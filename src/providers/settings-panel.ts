/**
 * ITFFTP - Extension Settings Webview
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { logger } from '../utils/logger';
import { configManager } from '../core/config';
import { transferManager } from '../core/transfer-manager';
import { connectionManager } from '../core/connection-manager';
import { AnalyticsStore } from '../core/analytics-store';
import { classifyDiff, collapseRecursiveTransfers, newerSide, shouldSyncDiff } from '../core/diff-comparison';
import { parseConfiguredConnections, parseReusableRemotes, resolveConfiguredConnection } from '../core/config-contract';
import {
  DEFAULT_MAX_SCAN_DEPTH,
  DEFAULT_MAX_SCAN_DIRECTORIES,
  runBoundedRecursiveScan
} from '../core/recursive-scan';
import { normalizeRemoteRelativePath, safeRemoteEntryName } from '../core/remote-path';
import { BaseConnection } from '../core/connection';
import { isConnectionClosedError, isRemoteMissingError, isRemoteNotDirectoryError } from '../core/connection-errors';
import { isGeneratedWatcherWrite } from '../core/watcher-suppression';
import { FTPConfig, StoredFTPConfig, SyncResult, TransferOutcome } from '../types';
import { DEFAULT_IGNORE_PATTERNS, errorMessage, isPathIgnored, joinRemotePath } from '../utils/helpers';

type SettingsSavedHandler = (scope: vscode.Uri) => Promise<void> | void;

type DiffEntry = {
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modifyTime?: number;
};

type DiffSignature = Omit<DiffEntry, 'path'>;

type SynchronizedSignatures = {
  local: DiffSignature;
  remote: DiffSignature;
};

type DiffRecord = {
  path: string;
  type: 'file' | 'directory';
  local?: Omit<DiffEntry, 'path'>;
  remote?: Omit<DiffEntry, 'path'>;
  status: 'same' | 'missing-local' | 'missing-remote' | 'modified' | 'type-changed';
  newer?: 'local' | 'remote';
  synchronized?: SynchronizedSignatures;
};

type DiffTransferCandidate = {
  path: string;
  type: 'file' | 'directory';
  record: DiffRecord;
};

type ComparisonCacheWrite = {
  file: vscode.Uri;
  expectedCacheKey: string;
  generation: number;
  revision: number;
  records: DiffRecord[];
};

type WatchedRefreshBatch = {
  config: FTPConfig;
  generation: number;
  targets: Map<string, boolean>;
  verifyDirtyContent: boolean;
  synchronizedPaths: Set<string>;
};

type DashboardJob = {
  id: string;
  path: string;
  direction: 'upload' | 'download' | 'delete';
  status: 'transferring' | 'completed' | 'error';
  progress: number;
  endTime?: number;
};

type DashboardSettingsInput = Partial<Record<typeof SETTING_KEYS[number] | 'connections' | 'dashboardZoom', unknown>>;

type SettingsPanelMessage = {
  type?: string;
  action?: unknown;
  connection?: unknown;
  connections?: unknown;
  direction?: unknown;
  force?: unknown;
  kind?: unknown;
  path?: unknown;
  projectId?: unknown;
  requestId?: unknown;
  selectedOnly?: unknown;
  settings?: DashboardSettingsInput;
};

const DIFF_CACHE_VERSION = 4;
const MAX_FTP_SCAN_CONCURRENCY = 4;

const SETTING_KEYS = [
  'autoConnect',
  'autoReconnect',
  'autoRefresh',
  'showHiddenFiles',
  'confirmDelete',
  'confirmSync',
  'showWebMasterTools',
  'enableFileWatcher',
  'defaultSyntaxHighlighting',
  'downloadWhenOpenInRemoteExplorer',
  'transferConcurrency',
  'remoteExplorerSortOrder'
] as const;

const DEFAULT_SETTINGS = {
  autoConnect: true,
  autoReconnect: true,
  autoRefresh: true,
  showHiddenFiles: false,
  confirmDelete: true,
  confirmSync: true,
  showWebMasterTools: true,
  enableFileWatcher: false,
  defaultSyntaxHighlighting: true,
  downloadWhenOpenInRemoteExplorer: false,
  transferConcurrency: 4,
  remoteExplorerSortOrder: 'name',
  dashboardZoom: 110,
  remotes: {}
};

export class SettingsPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private scope?: vscode.Uri;
  private diffRefreshRunning = false;
  private pendingDiffRefresh?: { value: unknown; generation: number; key: string; forceDirectoryCacheRefresh: boolean };
  private hasPendingDiffRefresh = false;
  private diffScanGeneration = 0;
  private comparisonRevision = 0;
  private diffScanTail: Promise<void> = Promise.resolve();
  private activeDiffProgressGeneration?: number;
  private activeDiffRequestKey?: string;
  private readonly diffDirectoryCache = new Map<string, DiffEntry[]>();
  private readonly diffScanConnectionTails = new WeakMap<BaseConnection, Promise<void>>();
  private readonly latestDiffRecords = new Map<string, DiffRecord>();
  private localWatcher?: vscode.FileSystemWatcher;
  private readonly localRefreshTimers = new Map<string, NodeJS.Timeout>();
  private readonly comparisonCacheWriteTails = new Map<string, Promise<void>>();
  private cacheWriteTimer?: NodeJS.Timeout;
  private backgroundRefreshTimer?: NodeJS.Timeout;
  private watchedRefreshTimer?: NodeJS.Timeout;
  private readonly watchedRefreshBatches = new Map<string, WatchedRefreshBatch>();
  private readonly pendingSynchronizedPaths = new Map<string, Set<string>>();
  private watchedRefreshRunning = false;
  private lastBackgroundRefreshAt = 0;
  private activeComparisonCacheKey?: string;
  private readonly localDirtyPaths = new Set<string>();
  private analyticsProjectFilter = 'all';
  private transferQueueExpiryTimer?: NodeJS.Timeout;
  private readonly dashboardJobs = new Map<string, DashboardJob>();
  private readonly analyticsChangedListener = () => void this.sendAnalytics();
  private readonly transferProgressListener = () => {
    if (!this.panel) {return;}
    const queue = transferManager.getQueue();
    const now = Date.now();
    const visible = queue.filter(item => {
      const itemStatus = String(item.status);
      return itemStatus === 'pending' || itemStatus === 'transferring'
        || ((itemStatus === 'completed' || itemStatus === 'skipped' || itemStatus === 'cancelled' || itemStatus === 'error')
          && item.endTime && now - item.endTime.getTime() < 8000);
    });
    for (const [id, job] of this.dashboardJobs) {
      if (job.endTime && now - job.endTime >= 8000) {this.dashboardJobs.delete(id);}
    }
    const dashboardJobs = [...this.dashboardJobs.values()];
    void this.panel.webview.postMessage({
      type: 'diffTransferQueue',
      items: [...visible.map(item => {
        const remoteRoot = (item.config?.remotePath || '/').replace(/\\/g, '/').replace(/\/+$/g, '') || '/';
        const normalized = item.remotePath.replace(/\\/g, '/');
        const remotePrefix = remoteRoot === '/' ? '/' : `${remoteRoot}/`;
        const relativePath = normalized.startsWith(remotePrefix) ? normalized.slice(remotePrefix.length) : normalized.replace(/^\/+/, '');
        return {
          id: item.id,
          path: relativePath || normalized,
          direction: item.direction,
          status: item.status,
          progress: Math.min(100, Math.max(0, Number(item.progress) || 0)),
          transferred: Math.max(0, Number(item.transferred) || 0),
          size: Math.max(0, Number(item.size) || 0)
        };
      }), ...dashboardJobs]
    });
    if (visible.some(item => ['completed', 'skipped', 'cancelled', 'error'].includes(String(item.status)))
      || dashboardJobs.some(item => item.endTime)) {
      if (this.transferQueueExpiryTimer) {clearTimeout(this.transferQueueExpiryTimer);}
      this.transferQueueExpiryTimer = setTimeout(() => this.transferProgressListener(), 8100);
    }
    const active = queue.filter(item => item.status === 'transferring');
    if (!active.length) {return;}
    const percentage = Math.round(active.reduce((total, item) => total + Math.min(100, Math.max(0, Number(item.progress) || 0)), 0) / active.length);
    const label = active.length === 1
      ? `${active[0].direction === 'upload' ? 'Uploading' : 'Downloading'} ${active[0].remotePath.split('/').pop() || active[0].remotePath}`
      : `Transferring ${active.length} files`;
    void this.panel.webview.postMessage({ type: 'diffTransferProgress', active: true, label, percentage });
  };

  private updateDashboardJob(job: DashboardJob): void {
    this.dashboardJobs.set(job.id, job);
    this.transferProgressListener();
  }

  private removeDashboardJob(id?: string): void {
    if (!id || !this.dashboardJobs.delete(id)) {return;}
    this.transferProgressListener();
  }

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onSettingsSaved?: SettingsSavedHandler,
    private readonly analyticsStore?: AnalyticsStore,
    private readonly globalStorageUri?: vscode.Uri
  ) {
    this.analyticsStore?.on('changed', this.analyticsChangedListener);
    transferManager.on('queueUpdate', this.transferProgressListener);
  }

  public open(scope?: vscode.Uri): void {
    const resolvedScope = scope || vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!resolvedScope) {
      vscode.window.showWarningMessage('Open a workspace before editing ITFFTP settings.');
      return;
    }

    this.initialize(resolvedScope);

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      void this.sendSettings();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'stackerftp.settings',
      'ITFFTP Settings',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri]
      }
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.panel.webview.onDidReceiveMessage(message => {
      void this.handleMessage(message);
    });

    const nonce = this.getNonce();
    void this.getHtmlForWebview(this.panel.webview, nonce).then(html => {
      if (this.panel) {
        this.panel.webview.html = html;
        logger.info('ITFFTP dashboard HTML loaded; waiting for webview settings request');
      }
    });
  }

  public dispose(): void {
    const activeProgressGeneration = this.activeDiffProgressGeneration;
    this.diffScanGeneration++;
    if (activeProgressGeneration !== undefined) {
      this.finishDiffScanProgress(activeProgressGeneration, 'Comparison cancelled');
    }
    this.watchedRefreshBatches.clear();
    this.pendingSynchronizedPaths.clear();
    this.localWatcher?.dispose();
    for (const timer of this.localRefreshTimers.values()) {clearTimeout(timer);}
    this.localRefreshTimers.clear();
    if (this.cacheWriteTimer) {clearTimeout(this.cacheWriteTimer);}
    if (this.backgroundRefreshTimer) {clearTimeout(this.backgroundRefreshTimer);}
    if (this.watchedRefreshTimer) {clearTimeout(this.watchedRefreshTimer);}
    if (this.transferQueueExpiryTimer) {clearTimeout(this.transferQueueExpiryTimer);}
    this.panel?.dispose();
    this.panel = undefined;
    this.analyticsStore?.removeListener('changed', this.analyticsChangedListener);
    transferManager.removeListener('queueUpdate', this.transferProgressListener);
  }

  public initialize(scope: vscode.Uri): void {
    const changedScope = this.scope?.toString() !== scope.toString();
    if (changedScope) {
      const activeProgressGeneration = this.activeDiffProgressGeneration;
      this.diffScanGeneration++;
      this.comparisonRevision++;
      this.latestDiffRecords.clear();
      this.localDirtyPaths.clear();
      this.diffDirectoryCache.clear();
      this.pendingSynchronizedPaths.clear();
      this.activeComparisonCacheKey = undefined;
      this.sendComparisonSnapshot();
      if (activeProgressGeneration !== undefined) {
        this.finishDiffScanProgress(activeProgressGeneration, 'Comparison cancelled');
      }
    }
    this.scope = scope;
    if (changedScope || !this.localWatcher) {this.ensureLocalWatcher(scope);}
    const config = configManager.getConfigs(scope.fsPath).find(candidate => candidate.default) || configManager.getConfigs(scope.fsPath)[0];
    if (config) {void this.loadCachedComparison(config);}
  }

  public async refreshComparisonInBackground(config?: FTPConfig): Promise<void> {
    if (!this.scope) {return;}
    const active = config || configManager.getConfigs(this.scope.fsPath).find(candidate => candidate.default) || configManager.getConfigs(this.scope.fsPath)[0];
    if (!active) {return;}
    await this.loadCachedComparison(active);
    // Local watcher events keep cached rows current. Remote comparison is
    // intentionally user-driven so opening the dashboard never inherits a
    // long-running background FTP scan.
    this.lastBackgroundRefreshAt = Date.now();
  }

  public scheduleBackgroundRefresh(config?: FTPConfig): void {
    if (Date.now() - this.lastBackgroundRefreshAt < 5000) {return;}
    if (this.backgroundRefreshTimer) {clearTimeout(this.backgroundRefreshTimer);}
    this.backgroundRefreshTimer = setTimeout(() => {
      this.backgroundRefreshTimer = undefined;
      void this.refreshComparisonInBackground(config).catch(error => logger.warn('Background comparison refresh failed', error));
    }, 500);
  }

  private ensureLocalWatcher(scope: vscode.Uri): void {
    this.localWatcher?.dispose();
    this.localWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(scope, '**/*'));
    const changed = (uri: vscode.Uri): void => {
      if (!this.scope || !uri.fsPath.startsWith(this.scope.fsPath)) {return;}
      if (isGeneratedWatcherWrite(uri.fsPath)) {
        logger.debug('ITFFTP-generated local write ignored by Transfer comparison watcher');
        return;
      }
      const configs = configManager.getConfigs(this.scope.fsPath);
      const activeConfig = configs.find(candidate => candidate.default) || configs[0];
      if (!activeConfig) {return;}
      const relativePath = this.relativeLocalPath(uri, activeConfig);
      if (relativePath === undefined) {return;}
      if (!relativePath || this.isIgnoredDiffPath(relativePath, [...DEFAULT_IGNORE_PATTERNS, ...(activeConfig?.ignore || [])])) {return;}
      this.localDirtyPaths.add(relativePath);
      const pendingTimer = this.localRefreshTimers.get(relativePath);
      if (pendingTimer) {clearTimeout(pendingTimer);}
      const timer = setTimeout(() => {
        this.localRefreshTimers.delete(relativePath);
        const currentConfigs = configManager.getConfigs(this.scope!.fsPath);
        const config = currentConfigs.find(candidate => candidate.default) || currentConfigs[0];
        if (!config) {return;}
        logger.info(`ITFFTP local change detected; updating cached comparison`);
        void this.refreshLocalCacheEntry(uri, config);
      }, 450);
      this.localRefreshTimers.set(relativePath, timer);
    };
    this.localWatcher.onDidCreate(changed);
    this.localWatcher.onDidChange(changed);
    this.localWatcher.onDidDelete(changed);
  }

  private cacheFile(config: FTPConfig): vscode.Uri | undefined {
    if (!this.globalStorageUri || !this.scope) {return undefined;}
    const identity = [this.scope.toString(), config.protocol, config.host, config.port || '', config.username || '', config.localPath || '.', config.remotePath || '/', ...(config.ignore || [])].join('\n');
    const key = crypto.createHash('sha256').update(identity).digest('hex');
    return vscode.Uri.joinPath(this.globalStorageUri, 'diff-cache', `${key}.json`);
  }

  private diffDirectoryCacheKey(config: FTPConfig, remoteDirectory: string): string {
    return JSON.stringify([
      config.protocol,
      config.host,
      config.port || '',
      config.username || '',
      remoteDirectory,
      ...(config.ignore || [])
    ]);
  }

  private beginDiffScanProgress(generation: number): void {
    this.activeDiffProgressGeneration = generation;
    this.panel?.webview.postMessage({
      type: 'diffTransferProgress',
      active: true,
      label: 'Comparing local and remote files…',
      percentage: 0
    });
  }

  private finishDiffScanProgress(generation: number, label: string, percentage?: number): void {
    if (this.activeDiffProgressGeneration !== generation) {return;}
    this.activeDiffProgressGeneration = undefined;
    this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: false, label, percentage });
  }

  private activateComparisonIdentity(cacheKey: string): void {
    if (this.activeComparisonCacheKey === cacheKey) {return;}
    const activeProgressGeneration = this.activeDiffProgressGeneration;
    this.diffScanGeneration++;
    this.comparisonRevision++;
    this.latestDiffRecords.clear();
    this.localDirtyPaths.clear();
    this.diffDirectoryCache.clear();
    for (const pendingKey of [...this.pendingSynchronizedPaths.keys()]) {
      if (pendingKey !== cacheKey) {this.pendingSynchronizedPaths.delete(pendingKey);}
    }
    if (this.cacheWriteTimer) {
      clearTimeout(this.cacheWriteTimer);
      this.cacheWriteTimer = undefined;
    }
    this.activeComparisonCacheKey = cacheKey;
    this.sendComparisonSnapshot();
    if (activeProgressGeneration !== undefined) {
      this.finishDiffScanProgress(activeProgressGeneration, 'Comparison cancelled');
    }
  }

  private async loadCachedComparison(config: FTPConfig): Promise<void> {
    const file = this.cacheFile(config);
    if (!file) {return;}
    const cacheKey = file.toString();
    if (this.activeComparisonCacheKey === cacheKey && this.latestDiffRecords.size) {
      this.sendComparisonSnapshot();
      return;
    }
    this.activateComparisonIdentity(cacheKey);
    const expectedRevision = this.comparisonRevision;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(file)));
      if (parsed?.version !== DIFF_CACHE_VERSION || !Array.isArray(parsed.records)) {return;}
      if (this.activeComparisonCacheKey !== cacheKey || this.comparisonRevision !== expectedRevision) {return;}
      const records = new Map<string, DiffRecord>();
      for (const record of parsed.records) {
        if (record && typeof record.path === 'string' && (record.type === 'file' || record.type === 'directory')) {
          records.set(record.path, record as DiffRecord);
        }
      }
      this.latestDiffRecords.clear();
      for (const [recordPath, record] of records) {this.latestDiffRecords.set(recordPath, record);}
      this.comparisonRevision++;
      logger.info(`ITFFTP comparison cache loaded: ${this.latestDiffRecords.size} paths`);
      this.sendComparisonSnapshot();
    } catch {
      // The cache is optional and is created after the first completed scan.
    }
  }

  private scheduleComparisonCacheWrite(config: FTPConfig, generation: number, revision: number, completedRecords: Iterable<DiffRecord>): void {
    const file = this.cacheFile(config);
    if (!file) {return;}
    const write: ComparisonCacheWrite = {
      file,
      expectedCacheKey: file.toString(),
      generation,
      revision,
      records: [...completedRecords].map(record => ({
        ...record,
        local: record.local ? { ...record.local } : undefined,
        remote: record.remote ? { ...record.remote } : undefined,
        synchronized: record.synchronized ? {
          local: { ...record.synchronized.local },
          remote: { ...record.synchronized.remote }
        } : undefined
      }))
    };
    if (this.cacheWriteTimer) {clearTimeout(this.cacheWriteTimer);}
    this.cacheWriteTimer = setTimeout(() => {
      this.cacheWriteTimer = undefined;
      this.enqueueComparisonCacheWrite(write);
    }, 300);
  }

  private enqueueComparisonCacheWrite(write: ComparisonCacheWrite): void {
    const previous = this.comparisonCacheWriteTails.get(write.expectedCacheKey) || Promise.resolve();
    const pending = previous
      .catch(() => undefined)
      .then(() => this.persistComparisonCache(write));
    this.comparisonCacheWriteTails.set(write.expectedCacheKey, pending);
    void pending.finally(() => {
      if (this.comparisonCacheWriteTails.get(write.expectedCacheKey) === pending) {
        this.comparisonCacheWriteTails.delete(write.expectedCacheKey);
      }
    });
  }

  private async persistComparisonCache(write: ComparisonCacheWrite): Promise<void> {
    if (write.generation !== this.diffScanGeneration
      || write.revision !== this.comparisonRevision
      || write.expectedCacheKey !== this.activeComparisonCacheKey) {return;}
    const { file } = write;
    const temporary = vscode.Uri.joinPath(
      vscode.Uri.joinPath(this.globalStorageUri!, 'diff-cache'),
      `${file.path.split('/').pop()}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    );
    try {
      const payload = JSON.stringify({ version: DIFF_CACHE_VERSION, updatedAt: new Date().toISOString(), revision: write.revision, records: write.records });
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.globalStorageUri!, 'diff-cache'));
      await vscode.workspace.fs.writeFile(temporary, new TextEncoder().encode(payload));
      if (write.generation !== this.diffScanGeneration
        || write.revision !== this.comparisonRevision
        || write.expectedCacheKey !== this.activeComparisonCacheKey) {
        await vscode.workspace.fs.delete(temporary);
        return;
      }
      await vscode.workspace.fs.rename(temporary, file, { overwrite: true });
    } catch (error) {
      logger.warn('Unable to persist ITFFTP comparison cache', error);
      try { await vscode.workspace.fs.delete(temporary); } catch { /* Another window may already have replaced the cache. */ }
    }
  }

  public canAutoDownload(config: FTPConfig, relativePath: string): boolean {
    const normalized = normalizeRemoteRelativePath(relativePath);
    if (!normalized) {return false;}
    const cacheKey = this.cacheFile(config)?.toString();
    if (cacheKey && this.activeComparisonCacheKey && cacheKey !== this.activeComparisonCacheKey) {return true;}
    return !this.localDirtyPaths.has(normalized);
  }

  public async refreshWatchedPath(
    config: FTPConfig,
    relativePath: string,
    verifyDirtyContent = false,
    kind?: 'file' | 'directory',
    completedDirection?: 'upload' | 'download'
  ): Promise<void> {
    const normalized = normalizeRemoteRelativePath(relativePath);
    if (!normalized) {return;}
    const key = this.cacheFile(config)?.toString() || JSON.stringify([
      this.scope?.toString() || '',
      config.protocol,
      config.host,
      config.port || '',
      config.username || '',
      config.localPath || '.',
      config.remotePath || '/',
      ...(config.ignore || [])
    ]);
    if (this.activeComparisonCacheKey && key !== this.activeComparisonCacheKey) {
      logger.debug('ITFFTP watcher comparison refresh ignored for an inactive Transfer identity');
      return;
    }
    let batch = this.watchedRefreshBatches.get(key);
    if (!batch || batch.generation !== this.diffScanGeneration) {
      batch = {
        config,
        generation: this.diffScanGeneration,
        targets: new Map<string, boolean>(),
        verifyDirtyContent: false,
        synchronizedPaths: new Set<string>()
      };
      this.watchedRefreshBatches.set(key, batch);
    }
    batch.config = config;
    batch.verifyDirtyContent ||= verifyDirtyContent;
    const pendingSynchronized = this.pendingSynchronizedPaths.get(key) || new Set<string>();
    if (completedDirection) {
      batch.synchronizedPaths.add(normalized);
      pendingSynchronized.add(normalized);
      this.pendingSynchronizedPaths.set(key, pendingSynchronized);
    } else {
      batch.synchronizedPaths.delete(normalized);
      if (pendingSynchronized.delete(normalized) && pendingSynchronized.size === 0) {
        this.pendingSynchronizedPaths.delete(key);
      }
    }
    const parent = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '';
    this.addWatchedRefreshTarget(batch.targets, parent, false);
    if (kind === 'directory' || this.latestDiffRecords.get(normalized)?.type === 'directory') {
      this.addWatchedRefreshTarget(batch.targets, normalized, true);
    }
    if (this.watchedRefreshTimer) {clearTimeout(this.watchedRefreshTimer);}
    this.watchedRefreshTimer = setTimeout(() => {
      this.watchedRefreshTimer = undefined;
      void this.flushWatchedRefresh();
    }, 250);
  }

  private addWatchedRefreshTarget(targets: Map<string, boolean>, target: string, recursive: boolean): void {
    for (const [existing, existingRecursive] of [...targets]) {
      if (existing === target) {
        targets.set(existing, existingRecursive || recursive);
        return;
      }
      if (existingRecursive && target.startsWith(`${existing}/`)) {return;}
      if (recursive && existing.startsWith(`${target}/`)) {targets.delete(existing);}
    }
    targets.set(target, recursive);
  }

  private async flushWatchedRefresh(): Promise<void> {
    if (this.watchedRefreshRunning) {return;}
    this.watchedRefreshRunning = true;
    try {
      while (this.watchedRefreshBatches.size) {
        const next = this.watchedRefreshBatches.entries().next().value as [string, WatchedRefreshBatch] | undefined;
        if (!next) {break;}
        const [key, active] = next;
        this.watchedRefreshBatches.delete(key);
        if (active.generation !== this.diffScanGeneration) {continue;}
        const targets = [...active.targets]
          .sort(([leftPath, leftRecursive], [rightPath, rightRecursive]) => {
            const depth = leftPath.split('/').filter(Boolean).length - rightPath.split('/').filter(Boolean).length;
            return depth || Number(leftRecursive) - Number(rightRecursive) || leftPath.localeCompare(rightPath);
          });
        for (const [target, recursive] of targets) {
          if (active.generation !== this.diffScanGeneration) {break;}
          // Watcher work stays behind an interactive scan and re-lists only
          // the affected parent/subtree without changing the request epoch.
          // If a newer Full Refresh takes ownership, the remainder of this
          // older watcher batch is already covered and must not resume later.
          await this.scanComparison(
            active.config,
            target,
            active.generation,
            true,
            recursive,
            active.verifyDirtyContent,
            { relativeDirectory: target, recursive },
            active.synchronizedPaths.size ? active.synchronizedPaths : undefined
          );
        }
      }
    } catch (error) {
      logger.warn('Watcher-triggered comparison refresh failed', error);
    } finally {
      this.watchedRefreshRunning = false;
      if (this.watchedRefreshBatches.size && !this.watchedRefreshTimer) {
        this.watchedRefreshTimer = setTimeout(() => {
          this.watchedRefreshTimer = undefined;
          void this.flushWatchedRefresh();
        }, 250);
      }
    }
  }

  private invalidateDiffDirectoryCache(config: FTPConfig, relativeDirectory: string, recursive = false): void {
    const root = (config.remotePath || '/').replace(/\\/g, '/').replace(/\/+$/g, '') || '/';
    const remoteDirectory = relativeDirectory ? joinRemotePath(root, relativeDirectory) : root;
    const prefix = remoteDirectory === '/' ? '/' : `${remoteDirectory}/`;
    for (const key of [...this.diffDirectoryCache.keys()]) {
      try {
        const parts = JSON.parse(key) as unknown[];
        const sameProfile = parts[0] === config.protocol
          && parts[1] === config.host
          && parts[2] === (config.port || '')
          && parts[3] === (config.username || '');
        const cachedDirectory = typeof parts[4] === 'string' ? parts[4] : '';
        if (sameProfile && (cachedDirectory === remoteDirectory || (recursive && cachedDirectory.startsWith(prefix)))) {
          this.diffDirectoryCache.delete(key);
        }
      } catch {
        // Cache keys are internal JSON tuples; discard malformed entries.
        this.diffDirectoryCache.delete(key);
      }
    }
  }

  private sendComparisonSnapshot(): void {
    if (!this.panel) {return;}
    void this.panel.webview.postMessage({ type: 'diffSnapshot', records: [...this.latestDiffRecords.values()], folders: [...this.latestDiffRecords.values()].filter(record => record.type === 'directory').length, cached: true });
  }

  private async refreshLocalCacheEntry(uri: vscode.Uri, config: FTPConfig): Promise<void> {
    if (!this.scope) {return;}
    const cacheKey = this.cacheFile(config)?.toString();
    if (cacheKey && this.activeComparisonCacheKey && cacheKey !== this.activeComparisonCacheKey) {return;}
    const relativePath = this.relativeLocalPath(uri, config);
    if (!relativePath) {return;}
    if (cacheKey) {
      const pendingSynchronized = this.pendingSynchronizedPaths.get(cacheKey);
      if (pendingSynchronized?.delete(relativePath) && pendingSynchronized.size === 0) {
        this.pendingSynchronizedPaths.delete(cacheKey);
      }
    }
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      const current = this.latestDiffRecords.get(relativePath);
      const type: DiffRecord['type'] = stat.type === vscode.FileType.Directory ? 'directory' : 'file';
      const record: DiffRecord = {
        path: relativePath,
        type,
        local: { type, size: type === 'file' ? stat.size : undefined, modifyTime: stat.mtime },
        remote: current?.remote,
        status: 'same'
      };
      if (current?.synchronized
        && this.signaturesMatch(record.local, current.synchronized.local)
        && this.signaturesMatch(record.remote, current.synchronized.remote)) {
        record.synchronized = {
          local: { ...current.synchronized.local },
          remote: { ...current.synchronized.remote }
        };
      }
      record.status = this.diffStatus(record);
      record.newer = record.status === 'modified' ? newerSide(record, this.localDirtyPaths.has(record.path)) : undefined;
      if (record.status === 'same') {this.localDirtyPaths.delete(record.path);}
      this.latestDiffRecords.set(relativePath, record);
    } catch {
      const current = this.latestDiffRecords.get(relativePath);
      if (current?.remote) {
        const record: DiffRecord = { ...current, local: undefined, synchronized: undefined, status: 'missing-local' };
        this.latestDiffRecords.set(relativePath, record);
      } else {
        this.latestDiffRecords.delete(relativePath);
      }
    }
    this.comparisonRevision++;
    this.sendComparisonSnapshot();
    this.scheduleComparisonCacheWrite(config, this.diffScanGeneration, this.comparisonRevision, this.latestDiffRecords.values());
  }

  private async handleMessage(message: SettingsPanelMessage): Promise<void> {
    try {
      switch (message?.type) {
        case 'ready':
          logger.info('ITFFTP dashboard is ready; sending settings');
          await this.sendSettings();
          this.transferProgressListener();
          break;
        case 'loadSettings':
          logger.info('ITFFTP dashboard requested settings');
          await this.sendSettings();
          break;
        case 'saveSettings':
          await this.saveSettings(message.settings);
          break;
        case 'resetSettings':
          await this.resetSettings();
          break;
        case 'openJson':
          await vscode.commands.executeCommand('workbench.action.openSettingsJson');
          break;
        case 'importConnections':
          await this.importConnections();
          break;
        case 'exportConnections':
          await this.exportConnections(message.connections, Boolean(message.selectedOnly));
          break;
        case 'openCompare':
          await this.loadRemoteDiff(undefined, true);
          break;
        case 'loadDiffRemote':
          await this.loadRemoteDiff(message.connection, Boolean(message.force));
          break;
        case 'loadDiffFolder':
          await this.loadRemoteDiffFolder(message.connection, message.path);
          break;
        case 'browseFolders':
          await this.browseFolders(message.requestId, message.kind, message.path, message.connection);
          break;
        case 'createRemoteFolder':
          await this.createRemoteFolder(message.connection);
          break;
        case 'readDiffFile':
          await this.readDiffFile(message.direction === 'remote' ? 'remote' : 'local', message.path, message.connection);
          break;
        case 'diffAction':
          {
            const transferAction = message.action === 'upload' || message.action === 'download'
              ? message.action
              : undefined;
            const preparationJobId = transferAction ? `prepare-${Date.now()}-${crypto.randomBytes(3).toString('hex')}` : undefined;
            if (preparationJobId && transferAction) {
              this.updateDashboardJob({ id: preparationJobId, path: String(message.path || ''), direction: transferAction, status: 'transferring', progress: 0 });
            }
            try {
              await this.handleDiffAction(String(message.action || ''), message.direction === 'remote' ? 'remote' : 'local', message.path, message.connection, preparationJobId);
            } finally {
              this.removeDashboardJob(preparationJobId);
            }
          }
          break;
        case 'diffTransfer':
          {
            const direction = message.direction === 'download' ? 'download' : 'upload';
            await this.handleDiffAction(direction, direction === 'upload' ? 'local' : 'remote', message.path, message.connection);
          }
          break;
        case 'syncAllChanged':
          await this.syncChanged(message.direction === 'down' ? 'down' : 'up', message.connection);
          break;
        case 'testConnection':
          await this.testConnection(message.connection);
          break;
        case 'analyticsFilter':
          this.analyticsProjectFilter = typeof message.projectId === 'string' ? message.projectId : 'all';
          await this.sendAnalytics();
          break;
      }
    } catch (error) {
      logger.error('Settings panel message handler error', error);
      this.panel?.webview.postMessage({
        type: 'saveError',
        message: errorMessage(error)
      });
    }
  }

  private getConfiguration(): vscode.WorkspaceConfiguration {
    if (!this.scope) {
      throw new Error('No workspace is selected');
    }
    return vscode.workspace.getConfiguration('stackerftp', this.scope);
  }

  private async sendSettings(): Promise<void> {
    if (!this.panel) {return;}

    const configuration = this.getConfiguration();
    // Activation and the configuration watcher already populate this cache.
    // Only read the file here when this is the first dashboard operation.
    if (configManager.getConfigs(this.scope!.fsPath).length === 0) {
      await configManager.loadConfig(this.scope!.fsPath);
    }
    // The workspace inventory can require thousands of filesystem stats.  Do
    // not hold the dashboard settings hostage while it is being collected.
    const workspaceFilesPromise = this.getWorkspaceFiles();
    const settings = {
      autoConnect: configuration.get<boolean>('autoConnect', DEFAULT_SETTINGS.autoConnect),
      autoReconnect: configuration.get<boolean>('autoReconnect', DEFAULT_SETTINGS.autoReconnect),
      autoRefresh: configuration.get<boolean>('autoRefresh', DEFAULT_SETTINGS.autoRefresh),
      showHiddenFiles: configuration.get<boolean>('showHiddenFiles', DEFAULT_SETTINGS.showHiddenFiles),
      confirmDelete: configuration.get<boolean>('confirmDelete', DEFAULT_SETTINGS.confirmDelete),
      confirmSync: configuration.get<boolean>('confirmSync', DEFAULT_SETTINGS.confirmSync),
      showWebMasterTools: configuration.get<boolean>('showWebMasterTools', DEFAULT_SETTINGS.showWebMasterTools),
      enableFileWatcher: configuration.get<boolean>('enableFileWatcher', DEFAULT_SETTINGS.enableFileWatcher),
      defaultSyntaxHighlighting: configuration.get<boolean>('defaultSyntaxHighlighting', DEFAULT_SETTINGS.defaultSyntaxHighlighting),
      downloadWhenOpenInRemoteExplorer: configuration.get<boolean>(
        'downloadWhenOpenInRemoteExplorer',
        DEFAULT_SETTINGS.downloadWhenOpenInRemoteExplorer
      ),
      transferConcurrency: configuration.get<number>('transferConcurrency', DEFAULT_SETTINGS.transferConcurrency),
      remoteExplorerSortOrder: configuration.get<string>('remoteExplorerSortOrder', DEFAULT_SETTINGS.remoteExplorerSortOrder),
      dashboardZoom: configuration.get<number>('dashboardZoom', DEFAULT_SETTINGS.dashboardZoom),
      remotes: JSON.stringify(configuration.get<Record<string, unknown>>('remotes', DEFAULT_SETTINGS.remotes), null, 2),
      connections: JSON.stringify(configManager.getConfigs(this.scope!.fsPath), null, 2),
      workspaceFiles: [],
      workspaceFileStats: {},
      defaultIgnorePatterns: DEFAULT_IGNORE_PATTERNS,
      analytics: this.analyticsStore ? await this.analyticsStore.getAnalytics(this.analyticsProjectFilter) : transferManager.getAnalytics()
    };

    this.panel.webview.postMessage({ type: 'settings', settings });
    this.sendComparisonSnapshot();
    logger.info('ITFFTP dashboard settings sent');
    void this.sendWorkspaceInventory(workspaceFilesPromise);
  }

  private localRoot(config: FTPConfig): vscode.Uri {
    if (!this.scope) {throw new Error('No workspace is selected.');}
    const relative = String(config.localPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!relative || relative === '.') {return this.scope;}
    if (relative.split('/').some(segment => segment === '..')) {throw new Error('Local folder must stay inside the workspace.');}
    return vscode.Uri.joinPath(this.scope, ...relative.split('/').filter(Boolean));
  }

  private relativeLocalPath(uri: vscode.Uri, config: FTPConfig): string | undefined {
    const root = this.localRoot(config);
    const relative = path.relative(root.fsPath, uri.fsPath).replace(/\\/g, '/');
    return !relative || relative === '.' ? '' : relative === '..' || relative.startsWith('../') ? undefined : relative;
  }

  private async browseFolders(requestId: unknown, kind: unknown, value: unknown, connectionValue: unknown): Promise<void> {
    if (!this.panel || !this.scope || typeof requestId !== 'string') {return;}
    const folderKind = kind === 'remote' ? 'remote' : 'local';
    const requestedPath = String(value || (folderKind === 'remote' ? '/' : '')).replace(/\\/g, '/');
    try {
      let entries: Array<{ name: string; path: string }> = [];
      if (folderKind === 'local') {
        const relative = requestedPath.replace(/^\/+|\/+$/g, '');
        if (relative.split('/').some(segment => segment === '..')) {throw new Error('Local folder must stay inside the workspace.');}
        const directory = relative ? vscode.Uri.joinPath(this.scope, ...relative.split('/')) : this.scope;
        entries = (await vscode.workspace.fs.readDirectory(directory))
          .filter(([, type]) => type === vscode.FileType.Directory)
          .map(([name]) => ({ name, path: relative ? `${relative}/${name}` : name }))
          .sort((left, right) => left.name.localeCompare(right.name));
      } else {
        const config = this.resolveConnections(connectionValue)[0] || connectionManager.getPrimaryConfig();
        if (!config) {throw new Error('Select a host before browsing remote folders.');}
        const remotePath = `/${requestedPath}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
        const connection = await connectionManager.connect(config);
        entries = (await connection.list(remotePath))
          .flatMap(entry => {
            const name = safeRemoteEntryName(entry.name);
            if (entry.type !== 'directory' || !name) {return [];}
            return [{ name, path: `${remotePath === '/' ? '' : remotePath}/${name}`.replace(/\/+/g, '/') }];
          })
          .sort((left: { name: string }, right: { name: string }) => left.name.localeCompare(right.name));
      }
      await this.panel.webview.postMessage({ type: 'folderPicker', requestId, kind: folderKind, path: requestedPath, entries });
    } catch (error) {
      const message = errorMessage(error);
      logger.warn(`Unable to browse ${folderKind} folders at ${requestedPath || '/'}`, error);
      await this.panel?.webview.postMessage({ type: 'folderPickerError', requestId, kind: folderKind, path: requestedPath, message });
    }
  }

  private async createRemoteFolder(value: unknown): Promise<void> {
    const config = this.resolveConnections(value)[0] || connectionManager.getPrimaryConfig();
    if (!config) {throw new Error('Select a host before creating a remote folder.');}
    const name = await vscode.window.showInputBox({
      title: 'Create remote folder',
      prompt: `Folder name inside ${config.remotePath || '/'}`,
      validateInput: candidate => safeRemoteEntryName(candidate.trim())
        ? undefined
        : 'Enter one folder name without slashes, dot segments, or control characters.'
    });
    if (!name) {return;}
    const folderName = name.trim();
    if (!safeRemoteEntryName(folderName)) {throw new Error('Remote folder name is invalid.');}
    const root = (config.remotePath || '/').replace(/\\/g, '/').replace(/\/+$/g, '') || '/';
    const remotePath = `${root === '/' ? '' : root}/${folderName}`.replace(/\/+/g, '/');
    const connection = await connectionManager.connect(config);
    await connection.mkdir(remotePath);
    this.panel?.webview.postMessage({ type: 'remoteFolderCreated', message: `Created remote folder ${remotePath}` });
  }

  private withDashboardSyncMode(config: FTPConfig): FTPConfig {
    return {
      ...config,
      syncMode: 'full'
    };
  }

  private async sendWorkspaceInventory(workspaceFilesPromise: Promise<string[]>): Promise<void> {
    try {
      const workspaceFiles = await workspaceFilesPromise;
      const workspaceFileStats = await this.getWorkspaceFileStats(workspaceFiles);
      this.panel?.webview.postMessage({ type: 'workspaceFiles', workspaceFiles, workspaceFileStats });
      logger.info(`ITFFTP dashboard workspace inventory sent (${workspaceFiles.length} entries)`);
    } catch (error) {
      logger.warn('Unable to load ITFFTP dashboard workspace inventory', error);
      this.panel?.webview.postMessage({
        type: 'saveError',
        message: `Unable to load the local folder list: ${errorMessage(error)}`
      });
    }
  }

  private async sendAnalytics(): Promise<void> {
    const analytics = this.analyticsStore ? await this.analyticsStore.getAnalytics(this.analyticsProjectFilter) : transferManager.getAnalytics();
    this.panel?.webview.postMessage({ type: 'analytics', analytics });
  }

  private async saveSettings(values: DashboardSettingsInput = {}): Promise<void> {
    const configuration = this.getConfiguration();
    const connections = this.parseConnections(values?.connections);
    const transferConcurrency = this.parseConcurrency(values?.transferConcurrency);
    const sortOrder = this.parseSortOrder(values?.remoteExplorerSortOrder);
    const dashboardZoom = Math.min(160, Math.max(80, Math.round(Number(values?.dashboardZoom) || DEFAULT_SETTINGS.dashboardZoom)));

    const updates: Record<string, unknown> = {
      autoConnect: Boolean(values?.autoConnect),
      autoReconnect: Boolean(values?.autoReconnect),
      autoRefresh: Boolean(values?.autoRefresh),
      showHiddenFiles: Boolean(values?.showHiddenFiles),
      confirmDelete: Boolean(values?.confirmDelete),
      confirmSync: Boolean(values?.confirmSync),
      showWebMasterTools: Boolean(values?.showWebMasterTools),
      enableFileWatcher: Boolean(values?.enableFileWatcher),
      defaultSyntaxHighlighting: Boolean(values?.defaultSyntaxHighlighting),
      downloadWhenOpenInRemoteExplorer: Boolean(values?.downloadWhenOpenInRemoteExplorer),
      transferConcurrency,
      remoteExplorerSortOrder: sortOrder
    };

    for (const key of SETTING_KEYS) {
      await configuration.update(key, updates[key], vscode.ConfigurationTarget.Workspace);
    }
    await configuration.update('dashboardZoom', dashboardZoom, vscode.ConfigurationTarget.Global);

    await configManager.saveConfig(this.scope!.fsPath, connections);

    this.panel?.webview.postMessage({ type: 'saveSuccess' });
    logger.info('ITFFTP settings saved automatically');

    if (this.scope && this.onSettingsSaved) {
      await this.onSettingsSaved(this.scope);
    }
  }

  private async resetSettings(): Promise<void> {
    const configuration = this.getConfiguration();
    for (const key of SETTING_KEYS) {
      await configuration.update(key, undefined, vscode.ConfigurationTarget.Workspace);
    }

    await this.sendSettings();
    this.panel?.webview.postMessage({ type: 'resetSuccess' });
    this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: false, label: 'Workspace setting overrides reset' });
    logger.info('Workspace setting overrides reset');
  }

  private parseConnections(value: unknown): StoredFTPConfig[] {
    let parsed: unknown = value;
    if (typeof value === 'string') {
      parsed = JSON.parse(value.trim() || '[]');
    }

    if (parsed === undefined || parsed === null) {return [];}
    const omitUndefined = (candidate: unknown): unknown => {
      if (Array.isArray(candidate)) {return candidate.map(omitUndefined);}
      if (!candidate || typeof candidate !== 'object') {return candidate;}
      return Object.fromEntries(Object.entries(candidate as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, omitUndefined(item)]));
    };
    const normalizeLocalPath = (localPath: string | undefined): string | undefined => localPath === undefined
      ? undefined
      : localPath.replace(/\\/g, '/').replace(/^\.\/?$/, '').replace(/^\/+|\/+$/g, '') || undefined;
    const connections = parseConfiguredConnections(omitUndefined(parsed)).map(connection => {
      const normalized = { ...connection } as StoredFTPConfig;
      const localPath = normalizeLocalPath(connection.localPath);
      if (localPath === undefined) {delete normalized.localPath;}
      else {normalized.localPath = localPath;}
      if (connection.profiles) {
        normalized.profiles = Object.fromEntries(Object.entries(connection.profiles).map(([name, profile]) => {
          const normalizedProfile = { ...profile };
          const profileLocalPath = normalizeLocalPath(profile.localPath);
          if (profileLocalPath === undefined) {delete normalizedProfile.localPath;}
          else {normalizedProfile.localPath = profileLocalPath;}
          return [name, normalizedProfile];
        }));
      }
      return normalized;
    });

    if (connections.filter(connection => Boolean(connection.default)).length > 1) {
      throw new Error('Only one remote location can be the default host.');
    }

    return connections;
  }

  private resolveConnections(value: unknown): FTPConfig[] {
    const remotes = parseReusableRemotes(
      vscode.workspace.getConfiguration('stackerftp', this.scope).get<unknown>('remotes', {})
    );
    return this.parseConnections(value).map(connection => resolveConfiguredConnection(connection, remotes).config);
  }

  private async importConnections(): Promise<void> {
    const selected = await vscode.window.showOpenDialog({
      title: 'Import ITFFTP remote locations',
      canSelectMany: false,
      canSelectFiles: true,
      canSelectFolders: false,
      filters: { 'JSON configuration': ['json'] }
    });

    if (!selected?.[0]) {return;}

    const content = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(selected[0]));
    const connections = this.parseConnections(JSON.parse(content));
    this.panel?.webview.postMessage({ type: 'connectionsImported', connections });
    const label = `Imported ${connections.length} remote location${connections.length === 1 ? '' : 's'}`;
    this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: false, label });
    logger.info(label);
  }

  private async testConnection(value: unknown): Promise<void> {
    try {
      const config = this.resolveConnections(value)[0];
      if (!config) {throw new Error('Select a host before testing the connection.');}
      await connectionManager.testConnection(config);
      this.panel?.webview.postMessage({ type: 'testSuccess', message: `Connection test succeeded for ${config.host}.` });
      logger.info(`Connection test succeeded: ${config.host}`);
    } catch (error) {
      this.panel?.webview.postMessage({ type: 'testError', message: errorMessage(error) });
      logger.warn(`Connection test failed: ${errorMessage(error)}`);
    }
  }

  private async loadRemoteDiff(value: unknown, force = false): Promise<void> {
    const requestedConfig = this.resolveConnections(value)[0] || connectionManager.getPrimaryConfig();
    if (!requestedConfig) {throw new Error('Select a host before loading remote files.');}
    const requestedCacheKey = this.cacheFile(requestedConfig)?.toString();
    if (!force && this.latestDiffRecords.size && requestedCacheKey && this.activeComparisonCacheKey === requestedCacheKey) {
      this.sendComparisonSnapshot();
      this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: false, label: `Cached comparison ready (${this.latestDiffRecords.size} paths)`, percentage: 100 });
      logger.info(`ITFFTP cached comparison served without a remote scan: ${this.latestDiffRecords.size} paths`);
      return;
    }
    if (requestedCacheKey && this.activeComparisonCacheKey !== requestedCacheKey) {
      this.activateComparisonIdentity(requestedCacheKey);
      await this.loadCachedComparison(requestedConfig);
      if (!force && this.latestDiffRecords.size) {
        this.sendComparisonSnapshot();
        return;
      }
    }
    const requestKey = [
      this.scope?.toString() || '',
      requestedConfig.protocol,
      requestedConfig.host,
      requestedConfig.port || '',
      requestedConfig.username || '',
      requestedConfig.remotePath || '/'
    ].join('\n');
    const generation = ++this.diffScanGeneration;
    const forceDirectoryCacheRefresh = force
      || Boolean(this.pendingDiffRefresh?.key === requestKey && this.pendingDiffRefresh.forceDirectoryCacheRefresh);
    this.pendingDiffRefresh = { value, generation, key: requestKey, forceDirectoryCacheRefresh };
    this.hasPendingDiffRefresh = true;
    if (this.diffRefreshRunning) {
      logger.debug('ITFFTP diff refresh queued behind the active scan');
      return;
    }
    this.diffRefreshRunning = true;
    try {
      do {
        const request = this.pendingDiffRefresh;
        this.pendingDiffRefresh = undefined;
        this.hasPendingDiffRefresh = false;
        if (request) {
          this.activeDiffRequestKey = request.key;
          await this.loadRemoteDiffOnce(request.value, request.generation, request.forceDirectoryCacheRefresh);
        }
      } while (this.hasPendingDiffRefresh);
    } finally {
      this.diffRefreshRunning = false;
      this.activeDiffRequestKey = undefined;
    }
  }

  private async loadRemoteDiffOnce(value: unknown, generation: number, forceDirectoryCacheRefresh: boolean): Promise<void> {
    const config = this.resolveConnections(value)[0] || connectionManager.getPrimaryConfig();
    if (!config) {throw new Error('Select a host before loading remote files.');}
    // Expansion is presentation-only. Every comparison discovers descendants.
    await this.scanComparison(config, '', generation, false, true, false, forceDirectoryCacheRefresh);
  }

  private async loadRemoteDiffFolder(value: unknown, relativePath: unknown): Promise<void> {
    const config = this.resolveConnections(value)[0] || connectionManager.getPrimaryConfig();
    if (!config) {throw new Error('Select a host before loading remote files.');}
    const relativeDirectory = normalizeRemoteRelativePath(relativePath, true);
    if (relativeDirectory === undefined) {throw new Error('Remote folder must stay inside the configured root.');}
    await this.scanComparison(config, relativeDirectory, ++this.diffScanGeneration, true, true);
  }

  private classifySettledTransfers(
    paths: string[],
    settled: PromiseSettledResult<TransferOutcome>[]
  ): { completedPaths: string[]; skipped: Array<{ path: string; reason: string }>; failedCount: number } {
    const completedPaths: string[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    let failedCount = 0;
    for (let index = 0; index < settled.length; index++) {
      const result = settled[index];
      if (result.status === 'rejected') {
        failedCount++;
      } else if (result.value.status === 'completed') {
        completedPaths.push(paths[index]);
      } else {
        skipped.push({ path: paths[index], reason: result.value.reason });
      }
    }
    return { completedPaths, skipped, failedCount };
  }

  private getTransferCandidates(
    records: Iterable<DiffRecord>,
    direction: 'upload' | 'download',
    ignorePatterns: readonly string[] = []
  ): DiffTransferCandidate[] {
    const candidates: DiffTransferCandidate[] = [];
    for (const record of records) {
      if (this.isIgnoredDiffPath(record.path, ignorePatterns)) {continue;}
      const source = direction === 'upload' ? record.local : record.remote;
      const target = direction === 'upload' ? record.remote : record.local;
      if (!source) {continue;}
      const replacesFileWithDirectory = record.status === 'type-changed'
        && source.type === 'directory'
        && target?.type === 'file';
      if (source.type !== 'file' && !replacesFileWithDirectory) {continue;}
      candidates.push({ path: record.path, type: source.type, record });
    }
    return collapseRecursiveTransfers(candidates);
  }

  private directoryTransferOutcome(
    result: SyncResult,
    direction: 'upload' | 'download',
    relativePath: string
  ): TransferOutcome {
    if (result.failed.length) {
      const details = result.failed
        .slice(0, 3)
        .map(failure => `${failure.path}: ${failure.error}`)
        .join('; ');
      throw new Error(`${direction === 'upload' ? 'Upload' : 'Download'} failed for ${relativePath}: ${details}`);
    }
    if (result.skipped.length) {
      const details = result.skipped.slice(0, 3).join(', ');
      return {
        status: 'skipped',
        reason: `${result.skipped.length} nested entr${result.skipped.length === 1 ? 'y was' : 'ies were'} skipped${details ? ` (${details})` : ''}`
      };
    }
    return { status: 'completed' };
  }

  private async transferDiffCandidate(
    connection: BaseConnection,
    candidate: DiffTransferCandidate,
    direction: 'upload' | 'download',
    config: FTPConfig
  ): Promise<TransferOutcome> {
    const record = candidate.record;
    const source = direction === 'upload' ? record.local : record.remote;
    const target = direction === 'upload' ? record.remote : record.local;
    if (!source) {throw new Error(`The ${direction === 'upload' ? 'local' : 'remote'} source no longer exists: ${candidate.path}`);}
    const localUri = vscode.Uri.joinPath(this.localRoot(config), ...candidate.path.split('/'));
    const remoteRoot = (config.remotePath || '/').replace(/\/$/, '');
    const remotePath = joinRemotePath(remoteRoot, candidate.path);

    if (source.type === 'file') {
      const options = {
        size: source.size,
        targetExists: Boolean(target),
        sourceType: 'file' as const,
        targetType: target?.type,
        replaceTypeCollision: record.status === 'type-changed' && target?.type === 'directory'
      };
      return direction === 'upload'
        ? transferManager.uploadFile(connection, localUri.fsPath, remotePath, config, options)
        : transferManager.downloadFile(connection, remotePath, localUri.fsPath, config, options);
    }

    if (record.status !== 'type-changed' || target?.type !== 'file') {
      throw new Error(`Directory transfer requires an explicit file/folder collision: ${candidate.path}`);
    }
    const options = {
      sourceType: 'directory' as const,
      targetType: 'file' as const,
      replaceTypeCollision: true
    };
    const result = direction === 'upload'
      ? await transferManager.uploadDirectory(connection, localUri.fsPath, remotePath, config, options)
      : await transferManager.downloadDirectory(connection, remotePath, localUri.fsPath, config, options);
    return this.directoryTransferOutcome(result, direction, candidate.path);
  }

  private reportSkippedTransfers(skipped: Array<{ path: string; reason: string }>): void {
    if (!skipped.length) {return;}
    const details = skipped.map(item => `${item.path}: ${item.reason}`).join('; ');
    const label = `Skipped ${skipped.length} transfer${skipped.length === 1 ? '' : 's'} — ${details}`;
    logger.warn(label);
    this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: false, label });
  }

  private async syncChanged(direction: 'up' | 'down', value?: unknown): Promise<void> {
    if (!this.scope) {throw new Error('No workspace is selected.');}
    const config = this.resolveConnections(value)[0] || configManager.getActiveConfig(this.scope.fsPath) || configManager.getConfigs(this.scope.fsPath).find(candidate => candidate.default) || configManager.getConfigs(this.scope.fsPath)[0];
    if (!config) {throw new Error('Select a host before syncing.');}
    // The interactive tree is lazy. A bulk sync must discover every changed
    // descendant before it builds the transfer list.
    await this.scanComparison(config, '', ++this.diffScanGeneration, false, true, true, true);
    if (!this.latestDiffRecords.size) {throw new Error('No comparison data available. Open Transfer first.');}

    const rawCandidates = [...this.latestDiffRecords.values()].filter(record =>
      shouldSyncDiff(record, direction, this.localDirtyPaths.has(record.path))
    );
    // Use the authoritative source-side type. Aggregate rows intentionally use
    // "directory" when either side is a directory, which previously discarded
    // file-over-directory collisions before they reached TransferManager.
    const transferDirection = direction === 'up' ? 'upload' : 'download';
    const candidates = this.getTransferCandidates(rawCandidates, transferDirection, config.ignore || []);
    logger.info(`ITFFTP sync ${direction} selected ${candidates.length} changed entr${candidates.length === 1 ? 'y' : 'ies'} from ${this.latestDiffRecords.size} compared paths`);

    if (candidates.length === 0) {
      logger.info(`No changed entries to sync ${direction === 'up' ? 'up' : 'down'}.`);
      this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: false, label: `No changed entries to sync ${direction === 'up' ? 'up' : 'down'}` });
      return;
    }

    const connection = await connectionManager.connect(config);
    const transferConfig = this.withDashboardSyncMode(config);
    const actions: Array<{ path: string; promise: Promise<TransferOutcome> }> = [];
    for (const candidate of candidates) {
      const filePath = candidate.path.replace(/\/$/, '');
      if (!filePath) {continue;}
      actions.push({
        path: filePath,
        promise: this.transferDiffCandidate(connection, candidate, transferDirection, transferConfig)
      });
    }

    this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: true, label: `${direction === 'up' ? 'Uploading' : 'Downloading'} ${candidates.length} changed entries`, percentage: 0 });
    if (actions.length === 0) {
      this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: false, label: `No valid entries for ${direction === 'up' ? 'upload' : 'download'}` });
      return;
    }

    try {
      const settled = await Promise.allSettled(actions.map(entry => entry.promise));
      const { completedPaths, skipped, failedCount } = this.classifySettledTransfers(
        actions.map(entry => entry.path),
        settled
      );
      if (completedPaths.length > 0) {
        await this.refreshAfterTransfer(completedPaths, direction === 'up' ? 'upload' : 'download', config);
      }
      if (failedCount > 0) {
        const message = direction === 'up' ? 'Uploaded' : 'Downloaded';
        const skippedDetails = skipped.length
          ? `; skipped ${skipped.map(item => `${item.path}: ${item.reason}`).join('; ')}`
          : '';
        const label = `${message} ${completedPaths.length} changed entr${completedPaths.length === 1 ? 'y' : 'ies'}; ${failedCount} failed${skippedDetails}`;
        logger.warn(label);
        this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: false, label });
      } else if (skipped.length) {
        this.reportSkippedTransfers(skipped);
      } else {
        const message = direction === 'up' ? 'Uploaded' : 'Downloaded';
        this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: false, label: `${message} ${completedPaths.length} changed entr${completedPaths.length === 1 ? 'y' : 'ies'}` });
      }
    } finally {
      // No-op. Sync completion status is posted above to keep the UI deterministic.
    }
  }

  private async refreshAfterTransfer(syncedPaths: string[], direction: 'upload' | 'download', selectedConfig?: FTPConfig): Promise<void> {
    if (!this.scope) {return;}
    const config = selectedConfig || configManager.getActiveConfig(this.scope.fsPath) || configManager.getConfigs(this.scope.fsPath).find(candidate => candidate.default) || configManager.getConfigs(this.scope.fsPath)[0];
    if (!config) {return;}

    const completedPaths = [...new Set(syncedPaths.map(syncedPath => syncedPath.replace(/\/$/, '')).filter(Boolean))];
    // A verified transfer invalidates older scans immediately. The comparison
    // itself is committed only from authoritative local and remote listings.
    const generation = ++this.diffScanGeneration;
    this.comparisonRevision++;
    const pathsByParent = new Map<string, Set<string>>();
    for (const completedPath of completedPaths) {
      const directParent = completedPath.includes('/') ? completedPath.slice(0, completedPath.lastIndexOf('/')) : '';
      for (let parent: string | undefined = directParent; parent !== undefined; parent = parent
        ? (parent.includes('/') ? parent.slice(0, parent.lastIndexOf('/')) : '')
        : undefined) {
        const paths = pathsByParent.get(parent) || new Set<string>();
        paths.add(completedPath);
        pathsByParent.set(parent, paths);
      }
    }
    const parents = [...pathsByParent.keys()].sort((left, right) => {
      const depth = left.split('/').filter(Boolean).length - right.split('/').filter(Boolean).length;
      return depth || left.localeCompare(right);
    });
    logger.info(`ITFFTP ${direction} completed; re-comparing ${parents.length} affected parent${parents.length === 1 ? '' : 's'}`);
    for (const parent of parents) {
      await this.scanComparison(
        config,
        parent,
        generation,
        true,
        false,
        false,
        { relativeDirectory: parent, recursive: false },
        pathsByParent.get(parent)
      );
    }
  }

  private async refreshChangedPathAfterMutation(filePath: string, side: 'local' | 'remote', action: string, config: FTPConfig): Promise<void> {
    const normalized = filePath.replace(/\/$/, '');
    const parent = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '';
    const generation = ++this.diffScanGeneration;

    if (action === 'delete') {
      this.invalidateDiffDirectoryCache(config, parent);
      for (const [path, record] of [...this.latestDiffRecords.entries()]) {
        if (path !== normalized && !path.startsWith(`${normalized}/`)) {continue;}
        if (side === 'local') {record.local = undefined;}
        else {record.remote = undefined;}
        if (!record.local && !record.remote) {
          this.latestDiffRecords.delete(path);
          continue;
        }
        record.status = this.diffStatus(record);
        record.newer = undefined;
        this.latestDiffRecords.set(path, record);
      }
      this.comparisonRevision++;
      this.sendComparisonSnapshot();
      this.scheduleComparisonCacheWrite(config, generation, this.comparisonRevision, this.latestDiffRecords.values());
      return;
    }

    // Rename changes the path identity, so validate only its parent directory.
    await this.scanComparison(
      config,
      parent,
      generation,
      true,
      false,
      false,
      { relativeDirectory: parent, recursive: false }
    );
  }

  /**
   * FileZilla-style comparison: list both peers of every directory and emit a
   * single record for each relative path.  This deliberately never sends a
   * free-standing local list and remote list for the webview to reconcile.
   */
  private async withExclusiveDiffScanConnection<T>(connection: BaseConnection, operation: () => Promise<T>): Promise<T> {
    const previous = this.diffScanConnectionTails.get(connection) || Promise.resolve();
    let release!: () => void;
    const reservation = new Promise<void>(resolve => {release = resolve;});
    const tail = previous.then(() => reservation);
    this.diffScanConnectionTails.set(connection, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.diffScanConnectionTails.get(connection) === tail) {
        this.diffScanConnectionTails.delete(connection);
      }
    }
  }

  private async withDiffScanConnection<T>(
    config: FTPConfig,
    session: { primary: BaseConnection },
    usePrimary: boolean,
    isCancelled: () => boolean,
    operation: (connection: BaseConnection) => Promise<T>
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (isCancelled()) {throw new Error('Comparison refresh was superseded.');}
      let connection: BaseConnection | undefined;
      let pooled = false;
      try {
        if (usePrimary) {
          const currentPrimary = connectionManager.getConnection(config);
          if (currentPrimary?.connected) {session.primary = currentPrimary;}
          connection = session.primary;
        } else {
          connection = await connectionManager.getStrictPooledConnection(config);
        }
        pooled = connectionManager.getConnection(config) !== connection;
        if (isCancelled()) {throw new Error('Comparison refresh was superseded.');}
        return await this.withExclusiveDiffScanConnection(connection, () => operation(connection!));
      } catch (error) {
        if (!isConnectionClosedError(error) || attempt > 0 || isCancelled()) {throw error;}
        if (connection && connectionManager.getConnection(config) === connection) {
          session.primary = await connectionManager.invalidateAndReconnect(config, connection);
          logger.info('ITFFTP scan primary connection closed; continuing on the reconnected session');
        } else if (connection) {
          // A classified closed pooled transport must never re-enter the idle
          // pool, even when its wrapper still reports connected.
          pooled = false;
          await connectionManager.discardPooledConnection(config, connection);
          logger.info('ITFFTP pooled scan connection closed; retrying on a fresh pooled session');
        } else {
          logger.info('ITFFTP scan pool acquisition failed on a closed transport; retrying');
        }
      } finally {
        if (connection && pooled) {
          connectionManager.releasePooledConnection(config, connection);
        }
      }
    }
    throw new Error('Unable to acquire a live comparison connection.');
  }

  private async scanComparison(
    config: FTPConfig,
    startDirectory = '',
    generation: number | undefined = undefined,
    partial = false,
    recursive = true,
    verifyDirtyContent = false,
    forceDirectoryCacheRefresh: boolean | { relativeDirectory: string; recursive: boolean } = false,
    synchronizedPaths?: ReadonlySet<string>
  ): Promise<void> {
    const previous = this.diffScanTail;
    let release!: () => void;
    const reservation = new Promise<void>(resolve => {release = resolve;});
    const tail = previous.then(() => reservation);
    this.diffScanTail = tail;
    await previous;
    try {
      const executionGeneration = generation ?? ++this.diffScanGeneration;
      if (forceDirectoryCacheRefresh === true) {
        this.diffDirectoryCache.clear();
      } else if (forceDirectoryCacheRefresh) {
        this.invalidateDiffDirectoryCache(
          config,
          forceDirectoryCacheRefresh.relativeDirectory,
          forceDirectoryCacheRefresh.recursive
        );
      }
      const expectedRevision = this.comparisonRevision;
      const synchronizationKey = this.cacheFile(config)?.toString();
      const pendingSynchronized = synchronizationKey
        ? this.pendingSynchronizedPaths.get(synchronizationKey)
        : undefined;
      const effectiveSynchronizedPaths = new Set<string>([
        ...(pendingSynchronized || []),
        ...(synchronizedPaths || [])
      ]);
      await this.runScanComparison(
        config,
        startDirectory,
        executionGeneration,
        partial,
        recursive,
        verifyDirtyContent,
        expectedRevision,
        effectiveSynchronizedPaths.size ? effectiveSynchronizedPaths : undefined
      );
    } finally {
      release();
      if (this.diffScanTail === tail) {this.diffScanTail = Promise.resolve();}
    }
  }

  private async runScanComparison(
    config: FTPConfig,
    startDirectory = '',
    generation: number,
    partial = false,
    recursive = true,
    verifyDirtyContent = false,
    expectedRevision = this.comparisonRevision,
    synchronizedPaths?: ReadonlySet<string>
  ): Promise<void> {
    const normalizedStart = normalizeRemoteRelativePath(startDirectory, true);
    if (normalizedStart === undefined) {throw new Error('Remote folder must stay inside the configured root.');}
    startDirectory = normalizedStart;
    if (generation !== this.diffScanGeneration || expectedRevision !== this.comparisonRevision) {return;}

    const scanStartedAt = Date.now();
    const cacheFile = this.cacheFile(config);
    if (cacheFile) {this.activeComparisonCacheKey = cacheFile.toString();}
    const root = (config.remotePath || '/').replace(/\\/g, '/').replace(/\/+$/g, '') || '/';
    const ignored = [...DEFAULT_IGNORE_PATTERNS, ...(config.ignore || [])];
    const configuredConcurrency = vscode.workspace.getConfiguration('stackerftp').get<number>('transferConcurrency', 4);
    const requestedScanConcurrency = Number.isFinite(configuredConcurrency) ? Math.round(configuredConcurrency) : 1;
    const scanConcurrency = config.protocol === 'sftp'
      ? 1
      : Math.min(MAX_FTP_SCAN_CONCURRENCY, Math.max(1, requestedScanConcurrency));
    const isCancelled = (): boolean => generation !== this.diffScanGeneration || expectedRevision !== this.comparisonRevision;
    const verifiedCleanPaths = new Set<string>();
    const skipRemoteDirectoryListing = new Set<string>();
    const knownStart = startDirectory ? this.latestDiffRecords.get(startDirectory) : undefined;
    if (startDirectory && knownStart?.local?.type === 'directory' && knownStart.remote?.type !== 'directory') {
      skipRemoteDirectoryListing.add(startDirectory);
    }
    const isAffectedPath = (path: string): boolean => {
      if (!startDirectory) {return recursive || !path.includes('/');}
      if (path === startDirectory) {return true;}
      if (!path.startsWith(`${startDirectory}/`)) {return false;}
      return recursive || !path.slice(startDirectory.length + 1).includes('/');
    };
    const previousAffectedPaths = partial
      ? [...this.latestDiffRecords.keys()].filter(isAffectedPath)
      : [...this.latestDiffRecords.keys()];
    const records: Map<string, DiffRecord> = partial
      ? new Map(this.latestDiffRecords)
      : new Map();
    if (partial) {
      for (const path of previousAffectedPaths) {
        if (path !== startDirectory) {records.delete(path);}
      }
    }

    let reportedPercentage = 0;
    let lastUiBatchAt = 0;
    const pendingUiRecords = new Map<string, DiffRecord>();
    const publishPendingUiRecords = (
      progress: { visitedDirectories: number; pendingDirectories: number },
      force = false
    ): void => {
      if (partial || pendingUiRecords.size === 0 || isCancelled()) {return;}
      const now = Date.now();
      if (!force && lastUiBatchAt > 0 && now - lastUiBatchAt < 150 && pendingUiRecords.size < 250) {return;}
      const batch = [...pendingUiRecords.values()];
      pendingUiRecords.clear();
      lastUiBatchAt = now;
      this.panel?.webview.postMessage({
        type: 'diffBatch',
        records: batch,
        scannedDirectories: progress.visitedDirectories,
        pendingDirectories: progress.pendingDirectories,
        complete: force && progress.pendingDirectories === 0
      });
    };

    this.beginDiffScanProgress(generation);
    logger.info(`ITFFTP paired diff scan started: ${root}${startDirectory ? `/${startDirectory}` : ''}; concurrency=${scanConcurrency}`);
    try {
      const session = { primary: await connectionManager.connect(config) };
      if (isCancelled()) {
        this.finishDiffScanProgress(generation, 'Comparison refresh superseded');
        this.sendComparisonSnapshot();
        return;
      }
      if (!partial) {
        this.panel?.webview.postMessage({ type: 'diffStart', root, startDirectory });
      }

      const traversal = await runBoundedRecursiveScan<{
        records: DiffRecord[];
        localCount: number;
        remoteCount: number;
        elapsedMs: number;
      }>({
        startDirectory,
        concurrency: scanConcurrency,
        isCancelled,
        scanDirectory: async (directory, workerIndex) => {
          const directoryStartedAt = Date.now();
          const localEntriesPromise = this.getWorkspaceDirectoryEntries(directory, ignored, config);
          return this.withDiffScanConnection(
            config,
            session,
            config.protocol === 'sftp' || workerIndex === 0,
            isCancelled,
            async connection => {
              const remoteEntries = skipRemoteDirectoryListing.has(directory)
                ? []
                : await this.getRemoteDirectoryEntries(
                  connection,
                  config,
                  directory,
                  ignored,
                  directory !== startDirectory
                );
              const localEntries = await localEntriesPromise;
              if (isCancelled()) {throw new Error('Comparison refresh was superseded.');}
              const localByPath = new Map(localEntries.map(entry => [entry.path, entry]));
              const remoteByPath = new Map(remoteEntries.map(entry => [entry.path, entry]));
              const directoryRecords = new Map<string, DiffRecord>();
              const childDirectories: string[] = [];
              for (const path of new Set([...localByPath.keys(), ...remoteByPath.keys()])) {
                const local = localByPath.get(path);
                const remote = remoteByPath.get(path);
                const type = local?.type === 'directory' || remote?.type === 'directory' ? 'directory' : 'file';
                directoryRecords.set(path, {
                  path,
                  type,
                  local: local && { type: local.type, size: local.size, modifyTime: local.modifyTime },
                  remote: remote && { type: remote.type, size: remote.size, modifyTime: remote.modifyTime },
                  status: 'same'
                });
                if (recursive && type === 'directory') {
                  childDirectories.push(path);
                  if (remote?.type !== 'directory') {skipRemoteDirectoryListing.add(path);}
                }
              }
              if (verifyDirtyContent) {
                await this.clearFalseDirtyFlags(connection, config, [...directoryRecords.keys()], directoryRecords, verifiedCleanPaths);
              }
              return {
                childDirectories,
                value: {
                  records: [...directoryRecords.values()],
                  localCount: localEntries.length,
                  remoteCount: remoteEntries.length,
                  elapsedMs: Date.now() - directoryStartedAt
                }
              };
            }
          );
        },
        onBatch: (entries, progress) => {
          if (isCancelled()) {return;}
          for (const entry of entries) {
            logger.info(`ITFFTP diff folder scan complete: ${entry.directory || '/'}; ${entry.value.localCount} local, ${entry.value.remoteCount} remote; ${entry.value.elapsedMs}ms`);
            for (const record of entry.value.records) {
              const live = this.latestDiffRecords.get(record.path);
              if (this.localDirtyPaths.has(record.path) && !synchronizedPaths?.has(record.path)) {
                if (live) {record.local = live.local;}
              }
              if (synchronizedPaths?.has(record.path)) {
                record.synchronized = this.createSynchronizedSignatures(record);
              } else if (live?.synchronized
                && this.signaturesMatch(record.local, live.synchronized.local)
                && this.signaturesMatch(record.remote, live.synchronized.remote)) {
                record.synchronized = {
                  local: { ...live.synchronized.local },
                  remote: { ...live.synchronized.remote }
                };
              }
              const synchronized = this.hasMatchingSynchronizedSignatures(record);
              if (synchronized) {verifiedCleanPaths.add(record.path);}
              const locallyDirty = this.localDirtyPaths.has(record.path)
                && !verifiedCleanPaths.has(record.path)
                && !synchronized;
              record.status = synchronized ? 'same' : classifyDiff(record, locallyDirty);
              record.newer = record.status === 'modified'
                ? newerSide(record, locallyDirty)
                : undefined;
              records.set(record.path, record);
              if (!partial) {
                pendingUiRecords.set(record.path, record);
              }
            }
          }
          publishPendingUiRecords(progress);

          const denominator = Math.max(1, progress.visitedDirectories + progress.pendingDirectories);
          reportedPercentage = Math.max(
            reportedPercentage,
            Math.min(95, Math.round((progress.visitedDirectories / denominator) * 95))
          );
          if (this.activeDiffProgressGeneration === generation) {
            const label = entries.length === 1
              ? `Compared ${entries[0].directory || '/'}`
              : `Compared ${entries.length} folders`;
            this.panel?.webview.postMessage({
              type: 'diffTransferProgress',
              active: true,
              label: `${label} · ${progress.visitedDirectories} scanned · ${progress.pendingDirectories} queued`,
              percentage: reportedPercentage
            });
          }
        }
      });

      if (traversal.cancelled || isCancelled()) {
        logger.info('ITFFTP paired diff scan superseded by a newer refresh');
        this.finishDiffScanProgress(generation, 'Comparison refresh superseded');
        this.sendComparisonSnapshot();
        return;
      }

      for (const dirtyPath of this.localDirtyPaths) {
        if (verifiedCleanPaths.has(dirtyPath) || synchronizedPaths?.has(dirtyPath)) {continue;}
        const live = this.latestDiffRecords.get(dirtyPath);
        const scanned = records.get(dirtyPath);
        if (live && scanned) {
          scanned.local = live.local;
          if (!partial) {pendingUiRecords.set(dirtyPath, scanned);}
        }
      }
      const cleanPaths = new Set(verifiedCleanPaths);
      for (const record of records.values()) {
        const synchronized = this.hasMatchingSynchronizedSignatures(record);
        const locallyDirty = this.localDirtyPaths.has(record.path)
          && !verifiedCleanPaths.has(record.path)
          && !synchronized;
        record.status = synchronized ? 'same' : classifyDiff(record, locallyDirty);
        record.newer = record.status === 'modified'
          ? newerSide(record, locallyDirty)
          : undefined;
        if (record.status === 'same') {cleanPaths.add(record.path);}
      }
      if (isCancelled()) {
        this.finishDiffScanProgress(generation, 'Comparison refresh superseded');
        this.sendComparisonSnapshot();
        return;
      }
      this.latestDiffRecords.clear();
      for (const [path, record] of records) {this.latestDiffRecords.set(path, record);}
      for (const cleanPath of cleanPaths) {this.localDirtyPaths.delete(cleanPath);}

      if (partial) {
        const affected = [...records.values()].filter(record => isAffectedPath(record.path));
        const currentPaths = new Set(affected.map(record => record.path));
        const removed = previousAffectedPaths.filter(path => !currentPaths.has(path));
        this.panel?.webview.postMessage({ type: 'diffPatch', root: startDirectory, records: affected, removed });
      } else {
        publishPendingUiRecords(
          { visitedDirectories: traversal.visitedDirectories, pendingDirectories: 0 },
          true
        );
        this.panel?.webview.postMessage({
          type: 'diffScanComplete',
          folders: traversal.visitedDirectories,
          paths: records.size
        });
      }

      const committedRevision = ++this.comparisonRevision;
      if (synchronizedPaths?.size && cacheFile) {
        const pendingSynchronized = this.pendingSynchronizedPaths.get(cacheFile.toString());
        if (pendingSynchronized) {
          for (const synchronizedPath of synchronizedPaths) {
            const synchronizedRecord = records.get(synchronizedPath);
            if (synchronizedRecord && this.hasMatchingSynchronizedSignatures(synchronizedRecord)) {
              pendingSynchronized.delete(synchronizedPath);
            }
          }
          if (pendingSynchronized.size === 0) {this.pendingSynchronizedPaths.delete(cacheFile.toString());}
        }
      }
      this.finishDiffScanProgress(generation, `Comparison updated (${records.size} paths)`, 100);
      this.scheduleComparisonCacheWrite(config, generation, committedRevision, records.values());
      const statusCounts = [...records.values()].reduce<Record<string, number>>((counts, record) => {
        counts[record.status] = (counts[record.status] || 0) + 1;
        return counts;
      }, {});
      logger.info(`ITFFTP paired diff scan complete: ${traversal.visitedDirectories} folders, ${records.size} paths, ${Date.now() - scanStartedAt}ms; ${JSON.stringify(statusCounts)}`);
    } catch (error) {
      if (isCancelled()) {
        this.finishDiffScanProgress(generation, 'Comparison refresh superseded');
        this.sendComparisonSnapshot();
        return;
      }
      logger.error('ITFFTP paired diff scan failed', error);
      this.sendComparisonSnapshot();
      this.panel?.webview.postMessage({ type: 'remoteDiffError', message: errorMessage(error) });
      this.finishDiffScanProgress(generation, 'Unable to refresh file comparison');
    }
  }

  private async getRemoteDirectoryEntries(connection: BaseConnection, config: FTPConfig, relativeDirectory: string, ignorePatterns: string[], allowMissing: boolean): Promise<DiffEntry[]> {
    const normalizedDirectory = normalizeRemoteRelativePath(relativeDirectory, true);
    if (normalizedDirectory === undefined) {throw new Error('Remote folder must stay inside the configured root.');}
    relativeDirectory = normalizedDirectory;
    const root = (config.remotePath || '/').replace(/\\/g, '/').replace(/\/+$/g, '') || '/';
    const remoteDirectory = relativeDirectory ? joinRemotePath(root, relativeDirectory) : root;
    const cacheKey = this.diffDirectoryCacheKey(config, remoteDirectory);
    const cached = this.diffDirectoryCache.get(cacheKey);
    if (cached) {return cached;}
    try {
      const listed = await connection.list(remoteDirectory);
      const entries = listed.flatMap((item): DiffEntry[] => {
        const name = safeRemoteEntryName(item.name);
        if (!name) {return [];}
        const path = relativeDirectory ? `${relativeDirectory}/${name}` : name;
        if (this.isIgnoredDiffPath(path, ignorePatterns)) {return [];}
        return [{ path, type: item.type === 'directory' ? 'directory' : 'file', size: Number(item.size || 0), modifyTime: item.modifyTime instanceof Date ? item.modifyTime.getTime() : Number(item.modifyTime || 0) }];
      });
      this.diffDirectoryCache.set(cacheKey, entries);
      return entries;
    } catch (error) {
      if (allowMissing && (isRemoteMissingError(error) || isRemoteNotDirectoryError(error))) {return [];}
      throw error;
    }
  }

  private signaturesMatch(actual: DiffSignature | undefined, expected: DiffSignature): boolean {
    return Boolean(actual
      && actual.type === expected.type
      && actual.size === expected.size
      && actual.modifyTime === expected.modifyTime);
  }

  private createSynchronizedSignatures(record: DiffRecord): SynchronizedSignatures | undefined {
    if (record.type !== 'file'
      || record.local?.type !== 'file'
      || record.remote?.type !== 'file'
      || record.local.size !== record.remote.size) {return undefined;}
    return {
      local: { ...record.local },
      remote: { ...record.remote }
    };
  }

  private hasMatchingSynchronizedSignatures(record: DiffRecord): boolean {
    return Boolean(record.synchronized
      && this.signaturesMatch(record.local, record.synchronized.local)
      && this.signaturesMatch(record.remote, record.synchronized.remote));
  }

  private diffStatus(record: DiffRecord): DiffRecord['status'] {
    if (this.hasMatchingSynchronizedSignatures(record)) {return 'same';}
    return classifyDiff(record, this.localDirtyPaths.has(record.path));
  }

  /**
   * Watchers report metadata-only writes as changes. For dirty, equal-sized
   * files, verify bytes before showing a modification. This keeps fast
   * size-based comparison for the normal scan while removing false positives.
   */
  private async clearFalseDirtyFlags(
    connection: BaseConnection,
    config: FTPConfig,
    paths: string[],
    records: Map<string, DiffRecord>,
    verifiedCleanPaths: Set<string>
  ): Promise<void> {
    if (!this.scope) {return;}
    const root = (config.remotePath || '/').replace(/\\/g, '/').replace(/\/+$/g, '') || '/';
    const candidates = paths
      .map(path => records.get(path))
      .filter((record): record is DiffRecord => Boolean(
        record?.type === 'file' &&
        record.local &&
        record.remote &&
        record.local.size === record.remote.size &&
        this.localDirtyPaths.has(record.path) &&
        Number(record.local.size || 0) <= 5 * 1024 * 1024
      ))
      .slice(0, 32);

    for (const record of candidates) {
      try {
        const local = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.localRoot(config), ...record.path.split('/')));
        const remote = await connection.readFile(joinRemotePath(root, record.path));
        if (Buffer.from(local).equals(Buffer.from(remote))) {
          verifiedCleanPaths.add(record.path);
        }
      } catch {
        // Keep the watcher-derived modified state when verification is unavailable.
      }
    }
  }

  private async readDiffFile(direction: 'local' | 'remote', relativePath: unknown, value: unknown): Promise<void> {
    const filePath = normalizeRemoteRelativePath(relativePath);
    if (!filePath) {return;}
    if (direction === 'local') {
      const record = this.latestDiffRecords.get(filePath);
      const describe = (entry?: { size?: number; modifyTime?: number }): string => entry
        ? `${entry.size ?? 0} bytes, ${entry.modifyTime ? new Date(entry.modifyTime).toISOString() : 'time unknown'}`
        : 'missing';
      logger.info(`ITFFTP diff file selected: ${filePath}; local=${describe(record?.local)}; remote=${describe(record?.remote)}; status=${record?.status || 'unknown'}`);
    }
    const config = this.resolveConnections(value)[0] || connectionManager.getPrimaryConfig();
    if (!config) {throw new Error('Select a host before reading a file.');}
    try {
      let content = '';
      if (direction === 'local') {
        if (!this.scope) {throw new Error('No workspace is selected.');}
        const data = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.localRoot(config), ...filePath.split('/')));
        content = new TextDecoder('utf-8').decode(data);
      } else {
        const connection = await connectionManager.connect(config);
        const root = (config.remotePath || '/').replace(/\/$/, '');
        content = (await connection.readFile(joinRemotePath(root, filePath))).toString('utf8');
      }
      this.panel?.webview.postMessage({ type: 'diffFile', direction, path: filePath, content });
    } catch (error) {
      const details = errorMessage(error, '');
      const missing = /ENOENT|no such file|not found/i.test(details);
      this.panel?.webview.postMessage({
        type: 'diffFile',
        direction,
        path: filePath,
        content: missing ? `File doesn't exist on ${direction}.` : `Unable to read the ${direction} file.`
      });
    }
  }

  private async handleDiffAction(action: string, direction: 'local' | 'remote', relativePath: unknown, value: unknown, preparationJobId?: string): Promise<void> {
    const filePath = normalizeRemoteRelativePath(relativePath);
    if (!filePath) {return;}
    // Aggregate rows use "directory" when either side is a directory. Actions
    // must instead use the selected/source side or a local-file/remote-folder
    // collision is mistaken for a recursive folder action.
    const initialRecord = this.latestDiffRecords.get(filePath);
    const initialSelectedEntry = direction === 'local' ? initialRecord?.local : initialRecord?.remote;
    let isDirectory = initialSelectedEntry?.type === 'directory' || filePath.endsWith('/');
    const relativeSegments = filePath.replace(/\/$/, '').split('/');
    if (!this.scope) {throw new Error('No workspace is selected.');}
    const config = this.resolveConnections(value)[0] || connectionManager.getPrimaryConfig() || configManager.getConfigs(this.scope.fsPath).find(candidate => candidate.default) || configManager.getConfigs(this.scope.fsPath)[0];
    if (!config) {throw new Error('Select a host before using this action.');}
    if (isDirectory && (action === 'upload' || action === 'download')) {
      // Folder transfers use only changed files, so complete this subtree just
      // before selecting candidates rather than during initial panel load.
      await this.scanComparison(config, filePath.replace(/\/$/, ''), ++this.diffScanGeneration, true, true, true);
    }
    const connection = await connectionManager.connect(config);
    const transferConfig = this.withDashboardSyncMode(config);
    const remoteRoot = (config.remotePath || '/').replace(/\/$/, '');
    const remotePath = joinRemotePath(remoteRoot, filePath.replace(/\/$/, ''));
    const record = this.latestDiffRecords.get(filePath);
    const selectedEntry = direction === 'local' ? record?.local : record?.remote;
    isDirectory = selectedEntry ? selectedEntry.type === 'directory' : isDirectory;
    const localRoot = this.localRoot(config);
    const localUri = vscode.Uri.joinPath(localRoot, ...relativeSegments);
    let transferredPaths: string[] | undefined;
    if (action === 'upload' && direction === 'local') {
      this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: true, label: `Uploading ${filePath}`, percentage: 0 });
      const selectedCandidate = record ? this.getTransferCandidates([record], 'upload')[0] : undefined;
      if (isDirectory && selectedCandidate?.type === 'directory') {
        this.removeDashboardJob(preparationJobId);
        const outcome = await this.transferDiffCandidate(connection, selectedCandidate, 'upload', transferConfig);
        if (outcome.status !== 'completed') {
          this.reportSkippedTransfers([{ path: filePath, reason: outcome.reason }]);
          return;
        }
        transferredPaths = [filePath];
      } else if (isDirectory) {
        const changedEntries = this.getChangedSubtreeFiles(filePath, 'upload');
        if (!changedEntries.length) {
          this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: false, label: `No changed entries under ${filePath}`, percentage: 100 });
          return;
        }
        this.removeDashboardJob(preparationJobId);
        const settled = await Promise.allSettled(changedEntries.map(candidate =>
          this.transferDiffCandidate(connection, candidate, 'upload', transferConfig)
        ));
        const { completedPaths, skipped, failedCount } = this.classifySettledTransfers(
          changedEntries.map(candidate => candidate.path),
          settled
        );
        if (failedCount || skipped.length) {
          if (completedPaths.length) {await this.refreshAfterTransfer(completedPaths, 'upload', config);}
          this.reportSkippedTransfers(skipped);
          if (failedCount) {throw new Error(`Uploaded ${completedPaths.length} changed entries; ${failedCount} failed.`);}
          return;
        }
        transferredPaths = completedPaths;
      }
      else {
        if (!selectedCandidate) {throw new Error(`The local source no longer exists: ${filePath}`);}
        this.removeDashboardJob(preparationJobId);
        const outcome = await this.transferDiffCandidate(connection, selectedCandidate, 'upload', transferConfig);
        if (outcome.status !== 'completed') {
          this.reportSkippedTransfers([{ path: filePath, reason: outcome.reason }]);
          return;
        }
      }
    } else if (action === 'download' && direction === 'remote') {
      this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: true, label: `Downloading ${filePath}`, percentage: 0 });
      const selectedCandidate = record ? this.getTransferCandidates([record], 'download')[0] : undefined;
      if (isDirectory && selectedCandidate?.type === 'directory') {
        this.removeDashboardJob(preparationJobId);
        const outcome = await this.transferDiffCandidate(connection, selectedCandidate, 'download', transferConfig);
        if (outcome.status !== 'completed') {
          this.reportSkippedTransfers([{ path: filePath, reason: outcome.reason }]);
          return;
        }
        transferredPaths = [filePath];
      } else if (isDirectory) {
        const changedEntries = this.getChangedSubtreeFiles(filePath, 'download');
        if (!changedEntries.length) {
          this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: false, label: `No changed entries under ${filePath}`, percentage: 100 });
          return;
        }
        this.removeDashboardJob(preparationJobId);
        const settled = await Promise.allSettled(changedEntries.map(candidate =>
          this.transferDiffCandidate(connection, candidate, 'download', transferConfig)
        ));
        const { completedPaths, skipped, failedCount } = this.classifySettledTransfers(
          changedEntries.map(candidate => candidate.path),
          settled
        );
        if (failedCount || skipped.length) {
          if (completedPaths.length) {await this.refreshAfterTransfer(completedPaths, 'download', config);}
          this.reportSkippedTransfers(skipped);
          if (failedCount) {throw new Error(`Downloaded ${completedPaths.length} changed entries; ${failedCount} failed.`);}
          return;
        }
        transferredPaths = completedPaths;
      } else {
        if (!selectedCandidate) {throw new Error(`The remote source no longer exists: ${filePath}`);}
        this.removeDashboardJob(preparationJobId);
        const outcome = await this.transferDiffCandidate(connection, selectedCandidate, 'download', transferConfig);
        if (outcome.status !== 'completed') {
          this.reportSkippedTransfers([{ path: filePath, reason: outcome.reason }]);
          return;
        }
      }
    }
    else if (action === 'delete') {
      const choice = await vscode.window.showWarningMessage(`Delete ${filePath}?`, { modal: true }, 'Delete');
      if (choice !== 'Delete') {return;}
      const deleteJobId = `delete-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
      this.updateDashboardJob({ id: deleteJobId, path: filePath, direction: 'delete', status: 'transferring', progress: 0 });
      this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: true, label: `Deleting ${filePath}`, percentage: 0 });
      try {
        if (direction === 'local') {
          try {
            await vscode.workspace.fs.delete(localUri, { recursive: isDirectory, useTrash: true });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!/recycle bin|trash/i.test(message)) {throw error;}
            // VS Code cannot recycle files on some UNC/network workspaces. The
            // user already confirmed this delete, so fall back to direct removal.
            await vscode.workspace.fs.delete(localUri, { recursive: isDirectory, useTrash: false });
            logger.info(`ITFFTP local delete bypassed unavailable recycle bin: ${filePath}`);
          }
        }
        else if (isDirectory) {await connection.rmdir(remotePath, true);}
        else {await connection.delete(remotePath);}
        this.updateDashboardJob({ id: deleteJobId, path: filePath, direction: 'delete', status: 'completed', progress: 100, endTime: Date.now() });
      } catch (error) {
        this.updateDashboardJob({ id: deleteJobId, path: filePath, direction: 'delete', status: 'error', progress: 100, endTime: Date.now() });
        throw error;
      }
    } else if (action === 'rename') {
      const nextNameInput = await vscode.window.showInputBox({
        prompt: 'New file name',
        value: filePath.split('/').pop(),
        validateInput: candidate => safeRemoteEntryName(candidate.trim())
          ? undefined
          : 'Enter one name without slashes, dot segments, or control characters.'
      });
      if (!nextNameInput) {return;}
      const nextName = nextNameInput.trim();
      if (!safeRemoteEntryName(nextName)) {throw new Error('New file name is invalid.');}
      const nextRelative = `${filePath.slice(0, filePath.lastIndexOf('/') + 1)}${nextName}`;
      if (direction === 'local') {await vscode.workspace.fs.rename(localUri, vscode.Uri.joinPath(localRoot, ...nextRelative.split('/')), { overwrite: false });}
      else {await connection.rename(remotePath, joinRemotePath(remoteRoot, nextRelative));}
    }
    logger.info(`ITFFTP diff ${action} completed: ${filePath}; updating cached comparison`);
    if (action === 'upload' || action === 'download') {
      await this.refreshAfterTransfer(transferredPaths || [filePath], action, config);
    } else {
      await this.refreshChangedPathAfterMutation(filePath, direction, action, config);
    }
    const completedLabel = action === 'upload' ? 'Uploaded' : action === 'download' ? 'Downloaded' : action === 'delete' ? 'Deleted' : 'Renamed';
    this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: false, label: `${completedLabel} ${filePath}`, percentage: 100 });
    this.panel?.webview.postMessage({ type: 'diffActionComplete', action, direction, path: filePath });
  }

  private getChangedSubtreeFiles(folderPath: string, direction: 'upload' | 'download'): DiffTransferCandidate[] {
    const prefix = `${folderPath.replace(/\/$/, '')}/`;
    const changedRecords = [...this.latestDiffRecords.values()].filter(record => {
      if (!record.path.startsWith(prefix)) {return false;}
      if (direction === 'upload') {
        return Boolean(record.local) && (record.status === 'modified' || record.status === 'missing-remote' || record.status === 'type-changed');
      }
      return Boolean(record.remote) && (record.status === 'modified' || record.status === 'missing-local' || record.status === 'type-changed');
    });
    return this.getTransferCandidates(changedRecords, direction)
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  private async exportConnections(value: unknown, selectedOnly: boolean): Promise<void> {
    const connections = this.parseConnections(value);
    if (connections.length === 0) {
      throw new Error('Add a remote location before exporting configuration.');
    }

    const destination = await vscode.window.showSaveDialog({
      title: selectedOnly ? 'Export selected ITFFTP remote location' : 'Export all ITFFTP remote locations',
      defaultUri: vscode.Uri.joinPath(this.scope!, selectedOnly ? 'itfftp-host.json' : 'itfftp-hosts.json'),
      filters: { 'JSON configuration': ['json'] }
    });

    if (!destination) {return;}

    const data = selectedOnly && connections.length === 1 ? connections[0] : connections;
    await vscode.workspace.fs.writeFile(destination, new TextEncoder().encode(JSON.stringify(data, null, 2)));
    vscode.window.showInformationMessage(
      `ITFFTP: Exported ${connections.length} remote location${connections.length === 1 ? '' : 's'}. Keep this file secure if it contains credentials.`
    );
  }

  private async getWorkspaceDirectory(relativeDirectory: string, ignorePatterns: string[], config: FTPConfig): Promise<{ files: string[]; stats: Record<string, { size: number; modifyTime: number }> }> {
    if (!this.scope) {return { files: [], stats: {} };}
    const root = this.localRoot(config);
    const directory = relativeDirectory ? vscode.Uri.joinPath(root, ...relativeDirectory.split('/')) : root;
    const files: string[] = [];
    const stats: Record<string, { size: number; modifyTime: number }> = {};
    try {
      const entries = await vscode.workspace.fs.readDirectory(directory);
      for (const [name, type] of entries) {
        const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
        if (this.isIgnoredDiffPath(relativePath, ignorePatterns)) {continue;}
        if (type === vscode.FileType.Directory) {files.push(`${relativePath}/`);}
        else if (type === vscode.FileType.File) {
          files.push(relativePath);
          try {
            const stat = await vscode.workspace.fs.stat(vscode.Uri.joinPath(directory, name));
            stats[relativePath] = { size: stat.size, modifyTime: stat.mtime };
          } catch { /* File disappeared while listing. */ }
        }
      }
    } catch { /* Missing/unreadable local folder is represented as empty. */ }
    return { files: files.sort((left, right) => left.localeCompare(right)), stats };
  }

  private async getWorkspaceDirectoryEntries(relativeDirectory: string, ignorePatterns: string[], config: FTPConfig): Promise<DiffEntry[]> {
    if (!this.scope) {return [];}
    const root = this.localRoot(config);
    const directory = relativeDirectory ? vscode.Uri.joinPath(root, ...relativeDirectory.split('/')) : root;
    try {
      const entries = await vscode.workspace.fs.readDirectory(directory);
      const result: DiffEntry[] = [];
      for (const [name, type] of entries) {
        const path = relativeDirectory ? `${relativeDirectory}/${name}` : name;
        if (this.isIgnoredDiffPath(path, ignorePatterns)) {continue;}
        if (type === vscode.FileType.Directory) {result.push({ path, type: 'directory' });}
        else if (type === vscode.FileType.File) {
          try {
            const stat = await vscode.workspace.fs.stat(vscode.Uri.joinPath(directory, name));
            result.push({ path, type: 'file', size: stat.size, modifyTime: stat.mtime });
          } catch { /* File changed while listing. */ }
        }
      }
      return result.sort((left, right) => left.path.localeCompare(right.path));
    } catch {
      return [];
    }
  }

  private async getWorkspaceFiles(
    ignorePatterns: readonly string[] = DEFAULT_IGNORE_PATTERNS,
    limits: { maxEntries: number; maxDirectories: number; maxDepth: number } = {
      maxEntries: 100_000,
      maxDirectories: DEFAULT_MAX_SCAN_DIRECTORIES,
      maxDepth: DEFAULT_MAX_SCAN_DEPTH
    }
  ): Promise<string[]> {
    if (!this.scope) {return [];}
    if (!Number.isSafeInteger(limits.maxEntries) || limits.maxEntries < 1) {
      throw new RangeError('Workspace inventory maxEntries must be a positive safe integer.');
    }

    const files: string[] = [];
    await runBoundedRecursiveScan<string[]>({
      startDirectory: '',
      concurrency: 4,
      maxDirectories: limits.maxDirectories,
      maxDepth: limits.maxDepth,
      isCancelled: () => false,
      scanDirectory: async relativeDirectory => {
        const directory = relativeDirectory
          ? vscode.Uri.joinPath(this.scope!, ...relativeDirectory.split('/'))
          : this.scope!;
        let entries: [string, vscode.FileType][];
        try {
          entries = await vscode.workspace.fs.readDirectory(directory);
        } catch (error) {
          throw new Error(`Unable to read workspace folder ${relativeDirectory || '.'}: ${errorMessage(error)}`);
        }
        const childDirectories: string[] = [];
        const discoveredEntries: string[] = [];
        for (const [name, type] of entries) {
          const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
          if (this.isIgnoredDiffPath(relativePath, ignorePatterns)) {continue;}
          if (type === vscode.FileType.Directory) {
            childDirectories.push(relativePath);
            discoveredEntries.push(`${relativePath}/`);
          } else if (type === vscode.FileType.File) {
            discoveredEntries.push(relativePath);
          }
        }
        return { childDirectories, value: discoveredEntries };
      },
      onBatch: entries => {
        const discoveredEntries = entries.flatMap(entry => entry.value);
        if (files.length + discoveredEntries.length > limits.maxEntries) {
          throw new Error(`Workspace inventory exceeded the maximum entry count of ${limits.maxEntries}.`);
        }
        files.push(...discoveredEntries);
      }
    });

    return files.sort((left, right) => left.localeCompare(right));
  }

  private isIgnoredDiffPath(relativePath: string, patterns: readonly string[]): boolean {
    return isPathIgnored(relativePath, patterns);
  }

  private async getWorkspaceFileStats(
    workspaceFiles?: string[]
  ): Promise<Record<string, { size: number; modifyTime: number }>> {
    if (!this.scope) {return {};}
    const stats: Record<string, { size: number; modifyTime: number }> = {};
    for (const relative of workspaceFiles || await this.getWorkspaceFiles()) {
      if (relative.endsWith('/')) {continue;}
      try {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.joinPath(this.scope, ...relative.split('/')));
        stats[relative] = { size: stat.size, modifyTime: stat.mtime };
      } catch {
        // File may disappear while the workspace is being scanned.
      }
    }
    return stats;
  }

  private parseConcurrency(value: unknown): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      throw new Error('Transfer concurrency must be an integer from 1 to 100.');
    }
    return parsed;
  }

  private parseSortOrder(value: unknown): 'name' | 'size' | 'date' | 'type' {
    if (value === 'name' || value === 'size' || value === 'date' || value === 'type') {
      return value;
    }
    throw new Error('Remote explorer sort order is invalid.');
  }

  private async getHtmlForWebview(webview: vscode.Webview, nonce: string): Promise<string> {
    const resourcesPath = vscode.Uri.joinPath(this.extensionUri, 'resources', 'webview');
    let htmlContent = '';
    let cssContent = '';
    let jsContent = '';

    try {
      const [htmlData, cssData, jsData] = await Promise.all([
        vscode.workspace.fs.readFile(vscode.Uri.joinPath(resourcesPath, 'settings.html')),
        vscode.workspace.fs.readFile(vscode.Uri.joinPath(resourcesPath, 'settings.css')),
        vscode.workspace.fs.readFile(vscode.Uri.joinPath(resourcesPath, 'settings.js'))
      ]);
      const decoder = new TextDecoder('utf-8');
      htmlContent = decoder.decode(htmlData);
      cssContent = decoder.decode(cssData);
      jsContent = decoder.decode(jsData);
    } catch (error) {
      logger.error('Failed to load settings webview resources', error);
      htmlContent = '<main class="settings-container"><p>Unable to load settings.</p></main>';
    }

    const codiconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'resources', 'codicons', 'codicon.css')
    );
    const chartUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'resources', 'webview', 'vendor', 'chart.umd.js')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource};">
  <link href="${codiconUri}" rel="stylesheet">
  <style>${cssContent}</style>
</head>
<body>
  ${htmlContent}
  <script nonce="${nonce}" src="${chartUri}"></script>
  <script nonce="${nonce}">${jsContent}</script>
</body>
</html>`;
  }

  private getNonce(): string {
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i++) {
      nonce += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return nonce;
  }
}

/**
 * ITFFTP - Extension Settings Webview
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { logger } from '../utils/logger';
import { statusBar } from '../utils/status-bar';
import { configManager } from '../core/config';
import { transferManager } from '../core/transfer-manager';
import { connectionManager } from '../core/connection-manager';
import { AnalyticsStore } from '../core/analytics-store';
import { classifyDiff, newerSide, shouldSyncDiff } from '../core/diff-comparison';
import { BaseConnection } from '../core/connection';
import { isConnectionClosedError } from '../core/connection-errors';
import { FTPConfig } from '../types';
import { DEFAULT_IGNORE_PATTERNS, isPathIgnored } from '../utils/helpers';

type SettingsSavedHandler = (scope: vscode.Uri) => Promise<void> | void;

type DiffEntry = {
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modifyTime?: number;
};

type DiffRecord = {
  path: string;
  type: 'file' | 'directory';
  local?: Omit<DiffEntry, 'path'>;
  remote?: Omit<DiffEntry, 'path'>;
  status: 'same' | 'missing-local' | 'missing-remote' | 'modified' | 'type-changed';
  newer?: 'local' | 'remote';
};

type DashboardJob = {
  id: string;
  path: string;
  direction: 'upload' | 'download' | 'delete';
  status: 'transferring' | 'completed' | 'error';
  progress: number;
  endTime?: number;
};

const DIFF_CACHE_VERSION = 2;

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
  'useNativeTreeView',
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
  useNativeTreeView: true,
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
  private pendingDiffRefresh?: { value: unknown; generation: number; key: string };
  private hasPendingDiffRefresh = false;
  private diffScanGeneration = 0;
  private activeDiffRequestKey?: string;
  private readonly diffDirectoryCache = new Map<string, DiffEntry[]>();
  private readonly latestDiffRecords = new Map<string, DiffRecord>();
  private localWatcher?: vscode.FileSystemWatcher;
  private readonly localRefreshTimers = new Map<string, NodeJS.Timeout>();
  private cacheWriteTimer?: NodeJS.Timeout;
  private backgroundRefreshTimer?: NodeJS.Timeout;
  private watchedRefreshTimer?: NodeJS.Timeout;
  private watchedRefreshConfig?: FTPConfig;
  private lastBackgroundRefreshAt = 0;
  private activeComparisonCacheKey?: string;
  private readonly localDirtyPaths = new Set<string>();
  // Retained while legacy folder messages are accepted; all dashboard scans use
  // scanComparison above and therefore never enter this path.
  private readonly diffFullScans = new Set<string>();
  private analyticsProjectFilter = 'all';
  private transferQueueExpiryTimer?: NodeJS.Timeout;
  private readonly dashboardJobs = new Map<string, DashboardJob>();
  private readonly analyticsChangedListener = () => void this.sendAnalytics();
  private readonly transferProgressListener = () => {
    if (!this.panel) {return;}
    const queue = transferManager.getQueue();
    const now = Date.now();
    const visible = queue.filter(item => item.status === 'pending' || item.status === 'transferring'
      || ((item.status === 'completed' || item.status === 'error') && item.endTime && now - item.endTime.getTime() < 8000));
    for (const [id, job] of this.dashboardJobs) {
      if (job.endTime && now - job.endTime >= 8000) {this.dashboardJobs.delete(id);}
    }
    const dashboardJobs = [...this.dashboardJobs.values()];
    void this.panel.webview.postMessage({
      type: 'diffTransferQueue',
      items: [...visible.map(item => {
        const remoteRoot = (item.config?.remotePath || '/').replace(/\\/g, '/').replace(/\/+$/g, '') || '/';
        const normalized = item.remotePath.replace(/\\/g, '/');
        const relativePath = normalized.startsWith(`${remoteRoot}/`) ? normalized.slice(remoteRoot.length + 1) : normalized.replace(/^\/+/, '');
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
    if (visible.some(item => item.status === 'completed' || item.status === 'error') || dashboardJobs.some(item => item.endTime)) {
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
    if (changedScope) {this.diffScanGeneration++;}
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
    const identity = [this.scope.toString(), config.protocol, config.host, config.port || '', config.localPath || '.', config.remotePath || '/', ...(config.ignore || [])].join('\n');
    const key = crypto.createHash('sha256').update(identity).digest('hex');
    return vscode.Uri.joinPath(this.globalStorageUri, 'diff-cache', `${key}.json`);
  }

  private async loadCachedComparison(config: FTPConfig): Promise<void> {
    const file = this.cacheFile(config);
    if (!file) {return;}
    const cacheKey = file.toString();
    if (this.activeComparisonCacheKey === cacheKey && this.latestDiffRecords.size) {
      this.sendComparisonSnapshot();
      return;
    }
    if (this.activeComparisonCacheKey !== cacheKey) {
      this.latestDiffRecords.clear();
      this.diffDirectoryCache.clear();
      this.activeComparisonCacheKey = cacheKey;
    }
    try {
      const parsed = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(file)));
      if (parsed?.version !== DIFF_CACHE_VERSION || !Array.isArray(parsed.records)) {return;}
      for (const record of parsed.records) {
        if (record && typeof record.path === 'string' && (record.type === 'file' || record.type === 'directory')) {
          this.latestDiffRecords.set(record.path, record as DiffRecord);
        }
      }
      logger.info(`ITFFTP comparison cache loaded: ${this.latestDiffRecords.size} paths`);
      this.sendComparisonSnapshot();
    } catch {
      // The cache is optional and is created after the first completed scan.
    }
  }

  private scheduleComparisonCacheWrite(config: FTPConfig): void {
    if (this.cacheWriteTimer) {clearTimeout(this.cacheWriteTimer);}
    this.cacheWriteTimer = setTimeout(() => {
      this.cacheWriteTimer = undefined;
      void this.persistComparisonCache(config);
    }, 300);
  }

  private async persistComparisonCache(config: FTPConfig): Promise<void> {
    const file = this.cacheFile(config);
    if (!file) {return;}
    const temporary = vscode.Uri.joinPath(
      vscode.Uri.joinPath(this.globalStorageUri!, 'diff-cache'),
      `${file.path.split('/').pop()}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    );
    try {
      const payload = JSON.stringify({ version: DIFF_CACHE_VERSION, updatedAt: new Date().toISOString(), records: [...this.latestDiffRecords.values()] });
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.globalStorageUri!, 'diff-cache'));
      await vscode.workspace.fs.writeFile(temporary, new TextEncoder().encode(payload));
      await vscode.workspace.fs.rename(temporary, file, { overwrite: true });
    } catch (error) {
      logger.warn('Unable to persist ITFFTP comparison cache', error);
      try { await vscode.workspace.fs.delete(temporary); } catch { /* Another window may already have replaced the cache. */ }
    }
  }

  public async refreshWatchedPath(config: FTPConfig, relativePath: string): Promise<void> {
    if (!relativePath || relativePath.includes('../')) {return;}
    this.watchedRefreshConfig = config;
    if (this.watchedRefreshTimer) {clearTimeout(this.watchedRefreshTimer);}
    this.watchedRefreshTimer = setTimeout(() => {
      this.watchedRefreshTimer = undefined;
      const active = this.watchedRefreshConfig;
      this.watchedRefreshConfig = undefined;
      if (!active) {return;}
      // A watcher event says state changed; it does not prove the two peers now
      // match. Relist both complete trees so collapsed descendants stay correct.
      this.diffDirectoryCache.clear();
      void this.scanComparison(active, '', ++this.diffScanGeneration, false, true, false);
    }, 250);
  }

  private sendComparisonSnapshot(): void {
    if (!this.panel || !this.latestDiffRecords.size) {return;}
    void this.panel.webview.postMessage({ type: 'diffSnapshot', records: [...this.latestDiffRecords.values()], folders: [...this.latestDiffRecords.values()].filter(record => record.type === 'directory').length, cached: true });
  }

  private async refreshLocalCacheEntry(uri: vscode.Uri, config: FTPConfig): Promise<void> {
    if (!this.scope) {return;}
    const relativePath = this.relativeLocalPath(uri, config);
    if (!relativePath) {return;}
    const current = this.latestDiffRecords.get(relativePath);
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      const type: DiffRecord['type'] = stat.type === vscode.FileType.Directory ? 'directory' : 'file';
      const record: DiffRecord = {
        path: relativePath,
        type,
        local: { type, size: type === 'file' ? stat.size : undefined, modifyTime: stat.mtime },
        remote: current?.remote,
        status: 'same'
      };
      record.status = this.diffStatus(record);
      record.newer = record.status === 'modified' ? newerSide(record, this.localDirtyPaths.has(record.path)) : undefined;
      this.latestDiffRecords.set(relativePath, record);
    } catch {
      if (current?.remote) {
        const record: DiffRecord = { ...current, local: undefined, status: 'missing-local' };
        this.latestDiffRecords.set(relativePath, record);
      } else {
        this.latestDiffRecords.delete(relativePath);
      }
    }
    this.sendComparisonSnapshot();
    this.scheduleComparisonCacheWrite(config);
  }

  private async handleMessage(message: any): Promise<void> {
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
          this.diffDirectoryCache.clear();
          await this.loadRemoteDiff(undefined, true);
          break;
        case 'loadDiffRemote':
          if (message.force) {this.diffDirectoryCache.clear();}
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
          await this.readDiffFile(message.direction, message.path, message.connection);
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
              await this.handleDiffAction(message.action, message.direction, message.path, message.connection, preparationJobId);
            } finally {
              this.removeDashboardJob(preparationJobId);
            }
          }
          break;
        case 'diffTransfer':
          await this.handleDiffAction(message.direction, message.direction === 'upload' ? 'local' : 'remote', message.path, message.connection);
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
    } catch (error: any) {
      logger.error('Settings panel message handler error', error);
      this.panel?.webview.postMessage({
        type: 'saveError',
        message: error?.message || String(error)
      });
      statusBar.error(`Settings error: ${error?.message || error}`);
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
      useNativeTreeView: configuration.get<boolean>('useNativeTreeView', DEFAULT_SETTINGS.useNativeTreeView),
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
      const config = this.parseConnections(connectionValue)[0] || connectionManager.getPrimaryConfig();
      if (!config) {throw new Error('Select a host before browsing remote folders.');}
      const remotePath = `/${requestedPath}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
      const connection = await connectionManager.connect(config);
      entries = (await connection.list(remotePath))
        .filter((entry: any) => entry.type === 'directory' && entry.name && entry.name !== '.' && entry.name !== '..')
        .map((entry: any) => ({ name: String(entry.name), path: `${remotePath === '/' ? '' : remotePath}/${entry.name}`.replace(/\/+/g, '/') }))
        .sort((left: { name: string }, right: { name: string }) => left.name.localeCompare(right.name));
    }
    this.panel.webview.postMessage({ type: 'folderPicker', requestId, kind: folderKind, path: requestedPath, entries });
  }

  private async createRemoteFolder(value: unknown): Promise<void> {
    const config = this.parseConnections(value)[0] || connectionManager.getPrimaryConfig();
    if (!config) {throw new Error('Select a host before creating a remote folder.');}
    const name = await vscode.window.showInputBox({ title: 'Create remote folder', prompt: `Folder name inside ${config.remotePath || '/'}`, validateInput: candidate => !candidate.trim() ? 'Enter a folder name.' : /[\\/]/.test(candidate) || candidate === '.' || candidate === '..' ? 'Enter one folder name without slashes.' : undefined });
    if (!name) {return;}
    const root = (config.remotePath || '/').replace(/\\/g, '/').replace(/\/+$/g, '') || '/';
    const remotePath = `${root === '/' ? '' : root}/${name.trim()}`.replace(/\/+/g, '/');
    const connection = await connectionManager.connect(config);
    await connection.mkdir(remotePath);
    this.diffDirectoryCache.clear();
    await this.scanComparison(config, '', ++this.diffScanGeneration, false, false);
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
    }
  }

  private async sendAnalytics(): Promise<void> {
    const analytics = this.analyticsStore ? await this.analyticsStore.getAnalytics(this.analyticsProjectFilter) : transferManager.getAnalytics();
    this.panel?.webview.postMessage({ type: 'analytics', analytics });
  }

  private async saveSettings(values: any): Promise<void> {
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
      useNativeTreeView: Boolean(values?.useNativeTreeView),
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
    statusBar.success('ITFFTP settings saved automatically');

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
    statusBar.success('Workspace setting overrides reset');
  }

  private parseConnections(value: unknown): FTPConfig[] {
    let parsed: unknown = value;
    if (typeof value === 'string') {
      parsed = JSON.parse(value.trim() || '[]');
    }

    const connections = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    for (const connection of connections) {
      if (!connection || typeof connection !== 'object' || Array.isArray(connection)) {
        throw new Error('Each connection must be a JSON object.');
      }
      const candidate = connection as Partial<FTPConfig>;
      if (!candidate.host || !candidate.username || !candidate.protocol) {
        throw new Error('Each connection requires host, username, and protocol.');
      }
      if (!['sftp', 'ftp', 'ftps'].includes(candidate.protocol)) {
        throw new Error(`Unsupported connection protocol: ${candidate.protocol}`);
      }
      if (candidate.collisionPolicy && !['ask', 'overwrite', 'skip'].includes(candidate.collisionPolicy)) {
        throw new Error(`Unsupported collision policy: ${candidate.collisionPolicy}`);
      }
      if (candidate.syncMode && !['update', 'full'].includes(candidate.syncMode)) {
        throw new Error(`Unsupported sync mode: ${candidate.syncMode}`);
      }
      if (candidate.localPath !== undefined) {
        const localPath = String(candidate.localPath).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        if (localPath.split('/').some(segment => segment === '..')) {
          throw new Error('Local folder must stay inside the workspace.');
        }
        candidate.localPath = localPath || undefined;
      }
      if (candidate.default !== undefined && typeof candidate.default !== 'boolean') {
        throw new Error('The default host marker must be true or false.');
      }
      if (candidate.keepalive !== undefined && (!Number.isInteger(candidate.keepalive) || candidate.keepalive < 0)) {
        throw new Error('Keepalive must be a whole number of milliseconds, or 0 to disable it.');
      }
    }

    if (connections.filter(connection => Boolean((connection as FTPConfig).default)).length > 1) {
      throw new Error('Only one remote location can be the default host.');
    }

    return connections as FTPConfig[];
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
    statusBar.success(`Imported ${connections.length} remote location${connections.length === 1 ? '' : 's'}`);
  }

  private async testConnection(value: unknown): Promise<void> {
    try {
      const config = this.parseConnections(value)[0];
      if (!config) {throw new Error('Select a host before testing the connection.');}
      const connection = await connectionManager.connect(config);
      await connection.list(config.remotePath || '/');
      await connectionManager.disconnect(config);
      this.panel?.webview.postMessage({ type: 'testSuccess', message: `Connection test succeeded for ${config.host}.` });
      statusBar.success(`Connection test succeeded: ${config.host}`);
    } catch (error: any) {
      this.panel?.webview.postMessage({ type: 'testError', message: error?.message || String(error) });
      statusBar.error(`Connection test failed: ${error?.message || error}`, true);
    }
  }

  private async loadRemoteDiff(value: unknown, force = false): Promise<void> {
    const requestedConfig = this.parseConnections(value)[0] || connectionManager.getPrimaryConfig();
    if (!requestedConfig) {throw new Error('Select a host before loading remote files.');}
    const requestedCacheKey = this.cacheFile(requestedConfig)?.toString();
    if (!force && this.latestDiffRecords.size && requestedCacheKey && this.activeComparisonCacheKey === requestedCacheKey) {
      this.sendComparisonSnapshot();
      this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: false, label: `Cached comparison ready (${this.latestDiffRecords.size} paths)`, percentage: 100 });
      logger.info(`ITFFTP cached comparison served without a remote scan: ${this.latestDiffRecords.size} paths`);
      return;
    }
    if (requestedCacheKey && this.activeComparisonCacheKey !== requestedCacheKey) {
      this.latestDiffRecords.clear();
      this.diffDirectoryCache.clear();
      this.activeComparisonCacheKey = requestedCacheKey;
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
    this.pendingDiffRefresh = { value, generation, key: requestKey };
    this.hasPendingDiffRefresh = true;
    if (this.diffRefreshRunning) {
      logger.debug('ITFFTP diff refresh queued behind the active scan');
      return;
    }
    this.diffRefreshRunning = true;
    try {
      do {
        const request = this.pendingDiffRefresh;
        this.hasPendingDiffRefresh = false;
        if (request) {
          this.activeDiffRequestKey = request.key;
          await this.loadRemoteDiffOnce(request.value, request.generation);
        }
      } while (this.hasPendingDiffRefresh);
    } finally {
      this.diffRefreshRunning = false;
      this.activeDiffRequestKey = undefined;
    }
  }

  private async loadRemoteDiffOnce(value: unknown, generation: number): Promise<void> {
    const config = this.parseConnections(value)[0] || connectionManager.getPrimaryConfig();
    if (!config) {throw new Error('Select a host before loading remote files.');}
    // Expansion is presentation-only. Every comparison discovers descendants.
    await this.scanComparison(config, '', generation, false, true);
  }

  private async loadRemoteDiffFolder(value: unknown, relativePath: unknown): Promise<void> {
    const config = this.parseConnections(value)[0] || connectionManager.getPrimaryConfig();
    if (!config) {throw new Error('Select a host before loading remote files.');}
    const relativeDirectory = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    await this.scanComparison(config, relativeDirectory, ++this.diffScanGeneration, true, true);
  }

  private async syncChanged(direction: 'up' | 'down', value?: unknown): Promise<void> {
    if (!this.scope) {throw new Error('No workspace is selected.');}
    const config = this.parseConnections(value)[0] || configManager.getActiveConfig(this.scope.fsPath) || configManager.getConfigs(this.scope.fsPath).find(candidate => candidate.default) || configManager.getConfigs(this.scope.fsPath)[0];
    if (!config) {throw new Error('Select a host before syncing.');}
    // The interactive tree is lazy. A bulk sync must discover every changed
    // descendant before it builds the transfer list.
    await this.scanComparison(config, '', ++this.diffScanGeneration, false, true, true);
    if (!this.latestDiffRecords.size) {throw new Error('No comparison data available. Open Transfer first.');}

    const rawCandidates = [...this.latestDiffRecords.values()].filter(record =>
      shouldSyncDiff(record, direction, this.localDirtyPaths.has(record.path))
    );
    // The paired comparison already contains every changed descendant. Queue
    // files directly so a changed directory cannot trigger a full recursive
    // transfer of otherwise identical or ignored content.
    const candidates = rawCandidates.filter(record => record.type === 'file'
      && !this.isIgnoredDiffPath(record.path, config.ignore || []));
    logger.info(`ITFFTP sync ${direction} selected ${candidates.length} changed file${candidates.length === 1 ? '' : 's'} from ${this.latestDiffRecords.size} compared paths`);

    if (candidates.length === 0) {
      statusBar.info(`No changed files to sync ${direction === 'up' ? 'up' : 'down'}.`);
      this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: false, label: `No changed files to sync ${direction === 'up' ? 'up' : 'down'}` });
      return;
    }

    const connection = await connectionManager.connect(config);
    const transferConfig = this.withDashboardSyncMode(config);
    const remoteRoot = (config.remotePath || '/').replace(/\/$/, '');
    const actions: Array<{ path: string; promise: Promise<unknown> }> = [];
    for (const candidate of candidates) {
      const filePath = candidate.path.replace(/\/$/, '');
      if (!filePath) {continue;}
      const segments = filePath.split('/');
      const localUri = vscode.Uri.joinPath(this.localRoot(config), ...segments);
      const remotePath = `${remoteRoot}/${filePath}`;
      if (direction === 'up' && candidate.local) {
        actions.push({
          path: filePath,
          promise: transferManager.uploadFile(connection, localUri.fsPath, remotePath, transferConfig, {
            size: candidate.local.size,
            targetExists: Boolean(candidate.remote),
            targetType: 'file'
          })
        });
      } else if (direction === 'down' && candidate.remote) {
        actions.push({
          path: filePath,
          promise: transferManager.downloadFile(connection, remotePath, localUri.fsPath, transferConfig, {
            size: candidate.remote.size,
            targetExists: Boolean(candidate.local),
            targetType: 'file'
          })
        });
      } else {
        continue;
      }
    }

    this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: true, label: `${direction === 'up' ? 'Uploading' : 'Downloading'} ${candidates.length} changed files`, percentage: 0 });
    if (actions.length === 0) {
      this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: false, label: `No valid entries for ${direction === 'up' ? 'upload' : 'download'}` });
      return;
    }

    try {
      const settled = await Promise.allSettled(actions.map(entry => entry.promise));
      const completedPaths = actions.filter((_, index) => settled[index].status === 'fulfilled').map(entry => entry.path);
      if (completedPaths.length > 0) {
        this.diffDirectoryCache.clear();
        await this.refreshAfterTransfer(completedPaths, direction === 'up' ? 'upload' : 'download', config);
      }
      if (completedPaths.length < actions.length) {
        const failedCount = actions.length - completedPaths.length;
        statusBar.warn(`Sync completed with ${failedCount} failure${failedCount === 1 ? '' : 's'}`);
      }
      const message = direction === 'up' ? 'Uploaded' : 'Downloaded';
      this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: false, label: `${message} ${completedPaths.length} changed file${completedPaths.length === 1 ? '' : 's'}` });
    } finally {
      // No-op. Sync completion status is posted above to keep the UI deterministic.
    }
  }

  private async refreshAfterTransfer(syncedPaths: string[], direction: 'upload' | 'download', selectedConfig?: FTPConfig): Promise<void> {
    if (!this.scope) {return;}
    const config = selectedConfig || configManager.getActiveConfig(this.scope.fsPath) || configManager.getConfigs(this.scope.fsPath).find(candidate => candidate.default) || configManager.getConfigs(this.scope.fsPath)[0];
    if (!config) {return;}

    for (const syncedPath of syncedPaths) {
      const pathToSync = syncedPath.replace(/\/$/, '');
      const prefix = `${pathToSync}`;
      for (const dirtyPath of [...this.localDirtyPaths]) {
        if (dirtyPath === prefix || dirtyPath.startsWith(`${prefix}/`)) {
          this.localDirtyPaths.delete(dirtyPath);
        }
      }
    }
    for (const syncedPath of syncedPaths) {
      const normalized = syncedPath.replace(/\/$/, '');
      const record = this.latestDiffRecords.get(normalized);
      if (record) {
        if (direction === 'upload' && record.local) {record.remote = { ...record.local };}
        if (direction === 'download' && record.remote) {record.local = { ...record.remote };}
        record.status = this.diffStatus(record);
        record.newer = record.status === 'modified' ? newerSide(record, this.localDirtyPaths.has(record.path)) : undefined;
        this.latestDiffRecords.set(normalized, record);
      }
      const parent = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '';
      const remoteRoot = (config.remotePath || '/').replace(/\\/g, '/').replace(/\/+$/g, '') || '/';
      const remoteDirectory = parent ? `${remoteRoot}/${parent}` : remoteRoot;
      const cachePrefix = `${config.protocol}:${config.host}:${config.port || ''}:${remoteDirectory}`;
      for (const key of [...this.diffDirectoryCache.keys()]) {
        if (key === cachePrefix) {this.diffDirectoryCache.delete(key);}
      }
    }
    this.sendComparisonSnapshot();
    this.scheduleComparisonCacheWrite(config);
  }

  private async refreshChangedPathAfterMutation(filePath: string, side: 'local' | 'remote', action: string, config: FTPConfig): Promise<void> {
    const normalized = filePath.replace(/\/$/, '');
    const parent = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '';
    const remoteRoot = (config.remotePath || '/').replace(/\\/g, '/').replace(/\/+$/g, '') || '/';
    const remoteDirectory = parent ? `${remoteRoot}/${parent}` : remoteRoot;
    this.diffDirectoryCache.delete(`${config.protocol}:${config.host}:${config.port || ''}:${remoteDirectory}`);

    if (action === 'delete') {
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
      this.sendComparisonSnapshot();
      this.scheduleComparisonCacheWrite(config);
      return;
    }

    // Rename changes the path identity, so validate only its parent directory.
    await this.scanComparison(config, parent, ++this.diffScanGeneration, true, false);
  }

  private async loadRemoteDiffDirectory(config: FTPConfig, relativeDirectory: string, background = false): Promise<Array<{ path: string; type: 'file' | 'directory'; status: string; size?: number; modifyTime?: number }>> {
    try {
      const root = (config.remotePath || '/').replace(/\\/g, '/').replace(/\/+$|(?<!^)\/+/g, '/').replace(/\/$/, '') || '/';
      const remoteDirectory = relativeDirectory ? `${root}/${relativeDirectory}` : root;
      const cacheKey = `${config.protocol}:${config.host}:${config.port || ''}:${remoteDirectory}`;
      const ignoredPatterns = [...DEFAULT_IGNORE_PATTERNS, ...(config.ignore || [])];
      if (!background) {this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: true, label: `Loading ${relativeDirectory || 'remote root'}…` });}

      let files = this.diffDirectoryCache.get(cacheKey);
      const fromCache = Boolean(files);
      if (!files) {
        const connection = await connectionManager.connect(config);
        const listed = await connection.list(remoteDirectory);
        files = listed.flatMap(item => {
          const name = String(item.name || '').replace(/\\/g, '/');
          const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
          if (!name || this.isIgnoredDiffPath(relativePath, ignoredPatterns)) {return [];}
          const directory = item.type === 'directory';
          return [{ path: `${relativePath}${directory ? '/' : ''}`, type: directory ? 'directory' as const : 'file' as const, status: directory ? '' : 'remote', size: Number(item.size || 0), modifyTime: item.modifyTime instanceof Date ? item.modifyTime.getTime() : Number(item.modifyTime || 0) }];
        });
        this.diffDirectoryCache.set(cacheKey, files);
      }

      const local = await this.getWorkspaceDirectory(relativeDirectory, ignoredPatterns, config);
      this.panel?.webview.postMessage({ type: 'remoteDiff', root, files, localFiles: local.files, localFileStats: local.stats, parent: relativeDirectory, complete: true, fullScan: false, scanComplete: !background });
      if (!background) {this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: false, label: `Loaded ${relativeDirectory || 'remote root'} (${files.length} entries)` });}
      logger.info(`ITFFTP diff directory loaded: ${relativeDirectory || '/'} (${files.length} remote entries, ${fromCache ? 'cached' : 'fresh'})`);
      return files.map(file => ({ ...file, status: '' }));
    } catch (error: any) {
      logger.error('ITFFTP diff directory load failed', error);
      this.panel?.webview.postMessage({ type: 'remoteDiffError', message: error?.message || String(error) });
      this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: false, label: 'Unable to load remote directory' });
      return [];
    }
  }

  private async scanFullDiff(config: FTPConfig): Promise<void> {
    const root = (config.remotePath || '/').replace(/\\/g, '/').replace(/\/+$|(?<!^)\/+/g, '/').replace(/\/$/, '') || '/';
    const scanKey = `${config.protocol}:${config.host}:${config.port || ''}:${root}`;
    if (this.diffFullScans.has(scanKey)) {return;}
    this.diffFullScans.add(scanKey);
    const queue = [''];
    const visited = new Set<string>();
    let entries = 0;
    try {
      while (queue.length > 0 && entries < 10000) {
        const directory = queue.shift()!;
        if (visited.has(directory)) {continue;}
        visited.add(directory);
        this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: true, label: `Comparing ${visited.size} folder${visited.size === 1 ? '' : 's'}…` });
        const listed = await this.loadRemoteDiffDirectory(config, directory, true);
        entries += listed.length;
        for (const entry of listed) {
          if (entry.type === 'directory') {queue.push(entry.path.replace(/\/$/, ''));}
        }
      }
      this.panel?.webview.postMessage({ type: 'remoteDiffScanComplete', folders: visited.size, entries });
      this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: false, label: `Comparison updated (${entries} entries)` });
      logger.info(`ITFFTP full diff comparison complete: ${visited.size} folders, ${entries} entries`);
    } catch (error) {
      logger.error('ITFFTP full diff comparison failed', error);
      this.panel?.webview.postMessage({ type: 'remoteDiffError', message: error instanceof Error ? error.message : String(error) });
      this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: false, label: 'Unable to complete file comparison' });
    } finally {
      this.diffFullScans.delete(scanKey);
    }
  }

  /**
   * FileZilla-style comparison: list both peers of every directory and emit a
   * single record for each relative path.  This deliberately never sends a
   * free-standing local list and remote list for the webview to reconcile.
   */
  private async scanComparison(
    config: FTPConfig,
    startDirectory = '',
    generation = ++this.diffScanGeneration,
    partial = false,
    recursive = true,
    verifyDirtyContent = false
  ): Promise<void> {
    const cacheFile = this.cacheFile(config);
    if (cacheFile) {this.activeComparisonCacheKey = cacheFile.toString();}
    const root = (config.remotePath || '/').replace(/\\/g, '/').replace(/\/+$/g, '') || '/';
    const ignored = [...DEFAULT_IGNORE_PATTERNS, ...(config.ignore || [])];
    // Comparisons are control-channel metadata operations. Reuse the already
    // authenticated primary session instead of paying for another FTP login.
    let connection = await connectionManager.connect(config);
    const queue = [startDirectory];
    const visited = new Set<string>();
    const isAffectedPath = (path: string): boolean => {
      if (!startDirectory) {return recursive || !path.includes('/');}
      if (path === startDirectory) {return true;}
      if (!path.startsWith(`${startDirectory}/`)) {return false;}
      return recursive || !path.slice(startDirectory.length + 1).includes('/');
    };
    const previousAffectedPaths = partial
      ? [...this.latestDiffRecords.keys()].filter(isAffectedPath)
      : [...this.latestDiffRecords.keys()];
    const records = partial ? new Map(this.latestDiffRecords) : new Map<string, DiffRecord>();
    if (partial) {
      for (const path of previousAffectedPaths) {
        if (path !== startDirectory) {records.delete(path);}
      }
    }
    let reportedPercentage = 0;
    if (!partial) {
      this.latestDiffRecords.clear();
      this.panel?.webview.postMessage({ type: 'diffStart', root, startDirectory });
    }
    this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: true, label: 'Comparing local and remote files…', percentage: 0 });
    logger.info(`ITFFTP paired diff scan started: ${root}${startDirectory ? `/${startDirectory}` : ''}`);
    try {
      while (queue.length && visited.size < 10000) {
        if (generation !== this.diffScanGeneration) {
          logger.info('ITFFTP paired diff scan superseded by a newer refresh');
          return;
        }
        const directory = queue.shift()!;
        if (visited.has(directory)) {continue;}
        visited.add(directory);
        const directoryStartedAt = Date.now();
        const displayDirectory = directory || '/';
        this.panel?.webview.postMessage({
          type: 'diffTransferProgress',
          active: true,
          label: `Listing ${displayDirectory} · ${visited.size} scanned · ${queue.length} queued`,
          percentage: reportedPercentage
        });
        logger.info(`ITFFTP diff folder scan started: ${displayDirectory} (${visited.size} scanned, ${queue.length} queued)`);
        const localEntriesPromise = this.getWorkspaceDirectoryEntries(directory, ignored, config);
        let remoteEntries: DiffEntry[];
        try {
          remoteEntries = await this.getRemoteDirectoryEntries(connection, config, directory, ignored, directory !== startDirectory);
        } catch (error) {
          if (!isConnectionClosedError(error) || config.protocol === 'sftp') { throw error; }
          connection = await connectionManager.connect(config);
          logger.info('ITFFTP scan connection was closed by the server; continuing on the reconnected primary session');
          remoteEntries = await this.getRemoteDirectoryEntries(connection, config, directory, ignored, directory !== startDirectory);
        }
        const localEntries = await localEntriesPromise;
        logger.info(`ITFFTP diff folder scan complete: ${displayDirectory}; ${localEntries.length} local, ${remoteEntries.length} remote; ${Date.now() - directoryStartedAt}ms`);
        const localByPath = new Map(localEntries.map(entry => [entry.path, entry]));
        const remoteByPath = new Map(remoteEntries.map(entry => [entry.path, entry]));
        for (const path of new Set([...localByPath.keys(), ...remoteByPath.keys()])) {
          const local = localByPath.get(path);
          const remote = remoteByPath.get(path);
          const type = local?.type === 'directory' || remote?.type === 'directory' ? 'directory' : 'file';
          records.set(path, {
            path, type,
            local: local && { type: local.type, size: local.size, modifyTime: local.modifyTime },
            remote: remote && { type: remote.type, size: remote.size, modifyTime: remote.modifyTime },
            status: 'same'
          });
          if (recursive && (local?.type === 'directory' || remote?.type === 'directory')) {queue.push(path);}
        }
        if (verifyDirtyContent) {
          await this.clearFalseDirtyFlags(connection, config, [...new Set([...localByPath.keys(), ...remoteByPath.keys()])], records);
        }
        // A watcher may have refreshed local metadata while this slower remote
        // directory scan was in flight. Preserve that newer local snapshot so
        // an old scan batch cannot make an edited file disappear again.
        for (const dirtyPath of this.localDirtyPaths) {
          const live = this.latestDiffRecords.get(dirtyPath);
          const scanned = records.get(dirtyPath);
          if (!live || !scanned) {continue;}
          scanned.local = live.local;
        }
        for (const record of records.values()) {
          record.status = this.diffStatus(record);
          record.newer = record.status === 'modified' ? newerSide(record, this.localDirtyPaths.has(record.path)) : undefined;
          if (record.status === 'same') {this.localDirtyPaths.delete(record.path);}
        }
        this.latestDiffRecords.clear();
        for (const [path, record] of records) {this.latestDiffRecords.set(path, record);}
        if (!partial) {
          this.panel?.webview.postMessage({ type: 'diffBatch', records: [...records.values()], scannedDirectories: visited.size, pendingDirectories: queue.length, complete: queue.length === 0 });
        }
        const denominator = Math.max(1, visited.size + queue.length);
        reportedPercentage = Math.max(reportedPercentage, Math.min(95, Math.round((visited.size / denominator) * 95)));
        this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: true, label: `Compared ${displayDirectory} · ${visited.size} scanned · ${queue.length} queued`, percentage: reportedPercentage });
      }
      if (generation !== this.diffScanGeneration) {return;}
      if (partial) {
        const affected = [...records.values()].filter(record => isAffectedPath(record.path));
        const currentPaths = new Set(affected.map(record => record.path));
        const removed = previousAffectedPaths.filter(path => !currentPaths.has(path));
        this.panel?.webview.postMessage({ type: 'diffPatch', root: startDirectory, records: affected, removed });
      } else {
        this.panel?.webview.postMessage({ type: 'diffScanComplete', records: [...records.values()], folders: visited.size });
      }
      this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: false, label: `Comparison updated (${records.size} paths)`, percentage: 100 });
      this.scheduleComparisonCacheWrite(config);
      const statusCounts = [...records.values()].reduce<Record<string, number>>((counts, record) => {
        counts[record.status] = (counts[record.status] || 0) + 1;
        return counts;
      }, {});
      logger.info(`ITFFTP paired diff scan complete: ${visited.size} folders, ${records.size} paths; ${JSON.stringify(statusCounts)}`);
    } catch (error: any) {
      if (generation !== this.diffScanGeneration) {return;}
      logger.error('ITFFTP paired diff scan failed', error);
      this.panel?.webview.postMessage({ type: 'remoteDiffError', message: error?.message || String(error) });
      this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: false, label: 'Unable to refresh file comparison' });
    } finally {
      // The primary session belongs to ConnectionManager and remains available.
    }
  }

  private async getRemoteDirectoryEntries(connection: any, config: FTPConfig, relativeDirectory: string, ignorePatterns: string[], allowMissing: boolean): Promise<DiffEntry[]> {
    const root = (config.remotePath || '/').replace(/\\/g, '/').replace(/\/+$/g, '') || '/';
    const remoteDirectory = relativeDirectory ? `${root}/${relativeDirectory}` : root;
    const cacheKey = `${config.protocol}:${config.host}:${config.port || ''}:${remoteDirectory}`;
    const cached = this.diffDirectoryCache.get(cacheKey);
    if (cached) {return cached;}
    try {
      const listed = await connection.list(remoteDirectory);
      const entries = listed.flatMap((item: any): DiffEntry[] => {
        const name = String(item.name || '').replace(/\\/g, '/');
        const path = relativeDirectory ? `${relativeDirectory}/${name}` : name;
        if (!name || this.isIgnoredDiffPath(path, ignorePatterns)) {return [];}
        return [{ path, type: item.type === 'directory' ? 'directory' : 'file', size: Number(item.size || 0), modifyTime: item.modifyTime instanceof Date ? item.modifyTime.getTime() : Number(item.modifyTime || 0) }];
      });
      this.diffDirectoryCache.set(cacheKey, entries);
      return entries;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (allowMissing && /^550\b|\b550\b.*(?:not found|no such|existence)|no such file|not found/i.test(message)) { return []; }
      throw error;
    }
  }

  private diffStatus(record: DiffRecord): DiffRecord['status'] {
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
    records: Map<string, DiffRecord>
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
        const remote = await connection.readFile(`${root}/${record.path}`);
        if (Buffer.from(local).equals(Buffer.from(remote))) {
          this.localDirtyPaths.delete(record.path);
        }
      } catch {
        // Keep the watcher-derived modified state when verification is unavailable.
      }
    }
  }

  private async readDiffFile(direction: 'local' | 'remote', relativePath: unknown, value: unknown): Promise<void> {
    const filePath = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!filePath || filePath.includes('../')) {return;}
    if (direction === 'local') {
      const record = this.latestDiffRecords.get(filePath);
      const describe = (entry?: { size?: number; modifyTime?: number }): string => entry
        ? `${entry.size ?? 0} bytes, ${entry.modifyTime ? new Date(entry.modifyTime).toISOString() : 'time unknown'}`
        : 'missing';
      logger.info(`ITFFTP diff file selected: ${filePath}; local=${describe(record?.local)}; remote=${describe(record?.remote)}; status=${record?.status || 'unknown'}`);
    }
    const config = this.parseConnections(value)[0] || connectionManager.getPrimaryConfig();
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
        content = (await connection.readFile(`${root}/${filePath}`)).toString('utf8');
      }
      this.panel?.webview.postMessage({ type: 'diffFile', direction, path: filePath, content });
    } catch (error: any) {
      const details = String(error?.message || error || '');
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
    const filePath = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!filePath || filePath.includes('../')) {return;}
    // Tree paths are normalized without a trailing slash. Use the paired scan
    // record as the source of truth so folder actions stay recursive.
    const isDirectory = this.latestDiffRecords.get(filePath)?.type === 'directory' || filePath.endsWith('/');
    const relativeSegments = filePath.replace(/\/$/, '').split('/');
    if (!this.scope) {throw new Error('No workspace is selected.');}
    const config = this.parseConnections(value)[0] || connectionManager.getPrimaryConfig() || configManager.getConfigs(this.scope.fsPath).find(candidate => candidate.default) || configManager.getConfigs(this.scope.fsPath)[0];
    if (!config) {throw new Error('Select a host before using this action.');}
    if (isDirectory && (action === 'upload' || action === 'download')) {
      // Folder transfers use only changed files, so complete this subtree just
      // before selecting candidates rather than during initial panel load.
      await this.scanComparison(config, filePath.replace(/\/$/, ''), ++this.diffScanGeneration, true, true, true);
    }
    const connection = await connectionManager.connect(config);
    const transferConfig = this.withDashboardSyncMode(config);
    const remoteRoot = (config.remotePath || '/').replace(/\/$/, '');
    const remotePath = `${remoteRoot}/${filePath.replace(/\/$/, '')}`;
    const record = this.latestDiffRecords.get(filePath);
    const localRoot = this.localRoot(config);
    const localUri = vscode.Uri.joinPath(localRoot, ...relativeSegments);
    let transferredPaths: string[] | undefined;
    if (action === 'upload' && direction === 'local') {
      this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: true, label: `Uploading ${filePath}`, percentage: 0 });
      if (isDirectory) {
        const changedFiles = this.getChangedSubtreeFiles(filePath, 'upload');
        if (!changedFiles.length) {
          this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: false, label: `No changed files under ${filePath}`, percentage: 100 });
          return;
        }
        this.removeDashboardJob(preparationJobId);
        const settled = await Promise.allSettled(changedFiles.map(candidate => {
          const candidateLocal = vscode.Uri.joinPath(localRoot, ...candidate.path.split('/'));
          return transferManager.uploadFile(connection, candidateLocal.fsPath, `${remoteRoot}/${candidate.path}`, transferConfig, {
            size: candidate.local?.size,
            targetExists: Boolean(candidate.remote),
            targetType: 'file'
          });
        }));
        const completed = changedFiles.filter((_, index) => settled[index].status === 'fulfilled').map(candidate => candidate.path);
        const failed = settled.length - completed.length;
        if (failed) {
          if (completed.length) {await this.refreshAfterTransfer(completed, 'upload', config);}
          throw new Error(`Uploaded ${completed.length} changed files; ${failed} failed.`);
        }
        transferredPaths = completed;
      }
      else {
        this.removeDashboardJob(preparationJobId);
        await transferManager.uploadFile(connection, localUri.fsPath, remotePath, transferConfig, {
          size: record?.local?.size,
          targetExists: Boolean(record?.remote),
          targetType: 'file'
        });
      }
    } else if (action === 'download' && direction === 'remote') {
      this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: true, label: `Downloading ${filePath}`, percentage: 0 });
      if (isDirectory) {
        const changedFiles = this.getChangedSubtreeFiles(filePath, 'download');
        if (!changedFiles.length) {
          this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: false, label: `No changed files under ${filePath}`, percentage: 100 });
          return;
        }
        this.removeDashboardJob(preparationJobId);
        const settled = await Promise.allSettled(changedFiles.map(candidate => {
          const candidateLocal = vscode.Uri.joinPath(localRoot, ...candidate.path.split('/'));
          return transferManager.downloadFile(connection, `${remoteRoot}/${candidate.path}`, candidateLocal.fsPath, transferConfig, {
            size: candidate.remote?.size,
            targetExists: Boolean(candidate.local),
            targetType: 'file'
          });
        }));
        const completed = changedFiles.filter((_, index) => settled[index].status === 'fulfilled').map(candidate => candidate.path);
        const failed = settled.length - completed.length;
        if (failed) {
          if (completed.length) {await this.refreshAfterTransfer(completed, 'download', config);}
          throw new Error(`Downloaded ${completed.length} changed files; ${failed} failed.`);
        }
        transferredPaths = completed;
      } else {
        this.removeDashboardJob(preparationJobId);
        await transferManager.downloadFile(connection, remotePath, localUri.fsPath, transferConfig, {
          size: record?.remote?.size,
          targetExists: Boolean(record?.local),
          targetType: 'file'
        });
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
      const nextName = await vscode.window.showInputBox({ prompt: 'New file name', value: filePath.split('/').pop() });
      if (!nextName || nextName.includes('/') || nextName.includes('\\')) {return;}
      const nextRelative = `${filePath.slice(0, filePath.lastIndexOf('/') + 1)}${nextName}`;
      if (direction === 'local') {await vscode.workspace.fs.rename(localUri, vscode.Uri.joinPath(localRoot, ...nextRelative.split('/')), { overwrite: false });}
      else {await connection.rename(remotePath, `${remoteRoot}/${nextRelative}`);}
    }
    // Update the visible row as soon as the transfer itself succeeds.  A full
    // recursive refresh can take a while on large remote sites, and must not
    // leave the dashboard looking stale until that background work completes.
    if (action === 'upload' || action === 'download') {
      const prefix = filePath.replace(/\/$/, '');
      for (const dirtyPath of [...this.localDirtyPaths]) {
        if (dirtyPath === prefix || dirtyPath.startsWith(`${prefix}/`)) {this.localDirtyPaths.delete(dirtyPath);}
      }
    }
    const normalizedPath = filePath.replace(/\/$/, '');
    const parentPath = normalizedPath.includes('/') ? normalizedPath.slice(0, normalizedPath.lastIndexOf('/')) : '';
    const root = (config.remotePath || '/').replace(/\\/g, '/').replace(/\/+$/g, '') || '/';
    const remoteDirectory = parentPath ? `${root}/${parentPath}` : root;
    this.diffDirectoryCache.delete(`${config.protocol}:${config.host}:${config.port || ''}:${remoteDirectory}`);
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

  private getChangedSubtreeFiles(folderPath: string, direction: 'upload' | 'download'): DiffRecord[] {
    const prefix = `${folderPath.replace(/\/$/, '')}/`;
    return [...this.latestDiffRecords.values()]
      .filter(record => {
        if (record.type !== 'file' || !record.path.startsWith(prefix)) {return false;}
        if (direction === 'upload') {
          return Boolean(record.local) && (record.status === 'modified' || record.status === 'missing-remote' || record.status === 'type-changed');
        }
        return Boolean(record.remote) && (record.status === 'modified' || record.status === 'missing-local' || record.status === 'type-changed');
      })
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

  private async getWorkspaceFiles(ignorePatterns: readonly string[] = DEFAULT_IGNORE_PATTERNS): Promise<string[]> {
    if (!this.scope) {return [];}

    const files: string[] = [];
    const queue: Array<{ uri: vscode.Uri; prefix: string; depth: number }> = [{ uri: this.scope, prefix: '', depth: 0 }];
    while (queue.length > 0 && files.length < 10000) {
      const current = queue.shift()!;
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(current.uri);
      } catch {
        continue;
      }

      for (const [name, type] of entries) {
        const relativePath = current.prefix ? `${current.prefix}/${name}` : name;
        if (this.isIgnoredDiffPath(relativePath, ignorePatterns)) {continue;}
        if (type === vscode.FileType.Directory) {
          files.push(`${relativePath}/`);
          if (current.depth < 12 && files.length < 10000) {
            queue.push({ uri: vscode.Uri.joinPath(current.uri, name), prefix: relativePath, depth: current.depth + 1 });
          }
        } else if (type === vscode.FileType.File) {
          files.push(relativePath);
        }

        if (files.length >= 10000) {break;}
      }
    }

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

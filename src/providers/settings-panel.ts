/**
 * ITFFTP - Extension Settings Webview
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { logger } from '../utils/logger';
import { statusBar } from '../utils/status-bar';
import { configManager } from '../core/config';
import { transferManager } from '../core/transfer-manager';
import { connectionManager } from '../core/connection-manager';
import { AnalyticsStore } from '../core/analytics-store';
import { classifyDiff, collapseRecursiveTransfers } from '../core/diff-comparison';
import { BaseConnection } from '../core/connection';
import { isConnectionClosedError } from '../core/connection-errors';
import { FTPConfig } from '../types';
import { matchesPattern } from '../utils/helpers';

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
  local?: Omit<DiffEntry, 'path' | 'type'>;
  remote?: Omit<DiffEntry, 'path' | 'type'>;
  status: 'same' | 'missing-local' | 'missing-remote' | 'modified' | 'type-changed';
};

const DEFAULT_IGNORE_PATTERNS = [
  '.git',
  '.vscode',
  '.idea',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.env',
  '.env.*',
  '.DS_Store',
  'Thumbs.db'
];

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
  private localRefreshTimer?: NodeJS.Timeout;
  private cacheWriteTimer?: NodeJS.Timeout;
  private backgroundRefreshTimer?: NodeJS.Timeout;
  private lastBackgroundRefreshAt = 0;
  private activeComparisonCacheKey?: string;
  private readonly localDirtyPaths = new Set<string>();
  // Retained while legacy folder messages are accepted; all dashboard scans use
  // scanComparison above and therefore never enter this path.
  private readonly diffFullScans = new Set<string>();
  private analyticsProjectFilter = 'all';
  private readonly analyticsChangedListener = () => void this.sendAnalytics();
  private readonly transferProgressListener = () => {
    const active = transferManager.getQueue().filter(item => item.status === 'transferring');
    if (!active.length || !this.panel) return;
    const percentage = Math.round(active.reduce((total, item) => total + Math.min(100, Math.max(0, Number(item.progress) || 0)), 0) / active.length);
    const label = active.length === 1
      ? `${active[0].direction === 'upload' ? 'Uploading' : 'Downloading'} ${active[0].remotePath.split('/').pop() || active[0].remotePath}`
      : `Transferring ${active.length} files`;
    void this.panel.webview.postMessage({ type: 'diffTransferProgress', active: true, label, percentage });
  };

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
    if (this.localRefreshTimer) clearTimeout(this.localRefreshTimer);
    if (this.cacheWriteTimer) clearTimeout(this.cacheWriteTimer);
    if (this.backgroundRefreshTimer) clearTimeout(this.backgroundRefreshTimer);
    this.panel?.dispose();
    this.panel = undefined;
    this.analyticsStore?.removeListener('changed', this.analyticsChangedListener);
    transferManager.removeListener('queueUpdate', this.transferProgressListener);
  }

  public initialize(scope: vscode.Uri): void {
    const changedScope = this.scope?.toString() !== scope.toString();
    if (changedScope) this.diffScanGeneration++;
    this.scope = scope;
    if (changedScope || !this.localWatcher) this.ensureLocalWatcher(scope);
    const config = configManager.getConfigs(scope.fsPath).find(candidate => candidate.default) || configManager.getConfigs(scope.fsPath)[0];
    if (config) void this.loadCachedComparison(config);
  }

  public async refreshComparisonInBackground(config?: FTPConfig): Promise<void> {
    if (!this.scope) return;
    const active = config || configManager.getConfigs(this.scope.fsPath).find(candidate => candidate.default) || configManager.getConfigs(this.scope.fsPath)[0];
    if (!active) return;
    await this.loadCachedComparison(active);
    logger.info(`ITFFTP background comparison refresh started for ${active.name || active.host}`);
    await this.loadRemoteDiff(active);
    this.lastBackgroundRefreshAt = Date.now();
  }

  public scheduleBackgroundRefresh(config?: FTPConfig): void {
    if (Date.now() - this.lastBackgroundRefreshAt < 5000) return;
    if (this.backgroundRefreshTimer) clearTimeout(this.backgroundRefreshTimer);
    this.backgroundRefreshTimer = setTimeout(() => {
      this.backgroundRefreshTimer = undefined;
      void this.refreshComparisonInBackground(config).catch(error => logger.warn('Background comparison refresh failed', error));
    }, 500);
  }

  private ensureLocalWatcher(scope: vscode.Uri): void {
    this.localWatcher?.dispose();
    this.localWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(scope, '**/*'));
    const changed = (uri: vscode.Uri): void => {
      if (!this.scope || !uri.fsPath.startsWith(this.scope.fsPath)) return;
      const relativePath = uri.fsPath.slice(this.scope.fsPath.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
      const configs = configManager.getConfigs(this.scope.fsPath);
      const activeConfig = configs.find(candidate => candidate.default) || configs[0];
      if (!relativePath || this.isIgnoredDiffPath(relativePath, [...DEFAULT_IGNORE_PATTERNS, ...(activeConfig?.ignore || [])])) return;
      this.localDirtyPaths.add(relativePath);
      if (this.localRefreshTimer) clearTimeout(this.localRefreshTimer);
      this.localRefreshTimer = setTimeout(() => {
        this.localRefreshTimer = undefined;
        const currentConfigs = configManager.getConfigs(this.scope!.fsPath);
        const config = currentConfigs.find(candidate => candidate.default) || currentConfigs[0];
        if (!config) return;
        logger.info(`ITFFTP local change detected; updating cached comparison`);
        void this.refreshLocalCacheEntry(uri, config);
      }, 450);
    };
    this.localWatcher.onDidCreate(changed);
    this.localWatcher.onDidChange(changed);
    this.localWatcher.onDidDelete(changed);
  }

  private cacheFile(config: FTPConfig): vscode.Uri | undefined {
    if (!this.globalStorageUri || !this.scope) return undefined;
    const identity = [this.scope.toString(), config.protocol, config.host, config.port || '', config.remotePath || '/', ...(config.ignore || [])].join('\n');
    const key = crypto.createHash('sha256').update(identity).digest('hex');
    return vscode.Uri.joinPath(this.globalStorageUri, 'diff-cache', `${key}.json`);
  }

  private async loadCachedComparison(config: FTPConfig): Promise<void> {
    const file = this.cacheFile(config);
    if (!file) return;
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
      if (parsed?.version !== 1 || !Array.isArray(parsed.records)) return;
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
    if (this.cacheWriteTimer) clearTimeout(this.cacheWriteTimer);
    this.cacheWriteTimer = setTimeout(() => {
      this.cacheWriteTimer = undefined;
      void this.persistComparisonCache(config);
    }, 300);
  }

  private async persistComparisonCache(config: FTPConfig): Promise<void> {
    const file = this.cacheFile(config);
    if (!file) return;
    const temporary = vscode.Uri.joinPath(
      vscode.Uri.joinPath(this.globalStorageUri!, 'diff-cache'),
      `${file.path.split('/').pop()}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    );
    try {
      const payload = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), records: [...this.latestDiffRecords.values()] });
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.globalStorageUri!, 'diff-cache'));
      await vscode.workspace.fs.writeFile(temporary, new TextEncoder().encode(payload));
      await vscode.workspace.fs.rename(temporary, file, { overwrite: true });
    } catch (error) {
      logger.warn('Unable to persist ITFFTP comparison cache', error);
      try { await vscode.workspace.fs.delete(temporary); } catch { /* Another window may already have replaced the cache. */ }
    }
  }

  private sendComparisonSnapshot(): void {
    if (!this.panel || !this.latestDiffRecords.size) return;
    void this.panel.webview.postMessage({ type: 'diffScanComplete', records: [...this.latestDiffRecords.values()], folders: [...this.latestDiffRecords.values()].filter(record => record.type === 'directory').length, cached: true });
  }

  private async refreshLocalCacheEntry(uri: vscode.Uri, config: FTPConfig): Promise<void> {
    if (!this.scope) return;
    const relativePath = uri.fsPath.slice(this.scope.fsPath.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
    if (!relativePath) return;
    const current = this.latestDiffRecords.get(relativePath);
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      const type: DiffRecord['type'] = stat.type === vscode.FileType.Directory ? 'directory' : 'file';
      const record: DiffRecord = {
        path: relativePath,
        type,
        local: { size: type === 'file' ? stat.size : undefined, modifyTime: stat.mtime },
        remote: current?.remote,
        status: 'same'
      };
      record.status = this.diffStatus(record);
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
          await this.loadRemoteDiff(undefined);
          break;
        case 'loadDiffRemote':
          if (message.force) this.diffDirectoryCache.clear();
          await this.loadRemoteDiff(message.connection);
          break;
        case 'loadDiffFolder':
          await this.loadRemoteDiffFolder(message.connection, message.path);
          break;
        case 'readDiffFile':
          await this.readDiffFile(message.direction, message.path, message.connection);
          break;
        case 'diffAction':
          await this.handleDiffAction(message.action, message.direction, message.path, message.connection);
          break;
        case 'diffTransfer':
          await this.handleDiffAction(message.direction, message.direction === 'upload' ? 'local' : 'remote', message.path, message.connection);
          break;
        case 'syncAllChanged':
          await this.syncChanged(message.direction === 'down' ? 'down' : 'up');
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
    if (!this.panel) return;

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

    if (!selected?.[0]) return;

    const content = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(selected[0]));
    const connections = this.parseConnections(JSON.parse(content));
    this.panel?.webview.postMessage({ type: 'connectionsImported', connections });
    statusBar.success(`Imported ${connections.length} remote location${connections.length === 1 ? '' : 's'}`);
  }

  private async testConnection(value: unknown): Promise<void> {
    try {
      const config = this.parseConnections(value)[0];
      if (!config) throw new Error('Select a host before testing the connection.');
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

  private async loadRemoteDiff(value: unknown): Promise<void> {
    const requestedConfig = this.parseConnections(value)[0] || connectionManager.getPrimaryConfig();
    if (!requestedConfig) throw new Error('Select a host before loading remote files.');
    const requestKey = [
      this.scope?.toString() || '',
      requestedConfig.protocol,
      requestedConfig.host,
      requestedConfig.port || '',
      requestedConfig.username || '',
      requestedConfig.remotePath || '/'
    ].join('\n');
    if (this.diffRefreshRunning && this.activeDiffRequestKey === requestKey) {
      logger.debug('ITFFTP diff refresh already running for this remote; duplicate request joined the active scan');
      return;
    }
    const generation = ++this.diffScanGeneration;
    this.pendingDiffRefresh = { value, generation, key: requestKey };
    this.hasPendingDiffRefresh = true;
    if (this.diffRefreshRunning) return;
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
    if (!config) throw new Error('Select a host before loading remote files.');
    await this.scanComparison(config, '', generation);
  }

  private async loadRemoteDiffFolder(value: unknown, relativePath: unknown): Promise<void> {
    const config = this.parseConnections(value)[0] || connectionManager.getPrimaryConfig();
    if (!config) throw new Error('Select a host before loading remote files.');
    const relativeDirectory = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    await this.scanComparison(config, relativeDirectory, ++this.diffScanGeneration, true);
  }

  private async syncChanged(direction: 'up' | 'down'): Promise<void> {
    if (!this.scope) throw new Error('No workspace is selected.');
    const config = configManager.getActiveConfig(this.scope.fsPath) || configManager.getConfigs(this.scope.fsPath).find(candidate => candidate.default) || configManager.getConfigs(this.scope.fsPath)[0];
    if (!config) throw new Error('Select a host before syncing.');
    if (!this.latestDiffRecords.size) throw new Error('No comparison data available. Open the diff viewer first.');

    const changedStatuses = new Set(['modified', 'missing-local', 'missing-remote', 'type-changed']);
    const rawCandidates = [...this.latestDiffRecords.values()].filter(record => {
      if (!changedStatuses.has(record.status)) return false;
      if (direction === 'up') {
        return record.status === 'modified' || record.status === 'missing-remote' || record.status === 'type-changed';
      }
      return record.status === 'modified' || record.status === 'missing-local' || record.status === 'type-changed';
    });
    const candidates = collapseRecursiveTransfers(rawCandidates);

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
      if (!filePath) continue;
      const segments = filePath.split('/');
      const localUri = vscode.Uri.joinPath(this.scope, ...segments);
      const remotePath = `${remoteRoot}/${filePath}`;
      if (direction === 'up' && candidate.local) {
        if (candidate.type === 'directory') {
          actions.push({ path: filePath, promise: transferManager.uploadDirectory(connection, localUri.fsPath, remotePath, transferConfig) });
        } else {
          actions.push({
            path: filePath,
            promise: transferManager.uploadFile(connection, localUri.fsPath, remotePath, transferConfig, {
              size: candidate.local.size,
              targetExists: Boolean(candidate.remote),
              targetType: 'file'
            })
          });
        }
      } else if (direction === 'down' && candidate.remote) {
        if (candidate.type === 'directory') {
          actions.push({ path: filePath, promise: transferManager.downloadDirectory(connection, remotePath, localUri.fsPath, transferConfig) });
        } else {
          actions.push({
            path: filePath,
            promise: transferManager.downloadFile(connection, remotePath, localUri.fsPath, transferConfig, {
              size: candidate.remote.size,
              targetExists: Boolean(candidate.local),
              targetType: 'file'
            })
          });
        }
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
        await this.refreshAfterTransfer(completedPaths);
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

  private async refreshAfterTransfer(syncedPaths: string[]): Promise<void> {
    if (!this.scope) return;
    const config = configManager.getActiveConfig(this.scope.fsPath) || configManager.getConfigs(this.scope.fsPath).find(candidate => candidate.default) || configManager.getConfigs(this.scope.fsPath)[0];
    if (!config) return;

    for (const syncedPath of syncedPaths) {
      const pathToSync = syncedPath.replace(/\/$/, '');
      const prefix = `${pathToSync}`;
      for (const dirtyPath of [...this.localDirtyPaths]) {
        if (dirtyPath === prefix || dirtyPath.startsWith(`${prefix}/`)) {
          this.localDirtyPaths.delete(dirtyPath);
        }
      }
    }
    const refreshRoots = new Map<string, boolean>();
    for (const syncedPath of syncedPaths) {
      const normalized = syncedPath.replace(/\/$/, '');
      const record = this.latestDiffRecords.get(normalized);
      const parent = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '';
      refreshRoots.set(parent, refreshRoots.get(parent) || false);
      if (record?.type === 'directory') refreshRoots.set(normalized, true);
    }
    for (const [refreshRoot, recursive] of [...refreshRoots.entries()].sort((left, right) => left[0].split('/').length - right[0].split('/').length)) {
      const remoteRoot = (config.remotePath || '/').replace(/\\/g, '/').replace(/\/+$/g, '') || '/';
      const remoteDirectory = refreshRoot ? `${remoteRoot}/${refreshRoot}` : remoteRoot;
      const cachePrefix = `${config.protocol}:${config.host}:${config.port || ''}:${remoteDirectory}`;
      for (const key of [...this.diffDirectoryCache.keys()]) {
        if (key === cachePrefix || (recursive && key.startsWith(`${cachePrefix}/`))) this.diffDirectoryCache.delete(key);
      }
      await this.scanComparison(config, refreshRoot, ++this.diffScanGeneration, true, recursive);
    }
    this.scheduleComparisonCacheWrite(config);
  }

  private async loadRemoteDiffDirectory(config: FTPConfig, relativeDirectory: string, background = false): Promise<Array<{ path: string; type: 'file' | 'directory'; status: string; size?: number; modifyTime?: number }>> {
    try {
      const root = (config.remotePath || '/').replace(/\\/g, '/').replace(/\/+$|(?<!^)\/+/g, '/').replace(/\/$/, '') || '/';
      const remoteDirectory = relativeDirectory ? `${root}/${relativeDirectory}` : root;
      const cacheKey = `${config.protocol}:${config.host}:${config.port || ''}:${remoteDirectory}`;
      const ignoredPatterns = [...DEFAULT_IGNORE_PATTERNS, ...(config.ignore || [])];
      if (!background) this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: true, label: `Loading ${relativeDirectory || 'remote root'}…` });

      let files = this.diffDirectoryCache.get(cacheKey);
      const fromCache = Boolean(files);
      if (!files) {
        const connection = await connectionManager.connect(config);
        const listed = await connection.list(remoteDirectory);
        files = listed.flatMap(item => {
          const name = String(item.name || '').replace(/\\/g, '/');
          const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
          if (!name || this.isIgnoredDiffPath(relativePath, ignoredPatterns)) return [];
          const directory = item.type === 'directory';
          return [{ path: `${relativePath}${directory ? '/' : ''}`, type: directory ? 'directory' as const : 'file' as const, status: directory ? '' : 'remote', size: Number(item.size || 0), modifyTime: item.modifyTime instanceof Date ? item.modifyTime.getTime() : Number(item.modifyTime || 0) }];
        });
        this.diffDirectoryCache.set(cacheKey, files);
      }

      const local = await this.getWorkspaceDirectory(relativeDirectory, ignoredPatterns);
      this.panel?.webview.postMessage({ type: 'remoteDiff', root, files, localFiles: local.files, localFileStats: local.stats, parent: relativeDirectory, complete: true, fullScan: false, scanComplete: !background });
      if (!background) this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: false, label: `Loaded ${relativeDirectory || 'remote root'} (${files.length} entries)` });
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
    if (this.diffFullScans.has(scanKey)) return;
    this.diffFullScans.add(scanKey);
    const queue = [''];
    const visited = new Set<string>();
    let entries = 0;
    try {
      while (queue.length > 0 && entries < 10000) {
        const directory = queue.shift()!;
        if (visited.has(directory)) continue;
        visited.add(directory);
        this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: true, label: `Comparing ${visited.size} folder${visited.size === 1 ? '' : 's'}…` });
        const listed = await this.loadRemoteDiffDirectory(config, directory, true);
        entries += listed.length;
        for (const entry of listed) {
          if (entry.type === 'directory') queue.push(entry.path.replace(/\/$/, ''));
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
    recursive = true
  ): Promise<void> {
    const cacheFile = this.cacheFile(config);
    if (cacheFile) this.activeComparisonCacheKey = cacheFile.toString();
    const root = (config.remotePath || '/').replace(/\\/g, '/').replace(/\/+$/g, '') || '/';
    const ignored = [...DEFAULT_IGNORE_PATTERNS, ...(config.ignore || [])];
    await connectionManager.connect(config);
    let connection = await connectionManager.getPooledConnection(config);
    const queue = [startDirectory];
    const visited = new Set<string>();
    const isAffectedPath = (path: string): boolean => {
      if (!startDirectory) return recursive || !path.includes('/');
      if (path === startDirectory) return true;
      if (!path.startsWith(`${startDirectory}/`)) return false;
      return recursive || !path.slice(startDirectory.length + 1).includes('/');
    };
    const previousAffectedPaths = partial
      ? [...this.latestDiffRecords.keys()].filter(isAffectedPath)
      : [...this.latestDiffRecords.keys()];
    const records = partial ? new Map(this.latestDiffRecords) : new Map<string, DiffRecord>();
    if (partial) {
      for (const path of previousAffectedPaths) {
        if (path !== startDirectory) records.delete(path);
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
        if (visited.has(directory)) continue;
        visited.add(directory);
        const localEntriesPromise = this.getWorkspaceDirectoryEntries(directory, ignored);
        let remoteEntries: DiffEntry[];
        try {
          remoteEntries = await this.getRemoteDirectoryEntries(connection, config, directory, ignored, directory !== startDirectory);
        } catch (error) {
          if (!isConnectionClosedError(error) || config.protocol === 'sftp') { throw error; }
          connectionManager.releasePooledConnection(config, connection);
          connection = await connectionManager.getPooledConnection(config);
          logger.info('ITFFTP scan connection was closed by the server; continuing on a fresh connection');
          remoteEntries = await this.getRemoteDirectoryEntries(connection, config, directory, ignored, directory !== startDirectory);
        }
        const localEntries = await localEntriesPromise;
        const localByPath = new Map(localEntries.map(entry => [entry.path, entry]));
        const remoteByPath = new Map(remoteEntries.map(entry => [entry.path, entry]));
        for (const path of new Set([...localByPath.keys(), ...remoteByPath.keys()])) {
          const local = localByPath.get(path);
          const remote = remoteByPath.get(path);
          const type = local?.type || remote?.type || 'file';
          records.set(path, {
            path, type,
            local: local && { size: local.size, modifyTime: local.modifyTime },
            remote: remote && { size: remote.size, modifyTime: remote.modifyTime },
            status: 'same'
          });
          if (type === 'directory' && recursive) queue.push(path);
        }
        await this.clearFalseDirtyFlags(connection, config, [...new Set([...localByPath.keys(), ...remoteByPath.keys()])], records);
        for (const record of records.values()) {
          record.status = this.diffStatus(record);
          if (record.status === 'same') this.localDirtyPaths.delete(record.path);
        }
        this.latestDiffRecords.clear();
        for (const [path, record] of records) this.latestDiffRecords.set(path, record);
        if (!partial) {
          this.panel?.webview.postMessage({ type: 'diffBatch', records: [...records.values()], scannedDirectories: visited.size, pendingDirectories: queue.length, complete: queue.length === 0 });
        }
        const denominator = Math.max(1, visited.size + queue.length);
        reportedPercentage = Math.max(reportedPercentage, Math.min(95, Math.round((visited.size / denominator) * 95)));
        this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: true, label: `Compared ${visited.size} folder${visited.size === 1 ? '' : 's'}…`, percentage: reportedPercentage });
      }
      if (generation !== this.diffScanGeneration) return;
      if (partial) {
        const affected = [...records.values()].filter(record => isAffectedPath(record.path));
        const currentPaths = new Set(affected.map(record => record.path));
        const removed = previousAffectedPaths.filter(path => !currentPaths.has(path));
        this.panel?.webview.postMessage({ type: 'diffPatch', records: affected, removed });
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
      if (generation !== this.diffScanGeneration) return;
      logger.error('ITFFTP paired diff scan failed', error);
      this.panel?.webview.postMessage({ type: 'remoteDiffError', message: error?.message || String(error) });
      this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: false, label: 'Unable to refresh file comparison' });
    } finally {
      connectionManager.releasePooledConnection(config, connection);
    }
  }

  private async getRemoteDirectoryEntries(connection: any, config: FTPConfig, relativeDirectory: string, ignorePatterns: string[], allowMissing: boolean): Promise<DiffEntry[]> {
    const root = (config.remotePath || '/').replace(/\\/g, '/').replace(/\/+$/g, '') || '/';
    const remoteDirectory = relativeDirectory ? `${root}/${relativeDirectory}` : root;
    const cacheKey = `${config.protocol}:${config.host}:${config.port || ''}:${remoteDirectory}`;
    const cached = this.diffDirectoryCache.get(cacheKey);
    if (cached) return cached;
    try {
      const listed = await connection.list(remoteDirectory);
      const entries = listed.flatMap((item: any): DiffEntry[] => {
        const name = String(item.name || '').replace(/\\/g, '/');
        const path = relativeDirectory ? `${relativeDirectory}/${name}` : name;
        if (!name || this.isIgnoredDiffPath(path, ignorePatterns)) return [];
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
    if (!this.scope) return;
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
        const local = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.scope, ...record.path.split('/')));
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
    if (!filePath || filePath.includes('../')) return;
    if (direction === 'local') {
      const record = this.latestDiffRecords.get(filePath);
      const describe = (entry?: { size?: number; modifyTime?: number }): string => entry
        ? `${entry.size ?? 0} bytes, ${entry.modifyTime ? new Date(entry.modifyTime).toISOString() : 'time unknown'}`
        : 'missing';
      logger.info(`ITFFTP diff file selected: ${filePath}; local=${describe(record?.local)}; remote=${describe(record?.remote)}; status=${record?.status || 'unknown'}`);
    }
    try {
      let content = '';
      if (direction === 'local') {
        if (!this.scope) throw new Error('No workspace is selected.');
        const data = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.scope, ...filePath.split('/')));
        content = new TextDecoder('utf-8').decode(data);
      } else {
        const config = this.parseConnections(value)[0] || connectionManager.getPrimaryConfig();
        if (!config) throw new Error('Select a host before reading a remote file.');
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

  private async handleDiffAction(action: string, direction: 'local' | 'remote', relativePath: unknown, value: unknown): Promise<void> {
    const filePath = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!filePath || filePath.includes('../')) return;
    // Tree paths are normalized without a trailing slash. Use the paired scan
    // record as the source of truth so folder actions stay recursive.
    const isDirectory = this.latestDiffRecords.get(filePath)?.type === 'directory' || filePath.endsWith('/');
    const relativeSegments = filePath.replace(/\/$/, '').split('/');
    if (!this.scope) throw new Error('No workspace is selected.');
    const config = this.parseConnections(value)[0] || connectionManager.getPrimaryConfig() || configManager.getConfigs(this.scope.fsPath).find(candidate => candidate.default) || configManager.getConfigs(this.scope.fsPath)[0];
    if (!config) throw new Error('Select a host before using this action.');
    const connection = await connectionManager.connect(config);
    const transferConfig = this.withDashboardSyncMode(config);
    const remoteRoot = (config.remotePath || '/').replace(/\/$/, '');
    const remotePath = `${remoteRoot}/${filePath.replace(/\/$/, '')}`;
    const record = this.latestDiffRecords.get(filePath);
    const localUri = vscode.Uri.joinPath(this.scope, ...relativeSegments);
    if (action === 'upload' && direction === 'local') {
      this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: true, label: `Uploading ${filePath}`, percentage: 0 });
      if (isDirectory) await transferManager.uploadDirectory(connection, localUri.fsPath, remotePath, transferConfig);
      else await transferManager.uploadFile(connection, localUri.fsPath, remotePath, transferConfig, {
        size: record?.local?.size,
        targetExists: Boolean(record?.remote),
        targetType: 'file'
      });
    } else if (action === 'download' && direction === 'remote') {
      this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: true, label: `Downloading ${filePath}`, percentage: 0 });
      if (isDirectory) {
        const result = await transferManager.downloadDirectory(connection, remotePath, localUri.fsPath, transferConfig);
        if (result.failed.length) throw new Error(`Downloaded ${result.downloaded.length} files; ${result.failed.length} failed. Check the ITFFTP output for details.`);
      } else await transferManager.downloadFile(connection, remotePath, localUri.fsPath, transferConfig, {
        size: record?.remote?.size,
        targetExists: Boolean(record?.local),
        targetType: 'file'
      });
    }
    else if (action === 'delete') {
      const choice = await vscode.window.showWarningMessage(`Delete ${filePath}?`, { modal: true }, 'Delete');
      if (choice !== 'Delete') return;
      this.panel?.webview.postMessage({ type: 'diffTransferProgress', active: true, label: `Deleting ${filePath}`, percentage: 0 });
      if (direction === 'local') await vscode.workspace.fs.delete(localUri, { recursive: isDirectory, useTrash: true });
      else if (isDirectory) await connection.rmdir(remotePath, true);
      else await connection.delete(remotePath);
    } else if (action === 'rename') {
      const nextName = await vscode.window.showInputBox({ prompt: 'New file name', value: filePath.split('/').pop() });
      if (!nextName || nextName.includes('/') || nextName.includes('\\')) return;
      const nextRelative = `${filePath.slice(0, filePath.lastIndexOf('/') + 1)}${nextName}`;
      if (direction === 'local') await vscode.workspace.fs.rename(localUri, vscode.Uri.joinPath(this.scope, ...nextRelative.split('/')), { overwrite: false });
      else await connection.rename(remotePath, `${remoteRoot}/${nextRelative}`);
    }
    // Update the visible row as soon as the transfer itself succeeds.  A full
    // recursive refresh can take a while on large remote sites, and must not
    // leave the dashboard looking stale until that background work completes.
    if (action === 'upload' || action === 'download') {
      const prefix = filePath.replace(/\/$/, '');
      for (const dirtyPath of [...this.localDirtyPaths]) {
        if (dirtyPath === prefix || dirtyPath.startsWith(`${prefix}/`)) this.localDirtyPaths.delete(dirtyPath);
      }
    }
    const normalizedPath = filePath.replace(/\/$/, '');
    const parentPath = normalizedPath.includes('/') ? normalizedPath.slice(0, normalizedPath.lastIndexOf('/')) : '';
    const root = (config.remotePath || '/').replace(/\\/g, '/').replace(/\/+$/g, '') || '/';
    const remoteDirectory = parentPath ? `${root}/${parentPath}` : root;
    this.diffDirectoryCache.delete(`${config.protocol}:${config.host}:${config.port || ''}:${remoteDirectory}`);
    logger.info(`ITFFTP diff ${action} completed: ${filePath}; refreshing paired comparison`);
    await this.refreshAfterTransfer([filePath]);
    this.panel?.webview.postMessage({ type: 'diffActionComplete', action, direction, path: filePath });
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

    if (!destination) return;

    const data = selectedOnly && connections.length === 1 ? connections[0] : connections;
    await vscode.workspace.fs.writeFile(destination, new TextEncoder().encode(JSON.stringify(data, null, 2)));
    vscode.window.showInformationMessage(
      `ITFFTP: Exported ${connections.length} remote location${connections.length === 1 ? '' : 's'}. Keep this file secure if it contains credentials.`
    );
  }

  private async getWorkspaceDirectory(relativeDirectory: string, ignorePatterns: string[]): Promise<{ files: string[]; stats: Record<string, { size: number; modifyTime: number }> }> {
    if (!this.scope) return { files: [], stats: {} };
    const directory = relativeDirectory ? vscode.Uri.joinPath(this.scope, ...relativeDirectory.split('/')) : this.scope;
    const files: string[] = [];
    const stats: Record<string, { size: number; modifyTime: number }> = {};
    try {
      const entries = await vscode.workspace.fs.readDirectory(directory);
      for (const [name, type] of entries) {
        const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
        if (this.isIgnoredDiffPath(relativePath, ignorePatterns)) continue;
        if (type === vscode.FileType.Directory) files.push(`${relativePath}/`);
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

  private async getWorkspaceDirectoryEntries(relativeDirectory: string, ignorePatterns: string[]): Promise<DiffEntry[]> {
    if (!this.scope) return [];
    const directory = relativeDirectory ? vscode.Uri.joinPath(this.scope, ...relativeDirectory.split('/')) : this.scope;
    try {
      const entries = await vscode.workspace.fs.readDirectory(directory);
      const result: DiffEntry[] = [];
      for (const [name, type] of entries) {
        const path = relativeDirectory ? `${relativeDirectory}/${name}` : name;
        if (this.isIgnoredDiffPath(path, ignorePatterns)) continue;
        if (type === vscode.FileType.Directory) result.push({ path, type: 'directory' });
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

  private async getWorkspaceFiles(ignorePatterns: string[] = DEFAULT_IGNORE_PATTERNS): Promise<string[]> {
    if (!this.scope) return [];

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
        if (this.isIgnoredDiffPath(relativePath, ignorePatterns)) continue;
        if (type === vscode.FileType.Directory) {
          files.push(`${relativePath}/`);
          if (current.depth < 12 && files.length < 10000) {
            queue.push({ uri: vscode.Uri.joinPath(current.uri, name), prefix: relativePath, depth: current.depth + 1 });
          }
        } else if (type === vscode.FileType.File) {
          files.push(relativePath);
        }

        if (files.length >= 10000) break;
      }
    }

    return files.sort((left, right) => left.localeCompare(right));
  }

  private isIgnoredDiffPath(relativePath: string, patterns: string[]): boolean {
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!normalized) return false;
    const basename = normalized.split('/').pop() || normalized;
    return patterns.some(pattern => {
      const clean = String(pattern || '').replace(/^\/+|\/+$/g, '');
      if (!clean) return false;
      if (matchesPattern(normalized, [clean]) || matchesPattern(basename, [clean])) return true;
      if (!/[?*]/.test(clean) && normalized.split('/').includes(clean)) return true;
      if (clean.endsWith('/**')) {
        const prefix = clean.slice(0, -3);
        return normalized === prefix || normalized.startsWith(`${prefix}/`);
      }
      return false;
    });
  }

  private async getWorkspaceFileStats(
    workspaceFiles?: string[]
  ): Promise<Record<string, { size: number; modifyTime: number }>> {
    if (!this.scope) return {};
    const stats: Record<string, { size: number; modifyTime: number }> = {};
    for (const relative of workspaceFiles || await this.getWorkspaceFiles()) {
      if (relative.endsWith('/')) continue;
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

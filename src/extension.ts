/**
 * ITFFTP - VS Code Extension
 * 
 * A professional FTP/SFTP client with file manager and web master tools
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { RemoteExplorerTreeProvider } from './providers/remote-explorer-tree';
import { RemoteDocumentProvider } from './providers/remote-document-provider';
import { configManager } from './core/config';
import { connectionManager } from './core/connection-manager';
import { transferManager } from './core/transfer-manager';
import { isTransferCompleted, skippedTransferMessage } from './core/transfer-outcome';
import { logger } from './utils/logger';
import { statusBar } from './utils/status-bar';
import { registerCommands } from './commands';
import { fileWatcherManager, WatchedChange } from './core/file-watcher';
import { DEFAULT_IGNORE_PATTERNS, errorCode, errorMessage, isPathIgnored, resolveLocalRoot } from './utils/helpers';
import { SettingsPanel } from './providers/settings-panel';
import { DashboardLauncherProvider } from './providers/dashboard-launcher';
import { AnalyticsStore } from './core/analytics-store';
import { FileEntry, FTPConfig, TransferItem } from './types';

let remoteTreeProvider: RemoteExplorerTreeProvider;
let remoteDocumentProvider: RemoteDocumentProvider;
let settingsPanelProvider: SettingsPanel;
let remoteExplorerRefreshTimer: NodeJS.Timeout | undefined;

import { ProviderContainer } from './commands/index';

const providerContainer: ProviderContainer = {
  remoteExplorer: undefined,
  settingsPanel: undefined
};

interface RemoteCommandItem {
  entry: FileEntry;
  config?: FTPConfig;
}

interface EditMapping {
  remotePath: string;
  config: FTPConfig;
}

function getEditMappings(): Map<string, EditMapping> | undefined {
  return (global as { stackerftpEditMappings?: Map<string, EditMapping> }).stackerftpEditMappings;
}

// Session-based auto-upload confirmation state
// Session-based auto-upload confirmation state (per host)
const autoUploadConfirmedHosts: Set<string> = new Set();

const AUTO_CONNECT_DELAY_MS = 1500;
const AUTO_CONNECT_RETRY_DELAY_MS = 3000;
const MAX_AUTO_CONNECT_RETRIES = 1;
const autoConnectTimers: Map<string, NodeJS.Timeout> = new Map();
const autoConnectRetries: Map<string, number> = new Map();

function scheduleRemoteExplorerRefresh(): void {
  if (remoteExplorerRefreshTimer) {clearTimeout(remoteExplorerRefreshTimer);}
  remoteExplorerRefreshTimer = setTimeout(() => {
    remoteExplorerRefreshTimer = undefined;
    remoteTreeProvider?.refreshAfterOperation();
  }, 150);
}

export function activate(context: vscode.ExtensionContext): void {
  logger.info('ITFFTP activation started');
  const analyticsStore = new AnalyticsStore(context.globalStorageUri);
  context.subscriptions.push(analyticsStore);
  const transferCompleteListener = (item: TransferItem): void => {
    void analyticsStore.record(item);
    if (item.status === 'completed') {
      if (item.config) {
        fileWatcherManager.markTransferCompleted(item.config, item.localPath, item.remotePath);
      }
      if (item.direction === 'upload') {scheduleRemoteExplorerRefresh();}
    }
  };
  transferManager.on('transferComplete', transferCompleteListener);
  context.subscriptions.push({
    dispose: () => transferManager.removeListener('transferComplete', transferCompleteListener)
  });
  // 1. Fundamental Command Registration (Always available)
  context.subscriptions.push(
    vscode.commands.registerCommand('stackerftp.showOutput', () => {
      logger.show();
    })
  );

  // 2. Register Global Providers
  const settingsPanel = new SettingsPanel(context.extensionUri, async scope => {
    await configManager.loadConfig(scope.fsPath);
    remoteTreeProvider?.refresh();
    await startFileWatcher(scope.fsPath);
    scheduleAutoConnect(scope.fsPath);
  }, analyticsStore, context.globalStorageUri);
  settingsPanelProvider = settingsPanel;
  context.subscriptions.push(connectionManager.onConnectionChanged(() => {
    const scope = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!scope) {return;}
    const active = configManager.getActiveConfig(scope.fsPath);
    if (active && connectionManager.isConnected(active)) {settingsPanel.scheduleBackgroundRefresh(active);}
  }));
  providerContainer.settingsPanel = settingsPanel;
  const dashboardLauncher = new DashboardLauncherProvider(() => settingsPanel.open());
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      DashboardLauncherProvider.viewType,
      dashboardLauncher
    ),
    settingsPanel,
    vscode.commands.registerCommand('stackerftp.openSettings', () => {
      settingsPanel.open();
    })
  );

  // 3. Resolve workspace-owned providers before command registration. The
  // command module captures provider references when it registers handlers, so
  // registering first permanently leaves Remote Explorer commands undefined.
  const workspaceFolders = vscode.workspace.workspaceFolders;
  const workspaceRoot = workspaceFolders?.[0]?.uri.fsPath;

  if (workspaceRoot) {
    remoteDocumentProvider = new RemoteDocumentProvider();
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(
        RemoteDocumentProvider.scheme,
        remoteDocumentProvider
      )
    );

    remoteTreeProvider = new RemoteExplorerTreeProvider(workspaceRoot);
    providerContainer.remoteExplorer = remoteTreeProvider;
    context.subscriptions.push(remoteTreeProvider);
  }

  // 4. Register All Feature Commands (before the no-workspace early exit).
  registerCommands(context, providerContainer);

  if (!workspaceFolders || workspaceFolders.length === 0) {
    logger.info('No workspace folder open, features will activate on folder open.');

    // Show welcome message
    vscode.window.showInformationMessage(
      'ITFFTP: Please open a folder to start using ITFFTP features.',
      'Open Folder'
    ).then(selection => {
      if (selection === 'Open Folder') {
        vscode.commands.executeCommand('vscode.openFolder');
      }
    });

    return;
  }

  // The guarded initialization above proves this before the early exit.
  const activeWorkspaceRoot = workspaceRoot!;

  // The dashboard is the only ITFFTP surface. Keep the provider available to
  // transfer commands, but do not create a classic explorer side-panel view.

  // 5. Register viewContent command
  context.subscriptions.push(
    vscode.commands.registerCommand('stackerftp.viewContent', async (item?: RemoteCommandItem) => {
      if (!item || !item.entry) {
        statusBar.error('No file selected');
        return;
      }

      const remotePath = item.entry.path;
      const fileName = item.entry.name || path.basename(remotePath);

      if (RemoteDocumentProvider.isSystemFile(remotePath)) {
        statusBar.warn(`Cannot view system file: ${fileName}`);
        return;
      }

      if (RemoteDocumentProvider.isBinaryFile(remotePath)) {
        const choice = await vscode.window.showWarningMessage(
          `"${fileName}" is a binary file and cannot be viewed as text. Download instead?`,
          'Download', 'Cancel'
        );
        if (choice === 'Download') {
          vscode.commands.executeCommand('stackerftp.tree.download', item);
        }
        return;
      }

      if (item.config) {
        RemoteDocumentProvider.setConfigForPath(remotePath, item.config);
      }

      try {
        const uri = RemoteDocumentProvider.createUri(remotePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (error) {
        statusBar.error(`Failed to open file: ${errorMessage(error)}`);
      }
    })
  );

  // 6. Transfer status & File Watcher. The native queue TreeView is retired;
  // retain only the status count and dispose both EventEmitter listeners.
  const transferQueueUpdateListener = (): void => {
    statusBar.updateTransferCount(transferManager.getActiveCount());
  };
  const transferQueueCompleteListener = (): void => statusBar.updateTransferCount(0);
  transferManager.on('queueUpdate', transferQueueUpdateListener);
  transferManager.on('queueComplete', transferQueueCompleteListener);
  context.subscriptions.push({
    dispose: () => {
      transferManager.removeListener('queueUpdate', transferQueueUpdateListener);
      transferManager.removeListener('queueComplete', transferQueueCompleteListener);
    }
  });

  // 7. Startup Tasks
  // Load every workspace config before starting its independently-owned watcher.
  settingsPanel.initialize(vscode.Uri.file(activeWorkspaceRoot));
  for (const folder of workspaceFolders) {
    void loadConfiguration(folder.uri.fsPath).then(() => startFileWatcher(folder.uri.fsPath));
  }

  // 8. Event Listeners (Workspace changes, Save)
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async event => {
      for (const removed of event.removed) {
        clearAutoConnectTimer(removed.uri.fsPath);
        const removedConfig = configManager.getActiveConfig(removed.uri.fsPath);
        fileWatcherManager.stopWatcher(removed.uri.fsPath);
        if (removedConfig) {await connectionManager.disconnect(removedConfig);}
      }
      for (const added of event.added) {
        await loadConfiguration(added.uri.fsPath);
        settingsPanel.initialize(added.uri);
        await startFileWatcher(added.uri.fsPath);
      }
    }),
    vscode.workspace.onDidChangeConfiguration(async event => {
      for (const folder of vscode.workspace.workspaceFolders || []) {
        if (event.affectsConfiguration('stackerftp.enableFileWatcher', folder.uri)) {
          await startFileWatcher(folder.uri.fsPath);
        }
      }
    }),
    vscode.workspace.onDidSaveTextDocument(async document => {
      const documentScope = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath || activeWorkspaceRoot;
      const configPath = path.join(documentScope, '.vscode', 'sftp.json');
      if (normalizeLocalPath(document.fileName) === normalizeLocalPath(configPath)) {
        await loadConfiguration(documentScope);
        remoteTreeProvider?.refresh();
        await startFileWatcher(documentScope);
        statusBar.success('Configuration reloaded');
        return;
      }

      // Handle Edit Local
      const editMappings = getEditMappings();
      if (editMappings && editMappings.has(document.fileName)) {
        const metadata = editMappings.get(document.fileName);
        if (!metadata || !connectionManager.isConnected(metadata.config)) {return;}
        try {
          const connection = connectionManager.getConnection(metadata.config)!;
          const outcome = await transferManager.uploadFile(connection, document.fileName, metadata.remotePath, metadata.config);
          if (isTransferCompleted(outcome)) {
            statusBar.success(`Uploaded: ${path.basename(metadata.remotePath)}`);
          } else {
            void vscode.window.showWarningMessage(skippedTransferMessage('Upload', metadata.remotePath, outcome));
          }
        } catch (error) {
          statusBar.error(`Failed to upload: ${errorMessage(error)}`, true);
        }
        return;
      }

      handleFileSave(document, documentScope);
    })
  );

  logger.info('ITFFTP extension activated successfully');
}

// NOTE: FileSystemProvider for 'stackerftp' scheme was removed as it was
// a placeholder implementation. Remote file viewing uses RemoteDocumentProvider
// with 'stackerftp-remote' scheme, and editing uses 'editInLocal' workflow.

async function loadConfiguration(workspaceRoot: string): Promise<void> {
  try {
    if (configManager.configExists(workspaceRoot)) {
      await configManager.loadConfig(workspaceRoot);
      logger.info('Configuration loaded successfully');

      const config = configManager.getActiveConfig(workspaceRoot);
      if (config) {
        logger.info(`Active config: ${config.name || config.host}`);
      }
      scheduleAutoConnect(workspaceRoot);
    } else {
      clearAutoConnectTimer(workspaceRoot);
      logger.info('No configuration file found');
    }
  } catch (error) {
    clearAutoConnectTimer(workspaceRoot);
    logger.error('Failed to load configuration', error);
  }
}

function scheduleAutoConnect(workspaceRoot: string): void {
  clearAutoConnectTimer(workspaceRoot);

  const configuration = vscode.workspace.getConfiguration(
    'stackerftp',
    vscode.Uri.file(workspaceRoot)
  );
  if (!configuration.get<boolean>('autoConnect', true)) {
    logger.info('Auto-connect is disabled in ITFFTP settings');
    return;
  }

  if (!vscode.workspace.isTrusted) {
    logger.info('Auto-connect skipped because the workspace is not trusted');
    return;
  }

  const config = configManager.getActiveConfig(workspaceRoot);
  if (!config) {
    logger.info('Auto-connect skipped because no active FTP configuration is available');
    return;
  }

  const timer = setTimeout(() => {
    autoConnectTimers.delete(workspaceRoot);
    void autoConnectConfiguredServer(workspaceRoot);
  }, AUTO_CONNECT_DELAY_MS);
  autoConnectTimers.set(workspaceRoot, timer);
  logger.info(`Auto-connect scheduled for ${config.name || config.host} in ${AUTO_CONNECT_DELAY_MS}ms`);
}

function clearAutoConnectTimer(workspaceRoot: string): void {
  const timer = autoConnectTimers.get(workspaceRoot);
  if (!timer) {return;}
  clearTimeout(timer);
  autoConnectTimers.delete(workspaceRoot);
}

async function autoConnectConfiguredServer(workspaceRoot: string): Promise<void> {
  const configuration = vscode.workspace.getConfiguration(
    'stackerftp',
    vscode.Uri.file(workspaceRoot)
  );
  if (!configuration.get<boolean>('autoConnect', true)) {return;}

  const config = configManager.getActiveConfig(workspaceRoot);
  if (!config) {return;}
  if (connectionManager.isConnected(config)) {
    settingsPanelProvider?.scheduleBackgroundRefresh(config);
    return;
  }

  // Avoid an unsolicited password prompt during startup. Users can connect
  // manually from the panel when credentials have not been stored yet.
  if (!config.password && !config.privateKeyPath) {
    logger.warn(`Auto-connect skipped for ${config.host}: no stored password or private key`);
    return;
  }

  try {
    logger.info(`Auto-connecting to ${config.name || config.host}`);
    await connectionManager.connect(config);
    settingsPanelProvider?.scheduleBackgroundRefresh(config);
    autoConnectRetries.delete(workspaceRoot);
    remoteTreeProvider?.refresh();
  } catch (error) {
    logger.error(`Auto-connect failed for ${config.host}`, error);
    statusBar.error(`Auto-connect failed: ${errorMessage(error)}`, true);
    const attempts = autoConnectRetries.get(workspaceRoot) || 0;
    if (configuration.get<boolean>('autoReconnect', true) && attempts < MAX_AUTO_CONNECT_RETRIES) {
      autoConnectRetries.set(workspaceRoot, attempts + 1);
      logger.warn(`Retrying initial connection to ${config.name || config.host} in ${AUTO_CONNECT_RETRY_DELAY_MS}ms`);
      const retryTimer = setTimeout(() => {
        autoConnectTimers.delete(workspaceRoot);
        void autoConnectConfiguredServer(workspaceRoot);
      }, AUTO_CONNECT_RETRY_DELAY_MS);
      autoConnectTimers.set(workspaceRoot, retryTimer);
    }
  }
}

async function handleFileSave(document: vscode.TextDocument, workspaceRoot: string): Promise<void> {
  const config = configManager.getActiveConfig(workspaceRoot);
  if (!config || !config.uploadOnSave) {
    return;
  }
  const watcherEnabled = vscode.workspace.getConfiguration(
    'stackerftp',
    vscode.Uri.file(workspaceRoot)
  ).get<boolean>('enableFileWatcher', false);
  if (watcherEnabled) {
    // The FileWatcher owns Auto Sync saves so every editor and filesystem edit
    // follows the same one-second quiet period and is transferred only once.
    return;
  }

  const localRoot = resolveLocalRoot(workspaceRoot, config.localPath);
  const localRelation = path.relative(localRoot, document.fileName);
  if (localRelation === '..' || localRelation.startsWith(`..${path.sep}`) || path.isAbsolute(localRelation)) {return;}

  const relativePath = localRelation;
  if (isPathIgnored(relativePath, [...DEFAULT_IGNORE_PATTERNS, ...(config.ignore || [])])) {
    return;
  }

  // Check for active connection FIRST - before showing a dialog
  if (!connectionManager.isConnected(config)) {
    logger.debug(`No active connection for ${config.name || config.host}, skipping auto-upload`);
    return;
  }

  const connectionKey = `${config.username}@${config.host}`;

  // Ask for confirmation once per session (per host)
  if (!autoUploadConfirmedHosts.has(connectionKey)) {
    const choice = await vscode.window.showInformationMessage(
      `Auto-upload is enabled. Upload "${path.basename(document.fileName)}" to ${config.name || config.host}?`,
      { modal: false },
      'Yes, upload',
      'Yes, always in this session',
      'No'
    );

    if (choice === 'No' || !choice) {
      return;
    }

    if (choice === 'Yes, always in this session') {
      autoUploadConfirmedHosts.add(connectionKey);
    }
  }

  try {
    const connection = connectionManager.getConnection(config);
    if (!connection) {
      logger.warn(`Connection lost during save for ${config.host}`);
      return;
    }
    const remotePath = path.join(config.remotePath, relativePath).replace(/\\/g, '/');

    const remoteDir = path.dirname(remotePath);
    try {
      await connection.mkdir(remoteDir);
    } catch (error) {
      // Directory might already exist
      const code = errorCode(error);
      const message = errorMessage(error, '');
      if (code !== 'EEXIST' && !message.includes('exists')) {
        logger.warn(`Failed to create directory: ${remoteDir}`, error);
        // Permission hatası varsa bildir
        if (code === 'EACCES' || code === 'EPERM' ||
          message.includes('permission') || message.includes('Permission')) {
          throw new Error(`Permission denied creating directory: ${remoteDir}`);
        }
      }
    }

    const outcome = await transferManager.uploadFile(connection, document.fileName, remotePath, config);
    if (!isTransferCompleted(outcome)) {
      void vscode.window.showWarningMessage(skippedTransferMessage('Auto-upload', document.fileName, outcome));
      return;
    }

    vscode.window.setStatusBarMessage(`$(cloud-upload) Uploaded: ${path.basename(document.fileName)}`, 3000);
    logger.info(`Auto-uploaded: ${relativePath}`);
  } catch (error) {
    vscode.window.setStatusBarMessage(`$(error) Upload failed: ${path.basename(document.fileName)}`, 5000);
    logger.error(`Auto-upload failed for ${relativePath}`, error);
  }
}

async function startFileWatcher(workspaceRoot: string): Promise<void> {
  const config = configManager.getActiveConfig(workspaceRoot);
  if (!config) {
    fileWatcherManager.stopWatcher(workspaceRoot);
    return;
  }
  const enabled = vscode.workspace.getConfiguration('stackerftp', vscode.Uri.file(workspaceRoot)).get<boolean>('enableFileWatcher', false);
  if (!enabled) {
    fileWatcherManager.stopWatcher(workspaceRoot);
    return;
  }
  const localRoot = resolveLocalRoot(workspaceRoot, config.localPath);
  fileWatcherManager.startWatcher(workspaceRoot, localRoot, config, async (change: WatchedChange) => {
    await settingsPanelProvider?.refreshWatchedPath(
      config,
      change.path,
      change.remoteMutated === true,
      change.kind,
      change.completedDirection
    );
    if (change.side === 'remote' || change.remoteMutated) {scheduleRemoteExplorerRefresh();}
  }, relativePath => settingsPanelProvider?.canAutoDownload(config, relativePath) ?? true);
}

function normalizeLocalPath(localPath: string): string {
  const resolved = path.resolve(localPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function deactivate(): void {
  logger.info('ITFFTP extension deactivating...');

  for (const timer of autoConnectTimers.values()) {
    clearTimeout(timer);
  }
  autoConnectTimers.clear();

  if (remoteExplorerRefreshTimer) {clearTimeout(remoteExplorerRefreshTimer);}
  remoteExplorerRefreshTimer = undefined;

  fileWatcherManager.stopAll();

  connectionManager.disconnect().catch(error => {
    console.error('Error disconnecting:', error);
  });

  // Clean up temporary edit files
  try {
    const tempEditDir = path.join(os.tmpdir(), 'stackerftp-edit');
    if (fs.existsSync(tempEditDir)) {
      fs.rmSync(tempEditDir, { recursive: true, force: true });
      logger.info('Cleaned up temporary edit files');
    }
  } catch (error) {
    // Ignore cleanup errors - not critical
    console.error('Error cleaning up temp files:', error);
  }

  // Clear edit mappings
  getEditMappings()?.clear();

  statusBar.dispose();
  logger.dispose();
}

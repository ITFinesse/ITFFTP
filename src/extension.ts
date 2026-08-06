/**
 * ITFFTP - VS Code Extension
 * 
 * A professional FTP/SFTP client with file manager and web master tools
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { RemoteExplorerWebviewProvider } from './providers/remote-explorer-webview';
import { RemoteExplorerTreeProvider } from './providers/remote-explorer-tree';
import { ConnectionFormProvider } from './providers/connection-form-provider';
import { RemoteDocumentProvider } from './providers/remote-document-provider';
import { configManager } from './core/config';
import { connectionManager } from './core/connection-manager';
import { transferManager } from './core/transfer-manager';
import { logger } from './utils/logger';
import { statusBar } from './utils/status-bar';
import { registerCommands } from './commands';
import { fileWatcherManager } from './core/file-watcher';
import { DEFAULT_IGNORE_PATTERNS, isPathIgnored } from './utils/helpers';
import { TransferQueueTreeProvider } from './providers/transfer-queue-tree';
import { SettingsPanel } from './providers/settings-panel';
import { DashboardLauncherProvider } from './providers/dashboard-launcher';
import { AnalyticsStore } from './core/analytics-store';
import { FTPConfig } from './types';
import { isWatcherWriteSuppressed, suppressWatcherWrite } from './core/watcher-suppression';

let remoteExplorerProvider: RemoteExplorerWebviewProvider;
let remoteTreeProvider: RemoteExplorerTreeProvider;
let connectionFormProvider: ConnectionFormProvider;
let remoteDocumentProvider: RemoteDocumentProvider;
let settingsPanelProvider: SettingsPanel;

import { ProviderContainer } from './commands/index';

const providerContainer: ProviderContainer = {
  remoteExplorer: undefined,
  connectionFormProvider: undefined,
  settingsPanel: undefined,
  treeView: undefined
};

// Session-based auto-upload confirmation state
// Session-based auto-upload confirmation state (per host)
const autoUploadConfirmedHosts: Set<string> = new Set();

// Track recently uploaded files to prevent duplicate uploads
// when both uploadOnSave and watcher.autoUpload are enabled
const AUTO_CONNECT_DELAY_MS = 1500;
const AUTO_CONNECT_RETRY_DELAY_MS = 3000;
const MAX_AUTO_CONNECT_RETRIES = 1;
const autoConnectTimers: Map<string, NodeJS.Timeout> = new Map();
const autoConnectRetries: Map<string, number> = new Map();

/**
 * Mark a file as recently uploaded to prevent duplicate uploads
 */
export function markFileAsUploaded(filePath: string): void {
  suppressWatcherWrite(filePath, 3000);
}

/**
 * Check if a file was recently uploaded (within tracking duration)
 */
export function wasRecentlyUploaded(filePath: string): boolean {
  return isWatcherWriteSuppressed(filePath);
}

export function activate(context: vscode.ExtensionContext): void {
  logger.info('ITFFTP activation started');
  const analyticsStore = new AnalyticsStore(context.globalStorageUri);
  context.subscriptions.push(analyticsStore);
  transferManager.on('transferComplete', item => { void analyticsStore.record(item); });
  // 1. Fundamental Command Registration (Always available)
  context.subscriptions.push(
    vscode.commands.registerCommand('stackerftp.showOutput', () => {
      logger.show();
    })
  );

  // 2. Register Global Providers
  connectionFormProvider = new ConnectionFormProvider(context.extensionUri);
  providerContainer.connectionFormProvider = connectionFormProvider;
  const settingsPanel = new SettingsPanel(context.extensionUri, async scope => {
    await configManager.loadConfig(scope.fsPath);
    connectionFormProvider?.refresh();
    remoteTreeProvider?.refresh();
    await startFileWatcher(scope.fsPath);
    scheduleAutoConnect(scope.fsPath);
  }, analyticsStore, context.globalStorageUri);
  settingsPanelProvider = settingsPanel;
  context.subscriptions.push(connectionManager.onConnectionChanged(() => {
    const scope = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!scope) return;
    const active = configManager.getActiveConfig(scope.fsPath);
    if (active && connectionManager.isConnected(active)) settingsPanel.scheduleBackgroundRefresh(active);
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

  // 3. Register All Feature Commands (before early exit)
  registerCommands(context, providerContainer);

  // 4. Workspace Check & Feature-specific Initialization
  const workspaceFolders = vscode.workspace.workspaceFolders;

  if (!workspaceFolders || workspaceFolders.length === 0) {
    logger.info('No workspace folder open, features will activate on folder open.');

    // Show welcome message
    vscode.window.showInformationMessage(
      'ITFFTP: Please open a folder to start using SFTP features.',
      'Open Folder'
    ).then(selection => {
      if (selection === 'Open Folder') {
        vscode.commands.executeCommand('vscode.openFolder');
      }
    });

    return;
  }

  const workspaceRoot = workspaceFolders[0].uri.fsPath;

  // 5. Remote Explorer & File System Providers
  remoteDocumentProvider = new RemoteDocumentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      RemoteDocumentProvider.scheme,
      remoteDocumentProvider
    )
  );

  // 6. Native TreeView Setup
  remoteTreeProvider = new RemoteExplorerTreeProvider(workspaceRoot);
  providerContainer.remoteExplorer = remoteTreeProvider;

  // The dashboard is the only ITFFTP surface. Keep the provider available to
  // transfer commands, but do not create a classic explorer side-panel view.

  // 7. Register viewContent command
  context.subscriptions.push(
    vscode.commands.registerCommand('stackerftp.viewContent', async (item?: any) => {
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
      } catch (error: any) {
        statusBar.error(`Failed to open file: ${error.message}`);
      }
    })
  );

  // 8. Transfer Queue & File Watcher
  const transferQueueProvider = new TransferQueueTreeProvider();
  context.subscriptions.push(transferQueueProvider);

  transferManager.on('queueUpdate', () => {
    const activeCount = transferManager.getActiveCount();
    statusBar.updateTransferCount(activeCount);
    // UI Update: Badge on Activity Bar
    if (transferQueueProvider) {
      transferQueueProvider.updateBadge(activeCount);
    }
  });

  transferManager.on('queueComplete', () => {
    statusBar.updateTransferCount(0);
    if (transferQueueProvider) {
      transferQueueProvider.updateBadge(0);
    }
  });

  // 9. Startup Tasks
  // Load the config before starting the watcher or scheduling auto-connect.
  void loadConfiguration(workspaceRoot).then(() => {
    settingsPanel.initialize(vscode.Uri.file(workspaceRoot));
    return startFileWatcher(workspaceRoot);
  });

  // 10. Event Listeners (Workspace changes, Save)
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async event => {
      for (const removed of event.removed) {
        clearAutoConnectTimer(removed.uri.fsPath);
        fileWatcherManager.stopAll();
        await connectionManager.disconnect();
      }
      for (const added of event.added) {
        await loadConfiguration(added.uri.fsPath);
        settingsPanel.initialize(added.uri);
        await startFileWatcher(added.uri.fsPath);
      }
    }),
    vscode.workspace.onDidSaveTextDocument(async document => {
      const configPath = path.join(workspaceRoot, '.vscode', 'sftp.json');
      if (document.fileName === configPath) {
        await loadConfiguration(workspaceRoot);
        if (connectionFormProvider) connectionFormProvider.refresh();
        statusBar.success('Configuration reloaded');
        return;
      }

      // Handle Edit Local
      const editMappings = (global as any).stackerftpEditMappings;
      if (editMappings && editMappings.has(document.fileName)) {
        const metadata = editMappings.get(document.fileName);
        if (!connectionManager.isConnected(metadata.config)) return;
        try {
          const connection = connectionManager.getConnection(metadata.config)!;
          await transferManager.uploadFile(connection, document.fileName, metadata.remotePath, metadata.config);
          statusBar.success(`Uploaded: ${path.basename(metadata.remotePath)}`);
        } catch (error: any) {
          statusBar.error(`Failed to upload: ${error.message}`, true);
        }
        return;
      }

      handleFileSave(document, workspaceRoot);
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
  if (!timer) return;
  clearTimeout(timer);
  autoConnectTimers.delete(workspaceRoot);
}

async function autoConnectConfiguredServer(workspaceRoot: string): Promise<void> {
  const configuration = vscode.workspace.getConfiguration(
    'stackerftp',
    vscode.Uri.file(workspaceRoot)
  );
  if (!configuration.get<boolean>('autoConnect', true)) return;

  const config = configManager.getActiveConfig(workspaceRoot);
  if (!config) return;
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
    connectionFormProvider?.refresh();
  } catch (error: any) {
    logger.error(`Auto-connect failed for ${config.host}`, error);
    statusBar.error(`Auto-connect failed: ${error.message || error}`, true);
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
  if (!document.fileName.startsWith(workspaceRoot)) {
    return;
  }

  const config = configManager.getActiveConfig(workspaceRoot);
  if (!config || !config.uploadOnSave) {
    return;
  }

  const relativePath = path.relative(workspaceRoot, document.fileName);
  if (isPathIgnored(relativePath, [...DEFAULT_IGNORE_PATTERNS, ...(config.ignore || [])])) {
    return;
  }

  // Check for active connection FIRST - before showing any dialog
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
    } catch (error: any) {
      // Directory might already exist
      if (error.code !== 'EEXIST' && !error.message?.includes('exists')) {
        logger.warn(`Failed to create directory: ${remoteDir}`, error);
        // Permission hatası varsa bildir
        if (error.code === 'EACCES' || error.code === 'EPERM' ||
          error.message?.includes('permission') || error.message?.includes('Permission')) {
          throw new Error(`Permission denied creating directory: ${remoteDir}`);
        }
      }
    }

    await transferManager.uploadFile(connection, document.fileName, remotePath, config);

    // Mark as recently uploaded to prevent duplicate from file watcher
    markFileAsUploaded(document.fileName);

    vscode.window.setStatusBarMessage(`$(cloud-upload) Uploaded: ${path.basename(document.fileName)}`, 3000);
    logger.info(`Auto-uploaded: ${relativePath}`);
  } catch (error) {
    vscode.window.setStatusBarMessage(`$(error) Upload failed: ${path.basename(document.fileName)}`, 5000);
    logger.error(`Auto-upload failed for ${relativePath}`, error);
  }
}

async function startFileWatcher(workspaceRoot: string): Promise<void> {
  const config = configManager.getActiveConfig(workspaceRoot);
  if (!config) return;
  const key = `${workspaceRoot}-${config.host}`;
  const enabled = vscode.workspace.getConfiguration('stackerftp', vscode.Uri.file(workspaceRoot)).get<boolean>('enableFileWatcher', false);
  if (!enabled || (!config.watcher && !config.uploadOnSave)) {
    fileWatcherManager.stopWatcher(key);
    return;
  }
  const watcherConfig: FTPConfig = config.watcher ? config : {
    ...config,
    watcher: { files: '**/*', autoUpload: true, autoDelete: false }
  };
  fileWatcherManager.startWatcher(workspaceRoot, watcherConfig);
}

export function deactivate(): void {
  logger.info('ITFFTP extension deactivating...');

  for (const timer of autoConnectTimers.values()) {
    clearTimeout(timer);
  }
  autoConnectTimers.clear();

  fileWatcherManager.stopAll();

  connectionManager.disconnect().catch(error => {
    console.error('Error disconnecting:', error);
  });

  // Clean up temporary edit files
  try {
    const os = require('os');
    const fs = require('fs');
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
  if ((global as any).stackerftpEditMappings) {
    (global as any).stackerftpEditMappings.clear();
  }

  statusBar.dispose();
  logger.dispose();
}

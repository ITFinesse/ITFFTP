/**
 * ITFFTP - Commands
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { configManager } from '../core/config';
import { connectionManager } from '../core/connection-manager';
import { isConnectionClosedError } from '../core/connection-errors';
import { transferManager } from '../core/transfer-manager';
import { isTransferCompleted, skippedTransferMessage } from '../core/transfer-outcome';
import { runBoundedRecursiveScan } from '../core/recursive-scan';
import type { BaseConnection } from '../core/connection';
import type { FileEntry, FTPConfig, Protocol, SyncResult, TransferOutcome } from '../types';
import { logger } from '../utils/logger';
import { statusBar } from '../utils/status-bar';
import { errorCode, errorMessage, normalizeRemotePath, formatFileSize, sanitizeRelativePath, resolveLocalRoot } from '../utils/helpers';
import { ConnectionWizard } from '../core/connection-wizard';
import { createGitIntegration } from '../core/git-integration';
import { getWorkspaceRoot } from './utils';
import { registerWebMasterCommands } from './webmaster';
import { registerViewCommands } from './view';

import { SettingsPanel } from '../providers/settings-panel';
import type {
  RemoteConfigTreeItem,
  RemoteExplorerTreeProvider,
  RemoteTreeItem
} from '../providers/remote-explorer-tree';
import type { TransferTreeItem } from '../providers/transfer-queue-tree';

type RemoteExplorerItem = RemoteTreeItem | RemoteConfigTreeItem;
type RemoteExplorerCommandItem = RemoteExplorerItem & { connectionRef?: BaseConnection };
type RemoteFileCommandItem = RemoteTreeItem & { connectionRef?: BaseConnection };
type RemoteFileInput = RemoteTreeItem | FileEntry;
type LocalResourceItem = vscode.Uri | { resourceUri: vscode.Uri };
type DownloadCommandItem = LocalResourceItem | RemoteTreeItem;

const MAX_REMOTE_LIST_FILES = 100_000;

interface ConnectionCommandItem {
  config: FTPConfig;
}

interface EditMapping {
  remotePath: string;
  configName?: string;
  config: FTPConfig;
}

function isRemoteTreeItem(value: unknown): value is RemoteTreeItem {
  return typeof value === 'object' && value !== null && 'entry' in value && 'config' in value;
}

function hasFsPath(value: unknown): value is vscode.Uri {
  return typeof value === 'object' && value !== null && 'fsPath' in value &&
    typeof (value as { fsPath?: unknown }).fsPath === 'string';
}

function reportSkippedTransfer(action: 'Upload' | 'Download', target: string, outcome: TransferOutcome): void {
  if (isTransferCompleted(outcome)) {return;}
  const message = skippedTransferMessage(action, target, outcome);
  void vscode.window.showWarningMessage(message);
}

export interface ProviderContainer {
  remoteExplorer?: RemoteExplorerTreeProvider;
  settingsPanel?: SettingsPanel;
}

type ProfileAction = 'create' | 'edit' | 'delete' | 'setDefault' | 'clearDefault' | 'openJson';

function getConnectionLabel(config: FTPConfig): string {
  return config.name || config.host;
}

function getConnectionDescription(config: FTPConfig): string {
  return `${config.protocol.toUpperCase()} • ${config.username}@${config.host}`;
}

function setOptionalProfileField<K extends keyof FTPConfig>(
  profile: Partial<FTPConfig>,
  key: K,
  value: FTPConfig[K] | undefined
): void {
  if (value === undefined || value === '') {
    delete profile[key];
    return;
  }

  profile[key] = value;
}

async function promptOptionalInput(
  prompt: string,
  value: string,
  placeHolder: string
): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt,
    value,
    placeHolder,
    ignoreFocusOut: true
  });
}

async function promptOptionalPort(existing?: number): Promise<number | undefined | null> {
  for (;;) {
    const rawValue = await promptOptionalInput(
      'Profile port override',
      typeof existing === 'number' ? String(existing) : '',
      'Leave empty to inherit the base connection port'
    );

    if (rawValue === undefined) {
      return undefined;
    }

    const trimmed = rawValue.trim();
    if (!trimmed) {
      return null;
    }

    const port = Number(trimmed);
    if (Number.isInteger(port) && port > 0) {
      return port;
    }

    statusBar.error('Port must be a positive integer');
  }
}

async function promptProfileProtocol(existing?: Protocol): Promise<Protocol | null | undefined> {
  const selected = await vscode.window.showQuickPick(
    [
      { label: 'Inherit Base Connection', value: null as Protocol | null, description: 'Do not override protocol' },
      { label: 'SFTP', value: 'sftp' as Protocol },
      { label: 'FTP', value: 'ftp' as Protocol },
      { label: 'FTPS', value: 'ftps' as Protocol }
    ],
    {
      placeHolder: `Protocol override${existing ? ` (current: ${existing.toUpperCase()})` : ''}`,
      ignoreFocusOut: true
    }
  );

  return selected?.value;
}

async function promptProfileSecure(
  existing?: FTPConfig['secure']
): Promise<FTPConfig['secure'] | null | undefined> {
  const describeCurrent = existing === undefined ? 'inherit' : String(existing);
  const selected = await vscode.window.showQuickPick(
    [
      { label: 'Inherit Base Connection', value: null as FTPConfig['secure'] | null, description: 'Do not override secure mode' },
      { label: 'Disabled', value: false as FTPConfig['secure'] },
      { label: 'Enabled', value: true as FTPConfig['secure'] },
      { label: 'Control', value: 'control' as FTPConfig['secure'] },
      { label: 'Implicit', value: 'implicit' as FTPConfig['secure'] }
    ],
    {
      placeHolder: `Secure mode override (current: ${describeCurrent})`,
      ignoreFocusOut: true
    }
  );

  return selected?.value;
}

async function promptForProfileOverrides(
  profileName: string,
  existing: Partial<FTPConfig> = {}
): Promise<Partial<FTPConfig> | undefined> {
  const profile: Partial<FTPConfig> = { ...existing };

  const protocol = await promptProfileProtocol(existing.protocol);
  if (protocol === undefined) {return undefined;}
  setOptionalProfileField(profile, 'protocol', protocol ?? undefined);

  const host = await promptOptionalInput(
    `Host override for profile "${profileName}"`,
    existing.host || '',
    'Leave empty to inherit the base connection host'
  );
  if (host === undefined) {return undefined;}
  setOptionalProfileField(profile, 'host', host.trim() || undefined);

  const port = await promptOptionalPort(existing.port);
  if (port === undefined) {return undefined;}
  setOptionalProfileField(profile, 'port', port === null ? undefined : port);

  const username = await promptOptionalInput(
    `Username override for profile "${profileName}"`,
    existing.username || '',
    'Leave empty to inherit the base connection username'
  );
  if (username === undefined) {return undefined;}
  setOptionalProfileField(profile, 'username', username.trim() || undefined);

  const remotePath = await promptOptionalInput(
    `Remote path override for profile "${profileName}"`,
    existing.remotePath || '',
    'Leave empty to inherit the base connection remote path'
  );
  if (remotePath === undefined) {return undefined;}
  setOptionalProfileField(profile, 'remotePath', remotePath.trim() || undefined);

  const password = await promptOptionalInput(
    `Password override for profile "${profileName}"`,
    existing.password || '',
    'Leave empty to inherit the base connection password'
  );
  if (password === undefined) {return undefined;}
  setOptionalProfileField(profile, 'password', password || undefined);

  const privateKeyPath = await promptOptionalInput(
    `Private key override for profile "${profileName}"`,
    existing.privateKeyPath || '',
    'Leave empty to inherit the base connection private key path'
  );
  if (privateKeyPath === undefined) {return undefined;}
  setOptionalProfileField(profile, 'privateKeyPath', privateKeyPath.trim() || undefined);

  const passphrase = await promptOptionalInput(
    `Passphrase override for profile "${profileName}"`,
    existing.passphrase || '',
    'Leave empty to inherit the base connection passphrase'
  );
  if (passphrase === undefined) {return undefined;}
  setOptionalProfileField(profile, 'passphrase', passphrase || undefined);

  const secure = await promptProfileSecure(existing.secure);
  if (secure === undefined) {return undefined;}
  setOptionalProfileField(profile, 'secure', secure ?? undefined);

  return profile;
}

async function manageProfiles(workspaceRoot: string): Promise<void> {
  await configManager.loadConfig(workspaceRoot);
  const configs = configManager.getConfigs(workspaceRoot);

  if (configs.length === 0) {
    statusBar.info('No connections configured');
    return;
  }

  const selectedConfigItem = await vscode.window.showQuickPick(
    configs.map((config, index) => ({
      label: getConnectionLabel(config),
      description: getConnectionDescription(config),
      detail: `${Object.keys(config.profiles || {}).length} profile(s)${config.defaultProfile ? ` • default: ${config.defaultProfile}` : ''}`,
      index
    })),
    {
      placeHolder: 'Select a connection to manage profiles',
      ignoreFocusOut: true
    }
  );

  if (!selectedConfigItem) {return;}

  const config = configs[selectedConfigItem.index];
  const profileNames = Object.keys(config.profiles || {});
  const actionItems: { label: string; description: string; value: ProfileAction }[] = [
    { label: 'Create Profile', description: 'Add a new profile override for this connection', value: 'create' },
    { label: 'Open sftp.json', description: 'Edit profiles directly in JSON', value: 'openJson' }
  ];

  if (profileNames.length > 0) {
    actionItems.splice(1, 0,
      { label: 'Edit Profile', description: 'Update an existing profile override', value: 'edit' },
      { label: 'Delete Profile', description: 'Remove an existing profile', value: 'delete' },
      { label: 'Set Default Profile', description: 'Choose which profile should be active by default', value: 'setDefault' }
    );

    if (config.defaultProfile) {
      actionItems.push({
        label: 'Clear Default Profile',
        description: `Stop using "${config.defaultProfile}" as the default`,
        value: 'clearDefault'
      });
    }
  }

  const selectedAction = await vscode.window.showQuickPick(actionItems, {
    placeHolder: `Manage profiles for ${getConnectionLabel(config)}`,
    ignoreFocusOut: true
  });

  if (!selectedAction) {return;}

  if (selectedAction.value === 'openJson') {
    const configPath = configManager.getConfigPath(workspaceRoot);
    const doc = await vscode.workspace.openTextDocument(configPath);
    await vscode.window.showTextDocument(doc);
    return;
  }

  config.profiles = config.profiles || {};

  switch (selectedAction.value) {
    case 'create': {
      const profileName = await vscode.window.showInputBox({
        prompt: 'Profile name',
        placeHolder: 'Example: production, staging, preview',
        ignoreFocusOut: true,
        validateInput: (value) => {
          const trimmed = value.trim();
          if (!trimmed) {return 'Profile name is required';}
          if (config.profiles?.[trimmed]) {return 'A profile with this name already exists';}
          return null;
        }
      });

      if (!profileName) {return;}

      const overrides = await promptForProfileOverrides(profileName.trim());
      if (!overrides) {return;}

      config.profiles[profileName.trim()] = overrides;

      if (!config.defaultProfile) {
        const makeDefault = await vscode.window.showQuickPick(
          ['Yes', 'No'],
          {
            placeHolder: `Use "${profileName.trim()}" as the default profile?`,
            ignoreFocusOut: true
          }
        );
        if (makeDefault === 'Yes') {
          config.defaultProfile = profileName.trim();
        }
      }

      break;
    }

    case 'edit': {
      const selectedProfile = await vscode.window.showQuickPick(profileNames, {
        placeHolder: 'Select a profile to edit',
        ignoreFocusOut: true
      });

      if (!selectedProfile) {return;}

      const overrides = await promptForProfileOverrides(selectedProfile, config.profiles[selectedProfile]);
      if (!overrides) {return;}

      config.profiles[selectedProfile] = overrides;
      break;
    }

    case 'delete': {
      const selectedProfile = await vscode.window.showQuickPick(profileNames, {
        placeHolder: 'Select a profile to delete',
        ignoreFocusOut: true
      });

      if (!selectedProfile) {return;}

      const confirm = await vscode.window.showWarningMessage(
        `Delete profile "${selectedProfile}" from ${getConnectionLabel(config)}?`,
        { modal: true },
        'Delete',
        'Cancel'
      );

      if (confirm !== 'Delete') {return;}

      delete config.profiles[selectedProfile];
      if (config.defaultProfile === selectedProfile) {
        delete config.defaultProfile;
      }
      break;
    }

    case 'setDefault': {
      const selectedProfile = await vscode.window.showQuickPick(profileNames, {
        placeHolder: 'Select the default profile',
        ignoreFocusOut: true
      });

      if (!selectedProfile) {return;}
      config.defaultProfile = selectedProfile;
      break;
    }

    case 'clearDefault':
      delete config.defaultProfile;
      break;
  }

  if (Object.keys(config.profiles).length === 0) {
    delete config.profiles;
  }

  await configManager.saveConfig(workspaceRoot, configs);
  await configManager.loadConfig(workspaceRoot);
  await vscode.commands.executeCommand('stackerftp.tree.refresh');
  statusBar.success(`Profiles updated for ${getConnectionLabel(config)}`);
}

export function registerCommands(
  context: vscode.ExtensionContext,
  container: ProviderContainer
): void {
  const { remoteExplorer, settingsPanel } = container;

  // ==================== Configuration Commands ====================

  const configCommand = vscode.commands.registerCommand('stackerftp.config', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {return;}

    if (configManager.configExists(workspaceRoot)) {
      const choice = await vscode.window.showQuickPick(
        [
          { label: '$(add) Create New Connection (Wizard)', description: 'Step-by-step connection setup', value: 'wizard' },
          { label: '$(file-code) Open Config File', description: 'Edit sftp.json directly', value: 'open' },
          { label: '$(repo-forked) Create New Config (JSON)', description: 'Create raw JSON config', value: 'json' },
          { label: '$(symbol-color) Edit Profiles', description: 'Manage connection profiles', value: 'profiles' }
        ],
        { placeHolder: 'Select an action' }
      );

      if (!choice) {return;}

      switch (choice.value) {
        case 'wizard':
          await ConnectionWizard.createNewConnection(workspaceRoot);
          break;
        case 'open': {
          const configPath = configManager.getConfigPath(workspaceRoot);
          const doc = await vscode.workspace.openTextDocument(configPath);
          await vscode.window.showTextDocument(doc);
          break;
        }
        case 'json':
          await configManager.createDefaultConfig(workspaceRoot);
          break;
        case 'profiles':
          await manageProfiles(workspaceRoot);
          break;
      }
    } else {
      // No config exists - offer wizard or simple config
      const choice = await vscode.window.showQuickPick(
        [
          { label: '$(add) Connection Wizard (Recommended)', description: 'Step-by-step setup with protocol selection', value: 'wizard' },
          { label: '$(file-code) Simple Config', description: 'Create basic JSON template', value: 'simple' }
        ],
        { placeHolder: 'How would you like to create your first connection?' }
      );

      if (choice?.value === 'wizard') {
        await ConnectionWizard.createNewConnection(workspaceRoot);
      } else if (choice?.value === 'simple') {
        await configManager.createDefaultConfig(workspaceRoot);
      }
    }
  });

  // ==================== Connection Commands ====================

  const connectCommand = vscode.commands.registerCommand('stackerftp.connect', async (item?: ConnectionCommandItem) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {return;}

    // Handle direct connection from tree view
    if (item && item.config) {
      try {
        await connectionManager.connect(item.config);
        statusBar.success(`Connected to ${item.config.name || item.config.host}`);
        if (remoteExplorer?.refresh) {
          remoteExplorer.refresh();
        }
      } catch (error: unknown) {
        statusBar.error(`Connection failed: ${errorMessage(error)}`, true);
      }
      return;
    }

    const configs = configManager.getConfigs(workspaceRoot);

    if (configs.length === 0) {
      const choice = await vscode.window.showQuickPick(
        [
          { label: '$(add) Create New Connection', description: 'Set up a new server connection', value: 'new' },
          { label: '$(file-code) Open Config', description: 'Edit configuration file', value: 'config' }
        ],
        { placeHolder: 'No connections found. What would you like to do?' }
      );

      if (choice?.value === 'new') {
        await ConnectionWizard.createNewConnection(workspaceRoot);
      } else if (choice?.value === 'config') {
        await vscode.commands.executeCommand('stackerftp.config');
      }
      return;
    }

    // Show connection selector if multiple configs exist
    // Changed: Always show list if multiple configs, even if some are connected
    if (configs.length === 1) {
      const isConnected = connectionManager.isConnected(configs[0]);
      if (isConnected) {
        statusBar.info(`Already connected to ${configs[0].name || configs[0].host}`);
        return;
      }

      try {
        await connectionManager.connect(configs[0]);
        statusBar.success(`Connected to ${configs[0].name || configs[0].host}`);
        if (remoteExplorer?.refresh) {
          remoteExplorer.refresh();
        }
      } catch (error: unknown) {
        statusBar.error(`Connection failed: ${errorMessage(error)}`, true);
      }
      return;
    }

    const items = configs.map((config, index) => {
      const isConnected = connectionManager.isConnected(config);
      return {
        label: `${isConnected ? '$(play)' : '$(primitive-square)'} ${config.name || config.host}`,
        description: `${config.protocol.toUpperCase()} | ${config.username}@${config.host}:${config.port || (config.protocol === 'sftp' ? 22 : 21)}`,
        detail: isConnected ? 'Connected' : 'Click to connect',
        config,
        index
      };
    });

    const selected = await vscode.window.showQuickPick(items, {
      title: 'Select Connection',
      placeHolder: 'Choose a server to connect'
    });

    if (!selected) {return;}

    try {
      await connectionManager.connect(selected.config);
      statusBar.success(`Connected to ${selected.config.name || selected.config.host}`);
      if (remoteExplorer?.refresh) {
        remoteExplorer.refresh();
      }
    } catch (error: unknown) {
      statusBar.error(`Connection failed: ${errorMessage(error)}`, true);
    }
  });

  const disconnectCommand = vscode.commands.registerCommand('stackerftp.disconnect', async (item?: ConnectionCommandItem) => {
    // Handle disconnection from tree view
    if (item && item.config) {
      try {
        await connectionManager.disconnect(item.config);
        statusBar.success(`Disconnected: ${item.config.name || item.config.host}`);
        if (remoteExplorer?.refresh) {
          remoteExplorer.refresh();
        }
      } catch (error: unknown) {
        statusBar.error(`Disconnect failed: ${errorMessage(error)}`, true);
      }
      return;
    }

    const activeConnections = connectionManager.getActiveConnections();

    if (activeConnections.length === 0) {
      statusBar.info('No active connections');
      return;
    }

    try {
      await connectionManager.disconnect();
      statusBar.success('Disconnected from all servers');
      if (remoteExplorer?.refresh) {
        remoteExplorer.refresh();
      }
    } catch (error: unknown) {
      statusBar.error(`Disconnect failed: ${errorMessage(error)}`, true);
    }
  });

  const setProfileCommand = vscode.commands.registerCommand('stackerftp.setProfile', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {return;}

    const profiles = configManager.getAvailableProfiles(workspaceRoot);
    if (profiles.length === 0) {
      statusBar.info('No profiles configured');
      return;
    }

    const selected = await vscode.window.showQuickPick(profiles, {
      placeHolder: 'Select a profile'
    });

    if (selected) {
      configManager.setProfile(workspaceRoot, selected);
      statusBar.success(`Switched to profile: ${selected}`);
    }
  });

  // ==================== Transfer Commands ====================

  const uploadCommand = vscode.commands.registerCommand(
    'stackerftp.upload',
    async (
      uriOrResource: vscode.Uri | { resourceUri: vscode.Uri } | (vscode.Uri | { resourceUri: vscode.Uri })[],
      selectedItems?: (vscode.Uri | { resourceUri: vscode.Uri })[]
    ) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {return;}

    // VS Code context menus pass multi-selection as the second argument.
    const items = selectedItems && selectedItems.length > 0
      ? selectedItems
      : (Array.isArray(uriOrResource) ? uriOrResource : [uriOrResource]);

    if (!items || items.length === 0) {
      statusBar.error('No file selected');
      return;
    }

    // Extract local paths from items
    const localPaths: string[] = [];
    for (const item of items) {
      if (!item) {continue;}
      if ('resourceUri' in item) {
        localPaths.push(item.resourceUri.fsPath);
      } else if ('fsPath' in item) {
        localPaths.push(item.fsPath);
      }
    }

    if (localPaths.length === 0) {
      statusBar.error('No valid file selected');
      return;
    }

    // Check for active connections first
    const activeConns = connectionManager.getAllActiveConnections();

    let config: FTPConfig;
    let connection: BaseConnection;

    if (activeConns.length === 0) {
      // No active connections - use config and connect
      const activeConfig = configManager.getActiveConfig(workspaceRoot);
      if (!activeConfig) {
        statusBar.error('No ITFFTP configuration found', true);
        return;
      }
      config = activeConfig;
      connection = await connectionManager.ensureConnection(config);
    } else if (activeConns.length === 1) {
      // Single connection - use it
      config = activeConns[0].config;
      connection = activeConns[0].connection;
    } else {
      // Multiple connections - ask user or use primary
      const selected = await connectionManager.selectConnectionForTransfer('upload');
      if (!selected) {return;}
      config = selected.config;
      connection = selected.connection;
    }

    try {
      let uploadedCount = 0;
      let failedCount = 0;
      let skippedCount = 0;
      const localRoot = resolveLocalRoot(workspaceRoot, config.localPath);

      for (const localPath of localPaths) {
        try {
          const relativePath = sanitizeRelativePath(path.relative(localRoot, localPath));
          const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));

          if (fs.statSync(localPath).isDirectory()) {
            const result = await transferManager.uploadDirectory(connection, localPath, remotePath, config);
            uploadedCount += result.uploaded.length;
            failedCount += result.failed.length;
            skippedCount += result.skipped.length;
          } else {
            // Ensure remote directory exists
            const remoteDir = normalizeRemotePath(path.dirname(remotePath));
            try {
              await connection.mkdir(remoteDir);
            } catch {
              // Directory might already exist
            }
            const outcome = await transferManager.uploadFile(connection, localPath, remotePath, config);
            if (isTransferCompleted(outcome)) {
              uploadedCount++;
            } else {
              skippedCount++;
              reportSkippedTransfer('Upload', localPath, outcome);
            }
          }
        } catch (err) {
          failedCount++;
        }
      }

      if (failedCount === 0 && skippedCount === 0) {
        statusBar.success(`Uploaded: ${uploadedCount} item(s)`);
      } else {
        void vscode.window.showWarningMessage(`Uploaded: ${uploadedCount}, Skipped: ${skippedCount}, Failed: ${failedCount}`);
      }

    } catch (error: unknown) {
      statusBar.error(`Upload failed: ${errorMessage(error)}`, true);
    }
  });

  const uploadCurrentFileCommand = vscode.commands.registerCommand('stackerftp.uploadCurrentFile', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      statusBar.error('No active editor');
      return;
    }

    const localPath = editor.document.fileName;
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {return;}

    // Check for active connections first
    const activeConns = connectionManager.getAllActiveConnections();

    let config: FTPConfig;
    let connection: BaseConnection;

    if (activeConns.length === 0) {
      const activeConfig = configManager.getActiveConfig(workspaceRoot);
      if (!activeConfig) {
        statusBar.error('No ITFFTP configuration found', true);
        return;
      }
      config = activeConfig;
      connection = await connectionManager.ensureConnection(config);
    } else if (activeConns.length === 1) {
      config = activeConns[0].config;
      connection = activeConns[0].connection;
    } else {
      const selected = await connectionManager.selectConnectionForTransfer('upload');
      if (!selected) {return;}
      config = selected.config;
      connection = selected.connection;
    }

    try {
      const relativePath = sanitizeRelativePath(path.relative(resolveLocalRoot(workspaceRoot, config.localPath), localPath));
      const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));

      // Save file first if modified
      if (editor.document.isDirty) {
        const saved = await editor.document.save();
        if (!saved) {
          void vscode.window.showWarningMessage('Upload cancelled because the current file could not be saved.');
          return;
        }
      }

      // Ensure remote directory exists
      const remoteDir = normalizeRemotePath(path.dirname(remotePath));
      try {
        await connection.mkdir(remoteDir);
      } catch (error: unknown) {
        // Directory might already exist
        if (errorCode(error) !== 'EEXIST' && !errorMessage(error, '').includes('exists')) {
          logger.warn(`Failed to create directory: ${remoteDir}`, error);
        }
      }

      const outcome = await transferManager.uploadFile(connection, localPath, remotePath, config);
      if (isTransferCompleted(outcome)) {
        statusBar.success(`Uploaded: ${path.basename(localPath)}`);
      } else {
        reportSkippedTransfer('Upload', localPath, outcome);
      }
    } catch (error: unknown) {
      statusBar.error(`Upload failed: ${errorMessage(error)}`, true);
    }
  });

  const downloadCommand = vscode.commands.registerCommand('stackerftp.download', async (
    itemOrItems?: DownloadCommandItem | DownloadCommandItem[],
    selectedItems?: DownloadCommandItem[]
  ) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {return;}

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
        statusBar.error('No ITFFTP configuration found', true);
      return;
    }

    // VS Code context menus pass multi-selection as the second argument.
    const items = selectedItems && selectedItems.length > 0
      ? selectedItems
      : (Array.isArray(itemOrItems) ? itemOrItems : (itemOrItems ? [itemOrItems] : []));

    if (items.length === 0) {
      statusBar.error('No item selected. Use "Download Project" for full project download.');
      return;
    }

    try {
      const connection = await connectionManager.ensureConnection(config);
      const localRoot = resolveLocalRoot(workspaceRoot, config.localPath);

      let downloadedCount = 0;
      let failedCount = 0;
      let skippedCount = 0;
      let handledCount = 0;

      for (const itemOrResource of items) {
        if (!itemOrResource) {continue;}

        let remotePath: string;
        let localPath: string;
        let isDirectory = false;

        // Check if it's a SCM resource state (has resourceUri property)
        if ('resourceUri' in itemOrResource && itemOrResource.resourceUri) {
          // SCM resource - download from remote to this local file
          localPath = itemOrResource.resourceUri.fsPath;
          const relativePath = sanitizeRelativePath(path.relative(localRoot, localPath));
          remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));
        } else if (itemOrResource && 'fsPath' in itemOrResource) {
          // Local Explorer / editor resource - download matching remote path to selected local target
          localPath = itemOrResource.fsPath;
          const relativePath = sanitizeRelativePath(path.relative(localRoot, localPath));
          remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));

          try {
            isDirectory = fs.statSync(localPath).isDirectory();
          } catch {
            isDirectory = false;
          }
        } else if (isRemoteTreeItem(itemOrResource)) {
          // Remote explorer item
          remotePath = itemOrResource.entry.path;
          const relativePath = path.relative(config.remotePath, remotePath);
          localPath = path.join(localRoot, relativePath);
          isDirectory = itemOrResource.entry.type === 'directory' ||
            (itemOrResource.entry.type === 'symlink' && itemOrResource.entry.isSymlinkToDirectory === true);
        } else {
          // Skip invalid items
          continue;
        }

        handledCount++;

        try {
          if (isDirectory) {
            const result = await transferManager.downloadDirectory(connection, remotePath, localPath, config);
            downloadedCount += result.downloaded.length;
            failedCount += result.failed.length;
            skippedCount += result.skipped.length;
          } else {
            // Ensure local directory exists
            const localDir = path.dirname(localPath);
            if (!fs.existsSync(localDir)) {
              fs.mkdirSync(localDir, { recursive: true });
            }
            const outcome = await transferManager.downloadFile(connection, remotePath, localPath, config);
            if (isTransferCompleted(outcome)) {
              downloadedCount++;
            } else {
              skippedCount++;
              reportSkippedTransfer('Download', localPath, outcome);
            }
          }
        } catch (err) {
          failedCount++;
        }
      }

      if (handledCount === 0) {
        statusBar.error('No valid selection. Use "Download Project" for full project download.');
        return;
      }

      if (failedCount === 0 && skippedCount === 0) {
        statusBar.success(`Downloaded: ${downloadedCount} item(s)`);
      } else {
        void vscode.window.showWarningMessage(`Downloaded: ${downloadedCount}, Skipped: ${skippedCount}, Failed: ${failedCount}`);
      }
    } catch (error: unknown) {
      statusBar.error(`Download failed: ${errorMessage(error)}`, true);
    }
  });

  const downloadProjectCommand = vscode.commands.registerCommand('stackerftp.downloadProject', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {return;}

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
        statusBar.error('No ITFFTP configuration found', true);
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      'Download entire project?',
      'Yes', 'No'
    );
    if (choice !== 'Yes') {return;}

    try {
      const connection = await connectionManager.ensureConnection(config);
      const result = await transferManager.downloadDirectory(connection, config.remotePath, resolveLocalRoot(workspaceRoot, config.localPath), config);
      showSyncResult(result, 'download');
      if (result.failed.length === 0 && result.skipped.length === 0) {
        statusBar.success('Project downloaded successfully');
      }
    } catch (error: unknown) {
      statusBar.error(`Download failed: ${errorMessage(error)}`, true);
    }
  });

  // ==================== Sync Commands ====================

  const syncToRemoteCommand = vscode.commands.registerCommand('stackerftp.syncToRemote', async (uri?: vscode.Uri) => {
    await performSync('toRemote', uri);
  });

  const syncToLocalCommand = vscode.commands.registerCommand('stackerftp.syncToLocal', async (uri?: vscode.Uri) => {
    await performSync('toLocal', uri);
  });

  const syncBothWaysCommand = vscode.commands.registerCommand('stackerftp.syncBothWays', async (uri?: vscode.Uri) => {
    await performSync('both', uri);
  });

  async function performSync(direction: 'toRemote' | 'toLocal' | 'both', uri?: vscode.Uri) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {return;}

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
        statusBar.error('No ITFFTP configuration found', true);
      return;
    }

    const confirmSync = vscode.workspace.getConfiguration('stackerftp').get<boolean>('confirmSync', true);
    if (confirmSync) {
      const action = direction === 'toRemote' ? 'Local → Remote' : direction === 'toLocal' ? 'Remote → Local' : 'Both ways';
      const choice = await vscode.window.showWarningMessage(
        `Sync ${action}?`,
        { modal: true },
        'Yes', 'No'
      );
      if (choice !== 'Yes') {return;}
    }

    try {
      const connection = await connectionManager.ensureConnection(config);
      const localRoot = resolveLocalRoot(workspaceRoot, config.localPath);

      let localPath: string;
      let remotePath: string;

      if (uri) {
        localPath = uri.fsPath;
        const relativePath = sanitizeRelativePath(path.relative(localRoot, localPath));
        remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));
      } else {
        localPath = localRoot;
        remotePath = config.remotePath;
      }

      let result;
      if (direction === 'toRemote') {
        result = await transferManager.syncToRemote(connection, localPath, remotePath, config);
      } else if (direction === 'toLocal') {
        result = await transferManager.syncToLocal(connection, remotePath, localPath, config);
      } else {
        result = await transferManager.syncBothWays(connection, localPath, remotePath, config);
      }

      showSyncResult(result, direction === 'toRemote' ? 'upload' : 'download');

    } catch (error: unknown) {
      statusBar.error(`Sync failed: ${errorMessage(error)}`, true);
    }
  }

  function showSyncResult(result: SyncResult, _type: string): void {
    const messages: string[] = [];

    if (result.uploaded.length > 0) {
      messages.push(`Uploaded: ${result.uploaded.length} files`);
    }
    if (result.downloaded.length > 0) {
      messages.push(`Downloaded: ${result.downloaded.length} files`);
    }
    if (result.failed.length > 0) {
      messages.push(`Failed: ${result.failed.length} files`);
    }
    if (result.skipped.length > 0) {
      messages.push(`Skipped: ${result.skipped.length} files`);
    }

    if (messages.length > 0) {
      if (result.failed.length > 0 || result.skipped.length > 0) {
        void vscode.window.showWarningMessage(messages.join(', '));
      } else {
        statusBar.success(messages.join(', '));
      }
    }

    if (result.failed.length > 0) {
      logger.error('Sync failures', result.failed);
    }
  }

  // ==================== File Management Commands ====================

  const openRemoteFileCommand = vscode.commands.registerCommand('stackerftp.openRemoteFile', async (item: RemoteTreeItem) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {return;}

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {return;}

    try {
      const connection = await connectionManager.ensureConnection(config);
      const content = await connection.readFile(item.entry.path);

      // Create a temporary file
      const tempDir = path.join(os.tmpdir(), 'stackerftp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const tempPath = path.join(tempDir, item.entry.name);
      fs.writeFileSync(tempPath, content);

      const doc = await vscode.workspace.openTextDocument(tempPath);
      await vscode.window.showTextDocument(doc);
    } catch (error: unknown) {
      statusBar.error(`Failed to open file: ${errorMessage(error)}`);
    }
  });

  const deleteRemoteCommand = vscode.commands.registerCommand('stackerftp.deleteRemote', async (
    itemOrItems?: RemoteTreeItem | RemoteTreeItem[]
  ) => {
    // Handle both single item and array of items, filter out invalid items
    const rawItems = Array.isArray(itemOrItems) ? itemOrItems : (itemOrItems ? [itemOrItems] : []);
    const items = rawItems.filter(item => item && item.entry);

    if (items.length === 0) {
      statusBar.error('No item selected');
      return;
    }

    const names = items.map(i => i.entry.name).join(', ');
    const confirmDelete = vscode.workspace.getConfiguration('stackerftp').get<boolean>('confirmDelete', true);

    if (confirmDelete) {
      const message = items.length === 1
        ? `Delete "${items[0].entry.name}"?`
        : `Delete ${items.length} items (${names})?`;
      const choice = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        'Delete', 'Cancel'
      );
      if (choice !== 'Delete') {return;}
    }

    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {return;}

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {return;}

    try {
      const connection = await connectionManager.ensureConnection(config);

      for (const item of items) {
        if (item.entry.type === 'directory') {
          await connection.rmdir(item.entry.path, true);
        } else {
          await connection.delete(item.entry.path);
        }
      }

      statusBar.success(`Deleted: ${items.length === 1 ? items[0].entry.name : `${items.length} items`}`);

    } catch (error: unknown) {
      statusBar.error(`Delete failed: ${errorMessage(error)}`, true);
    }
  });

  const newFolderCommand = vscode.commands.registerCommand('stackerftp.newFolder', async (item?: RemoteExplorerCommandItem) => {
    const folderName = await vscode.window.showInputBox({
      prompt: 'Enter folder name',
      placeHolder: 'new-folder'
    });

    if (!folderName) {return;}

    // Get config and connection from item if available, otherwise pick from active connections
    let config: FTPConfig | undefined;
    let connection: BaseConnection | undefined;

    if (item?.config) {
      config = item.config;
      connection = item.connectionRef || connectionManager.getConnection(config);
    } else {
      // Pick from active connections
      const activeConnections = connectionManager.getAllActiveConnections();
      if (activeConnections.length === 0) {
        statusBar.error('No active connection. Connect first.');
        return;
      } else if (activeConnections.length === 1) {
        config = activeConnections[0].config;
        connection = activeConnections[0].connection;
      } else {
        const selected = await vscode.window.showQuickPick(
          activeConnections.map(c => ({ label: c.config.name || c.config.host, config: c.config, connection: c.connection })),
          { placeHolder: 'Select connection for new folder' }
        );
        if (!selected) {return;}
        config = selected.config;
        connection = selected.connection;
      }
    }

    if (!connection || !config) {
      statusBar.error('No active connection');
      return;
    }

    try {
      let parentPath: string;
      if (item && 'entry' in item && item.entry.type === 'directory') {
        parentPath = item.entry.path;
      } else if (item && 'entry' in item) {
        parentPath = path.dirname(item.entry.path);
      } else {
        parentPath = config.remotePath || '/';
      }

      const newPath = normalizeRemotePath(path.join(parentPath, folderName));
      await connection.mkdir(newPath);

      statusBar.success(`Created folder: ${folderName}`);
      remoteExplorer?.refreshAfterOperation();

    } catch (error: unknown) {
      statusBar.error(`Failed to create folder: ${errorMessage(error)}`, true);
    }
  });

  const newFileCommand = vscode.commands.registerCommand('stackerftp.newFile', async (item?: RemoteExplorerCommandItem) => {
    const fileName = await vscode.window.showInputBox({
      prompt: 'Enter file name',
      placeHolder: 'new-file.txt'
    });

    if (!fileName) {return;}

    // Get config and connection from item if available, otherwise pick from active connections
    let config: FTPConfig | undefined;
    let connection: BaseConnection | undefined;

    if (item?.config) {
      config = item.config;
      connection = item.connectionRef || connectionManager.getConnection(config);
    } else {
      // Pick from active connections
      const activeConnections = connectionManager.getAllActiveConnections();
      if (activeConnections.length === 0) {
        statusBar.error('No active connection. Connect first.');
        return;
      } else if (activeConnections.length === 1) {
        config = activeConnections[0].config;
        connection = activeConnections[0].connection;
      } else {
        const selected = await vscode.window.showQuickPick(
          activeConnections.map(c => ({ label: c.config.name || c.config.host, config: c.config, connection: c.connection })),
          { placeHolder: 'Select connection for new file' }
        );
        if (!selected) {return;}
        config = selected.config;
        connection = selected.connection;
      }
    }

    if (!connection || !config) {
      statusBar.error('No active connection');
      return;
    }

    try {
      let parentPath: string;
      if (item && 'entry' in item && item.entry.type === 'directory') {
        parentPath = item.entry.path;
      } else if (item && 'entry' in item) {
        parentPath = path.dirname(item.entry.path);
      } else {
        parentPath = config.remotePath || '/';
      }

      const newPath = normalizeRemotePath(path.join(parentPath, fileName));
      await connection.writeFile(newPath, '');

      statusBar.success(`Created file: ${fileName}`);
      remoteExplorer?.refreshAfterOperation();

    } catch (error: unknown) {
      statusBar.error(`Failed to create file: ${errorMessage(error)}`, true);
    }
  });

  const openTransferForLegacyTreeCommand = async (action: string): Promise<void> => {
    const scope = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!scope || !settingsPanel) {
      void vscode.window.showWarningMessage('Open a workspace to use Transfer.');
      return;
    }
    settingsPanel.open(scope);
    void vscode.window.showInformationMessage(
      `${action} belongs to the retired Remote Explorer tree. Use the folder controls in Transfer.`
    );
  };

  const expandAllCommand = vscode.commands.registerCommand(
    'stackerftp.expandAll',
    () => openTransferForLegacyTreeCommand('Expand All')
  );
  const collapseAllCommand = vscode.commands.registerCommand(
    'stackerftp.collapseAll',
    () => openTransferForLegacyTreeCommand('Collapse All')
  );
  const expandConnectionCommand = vscode.commands.registerCommand(
    'stackerftp.expandConnection',
    () => openTransferForLegacyTreeCommand('Expand')
  );
  const collapseConnectionCommand = vscode.commands.registerCommand(
    'stackerftp.collapseConnection',
    () => openTransferForLegacyTreeCommand('Collapse')
  );

  const renameCommand = vscode.commands.registerCommand('stackerftp.rename', async (item?: RemoteFileCommandItem) => {
    if (!item?.entry) {
      statusBar.error('No item selected');
      return;
    }

    const newName = await vscode.window.showInputBox({
      prompt: 'Enter new name',
      value: item.entry.name
    });

    if (!newName || newName === item.entry.name) {return;}

    // Get config and connection from item
    const config = item.config;
    const connection = item.connectionRef || connectionManager.getConnection(config);

    if (!connection || !config) {
      statusBar.error('No active connection');
      return;
    }

    try {
      const newPath = normalizeRemotePath(path.join(path.dirname(item.entry.path), newName));

      await connection.rename(item.entry.path, newPath);
      statusBar.success(`Renamed to: ${newName}`);
      remoteExplorer?.refreshAfterOperation();

    } catch (error: unknown) {
      statusBar.error(`Rename failed: ${errorMessage(error)}`, true);
    }
  });

  const duplicateCommand = vscode.commands.registerCommand('stackerftp.duplicate', async (item?: RemoteFileCommandItem) => {
    if (!item?.entry) {
      statusBar.error('No item selected');
      return;
    }

    // Get config and connection from item
    const config = item.config;
    const connection = item.connectionRef || connectionManager.getConnection(config);

    if (!connection || !config) {
      statusBar.error('No active connection');
      return;
    }

    try {
      const content = await connection.readFile(item.entry.path);

      const ext = path.extname(item.entry.name);
      const base = path.basename(item.entry.name, ext);
      const newName = `${base}_copy${ext}`;
      const newPath = normalizeRemotePath(path.join(path.dirname(item.entry.path), newName));

      await connection.writeFile(newPath, content);
      statusBar.success(`Duplicated: ${newName}`);
      remoteExplorer?.refreshAfterOperation();

    } catch (error: unknown) {
      statusBar.error(`Duplicate failed: ${errorMessage(error)}`, true);
    }
  });

  const refreshCommand = vscode.commands.registerCommand('stackerftp.refresh', () => {
    if (remoteExplorer?.refresh) {
      remoteExplorer.refresh();
      logger.info('Remote explorer refreshed');
    }
  });

  // ==================== Utility Commands ====================

  const diffCommand = vscode.commands.registerCommand('stackerftp.diff', async (firstArg?: unknown, secondArg?: unknown) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {return;}

    try {
      // A view/item context menu passes the TreeItem as the first argument,
      // while Explorer/editor context menus pass a Uri. Keep accepting an
      // optional second argument for callers that provide both explicitly.
      const item = isRemoteTreeItem(firstArg) ? firstArg : isRemoteTreeItem(secondArg) ? secondArg : undefined;
      const uri = item
        ? undefined
        : (hasFsPath(firstArg) ? firstArg : hasFsPath(secondArg) ? secondArg : undefined);

      let localPath: string;
      let remotePath: string;
      let fileName: string;
      let activeConfig: FTPConfig;

      if (item && item.entry) {
        // Called from remote explorer - use item's config
        activeConfig = item.config;
        if (!activeConfig) {
          statusBar.error('No configuration found for this connection');
          return;
        }
        remotePath = item.entry.path;
        if (!remotePath) {
          statusBar.error('Remote path is undefined');
          return;
        }
        fileName = item.entry.name || path.basename(remotePath);

        // Calculate relative path from remote root
        const remoteRoot = activeConfig.remotePath || '/';
        let relativePath = remotePath;
        if (remotePath.startsWith(remoteRoot)) {
          relativePath = remotePath.substring(remoteRoot.length);
        }
        // Remove leading slash
        if (relativePath.startsWith('/')) {
          relativePath = relativePath.substring(1);
        }
        localPath = path.join(resolveLocalRoot(workspaceRoot, activeConfig.localPath), relativePath);
      } else if (uri) {
        // Called from local file
        const config = configManager.getActiveConfig(workspaceRoot);
        if (!config) {
        statusBar.error('No ITFFTP configuration found', true);
          return;
        }
        activeConfig = config;
        localPath = uri.fsPath;
        const relativePath = sanitizeRelativePath(path.relative(resolveLocalRoot(workspaceRoot, activeConfig.localPath), localPath));
        remotePath = normalizeRemotePath(path.posix.join(activeConfig.remotePath, relativePath.replace(/\\/g, '/')));
        fileName = path.basename(localPath);
      } else {
        statusBar.error('No file selected');
        return;
      }

      // Check if local file exists
      if (!fs.existsSync(localPath)) {
        statusBar.error(`Local file not found: ${fileName}. Download the file first to compare.`);
        return;
      }

      // Download remote file to temp
      const connection = await connectionManager.ensureConnection(activeConfig);
      const tempDir = path.join(os.tmpdir(), 'stackerftp-diff');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      const tempRemotePath = path.join(tempDir, `${Date.now()}-${fileName}.remote`);

      await connection.download(remotePath, tempRemotePath);

      // Show diff
      const localUri = vscode.Uri.file(localPath);
      const remoteUri = vscode.Uri.file(tempRemotePath);

      await vscode.commands.executeCommand('vscode.diff', remoteUri, localUri,
        `${fileName} (Remote) ↔ ${fileName} (Local)`,
        { preview: true }
      );

      logger.info(`Diff shown for ${fileName}`);
    } catch (error: unknown) {
      statusBar.error(`Diff failed: ${errorMessage(error)}`);
    }
  });

  const terminalCommand = vscode.commands.registerCommand('stackerftp.terminal', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {return;}

    // Get active connections
    const activeConns = connectionManager.getAllActiveConnections();

    let targetConfig: FTPConfig | undefined;

    if (activeConns.length === 0) {
      // No active connections - check if we have configured connections
      const configs = configManager.getConfigs(workspaceRoot);
      if (configs.length === 0) {
        statusBar.error('No configurations found');
        return;
      }

      // Prompt to select a config to connect and open terminal
      const items = configs.map(c => ({
        label: c.name || c.host,
        description: `${c.protocol.toUpperCase()} • ${c.username}@${c.host}`,
        config: c
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a server to connect and open terminal'
      });

      if (!selected) {return;}

      try {
        await connectionManager.connect(selected.config);
        targetConfig = selected.config;
      } catch (error: unknown) {
        statusBar.error(`Connection failed: ${errorMessage(error)}`);
        return;
      }
    } else if (activeConns.length === 1) {
      // Single active connection
      targetConfig = activeConns[0].config;
    } else {
      // Multiple active connections - prompt to select
      const primaryConfig = connectionManager.getPrimaryConfig();

      const items = activeConns.map(({ config }) => {
        const isPrimary = primaryConfig && config.name === primaryConfig.name && config.host === primaryConfig.host;
        return {
          label: isPrimary ? `$(star-full) ${config.name || config.host}` : (config.name || config.host),
          description: `${config.protocol.toUpperCase()} • ${config.username}@${config.host}`,
          detail: isPrimary ? 'Primary Connection' : '',
          config
        };
      });

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select connection for terminal'
      });

      if (!selected) {return;}
      targetConfig = selected.config;
    }

    if (!targetConfig) {return;}

    if (targetConfig.protocol !== 'sftp') {
      statusBar.error('Remote terminal is only available with SFTP protocol');
      return;
    }

    const terminal = vscode.window.createTerminal({
      name: `ITFFTP: ${targetConfig.name || targetConfig.host}`,
      shellPath: 'ssh',
      shellArgs: [
        '-p', String(targetConfig.port || 22),
        `${targetConfig.username}@${targetConfig.host}`
      ]
    });

    terminal.show();
  });

  const viewLogsCommand = vscode.commands.registerCommand('stackerftp.viewLogs', () => {
    logger.show();
  });

  const clearLogsCommand = vscode.commands.registerCommand('stackerftp.clearLogs', () => {
    logger.clear();
    statusBar.success('Logs cleared');
  });

  const cancelTransferCommand = vscode.commands.registerCommand('stackerftp.cancelTransfer', () => {
    transferManager.cancel();
    statusBar.success('All transfers cancelled');
  });

  // The native queue view is retired; show the live queue as a Quick Pick.
  const showTransferQueueCommand = vscode.commands.registerCommand('stackerftp.showTransferQueue', async () => {
    await vscode.commands.executeCommand('stackerftp.transferQueue');
  });

  // Cancel specific transfer item
  const cancelTransferItemCommand = vscode.commands.registerCommand('stackerftp.cancelTransferItem', (item?: TransferTreeItem) => {
    if (item && item.transferItem) {
      transferManager.cancelItem(item.transferItem.id);
      statusBar.success(`Cancelled: ${path.basename(item.transferItem.localPath)}`);
    }
  });

  // Retry failed transfer items
  const retryTransferItemCommand = vscode.commands.registerCommand('stackerftp.retryTransferItem', (
    item?: TransferTreeItem,
    selectedItems?: TransferTreeItem[]
  ) => {
    const items = selectedItems && selectedItems.length > 0
      ? selectedItems
      : (item ? [item] : []);

    const retryableIds = items
      .filter(queueItem => queueItem?.transferItem?.status === 'error')
      .map(queueItem => queueItem.transferItem.id);

    if (retryableIds.length === 0) {
      statusBar.warn('No failed transfers selected');
      return;
    }

    const retriedCount = transferManager.retryItems(retryableIds);
    if (retriedCount === 0) {
      statusBar.warn('No failed transfers were re-queued');
      return;
    }

    statusBar.success(`Retried: ${retriedCount} transfer${retriedCount > 1 ? 's' : ''}`);
  });

  // Clear completed/error transfers
  const clearTransferQueueCommand = vscode.commands.registerCommand('stackerftp.clearTransferQueue', () => {
    transferManager.clearCompleted();
    statusBar.success('Queue cleared');
  });

  // Legacy quick pick for transfer queue (backwards compatibility)
  const transferQueueCommand = vscode.commands.registerCommand('stackerftp.transferQueue', () => {
    const queue = transferManager.getQueue();
    if (queue.length === 0) {
      statusBar.success('Transfer queue is empty');
      return;
    }

    const items = queue.map(item => ({
      label: `${item.direction === 'upload' ? '$(arrow-up)' : '$(arrow-down)'} ${path.basename(item.localPath)}`,
      description: `${item.status} - ${Math.round(item.progress)}%`,
      item
    }));

    vscode.window.showQuickPick(items, {
      title: `Transfer Queue (${queue.length} items)`
    });
  });

  // ==================== Connection Wizard Commands ====================

  const newConnectionCommand = vscode.commands.registerCommand('stackerftp.newConnection', async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      statusBar.error('Open a workspace before creating a connection');
      return;
    }
    settingsPanel?.open(workspaceFolder.uri);
  });

  // ==================== Git Integration Commands ====================

  const uploadChangedFilesCommand = vscode.commands.registerCommand('stackerftp.uploadChangedFiles', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {return;}

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      statusBar.error('No ITFFTP configuration found', true);
      return;
    }

    const gitIntegration = createGitIntegration(workspaceRoot);

    if (!gitIntegration.isGitRepository()) {
      statusBar.error('Not a Git repository');
      return;
    }

    try {
      const changedFiles = await gitIntegration.getChangedFiles();
      const uploadableFiles = gitIntegration.filterUploadable(changedFiles);

      if (uploadableFiles.length === 0) {
        statusBar.success('No changed files to upload');
        return;
      }

      const choice = await vscode.window.showQuickPick(
        [
          { label: `$(cloud-upload) Upload All (${uploadableFiles.length} files)`, value: 'all' },
          { label: '$(list-selection) Select Files...', value: 'select' }
        ],
        { placeHolder: `${uploadableFiles.length} changed files found` }
      );

      if (!choice) {return;}

      let filesToUpload = uploadableFiles;

      if (choice.value === 'select') {
        const selected = await vscode.window.showQuickPick(
          uploadableFiles.map(f => ({
            label: `$(${f.status === 'added' ? 'add' : 'edit'}) ${f.path}`,
            description: f.status,
            file: f,
            picked: true
          })),
          {
            placeHolder: 'Select files to upload',
            canPickMany: true
          }
        );

        if (!selected || selected.length === 0) {return;}
        filesToUpload = selected.map(s => s.file);
      }

      const connection = await connectionManager.ensureConnection(config);

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Uploading changed files...',
        cancellable: true
      }, async (progress, token) => {
        let uploaded = 0;
        const total = filesToUpload.length;

        for (const file of filesToUpload) {
          if (token.isCancellationRequested) {break;}

          const relativePath = sanitizeRelativePath(path.relative(workspaceRoot, file.absolutePath));
          const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));

          progress.report({
            message: `${uploaded + 1}/${total}: ${path.basename(file.path)}`,
            increment: 100 / total
          });

          try {
            const remoteDir = normalizeRemotePath(path.dirname(remotePath));
            try {
              await connection.mkdir(remoteDir);
            } catch { /* Directory may already exist. */ }

            const outcome = await transferManager.uploadFile(connection, file.absolutePath, remotePath, config);
            if (isTransferCompleted(outcome)) {
              uploaded++;
            } else {
              reportSkippedTransfer('Upload', file.absolutePath, outcome);
            }
          } catch (error: unknown) {
            logger.error(`Failed to upload ${file.path}`, error);
          }
        }

        if (uploaded === total) {
          statusBar.success(`Uploaded ${uploaded}/${total} changed files`);
        } else {
          void vscode.window.showWarningMessage(`Uploaded ${uploaded}/${total} changed files; remaining files were skipped or failed`);
        }
      });

    } catch (error: unknown) {
      statusBar.error(`Upload failed: ${errorMessage(error)}`);
    }
  });

  const uploadProjectCommand = vscode.commands.registerCommand('stackerftp.uploadProject', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {return;}

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      statusBar.error('No ITFFTP configuration found', true);
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      'Upload entire project to remote? This may overwrite remote files.',
      { modal: true },
      'Yes', 'No'
    );

    if (choice !== 'Yes') {return;}

    try {
      const connection = await connectionManager.ensureConnection(config);
      const result = await transferManager.uploadDirectory(connection, resolveLocalRoot(workspaceRoot, config.localPath), config.remotePath, config);

      if (result.failed.length > 0 || result.skipped.length > 0) {
        void vscode.window.showWarningMessage(`Project uploaded: ${result.uploaded.length} files (${result.skipped.length} skipped, ${result.failed.length} failed)`);
      } else {
        statusBar.success(`Project uploaded: ${result.uploaded.length} files`);
      }
    } catch (error: unknown) {
      statusBar.error(`Upload project failed: ${errorMessage(error)}`);
    }
  });

  // ==================== List Commands ====================

  const listCommand = vscode.commands.registerCommand('stackerftp.list', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {return;}

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      statusBar.error('No ITFFTP configuration found', true);
      return;
    }

    try {
      const connection = await connectionManager.ensureConnection(config);
      const entries = await connection.list(config.remotePath);

      const items = entries.map(e => ({
        label: `$(${e.type === 'directory' ? 'folder' : 'file'}) ${e.name}`,
        description: e.type === 'file' ? formatFileSize(e.size) : '',
        detail: e.path,
        entry: e
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `${entries.length} items in ${config.remotePath}`
      });

      if (selected && selected.entry.type === 'file') {
        // Download and open
        const relativePath = path.relative(config.remotePath, selected.entry.path);
        const localPath = path.join(resolveLocalRoot(workspaceRoot, config.localPath), relativePath);
        const localDir = path.dirname(localPath);

        if (!fs.existsSync(localDir)) {
          fs.mkdirSync(localDir, { recursive: true });
        }

        const outcome = await transferManager.downloadFile(connection, selected.entry.path, localPath, config);
        if (!isTransferCompleted(outcome)) {
          reportSkippedTransfer('Download', localPath, outcome);
          return;
        }
        const doc = await vscode.workspace.openTextDocument(localPath);
        await vscode.window.showTextDocument(doc);
      }
    } catch (error: unknown) {
      statusBar.error(`List failed: ${errorMessage(error)}`);
    }
  });

  const listAllCommand = vscode.commands.registerCommand('stackerftp.listAll', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {return;}

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      statusBar.error('No ITFFTP configuration found', true);
      return;
    }

    try {
      const connection = await connectionManager.ensureConnection(config);
      const allFiles: FileEntry[] = [];
      const configuredConcurrency = vscode.workspace.getConfiguration('stackerftp').get<number>('transferConcurrency', 4);
      const concurrency = config.protocol === 'sftp'
        ? 1
        : Math.min(10, Math.max(1, Math.round(configuredConcurrency)));
      const workerConnections = new Map<number, BaseConnection>([[0, connection]]);
      const closedWorkers = new Set<BaseConnection>();

      const connectionForWorker = async (workerIndex: number): Promise<BaseConnection> => {
        const existing = workerConnections.get(workerIndex);
        if (existing) {return existing;}
        const pooled = await connectionManager.getStrictPooledConnection(config);
        workerConnections.set(workerIndex, pooled);
        return pooled;
      };

      try {
        const traversal = await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: 'Scanning remote files...',
          cancellable: true
        }, async (progress, token) => runBoundedRecursiveScan<FileEntry[]>({
          startDirectory: config.remotePath,
          concurrency,
          isCancelled: () => token.isCancellationRequested,
          scanDirectory: async (directory, workerIndex) => {
            const worker = await connectionForWorker(workerIndex);
            let entries: FileEntry[];
            try {
              entries = await worker.list(directory);
            } catch (error) {
              if (worker !== connection && isConnectionClosedError(error)) {closedWorkers.add(worker);}
              throw error;
            }
            return {
              childDirectories: entries
                .filter(entry => entry.type === 'directory' && !entry.name.startsWith('.'))
                .map(entry => entry.path),
              value: entries.filter(entry => entry.type === 'file')
            };
          },
          onBatch: (entries, scanProgress) => {
            const files = entries.flatMap(entry => entry.value);
            if (allFiles.length + files.length > MAX_REMOTE_LIST_FILES) {
              throw new Error(
                `Remote file scan exceeded the maximum file count of ${MAX_REMOTE_LIST_FILES}. Choose a narrower remote folder.`
              );
            }
            allFiles.push(...files);
            progress.report({
              message: `${allFiles.length} file(s); ${scanProgress.visitedDirectories} folder(s) scanned; ${scanProgress.pendingDirectories} pending`
            });
          }
        }));

        if (traversal.cancelled) {
          void vscode.window.showInformationMessage('Remote file scan cancelled.');
          return;
        }
      } finally {
        const pooledWorkers = [...workerConnections.values()].filter(worker => worker !== connection);
        await Promise.allSettled(pooledWorkers.map(async worker => {
          if (closedWorkers.has(worker)) {
            await connectionManager.discardPooledConnection(config, worker);
          } else {
            connectionManager.releasePooledConnection(config, worker);
          }
        }));
      }

      const items = allFiles.map(e => ({
        label: `$(file) ${path.basename(e.name)}`,
        description: formatFileSize(e.size),
        detail: e.path,
        entry: e
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `${allFiles.length} files found`,
        matchOnDetail: true
      });

      if (selected) {
        const relativePath = path.relative(config.remotePath, selected.entry.path);
        const localPath = path.join(resolveLocalRoot(workspaceRoot, config.localPath), relativePath);
        const localDir = path.dirname(localPath);

        if (!fs.existsSync(localDir)) {
          fs.mkdirSync(localDir, { recursive: true });
        }

        const outcome = await transferManager.downloadFile(connection, selected.entry.path, localPath, config);
        if (!isTransferCompleted(outcome)) {
          reportSkippedTransfer('Download', localPath, outcome);
          return;
        }
        const doc = await vscode.workspace.openTextDocument(localPath);
        await vscode.window.showTextDocument(doc);
      }
    } catch (error: unknown) {
      void vscode.window.showErrorMessage(`List all failed: ${errorMessage(error)}`);
    }
  });

  // ==================== Refresh Active File ====================

  const refreshActiveFileCommand = vscode.commands.registerCommand('stackerftp.refreshActiveFile', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {return;}

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      statusBar.error('No ITFFTP configuration found', true);
      return;
    }

    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
      statusBar.error('No active file');
      return;
    }

    const localPath = activeEditor.document.fileName;
    const localRoot = resolveLocalRoot(workspaceRoot, config.localPath);
    const localRelation = path.relative(localRoot, localPath);
    if (localRelation === '..' || localRelation.startsWith(`..${path.sep}`) || path.isAbsolute(localRelation)) {
      statusBar.error('File is not in workspace');
      return;
    }

    try {
      const connection = await connectionManager.ensureConnection(config);
      const relativePath = sanitizeRelativePath(localRelation);
      const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));

      const outcome = await transferManager.downloadFile(connection, remotePath, localPath, config);
      if (!isTransferCompleted(outcome)) {
        reportSkippedTransfer('Download', localPath, outcome);
        return;
      }

      // Reload the document
      const doc = await vscode.workspace.openTextDocument(localPath);
      await vscode.window.showTextDocument(doc);

      statusBar.success(`Refreshed: ${path.basename(localPath)}`);
    } catch (error: unknown) {
      statusBar.error(`Refresh failed: ${errorMessage(error)}`);
    }
  });

  // ==================== Remote-to-Remote Transfer ====================

  const copyToOtherRemoteCommand = vscode.commands.registerCommand('stackerftp.copyToOtherRemote', async (item?: RemoteTreeItem) => {
    if (!item || !item.entry) {
      statusBar.error('No file selected');
      return;
    }

    const sourceConfig = item.config;
    const activeConnections = connectionManager.getAllActiveConnections();

    // Filter out the source connection
    const otherConnections = activeConnections.filter(c =>
      c.config.host !== sourceConfig.host || c.config.username !== sourceConfig.username
    );

    if (otherConnections.length === 0) {
      statusBar.warn('No other remote connections available. Connect to another server first.');
      return;
    }

    // Let user select target connection
    const targetItems = otherConnections.map(c => ({
      label: c.config.name || c.config.host,
      description: `${c.config.protocol.toUpperCase()} · ${c.config.username}@${c.config.host}`,
      config: c.config,
      connection: c.connection
    }));

    const selected = await vscode.window.showQuickPick(targetItems, {
      placeHolder: 'Select target remote server'
    });

    if (!selected) {return;}

    // Ask for target path
    const targetPath = await vscode.window.showInputBox({
      prompt: 'Enter target path',
      value: path.join(selected.config.remotePath, path.basename(item.entry.path)),
      placeHolder: '/remote/path/filename'
    });

    if (!targetPath) {return;}

    try {
      const sourceConnection = connectionManager.getConnection(sourceConfig);
      if (!sourceConnection) {
        statusBar.error('Source connection not available');
        return;
      }

      // Create temp file
      const tempDir = path.join(os.tmpdir(), 'stackerftp-transfer');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      const tempPath = path.join(tempDir, path.basename(item.entry.path));

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Transferring ${item.entry.name}...`,
        cancellable: false
      }, async (progress) => {
        // Step 1: Download from source
        progress.report({ message: 'Downloading from source...', increment: 0 });
        await sourceConnection.download(item.entry.path, tempPath);

        // Step 2: Upload to target
        progress.report({ message: 'Uploading to target...', increment: 50 });
        await selected.connection.upload(tempPath, targetPath);

        // Step 3: Cleanup
        progress.report({ message: 'Cleaning up...', increment: 90 });
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      });

      statusBar.success(`Transferred ${item.entry.name} to ${selected.config.name || selected.config.host}`);

      remoteExplorer?.refreshAfterOperation();

    } catch (error: unknown) {
      statusBar.error(`Transfer failed: ${errorMessage(error)}`);
    }
  });

  const compareRemotesCommand = vscode.commands.registerCommand('stackerftp.compareRemotes', async (item?: RemoteTreeItem) => {
    if (!item || !item.entry || item.entry.type !== 'file') {
      statusBar.error('Select a file to compare');
      return;
    }

    const sourceConfig = item.config;
    const activeConnections = connectionManager.getAllActiveConnections();

    const otherConnections = activeConnections.filter(c =>
      c.config.host !== sourceConfig.host || c.config.username !== sourceConfig.username
    );

    if (otherConnections.length === 0) {
      statusBar.warn('No other remote connections available. Connect to another server first.');
      return;
    }
    const targetItems = otherConnections.map(c => ({
      label: c.config.name || c.config.host,
      description: `${c.config.protocol.toUpperCase()} · ${c.config.username}@${c.config.host}`,
      config: c.config,
      connection: c.connection
    }));

    const selected = await vscode.window.showQuickPick(targetItems, {
      placeHolder: 'Select remote server to compare with'
    });

    if (!selected) {return;}

    // Ask for target file path
    const targetPath = await vscode.window.showInputBox({
      prompt: 'Enter file path on target server',
      value: item.entry.path,
      placeHolder: '/remote/path/filename'
    });

    if (!targetPath) {return;}

    try {
      const sourceConnection = connectionManager.getConnection(sourceConfig);
      if (!sourceConnection) {
        statusBar.error('Source connection not available');
        return;
      }

      const tempDir = path.join(os.tmpdir(), 'stackerftp-compare');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const sourceFileName = `${sourceConfig.host}_${path.basename(item.entry.path)}`;
      const targetFileName = `${selected.config.host}_${path.basename(targetPath)}`;

      const sourceTempPath = path.join(tempDir, sourceFileName);
      const targetTempPath = path.join(tempDir, targetFileName);

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Downloading files for comparison...',
        cancellable: false
      }, async (progress) => {
        progress.report({ message: `Downloading from ${sourceConfig.host}...`, increment: 0 });
        await sourceConnection.download(item.entry.path, sourceTempPath);

        progress.report({ message: `Downloading from ${selected.config.host}...`, increment: 50 });
        await selected.connection.download(targetPath, targetTempPath);
      });

      // Open diff view
      const sourceUri = vscode.Uri.file(sourceTempPath);
      const targetUri = vscode.Uri.file(targetTempPath);

      await vscode.commands.executeCommand('vscode.diff',
        sourceUri,
        targetUri,
        `${sourceConfig.host} ↔ ${selected.config.host}: ${path.basename(item.entry.path)}`
      );

    } catch (error: unknown) {
      statusBar.error(`Compare failed: ${errorMessage(error)}`);
    }
  });

  const syncBetweenRemotesCommand = vscode.commands.registerCommand('stackerftp.syncBetweenRemotes', async (item?: RemoteTreeItem) => {
    if (!item || !item.entry || item.entry.type !== 'directory') {
      statusBar.error('Select a folder to sync');
      return;
    }

    const sourceConfig = item.config;
    const activeConnections = connectionManager.getAllActiveConnections();

    const otherConnections = activeConnections.filter(c =>
      c.config.host !== sourceConfig.host || c.config.username !== sourceConfig.username
    );

    if (otherConnections.length === 0) {
      statusBar.warn('No other remote connections available. Connect to another server first.');
      return;
    }

    const targetItems = otherConnections.map(c => ({
      label: c.config.name || c.config.host,
      description: `${c.config.protocol.toUpperCase()} · ${c.config.username}@${c.config.host}`,
      config: c.config,
      connection: c.connection
    }));

    const selected = await vscode.window.showQuickPick(targetItems, {
      placeHolder: 'Select target remote server for sync'
    });

    if (!selected) {return;}

    const targetPath = await vscode.window.showInputBox({
      prompt: 'Enter target folder path',
      value: item.entry.path,
      placeHolder: '/remote/path/folder'
    });

    if (!targetPath) {return;}

    const confirm = await vscode.window.showWarningMessage(
      `Sync folder "${item.entry.name}" from ${sourceConfig.host} to ${selected.config.host}?`,
      { modal: true },
      'Sync'
    );

    if (confirm !== 'Sync') {return;}

    try {
      const sourceConnection = connectionManager.getConnection(sourceConfig);
      if (!sourceConnection) {
        statusBar.error('Source connection not available');
        return;
      }

      // Get file list from source
      const sourceFiles = await sourceConnection.list(item.entry.path);
      const files = sourceFiles.filter(f => f.type === 'file');

      const tempDir = path.join(os.tmpdir(), 'stackerftp-sync', Date.now().toString());
      fs.mkdirSync(tempDir, { recursive: true });

      let transferred = 0;
      const total = files.length;

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Syncing ${total} files...`,
        cancellable: true
      }, async (progress, token) => {
        for (const file of files) {
          if (token.isCancellationRequested) {break;}

          const fileName = file.name;
          const sourcePath = file.path;
          const tempPath = path.join(tempDir, fileName);
          const destPath = normalizeRemotePath(path.join(targetPath, fileName));

          progress.report({
            message: `${fileName} (${transferred + 1}/${total})`,
            increment: (1 / total) * 100
          });

          try {
            await sourceConnection.download(sourcePath, tempPath);
            await selected.connection.upload(tempPath, destPath);
            transferred++;
          } catch (err) {
            logger.error(`Failed to sync ${fileName}`, err);
          }
        }

        // Cleanup temp dir
        fs.rmSync(tempDir, { recursive: true, force: true });
      });

      statusBar.success(`Synced ${transferred}/${total} files to ${selected.config.host}`);

      remoteExplorer?.refreshAfterOperation();

    } catch (error: unknown) {
      statusBar.error(`Sync failed: ${errorMessage(error)}`);
    }
  });

  // ==================== Reveal in Remote Explorer ====================

  const revealInRemoteExplorerCommand = vscode.commands.registerCommand('stackerftp.revealInRemoteExplorer', async (uri?: vscode.Uri) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {return;}

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      statusBar.error('No ITFFTP configuration found', true);
      return;
    }

    // Get file path from URI or active editor
    let localPath: string | undefined;
    if (uri) {
      localPath = uri.fsPath;
    } else if (vscode.window.activeTextEditor) {
      localPath = vscode.window.activeTextEditor.document.fileName;
    }

    if (!localPath) {
      statusBar.error('No file selected');
      return;
    }

    const localRoot = resolveLocalRoot(workspaceRoot, config.localPath);
    const localRelation = path.relative(localRoot, localPath);
    if (localRelation === '..' || localRelation.startsWith(`..${path.sep}`) || path.isAbsolute(localRelation)) {
      statusBar.error('File is not in workspace');
      return;
    }

    try {
      const relativePath = sanitizeRelativePath(localRelation);
      const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));
      if (!settingsPanel) {
        void vscode.window.showWarningMessage(`Transfer is unavailable. Remote path: ${remotePath}`);
        return;
      }
      settingsPanel.open(vscode.Uri.file(workspaceRoot));
      void vscode.window.showInformationMessage(
        `Opened Transfer. The retired Remote Explorer path maps to: ${remotePath}`
      );
    } catch (error: unknown) {
      statusBar.error(`Reveal failed: ${errorMessage(error)}`);
    }
  });

  const switchProtocolCommand = vscode.commands.registerCommand('stackerftp.switchProtocol', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {return;}

    await ConnectionWizard.switchProtocol(workspaceRoot);
  });

  const quickConnectCommand = vscode.commands.registerCommand('stackerftp.quickConnect', async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {return;}

    const configs = configManager.getConfigs(workspaceRoot);

    if (configs.length === 0) {
      const choice = await vscode.window.showQuickPick(
        [
          { label: '$(add) Create New Connection', description: 'Set up a new server connection', value: 'new' },
          { label: '$(file-code) Open Config', description: 'Edit configuration file', value: 'config' }
        ],
        { placeHolder: 'No connections found. What would you like to do?' }
      );

      if (choice?.value === 'new') {
        await ConnectionWizard.createNewConnection(workspaceRoot);
      } else if (choice?.value === 'config') {
        await vscode.commands.executeCommand('stackerftp.config');
      }
      return;
    }

    // Show connection selector
    const items = configs.map(config => {
      const isConnected = connectionManager.isConnected(config);
      return {
        label: `${isConnected ? '$(play)' : '$(primitive-square)'} ${config.name || config.host}`,
        description: `${config.protocol.toUpperCase()} | ${config.username}@${config.host}:${config.port}`,
        detail: isConnected ? 'Connected' : 'Disconnected',
        config
      };
    });

    const selected = await vscode.window.showQuickPick(items, {
      title: 'Select Connection',
      placeHolder: 'Choose a connection to connect/disconnect'
    });

    if (!selected) {return;}

    if (connectionManager.isConnected(selected.config)) {
      await connectionManager.disconnect(selected.config);
      // Disconnected message shown by connection-manager
    } else {
      try {
        await connectionManager.connect(selected.config);
        // Connected message shown by connection-manager
      } catch (error: unknown) {
        statusBar.error(`Connection failed: ${errorMessage(error)}`, true);
      }
    }
  });

  // ==================== Upload/Download Extended Commands ====================

  const uploadToAllProfilesCommand = vscode.commands.registerCommand('stackerftp.uploadToAllProfiles', async (uri: vscode.Uri, selectedItems?: vscode.Uri[]) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {return;}

    const configs = configManager.getConfigs(workspaceRoot);
    if (configs.length === 0) {
      statusBar.error('No ITFFTP configurations found', true);
      return;
    }

    const localPaths = selectedItems && selectedItems.length > 0
      ? selectedItems.map(item => item.fsPath).filter(Boolean)
      : (uri?.fsPath ? [uri.fsPath] : (vscode.window.activeTextEditor?.document.fileName ? [vscode.window.activeTextEditor.document.fileName] : []));

    if (localPaths.length === 0) {
      statusBar.error('No file selected');
      return;
    }

    const results: { name: string; success: boolean; error?: string }[] = [];
    const totalOperations = configs.length * localPaths.length;
    let completedOperations = 0;

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Uploading to all profiles...',
      cancellable: false
    }, async (progress) => {
      for (const localPath of localPaths) {
        for (let i = 0; i < configs.length; i++) {
          const config = configs[i];
          const profileName = config.name || config.host;
          completedOperations++;
          progress.report({
            message: `${path.basename(localPath)} -> ${profileName} (${completedOperations}/${totalOperations})`,
            increment: totalOperations > 0 ? (100 / totalOperations) : 100
          });

          try {
            const connection = await connectionManager.ensureConnection(config);
            const relativePath = sanitizeRelativePath(path.relative(resolveLocalRoot(workspaceRoot, config.localPath), localPath));
            const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));

            // Ensure remote directory exists
            const remoteDir = normalizeRemotePath(path.dirname(remotePath));
            try {
              await connection.mkdir(remoteDir);
            } catch {
              // Directory might already exist
            }

            const outcome = await transferManager.uploadFile(connection, localPath, remotePath, config);
            if (isTransferCompleted(outcome)) {
              results.push({ name: `${profileName}:${path.basename(localPath)}`, success: true });
            } else {
              reportSkippedTransfer('Upload', localPath, outcome);
              results.push({ name: `${profileName}:${path.basename(localPath)}`, success: false, error: outcome.reason });
            }
          } catch (error: unknown) {
            results.push({ name: `${profileName}:${path.basename(localPath)}`, success: false, error: errorMessage(error) });
          }
        }
      }
    });

    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success);

    if (failed.length === 0) {
      statusBar.success(`Uploaded to all ${successful} profiles successfully`);
    } else {
      statusBar.warn(`Uploaded to ${successful}/${results.length} profiles. Failed: ${failed.map(f => f.name).join(', ')}`);
    }
  });

  // Note: uploadFolder and downloadFolder commands are disabled.
  // The main upload and download commands now automatically detect file/folder type.

  // const uploadFolderCommand = vscode.commands.registerCommand('stackerftp.uploadFolder', async (uri: vscode.Uri) => {
  //   const workspaceRoot = getWorkspaceRoot(uri);
  //   if (!workspaceRoot) return;

  //   const config = configManager.getActiveConfig(workspaceRoot);
  //   if (!config) {
  //     statusBar.error('No ITFFTP configuration found', true);
  //     return;
  //   }

  //   const localPath = uri?.fsPath;
  //   if (!localPath) {
  //     statusBar.error('No folder selected');
  //     return;
  //   }

  //   try {
  //     const folderName = path.basename(localPath);
  //     const progress = statusBar.startProgress('upload-folder', `Uploading folder: ${folderName} (connecting...)`);

  //     try {
  //       const connection = await connectionManager.ensureConnection(config);

  //       const relativePath = sanitizeRelativePath(path.relative(workspaceRoot, localPath));
  //       const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));

  //       progress.update(`Uploading folder: ${folderName} (scanning and queueing files...)`);
  //       const result = await transferManager.uploadDirectory(connection, localPath, remotePath, config);
  //       progress.complete();
  //       showSyncResult(result, 'upload');
  //     } catch (error: unknown) {
  //       progress.fail(`Upload folder failed: ${errorMessage(error)}`);
  //       throw error;
  //     }
  //   } catch (error: unknown) {
  //     statusBar.error(`Upload folder failed: ${errorMessage(error)}`);
  //   }
  // });

  // Note: uploadFolder and downloadFolder commands are disabled.
  // The main upload and download commands now automatically detect file/folder type.

  // const downloadFolderCommand = vscode.commands.registerCommand('stackerftp.downloadFolder', async (uri: vscode.Uri) => {
  //   const workspaceRoot = getWorkspaceRoot(uri);
  //   if (!workspaceRoot) return;

  //   const config = configManager.getActiveConfig(workspaceRoot);
  //   if (!config) {
  //     statusBar.error('No ITFFTP configuration found', true);
  //     return;
  //   }

  //   const localPath = uri?.fsPath;
  //   if (!localPath) {
  //     statusBar.error('No folder selected');
  //     return;
  //   }

  //   try {
  //     const folderName = path.basename(localPath);
  //     const progress = statusBar.startProgress('download-folder', `Downloading folder: ${folderName} (connecting...)`);

  //     try {
  //       const connection = await connectionManager.ensureConnection(config);

  //       const relativePath = sanitizeRelativePath(path.relative(workspaceRoot, localPath));
  //       const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));

  //       progress.update(`Downloading folder: ${folderName} (scanning and queueing files...)`);
  //       const result = await transferManager.downloadDirectory(connection, remotePath, localPath, config);
  //       progress.complete();
  //       showSyncResult(result, 'download');
  //     } catch (error: unknown) {
  //       progress.fail(`Download folder failed: ${errorMessage(error)}`);
  //       throw error;
  //     }
  //   } catch (error: unknown) {
  //     statusBar.error(`Download folder failed: ${errorMessage(error)}`);
  //   }
  // });

  const editInLocalCommand = vscode.commands.registerCommand('stackerftp.editInLocal', async (item?: RemoteTreeItem) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {return;}

    // Use item's config if available, otherwise get active config
    const config = item?.config || configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      statusBar.error('No ITFFTP configuration found', true);
      return;
    }

    if (!item || !item.entry) {
      statusBar.error('No file selected');
      return;
    }

    try {
      const connection = await connectionManager.ensureConnection(config);
      const remotePath = item.entry.path;
      const fileName = path.basename(remotePath);

      // Create temp directory for editing
      const tempDir = path.join(os.tmpdir(), 'stackerftp-edit', config.name || config.host);
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      // Use unique temp file name to avoid conflicts
      const uniqueId = Date.now().toString(36);
      const tempFileName = `${path.basename(fileName, path.extname(fileName))}_${uniqueId}${path.extname(fileName)}`;
      const tempPath = path.join(tempDir, tempFileName);

      // Download file to temp
      const outcome = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Downloading ${fileName}...`,
        cancellable: false
      }, () => transferManager.downloadFile(connection, remotePath, tempPath, config));
      if (!isTransferCompleted(outcome)) {
        reportSkippedTransfer('Download', tempPath, outcome);
        return;
      }

      // Open in editor
      const doc = await vscode.workspace.openTextDocument(tempPath);
      await vscode.window.showTextDocument(doc);

      // Store mapping for upload on save
      const metadata: EditMapping = {
        remotePath,
        configName: config.name,
        config
      };

      // Store in extension context for later use
      const editMappingGlobal = global as typeof globalThis & {
        stackerftpEditMappings?: Map<string, EditMapping>;
      };
      const editMappings = editMappingGlobal.stackerftpEditMappings ?? new Map<string, EditMapping>();
      editMappingGlobal.stackerftpEditMappings = editMappings;
      editMappings.set(tempPath, metadata);

      statusBar.success(`Editing: ${fileName} - Save to upload changes`);
    } catch (error: unknown) {
      statusBar.error(`Failed to edit file: ${errorMessage(error)}`);
    }
  });

  const revealInExplorerCommand = vscode.commands.registerCommand('stackerftp.revealInExplorer', async (item?: RemoteTreeItem) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {return;}

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      statusBar.error('No ITFFTP configuration found', true);
      return;
    }

    if (!item || !item.entry) {
      statusBar.error('No file selected');
      return;
    }

    try {
      const remotePath = item.entry.path;
      const relativePath = path.relative(config.remotePath, remotePath);
      const localPath = path.join(resolveLocalRoot(workspaceRoot, config.localPath), relativePath);

      if (fs.existsSync(localPath)) {
        // Reveal in VS Code explorer
        const localUri = vscode.Uri.file(localPath);
        await vscode.commands.executeCommand('revealInExplorer', localUri);
      } else {
        // Download first then reveal
        const connection = await connectionManager.ensureConnection(config);
        const localDir = path.dirname(localPath);

        if (!fs.existsSync(localDir)) {
          fs.mkdirSync(localDir, { recursive: true });
        }

        const outcome = await transferManager.downloadFile(connection, remotePath, localPath, config);
        if (!isTransferCompleted(outcome)) {
          reportSkippedTransfer('Download', localPath, outcome);
          return;
        }

        const localUri = vscode.Uri.file(localPath);
        await vscode.commands.executeCommand('revealInExplorer', localUri);

        statusBar.success(`Downloaded and revealed: ${path.basename(localPath)}`);
      }
    } catch (error: unknown) {
      statusBar.error(`Failed to reveal file: ${errorMessage(error)}`);
    }
  });

  const forceUploadCommand = vscode.commands.registerCommand('stackerftp.forceUpload', async (uri: vscode.Uri, selectedItems?: vscode.Uri[]) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {return;}

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      statusBar.error('No ITFFTP configuration found', true);
      return;
    }

    const localPaths = selectedItems && selectedItems.length > 0
      ? selectedItems.map(item => item.fsPath).filter(Boolean)
      : (uri?.fsPath ? [uri.fsPath] : (vscode.window.activeTextEditor?.document.fileName ? [vscode.window.activeTextEditor.document.fileName] : []));

    if (localPaths.length === 0) {
      statusBar.error('No file selected');
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      localPaths.length === 1
        ? 'Force upload will overwrite the remote file. Continue?'
        : `Force upload will overwrite ${localPaths.length} remote files. Continue?`,
      { modal: true },
      'Yes', 'No'
    );
    if (choice !== 'Yes') {return;}

    try {
      const connection = await connectionManager.ensureConnection(config);
      let uploadedCount = 0;
      let failedCount = 0;
      let skippedCount = 0;

      for (const localPath of localPaths) {
        try {
          const relativePath = sanitizeRelativePath(path.relative(resolveLocalRoot(workspaceRoot, config.localPath), localPath));
          const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));

          // Ensure remote directory exists
          const remoteDir = normalizeRemotePath(path.dirname(remotePath));
          try {
            await connection.mkdir(remoteDir);
          } catch {
            // Directory might already exist
          }

          const outcome = await transferManager.uploadFile(connection, localPath, remotePath, config);
          if (isTransferCompleted(outcome)) {
            uploadedCount++;
          } else {
            skippedCount++;
            reportSkippedTransfer('Upload', localPath, outcome);
          }
        } catch {
          failedCount++;
        }
      }

      if (failedCount === 0 && skippedCount === 0) {
        statusBar.success(`Force uploaded: ${uploadedCount} item(s)`);
      } else {
        void vscode.window.showWarningMessage(`Force uploaded: ${uploadedCount}, Skipped: ${skippedCount}, Failed: ${failedCount}`);
      }
    } catch (error: unknown) {
      statusBar.error(`Force upload failed: ${errorMessage(error)}`, true);
    }
  });

  const forceDownloadCommand = vscode.commands.registerCommand('stackerftp.forceDownload', async (uri: vscode.Uri, selectedItems?: vscode.Uri[]) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {return;}

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      statusBar.error('No ITFFTP configuration found', true);
      return;
    }

    const localPaths = selectedItems && selectedItems.length > 0
      ? selectedItems.map(item => item.fsPath).filter(Boolean)
      : (uri?.fsPath ? [uri.fsPath] : (vscode.window.activeTextEditor?.document.fileName ? [vscode.window.activeTextEditor.document.fileName] : []));

    if (localPaths.length === 0) {
      statusBar.error('No file selected');
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      localPaths.length === 1
        ? 'Force download will overwrite the local file. Continue?'
        : `Force download will overwrite ${localPaths.length} local files. Continue?`,
      { modal: true },
      'Yes', 'No'
    );
    if (choice !== 'Yes') {return;}

    try {
      const connection = await connectionManager.ensureConnection(config);
      let downloadedCount = 0;
      let failedCount = 0;
      let skippedCount = 0;

      for (const localPath of localPaths) {
        try {
          const relativePath = sanitizeRelativePath(path.relative(resolveLocalRoot(workspaceRoot, config.localPath), localPath));
          const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));

          const outcome = await transferManager.downloadFile(connection, remotePath, localPath, config);
          if (isTransferCompleted(outcome)) {
            downloadedCount++;
          } else {
            skippedCount++;
            reportSkippedTransfer('Download', localPath, outcome);
            continue;
          }

          // Refresh the editor if file is open
          const openDoc = vscode.workspace.textDocuments.find(d => d.fileName === localPath);
          if (openDoc) {
            vscode.commands.executeCommand('workbench.action.files.revert');
          }
        } catch {
          failedCount++;
        }
      }

      if (failedCount === 0 && skippedCount === 0) {
        statusBar.success(`Force downloaded: ${downloadedCount} item(s)`);
      } else {
        void vscode.window.showWarningMessage(`Force downloaded: ${downloadedCount}, Skipped: ${skippedCount}, Failed: ${failedCount}`);
      }
    } catch (error: unknown) {
      statusBar.error(`Force download failed: ${errorMessage(error)}`, true);
    }
  });

  const listRemoteRevisionsCommand = vscode.commands.registerCommand('stackerftp.listRemoteRevisions', async (uri: vscode.Uri) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {return;}

    const config = configManager.getActiveConfig(workspaceRoot);
    if (!config) {
      statusBar.error('No ITFFTP configuration found', true);
      return;
    }

    const localPath = uri?.fsPath || vscode.window.activeTextEditor?.document.fileName;
    if (!localPath) {
      statusBar.error('No file selected');
      return;
    }

    try {
      const connection = await connectionManager.ensureConnection(config);
      const relativePath = sanitizeRelativePath(path.relative(resolveLocalRoot(workspaceRoot, config.localPath), localPath));
      const remotePath = normalizeRemotePath(path.join(config.remotePath, relativePath));
      const remoteDir = path.dirname(remotePath);
      const baseName = path.basename(remotePath, path.extname(remotePath));
      // List directory and find backup files
      const entries = await connection.list(remoteDir);
      const revisions = entries.filter(e =>
        e.name.startsWith(baseName) &&
        (e.name.includes('.bak') || e.name.includes('.backup') || e.name.match(/\.\d{4}-\d{2}-\d{2}/))
      );

      if (revisions.length === 0) {
        statusBar.success('No remote revisions found for this file');
        return;
      }

      const items = revisions.map(r => ({
        label: r.name,
        description: `${r.size} bytes`,
        detail: `Modified: ${r.modifyTime.toLocaleString()}`,
        entry: r
      }));

      const selected = await vscode.window.showQuickPick(items, {
        title: 'Remote Revisions',
        placeHolder: 'Select a revision to download'
      });

      if (selected) {
        const revisionPath = normalizeRemotePath(path.join(remoteDir, selected.entry.name));
        const localRevisionPath = path.join(path.dirname(localPath), selected.entry.name);

        const outcome = await transferManager.downloadFile(connection, revisionPath, localRevisionPath, config);
        if (isTransferCompleted(outcome)) {
          statusBar.success(`Downloaded revision: ${selected.entry.name}`);
        } else {
          reportSkippedTransfer('Download', localRevisionPath, outcome);
        }
      }
    } catch (error: unknown) {
      statusBar.error(`Failed to list revisions: ${errorMessage(error)}`);
    }
  });


  // ==================== Tree View Specific Commands ====================
  // These are used by the native TreeView and passed config explicitly

  const treeOpenFileCommand = vscode.commands.registerCommand('stackerftp.tree.openFile', async (
    item: RemoteFileInput,
    config?: FTPConfig
  ) => {
    if (container.remoteExplorer) {
      await container.remoteExplorer.openFile(item, config);
    }
  });

  const treeDownloadCommand = vscode.commands.registerCommand('stackerftp.tree.download', async (
    itemOrItems: RemoteFileInput | RemoteFileInput[],
    selectedItems?: RemoteFileInput[]
  ) => {
    // TreeView multi-select is passed as the second argument by VS Code.
    const items = selectedItems && selectedItems.length > 0
      ? selectedItems
      : (Array.isArray(itemOrItems) ? itemOrItems : [itemOrItems]);

    if (!items || items.length === 0) {
      statusBar.error('No item selected');
      return;
    }

    if (container.remoteExplorer) {
      let downloadedCount = 0;
      for (const item of items) {
        if (await container.remoteExplorer.downloadFile(item)) {
          downloadedCount++;
        }
      }
      if (downloadedCount > 1) {
        statusBar.success(`Downloaded: ${downloadedCount} items`);
      }
    }
  });

  const treeDeleteCommand = vscode.commands.registerCommand('stackerftp.tree.delete', async (
    itemOrItems: RemoteFileInput | RemoteFileInput[],
    selectedItems?: RemoteFileInput[]
  ) => {
    // TreeView multi-select is passed as the second argument by VS Code.
    const items = selectedItems && selectedItems.length > 0
      ? selectedItems
      : (Array.isArray(itemOrItems) ? itemOrItems : [itemOrItems]);

    if (!items || items.length === 0) {
      statusBar.error('No item selected');
      return;
    }

    const names = items.map(i => 'entry' in i ? i.entry.name : i.name).join(', ');
    const confirm = await vscode.window.showWarningMessage(
      items.length === 1
        ? `Delete "${names}"?`
        : `Delete ${items.length} items (${names})?`,
      { modal: true },
      'Delete', 'Cancel'
    );

    if (confirm !== 'Delete') {return;}

    if (container.remoteExplorer) {
      // Multi-select: skip individual confirm dialogs
      const skipConfirm = items.length > 1;
      for (const item of items) {
        await container.remoteExplorer.deleteFile(item, undefined, skipConfirm);
      }
    }
  });

  const treeRefreshCommand = vscode.commands.registerCommand('stackerftp.tree.refresh', () => {
    if (container.remoteExplorer) {
      container.remoteExplorer.refresh();
    }
  });

  // Register all commands
  context.subscriptions.push(
    treeOpenFileCommand,
    treeDownloadCommand,
    treeDeleteCommand,
    treeRefreshCommand,
    configCommand,
    connectCommand,
    disconnectCommand,
    setProfileCommand,
    uploadCommand,
    uploadCurrentFileCommand,
    downloadCommand,
    downloadProjectCommand,
    syncToRemoteCommand,
    syncToLocalCommand,
    syncBothWaysCommand,
    openRemoteFileCommand,
    deleteRemoteCommand,
    newFolderCommand,
    newFileCommand,
    renameCommand,
    duplicateCommand,
    refreshCommand,
    diffCommand,
    terminalCommand,
    viewLogsCommand,
    clearLogsCommand,
    cancelTransferCommand,
    transferQueueCommand,
    newConnectionCommand,
    switchProtocolCommand,
    quickConnectCommand,
    uploadToAllProfilesCommand,
    editInLocalCommand,
    revealInExplorerCommand,
    forceUploadCommand,
    forceDownloadCommand,
    listRemoteRevisionsCommand,
    uploadChangedFilesCommand,
    uploadProjectCommand,
    listCommand,
    listAllCommand,
    refreshActiveFileCommand,
    expandAllCommand,
    collapseAllCommand,
    expandConnectionCommand,
    collapseConnectionCommand,
    revealInRemoteExplorerCommand,
    copyToOtherRemoteCommand,
    compareRemotesCommand,
    syncBetweenRemotesCommand,
    showTransferQueueCommand,
    cancelTransferItemCommand,
    retryTransferItemCommand,
    clearTransferQueueCommand
  );

  const viewDisposables = registerViewCommands(container);
  const webMasterDisposables = registerWebMasterCommands();

  context.subscriptions.push(
    ...webMasterDisposables,
    ...viewDisposables
  );
}

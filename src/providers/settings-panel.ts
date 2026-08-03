/**
 * ITFFTP - Extension Settings Webview
 */

import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { statusBar } from '../utils/status-bar';
import { configManager } from '../core/config';
import { FTPConfig } from '../types';

type SettingsSavedHandler = (scope: vscode.Uri) => Promise<void> | void;

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
  'remoteExplorerSortOrder',
  'remotes'
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
  remotes: {}
};

export class SettingsPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private scope?: vscode.Uri;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onSettingsSaved?: SettingsSavedHandler
  ) {}

  public open(scope?: vscode.Uri): void {
    const resolvedScope = scope || vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!resolvedScope) {
      vscode.window.showWarningMessage('Open a workspace before editing ITFFTP settings.');
      return;
    }

    this.scope = resolvedScope;

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
      }
    });
  }

  public dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  private async handleMessage(message: any): Promise<void> {
    try {
      switch (message?.type) {
        case 'ready':
        case 'loadSettings':
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
    await configManager.loadConfig(this.scope!.fsPath);
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
      remotes: JSON.stringify(configuration.get<Record<string, unknown>>('remotes', DEFAULT_SETTINGS.remotes), null, 2),
      connections: JSON.stringify(configManager.getConfigs(this.scope!.fsPath), null, 2)
    };

    this.panel.webview.postMessage({ type: 'settings', settings });
  }

  private async saveSettings(values: any): Promise<void> {
    const configuration = this.getConfiguration();
    const remotes = this.parseRemotes(values?.remotes);
    const connections = this.parseConnections(values?.connections);
    const transferConcurrency = this.parseConcurrency(values?.transferConcurrency);
    const sortOrder = this.parseSortOrder(values?.remoteExplorerSortOrder);

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
      remoteExplorerSortOrder: sortOrder,
      remotes
    };

    for (const key of SETTING_KEYS) {
      await configuration.update(key, updates[key], vscode.ConfigurationTarget.Workspace);
    }

    await configManager.saveConfig(this.scope!.fsPath, connections);

    await this.sendSettings();
    this.panel?.webview.postMessage({ type: 'saveSuccess' });
    statusBar.success('ITFFTP settings saved');

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

  private parseRemotes(value: unknown): Record<string, unknown> {
    let parsed: unknown = value;
    if (typeof value === 'string') {
      parsed = JSON.parse(value.trim() || '{}');
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Remote definitions must be a JSON object.');
    }

    return parsed as Record<string, unknown>;
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
    }

    return connections as FTPConfig[];
  }

  private parseConcurrency(value: unknown): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
      throw new Error('Transfer concurrency must be an integer from 1 to 10.');
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

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource};">
  <link href="${codiconUri}" rel="stylesheet">
  <style>${cssContent}</style>
</head>
<body>
  ${htmlContent}
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

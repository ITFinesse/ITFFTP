import * as vscode from 'vscode';

/** Opens the full dashboard when the ITFFTP activity-bar entry is selected. */
export class DashboardLauncherProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'stackerftp.dashboardLauncher';

  constructor(private readonly openDashboard: () => void) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = '';
    const openWhenVisible = (): void => {
      if (!webviewView.visible) return;
      this.openDashboard();
      void vscode.commands.executeCommand('workbench.action.closeSidebar');
    };
    // resolveWebviewView only runs once. Opening on visibility changes makes
    // the activity-bar icon work again after the editor tab is closed.
    webviewView.onDidChangeVisibility(openWhenVisible);
    setTimeout(openWhenVisible, 0);
  }
}

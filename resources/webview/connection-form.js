const vscode = acquireVsCodeApi();
const connectionList = document.getElementById('connectionList');
const loadingOverlay = document.getElementById('loadingOverlay');
const emptyState = document.getElementById('emptyState');
const sidebarActions = document.getElementById('sidebarActions');
let configs = [];

function openSettings() {
  vscode.postMessage({ type: 'openSettings' });
}

document.getElementById('btnOpenSettings').addEventListener('click', openSettings);
document.getElementById('btnOpenSettingsEmpty').addEventListener('click', openSettings);
document.getElementById('btnRefresh').addEventListener('click', () => {
  loadingOverlay.classList.remove('hidden');
  vscode.postMessage({ type: 'loadConfigs' });
});

function renderConnections() {
  connectionList.querySelectorAll('.connection-item').forEach((item) => item.remove());
  emptyState.classList.toggle('hidden', configs.length > 0);

  configs.forEach((config, index) => {
    const lifecycle = config.lifecycle || { state: config.connected ? 'connected' : 'disconnected' };
    const isConnecting = lifecycle.state === 'connecting';
    const item = document.createElement('div');
    item.className = `connection-item ${lifecycle.state}`;

    const icon = isConnecting
      ? 'codicon-sync spin'
      : config.connected
        ? 'codicon-debug-disconnect'
        : 'codicon-plug';
    const status = lifecycle.state === 'error'
      ? lifecycle.error || 'Connection failed'
      : lifecycle.state.charAt(0).toUpperCase() + lifecycle.state.slice(1);

    item.innerHTML = `
      <div class="connection-icon"><i class="codicon ${config.protocol === 'sftp' ? 'codicon-lock' : 'codicon-cloud'}"></i></div>
      <div class="connection-info">
        <div class="connection-name"></div>
        <div class="connection-details"></div>
        <div class="connection-status"></div>
      </div>
      <button class="btn-icon connection-toggle" title="${config.connected ? 'Disconnect' : 'Connect'}" ${isConnecting ? 'disabled' : ''}>
        <span class="codicon ${icon}"></span>
      </button>`;

    item.querySelector('.connection-name').textContent = config.name || config.host;
    item.querySelector('.connection-details').textContent = `${(config.protocol || 'sftp').toUpperCase()} · ${config.username}@${config.host}`;
    const statusElement = item.querySelector('.connection-status');
    statusElement.textContent = status;
    statusElement.classList.toggle('error', lifecycle.state === 'error');
    item.querySelector('.connection-toggle').addEventListener('click', () => {
      vscode.postMessage({ type: config.connected ? 'disconnect' : 'connect', index });
    });
    connectionList.appendChild(item);
  });
}

window.addEventListener('message', (event) => {
  const message = event.data || {};
  if (message.type === 'configs') {
    configs = message.configs || [];
    renderConnections();
    loadingOverlay.classList.add('hidden');
    connectionList.classList.remove('hidden');
    sidebarActions.classList.remove('hidden');
  }
  if (message.type === 'noWorkspace') {
    loadingOverlay.classList.add('hidden');
    connectionList.classList.remove('hidden');
    emptyState.querySelector('p').textContent = 'Open a folder to manage connections';
  }
});

vscode.postMessage({ type: 'ready' });

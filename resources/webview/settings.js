const vscode = acquireVsCodeApi();

const ids = [
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
  'downloadWhenOpenInRemoteExplorer'
];

const message = document.getElementById('settingsMessage');
const remotes = document.getElementById('remotes');
const connections = document.getElementById('connections');

function showMessage(text, kind) {
  message.textContent = text;
  message.className = 'message ' + (kind || '');
  message.classList.remove('hidden');
}

function setSettings(settings) {
  ids.forEach((id) => {
    const input = document.getElementById(id);
    if (input) input.checked = Boolean(settings[id]);
  });

  document.getElementById('transferConcurrency').value = settings.transferConcurrency || 4;
  document.getElementById('remoteExplorerSortOrder').value = settings.remoteExplorerSortOrder || 'name';
  remotes.value = settings.remotes || '{}';
  connections.value = settings.connections || '[]';
  message.classList.add('hidden');
}

function readSettings() {
  const settings = {};
  ids.forEach((id) => {
    settings[id] = document.getElementById(id).checked;
  });
  settings.transferConcurrency = Number(document.getElementById('transferConcurrency').value);
  settings.remoteExplorerSortOrder = document.getElementById('remoteExplorerSortOrder').value;
  settings.remotes = remotes.value;
  settings.connections = connections.value;
  return settings;
}

document.getElementById('btnSave').addEventListener('click', () => {
  vscode.postMessage({ type: 'saveSettings', settings: readSettings() });
  showMessage('Saving settings...', '');
});

document.getElementById('btnReload').addEventListener('click', () => {
  vscode.postMessage({ type: 'loadSettings' });
  showMessage('Reloading settings...', '');
});

document.getElementById('btnReset').addEventListener('click', () => {
  vscode.postMessage({ type: 'resetSettings' });
});

document.getElementById('btnOpenJson').addEventListener('click', () => {
  vscode.postMessage({ type: 'openJson' });
});

window.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'settings') setSettings(data.settings || {});
  if (data.type === 'saveSuccess') showMessage('Settings saved.', 'success');
  if (data.type === 'resetSuccess') showMessage('Workspace overrides reset.', 'success');
  if (data.type === 'saveError') showMessage(data.message || 'Unable to save settings.', 'error');
});

vscode.postMessage({ type: 'ready' });

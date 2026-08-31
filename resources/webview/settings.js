const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const settingIds = ['autoConnect', 'autoReconnect', 'autoRefresh', 'showHiddenFiles', 'confirmDelete', 'confirmSync', 'showWebMasterTools', 'enableFileWatcher', 'defaultSyntaxHighlighting', 'downloadWhenOpenInRemoteExplorer'];
const panelCopy = { hosts: ['Hosts', 'Manage remote locations and choose the workspace default.'], settings: ['Settings', 'Compact workspace-wide transfer and explorer preferences.'], ignores: ['Ignores', 'Move workspace files between transfer scope and ignored patterns.'], diff: ['Transfer', 'Compare matching local and remote folders, then transfer verified changes.'], analytics: ['Analytics', 'Transfer activity recorded for this workspace.'] };

let profiles = [], selectedIndex = -1, workspaceFiles = [], selectedWorkspacePath = '', selectedIgnoredPattern = '';
let settingsLoaded = false, saveTimer, progressHideTimer, saveInFlight = false, selectedPath = '', selectedSide = 'local';
const diff = { records: new Map(), collapsed: new Set(), loadedFolders: new Set(['']), loadingFolders: new Set(), localContent: undefined, remoteContent: undefined, scanning: false, invalidated: true };
let folderPicker;
let folderPickerOutsideHandler;
let contextMenuCleanup;
const getProfile = () => selectedIndex >= 0 ? profiles[selectedIndex] : undefined;
const labelFor = (profile, index) => profile.name || profile.host || `Host ${index + 1}`;

function toast(text, kind = 'info') {
  const region = $('toastRegion'); if (!region || !text) return;
  const item = document.createElement('div'); item.className = `toast toast-${kind}`; item.setAttribute('role', kind === 'error' ? 'alert' : 'status'); item.textContent = text; region.replaceChildren(item);
  setTimeout(() => item.classList.add('toast-leave'), 8000); setTimeout(() => item.remove(), 11000);
}
function visiblePanel() { return document.querySelector('[data-panel-content]:not(.hidden)')?.dataset.panelContent; }
function setPanel(name) {
  document.querySelectorAll('[data-panel-content]').forEach(node => node.classList.toggle('hidden', node.dataset.panelContent !== name));
  document.querySelectorAll('[data-panel]').forEach(node => { const active = node.dataset.panel === name; node.classList.toggle('is-active', active); if (active) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current'); });
  $('pageTitle').textContent = panelCopy[name][0]; $('pageDescription').textContent = panelCopy[name][1];
  if (name === 'diff' && (diff.invalidated || !diff.records.size) && !diff.scanning) refreshDiff(false);
}
function autoSyncFor(profile) { return ['off', 'upload', 'download', 'both'].includes(profile.autoSync) ? profile.autoSync : profile.uploadOnSave ? 'upload' : 'off'; }
function renderHosts() {
  $('hostCount').textContent = `${profiles.length} host${profiles.length === 1 ? '' : 's'}`;
  $('hostList').innerHTML = profiles.length ? profiles.map((profile, index) => `<button class="host-row ${index === selectedIndex ? 'is-selected' : ''}" type="button" data-host="${index}"><span class="host-name">${esc(labelFor(profile, index))}${profile.default ? '<span class="default-tag">Default</span>' : ''}</span><span class="host-meta">${esc(profile.host || 'Host not set')} / ${esc(profile.username || 'User not set')}</span><span class="host-protocol">${esc(profile.protocol || 'sftp')}</span></button>`).join('') : '<div class="host-empty">No remote locations yet. Add a host to begin.</div>';
  $('hostList').querySelectorAll('[data-host]').forEach(node => node.addEventListener('click', () => { const nextIndex = Number(node.dataset.host); const changed = nextIndex !== selectedIndex; selectedIndex = nextIndex; if (changed) resetDiffComparison(); renderHosts(); renderIgnoreEditor(); updateRootFields(); }));
  renderHostEditor();
}
function renderHostEditor() {
  const profile = getProfile(); const ids = ['hostName', 'hostProtocol', 'hostAddress', 'hostUsername', 'hostPassword', 'hostPort', 'hostLocalPath', 'hostRemotePath', 'hostCollisionPolicy', 'hostSyncMode', 'hostAutoSync', 'hostDefault', 'hostSecureMode'];
  ids.forEach(id => { $(id).disabled = !profile; }); $('btnTestHost').classList.toggle('hidden', !profile); $('btnDeleteHost').classList.toggle('hidden', !profile);
  $('btnExportSelected').disabled = !profile;
  document.querySelectorAll('[data-folder-picker]').forEach(button => { button.disabled = !profile; });
  $('hostFtpsTlsRow').classList.toggle('hidden', profile?.protocol !== 'ftps'); $('hostSecureMode').disabled = !profile || profile.protocol !== 'ftps';
  $('editorTitle').textContent = profile ? labelFor(profile, selectedIndex) : 'Select a host'; $('editorNote').textContent = profile ? 'Edit this remote location below.' : 'Choose a remote location or add a new one.';
  updateTransferControls();
  if (!profile) { ['hostName', 'hostAddress', 'hostUsername', 'hostPassword', 'hostPort', 'hostLocalPath', 'hostRemotePath'].forEach(id => { $(id).value = ''; }); $('hostProtocol').value = 'sftp'; $('hostCollisionPolicy').value = 'ask'; $('hostSyncMode').value = 'update'; $('hostAutoSync').value = 'off'; $('hostSecureMode').value = 'control'; $('hostDefault').checked = false; return; }
  $('hostName').value = profile.name || ''; $('hostProtocol').value = profile.protocol || 'sftp'; $('hostAddress').value = profile.host || ''; $('hostUsername').value = profile.username || ''; $('hostPassword').value = profile.password || ''; $('hostPort').value = profile.port || ''; $('hostLocalPath').value = profile.localPath || '.'; $('hostRemotePath').value = profile.remotePath || '/'; $('hostCollisionPolicy').value = profile.collisionPolicy || 'ask'; $('hostSyncMode').value = profile.syncMode || 'update'; $('hostAutoSync').value = autoSyncFor(profile); $('hostDefault').checked = Boolean(profile.default); $('hostSecureMode').value = profile.secure === 'implicit' ? 'implicit' : 'control';
}
function updateProfile() {
  const profile = getProfile(); if (!profile) return;
  const previousProtocol = profile.protocol; const protocol = $('hostProtocol').value;
  const currentPort = Number($('hostPort').value); const previousDefaultPort = previousProtocol === 'sftp' ? 22 : 21; if (previousProtocol !== protocol && (!currentPort || currentPort === previousDefaultPort)) $('hostPort').value = protocol === 'sftp' ? '22' : '21';
  profile.name = $('hostName').value.trim() || undefined; profile.protocol = protocol; profile.host = $('hostAddress').value.trim(); profile.username = $('hostUsername').value.trim(); profile.password = $('hostPassword').value || undefined;
  if (protocol === 'ftps') profile.secure = $('hostSecureMode').value === 'implicit' ? 'implicit' : 'control'; else if (previousProtocol === 'ftps') profile.secure = false;
  const port = Number($('hostPort').value); profile.port = Number.isInteger(port) && port > 0 ? port : undefined; profile.localPath = $('hostLocalPath').value.trim().replace(/^\.\/?$/, '') || undefined; profile.remotePath = $('hostRemotePath').value.trim() || '/'; profile.collisionPolicy = $('hostCollisionPolicy').value; profile.syncMode = $('hostSyncMode').value;
  const mode = $('hostAutoSync').value; profile.autoSync = mode; profile.uploadOnSave = mode === 'upload' || mode === 'both'; profile.watcher = profile.uploadOnSave ? { ...(typeof profile.watcher === 'object' ? profile.watcher : {}), files: typeof profile.watcher === 'object' && profile.watcher.files ? profile.watcher.files : '**/*', autoUpload: true, autoDelete: typeof profile.watcher === 'object' ? Boolean(profile.watcher.autoDelete) : false } : false; if (mode !== 'off') $('enableFileWatcher').checked = true;
  if ($('hostDefault').checked) profiles.forEach((candidate, index) => { candidate.default = index === selectedIndex; }); else profile.default = false;
}
function isIgnored(path, patterns) {
  const clean = path.replace(/^\/+|\/+$/g, '');
  return patterns.some(pattern => { const value = String(pattern || '').replace(/^\/+|\/+$/g, ''); return value.endsWith('/**') ? clean === value.slice(0, -3) || clean.startsWith(value.slice(0, -3) + '/') : value === clean || (value && clean.split('/').includes(value)); });
}
function workspaceTreePaths() { return workspaceFiles.filter(path => !isIgnored(path, getProfile()?.ignore || [])); }
function focusPathOption(id, path) { [...$(id).querySelectorAll('[data-path]')].find(node => node.dataset.path === path)?.focus(); }
function renderPathList(id, values, selected, onSelect, empty) {
  const list = $(id); list.innerHTML = values.length ? values.map((path, index) => { const active = path === selected; return `<button class="path-row ${active ? 'is-selected' : ''}" type="button" role="option" aria-selected="${active}" tabindex="${active || (!selected && index === 0) ? '0' : '-1'}" data-path="${esc(path)}">${esc(path)}</button>`; }).join('') : `<div class="empty-state">${esc(empty)}</div>`;
  const options = [...list.querySelectorAll('[data-path]')];
  const select = path => { onSelect(path); queueMicrotask(() => focusPathOption(id, path)); };
  options.forEach((node, index) => {
    node.addEventListener('click', () => select(node.dataset.path));
    node.addEventListener('keydown', event => {
      let next = index;
      if (event.key === 'ArrowDown') next = Math.min(options.length - 1, index + 1);
      else if (event.key === 'ArrowUp') next = Math.max(0, index - 1);
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = options.length - 1;
      else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(node.dataset.path); return; }
      else return;
      event.preventDefault(); select(options[next].dataset.path);
    });
  });
}
function renderIgnoreEditor() {
  const profile = getProfile(); const select = $('ignoreHost'); select.innerHTML = profiles.length ? profiles.map((candidate, index) => `<option value="${index}">${esc(labelFor(candidate, index))}</option>`).join('') : '<option value="">No hosts configured</option>'; select.disabled = !profiles.length; select.value = selectedIndex >= 0 ? String(selectedIndex) : '';
  renderPathList('workspaceFileList', workspaceTreePaths(), selectedWorkspacePath, path => { selectedWorkspacePath = path; renderIgnoreEditor(); }, 'No workspace files outside the ignore list.');
  renderPathList('ignoredPatternList', profile?.ignore || [], selectedIgnoredPattern, path => { selectedIgnoredPattern = path; renderIgnoreEditor(); }, 'Nothing ignored yet.');
  $('btnIgnorePath').disabled = !profile || !selectedWorkspacePath; $('btnRestorePath').disabled = !profile || !selectedIgnoredPattern; $('manualIgnore').disabled = !profile; $('btnAddManualIgnore').disabled = !profile;
}
function addIgnore(pattern) {
  const profile = getProfile(); const clean = String(pattern || '').trim(); if (!profile || !clean) return;
  profile.ignore = [...new Set([...(profile.ignore || []), clean])]; selectedIgnoredPattern = clean; selectedWorkspacePath = '';
  renderIgnoreEditor(); scheduleSave(); resetDiffComparison(); if (visiblePanel() === 'diff') refreshDiff(true);
}
function readSettings() { updateProfile(); const value = {}; settingIds.forEach(id => { value[id] = Boolean($(id).checked); }); value.transferConcurrency = Number($('transferConcurrency').value); value.dashboardZoom = Number($('dashboardZoom').value); value.remoteExplorerSortOrder = $('remoteExplorerSortOrder').value; value.connections = JSON.stringify(profiles); return value; }
function scheduleSave() { if (!settingsLoaded) return; clearTimeout(saveTimer); saveTimer = setTimeout(() => { saveInFlight = true; progress(true, 'Saving settings'); vscode.postMessage({ type: 'saveSettings', settings: readSettings() }); }, 2000); }
function setSettings(settings) {
  settingIds.forEach(id => { if ($(id)) $(id).checked = Boolean(settings[id]); }); $('transferConcurrency').max = '100'; $('transferConcurrency').value = settings.transferConcurrency || 4; $('dashboardZoom').value = settings.dashboardZoom || 110; applyDashboardZoom(settings.dashboardZoom || 110); $('remoteExplorerSortOrder').value = settings.remoteExplorerSortOrder || 'name';
  try { const parsed = JSON.parse(settings.connections || '[]'); profiles = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []; } catch { profiles = []; toast('Unable to read connection profiles.', 'error'); }
  selectedIndex = profiles.length ? 0 : -1; updateRootFields(); renderHosts(); renderIgnoreEditor(); updateAnalytics(settings.analytics || {}); if (visiblePanel() === 'diff') refreshDiff(false);
}

function updateRootFields() { const profile = getProfile(); $('diffLocalRoot').value = profile?.localPath || '.'; $('diffRemoteRoot').value = profile?.remotePath || '/'; updateTransferControls(); }

function formatTreeSize(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}
function buildDiffTreeModel() {
  const records = [...diff.records.values()]; const changedFolders = new Set(); const sizes = { local: new Map(), remote: new Map() };
  records.forEach(record => {
    let parent = record.path.includes('/') ? record.path.slice(0, record.path.lastIndexOf('/')) : '';
    if (record.status !== 'same') while (parent) { changedFolders.add(parent); parent = parent.includes('/') ? parent.slice(0, parent.lastIndexOf('/')) : ''; }
    if (record.type !== 'file') return;
    ['local', 'remote'].forEach(side => {
      if (!record[side]) return;
      let folder = record.path.includes('/') ? record.path.slice(0, record.path.lastIndexOf('/')) : '';
      while (folder) { sizes[side].set(folder, (sizes[side].get(folder) || 0) + (Number(record[side].size) || 0)); folder = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : ''; }
    });
  });
  return { records, changedFolders, sizes };
}
function displayedDiffStatus(record, model) {
  if (record.type === 'directory' && record.status === 'same') {
    if (model.changedFolders.has(record.path)) return 'modified';
  }
  return record.status;
}
function treeRecords(model) {
  const changedOnly = $('diffChangedOnly').checked; const records = model.records;
  const visible = new Set(records.filter(record => !changedOnly || displayedDiffStatus(record, model) !== 'same').map(record => record.path));
  for (const path of [...visible]) { let parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''; while (parent) { visible.add(parent); parent = parent.includes('/') ? parent.slice(0, parent.lastIndexOf('/')) : ''; } }
  return records.filter(record => visible.has(record.path));
}
function canSyncRecord(record, direction) { if (record?.type !== 'file') return false; if (direction === 'up') return Boolean(record.local) && (record.status === 'missing-remote' || record.status === 'type-changed' || (record.status === 'modified' && record.newer === 'local')); return Boolean(record.remote) && (record.status === 'missing-local' || record.status === 'type-changed' || (record.status === 'modified' && record.newer === 'remote')); }
function sideIsFile(record, side) { return Boolean(record?.[side]) && (record[side].type || record.type) === 'file'; }
function updateTransferControls() {
  const profile = getProfile(); const profileReady = Boolean(profile) && !diff.scanning; const comparisonReady = profileReady && !diff.invalidated; const records = [...diff.records.values()]; const selectedRecord = diff.records.get(selectedPath);
  $('btnRefreshDiff').disabled = !profileReady; $('btnCreateRemoteFolder').disabled = !profileReady;
  document.querySelectorAll('[data-folder-picker^="transfer-"]').forEach(button => { button.disabled = !profileReady; });
  $('btnSyncChangedUp').disabled = !comparisonReady || !records.some(record => canSyncRecord(record, 'up'));
  $('btnSyncChangedDown').disabled = !comparisonReady || !records.some(record => canSyncRecord(record, 'down'));
  $('btnViewDiff').disabled = !comparisonReady || !sideIsFile(selectedRecord, 'local') || !sideIsFile(selectedRecord, 'remote'); $('btnUploadDiff').disabled = !comparisonReady || !selectedRecord?.local; $('btnDownloadDiff').disabled = !comparisonReady || !selectedRecord?.remote;
}
function renderDiffTree(side, model, visibleRecords) {
  const children = new Map([['', []]]);
  visibleRecords.forEach(record => { const parent = record.path.includes('/') ? record.path.slice(0, record.path.lastIndexOf('/')) : ''; if (!children.has(parent)) children.set(parent, []); children.get(parent).push(record); });
  const rows = [];
  const addChildren = (parent, depth) => {
    const entries = (children.get(parent) || []).sort((left, right) => left.type === right.type ? left.path.localeCompare(right.path) : left.type === 'directory' ? -1 : 1);
    for (const record of entries) {
    const parts = record.path.split('/');
    const folder = record.type === 'directory'; const present = side === 'local' ? record.local : record.remote; const state = present ? displayedDiffStatus(record, model) : (side === 'local' ? 'missing-local' : 'missing-remote');
    const size = present ? (folder ? model.sizes[side].get(record.path) || 0 : Number(present.size) || 0) : undefined;
    const hasKnownChildren = folder && [...diff.records.keys()].some(path => path.startsWith(`${record.path}/`));
    const expanded = folder && !diff.collapsed.has(record.path) && (diff.loadedFolders.has(record.path) || hasKnownChildren);
    const age = record.status === 'modified' && record.newer ? (record.newer === side ? 'is-newer' : 'is-older') : '';
    const stateLabel = state.replace('-', ' ');
    const selected = selectedPath === record.path && selectedSide === side;
    rows.push(`<button type="button" role="treeitem" aria-level="${depth + 1}" ${folder ? `aria-expanded="${expanded}"` : ''} aria-selected="${selected}" tabindex="${selected ? '0' : '-1'}" class="file-row ${folder ? 'is-folder' : 'is-file'} ${selected ? 'is-selected' : ''} ${present ? '' : 'is-placeholder'} status-${esc(state)} ${age}" data-path="${esc(record.path)}" data-side="${side}" data-folder="${folder ? 'true' : ''}" style="padding-left:${12 + depth * 16}px"><span class="codicon ${folder ? (diff.loadingFolders.has(record.path) ? 'codicon-loading codicon-modifier-spin' : expanded ? 'codicon-chevron-down' : 'codicon-chevron-right') : 'codicon-file'}"></span><span class="tree-name">${esc(parts.at(-1))}</span><span class="file-size">${size === undefined ? '—' : formatTreeSize(size)}</span><span class="file-status ${esc(state)}">${present ? esc(stateLabel) : side === 'local' ? 'missing locally' : 'missing remotely'}</span></button>`);
    if (expanded) addChildren(record.path, depth + 1);
    }
  }
  addChildren('', 0);
  return rows.length ? rows.join('') : diff.scanning ? '' : '<div class="empty-state">No changed paths match this filter.</div>';
}
function focusDiffTreeItem(side, path) { [...$(`diff${side === 'local' ? 'Local' : 'Remote'}List`).querySelectorAll('[data-path]')].find(node => node.dataset.path === path)?.focus(); }
function selectDiffTreeItem(path, side, toggleFolder = false, restoreFocus = false) {
  if (path !== selectedPath) hideFileDiff();
  selectedPath = path; selectedSide = side;
  if (toggleFolder) diff.collapsed.has(path) ? diff.collapsed.delete(path) : diff.collapsed.add(path);
  renderDiff();
  if (restoreFocus) focusDiffTreeItem(side, path);
}
function handleDiffTreeKey(event, node) {
  const items = [...node.parentElement.querySelectorAll('[data-path]')]; const index = items.indexOf(node); const side = node.dataset.side; const path = node.dataset.path;
  const moveTo = target => { event.preventDefault(); if (target) selectDiffTreeItem(target.dataset.path, target.dataset.side, false, true); };
  if (event.key === 'ArrowDown') return moveTo(items[Math.min(items.length - 1, index + 1)]);
  if (event.key === 'ArrowUp') return moveTo(items[Math.max(0, index - 1)]);
  if (event.key === 'Home') return moveTo(items[0]);
  if (event.key === 'End') return moveTo(items.at(-1));
  if (event.key === 'ArrowRight' && node.dataset.folder === 'true') {
    event.preventDefault();
    if (node.getAttribute('aria-expanded') !== 'true') { diff.collapsed.delete(path); renderDiff(); focusDiffTreeItem(side, path); return; }
    const child = items[index + 1]; if (child && Number(child.getAttribute('aria-level')) > Number(node.getAttribute('aria-level'))) selectDiffTreeItem(child.dataset.path, side, false, true);
    return;
  }
  if (event.key === 'ArrowLeft') {
    if (node.dataset.folder === 'true' && node.getAttribute('aria-expanded') === 'true') { event.preventDefault(); diff.collapsed.add(path); renderDiff(); focusDiffTreeItem(side, path); return; }
    const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''; const parent = items.find(item => item.dataset.path === parentPath); if (parent) moveTo(parent);
    return;
  }
  if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) { const bounds = node.getBoundingClientRect(); event.preventDefault(); selectedPath = path; selectedSide = side; renderDiff(); showContext(bounds.left + 18, bounds.bottom, path, side, node.dataset.folder === 'true'); return; }
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectDiffTreeItem(path, side, false, true); }
}
function renderDiff() {
  if (!getProfile()) { $('diffLocalCount').textContent = '0 paths'; $('diffRemoteCount').textContent = '0 paths'; $('diffLocalList').innerHTML = '<div class="empty-state">Choose a host to compare local files.</div>'; $('diffRemoteList').innerHTML = '<div class="empty-state">Choose a host to compare remote files.</div>'; [$('diffLocalList'), $('diffRemoteList')].forEach(tree => tree.setAttribute('aria-busy', 'false')); updateTransferControls(); return; }
  const model = buildDiffTreeModel(); const visibleRecords = treeRecords(model); const count = visibleRecords.length; $('diffLocalCount').textContent = `${count} paths`; $('diffRemoteCount').textContent = `${count} paths`; $('diffLocalList').innerHTML = renderDiffTree('local', model, visibleRecords); $('diffRemoteList').innerHTML = renderDiffTree('remote', model, visibleRecords);
  [$('diffLocalList'), $('diffRemoteList')].forEach(tree => tree.setAttribute('aria-busy', String(diff.scanning)));
  updateTransferControls();
  [$('diffLocalList'), $('diffRemoteList')].forEach(tree => { if (!tree.querySelector('[tabindex="0"]')) { const first = tree.querySelector('[data-path]'); if (first) first.tabIndex = 0; } });
  document.querySelectorAll('#diffLocalList [data-path], #diffRemoteList [data-path]').forEach(node => {
    node.addEventListener('click', () => selectDiffTreeItem(node.dataset.path, node.dataset.side, node.dataset.folder === 'true'));
    node.addEventListener('keydown', event => handleDiffTreeKey(event, node));
    node.addEventListener('dblclick', () => { if (node.dataset.folder !== 'true') requestFileDiff(node.dataset.path); });
    node.addEventListener('contextmenu', event => { event.preventDefault(); selectedPath = node.dataset.path; selectedSide = node.dataset.side; renderDiff(); showContext(event.clientX, event.clientY, selectedPath, selectedSide, node.dataset.folder === 'true', node); });
  });
}
function hideFileDiff() { diff.localContent = undefined; diff.remoteContent = undefined; $('diffFileView').replaceChildren(); document.querySelector('[data-panel-content="diff"]')?.classList.remove('has-file-diff'); }
function closeFileDiff() { hideFileDiff(); selectedPath = ''; renderDiff(); }
function resetDiffComparison() { diff.records.clear(); diff.collapsed.clear(); diff.loadedFolders = new Set(['']); diff.loadingFolders.clear(); diff.scanning = false; diff.invalidated = true; selectedPath = ''; selectedSide = 'local'; hideFileDiff(); renderDiff(); }
function refreshDiff(force = true) { const profile = getProfile(); if (!profile || diff.scanning) return false; if (force) resetDiffComparison(); diff.scanning = true; diff.invalidated = false; renderDiff(); progress(true, 'Comparing local and remote folders'); vscode.postMessage({ type: 'loadDiffRemote', connection: profile, force }); return true; }
function requestFileDiff(path) { const profile = getProfile(); const record = diff.records.get(path); if (!profile || !path || diff.scanning || diff.invalidated || !sideIsFile(record, 'local') || !sideIsFile(record, 'remote')) return; diff.localContent = undefined; diff.remoteContent = undefined; document.querySelector('[data-panel-content="diff"]')?.classList.add('has-file-diff'); vscode.postMessage({ type: 'readDiffFile', direction: 'local', path, connection: profile }); vscode.postMessage({ type: 'readDiffFile', direction: 'remote', path, connection: profile }); }
function alignedLineDiff(localText, remoteText) {
  const left = String(localText).replace(/\r\n/g, '\n').split('\n'); const right = String(remoteText).replace(/\r\n/g, '\n').split('\n');
  const operations = []; const cells = (left.length + 1) * (right.length + 1);
  if (cells <= 500000) {
    const width = right.length + 1; const table = new Uint32Array(cells);
    for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) table[i * width + j] = left[i] === right[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    let i = 0, j = 0;
    while (i < left.length || j < right.length) {
      if (i < left.length && j < right.length && left[i] === right[j]) operations.push({ type: 'equal', left: left[i++], right: right[j++] });
      else if (j < right.length && (i === left.length || table[i * width + j + 1] >= table[(i + 1) * width + j])) operations.push({ type: 'insert', right: right[j++] });
      else operations.push({ type: 'delete', left: left[i++] });
    }
  } else {
    const count = Math.max(left.length, right.length); for (let i = 0; i < count; i++) operations.push(left[i] === right[i] ? { type: 'equal', left: left[i] || '', right: right[i] || '' } : { type: 'replace', left: left[i], right: right[i] });
  }
  const rows = []; let leftLine = 1, rightLine = 1;
  for (let index = 0; index < operations.length;) {
    const op = operations[index];
    if (op.type === 'equal' || op.type === 'replace') { rows.push({ type: op.type, left: op.left, right: op.right, leftLine: op.left !== undefined ? leftLine++ : '', rightLine: op.right !== undefined ? rightLine++ : '' }); index++; continue; }
    const deleted = [], inserted = [];
    while (operations[index]?.type === 'delete') deleted.push(operations[index++].left);
    while (operations[index]?.type === 'insert') inserted.push(operations[index++].right);
    for (let row = 0; row < Math.max(deleted.length, inserted.length); row++) rows.push({ type: deleted[row] !== undefined && inserted[row] !== undefined ? 'replace' : deleted[row] !== undefined ? 'delete' : 'insert', left: deleted[row], right: inserted[row], leftLine: deleted[row] !== undefined ? leftLine++ : '', rightLine: inserted[row] !== undefined ? rightLine++ : '' });
  }
  return rows;
}
function diffCell(side, text, line, type) { const changed = type === 'replace' || (side === 'local' ? type === 'delete' : type === 'insert'); return `<div class="diff-code-cell ${changed ? side === 'local' ? 'diff-removed' : 'diff-added' : ''}"><span class="diff-line-number">${line}</span><code>${text === undefined ? '' : esc(text) || ' '}</code></div>`; }
function renderFileDiff() {
  if (!selectedPath) return;
  if (diff.localContent === undefined || diff.remoteContent === undefined) { $('diffFileView').innerHTML = `<div class="diff-file-heading"><h3>Diff file view <span>${esc(selectedPath)}</span></h3><button class="icon-button diff-close" type="button" aria-label="Close file diff" title="Close file diff"><span class="codicon codicon-close"></span></button></div><div class="diff-loading">Loading both files…</div>`; $('diffFileView').querySelector('.diff-close')?.addEventListener('click', closeFileDiff); return; }
  const rows = alignedLineDiff(diff.localContent, diff.remoteContent); const changed = rows.filter(row => row.type !== 'equal').length;
  $('diffFileView').innerHTML = `<div class="diff-file-heading"><h3>Diff file view <span>${esc(selectedPath)}</span></h3><span>${changed ? `${changed} changed line${changed === 1 ? '' : 's'}` : 'Files are identical'}</span><button class="icon-button diff-close" type="button" aria-label="Close file diff" title="Close file diff"><span class="codicon codicon-close"></span></button></div><div class="diff-editor-header"><strong>Local</strong><strong>Remote</strong></div><div class="diff-editor-body"><div class="diff-code-pane" data-diff-pane="local">${rows.map(row => diffCell('local', row.left, row.leftLine, row.type)).join('')}</div><div class="diff-code-pane" data-diff-pane="remote">${rows.map(row => diffCell('remote', row.right, row.rightLine, row.type)).join('')}</div></div>`;
  $('diffFileView').querySelector('.diff-close')?.addEventListener('click', closeFileDiff);
  const panes = [...$('diffFileView').querySelectorAll('[data-diff-pane]')]; let syncing = false; panes.forEach((pane, index) => pane.addEventListener('scroll', () => { if (syncing) return; syncing = true; panes[1 - index].scrollTop = pane.scrollTop; panes[1 - index].scrollLeft = pane.scrollLeft; requestAnimationFrame(() => { syncing = false; }); }));
}
function closeContextMenu(restoreFocus = false) { const cleanup = contextMenuCleanup; contextMenuCleanup = undefined; cleanup?.(restoreFocus); }
function showContext(x, y, path, side, folder) {
  closeContextMenu();
  const profile = getProfile(); if (diff.scanning || diff.invalidated || !profile) { toast(diff.scanning ? 'Wait for the local and remote comparison to finish.' : 'Run Full Refresh before using file actions.', 'info'); return; }
  const menu = document.createElement('div'); menu.className = 'diff-context-menu'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', `Actions for ${path}`); menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:1000`;
  const record = diff.records.get(path); const canUpload = Boolean(record?.local); const canDownload = Boolean(record?.remote); const canView = sideIsFile(record, 'local') && sideIsFile(record, 'remote'); const existsOnSelectedSide = Boolean(record?.[side]);
  menu.innerHTML = `${canView ? '<button role="menuitem" tabindex="-1" data-action="view"><span class="codicon codicon-diff"></span>View file diff</button>' : ''}${canUpload ? '<button role="menuitem" tabindex="-1" data-action="upload"><span class="codicon codicon-cloud-upload"></span>Upload to remote</button>' : ''}${canDownload ? '<button role="menuitem" tabindex="-1" data-action="download"><span class="codicon codicon-cloud-download"></span>Download to local</button>' : ''}<button role="menuitem" tabindex="-1" data-action="ignore"><span class="codicon codicon-exclude"></span>Add to ignore</button>${existsOnSelectedSide ? '<button role="menuitem" tabindex="-1" data-action="rename"><span class="codicon codicon-edit"></span>Rename</button>' : ''}${existsOnSelectedSide ? `<button role="menuitem" tabindex="-1" class="danger" data-action="delete"><span class="codicon codicon-trash"></span>Delete ${side}</button>` : ''}`;
  document.body.append(menu); const bounds = menu.getBoundingClientRect(); menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`; menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))}px`; menu.style.maxHeight = `${Math.max(120, window.innerHeight - 16)}px`; menu.style.overflowY = 'auto';
  const buttons = [...menu.querySelectorAll('[role="menuitem"]')]; const outside = event => { if (!menu.contains(event.target)) closeContextMenu(); };
  contextMenuCleanup = restoreFocus => { document.removeEventListener('pointerdown', outside, true); menu.remove(); if (restoreFocus) focusDiffTreeItem(side, path); };
  buttons.forEach(button => button.addEventListener('click', () => { const action = button.dataset.action; closeContextMenu(true); if (action === 'view') return requestFileDiff(path); if (action === 'ignore') return addIgnore(folder ? `${path}/**` : path); progress(true, `${action === 'upload' ? 'Uploading' : action === 'download' ? 'Downloading' : action === 'delete' ? 'Deleting' : 'Renaming'} ${path}`); vscode.postMessage({ type: 'diffAction', action, direction: action === 'upload' ? 'local' : action === 'download' ? 'remote' : side, path: folder ? `${path}/` : path, connection: profile }); }));
  menu.addEventListener('keydown', event => { const index = buttons.indexOf(document.activeElement); let next; if (event.key === 'ArrowDown') next = (index + 1) % buttons.length; else if (event.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length; else if (event.key === 'Home') next = 0; else if (event.key === 'End') next = buttons.length - 1; else if (event.key === 'Escape') { event.preventDefault(); closeContextMenu(true); return; } else if (event.key === 'Tab') { closeContextMenu(); return; } else return; event.preventDefault(); buttons[next]?.focus(); });
  document.addEventListener('pointerdown', outside, true); buttons[0]?.focus();
}
function applyDashboardZoom(value) { document.documentElement.style.zoom = `${Math.min(160, Math.max(80, Number(value) || 110))}%`; }
function progress(active, label, percentage) { const determinate = Number.isFinite(Number(percentage)); const amount = Math.min(100, Math.max(0, determinate ? Number(percentage) : (active ? 0 : 100))); const popup = $('diffTransferProgress'); clearTimeout(progressHideTimer); $('diffTransferLabel').textContent = label; $('diffTransferPercent').textContent = active && !determinate ? 'Working' : `${Math.round(amount)}%`; popup.style.setProperty('--progress', `${amount}%`); popup.classList.toggle('is-active', active); popup.classList.toggle('is-indeterminate', active && !determinate); popup.classList.add('is-visible'); if (!active) progressHideTimer = setTimeout(() => popup.classList.remove('is-visible'), 2600); }
function renderTransferQueue(items) {
  const queue = $('diffTransferQueue'); if (!queue) return; const transfers = Array.isArray(items) ? items : [];
  const statusLabels = { pending: 'Queued', transferring: 'Transferring', completed: 'Completed', error: 'Failed', skipped: 'Skipped', cancelled: 'Cancelled', canceled: 'Cancelled' };
  queue.innerHTML = transfers.length ? transfers.map(item => {
    const amount = Math.min(100, Math.max(0, Number(item.progress) || 0)); const parts = String(item.path || '').split('/'); const name = parts.pop() || item.path || 'Transfer'; const parent = parts.join('/'); const deleting = item.direction === 'delete'; const direction = deleting ? '&times;' : item.direction === 'upload' ? '&gt;' : '&lt;'; const directionLabel = deleting ? 'Delete' : item.direction === 'upload' ? 'Upload to remote' : 'Download to local'; const status = String(item.status || 'pending'); const statusLabel = statusLabels[status] || status; const indeterminate = status === 'transferring' && amount === 0; const ariaValueNow = indeterminate ? '' : ` aria-valuenow="${amount}"`;
    return `<div class="transfer-item is-${esc(status)} ${deleting ? 'is-delete' : ''}" role="group" aria-label="${esc(`${directionLabel} ${item.path || name}. ${statusLabel}.`)}" title="${esc(item.path)}"><div class="transfer-item-main"><span class="codicon ${deleting ? 'codicon-trash' : 'codicon-file'}"></span><span class="transfer-item-copy"><strong>${esc(name)}</strong>${parent ? `<small>${esc(parent)}</small>` : ''}<small class="transfer-state">${esc(statusLabel)}</small></span><b class="transfer-direction ${esc(item.direction)}" aria-label="${directionLabel}">${direction}</b></div><div class="transfer-item-progress ${indeterminate ? 'is-indeterminate' : ''}" role="progressbar" aria-label="${directionLabel} progress" aria-valuemin="0" aria-valuemax="100"${ariaValueNow} aria-valuetext="${esc(statusLabel)}" style="--item-progress:${amount}%"><i></i></div></div>`;
  }).join('') : '<div class="transfer-empty">No queued transfers</div>';
}
function closeFolderPicker(restoreFocus = false) { const picker = folderPicker; document.querySelector('.folder-tree-popover')?.remove(); if (folderPickerOutsideHandler) document.removeEventListener('pointerdown', folderPickerOutsideHandler, true); if (picker?.anchor) { picker.anchor.setAttribute('aria-expanded', 'false'); picker.anchor.removeAttribute('aria-controls'); if (restoreFocus) picker.anchor.focus(); } folderPickerOutsideHandler = undefined; folderPicker = undefined; }
function positionFolderPicker(popover) { if (!folderPicker?.anchor || !popover) return; const margin = 8; const gap = 4; const bounds = folderPicker.anchor.getBoundingClientRect(); popover.style.maxHeight = `${Math.max(120, window.innerHeight - margin * 2)}px`; const width = popover.offsetWidth; const height = popover.offsetHeight; popover.style.left = `${Math.max(margin, Math.min(bounds.left, window.innerWidth - width - margin))}px`; popover.style.top = `${Math.max(margin, Math.min(bounds.bottom + gap, window.innerHeight - height - margin))}px`; }
function requestFolderChildren(path) {
  if (!folderPicker || folderPicker.loading.has(path)) return;
  const profile = getProfile(); if (!profile) { closeFolderPicker(); return; }
  folderPicker.loading.add(path); renderFolderPicker(path);
  vscode.postMessage({ type: 'browseFolders', requestId: folderPicker.requestId, kind: folderPicker.kind, path, connection: profile });
}
function focusFolderPickerRow(path) { [...document.querySelectorAll('.folder-tree-popover [data-folder-path]')].find(row => row.dataset.folderPath === path)?.focus(); }
function folderParentPath(path) { if (!folderPicker || path === folderPicker.root) return undefined; const clean = path.replace(/\/$/, ''); const separator = clean.lastIndexOf('/'); return separator <= 0 ? folderPicker.root : clean.slice(0, separator); }
function setFolderPickerExpanded(path, expanded) { if (!folderPicker) return; const node = folderPicker.nodes.get(path) || { children: [] }; if (expanded && !node.loaded) { node.expanded = true; folderPicker.nodes.set(path, node); requestFolderChildren(path); return; } node.expanded = expanded; folderPicker.nodes.set(path, node); renderFolderPicker(path); }
function handleFolderPickerKey(event, row) {
  const rows = [...document.querySelectorAll('.folder-tree-popover [data-folder-path]')]; const index = rows.indexOf(row); const path = row.dataset.folderPath;
  const moveTo = target => { event.preventDefault(); target?.focus(); };
  if (event.key === 'ArrowDown') return moveTo(rows[Math.min(rows.length - 1, index + 1)]);
  if (event.key === 'ArrowUp') return moveTo(rows[Math.max(0, index - 1)]);
  if (event.key === 'Home') return moveTo(rows[0]);
  if (event.key === 'End') return moveTo(rows.at(-1));
  if (event.key === 'ArrowRight') { event.preventDefault(); if (row.getAttribute('aria-expanded') !== 'true') setFolderPickerExpanded(path, true); else { const child = rows[index + 1]; if (child && Number(child.getAttribute('aria-level')) > Number(row.getAttribute('aria-level'))) child.focus(); } return; }
  if (event.key === 'ArrowLeft') { event.preventDefault(); if (row.getAttribute('aria-expanded') === 'true') setFolderPickerExpanded(path, false); else focusFolderPickerRow(folderParentPath(path)); return; }
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectFolder(path); return; }
  if (event.key === 'Escape') { event.preventDefault(); closeFolderPicker(true); }
}
function renderFolderPicker(focusPath) {
  if (!folderPicker) return;
  const popover = document.querySelector('.folder-tree-popover'); if (!popover) return;
  const activePath = focusPath !== undefined ? focusPath : document.activeElement?.dataset?.folderPath;
  const rows = [];
  const add = (path, label, depth) => {
    const node = folderPicker.nodes.get(path); const expanded = node?.expanded; const loading = folderPicker.loading.has(path);
    const selected = path === folderPicker.selectedPath;
    rows.push(`<button class="folder-tree-row ${selected ? 'is-selected' : ''}" type="button" role="treeitem" aria-level="${depth + 1}" aria-expanded="${Boolean(expanded)}" aria-selected="${selected}" aria-busy="${loading}" tabindex="${selected ? '0' : '-1'}" data-folder-path="${esc(path)}" style="padding-left:${6 + depth * 16}px"><span class="folder-expand codicon ${loading ? 'codicon-loading codicon-modifier-spin' : expanded ? 'codicon-chevron-down' : 'codicon-chevron-right'}" data-folder-expand="${esc(path)}"></span><span class="folder-label"><span class="codicon ${depth ? 'codicon-folder' : 'codicon-root-folder'}"></span>${esc(label)}</span></button>`);
    if (expanded) (node.children || []).forEach(child => add(child.path, child.name, depth + 1));
  };
  add(folderPicker.root, folderPicker.kind === 'local' ? 'Workspace root' : '/', 0);
  popover.innerHTML = rows.join('') || '<div class="folder-tree-loading">No folders found.</div>';
  if (!popover.querySelector('[tabindex="0"]')) { const first = popover.querySelector('[data-folder-path]'); if (first) first.tabIndex = 0; }
  popover.querySelectorAll('[data-folder-expand]').forEach(control => control.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); const path = control.dataset.folderExpand; const node = folderPicker.nodes.get(path) || { children: [] }; setFolderPickerExpanded(path, !node.expanded); }));
  popover.querySelectorAll('[data-folder-path]').forEach(row => { row.addEventListener('click', () => selectFolder(row.dataset.folderPath)); row.addEventListener('keydown', event => handleFolderPickerKey(event, row)); });
  positionFolderPicker(popover); if (activePath !== undefined) focusFolderPickerRow(activePath);
}
function clearFolderPickerLoading(path) { if (!folderPicker?.loading.size) return; const paths = path === undefined ? [...folderPicker.loading] : folderPicker.loading.has(path) ? [path] : []; for (const pendingPath of paths) { const node = folderPicker.nodes.get(pendingPath); if (node && !node.loaded) node.expanded = false; folderPicker.loading.delete(pendingPath); } if (paths.length) renderFolderPicker(path); }
function selectFolder(path) {
  if (!folderPicker) return; const target = folderPicker.target; const profile = getProfile(); if (!profile) return closeFolderPicker();
  resetDiffComparison();
  if (target === 'host-local' || target === 'transfer-local') profile.localPath = path || undefined;
  else profile.remotePath = path || '/';
  renderHostEditor(); updateRootFields(); scheduleSave(); closeFolderPicker(true);
  if (visiblePanel() === 'diff') refreshDiff(true);
}
function openFolderPicker(target, anchor) {
  const profile = getProfile(); if (!profile) return;
  if (folderPicker?.target === target) return closeFolderPicker(true);
  updateProfile(); closeFolderPicker();
  const kind = target.endsWith('local') ? 'local' : 'remote'; const root = kind === 'local' ? '' : '/';
  const popover = document.createElement('div'); popover.id = 'folderTreePopover'; popover.className = 'folder-tree-popover'; popover.setAttribute('role', 'tree'); popover.setAttribute('aria-label', `${kind === 'local' ? 'Local' : 'Remote'} folder picker`); document.body.append(popover); anchor.setAttribute('aria-expanded', 'true'); anchor.setAttribute('aria-controls', popover.id);
  folderPicker = { target, kind, root, anchor, selectedPath: kind === 'local' ? profile.localPath || '' : profile.remotePath || '/', requestId: `${Date.now()}-${Math.random()}`, nodes: new Map([[root, { children: [], expanded: true, loaded: false }]]), loading: new Set() };
  positionFolderPicker(popover); requestFolderChildren(root); folderPickerOutsideHandler = event => { if (!event.target.closest('.folder-tree-popover') && !event.target.closest('[data-folder-picker]')) closeFolderPicker(); }; setTimeout(() => document.addEventListener('pointerdown', folderPickerOutsideHandler, true), 0);
}
function buildDiffColumnHeadings() { ['diffLocalCount', 'diffRemoteCount'].forEach(id => { const count = $(id); if (!count || count.parentElement.querySelector('.file-size-heading')) return; const heading = document.createElement('span'); heading.className = 'file-size-heading'; heading.textContent = 'Size'; count.parentElement.insertBefore(heading, count); }); }
function applyAutoSyncCopy() { const watcherCopy = $('enableFileWatcher')?.closest('.setting-row')?.querySelector('span'); if (watcherCopy) { watcherCopy.childNodes[0].textContent = 'Auto Sync watcher'; const detail = watcherCopy.querySelector('small'); if (detail) detail.textContent = 'Watch local and remote changes; enabled directions transfer after 1 quiet second.'; } const select = $('hostAutoSync'); const hostLabel = select?.closest('label'); if (hostLabel?.childNodes[0]) hostLabel.childNodes[0].textContent = 'Auto Sync direction'; const copy = { upload: 'Sync local edits up', download: 'Sync remote edits down', both: 'Sync edits both ways' }; Object.entries(copy).forEach(([value, label]) => { const option = select?.querySelector(`option[value="${value}"]`); if (option) option.textContent = label; }); }
const analyticsCharts = {};
function formatBytes(value) { const bytes = Number(value) || 0; if (bytes < 1024) return `${bytes} B`; if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`; if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`; return `${(bytes / 1073741824).toFixed(1)} GB`; }
function drawChart(id, config) { if (typeof Chart !== 'function' || !$(id)) return; if (analyticsCharts[id]) analyticsCharts[id].destroy(); analyticsCharts[id] = new Chart($(id).getContext('2d'), config); }
function updateAnalytics(data) {
  const uploads = Number(data.uploadedFiles) || 0; const downloads = Number(data.downloadedFiles) || 0;
  $('analyticsUploads').textContent = String(uploads); $('analyticsDownloads').textContent = String(downloads); $('analyticsUploadSize').textContent = formatBytes(data.uploadedBytes); $('analyticsDownloadSize').textContent = formatBytes(data.downloadedBytes); $('analyticsDuration').textContent = data.averageDurationMs ? `${Math.round(data.averageDurationMs)} ms` : '—';
  const filter = $('analyticsProjectFilter'); const selected = filter.value || 'all'; filter.innerHTML = '<option value="all">All projects</option>' + (data.projects || []).map(project => `<option value="${esc(project.id)}">${esc(project.name)}</option>`).join(''); filter.value = [...filter.options].some(option => option.value === selected) ? selected : 'all';
  const days = Array.isArray(data.days) ? data.days : []; const labels = days.map(day => day.date.slice(5));
  const grid = 'rgba(148, 163, 184, .16)'; const text = '#cbd5e1'; const upload = '#4da3ff'; const download = '#4fd18b';
  const scales = { x: { ticks: { color: text }, grid: { color: grid } }, y: { beginAtZero: true, ticks: { color: text }, grid: { color: grid } } };
  const common = { responsive: true, maintainAspectRatio: false, animation: { duration: 350 }, plugins: { legend: { labels: { color: text } } } };
  drawChart('analyticsChart', { type: 'bar', data: { labels, datasets: [{ label: 'Upload', data: days.map(day => day.uploadedBytes || 0), backgroundColor: upload }, { label: 'Download', data: days.map(day => day.downloadedBytes || 0), backgroundColor: download }] }, options: { ...common, scales } });
  drawChart('analyticsFilesChart', { type: 'line', data: { labels, datasets: [{ label: 'Uploaded', data: days.map(day => day.uploadedFiles || 0), borderColor: upload, backgroundColor: upload, tension: .25 }, { label: 'Downloaded', data: days.map(day => day.downloadedFiles || 0), borderColor: download, backgroundColor: download, tension: .25 }] }, options: { ...common, scales } });
  drawChart('analyticsDirectionChart', { type: 'doughnut', data: { labels: ['Upload', 'Download'], datasets: [{ data: [uploads, downloads], backgroundColor: [upload, download], borderWidth: 0 }] }, options: { ...common, cutout: '62%' } });
  let cumulative = 0; drawChart('analyticsCumulativeChart', { type: 'line', data: { labels, datasets: [{ label: 'Transferred files', data: days.map(day => cumulative += Number(day.uploadedFiles || 0) + Number(day.downloadedFiles || 0)), borderColor: '#c084fc', backgroundColor: 'rgba(192,132,252,.18)', fill: true, tension: .25 }] }, options: { ...common, scales } });
}

document.querySelectorAll('[data-panel]').forEach(node => node.addEventListener('click', () => setPanel(node.dataset.panel)));
buildDiffColumnHeadings();
applyAutoSyncCopy();
$('btnRefreshDiff').textContent = 'Full Refresh'; $('btnRefreshDiff').setAttribute('aria-label', 'Full Refresh'); $('btnRefreshDiff').title = 'Relist both local and remote folders, including all collapsed subfolders';
$('btnAddHost').addEventListener('click', () => { profiles.push({ name: 'New host', protocol: 'sftp', host: '', username: '', port: 22, remotePath: '/' }); selectedIndex = profiles.length - 1; resetDiffComparison(); renderHosts(); updateRootFields(); scheduleSave(); });
$('btnDeleteHost').addEventListener('click', () => { profiles.splice(selectedIndex, 1); selectedIndex = profiles.length ? 0 : -1; resetDiffComparison(); renderHosts(); renderIgnoreEditor(); updateRootFields(); scheduleSave(); });
$('btnTestHost').addEventListener('click', () => { updateProfile(); const profile = getProfile(); if (profile) vscode.postMessage({ type: 'testConnection', connection: profile }); });
const comparisonIdentityFields = new Set(['hostProtocol', 'hostAddress', 'hostUsername', 'hostPassword', 'hostPort', 'hostSecureMode']);
['hostName','hostProtocol','hostAddress','hostUsername','hostPassword','hostPort','hostSecureMode','hostCollisionPolicy','hostSyncMode','hostAutoSync','hostDefault'].forEach(id => $(id).addEventListener(['hostProtocol','hostSecureMode','hostCollisionPolicy','hostSyncMode','hostAutoSync','hostDefault'].includes(id) ? 'change' : 'input', () => { updateProfile(); if (comparisonIdentityFields.has(id)) resetDiffComparison(); renderHosts(); updateRootFields(); scheduleSave(); }));
$('hostEditor').addEventListener('submit', event => event.preventDefault());
document.querySelectorAll('[data-folder-picker]').forEach(button => { button.setAttribute('aria-haspopup', 'tree'); button.setAttribute('aria-expanded', 'false'); button.addEventListener('click', () => openFolderPicker(button.dataset.folderPicker, button)); });
$('ignoreHost').addEventListener('change', event => { selectedIndex = Number(event.target.value); selectedWorkspacePath = ''; selectedIgnoredPattern = ''; resetDiffComparison(); renderHosts(); renderIgnoreEditor(); updateRootFields(); });
$('btnIgnorePath').addEventListener('click', () => addIgnore(selectedWorkspacePath.endsWith('/') ? `${selectedWorkspacePath}/**` : selectedWorkspacePath));
$('btnRestorePath').addEventListener('click', () => { const profile = getProfile(); if (!profile || !selectedIgnoredPattern) return; profile.ignore = profile.ignore.filter(item => item !== selectedIgnoredPattern); selectedIgnoredPattern = ''; renderIgnoreEditor(); scheduleSave(); resetDiffComparison(); if (visiblePanel() === 'diff') refreshDiff(true); });
$('btnAddManualIgnore').addEventListener('click', () => { addIgnore($('manualIgnore').value); $('manualIgnore').value = ''; }); $('manualIgnore').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addIgnore($('manualIgnore').value); $('manualIgnore').value = ''; } });
$('btnRefreshDiff').addEventListener('click', () => refreshDiff(true)); $('btnUploadDiff').addEventListener('click', () => { const profile = getProfile(); if (profile && selectedPath && !diff.scanning && !diff.invalidated) { progress(true, `Uploading ${selectedPath}`); vscode.postMessage({ type: 'diffAction', action: 'upload', direction: 'local', path: selectedPath, connection: profile }); } }); $('btnDownloadDiff').addEventListener('click', () => { const profile = getProfile(); if (profile && selectedPath && !diff.scanning && !diff.invalidated) { progress(true, `Downloading ${selectedPath}`); vscode.postMessage({ type: 'diffAction', action: 'download', direction: 'remote', path: selectedPath, connection: profile }); } }); $('btnViewDiff').addEventListener('click', () => selectedPath && requestFileDiff(selectedPath));
$('btnSyncChangedUp').addEventListener('click', () => { const profile = getProfile(); if (profile && !diff.scanning && !diff.invalidated) { progress(true, 'Preparing changed files for upload'); vscode.postMessage({ type: 'syncAllChanged', direction: 'up', connection: profile }); } }); $('btnSyncChangedDown').addEventListener('click', () => { const profile = getProfile(); if (profile && !diff.scanning && !diff.invalidated) { progress(true, 'Preparing changed files for download'); vscode.postMessage({ type: 'syncAllChanged', direction: 'down', connection: profile }); } });
$('btnCreateRemoteFolder').addEventListener('click', () => { const profile = getProfile(); if (profile && !diff.scanning) vscode.postMessage({ type: 'createRemoteFolder', connection: profile }); });
$('diffChangedOnly').addEventListener('change', renderDiff); settingIds.forEach(id => $(id).addEventListener('change', scheduleSave)); $('transferConcurrency').addEventListener('input', scheduleSave); $('dashboardZoom').addEventListener('input', () => { applyDashboardZoom($('dashboardZoom').value); scheduleSave(); }); $('remoteExplorerSortOrder').addEventListener('change', scheduleSave); $('analyticsProjectFilter').addEventListener('change', () => vscode.postMessage({ type: 'analyticsFilter', projectId: $('analyticsProjectFilter').value }));
$('btnImportConnections').addEventListener('click', () => vscode.postMessage({ type: 'importConnections' })); $('btnExportConnections').addEventListener('click', () => vscode.postMessage({ type: 'exportConnections', connections: JSON.stringify(profiles), selectedOnly: false })); $('btnExportSelected').addEventListener('click', () => getProfile() && vscode.postMessage({ type: 'exportConnections', connections: JSON.stringify([getProfile()]), selectedOnly: true })); $('btnOpenJson').addEventListener('click', () => vscode.postMessage({ type: 'openJson' }));

window.addEventListener('message', event => { const data = event.data || {};
  if (data.type === 'settings') { setSettings(data.settings || {}); settingsLoaded = true; }
  if (data.type === 'workspaceFiles') { workspaceFiles = Array.isArray(data.workspaceFiles) ? data.workspaceFiles : []; renderIgnoreEditor(); }
  if (data.type === 'folderPicker' && folderPicker?.requestId === data.requestId && folderPicker.kind === data.kind) { const node = folderPicker.nodes.get(data.path) || { children: [] }; node.children = Array.isArray(data.entries) ? data.entries : []; node.loaded = true; node.expanded = true; folderPicker.nodes.set(data.path, node); folderPicker.loading.delete(data.path); renderFolderPicker(data.path); }
  if (data.type === 'folderPickerError' && folderPicker?.requestId === data.requestId && folderPicker.kind === data.kind) { clearFolderPickerLoading(data.path); toast(data.message || 'Unable to browse folders.', 'error'); }
  if (data.type === 'diffStart' && !diff.invalidated) { diff.scanning = true; diff.records.clear(); diff.loadedFolders = new Set(['']); diff.loadingFolders.clear(); $('diffRemoteRoot').value = data.root || '/'; renderDiff(); }
  if (data.type === 'diffBatch' && !diff.invalidated) { (data.records || []).forEach(record => diff.records.set(record.path, record)); renderDiff(); }
  if (data.type === 'diffSnapshot' && !diff.invalidated) { diff.records.clear(); (data.records || []).forEach(record => diff.records.set(record.path, record)); renderDiff(); }
  if (data.type === 'diffScanComplete' && !diff.invalidated) { diff.scanning = false; diff.records.forEach(record => { if (record.type === 'directory') diff.loadedFolders.add(record.path); }); renderDiff(); progress(false, `Comparison updated (${diff.records.size} paths)`, 100); }
  if (data.type === 'diffPatch' && !diff.invalidated) { (data.removed || []).forEach(path => diff.records.delete(path)); (data.records || []).forEach(record => diff.records.set(record.path, record)); if (typeof data.root === 'string') { diff.loadedFolders.add(data.root); diff.loadingFolders.delete(data.root); } renderDiff(); }
  if (data.type === 'diffTransferProgress') progress(Boolean(data.active), data.label || 'Working…', data.percentage);
  if (data.type === 'diffTransferQueue') renderTransferQueue(data.items);
  if (data.type === 'diffActionComplete') { renderDiff(); }
  if (data.type === 'remoteFolderCreated') { toast(data.message || 'Remote folder created.', 'success'); refreshDiff(true); }
  if (data.type === 'diffFile' && data.path === selectedPath) { if (data.direction === 'local') diff.localContent = data.content; else diff.remoteContent = data.content; renderFileDiff(); }
  if (data.type === 'remoteDiffError') { diff.scanning = false; diff.invalidated = true; renderDiff(); clearFolderPickerLoading(); progress(false, 'Unable to refresh file comparison', 100); toast(data.message || 'ITFFTP operation failed.', 'error'); }
  if (data.type === 'saveError') { clearFolderPickerLoading(); if (saveInFlight) progress(false, 'Settings were not saved', 100); saveInFlight = false; toast(data.message || 'ITFFTP operation failed.', 'error'); }
  if (data.type === 'testError') toast(data.message || 'Connection test failed.', 'error');
  if (data.type === 'saveSuccess') { saveInFlight = false; progress(false, 'Settings saved', 100); }
  if (data.type === 'testSuccess') toast(data.message || 'Connection test succeeded.', 'success');
  if (data.type === 'connectionsImported') { profiles = Array.isArray(data.connections) ? data.connections : []; selectedIndex = profiles.length ? 0 : -1; resetDiffComparison(); renderHosts(); renderIgnoreEditor(); updateRootFields(); scheduleSave(); }
  if (data.type === 'analytics') updateAnalytics(data.analytics || {});
});
window.addEventListener('resize', () => positionFolderPicker(document.querySelector('.folder-tree-popover')));
renderHostEditor(); renderIgnoreEditor(); updateRootFields(); renderDiff();
vscode.postMessage({ type: 'ready' });

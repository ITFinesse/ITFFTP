const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const settingIds = ['autoConnect', 'autoReconnect', 'autoRefresh', 'showHiddenFiles', 'confirmDelete', 'confirmSync', 'showWebMasterTools', 'enableFileWatcher', 'defaultSyntaxHighlighting', 'useNativeTreeView', 'downloadWhenOpenInRemoteExplorer'];
const panelCopy = { hosts: ['Hosts', 'Manage remote locations and choose the workspace default.'], settings: ['Settings', 'Compact workspace-wide transfer and explorer preferences.'], ignores: ['Ignores', 'Move workspace files between transfer scope and ignored patterns.'], diff: ['Diff Viewer', 'Compare matching local and remote paths in one tree.'], analytics: ['Analytics', 'Transfer activity recorded for this workspace.'] };

let profiles = [], selectedIndex = -1, workspaceFiles = [], selectedWorkspacePath = '', selectedIgnoredPattern = '';
let settingsLoaded = false, saveTimer, selectedPath = '', selectedSide = 'local';
const diff = { records: new Map(), collapsed: new Set(), localContent: '', remoteContent: '' };
const getProfile = () => selectedIndex >= 0 ? profiles[selectedIndex] : undefined;
const labelFor = (profile, index) => profile.name || profile.host || `Host ${index + 1}`;

function toast(text, kind = 'info') {
  const region = $('toastRegion'); if (!region || !text) return;
  const item = document.createElement('div'); item.className = `toast toast-${kind}`; item.textContent = text; region.replaceChildren(item);
  setTimeout(() => item.classList.add('toast-leave'), 8000); setTimeout(() => item.remove(), 11000);
}
function setPanel(name) {
  document.querySelectorAll('[data-panel-content]').forEach(node => node.classList.toggle('hidden', node.dataset.panelContent !== name));
  document.querySelectorAll('[data-panel]').forEach(node => node.classList.toggle('is-active', node.dataset.panel === name));
  $('pageTitle').textContent = panelCopy[name][0]; $('pageDescription').textContent = panelCopy[name][1];
  if (name === 'diff' && !diff.records.size) refreshDiff();
}
function autoSyncFor(profile) { return profile.uploadOnSave && profile.downloadOnOpen ? 'both' : profile.uploadOnSave ? 'upload' : profile.downloadOnOpen ? 'download' : 'off'; }
function renderHosts() {
  $('hostCount').textContent = `${profiles.length} host${profiles.length === 1 ? '' : 's'}`;
  $('hostList').innerHTML = profiles.length ? profiles.map((profile, index) => `<button class="host-row ${index === selectedIndex ? 'is-selected' : ''}" type="button" data-host="${index}"><span class="host-status"></span><span class="host-name">${esc(labelFor(profile, index))}${profile.default ? '<span class="default-tag">Default</span>' : ''}</span><span class="host-meta">${esc(profile.host || 'Host not set')} / ${esc(profile.username || 'User not set')}</span><span class="host-protocol">${esc(profile.protocol || 'sftp')}</span></button>`).join('') : '<div class="host-empty">No remote locations yet. Add a host to begin.</div>';
  $('hostList').querySelectorAll('[data-host]').forEach(node => node.addEventListener('click', () => { selectedIndex = Number(node.dataset.host); renderHosts(); renderIgnoreEditor(); }));
  renderHostEditor();
}
function renderHostEditor() {
  const profile = getProfile(); const ids = ['hostName', 'hostProtocol', 'hostAddress', 'hostUsername', 'hostPassword', 'hostPort', 'hostRemotePath', 'hostCollisionPolicy', 'hostSyncMode', 'hostAutoSync', 'hostDefault'];
  ids.forEach(id => { $(id).disabled = !profile; }); $('btnTestHost').classList.toggle('hidden', !profile); $('btnDeleteHost').classList.toggle('hidden', !profile);
  $('editorTitle').textContent = profile ? labelFor(profile, selectedIndex) : 'Select a host'; $('editorNote').textContent = profile ? 'Changes save automatically after two seconds.' : 'Choose a remote location or add a new one.';
  if (!profile) return;
  $('hostName').value = profile.name || ''; $('hostProtocol').value = profile.protocol || 'sftp'; $('hostAddress').value = profile.host || ''; $('hostUsername').value = profile.username || ''; $('hostPassword').value = profile.password || ''; $('hostPort').value = profile.port || ''; $('hostRemotePath').value = profile.remotePath || '/'; $('hostCollisionPolicy').value = profile.collisionPolicy || 'ask'; $('hostSyncMode').value = profile.syncMode || 'update'; $('hostAutoSync').value = autoSyncFor(profile); $('hostDefault').checked = Boolean(profile.default);
}
function updateProfile() {
  const profile = getProfile(); if (!profile) return;
  profile.name = $('hostName').value.trim() || undefined; profile.protocol = $('hostProtocol').value; profile.host = $('hostAddress').value.trim(); profile.username = $('hostUsername').value.trim(); profile.password = $('hostPassword').value || undefined;
  const port = Number($('hostPort').value); profile.port = Number.isInteger(port) && port > 0 ? port : undefined; profile.remotePath = $('hostRemotePath').value.trim() || '/'; profile.collisionPolicy = $('hostCollisionPolicy').value; profile.syncMode = $('hostSyncMode').value;
  const mode = $('hostAutoSync').value; profile.uploadOnSave = mode === 'upload' || mode === 'both'; profile.downloadOnOpen = mode === 'download' || mode === 'both';
  if ($('hostDefault').checked) profiles.forEach((candidate, index) => { candidate.default = index === selectedIndex; }); else profile.default = false;
}
function isIgnored(path, patterns) {
  const clean = path.replace(/^\/+|\/+$/g, '');
  return patterns.some(pattern => { const value = String(pattern || '').replace(/^\/+|\/+$/g, ''); return value.endsWith('/**') ? clean === value.slice(0, -3) || clean.startsWith(value.slice(0, -3) + '/') : value === clean || (value && clean.split('/').includes(value)); });
}
function workspaceTreePaths() { return workspaceFiles.filter(path => !isIgnored(path, getProfile()?.ignore || [])); }
function renderPathList(id, values, selected, onSelect, empty) {
  const list = $(id); list.innerHTML = values.length ? values.map(path => `<button class="path-row ${path === selected ? 'is-selected' : ''}" type="button" data-path="${esc(path)}">${esc(path)}</button>`).join('') : `<div class="empty-state">${esc(empty)}</div>`;
  list.querySelectorAll('[data-path]').forEach(node => node.addEventListener('click', () => onSelect(node.dataset.path)));
}
function renderIgnoreEditor() {
  const select = $('ignoreHost'); select.innerHTML = profiles.length ? profiles.map((profile, index) => `<option value="${index}">${esc(labelFor(profile, index))}</option>`).join('') : '<option value="">No hosts configured</option>'; select.disabled = !profiles.length; select.value = selectedIndex >= 0 ? String(selectedIndex) : '';
  renderPathList('workspaceFileList', workspaceTreePaths(), selectedWorkspacePath, path => { selectedWorkspacePath = path; renderIgnoreEditor(); }, 'No workspace files outside the ignore list.');
  renderPathList('ignoredPatternList', getProfile()?.ignore || [], selectedIgnoredPattern, path => { selectedIgnoredPattern = path; renderIgnoreEditor(); }, 'Nothing ignored yet.');
}
function addIgnore(pattern) {
  const profile = getProfile(); const clean = String(pattern || '').trim(); if (!profile || !clean) return;
  profile.ignore = [...new Set([...(profile.ignore || []), clean])]; selectedIgnoredPattern = clean; selectedWorkspacePath = '';
  renderIgnoreEditor(); renderDiff(); scheduleSave();
}
function readSettings() { updateProfile(); const value = {}; settingIds.forEach(id => { value[id] = Boolean($(id).checked); }); value.transferConcurrency = Number($('transferConcurrency').value); value.dashboardZoom = Number($('dashboardZoom').value); value.remoteExplorerSortOrder = $('remoteExplorerSortOrder').value; value.connections = JSON.stringify(profiles); return value; }
function scheduleSave() { if (!settingsLoaded) return; clearTimeout(saveTimer); $('autoSaveStatus').textContent = 'Waiting for changes…'; saveTimer = setTimeout(() => { vscode.postMessage({ type: 'saveSettings', settings: readSettings() }); $('autoSaveStatus').textContent = 'Saving…'; }, 2000); }
function setSettings(settings) {
  settingIds.forEach(id => { if ($(id)) $(id).checked = Boolean(settings[id]); }); $('transferConcurrency').max = '100'; $('transferConcurrency').value = settings.transferConcurrency || 4; $('dashboardZoom').value = settings.dashboardZoom || 110; applyDashboardZoom(settings.dashboardZoom || 110); $('remoteExplorerSortOrder').value = settings.remoteExplorerSortOrder || 'name';
  try { const parsed = JSON.parse(settings.connections || '[]'); profiles = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []; } catch { profiles = []; toast('Unable to read connection profiles.', 'error'); }
  selectedIndex = profiles.length ? 0 : -1; $('diffRemoteRoot').value = getProfile()?.remotePath || '/'; renderHosts(); renderIgnoreEditor(); updateAnalytics(settings.analytics || {});
}

function treeRecords() {
  const changedOnly = $('diffChangedOnly').checked; const records = [...diff.records.values()];
  const visible = new Set(records.filter(record => !changedOnly || record.status !== 'same').map(record => record.path));
  for (const path of [...visible]) { let parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''; while (parent) { visible.add(parent); parent = parent.includes('/') ? parent.slice(0, parent.lastIndexOf('/')) : ''; } }
  return records.filter(record => visible.has(record.path));
}
function renderDiffTree(side) {
  const children = new Map([['', []]]);
  treeRecords().forEach(record => { const parent = record.path.includes('/') ? record.path.slice(0, record.path.lastIndexOf('/')) : ''; if (!children.has(parent)) children.set(parent, []); children.get(parent).push(record); });
  const rows = [];
  const addChildren = (parent, depth) => {
    const entries = (children.get(parent) || []).sort((left, right) => left.type === right.type ? left.path.localeCompare(right.path) : left.type === 'directory' ? -1 : 1);
    for (const record of entries) {
    const parts = record.path.split('/');
    const folder = record.type === 'directory'; const present = side === 'local' ? record.local : record.remote; const state = present ? record.status : (side === 'local' ? 'missing-local' : 'missing-remote');
    rows.push(`<button type="button" role="treeitem" class="file-row ${folder ? 'is-folder' : 'is-file'} ${selectedPath === record.path && selectedSide === side ? 'is-selected' : ''} ${present ? '' : 'is-placeholder'} status-${esc(state)}" data-path="${esc(record.path)}" data-side="${side}" data-folder="${folder ? 'true' : ''}" style="padding-left:${12 + depth * 16}px"><span class="codicon ${folder ? (diff.collapsed.has(record.path) ? 'codicon-chevron-right' : 'codicon-chevron-down') : 'codicon-file'}"></span><span class="tree-name">${esc(parts.at(-1))}</span><span class="file-status ${esc(state)}">${present ? esc(state.replace('-', ' ')) : side === 'local' ? 'missing locally' : 'missing remotely'}</span></button>`);
    if (folder && !diff.collapsed.has(record.path)) addChildren(record.path, depth + 1);
    }
  }
  addChildren('', 0);
  return rows.length ? rows.join('') : '<div class="empty-state">No changed paths match this filter.</div>';
}
function renderDiff() {
  const count = treeRecords().length; $('diffLocalCount').textContent = `${count} paths`; $('diffRemoteCount').textContent = `${count} paths`; $('diffLocalList').innerHTML = renderDiffTree('local'); $('diffRemoteList').innerHTML = renderDiffTree('remote');
  document.querySelectorAll('#diffLocalList [data-path], #diffRemoteList [data-path]').forEach(node => {
    node.addEventListener('click', () => { const path = node.dataset.path; const side = node.dataset.side; selectedPath = path; selectedSide = side; if (node.dataset.folder === 'true') { diff.collapsed.has(path) ? diff.collapsed.delete(path) : diff.collapsed.add(path); } else requestFileDiff(path); renderDiff(); });
    node.addEventListener('contextmenu', event => { event.preventDefault(); selectedPath = node.dataset.path; selectedSide = node.dataset.side; renderDiff(); showContext(event.clientX, event.clientY, selectedPath, selectedSide, node.dataset.folder === 'true'); });
  });
}
function refreshDiff() { diff.records.clear(); $('diffFileView').replaceChildren(); vscode.postMessage({ type: 'loadDiffRemote', connection: getProfile(), force: true }); }
function requestFileDiff(path) { diff.localContent = ''; diff.remoteContent = ''; vscode.postMessage({ type: 'readDiffFile', direction: 'local', path, connection: getProfile() }); vscode.postMessage({ type: 'readDiffFile', direction: 'remote', path, connection: getProfile() }); }
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
  if (!diff.localContent || !diff.remoteContent) { $('diffFileView').innerHTML = `<div class="diff-file-heading"><h3>Diff file view <span>${esc(selectedPath)}</span></h3></div><div class="diff-loading">Loading both files…</div>`; return; }
  const rows = alignedLineDiff(diff.localContent, diff.remoteContent); const changed = rows.filter(row => row.type !== 'equal').length;
  $('diffFileView').innerHTML = `<div class="diff-file-heading"><h3>Diff file view <span>${esc(selectedPath)}</span></h3><span>${changed ? `${changed} changed line${changed === 1 ? '' : 's'}` : 'Files are identical'}</span></div><div class="diff-editor-header"><strong>Local</strong><strong>Remote</strong></div><div class="diff-editor-body"><div class="diff-code-pane" data-diff-pane="local">${rows.map(row => diffCell('local', row.left, row.leftLine, row.type)).join('')}</div><div class="diff-code-pane" data-diff-pane="remote">${rows.map(row => diffCell('remote', row.right, row.rightLine, row.type)).join('')}</div></div>`;
  const panes = [...$('diffFileView').querySelectorAll('[data-diff-pane]')]; let syncing = false; panes.forEach((pane, index) => pane.addEventListener('scroll', () => { if (syncing) return; syncing = true; panes[1 - index].scrollTop = pane.scrollTop; panes[1 - index].scrollLeft = pane.scrollLeft; requestAnimationFrame(() => { syncing = false; }); }));
}
function showContext(x, y, path, side, folder) {
  document.querySelector('.diff-context-menu')?.remove(); const menu = document.createElement('div'); menu.className = 'diff-context-menu'; menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:1000`;
  menu.innerHTML = `<button data-action="upload"><span class="codicon codicon-cloud-upload"></span>Upload to remote</button><button data-action="download"><span class="codicon codicon-cloud-download"></span>Download to local</button><button data-action="ignore"><span class="codicon codicon-exclude"></span>Add to ignore</button><button data-action="rename"><span class="codicon codicon-edit"></span>Rename</button><button class="danger" data-action="delete"><span class="codicon codicon-trash"></span>Delete ${side}</button>`;
  document.body.append(menu); menu.querySelectorAll('button').forEach(button => button.addEventListener('click', () => { const action = button.dataset.action; menu.remove(); if (action === 'ignore') return addIgnore(folder ? `${path}/**` : path); progress(true, `${action === 'upload' ? 'Uploading' : action === 'download' ? 'Downloading' : action === 'delete' ? 'Deleting' : 'Renaming'} ${path}`); vscode.postMessage({ type: 'diffAction', action, direction: action === 'upload' ? 'local' : action === 'download' ? 'remote' : side, path: folder ? `${path}/` : path, connection: getProfile() }); }));
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}
function applyDashboardZoom(value) { document.documentElement.style.zoom = `${Math.min(160, Math.max(80, Number(value) || 110))}%`; }
function progress(active, label, percentage) { const determinate = Number.isFinite(Number(percentage)); const amount = Math.min(100, Math.max(0, determinate ? Number(percentage) : (active ? 0 : 100))); $('diffTransferLabel').textContent = label; $('diffTransferPercent').textContent = active && !determinate ? 'Working' : `${Math.round(amount)}%`; $('diffTransferProgress').style.setProperty('--progress', `${amount}%`); $('diffTransferProgress').classList.toggle('is-active', active); $('diffTransferProgress').classList.toggle('is-indeterminate', active && !determinate); }
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
$('btnAddHost').addEventListener('click', () => { profiles.push({ name: 'New host', protocol: 'sftp', host: '', username: '', port: 22, remotePath: '/' }); selectedIndex = profiles.length - 1; renderHosts(); scheduleSave(); });
$('btnDeleteHost').addEventListener('click', () => { profiles.splice(selectedIndex, 1); selectedIndex = profiles.length ? 0 : -1; renderHosts(); renderIgnoreEditor(); scheduleSave(); });
$('btnTestHost').addEventListener('click', () => { updateProfile(); vscode.postMessage({ type: 'testConnection', connection: getProfile() }); });
['hostName','hostProtocol','hostAddress','hostUsername','hostPassword','hostPort','hostRemotePath','hostCollisionPolicy','hostSyncMode','hostAutoSync','hostDefault'].forEach(id => $(id).addEventListener(['hostProtocol','hostCollisionPolicy','hostSyncMode','hostAutoSync','hostDefault'].includes(id) ? 'change' : 'input', () => { updateProfile(); renderHosts(); scheduleSave(); }));
$('ignoreHost').addEventListener('change', event => { selectedIndex = Number(event.target.value); selectedWorkspacePath = ''; selectedIgnoredPattern = ''; renderHosts(); renderIgnoreEditor(); });
$('btnIgnorePath').addEventListener('click', () => addIgnore(selectedWorkspacePath.endsWith('/') ? `${selectedWorkspacePath}/**` : selectedWorkspacePath));
$('btnRestorePath').addEventListener('click', () => { const profile = getProfile(); if (!profile || !selectedIgnoredPattern) return; profile.ignore = profile.ignore.filter(item => item !== selectedIgnoredPattern); selectedIgnoredPattern = ''; renderIgnoreEditor(); renderDiff(); scheduleSave(); });
$('btnAddManualIgnore').addEventListener('click', () => addIgnore($('manualIgnore').value)); $('manualIgnore').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addIgnore($('manualIgnore').value); } });
$('btnRefreshDiff').addEventListener('click', refreshDiff); $('btnUploadDiff').addEventListener('click', () => selectedPath && vscode.postMessage({ type: 'diffAction', action: 'upload', direction: 'local', path: selectedPath, connection: getProfile() })); $('btnDownloadDiff').addEventListener('click', () => selectedPath && vscode.postMessage({ type: 'diffAction', action: 'download', direction: 'remote', path: selectedPath, connection: getProfile() }));
$('btnSyncChangedUp').addEventListener('click', () => vscode.postMessage({ type: 'syncAllChanged', direction: 'up' })); $('btnSyncChangedDown').addEventListener('click', () => vscode.postMessage({ type: 'syncAllChanged', direction: 'down' }));
['diffChangedOnly', 'diffHideIgnored', 'diffFollow'].forEach(id => $(id).addEventListener('change', renderDiff)); settingIds.forEach(id => $(id).addEventListener('change', scheduleSave)); $('transferConcurrency').addEventListener('input', scheduleSave); $('dashboardZoom').addEventListener('input', () => { applyDashboardZoom($('dashboardZoom').value); scheduleSave(); }); $('remoteExplorerSortOrder').addEventListener('change', scheduleSave); $('analyticsProjectFilter').addEventListener('change', () => vscode.postMessage({ type: 'analyticsFilter', projectId: $('analyticsProjectFilter').value }));
$('btnImportConnections').addEventListener('click', () => vscode.postMessage({ type: 'importConnections' })); $('btnExportConnections').addEventListener('click', () => vscode.postMessage({ type: 'exportConnections', connections: JSON.stringify(profiles), selectedOnly: false })); $('btnExportSelected').addEventListener('click', () => getProfile() && vscode.postMessage({ type: 'exportConnections', connections: JSON.stringify([getProfile()]), selectedOnly: true })); $('btnOpenJson').addEventListener('click', () => vscode.postMessage({ type: 'openJson' }));

window.addEventListener('message', event => { const data = event.data || {};
  if (data.type === 'settings') { setSettings(data.settings || {}); settingsLoaded = true; }
  if (data.type === 'workspaceFiles') { workspaceFiles = Array.isArray(data.workspaceFiles) ? data.workspaceFiles : []; renderIgnoreEditor(); }
  if (data.type === 'diffStart') { diff.records.clear(); $('diffRemoteRoot').value = data.root || '/'; renderDiff(); }
  if (data.type === 'diffBatch' || data.type === 'diffScanComplete') { (data.records || []).forEach(record => diff.records.set(record.path, record)); renderDiff(); }
  if (data.type === 'diffPatch') { (data.removed || []).forEach(path => diff.records.delete(path)); (data.records || []).forEach(record => diff.records.set(record.path, record)); renderDiff(); }
  if (data.type === 'diffTransferProgress') progress(Boolean(data.active), data.label || 'Working…', data.percentage);
  if (data.type === 'diffActionComplete') { renderDiff(); }
  if (data.type === 'diffFile' && data.path === selectedPath) { if (data.direction === 'local') diff.localContent = data.content; else diff.remoteContent = data.content; renderFileDiff(); }
  if (data.type === 'remoteDiffError' || data.type === 'saveError' || data.type === 'testError') toast(data.message || 'ITFFTP operation failed.', 'error');
  if (data.type === 'saveSuccess') { $('autoSaveStatus').textContent = 'All changes saved.'; toast('Settings saved automatically.', 'success'); }
  if (data.type === 'testSuccess') toast(data.message || 'Connection test succeeded.', 'success');
  if (data.type === 'connectionsImported') { profiles = Array.isArray(data.connections) ? data.connections : []; selectedIndex = profiles.length ? 0 : -1; renderHosts(); renderIgnoreEditor(); scheduleSave(); }
  if (data.type === 'analytics') updateAnalytics(data.analytics || {});
});
vscode.postMessage({ type: 'ready' });

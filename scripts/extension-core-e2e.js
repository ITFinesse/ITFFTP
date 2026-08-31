/*
 * Credential-safe real-server smoke test for the ITFFTP core transfer path.
 *
 * This deliberately does not use basic-ftp directly. It bundles the actual
 * FTPConnection and TransferManager with a minimal VS Code API shim, then uses
 * the configured test roots. Network execution is opt-in:
 *
 *   $env:ITFFTP_RUN_CORE_E2E='1'; node scripts/extension-core-e2e.js --run
 *
 * The FileWatcher needs VS Code's workspace watcher runtime and is therefore
 * explicitly reported as unavailable here. Use --require-watcher to make that
 * limitation a failing condition rather than mistaking this for watcher proof.
 */

'use strict';

const crypto = require('crypto');
const esbuild = require('esbuild');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repositoryRoot = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function parseConfig() {
  const configPath = path.join(repositoryRoot, '.vscode', 'sftp.json');
  if (!fs.existsSync(configPath)) { fail('CONFIG_MISSING'); }
  const raw = fs.readFileSync(configPath, 'utf8');
  const withoutComments = raw.replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (match, comment) => comment ? '' : match);
  const parsed = JSON.parse(withoutComments);
  const configs = Array.isArray(parsed) ? parsed : [parsed];
  const config = configs.find(candidate => candidate && candidate.default) || configs[0];
  if (!config || !['ftp', 'ftps'].includes(config.protocol)) { fail('CONFIG_UNSUPPORTED_PROTOCOL'); }
  if (!config.host || !config.username || !config.password) { fail('CONFIG_INCOMPLETE'); }
  return config;
}

function normaliseRemoteRoot(remotePath) {
  const normalised = path.posix.normalize(`/${String(remotePath || '').replace(/\\/g, '/')}`)
    .replace(/\/+$/, '') || '/';
  // The configured integration target is intentionally a test-only location.
  if (normalised !== '/public_html/test') { fail('REMOTE_ROOT_NOT_TEST_TARGET'); }
  return normalised;
}

function assertRemoteChild(root, child) {
  const relative = path.posix.relative(root, child);
  if (!relative || relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
    fail('UNSAFE_REMOTE_CHILD');
  }
}

function resolveLocalRoot(config) {
  if (!config.localPath) { fail('LOCAL_ROOT_MISSING'); }
  const candidate = path.isAbsolute(config.localPath)
    ? config.localPath
    : path.resolve(repositoryRoot, config.localPath);
  const localRoot = fs.realpathSync(candidate);
  if (!fs.statSync(localRoot).isDirectory()) { fail('LOCAL_ROOT_NOT_DIRECTORY'); }
  return localRoot;
}

function assertLocalChild(root, child) {
  const relative = path.relative(root, child);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('UNSAFE_LOCAL_CHILD');
  }
}

function makeVscodeShim() {
  return `
    const disposable = () => ({ dispose() {} });
    const statusBarItem = () => ({ show() {}, hide() {}, dispose() {}, text: '', tooltip: '', command: undefined, name: '', color: undefined });
    class EventEmitter {
      constructor() { this.event = () => disposable(); }
      fire() {}
      dispose() {}
    }
    module.exports = {
      StatusBarAlignment: { Left: 1, Right: 2 },
      ThemeColor: class ThemeColor { constructor(value) { this.value = value; } },
      EventEmitter,
      window: {
        createOutputChannel: () => ({ appendLine() {}, show() {}, clear() {}, dispose() {} }),
        createStatusBarItem: statusBarItem,
        showWarningMessage: async () => 'Overwrite',
        showErrorMessage: async () => undefined,
        showInformationMessage: async () => undefined
      },
      workspace: {
        workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
        getConfiguration: () => ({ get: (_key, fallback) => fallback, update: async () => undefined }),
        onDidChangeConfiguration: () => disposable()
      }
    };
  `;
}

async function loadCoreClasses() {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'itfftp-core-e2e-bundle-'));
  const outputPath = path.join(temporaryDirectory, 'core.js');

  try {
    await esbuild.build({
      absWorkingDir: repositoryRoot,
      entryPoints: ['itfftp-core-e2e-entry'],
      bundle: true,
      format: 'cjs',
      platform: 'node',
      target: 'node20',
      outfile: outputPath,
      external: ['cpu-features'],
      plugins: [{
        name: 'itfftp-core-e2e-vscode-shim',
        setup(build) {
          build.onResolve({ filter: /^itfftp-core-e2e-entry$/ }, () => ({ path: 'entry', namespace: 'itfftp-e2e' }));
          build.onLoad({ filter: /.*/, namespace: 'itfftp-e2e' }, () => ({
            contents: `import { connectionManager } from './src/core/connection-manager'; import { TransferManager } from './src/core/transfer-manager'; module.exports = { connectionManager, TransferManager };`,
            loader: 'js',
            resolveDir: repositoryRoot
          }));
          build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'itfftp-e2e-vscode' }));
          build.onLoad({ filter: /.*/, namespace: 'itfftp-e2e-vscode' }, () => ({ contents: makeVscodeShim(), loader: 'js' }));
        }
      }]
    });
    return { classes: require(outputPath), temporaryDirectory };
  } catch (error) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function completed(outcome) {
  if (!outcome || outcome.status !== 'completed') { fail('TRANSFER_NOT_COMPLETED'); }
}

function writeFile(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function requestedBulkCount() {
  const values = process.argv.slice(2)
    .filter(argument => argument.startsWith('--bulk='))
    .map(argument => argument.slice('--bulk='.length));
  if (values.length === 0) { return 0; }
  if (values.length !== 1 || !/^\d+$/.test(values[0])) { fail('INVALID_BULK_COUNT'); }
  const count = Number(values[0]);
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000) { fail('BULK_COUNT_OUT_OF_RANGE'); }
  return count;
}

function requestedWatcherProbeMode() {
  const values = process.argv.slice(2)
    .filter(argument => argument.startsWith('--watcher-probe='))
    .map(argument => argument.slice('--watcher-probe='.length));
  if (values.length === 0) { return undefined; }
  if (values.length !== 1 || !['upload', 'download', 'both', 'off'].includes(values[0])) {
    fail('INVALID_WATCHER_PROBE_MODE');
  }
  return values[0];
}

function bulkRelativePath(index) {
  const group = String(Math.floor(index / 50)).padStart(3, '0');
  const nested = String(Math.floor(index / 10) % 5).padStart(2, '0');
  return path.posix.join('bulk', `group-${group}`, `nested-${nested}`, `file-${String(index).padStart(5, '0')}.txt`);
}

async function listRemoteFiles(connection, remoteDirectory) {
  const pending = [remoteDirectory];
  const files = new Map();
  while (pending.length > 0) {
    const directory = pending.shift();
    const entries = await connection.list(directory);
    for (const entry of entries) {
      if (entry.type === 'directory' || entry.isSymlinkToDirectory) {
        pending.push(entry.path);
      } else if (entry.type === 'file') {
        files.set(entry.path, entry.size);
      } else {
        fail('UNEXPECTED_REMOTE_ENTRY_TYPE');
      }
    }
  }
  return files;
}

async function waitForCondition(check, timeoutMs, failureCode) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) { return; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  fail(failureCode);
}

async function runWatcherProbe(mode) {
  const config = parseConfig();
  const remoteRoot = normaliseRemoteRoot(config.remotePath);
  const localRoot = resolveLocalRoot(config);
  const suffix = `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const remoteChild = path.posix.join(remoteRoot, `itfftp-watcher-probe-${suffix}`);
  const localChild = path.join(localRoot, `itfftp-watcher-probe-${suffix}`);
  assertRemoteChild(remoteRoot, remoteChild);
  assertLocalChild(localRoot, localChild);

  const { classes, temporaryDirectory } = await loadCoreClasses();
  const proofDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'itfftp-watcher-probe-proof-'));
  const connectionManager = classes.connectionManager;
  const e2eConfig = { ...config, remotePath: remoteRoot, localPath: localRoot, keepalive: 0 };
  let connection;
  let remoteCreated = false;
  const startedAt = Date.now();
  const checks = { uploadLatestBytes: false, downloadLatestBytes: false, noPropagation: false };

  const content = label => `${label}-${crypto.randomBytes(24).toString('hex')}\n`;
  const writeRemote = async (remotePath, text) => {
    const staging = path.join(proofDirectory, `staging-${crypto.randomBytes(6).toString('hex')}.txt`);
    writeFile(staging, text);
    await connection.upload(staging, remotePath);
    fs.rmSync(staging, { force: true });
  };
  const remoteMatches = async (remotePath, expectedText) => {
    const proof = path.join(proofDirectory, `proof-${crypto.randomBytes(6).toString('hex')}.txt`);
    try {
      await connection.download(remotePath, proof);
      return fs.readFileSync(proof, 'utf8') === expectedText;
    } catch {
      return false;
    } finally {
      fs.rmSync(proof, { force: true });
    }
  };
  const preparePair = async name => {
    const localPath = path.join(localChild, name);
    const remotePath = path.posix.join(remoteChild, name);
    const baseline = content(`${name}-baseline`);
    writeFile(localPath, baseline);
    await writeRemote(remotePath, baseline);
    return { localPath, remotePath, baseline };
  };
  const testUpload = async () => {
    const pair = await preparePair('upload-probe.txt');
    await new Promise(resolve => setTimeout(resolve, 2500));
    writeFile(pair.localPath, content('upload-first-edit'));
    await new Promise(resolve => setTimeout(resolve, 1100));
    const latest = content('upload-second-edit');
    writeFile(pair.localPath, latest);
    await waitForCondition(() => remoteMatches(pair.remotePath, latest), 30_000, 'WATCHER_UPLOAD_TIMEOUT');
    checks.uploadLatestBytes = true;
  };
  const testDownload = async () => {
    const pair = await preparePair('download-probe.txt');
    await new Promise(resolve => setTimeout(resolve, 2500));
    await writeRemote(pair.remotePath, content('download-first-edit'));
    await new Promise(resolve => setTimeout(resolve, 1100));
    const latest = content('download-second-edit');
    await writeRemote(pair.remotePath, latest);
    await waitForCondition(
      async () => fs.existsSync(pair.localPath) && fs.readFileSync(pair.localPath, 'utf8') === latest,
      45_000,
      'WATCHER_DOWNLOAD_TIMEOUT'
    );
    checks.downloadLatestBytes = true;
  };
  const testOff = async () => {
    const uploadPair = await preparePair('off-upload-probe.txt');
    const downloadPair = await preparePair('off-download-probe.txt');
    await new Promise(resolve => setTimeout(resolve, 2500));
    writeFile(uploadPair.localPath, content('off-local-edit'));
    await writeRemote(downloadPair.remotePath, content('off-remote-edit'));
    await new Promise(resolve => setTimeout(resolve, 35_000));
    const remoteStayedBaseline = await remoteMatches(uploadPair.remotePath, uploadPair.baseline);
    const localStayedBaseline = fs.existsSync(downloadPair.localPath)
      && fs.readFileSync(downloadPair.localPath, 'utf8') === downloadPair.baseline;
    if (!remoteStayedBaseline || !localStayedBaseline) { fail('WATCHER_OFF_PROPAGATED_CHANGE'); }
    checks.noPropagation = true;
  };

  try {
    connection = await connectionManager.connect(e2eConfig);
    await connection.mkdir(remoteChild);
    remoteCreated = true;
    fs.mkdirSync(localChild, { recursive: false });
    if (mode === 'upload' || mode === 'both') { await testUpload(); }
    if (mode === 'download' || mode === 'both') { await testDownload(); }
    if (mode === 'off') { await testOff(); }
    return {
      suite: 'extension-watcher-probe',
      status: 'completed',
      mode,
      editPauseMs: 1100,
      checks,
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      suite: 'extension-watcher-probe',
      status: 'failed',
      mode,
      editPauseMs: 1100,
      checks,
      durationMs: Date.now() - startedAt,
      error: error && error.code ? String(error.code) : 'WATCHER_PROBE_FAILED'
    };
  } finally {
    try {
      // The active extension may observe cleanup events, so verify both sides
      // are absent after a short bounded settle and repeat only this child.
      let cleaned = false;
      for (let attempt = 0; attempt < 3 && !cleaned; attempt++) {
        if (connection?.connected && remoteCreated) {
          const target = await connection.stat(remoteChild);
          if (target) { await connection.rmdir(remoteChild, true); }
        }
        fs.rmSync(localChild, { recursive: true, force: true });
        await new Promise(resolve => setTimeout(resolve, 1200));
        const remoteAbsent = !remoteCreated || !connection?.connected || !(await connection.stat(remoteChild));
        cleaned = remoteAbsent && !fs.existsSync(localChild);
      }
      if (fs.existsSync(localChild)) { fail('WATCHER_PROBE_LOCAL_CLEANUP_FAILED'); }
      if (connection?.connected && remoteCreated && await connection.stat(remoteChild)) {
        fail('WATCHER_PROBE_REMOTE_CLEANUP_FAILED');
      }
    } finally {
      try { await connectionManager.disconnect(e2eConfig); } catch { /* connection is already closing */ }
      fs.rmSync(localChild, { recursive: true, force: true });
      fs.rmSync(proofDirectory, { recursive: true, force: true });
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

function validateWatcherProbe(mode) {
  const config = parseConfig();
  normaliseRemoteRoot(config.remotePath);
  resolveLocalRoot(config);
  return {
    suite: 'extension-watcher-probe',
    status: 'ready',
    network: 'not-run',
    mode,
    editPauseMs: 1100,
    boundedWaitMs: { upload: 30_000, download: 45_000, off: 35_000 },
    requirement: 'rebuilt extension active with the matching watcher mode'
  };
}

async function runBulkPhase(transfers, connection, config, localChild, remoteChild, count) {
  if (count === 0) { return { status: 'not-requested', files: 0, durationMs: 0 }; }
  const startedAt = Date.now();
  const files = Array.from({ length: count }, (_, index) => {
    const relativePath = bulkRelativePath(index);
    const localPath = path.join(localChild, ...relativePath.split('/'));
    const remotePath = path.posix.join(remoteChild, relativePath);
    writeFile(localPath, `bulk-transfer-${index}-${Date.now()}\n`);
    return { localPath, remotePath, size: fs.statSync(localPath).size };
  });

  // A real folder upload creates its directory tree before enqueuing files.
  // Reproduce that lifecycle here while still sending the files through the
  // concurrent TransferManager workers and connection pool.
  const remoteDirectories = [...new Set(files.map(file => path.posix.dirname(file.remotePath)))]
    .sort((left, right) => left.split('/').length - right.split('/').length);
  for (const remoteDirectory of remoteDirectories) {
    await connection.mkdir(remoteDirectory);
  }

  const settled = await Promise.allSettled(
    files.map(file => transfers.uploadFile(connection, file.localPath, file.remotePath, config))
  );
  const rejected = settled.find(result => result.status === 'rejected');
  if (rejected) {throw rejected.reason;}
  settled.forEach(result => completed(result.value));

  const listed = await listRemoteFiles(connection, path.posix.join(remoteChild, 'bulk'));
  if (listed.size !== files.length) { fail('BULK_REMOTE_COUNT_MISMATCH'); }
  for (const file of files) {
    if (listed.get(file.remotePath) !== file.size) { fail('BULK_REMOTE_SIZE_MISMATCH'); }
  }
  return { status: 'completed', files: files.length, sizeChecks: files.length, durationMs: Date.now() - startedAt };
}

async function run() {
  const config = parseConfig();
  const remoteRoot = normaliseRemoteRoot(config.remotePath);
  const localRoot = resolveLocalRoot(config);
  const bulkCount = requestedBulkCount();
  const remoteChild = path.posix.join(remoteRoot, `.itfftp-core-e2e-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`);
  assertRemoteChild(remoteRoot, remoteChild);
  const localChild = fs.mkdtempSync(path.join(localRoot, '.itfftp-core-e2e-'));
  assertLocalChild(localRoot, localChild);

  const { classes, temporaryDirectory } = await loadCoreClasses();
  const e2eConfig = { ...config, remotePath: remoteRoot, localPath: localRoot, collisionPolicy: 'overwrite', syncMode: 'full', keepalive: 0 };
  const connectionManager = classes.connectionManager;
  let connection;
  const transfers = new classes.TransferManager();
  const startedAt = Date.now();
  let phase = 'connect';
  let remoteCleanupAttempted = false;
  let localCleanupAttempted = false;

  try {
    connection = await connectionManager.connect(e2eConfig);
    phase = 'prepare-remote-child';
    await connection.mkdir(remoteChild);

    phase = 'upload';
    const source = path.join(localChild, 'source.txt');
    const remoteSource = path.posix.join(remoteChild, 'source.txt');
    writeFile(source, `core-upload-${Date.now()}\n`);
    completed(await transfers.uploadFile(connection, source, remoteSource, e2eConfig));

    phase = 'authoritative-remote-verification';
    const authoritative = await connection.stat(remoteSource);
    if (!authoritative || authoritative.type !== 'file' || authoritative.size !== fs.statSync(source).size) {
      fail('REMOTE_STAT_MISMATCH');
    }
    const proof = path.join(localChild, 'remote-proof.txt');
    await connection.download(remoteSource, proof);
    if (sha256(source) !== sha256(proof)) { fail('REMOTE_BYTES_MISMATCH'); }

    phase = 'download';
    const downloaded = path.join(localChild, 'downloaded.txt');
    completed(await transfers.downloadFile(connection, remoteSource, downloaded, e2eConfig));
    if (sha256(source) !== sha256(downloaded)) { fail('DOWNLOAD_BYTES_MISMATCH'); }

    // This verifies repeated writes through the real queue. It does not claim
    // watcher debounce coverage; that needs an activated VS Code watcher.
    phase = 'two-edit-transfer';
    const edited = path.join(localChild, 'two-edit.txt');
    const remoteEdited = path.posix.join(remoteChild, 'two-edit.txt');
    writeFile(edited, 'first-edit\n');
    completed(await transfers.uploadFile(connection, edited, remoteEdited, e2eConfig));
    await new Promise(resolve => setTimeout(resolve, 1100));
    writeFile(edited, 'second-edit\n');
    completed(await transfers.uploadFile(connection, edited, remoteEdited, e2eConfig));
    const finalProof = path.join(localChild, 'two-edit.remote.txt');
    await connection.download(remoteEdited, finalProof);
    if (sha256(edited) !== sha256(finalProof)) { fail('TWO_EDIT_FINAL_BYTES_MISMATCH'); }

    phase = 'bulk-transfer';
    const bulk = await runBulkPhase(transfers, connection, e2eConfig, localChild, remoteChild, bulkCount);

    const watcher = {
      status: 'unavailable',
      reason: 'requires an activated VS Code workspace watcher'
    };
    if (args.has('--require-watcher')) { fail('WATCHER_RUNTIME_UNAVAILABLE'); }
    return {
      suite: 'extension-core-e2e',
      coreTransfers: { status: 'completed', uploads: 3 + bulk.files, downloads: 3, byteChecks: 3 + (bulk.sizeChecks || 0), durationMs: Date.now() - startedAt },
      bulk,
      watcher
    };
  } catch (error) {
    const result = {
      suite: 'extension-core-e2e',
      coreTransfers: { status: 'failed', phase, durationMs: Date.now() - startedAt },
      watcher: { status: 'unavailable', reason: 'requires an activated VS Code workspace watcher' },
      error: error && error.code ? String(error.code) : 'CORE_E2E_FAILED'
    };
    if (args.has('--debug-static') && error instanceof Error) {
      result.detail = error.message
        .replaceAll(String(config.host || ''), '<host>')
        .replaceAll(String(config.username || ''), '<username>')
        .replaceAll(String(config.password || ''), '<secret>')
        .replaceAll(remoteChild, '<remote-child>')
        .replaceAll(localChild, '<local-child>')
        .replaceAll(repositoryRoot, '<repository>');
    }
    return result;
  } finally {
    try {
      if (connection?.connected) {
        phase = 'remote-cleanup';
        assertRemoteChild(remoteRoot, remoteChild);
        remoteCleanupAttempted = true;
        const cleanupTarget = await connection.stat(remoteChild);
        if (cleanupTarget) {await connection.rmdir(remoteChild, true);}
      }
    } finally {
      transfers.dispose();
      try { await connectionManager.disconnect(e2eConfig); } catch { /* connection is already closing */ }
      try {
        phase = 'local-cleanup';
        assertLocalChild(localRoot, localChild);
        localCleanupAttempted = true;
        fs.rmSync(localChild, { recursive: true, force: true });
      } finally {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      }
      if (!remoteCleanupAttempted || !localCleanupAttempted) { fail('CLEANUP_NOT_ATTEMPTED'); }
    }
  }
}

function validateOnly() {
  const config = parseConfig();
  normaliseRemoteRoot(config.remotePath);
  resolveLocalRoot(config);
  const bulkCount = requestedBulkCount();
  return {
    suite: 'extension-core-e2e',
    status: 'ready',
    network: 'not-run',
    bulk: { status: bulkCount > 0 ? 'not-run' : 'not-requested', files: bulkCount },
    watcher: { status: 'unavailable', reason: 'requires an activated VS Code workspace watcher' }
  };
}

async function bundleCheck() {
  const bulkCount = requestedBulkCount();
  const { temporaryDirectory } = await loadCoreClasses();
  try {
    return {
      suite: 'extension-core-e2e',
      status: 'ready',
      network: 'not-run',
      coreBundle: 'loaded',
      bulk: { status: bulkCount > 0 ? 'not-run' : 'not-requested', files: bulkCount },
      watcher: { status: 'unavailable', reason: 'requires an activated VS Code workspace watcher' }
    };
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

(async () => {
  try {
    const watcherProbeMode = requestedWatcherProbeMode();
    if (watcherProbeMode) {
      if (!args.has('--run')) {
        console.log(JSON.stringify(validateWatcherProbe(watcherProbeMode)));
        return;
      }
      if (process.env.ITFFTP_RUN_WATCHER_PROBE !== '1') { fail('WATCHER_PROBE_RUN_NOT_CONFIRMED'); }
      const result = await runWatcherProbe(watcherProbeMode);
      console.log(JSON.stringify(result));
      if (result.status !== 'completed') { process.exitCode = 1; }
      return;
    }
    if (!args.has('--run')) {
      if (args.has('--require-watcher')) { fail('WATCHER_RUNTIME_UNAVAILABLE'); }
      console.log(JSON.stringify(args.has('--check-core') ? await bundleCheck() : validateOnly()));
      return;
    }
    if (process.env.ITFFTP_RUN_CORE_E2E !== '1') { fail('NETWORK_RUN_NOT_CONFIRMED'); }
    const result = await run();
    console.log(JSON.stringify(result));
    if (result.coreTransfers.status !== 'completed') { process.exitCode = 1; }
  } catch (error) {
    const result = {
      suite: 'extension-core-e2e',
      status: 'failed',
      error: error && error.code ? String(error.code) : 'HARNESS_FAILED'
    };
    if (args.has('--debug-static') && error instanceof Error) {
      result.detail = error.message.replaceAll(repositoryRoot, '<repository>');
    }
    console.log(JSON.stringify(result));
    process.exitCode = 1;
  }
})();

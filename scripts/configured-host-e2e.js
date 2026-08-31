const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('basic-ftp');

function parseConfig() {
  const raw = fs.readFileSync(path.join(process.cwd(), '.vscode', 'sftp.json'), 'utf8');
  const withoutComments = raw.replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (match, comment) => comment ? '' : match);
  const parsed = JSON.parse(withoutComments);
  const configs = Array.isArray(parsed) ? parsed : [parsed];
  const config = configs.find(candidate => candidate && candidate.default) || configs[0];
  if (!config || !['ftp', 'ftps'].includes(config.protocol)) {
    throw new Error('The configured-host FTP test requires a default FTP or FTPS profile.');
  }
  return config;
}

function remoteJoin(...parts) {
  return parts.join('/').replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
}

function accessOptions(config) {
  return {
    host: config.host,
    port: config.port || 21,
    user: config.username,
    password: config.password,
    secure: config.secure || false,
    secureOptions: config.secureOptions
  };
}

async function connectedClient(config) {
  const client = new Client(config.connTimeout || 10000);
  await client.access(accessOptions(config));
  return client;
}

function relativeFilePath(index) {
  const group = String(Math.floor(index / 50)).padStart(3, '0');
  const subgroup = String(Math.floor(index / 10) % 5).padStart(2, '0');
  return `group-${group}/nested-${subgroup}/file-${String(index).padStart(5, '0')}.txt`;
}

async function uploadTree(config, localRoot, remoteRoot, count, concurrency) {
  const files = Array.from({ length: count }, (_, index) => {
    const relativePath = relativeFilePath(index);
    const localPath = path.join(localRoot, ...relativePath.split('/'));
    const content = `ITFFTP configured-host E2E ${count} ${index}\n`;
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, content);
    return { relativePath, localPath, size: Buffer.byteLength(content) };
  });

  let nextIndex = 0;
  const startedAt = Date.now();
  const workerResults = await Promise.allSettled(Array.from({ length: concurrency }, async () => {
    const client = await connectedClient(config);
    try {
      while (nextIndex < files.length) {
        const file = files[nextIndex++];
        const remotePath = remoteJoin(remoteRoot, file.relativePath);
        await client.ensureDir(remoteJoin(remoteRoot, path.posix.dirname(file.relativePath)));
        await client.uploadFrom(file.localPath, remotePath);
      }
    } finally {
      client.close();
    }
  }));
  const failedWorker = workerResults.find(result => result.status === 'rejected');
  if (failedWorker?.status === 'rejected') {throw failedWorker.reason;}
  return { files, durationMs: Date.now() - startedAt };
}

async function listTree(client, remoteRoot) {
  const queue = [{ remotePath: remoteRoot, relativePath: '' }];
  const files = new Map();
  let directories = 0;
  let listCalls = 0;
  const startedAt = Date.now();
  while (queue.length) {
    const current = queue.shift();
    const entries = await client.list(current.remotePath);
    listCalls++;
    for (const entry of entries) {
      const relativePath = current.relativePath ? `${current.relativePath}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        directories++;
        queue.push({ remotePath: remoteJoin(current.remotePath, entry.name), relativePath });
      } else {
        files.set(relativePath, entry.size);
      }
    }
  }
  return { files, directories, listCalls, durationMs: Date.now() - startedAt };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function main() {
  const config = parseConfig();
  const countsArgument = process.argv.find(argument => argument.startsWith('--counts='));
  const counts = (countsArgument ? countsArgument.slice('--counts='.length) : '120,1000')
    .split(',').map(Number).filter(count => Number.isInteger(count) && count > 0);
  const concurrencyArgument = process.argv.find(argument => argument.startsWith('--concurrency='));
  const concurrency = Math.max(1, Math.min(16, Number(concurrencyArgument?.slice('--concurrency='.length) || 4)));
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'itfftp-configured-e2e-'));
  const remoteBase = remoteJoin(config.remotePath || '/');
  const remoteRoot = remoteJoin(remoteBase, `.itfftp-e2e-${Date.now()}`);
  if (!remoteRoot.startsWith(`${remoteBase === '/' ? '' : remoteBase}/.itfftp-e2e-`)) {
    throw new Error('Refusing to use an unsafe remote E2E path.');
  }

  const control = await connectedClient(config);
  const results = [];
  try {
    await control.ensureDir(remoteRoot);
    for (const count of counts) {
      const phaseLocal = path.join(localRoot, String(count));
      const phaseRemote = remoteJoin(remoteRoot, String(count));
      fs.mkdirSync(phaseLocal, { recursive: true });
      const uploaded = await uploadTree(config, phaseLocal, phaseRemote, count, concurrency);
      const listed = await listTree(control, phaseRemote);
      const mismatches = uploaded.files.filter(file => listed.files.get(file.relativePath) !== file.size);
      if (listed.files.size !== count || mismatches.length) {
        throw new Error(`Metadata comparison failed for ${count} paths: ${listed.files.size} listed, ${mismatches.length} mismatched.`);
      }
      results.push({ count, uploadMs: uploaded.durationMs, listMs: listed.durationMs, directories: listed.directories, listCalls: listed.listCalls });
    }

    const editLocal = path.join(localRoot, 'edit-pause-edit.txt');
    const editRemote = remoteJoin(remoteRoot, 'edit-pause-edit.txt');
    fs.writeFileSync(editLocal, 'first-edit');
    await control.uploadFrom(editLocal, editRemote);
    await new Promise(resolve => setTimeout(resolve, 1100));
    fs.writeFileSync(editLocal, 'second-edit');
    await control.uploadFrom(editLocal, editRemote);
    const downloaded = path.join(localRoot, 'edit-pause-edit.remote.txt');
    await control.downloadTo(downloaded, editRemote);
    const localBytes = fs.readFileSync(editLocal);
    const remoteBytes = fs.readFileSync(downloaded);
    if (sha256(localBytes) !== sha256(remoteBytes)) {throw new Error('Edit-pause-edit final content did not match remote content.');}

    console.log(JSON.stringify({
      profile: config.name || 'configured',
      protocol: config.protocol,
      concurrency,
      results,
      editPauseEdit: 'sha256-match'
    }));
  } finally {
    try {await control.removeDir(remoteRoot);} finally {
      control.close();
      fs.rmSync(localRoot, { recursive: true, force: true });
    }
  }
}

main().catch(error => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});

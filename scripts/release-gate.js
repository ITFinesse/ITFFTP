'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const STAGE_PREFIX = 'itfftp-release-';
const STAGE_ENV = 'ITFFTP_RELEASE_STAGE';
const PRECHECKED_ENV = 'ITFFTP_RELEASE_PRECHECKED';
const MAX_ARCHIVE_ENTRIES = 5000;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_CAPTURED_ENTRY_BYTES = 25 * 1024 * 1024;

const REQUIRED_VSIX_FILES = Object.freeze([
  '[Content_Types].xml',
  'extension.vsixmanifest',
  'extension/CHANGELOG.md',
  'extension/LICENSE.txt',
  'extension/README.md',
  'extension/dist/extension.js',
  'extension/package.json',
  'extension/resources/activity-bar-icon.svg',
  'extension/resources/codicons/codicon.css',
  'extension/resources/codicons/codicon.ttf',
  'extension/resources/icon.png',
  'extension/resources/webview/connection-form.css',
  'extension/resources/webview/connection-form.html',
  'extension/resources/webview/connection-form.js',
  'extension/resources/webview/settings.css',
  'extension/resources/webview/settings.html',
  'extension/resources/webview/settings.js',
  'extension/resources/webview/vendor/chart.umd.js',
  'extension/schema/sftp.schema.json'
]);

const EXCLUDED_STAGE_DIRECTORIES = new Set([
  '.cache',
  '.claude',
  '.git',
  '.lean-ctx',
  '.npm',
  '.npm-cache',
  '.playwright-cli',
  '.snapshotfinesse',
  '.temp',
  '.tmp',
  '.vscode',
  '.vscode-test',
  'brain',
  'coverage',
  'dist',
  'dist-test',
  'node_modules',
  'out'
]);

const EXCLUDED_STAGE_FILES = new Set([
  '.clineignore',
  '.npmrc',
  'agents.md',
  'contributing.md',
  'development.md',
  'feature_plan.md',
  'features.md',
  'lean-ctx.md',
  'remediationbacklog.md'
]);

const CAPTURED_VSIX_FILES = new Set([
  'extension.vsixmanifest',
  'extension/dist/extension.js',
  'extension/package.json'
]);

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

function isCredentialLikeFile(baseName) {
  const lower = baseName.toLowerCase();
  return lower === '.env'
    || lower.startsWith('.env.')
    || lower === 'sftp.json'
    || lower === 'id_rsa'
    || lower === 'id_dsa'
    || lower === 'id_ecdsa'
    || lower === 'id_ed25519'
    || /\.(?:key|p12|pfx|pem|ppk)$/i.test(lower);
}

function shouldStageRelative(relativePath, isDirectory = false) {
  const normalized = toPosixPath(relativePath).replace(/^\.\//, '');
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length) return true;

  const lowerParts = parts.map(part => part.toLowerCase());
  if (lowerParts.some(part => EXCLUDED_STAGE_DIRECTORIES.has(part))) return false;

  const baseName = lowerParts[lowerParts.length - 1];
  if (isDirectory) return true;
  if (EXCLUDED_STAGE_FILES.has(baseName)) return false;
  if (isCredentialLikeFile(baseName)) return false;
  if (/\.vsix$/i.test(baseName) || /\.log$/i.test(baseName)) return false;
  if (/^exec-.*\.png$/i.test(baseName)) return false;
  if (normalized.toLowerCase().startsWith('resources/icon-source/')) return false;
  if (normalized.toLowerCase() === 'scripts/configured-host-e2e.js') return false;
  if (normalized.toLowerCase() === 'scripts/extension-core-e2e.js') return false;
  return true;
}

function copyWorkspace(sourceRoot, stageRoot) {
  let copiedFiles = 0;
  let excludedFiles = 0;

  function visit(sourceDirectory, relativeDirectory) {
    const entries = fs.readdirSync(sourceDirectory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? path.join(relativeDirectory, entry.name)
        : entry.name;
      const sourcePath = path.join(sourceDirectory, entry.name);

      if (entry.isSymbolicLink()) {
        throw new Error('Release staging refuses symbolic links.');
      }

      if (!shouldStageRelative(relativePath, entry.isDirectory())) {
        excludedFiles += 1;
        continue;
      }

      const destinationPath = path.join(stageRoot, relativePath);
      if (entry.isDirectory()) {
        fs.mkdirSync(destinationPath, { recursive: true });
        visit(sourcePath, relativePath);
      } else if (entry.isFile()) {
        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
        fs.copyFileSync(sourcePath, destinationPath);
        copiedFiles += 1;
      } else {
        throw new Error('Release staging found an unsupported filesystem entry.');
      }
    }
  }

  visit(sourceRoot, '');
  return { copiedFiles, excludedFiles };
}

function resolvedPath(value) {
  return fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value);
}

function assertSafeStagePath(stageRoot, sourceRoot) {
  const resolvedStage = resolvedPath(stageRoot);
  const resolvedTemp = resolvedPath(os.tmpdir());
  const tempPrefix = resolvedTemp.endsWith(path.sep) ? resolvedTemp : `${resolvedTemp}${path.sep}`;
  if (!resolvedStage.startsWith(tempPrefix)) {
    throw new Error('Release stage is outside the operating-system temporary directory.');
  }
  if (!path.basename(resolvedStage).startsWith(STAGE_PREFIX)) {
    throw new Error('Release stage does not have the expected isolated prefix.');
  }
  if (sourceRoot && resolvedStage === resolvedPath(sourceRoot)) {
    throw new Error('Release stage resolves to the source workspace.');
  }
}

function removeStage(stageRoot, sourceRoot) {
  if (!stageRoot || !fs.existsSync(stageRoot)) return;
  assertSafeStagePath(stageRoot, sourceRoot);
  fs.rmSync(stageRoot, { recursive: true, force: true });
}

function createStage(sourceRoot) {
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), STAGE_PREFIX));
  try {
    assertSafeStagePath(stageRoot, sourceRoot);
    const summary = copyWorkspace(sourceRoot, stageRoot);
    return { stageRoot, summary };
  } catch (error) {
    removeStage(stageRoot, sourceRoot);
    throw error;
  }
}

function resolveNpmCli() {
  const candidates = [];
  if (process.env.npm_execpath) candidates.push(process.env.npm_execpath);
  candidates.push(path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'));

  for (const pathEntry of (process.env.PATH || '').split(path.delimiter)) {
    if (!pathEntry) continue;
    candidates.push(path.join(pathEntry, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }

  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }

  const match = candidates.find(candidate => candidate && fs.existsSync(candidate));
  if (!match) throw new Error('Unable to locate npm-cli.js for the clean release install.');
  return match;
}

function spawnStage(stage) {
  const result = spawnSync(stage.command, stage.args, {
    cwd: stage.cwd,
    env: stage.env || process.env,
    stdio: 'inherit',
    windowsHide: true,
    shell: false
  });
  if (result.error) {
    const code = result.error.code || result.error.name || 'START_FAILED';
    throw new Error(`${stage.label} could not start (${code}).`);
  }
  return result.status === null ? 1 : result.status;
}

function runSequentialStages(stages, runner = spawnStage) {
  for (const stage of stages) {
    console.log(`[release-gate] ${stage.label}`);
    const status = runner(stage);
    if (status !== 0) {
      throw new Error(`${stage.label} failed with exit code ${status}.`);
    }
  }
}

function npmStage(label, npmCli, cwd, args, env) {
  return {
    label,
    command: process.execPath,
    args: [npmCli, ...args],
    cwd,
    env
  };
}

function installDependencies(stageRoot) {
  const npmCli = resolveNpmCli();
  const env = {
    ...process.env,
    CI: '1',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false'
  };
  runSequentialStages([
    npmStage('Install the exact locked dependency tree', npmCli, stageRoot, ['ci', '--no-audit', '--no-fund'], env)
  ]);
}

function runCheckStages(stageRoot) {
  const npmCli = resolveNpmCli();
  const env = { ...process.env, CI: '1' };
  const stages = [
    npmStage('Compile TypeScript', npmCli, stageRoot, ['run', 'compile'], env),
    npmStage('Lint TypeScript in the local mirror', npmCli, stageRoot, ['run', 'lint'], env),
    npmStage('Run the complete automated test suite', npmCli, stageRoot, ['test'], env),
    npmStage('Build the production extension bundle', npmCli, stageRoot, ['run', 'bundle'], env),
    {
      label: 'Parse-check the production extension bundle',
      command: process.execPath,
      args: ['--check', path.join(stageRoot, 'dist', 'extension.js')],
      cwd: stageRoot,
      env
    }
  ];
  runSequentialStages(stages);
}

function readJson(filePath, label) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    throw new Error(`${label} is not valid JSON.`);
  }
  return parsed;
}

function isExactSemver(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function assertDirectToolchain(stageRoot, manifest) {
  const required = ['@vscode/vsce', 'yauzl'];
  for (const dependencyName of required) {
    const declared = manifest.devDependencies && manifest.devDependencies[dependencyName];
    if (!isExactSemver(declared)) {
      throw new Error(`${dependencyName} must be a directly declared, exact devDependency for release packaging.`);
    }

    const packagePath = path.join(stageRoot, 'node_modules', ...dependencyName.split('/'), 'package.json');
    const installed = readJson(packagePath, `${dependencyName} installed package metadata`);
    if (installed.version !== declared) {
      throw new Error(`${dependencyName} does not match its exact manifest version.`);
    }
  }
}

function expectedArtifactName(manifest) {
  if (!manifest || !/^[a-z0-9][a-z0-9-]*$/i.test(manifest.name || '')) {
    throw new Error('Extension package name is invalid for a release artifact.');
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version || '')) {
    throw new Error('Extension version is invalid for a release artifact.');
  }
  return `${manifest.name}-${manifest.version}.vsix`;
}

function hashBuffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashFile(filePath) {
  return hashBuffer(fs.readFileSync(filePath));
}

function validateArchiveEntryName(entryName, seenLowerCaseNames) {
  if (typeof entryName !== 'string' || !entryName || entryName.includes('\0')) {
    throw new Error('VSIX contains an invalid archive entry name.');
  }
  if (entryName.includes('\\') || entryName.startsWith('/') || /^[A-Za-z]:/.test(entryName)) {
    throw new Error('VSIX contains an unsafe archive path.');
  }
  const parts = entryName.split('/');
  if (parts.some(part => part === '..' || part === '.')) {
    throw new Error('VSIX contains an unsafe archive path segment.');
  }

  const key = entryName.toLowerCase();
  if (seenLowerCaseNames && seenLowerCaseNames.has(key)) {
    throw new Error('VSIX contains duplicate archive entries.');
  }
  if (seenLowerCaseNames) seenLowerCaseNames.add(key);
  return entryName;
}

function isForbiddenVsixEntry(entryName) {
  const normalized = entryName.toLowerCase();
  const forbiddenPrefixes = [
    'extension/.git/',
    'extension/.vscode/',
    'extension/.vscode-test/',
    'extension/coverage/',
    'extension/dist-test/',
    'extension/node_modules/',
    'extension/out/',
    'extension/scripts/',
    'extension/src/',
    'extension/tests/'
  ];
  if (forbiddenPrefixes.some(prefix => normalized.startsWith(prefix))) return true;

  const baseName = normalized.split('/').pop();
  if (isCredentialLikeFile(baseName)) return true;
  if (/\.(?:log|map|ts|vsix)$/i.test(baseName)) return true;
  if (/^exec-.*\.png$/i.test(baseName)) return true;

  const forbiddenExact = new Set([
    'extension/.clineignore',
    'extension/.vscodeignore',
    'extension/agents.md',
    'extension/contributing.md',
    'extension/development.md',
    'extension/feature_plan.md',
    'extension/features.md',
    'extension/lean-ctx.md',
    'extension/package-lock.json',
    'extension/remediationbacklog.md'
  ]);
  return forbiddenExact.has(normalized);
}

function assertVsixEntrySet(entryNames, requiredFiles = REQUIRED_VSIX_FILES) {
  const seen = new Set();
  for (const entryName of entryNames) validateArchiveEntryName(entryName, seen);

  const missing = requiredFiles.filter(required => !seen.has(required.toLowerCase()));
  if (missing.length) {
    throw new Error(`VSIX is missing ${missing.length} required runtime file(s).`);
  }

  const forbidden = entryNames.filter(isForbiddenVsixEntry);
  if (forbidden.length) {
    throw new Error(`VSIX contains ${forbidden.length} forbidden internal or sensitive file(s).`);
  }
}

function readVsixArchive(vsixPath) {
  let yauzl;
  try {
    yauzl = require('yauzl');
  } catch (_error) {
    throw new Error('The directly declared yauzl release dependency is unavailable.');
  }

  return new Promise((resolve, reject) => {
    yauzl.open(vsixPath, { lazyEntries: true }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(new Error('The generated VSIX could not be opened.'));
        return;
      }

      const entryNames = [];
      const contents = new Map();
      const seen = new Set();
      let totalBytes = 0;
      let settled = false;

      const fail = error => {
        if (settled) return;
        settled = true;
        try { zipFile.close(); } catch (_closeError) { /* best effort */ }
        reject(error);
      };

      zipFile.on('error', () => fail(new Error('The generated VSIX archive is invalid.')));
      zipFile.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ entryNames, contents, totalBytes });
      });
      zipFile.on('entry', entry => {
        try {
          validateArchiveEntryName(entry.fileName, seen);
          entryNames.push(entry.fileName);
          totalBytes += entry.uncompressedSize;
          if (entryNames.length > MAX_ARCHIVE_ENTRIES || totalBytes > MAX_ARCHIVE_BYTES) {
            fail(new Error('VSIX exceeds the release gate archive limits.'));
            return;
          }
        } catch (error) {
          fail(error);
          return;
        }

        if (!CAPTURED_VSIX_FILES.has(entry.fileName)) {
          zipFile.readEntry();
          return;
        }
        if (entry.uncompressedSize > MAX_CAPTURED_ENTRY_BYTES) {
          fail(new Error('A required VSIX entry exceeds the inspection limit.'));
          return;
        }

        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(new Error('A required VSIX entry could not be inspected.'));
            return;
          }
          const chunks = [];
          let length = 0;
          stream.on('error', () => fail(new Error('A required VSIX entry could not be read.')));
          stream.on('data', chunk => {
            length += chunk.length;
            if (length > MAX_CAPTURED_ENTRY_BYTES) {
              stream.destroy();
              fail(new Error('A required VSIX entry exceeds the inspection limit.'));
              return;
            }
            chunks.push(chunk);
          });
          stream.on('end', () => {
            if (settled) return;
            contents.set(entry.fileName, Buffer.concat(chunks));
            zipFile.readEntry();
          });
        });
      });

      zipFile.readEntry();
    });
  });
}

function assertManifestIdentity(sourceManifest, packagedManifest) {
  const fields = ['name', 'publisher', 'version', 'main'];
  for (const field of fields) {
    if (!sourceManifest[field] || packagedManifest[field] !== sourceManifest[field]) {
      throw new Error(`Packaged extension manifest does not preserve ${field}.`);
    }
  }
  if (packagedManifest.main !== './dist/extension.js') {
    throw new Error('Packaged extension manifest does not use the production bundle entrypoint.');
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function inspectVsix(vsixPath, stageRoot, expectedBundleHash) {
  if (!fs.existsSync(vsixPath)) throw new Error('Expected VSIX artifact was not created.');
  const sourceManifest = readJson(path.join(stageRoot, 'package.json'), 'Source package manifest');
  const archive = await readVsixArchive(vsixPath);
  assertVsixEntrySet(archive.entryNames);

  const packagedManifestBuffer = archive.contents.get('extension/package.json');
  const packagedBundle = archive.contents.get('extension/dist/extension.js');
  const vsixManifest = archive.contents.get('extension.vsixmanifest');
  if (!packagedManifestBuffer || !packagedBundle || !vsixManifest) {
    throw new Error('VSIX inspection could not read the required identity or bundle entries.');
  }

  let packagedManifest;
  try {
    packagedManifest = JSON.parse(packagedManifestBuffer.toString('utf8'));
  } catch (_error) {
    throw new Error('Packaged extension manifest is not valid JSON.');
  }
  assertManifestIdentity(sourceManifest, packagedManifest);

  if (hashBuffer(packagedBundle) !== expectedBundleHash) {
    throw new Error('Packaged extension bundle does not match the verified production bundle.');
  }

  const identity = `${sourceManifest.publisher}.${sourceManifest.name}`;
  const manifestXml = vsixManifest.toString('utf8');
  const identityPattern = new RegExp(`\\bId=["']${escapeRegExp(identity)}["']`, 'i');
  const versionPattern = new RegExp(`\\bVersion=["']${escapeRegExp(sourceManifest.version)}["']`, 'i');
  if (!identityPattern.test(manifestXml) || !versionPattern.test(manifestXml)) {
    throw new Error('VSIX identity metadata does not match the extension manifest.');
  }

  return {
    entryCount: archive.entryNames.length,
    totalBytes: archive.totalBytes,
    artifactBytes: fs.statSync(vsixPath).size,
    bundleHash: expectedBundleHash
  };
}

function assertStagedContext(stageRoot) {
  const declaredStage = process.env[STAGE_ENV];
  if (!declaredStage) throw new Error('Internal release mode requires an isolated release stage.');
  assertSafeStagePath(stageRoot);
  if (resolvedPath(stageRoot) !== resolvedPath(declaredStage)) {
    throw new Error('Internal release mode does not match the isolated release stage.');
  }
}

function runVscePackage(stageRoot, artifactPath) {
  const manifest = readJson(path.join(stageRoot, 'package.json'), 'Source package manifest');
  assertDirectToolchain(stageRoot, manifest);
  const vsceCli = path.join(stageRoot, 'node_modules', '@vscode', 'vsce', 'vsce');
  if (!fs.existsSync(vsceCli)) throw new Error('Pinned @vscode/vsce executable is unavailable.');

  const env = {
    ...process.env,
    [STAGE_ENV]: stageRoot,
    [PRECHECKED_ENV]: '1'
  };
  runSequentialStages([{
    label: 'Package the extension without runtime dependency expansion',
    command: process.execPath,
    args: [vsceCli, 'package', '--no-dependencies', '--out', artifactPath],
    cwd: stageRoot,
    env
  }]);
}

function atomicCopy(sourcePath, destinationPath) {
  const temporaryPath = `${destinationPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.copyFileSync(sourcePath, temporaryPath);
    if (hashFile(temporaryPath) !== hashFile(sourcePath)) {
      throw new Error('Copied release artifact failed its integrity check.');
    }
    fs.renameSync(temporaryPath, destinationPath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
  }
}

async function runPackageStaged(stageRoot) {
  assertStagedContext(stageRoot);
  const manifest = readJson(path.join(stageRoot, 'package.json'), 'Source package manifest');
  assertDirectToolchain(stageRoot, manifest);
  runCheckStages(stageRoot);

  const bundlePath = path.join(stageRoot, 'dist', 'extension.js');
  const verifiedBundleHash = hashFile(bundlePath);
  const artifactPath = path.join(stageRoot, expectedArtifactName(manifest));
  runVscePackage(stageRoot, artifactPath);

  if (hashFile(bundlePath) !== verifiedBundleHash) {
    throw new Error('Packaging changed the production bundle after verification.');
  }
  const report = await inspectVsix(artifactPath, stageRoot, verifiedBundleHash);
  console.log(`[release-gate] VSIX verified: ${report.entryCount} files, ${report.artifactBytes} bytes.`);
  return artifactPath;
}

async function runReleaseFromSource(sourceRoot) {
  const { stageRoot, summary } = createStage(sourceRoot);
  console.log(`[release-gate] Local mirror staged (${summary.copiedFiles} files; excluded items were not copied).`);
  try {
    installDependencies(stageRoot);
    const manifest = readJson(path.join(stageRoot, 'package.json'), 'Source package manifest');
    const artifactName = expectedArtifactName(manifest);
    const env = { ...process.env, [STAGE_ENV]: stageRoot };
    runSequentialStages([{
      label: 'Run the staged release package and inspection gate',
      command: process.execPath,
      args: [path.join(stageRoot, 'scripts', 'release-gate.js'), '--package-staged'],
      cwd: stageRoot,
      env
    }]);

    const stagedArtifact = path.join(stageRoot, artifactName);
    const destinationArtifact = path.join(sourceRoot, artifactName);
    atomicCopy(stagedArtifact, destinationArtifact);
    if (hashFile(destinationArtifact) !== hashFile(stagedArtifact)) {
      throw new Error('Final release artifact failed its integrity readback.');
    }
    console.log(`[release-gate] Release artifact ready: ${artifactName}`);
    return destinationArtifact;
  } finally {
    removeStage(stageRoot, sourceRoot);
  }
}

async function runPrepublish(sourceRoot) {
  const declaredStage = process.env[STAGE_ENV];
  if (declaredStage) {
    assertStagedContext(sourceRoot);
    if (process.env[PRECHECKED_ENV] === '1') {
      console.log('[release-gate] Staged release checks already completed.');
      return;
    }
    runCheckStages(sourceRoot);
    return;
  }

  const { stageRoot, summary } = createStage(sourceRoot);
  console.log(`[release-gate] Local prepublish mirror staged (${summary.copiedFiles} files; excluded items were not copied).`);
  try {
    installDependencies(stageRoot);
    runCheckStages(stageRoot);
    const stagedBundle = path.join(stageRoot, 'dist', 'extension.js');
    const sourceBundle = path.join(sourceRoot, 'dist', 'extension.js');
    fs.mkdirSync(path.dirname(sourceBundle), { recursive: true });
    atomicCopy(stagedBundle, sourceBundle);
    console.log('[release-gate] Prepublish checks passed and the verified bundle was returned.');
  } finally {
    removeStage(stageRoot, sourceRoot);
  }
}

function printHelp() {
  console.log([
    'Usage: node scripts/release-gate.js [mode]',
    '',
    '  (no mode)          Stage, install, check, package and inspect a release.',
    '  --prepublish       Run clean-room checks for VS Code prepublish.',
    '  --check-staged     Internal: run checks in an authenticated local stage.',
    '  --package-staged   Internal: check, package and inspect in a local stage.',
    '  --inspect-staged P Internal: inspect one staged VSIX artifact.',
    '  --help             Show this help.'
  ].join('\n'));
}

async function main(argv = process.argv.slice(2)) {
  const sourceRoot = path.resolve(__dirname, '..');
  const mode = argv[0] || '--release';
  if (mode === '--help' || mode === '-h') {
    printHelp();
    return;
  }
  if (mode === '--release') {
    await runReleaseFromSource(sourceRoot);
    return;
  }
  if (mode === '--prepublish') {
    await runPrepublish(sourceRoot);
    return;
  }
  if (mode === '--check-staged') {
    assertStagedContext(sourceRoot);
    runCheckStages(sourceRoot);
    return;
  }
  if (mode === '--package-staged') {
    await runPackageStaged(sourceRoot);
    return;
  }
  if (mode === '--inspect-staged') {
    assertStagedContext(sourceRoot);
    const artifactPath = argv[1] && path.resolve(sourceRoot, argv[1]);
    if (!artifactPath || path.dirname(artifactPath) !== sourceRoot) {
      throw new Error('Staged VSIX inspection requires an artifact inside the release stage.');
    }
    const bundleHash = hashFile(path.join(sourceRoot, 'dist', 'extension.js'));
    const report = await inspectVsix(artifactPath, sourceRoot, bundleHash);
    console.log(`[release-gate] VSIX verified: ${report.entryCount} files, ${report.artifactBytes} bytes.`);
    return;
  }
  throw new Error('Unknown release gate mode.');
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[release-gate] FAILED: ${error instanceof Error ? error.message : 'Unknown error.'}`);
    process.exitCode = 1;
  });
}

module.exports = {
  REQUIRED_VSIX_FILES,
  assertDirectToolchain,
  assertManifestIdentity,
  assertSafeStagePath,
  assertVsixEntrySet,
  expectedArtifactName,
  hashBuffer,
  inspectVsix,
  isForbiddenVsixEntry,
  readVsixArchive,
  runSequentialStages,
  shouldStageRelative,
  validateArchiveEntryName
};

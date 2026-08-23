const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const esbuild = require('esbuild');

async function main() {
  const root = path.resolve(__dirname, '..');
  const testDirectory = path.join(root, 'tests');
  const entries = fs.readdirSync(testDirectory)
    .filter(name => name.endsWith('.test.ts'))
    .map(name => path.join(testDirectory, name));
  if (!entries.length) throw new Error('No test files were found.');

  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'itfftp-tests-'));
  try {
    await esbuild.build({
      entryPoints: entries,
      outdir: outputDirectory,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      sourcemap: 'inline',
      logLevel: 'warning'
    });
    const compiled = fs.readdirSync(outputDirectory)
      .filter(name => name.endsWith('.test.js'))
      .map(name => path.join(outputDirectory, name));
    const result = spawnSync(process.execPath, ['--test', ...compiled], {
      cwd: root,
      stdio: 'inherit'
    });
    if (result.error) throw result.error;
    process.exitCode = result.status === null ? 1 : result.status;
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

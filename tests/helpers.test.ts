import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRemotePath, sanitizeRelativePath, matchesPattern, isPathIgnored, formatFileSize, resolveLocalRoot } from '../src/utils/helpers';

describe('helpers', () => {
  it('normalizeRemotePath collapses slashes and backslashes', () => {
    assert.equal(normalizeRemotePath('\\var\\www//html//'), '/var/www/html/');
  });

  it('sanitizeRelativePath rejects path traversal', () => {
    assert.throws(() => sanitizeRelativePath('../secrets.txt'));
    assert.throws(() => sanitizeRelativePath('..\\secrets.txt'));
  });

  it('sanitizeRelativePath rejects absolute paths', () => {
    assert.throws(() => sanitizeRelativePath('/etc/passwd'));
  });

  it('matchesPattern supports double star', () => {
    assert.equal(matchesPattern('src/utils/helpers.ts', ['**/*.ts']), true);
    assert.equal(matchesPattern('src/utils/helpers.ts', ['**/*.js']), false);
  });

  it('matches ignored folder descendants using Windows paths', () => {
    assert.equal(matchesPattern('storage\\logs\\app.log', ['storage/logs/**']), true);
    assert.equal(matchesPattern('node_modules\\package\\index.js', ['node_modules']), true);
    assert.equal(matchesPattern('src\\index.ts', ['storage/logs/**', 'node_modules']), false);
  });

  it('fully ignores a directory, its contents, and matching basenames', () => {
    const patterns = ['storage/logs/**', '.env*', 'node_modules'];
    assert.equal(isPathIgnored('storage/logs', patterns), true);
    assert.equal(isPathIgnored('storage/logs/archive/old.log', patterns), true);
    assert.equal(isPathIgnored('packages/app/node_modules/lib/index.js', patterns), true);
    assert.equal(isPathIgnored('config/.env.local', patterns), true);
    assert.equal(isPathIgnored('storage/uploads/image.png', patterns), false);
  });

  it('formatFileSize formats bytes', () => {
    assert.equal(formatFileSize(0), '0 B');
    assert.equal(formatFileSize(1024), '1 KB');
  });

  it('resolves a configured local folder inside the workspace', () => {
    assert.equal(resolveLocalRoot('C:\\workspace', 'public/assets'), 'C:\\workspace\\public\\assets');
    assert.equal(resolveLocalRoot('C:\\workspace', '.'), 'C:\\workspace');
  });

  it('rejects a configured local folder outside the workspace', () => {
    assert.throws(() => resolveLocalRoot('C:\\workspace', '../secrets'), /inside the workspace/);
  });
});

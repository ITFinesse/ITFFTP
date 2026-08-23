import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const repositoryRoot = process.cwd();
const providerSource = fs.readFileSync(path.join(repositoryRoot, 'src', 'providers', 'settings-panel.ts'), 'utf8');
const webviewSource = fs.readFileSync(path.join(repositoryRoot, 'resources', 'webview', 'settings.js'), 'utf8');

describe('Transfer refresh contract', () => {
  it('recursively compares both sides without waiting for folder expansion', () => {
    assert.match(
      providerSource,
      /loadRemoteDiffOnce[\s\S]*?scanComparison\(config, '', generation, false, true\)/,
      'The normal/full comparison must recurse from the paired roots'
    );
    assert.doesNotMatch(
      webviewSource,
      /postMessage\(\{ type: 'loadDiffFolder'/,
      'Expanding a rendered folder must not be responsible for discovering descendants'
    );
  });

  it('full refresh describes and performs a paired local and remote relist', () => {
    assert.match(webviewSource, /textContent = 'Full refresh'/);
    assert.match(webviewSource, /Relist both local and remote folders, including all collapsed subfolders/);
    assert.match(providerSource, /if \(message\.force\) \{this\.diffDirectoryCache\.clear\(\);\}/);
  });

  it('watcher changes trigger a fresh recursive comparison instead of fabricating equality', () => {
    const method = providerSource.match(/public async refreshWatchedPath[\s\S]*?\n  }/)?.[0] || '';
    assert.match(method, /diffDirectoryCache\.clear\(\)/);
    assert.match(method, /scanComparison\(active, '', \+\+this\.diffScanGeneration, false, true, false\)/);
    assert.doesNotMatch(method, /refreshAfterTransfer/);
  });
});

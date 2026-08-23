import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDiff, collapseRecursiveTransfers, newerSide, shouldSyncDiff } from '../src/core/diff-comparison';
import { isConnectionClosedError, isRemoteMissingError } from '../src/core/connection-errors';

describe('classifyDiff', () => {
  it('treats equal-sized clean files as identical regardless of timestamps', () => {
    assert.equal(classifyDiff({ type: 'file', local: { size: 241293 }, remote: { size: 241293 } }), 'same');
  });

  it('keeps a watcher-dirty equal-sized file modified until byte verification clears it', () => {
    assert.equal(classifyDiff({ type: 'file', local: { size: 128 }, remote: { size: 128 } }, true), 'modified');
  });

  it('detects size and presence differences', () => {
    assert.equal(classifyDiff({ type: 'file', local: { size: 2 }, remote: { size: 1 } }), 'modified');
    assert.equal(classifyDiff({ type: 'file', remote: { size: 1 } }), 'missing-local');
    assert.equal(classifyDiff({ type: 'file', local: { size: 1 } }), 'missing-remote');
  });

  it('does not mark paired directories modified', () => {
    assert.equal(classifyDiff({ type: 'directory', local: {}, remote: {} }, true), 'same');
  });

  it('detects a file and folder collision at the same path', () => {
    assert.equal(classifyDiff({
      type: 'directory',
      local: { type: 'file', size: 10 },
      remote: { type: 'directory' }
    }), 'type-changed');
  });
});

describe('newerSide', () => {
  it('uses millisecond timestamps to identify the newer peer', () => {
    assert.equal(newerSide({ type: 'file', local: { modifyTime: 2001 }, remote: { modifyTime: 2000 } }), 'local');
    assert.equal(newerSide({ type: 'file', local: { modifyTime: 2000 }, remote: { modifyTime: 2001 } }), 'remote');
  });

  it('treats a watcher-dirty local file as newer', () => {
    assert.equal(newerSide({ type: 'file', local: { modifyTime: 2000 }, remote: { modifyTime: 2000 } }, true), 'local');
  });
});

describe('shouldSyncDiff', () => {
  it('syncs up only the locally changed record when other differences are remote-newer', () => {
    const records = [
      { path: 'edited.php', type: 'file' as const, status: 'modified' as const, local: { size: 20, modifyTime: 3000 }, remote: { size: 10, modifyTime: 2000 } },
      { path: 'remote-edit.php', type: 'file' as const, status: 'modified' as const, local: { size: 10, modifyTime: 1000 }, remote: { size: 20, modifyTime: 4000 } },
      { path: 'same.php', type: 'file' as const, status: 'same' as const, local: { size: 10, modifyTime: 1000 }, remote: { size: 10, modifyTime: 1000 } }
    ];

    assert.deepEqual(records.filter(record => shouldSyncDiff(record, 'up', record.path === 'edited.php')).map(record => record.path), ['edited.php']);
  });

  it('does not download over a locally dirty file', () => {
    const record = { type: 'file' as const, status: 'modified' as const, local: { size: 10, modifyTime: 1000 }, remote: { size: 20, modifyTime: 4000 } };
    assert.equal(shouldSyncDiff(record, 'down', true), false);
    assert.equal(shouldSyncDiff(record, 'down', false), true);
  });
});

describe('collapseRecursiveTransfers', () => {
  it('queues a changed directory once instead of also queuing every descendant', () => {
    const records = collapseRecursiveTransfers([
      { path: 'assets/css/site.css', type: 'file' as const },
      { path: 'assets', type: 'directory' as const },
      { path: 'assets/css', type: 'directory' as const },
      { path: 'index.php', type: 'file' as const }
    ]);
    assert.deepEqual(records.map(record => record.path), ['assets', 'index.php']);
  });
});

describe('isConnectionClosedError', () => {
  it('recognises a server FIN and common fatal socket failures', () => {
    assert.equal(isConnectionClosedError(new Error('Client is closed because Server sent FIN packet unexpectedly')), true);
    assert.equal(isConnectionClosedError({ message: 'read ECONNRESET' }), true);
  });

  it('does not treat an FTP missing-path response as a dead connection', () => {
    assert.equal(isConnectionClosedError(new Error("550 Can't check for file existence")), false);
  });
});

describe('isRemoteMissingError', () => {
  it('recognises an FTP missing-path response without hiding permission failures', () => {
    assert.equal(isRemoteMissingError(new Error('550 Could not delete /site/file.txt: No such file or directory')), true);
    assert.equal(isRemoteMissingError(new Error("553 Can't open that file: No such file or directory")), true);
    assert.equal(isRemoteMissingError(new Error('550 Permission denied')), false);
  });
});

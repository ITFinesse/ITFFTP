import { describe, expect, it } from 'vitest';
import { classifyDiff, collapseRecursiveTransfers, newerSide } from '../src/core/diff-comparison';
import { isConnectionClosedError } from '../src/core/connection-errors';

describe('classifyDiff', () => {
  it('treats equal-sized clean files as identical regardless of timestamps', () => {
    expect(classifyDiff({ type: 'file', local: { size: 241293 }, remote: { size: 241293 } })).toBe('same');
  });

  it('keeps a watcher-dirty equal-sized file modified until byte verification clears it', () => {
    expect(classifyDiff({ type: 'file', local: { size: 128 }, remote: { size: 128 } }, true)).toBe('modified');
  });

  it('detects size and presence differences', () => {
    expect(classifyDiff({ type: 'file', local: { size: 2 }, remote: { size: 1 } })).toBe('modified');
    expect(classifyDiff({ type: 'file', remote: { size: 1 } })).toBe('missing-local');
    expect(classifyDiff({ type: 'file', local: { size: 1 } })).toBe('missing-remote');
  });

  it('does not mark paired directories modified', () => {
    expect(classifyDiff({ type: 'directory', local: {}, remote: {} }, true)).toBe('same');
  });
});

describe('newerSide', () => {
  it('uses millisecond timestamps to identify the newer peer', () => {
    expect(newerSide({ type: 'file', local: { modifyTime: 2001 }, remote: { modifyTime: 2000 } })).toBe('local');
    expect(newerSide({ type: 'file', local: { modifyTime: 2000 }, remote: { modifyTime: 2001 } })).toBe('remote');
  });

  it('treats a watcher-dirty local file as newer', () => {
    expect(newerSide({ type: 'file', local: { modifyTime: 2000 }, remote: { modifyTime: 2000 } }, true)).toBe('local');
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
    expect(records.map(record => record.path)).toEqual(['assets', 'index.php']);
  });
});

describe('isConnectionClosedError', () => {
  it('recognises a server FIN and common fatal socket failures', () => {
    expect(isConnectionClosedError(new Error('Client is closed because Server sent FIN packet unexpectedly'))).toBe(true);
    expect(isConnectionClosedError({ message: 'read ECONNRESET' })).toBe(true);
  });

  it('does not treat an FTP missing-path response as a dead connection', () => {
    expect(isConnectionClosedError(new Error("550 Can't check for file existence"))).toBe(false);
  });
});

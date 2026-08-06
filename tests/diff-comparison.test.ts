import { describe, expect, it } from 'vitest';
import { classifyDiff, collapseRecursiveTransfers } from '../src/core/diff-comparison';

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

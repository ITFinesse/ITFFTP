export type ComparableFile = {
  type: 'file' | 'directory';
  local?: { size?: number };
  remote?: { size?: number };
};

export type DiffStatus = 'same' | 'missing-local' | 'missing-remote' | 'modified' | 'type-changed';

/** Classify a paired path after any watcher-dirty byte verification has run. */
export function classifyDiff(record: ComparableFile, locallyDirty = false): DiffStatus {
  if (!record.local) { return 'missing-local'; }
  if (!record.remote) { return 'missing-remote'; }
  if (record.type === 'directory') { return 'same'; }
  if (record.local.size !== record.remote.size) { return 'modified'; }
  return locallyDirty ? 'modified' : 'same';
}

/** Remove child actions already covered by a recursive directory transfer. */
export function collapseRecursiveTransfers<T extends { path: string; type: 'file' | 'directory' }>(records: T[]): T[] {
  const queuedDirectories: string[] = [];
  return [...records]
    .sort((left, right) => left.path.split('/').length - right.path.split('/').length || left.path.localeCompare(right.path))
    .filter(record => {
      const path = record.path.replace(/\/$/, '');
      if (queuedDirectories.some(directory => path.startsWith(`${directory}/`))) { return false; }
      if (record.type === 'directory') { queuedDirectories.push(path); }
      return true;
    });
}

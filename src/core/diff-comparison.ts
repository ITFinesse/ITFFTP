export type ComparableFile = {
  type: 'file' | 'directory';
  local?: { size?: number; modifyTime?: number };
  remote?: { size?: number; modifyTime?: number };
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

export function newerSide(record: ComparableFile, locallyDirty = false): 'local' | 'remote' | undefined {
  if (record.type !== 'file' || !record.local || !record.remote) { return undefined; }
  if (locallyDirty) { return 'local'; }
  const localTime = Number(record.local.modifyTime) || 0;
  const remoteTime = Number(record.remote.modifyTime) || 0;
  if (localTime <= 0 || remoteTime <= 0 || localTime === remoteTime) { return undefined; }
  return localTime > remoteTime ? 'local' : 'remote';
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

export type ComparableFile = {
  type: 'file' | 'directory';
  local?: { type?: 'file' | 'directory'; size?: number; modifyTime?: number };
  remote?: { type?: 'file' | 'directory'; size?: number; modifyTime?: number };
};

export type DiffStatus = 'same' | 'missing-local' | 'missing-remote' | 'modified' | 'type-changed';

export type SyncDirection = 'up' | 'down';

/** Classify a paired path after any watcher-dirty byte verification has run. */
export function classifyDiff(record: ComparableFile, locallyDirty = false): DiffStatus {
  if (!record.local) { return 'missing-local'; }
  if (!record.remote) { return 'missing-remote'; }
  if (record.local.type && record.remote.type && record.local.type !== record.remote.type) { return 'type-changed'; }
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

/** Select only changes that originate on the requested side. Bulk sync must
 * not turn every pre-existing mismatch into an overwrite operation. */
export function shouldSyncDiff(
  record: ComparableFile & { status: DiffStatus },
  direction: SyncDirection,
  locallyDirty = false
): boolean {
  if (direction === 'up') {
    if (record.status === 'missing-remote') { return Boolean(record.local); }
    if (record.status !== 'modified' && record.status !== 'type-changed') { return false; }
    return Boolean(record.local) && (locallyDirty || newerSide(record) === 'local');
  }

  if (record.status === 'missing-local') { return Boolean(record.remote); }
  if (record.status !== 'modified' && record.status !== 'type-changed') { return false; }
  return Boolean(record.remote) && !locallyDirty && newerSide(record) === 'remote';
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

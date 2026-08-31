import * as path from 'path';
import * as fs from 'fs';

interface LocalWriteSignature {
  exists: boolean;
  size?: number;
  mtimeMs?: number;
}

interface SuppressedWrite extends LocalWriteSignature {
  activeOperations: number;
  expiresAt: number;
}

export interface RemoteWatcherIdentity {
  protocol?: string;
  host: string;
  port?: number;
  username?: string;
}

export interface RemoteWatcherSignature {
  type: 'file' | 'directory' | 'symlink' | 'deleted';
  size?: number;
  mtimeMs?: number;
}

interface SuppressedRemoteWrite {
  activeOperations: number;
  expiresAt: number;
  signature?: RemoteWatcherSignature;
}

const ACTIVE_WRITE_TTL_MS = 185000;
const SETTLED_LOCAL_WRITE_TTL_MS = 3000;
// Remote polling backs off to 30 seconds when idle. Keep a completed mutation
// long enough for the next poll and its one-second quiet period to observe it.
const SETTLED_REMOTE_WRITE_TTL_MS = 45000;
const REMOTE_TIME_TOLERANCE_MS = 2000;
const SUPPRESSION_PRUNE_INTERVAL_MS = 3000;
const suppressedWrites = new Map<string, SuppressedWrite>();
const suppressedRemoteWrites = new Map<string, SuppressedRemoteWrite>();
let nextSuppressionPruneAt = 0;

function pruneExpiredSuppressions(now: number): void {
  if (now < nextSuppressionPruneAt) {return;}
  nextSuppressionPruneAt = now + SUPPRESSION_PRUNE_INTERVAL_MS;
  for (const [key, value] of suppressedWrites) {
    if (value.expiresAt <= now) {suppressedWrites.delete(key);}
  }
  for (const [key, value] of suppressedRemoteWrites) {
    if (value.expiresAt <= now) {suppressedRemoteWrites.delete(key);}
  }
}

function keyFor(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function remoteKeyFor(identity: RemoteWatcherIdentity, remotePath: string): string {
  const normalizedPath = remotePath.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  return [
    identity.protocol || 'ftp',
    identity.username || '',
    identity.host.toLowerCase(),
    identity.port || '',
    normalizedPath
  ].join('|');
}

function readLocalSignature(filePath: string): LocalWriteSignature {
  try {
    const stat = fs.statSync(filePath);
    return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return { exists: false };
  }
}

function localSignaturesMatch(expected: LocalWriteSignature, actual: LocalWriteSignature): boolean {
  return expected.exists === actual.exists
    && (!expected.exists || (expected.size === actual.size && expected.mtimeMs === actual.mtimeMs));
}

function remoteSignaturesMatch(expected: RemoteWatcherSignature, actual: RemoteWatcherSignature): boolean {
  if (expected.type !== actual.type || expected.size !== actual.size) {return false;}
  if (expected.mtimeMs === undefined || actual.mtimeMs === undefined) {return true;}
  return Math.abs(expected.mtimeMs - actual.mtimeMs) <= REMOTE_TIME_TOLERANCE_MS;
}

/** Mark the start of an ITFFTP operation that writes a local path. */
export function beginWatcherWrite(filePath: string, durationMs = ACTIVE_WRITE_TTL_MS): void {
  pruneExpiredSuppressions(Date.now());
  const key = keyFor(filePath);
  const previous = suppressedWrites.get(key);
  suppressedWrites.set(key, {
    ...readLocalSignature(filePath),
    activeOperations: (previous?.activeOperations || 0) + 1,
    expiresAt: Date.now() + Math.max(0, durationMs)
  });
}

/** Mark a local write complete and suppress every matching final filesystem event. */
export function completeWatcherWrite(filePath: string, durationMs = SETTLED_LOCAL_WRITE_TTL_MS): void {
  pruneExpiredSuppressions(Date.now());
  const key = keyFor(filePath);
  const previous = suppressedWrites.get(key);
  suppressedWrites.set(key, {
    ...readLocalSignature(filePath),
    activeOperations: Math.max(0, (previous?.activeOperations || 1) - 1),
    expiresAt: Date.now() + Math.max(0, durationMs)
  });
}

/** Backward-compatible settled marker for callers that perform an atomic write. */
export function suppressWatcherWrite(filePath: string, durationMs = SETTLED_LOCAL_WRITE_TTL_MS): void {
  pruneExpiredSuppressions(Date.now());
  suppressedWrites.set(keyFor(filePath), {
    ...readLocalSignature(filePath),
    activeOperations: 0,
    expiresAt: Date.now() + Math.max(0, durationMs)
  });
}

/**
 * Non-consuming check shared by the core watcher and SettingsPanel watcher.
 * A genuine edit changes the signature, clears the marker, and returns false.
 */
export function isGeneratedWatcherWrite(filePath: string): boolean {
  pruneExpiredSuppressions(Date.now());
  const key = keyFor(filePath);
  const suppressed = suppressedWrites.get(key);
  if (!suppressed || suppressed.expiresAt <= Date.now()) {
    suppressedWrites.delete(key);
    return false;
  }
  if (suppressed.activeOperations > 0) {return true;}
  if (!localSignaturesMatch(suppressed, readLocalSignature(filePath))) {
    suppressedWrites.delete(key);
    return false;
  }
  return true;
}

/** @deprecated Prefer isGeneratedWatcherWrite for clarity. */
export function isWatcherWriteSuppressed(filePath: string): boolean {
  return isGeneratedWatcherWrite(filePath);
}

/** Mark the start of an upload so remote polling cannot feed it back as a download. */
export function beginRemoteWatcherWrite(
  identity: RemoteWatcherIdentity,
  remotePath: string,
  durationMs = ACTIVE_WRITE_TTL_MS
): void {
  pruneExpiredSuppressions(Date.now());
  const key = remoteKeyFor(identity, remotePath);
  const previous = suppressedRemoteWrites.get(key);
  suppressedRemoteWrites.set(key, {
    activeOperations: (previous?.activeOperations || 0) + 1,
    expiresAt: Date.now() + Math.max(0, durationMs),
    signature: previous?.signature
  });
}

/** Complete an upload with the remote signature the watcher should ignore. */
export function completeRemoteWatcherWrite(
  identity: RemoteWatcherIdentity,
  remotePath: string,
  signature: RemoteWatcherSignature,
  durationMs = SETTLED_REMOTE_WRITE_TTL_MS
): void {
  pruneExpiredSuppressions(Date.now());
  const key = remoteKeyFor(identity, remotePath);
  const previous = suppressedRemoteWrites.get(key);
  suppressedRemoteWrites.set(key, {
    activeOperations: Math.max(0, (previous?.activeOperations || 1) - 1),
    expiresAt: Date.now() + Math.max(0, durationMs),
    signature
  });
}

/** Complete a remote delete so its polling event is not echoed back into the UI. */
export function completeRemoteWatcherDelete(
  identity: RemoteWatcherIdentity,
  remotePath: string,
  durationMs = SETTLED_REMOTE_WRITE_TTL_MS
): void {
  completeRemoteWatcherWrite(identity, remotePath, { type: 'deleted' }, durationMs);
}

/** Clear one failed/cancelled remote write operation. */
export function clearRemoteWatcherWrite(identity: RemoteWatcherIdentity, remotePath: string): void {
  pruneExpiredSuppressions(Date.now());
  const key = remoteKeyFor(identity, remotePath);
  const previous = suppressedRemoteWrites.get(key);
  if (!previous || previous.activeOperations <= 1) {
    if (previous?.signature) {
      suppressedRemoteWrites.set(key, { ...previous, activeOperations: 0 });
    } else {
      suppressedRemoteWrites.delete(key);
    }
    return;
  }
  suppressedRemoteWrites.set(key, { ...previous, activeOperations: previous.activeOperations - 1 });
}

/** Non-consuming operation-aware check for remote poll and delayed processing. */
export function isRemoteWatcherWriteSuppressed(
  identity: RemoteWatcherIdentity,
  remotePath: string,
  signature?: RemoteWatcherSignature
): boolean {
  pruneExpiredSuppressions(Date.now());
  const key = remoteKeyFor(identity, remotePath);
  const suppressed = suppressedRemoteWrites.get(key);
  if (!suppressed || suppressed.expiresAt <= Date.now()) {
    suppressedRemoteWrites.delete(key);
    return false;
  }
  if (suppressed.activeOperations > 0) {return true;}
  if (!signature || (suppressed.signature && remoteSignaturesMatch(suppressed.signature, signature))) {
    return true;
  }
  suppressedRemoteWrites.delete(key);
  return false;
}

/** Test-only reset: production callers should rely on expiry. */
export function resetWatcherSuppressionsForTests(): void {
  suppressedWrites.clear();
  suppressedRemoteWrites.clear();
  nextSuppressionPruneAt = 0;
}

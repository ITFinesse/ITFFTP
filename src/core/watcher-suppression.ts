import * as path from 'path';

const suppressedWrites = new Map<string, number>();

function keyFor(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Prevent filesystem events caused by ITFFTP itself from feeding back into Auto Sync. */
export function suppressWatcherWrite(filePath: string, durationMs = 3000): void {
  suppressedWrites.set(keyFor(filePath), Date.now() + Math.max(0, durationMs));
}

export function isWatcherWriteSuppressed(filePath: string): boolean {
  const key = keyFor(filePath);
  const expiresAt = suppressedWrites.get(key) || 0;
  if (expiresAt <= Date.now()) {
    suppressedWrites.delete(key);
    return false;
  }
  return true;
}

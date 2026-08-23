import * as path from 'path';
import * as fs from 'fs';

interface SuppressedWrite {
  expiresAt: number;
  size?: number;
  mtimeMs?: number;
}

const suppressedWrites = new Map<string, SuppressedWrite>();

function keyFor(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Prevent filesystem events caused by ITFFTP itself from feeding back into Auto Sync. */
export function suppressWatcherWrite(filePath: string, durationMs = 3000): void {
  let signature: Pick<SuppressedWrite, 'size' | 'mtimeMs'> = {};
  try {
    const stat = fs.statSync(filePath);
    signature = { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    // The pre-download marker has no signature; the post-download marker will.
  }
  suppressedWrites.set(keyFor(filePath), { expiresAt: Date.now() + Math.max(0, durationMs), ...signature });
}

export function isWatcherWriteSuppressed(filePath: string): boolean {
  const key = keyFor(filePath);
  const suppressed = suppressedWrites.get(key);
  if (!suppressed || suppressed.expiresAt <= Date.now()) {
    suppressedWrites.delete(key);
    return false;
  }
  if (suppressed.size !== undefined && suppressed.mtimeMs !== undefined) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size !== suppressed.size || stat.mtimeMs !== suppressed.mtimeMs) {
        suppressedWrites.delete(key);
        return false;
      }
    } catch {
      suppressedWrites.delete(key);
      return false;
    }
  }
  suppressedWrites.delete(key);
  return true;
}

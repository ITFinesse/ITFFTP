export interface RecursiveScanDirectoryResult<T> {
  childDirectories: string[];
  value: T;
}

export interface RecursiveScanBatchEntry<T> {
  directory: string;
  value: T;
}

export interface RecursiveScanProgress {
  visitedDirectories: number;
  pendingDirectories: number;
}

export interface BoundedRecursiveScanOptions<T> {
  startDirectory: string;
  concurrency: number;
  /** Fail the scan instead of publishing a silently truncated tree. */
  maxDirectories?: number;
  /** Root is depth zero; reaching a child beyond this depth fails the scan. */
  maxDepth?: number;
  isCancelled: () => boolean;
  scanDirectory: (directory: string, workerIndex: number) => Promise<RecursiveScanDirectoryResult<T>>;
  onBatch: (entries: RecursiveScanBatchEntry<T>[], progress: RecursiveScanProgress) => Promise<void> | void;
}

export const DEFAULT_MAX_SCAN_DIRECTORIES = 100_000;
export const DEFAULT_MAX_SCAN_DEPTH = 64;

export class RecursiveScanLimitError extends Error {
  constructor(public readonly limit: 'directories' | 'depth', public readonly maximum: number) {
    super(limit === 'directories'
      ? `Recursive scan exceeded the maximum directory count of ${maximum}.`
      : `Recursive scan exceeded the maximum depth of ${maximum}.`);
    this.name = 'RecursiveScanLimitError';
  }
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return resolved;
}

/**
 * Traverse a dynamically discovered directory tree in bounded breadth-first
 * batches. A completed batch is never published after cancellation.
 */
export async function runBoundedRecursiveScan<T>(
  options: BoundedRecursiveScanOptions<T>
): Promise<{ visitedDirectories: number; cancelled: boolean }> {
  const requestedConcurrency = Math.floor(options.concurrency);
  const concurrency = Number.isFinite(requestedConcurrency)
    ? Math.max(1, requestedConcurrency)
    : 1;
  const maxDirectories = positiveLimit(options.maxDirectories, DEFAULT_MAX_SCAN_DIRECTORIES, 'maxDirectories');
  const maxDepth = positiveLimit(options.maxDepth, DEFAULT_MAX_SCAN_DEPTH, 'maxDepth');
  const queue: Array<{ directory: string; depth: number }> = [{ directory: options.startDirectory, depth: 0 }];
  const discovered = new Set([options.startDirectory]);
  let visitedDirectories = 0;

  while (queue.length > 0) {
    if (options.isCancelled()) {return { visitedDirectories, cancelled: true };}
    const batch = queue.splice(0, concurrency);
    const settled = await Promise.allSettled(batch.map(async ({ directory, depth }, workerIndex) => ({
      directory,
      depth,
      result: await options.scanDirectory(directory, workerIndex)
    })));
    const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) {throw failed.reason;}
    const completed = settled.map(result => (result as PromiseFulfilledResult<{
      directory: string;
      depth: number;
      result: RecursiveScanDirectoryResult<T>;
    }>).value);
    if (options.isCancelled()) {return { visitedDirectories, cancelled: true };}

    visitedDirectories += completed.length;
    for (const { depth, result } of completed) {
      for (const child of result.childDirectories) {
        if (discovered.has(child)) {continue;}
        if (depth + 1 > maxDepth) {throw new RecursiveScanLimitError('depth', maxDepth);}
        if (discovered.size >= maxDirectories) {
          throw new RecursiveScanLimitError('directories', maxDirectories);
        }
        discovered.add(child);
        queue.push({ directory: child, depth: depth + 1 });
      }
    }

    await options.onBatch(
      completed.map(({ directory, result }) => ({ directory, value: result.value })),
      { visitedDirectories, pendingDirectories: queue.length }
    );
    if (options.isCancelled()) {return { visitedDirectories, cancelled: true };}
  }

  return { visitedDirectories, cancelled: false };
}

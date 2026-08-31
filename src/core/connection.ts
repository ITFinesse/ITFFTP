/**
 * ITFFTP - Base Connection Interface
 */

import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { FileEntry, FTPConfig, ConnectionStatus } from '../types';
import { FTP_MODIFY_TIME_TOLERANCE_MS, newerSide } from './diff-comparison';

export interface TransferProgress {
  filename: string;
  transferred: number;
  total: number;
  percentage: number;
}

export type ConnectionEvent =
  | 'connected'
  | 'disconnected'
  | 'error'
  | 'progress'
  | 'transferStart'
  | 'transferComplete';

export type UpdateTransferDirection = 'upload' | 'download';
export type UpdateTransferAction = 'overwrite' | 'skip';

/** Internal hand-off used when TransferManager already owns the matching
 * same-target write lock. Direct connection callers omit this so protocol
 * implementations acquire the lock themselves. */
export interface TransferSerializationOptions {
  writeLockHeld?: boolean;
}

/** In update mode, overwrite an existing target only when the source has a
 * known timestamp newer than the target by more than the shared tolerance. */
export function updateTransferAction(
  direction: UpdateTransferDirection,
  localSize: number,
  remoteSize: number,
  localModifyTime: number,
  remoteModifyTime: number
): UpdateTransferAction {
  const side = newerSide({
    type: 'file',
    local: { size: localSize, modifyTime: localModifyTime },
    remote: { size: remoteSize, modifyTime: remoteModifyTime }
  });
  return side === (direction === 'upload' ? 'local' : 'remote') ? 'overwrite' : 'skip';
}

export function isUsableModifyTime(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime()) && value.getTime() > 0;
}

export function modificationTimesMatch(left: Date, right: Date): boolean {
  return Math.abs(left.getTime() - right.getTime()) <= FTP_MODIFY_TIME_TOLERANCE_MS;
}

export function assertTransferredFile(
  entry: Pick<FileEntry, 'type' | 'size'> | null,
  expectedSize: number,
  label: string
): asserts entry is Pick<FileEntry, 'type' | 'size'> {
  if (!entry) {throw new Error(`${label} is missing after transfer`);}
  if (entry.type !== 'file') {
    throw new Error(`${label} has type ${entry.type} after transfer; expected file`);
  }
  if (!Number.isFinite(entry.size) || entry.size !== expectedSize) {
    throw new Error(`${label} size mismatch after transfer: expected ${expectedSize} bytes, received ${entry.size}`);
  }
}

function uniqueSuffix(): string {
  return `${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
}

export function uniqueRemoteSiblingPath(remotePath: string, purpose: 'upload' | 'backup'): string {
  const normalized = remotePath.replace(/\\/g, '/');
  return path.posix.join(
    path.posix.dirname(normalized),
    `.${path.posix.basename(normalized)}.itfftp-${purpose}-${uniqueSuffix()}`
  );
}

export function uniqueLocalSiblingPath(localPath: string, purpose: 'download' | 'backup'): string {
  const destination = path.resolve(localPath);
  return path.join(path.dirname(destination), `.${path.basename(destination)}.itfftp-${purpose}-${uniqueSuffix()}`);
}

async function lstatIfPresent(targetPath: string): Promise<fs.Stats | undefined> {
  try {
    return await fs.promises.lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {return undefined;}
    throw error;
  }
}

function assertSafeLocalTarget(targetPath: string, stats: fs.Stats | undefined): void {
  if (!stats) {return;}
  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing to replace symbolic link download target: ${targetPath}`);
  }
  if (!stats.isFile()) {
    throw new Error(`Cannot download to ${targetPath}: an unsafe target type exists at this path`);
  }
}

/** Promote a verified sibling staging file. Platforms that cannot replace an
 * existing path directly use a backup-and-rollback transaction. */
export async function promoteLocalStagingFile(
  stagingPath: string,
  localPath: string
): Promise<void> {
  const staging = path.resolve(stagingPath);
  const destination = path.resolve(localPath);
  if (path.dirname(staging) !== path.dirname(destination)) {
    throw new Error('Download staging file must be contained in the destination directory');
  }
  const stagingStat = await fs.promises.lstat(staging);
  if (!stagingStat.isFile() || stagingStat.isSymbolicLink()) {
    throw new Error(`Download staging path is not a regular file: ${staging}`);
  }

  const existing = await lstatIfPresent(destination);
  assertSafeLocalTarget(destination, existing);
  try {
    await fs.promises.rename(staging, destination);
    return;
  } catch (directError) {
    if (!existing) {throw directError;}
  }

  const current = await lstatIfPresent(destination);
  assertSafeLocalTarget(destination, current);
  if (!current) {
    await fs.promises.rename(staging, destination);
    return;
  }

  const backup = uniqueLocalSiblingPath(destination, 'backup');
  await fs.promises.rename(destination, backup);
  try {
    await fs.promises.rename(staging, destination);
  } catch (promotionError) {
    try {
      await fs.promises.rename(backup, destination);
    } catch (rollbackError) {
      throw Object.assign(
        new Error(`Download promotion and rollback both failed for ${destination}; previous data remains at ${backup}`),
        { promotionError, rollbackError }
      );
    }
    throw promotionError;
  }

  const backupStat = await lstatIfPresent(backup);
  if (backupStat) {await fs.promises.unlink(backup);}
}

/** Write a same-directory staging file, verify it, preserve its source mtime,
 * and only then promote it over the destination. */
export async function atomicDownloadToLocalFile(
  localPath: string,
  expectedSize: number,
  modifyTime: Date | undefined,
  writeStagingFile: (stagingPath: string) => Promise<void>
): Promise<void> {
  const destination = path.resolve(localPath);
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  assertSafeLocalTarget(destination, await lstatIfPresent(destination));

  const staging = uniqueLocalSiblingPath(destination, 'download');
  let failure: unknown;
  try {
    await writeStagingFile(staging);
    const stats = await fs.promises.lstat(staging);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Downloaded staging path is not a regular file: ${staging}`);
    }
    if (stats.size !== expectedSize) {
      throw new Error(`Downloaded file size mismatch: expected ${expectedSize} bytes, received ${stats.size}`);
    }
    if (modifyTime && isUsableModifyTime(modifyTime)) {
      await fs.promises.utimes(staging, modifyTime, modifyTime);
    }
    await promoteLocalStagingFile(staging, destination);
  } catch (error) {
    failure = error;
  }
  try {
    await fs.promises.unlink(staging);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT' && failure === undefined) {failure = error;}
  }
  if (failure !== undefined) {throw failure;}
}

const remoteWriteLocks = new Map<string, Promise<void>>();
const localWriteLocks = new Map<string, Promise<void>>();

function remoteWriteKey(config: FTPConfig, remotePath: string): string {
  const port = config.port || (config.protocol === 'sftp' ? 22 : 21);
  const normalizedPath = path.posix.resolve('/', remotePath.replace(/\\/g, '/'));
  return `${config.protocol}:${config.host.toLowerCase()}:${port}:${config.username}:${normalizedPath}`;
}

/** Serialize same-target writes across primary and pooled protocol objects. */
export async function withSerializedRemoteWrite<T>(
  config: FTPConfig,
  remotePath: string,
  operation: () => Promise<T>
): Promise<T> {
  const key = remoteWriteKey(config, remotePath);
  const previous = remoteWriteLocks.get(key) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => {release = resolve;});
  remoteWriteLocks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (remoteWriteLocks.get(key) === current) {remoteWriteLocks.delete(key);}
  }
}

function localWriteKey(localPath: string): string {
  const resolved = path.resolve(localPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Serialize writes to one local target without blocking unrelated paths. */
export async function withSerializedLocalWrite<T>(
  localPath: string,
  operation: () => Promise<T>
): Promise<T> {
  const key = localWriteKey(localPath);
  const previous = localWriteLocks.get(key) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => {release = resolve;});
  localWriteLocks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (localWriteLocks.get(key) === current) {localWriteLocks.delete(key);}
  }
}

// Operation queue item
interface QueueItem<T> {
  operation: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  settled: boolean;
}

export class ConnectionRetiredError extends Error {
  readonly code = 'CONNECTION_RETIRED';

  constructor(message = 'Connection retired before the operation completed') {
    super(message);
    this.name = 'ConnectionRetiredError';
  }
}

export abstract class BaseConnection extends EventEmitter {
  protected config: FTPConfig;
  protected _connected = false;
  protected _currentPath = '';

  // Operation queue for sequential execution
  private operationQueue: QueueItem<unknown>[] = [];
  private isProcessingQueue = false;
  private activeQueueItem?: QueueItem<unknown>;

  constructor(config: FTPConfig) {
    super();
    this.config = config;
    this._currentPath = config.remotePath;
  }

  /**
   * Execute operation in queue to prevent concurrent access
   */
  protected async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.operationQueue.push({
        operation,
        resolve: resolve as (value: unknown) => void,
        reject,
        settled: false
      });
      void this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue) {
      return;
    }

    this.isProcessingQueue = true;

    while (this.operationQueue.length > 0) {
      const item = this.operationQueue.shift();
      if (item) {
        this.activeQueueItem = item;
        try {
          const result = await item.operation();
          if (!item.settled) {
            item.settled = true;
            item.resolve(result);
          }
        } catch (error) {
          this.handleOperationError(error);
          if (!item.settled) {
            item.settled = true;
            item.reject(error);
          }
        } finally {
          if (this.activeQueueItem === item) {this.activeQueueItem = undefined;}
        }
      }
    }

    this.isProcessingQueue = false;
  }

  get connected(): boolean {
    return this._connected;
  }

  get currentPath(): string {
    return this._currentPath;
  }

  getConfig(): FTPConfig {
    return this.config;
  }

  getStatus(): ConnectionStatus {
    return {
      connected: this._connected,
      host: this.config.host,
      protocol: this.config.protocol,
      currentPath: this._currentPath
    };
  }

  abstract connect(): Promise<void>;
  protected handleOperationError(_error: unknown): void {
    // Protocol implementations can retire broken transport sessions here.
  }
  /** Reject both the active queued operation and every operation waiting behind
   * it. Protocol disconnect implementations must call super.disconnect() so a
   * retired transport cannot leave caller promises pending forever. */
  protected retireOperationQueue(error: unknown = new ConnectionRetiredError()): void {
    if (this.activeQueueItem && !this.activeQueueItem.settled) {
      this.activeQueueItem.settled = true;
      this.activeQueueItem.reject(error);
    }
    for (const item of this.operationQueue.splice(0)) {
      if (item.settled) {continue;}
      item.settled = true;
      item.reject(error);
    }
  }
  async disconnect(): Promise<void> {
    this.retireOperationQueue();
    this.removeAllListeners();
    this._connected = false;
  }
  abstract list(remotePath: string): Promise<FileEntry[]>;
  abstract download(remotePath: string, localPath: string, serialization?: TransferSerializationOptions): Promise<void>;
  abstract upload(localPath: string, remotePath: string, serialization?: TransferSerializationOptions): Promise<void>;
  /** Preserve a source modification time after transfer when the protocol and
   * server support it. Returns false when timestamp updates are unavailable. */
  async setModifyTime(_remotePath: string, _modifyTime: Date): Promise<boolean> {
    return false;
  }
  abstract delete(remotePath: string): Promise<void>;
  abstract mkdir(remotePath: string): Promise<void>;
  abstract rmdir(remotePath: string, recursive?: boolean): Promise<void>;
  abstract rename(oldPath: string, newPath: string): Promise<void>;
  abstract exists(remotePath: string): Promise<boolean>;
  abstract stat(remotePath: string): Promise<FileEntry | null>;
  abstract chmod(remotePath: string, mode: number | string): Promise<void>;
  abstract readFile(remotePath: string): Promise<Buffer>;
  abstract writeFile(remotePath: string, content: Buffer | string): Promise<void>;
  abstract exec(command: string): Promise<{ stdout: string; stderr: string; code: number }>;

  protected emitProgress(filename: string, transferred: number, total: number): void {
    const percentage = total > 0 ? Math.round((transferred / total) * 100) : 0;
    this.emit('progress', { filename, transferred, total, percentage });
  }
}

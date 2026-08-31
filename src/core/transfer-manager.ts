/**
 * ITFFTP - Transfer Manager
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  BaseConnection,
  assertTransferredFile,
  isUsableModifyTime,
  modificationTimesMatch,
  uniqueLocalSiblingPath,
  uniqueRemoteSiblingPath,
  updateTransferAction,
  withSerializedLocalWrite,
  withSerializedRemoteWrite
} from './connection';
import { connectionManager } from './connection-manager';
import { TransferItem, TransferOutcome, TransferRequestOptions, SyncResult, FTPConfig, FileEntry } from '../types';
import { logger } from '../utils/logger';
import { isRemoteMissingError } from './connection-errors';
import { statusBar } from '../utils/status-bar';
import { DEFAULT_IGNORE_PATTERNS, errorCode, errorMessage, generateId, normalizeRemotePath, isPathIgnored } from '../utils/helpers';
import { EventEmitter } from 'stream';
import {
  beginRemoteWatcherWrite,
  beginWatcherWrite,
  clearRemoteWatcherWrite,
  completeRemoteWatcherWrite,
  completeWatcherWrite
} from './watcher-suppression';

export class TransferCancelledError extends Error {
  readonly code = 'TRANSFER_CANCELLED';

  constructor(message = 'Transfer cancelled') {
    super(message);
    this.name = 'TransferCancelledError';
  }
}

class TransferSkippedError extends Error {
  readonly code = 'TRANSFER_SKIPPED';

  constructor(readonly reason: string) {
    super(`Skipped: ${reason}`);
    this.name = 'TransferSkippedError';
  }
}

export class TransferTraversalLimitError extends Error {
  readonly code = 'TRANSFER_TRAVERSAL_LIMIT';

  constructor(message: string) {
    super(message);
    this.name = 'TransferTraversalLimitError';
  }
}

export interface TransferProgress {
  completed: number;
  total: number;
  currentFile?: string;
  percentage: number;
}

export interface TransferAnalytics {
  uploadedFiles: number;
  downloadedFiles: number;
  uploadedBytes: number;
  downloadedBytes: number;
  averageDurationMs: number;
  days: Array<{ date: string; uploadedBytes: number; downloadedBytes: number; uploadedFiles: number; downloadedFiles: number }>;
}

export class TransferManager extends EventEmitter implements vscode.Disposable {
  private queue: TransferItem[] = [];
  private active = false;
  private isProcessing = false;
  private processingScheduled = false;
  private cancelled = false;
  private currentItem?: TransferItem;
  private sessionCollisionAction: 'ask' | 'overwrite' | 'skip' = 'ask';
  private collisionLock: Promise<void> = Promise.resolve();
  private queueUpdateTimeout: NodeJS.Timeout | undefined;
  private _activeCount = 0;
  private completionResolve: (() => void) | null = null;
  private wakeQueue?: () => void;
  private readonly preferredConnections = new Map<string, BaseConnection>();
  private readonly primaryTransfers = new Set<BaseConnection>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly activeConnections = new Map<string, {
    connection: BaseConnection;
    config: FTPConfig;
    retired: boolean;
    retirement?: Promise<void>;
  }>();
  private readonly latestTargetGenerations = new Map<string, number>();
  private readonly itemTargetGenerations = new Map<string, { key: string; generation: number }>();
  private nextTargetGeneration = 0;
  private transferHistory: TransferItem[] = [];
  private static readonly TRANSFER_TIMEOUT_MS = 180000; // 3 minutes safeguard against stalled transfers


  private emitQueueUpdate(immediate = false): void {
    if (immediate) {
      if (this.queueUpdateTimeout) {clearTimeout(this.queueUpdateTimeout);}
      this.queueUpdateTimeout = undefined;
      this.emit('queueUpdate', this.queue);
      return;
    }
    if (this.queueUpdateTimeout) {return;}
    this.queueUpdateTimeout = setTimeout(() => {
      this.emit('queueUpdate', this.queue);
      this.queueUpdateTimeout = undefined;
    }, 150); // 150ms debounce for UI stability
  }

  private scheduleProcessing(): void {
    if (this.active || this.processingScheduled) {return;}
    this.processingScheduled = true;
    queueMicrotask(() => {
      this.processingScheduled = false;
      void this.processQueue();
    });
  }

  private withTransferTimeout<T>(
    promise: Promise<T>,
    ms: number,
    context: string,
    signal: AbortSignal,
    onTimeout: (error: Error) => void
  ): Promise<T> {
    let timeoutId: NodeJS.Timeout | undefined;

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) {return;}
        settled = true;
        if (timeoutId) {clearTimeout(timeoutId);}
        signal.removeEventListener('abort', onAbort);
        action();
      };
      const onAbort = (): void => {
        const reason = signal.reason instanceof Error ? signal.reason : new TransferCancelledError();
        finish(() => reject(reason));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      timeoutId = setTimeout(() => {
        const err = Object.assign(new Error(`Transfer timeout after ${Math.round(ms / 1000)}s (${context})`), { code: 'TRANSFER_TIMEOUT' });
        onTimeout(err);
        finish(() => reject(err));
      }, ms);

      promise.then(
        value => finish(() => resolve(value)),
        error => finish(() => reject(error))
      );
    });
  }

  private acquirePooledConnection(config: FTPConfig, signal: AbortSignal): Promise<BaseConnection> {
    const acquisition = connectionManager.getPooledConnection(config);
    return new Promise<BaseConnection>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) {return;}
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(signal.reason instanceof Error ? signal.reason : new TransferCancelledError());
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
      acquisition.then(
        connection => {
          if (settled) {
            connectionManager.releasePooledConnection(config, connection);
            return;
          }
          settled = true;
          signal.removeEventListener('abort', onAbort);
          resolve(connection);
        },
        error => {
          if (settled) {return;}
          settled = true;
          signal.removeEventListener('abort', onAbort);
          reject(error);
        }
      );
    });
  }

  private resolveItem(item: TransferItem, outcome: TransferOutcome): void {
    const resolve = item.resolve;
    item.resolve = undefined;
    item.reject = undefined;
    resolve?.(outcome);
  }

  private rejectItem(item: TransferItem, error: unknown): void {
    const reject = item.reject;
    item.resolve = undefined;
    item.reject = undefined;
    reject?.(error);
  }

  private transferTargetKey(item: TransferItem): string {
    if (item.direction === 'download') {
      const resolved = path.resolve(item.localPath);
      return `download:${process.platform === 'win32' ? resolved.toLowerCase() : resolved}`;
    }
    const config = item.config!;
    const port = config.port || (config.protocol === 'sftp' ? 22 : 21);
    const remotePath = path.posix.resolve('/', normalizeRemotePath(item.remotePath));
    return `upload:${config.protocol}:${config.host.toLowerCase()}:${port}:${config.username}:${remotePath}`;
  }

  private registerLatestRequest(item: TransferItem): void {
    const key = this.transferTargetKey(item);
    const generation = ++this.nextTargetGeneration;
    this.latestTargetGenerations.set(key, generation);
    this.itemTargetGenerations.set(item.id, { key, generation });
  }

  private assertLatestRequest(item: TransferItem): void {
    const request = this.itemTargetGenerations.get(item.id);
    if (!request || this.latestTargetGenerations.get(request.key) !== request.generation) {
      throw new TransferSkippedError('superseded by a newer transfer for the same target');
    }
  }

  private releaseRequestGeneration(item: TransferItem): void {
    const request = this.itemTargetGenerations.get(item.id);
    if (!request) {return;}
    this.itemTargetGenerations.delete(item.id);
    if (this.latestTargetGenerations.get(request.key) === request.generation) {
      this.latestTargetGenerations.delete(request.key);
    }
  }

  private retireActiveConnection(itemId: string, reason: string): Promise<void> {
    const active = this.activeConnections.get(itemId);
    if (!active) {return Promise.resolve();}
    if (active.retirement) {return active.retirement;}
    active.retired = true;
    const primary = connectionManager.getConnection(active.config) === active.connection;
    active.retirement = (primary
      ? active.connection.disconnect()
      : connectionManager.discardPooledConnection(active.config, active.connection)
    ).catch(error => {
      logger.warn(`Failed to retire ${reason} transport for ${active.config.host}`, error);
    });
    return active.retirement;
  }

  private assertRemoteTypeCollisionTarget(config: FTPConfig, remotePath: string): void {
    const root = path.posix.resolve('/', normalizeRemotePath(config.remotePath || '/'));
    const target = path.posix.resolve('/', normalizeRemotePath(remotePath));
    const prefix = root === '/' ? '/' : `${root}/`;
    if (target === root || !target.startsWith(prefix)) {
      throw new Error(`Type-collision target is outside the configured remote root: ${remotePath}`);
    }
  }

  private assertLocalTypeCollisionTarget(config: FTPConfig, localPath: string): void {
    if (!config.localPath) {
      throw new Error('A configured local root is required for type-collision replacement');
    }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    const root = path.isAbsolute(config.localPath)
      ? path.resolve(config.localPath)
      : path.resolve(workspaceRoot, config.localPath);
    const target = path.resolve(localPath);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Type-collision target is outside the configured local root: ${localPath}`);
    }
  }

  private hasTypeReplacementAuthorization(
    item: Pick<TransferItem, 'sourceType' | 'targetType' | 'replaceTypeCollision'>,
    sourceType: 'file' | 'directory',
    targetType: 'file' | 'directory'
  ): boolean {
    return item.replaceTypeCollision === true
      && item.sourceType === sourceType
      && item.targetType === targetType;
  }

  private async removeRemoteReplacementBackup(
    connection: BaseConnection,
    backupPath: string,
    type: FileEntry['type']
  ): Promise<void> {
    if (type === 'directory') {await connection.rmdir(backupPath, true);}
    else {await connection.delete(backupPath);}
  }

  private async cleanupRemoteReplacementStaging(
    connection: BaseConnection,
    stagingPath: string,
    type: 'file' | 'directory'
  ): Promise<void> {
    try {
      if (type === 'directory') {await connection.rmdir(stagingPath, true);}
      else {await connection.delete(stagingPath);}
    } catch (error) {
      if (errorCode(error) === 2 || isRemoteMissingError(error)) {return;}
      logger.warn(`Failed to clean remote type-replacement staging for ${path.posix.basename(stagingPath)}`, error);
    }
  }

  private async promoteRemoteTypeReplacement(
    connection: BaseConnection,
    remotePath: string,
    stagingPath: string,
    targetType: FileEntry['type'],
    verify: () => Promise<void>
  ): Promise<void> {
    const backupPath = uniqueRemoteSiblingPath(remotePath, 'backup');
    let backedUp = false;
    let promoted = false;
    try {
      await connection.rename(remotePath, backupPath);
      backedUp = true;
      await connection.rename(stagingPath, remotePath);
      promoted = true;
      await verify();
    } catch (operationError) {
      try {
        if (promoted) {
          await connection.rename(remotePath, stagingPath);
          promoted = false;
        }
        if (backedUp) {
          await connection.rename(backupPath, remotePath);
          backedUp = false;
        }
      } catch (rollbackError) {
        throw Object.assign(
          new Error(`Remote type replacement and rollback failed for ${remotePath}; previous data remains at ${backupPath}`),
          { operationError, rollbackError }
        );
      }
      throw operationError;
    }

    await this.removeRemoteReplacementBackup(connection, backupPath, targetType);
  }

  private async promoteLocalTypeReplacement(
    localPath: string,
    stagingPath: string,
    targetType: 'file' | 'directory',
    verify: () => Promise<void>
  ): Promise<void> {
    const backupPath = uniqueLocalSiblingPath(localPath, 'backup');
    let backedUp = false;
    let promoted = false;
    try {
      await fs.promises.rename(localPath, backupPath);
      backedUp = true;
      await fs.promises.rename(stagingPath, localPath);
      promoted = true;
      await verify();
    } catch (operationError) {
      try {
        if (promoted) {
          await fs.promises.rename(localPath, stagingPath);
          promoted = false;
        }
        if (backedUp) {
          await fs.promises.rename(backupPath, localPath);
          backedUp = false;
        }
      } catch (rollbackError) {
        throw Object.assign(
          new Error(`Local type replacement and rollback failed for ${localPath}; previous data remains at ${backupPath}`),
          { operationError, rollbackError }
        );
      }
      throw operationError;
    }

    if (targetType === 'directory') {await fs.promises.rm(backupPath, { recursive: true });}
    else {await fs.promises.unlink(backupPath);}
  }

  private async handleCollision(targetPath: string, type: 'local' | 'remote', isDir = false): Promise<'overwrite' | 'skip'> {
    // Correctly serialize modal dialogs using a promise chain lock
    const currentLock = this.collisionLock;
    let resolveNext: () => void;
    this.collisionLock = new Promise(resolve => {
      resolveNext = resolve;
    });

    await currentLock;
    logger.debug(`Checking collision for: ${targetPath}`);

    try {
      // Re-check after acquiring lock in case it was set to 'All' by another thread
      if (this.sessionCollisionAction === 'overwrite') {return 'overwrite';}
      if (this.sessionCollisionAction === 'skip') {return 'skip';}

      const location = type === 'local' ? 'Local' : 'Remote';
      const kind = isDir ? 'directory' : 'file';
      const message = `${location} ${kind} already exists at "${targetPath}". Would you like to overwrite it?`;

      // Show modal dialog - this will block the lock
      const choice = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        'Overwrite', 'Skip', 'Overwrite All', 'Skip All'
      );

      logger.debug(`Collision choice for ${targetPath}: ${choice}`);

      if (choice === 'Overwrite All') {
        this.sessionCollisionAction = 'overwrite';
        return 'overwrite';
      } else if (choice === 'Skip All') {
        this.sessionCollisionAction = 'skip';
        return 'skip';
      } else if (choice === 'Overwrite') {
        return 'overwrite';
      } else {
        // Default to skip if canceled (Esc) to avoid accidental data loss
        return 'skip';
      }
    } finally {
      resolveNext!();
    }
  }

  async uploadFile(
    connection: BaseConnection,
    localPath: string,
    remotePath: string,
    config: FTPConfig,
    metadata?: TransferRequestOptions
  ): Promise<TransferOutcome> {
    return new Promise<TransferOutcome>((resolve, reject) => {
      const item: TransferItem = {
        id: generateId(),
        localPath,
        remotePath,
        direction: 'upload',
        status: 'pending',
        progress: 0,
        size: metadata?.size ?? 0,
        transferred: 0,
        config,
        resolve,
        reject,
        targetExists: metadata?.targetExists,
        sourceType: metadata?.sourceType,
        targetType: metadata?.targetType,
        replaceTypeCollision: metadata?.replaceTypeCollision
      };

      this.registerLatestRequest(item);
      this.queue.push(item);
      this.preferredConnections.set(item.id, connection);
      this._activeCount++;
      this.emitQueueUpdate(true);

      if (this.active) {this.wakeQueue?.();}
      else {this.scheduleProcessing();}
    });
  }

  async downloadFile(
    connection: BaseConnection,
    remotePath: string,
    localPath: string,
    config?: FTPConfig,
    metadata?: TransferRequestOptions
  ): Promise<TransferOutcome> {
    return new Promise<TransferOutcome>((resolve, reject) => {
      const item: TransferItem = {
        id: generateId(),
        localPath,
        remotePath,
        direction: 'download',
        status: 'pending',
        progress: 0,
        size: metadata?.size ?? 0,
        transferred: 0,
        config: config || connection.getConfig(),
        resolve,
        reject,
        targetExists: metadata?.targetExists,
        sourceType: metadata?.sourceType,
        targetType: metadata?.targetType,
        replaceTypeCollision: metadata?.replaceTypeCollision
      };

      this.registerLatestRequest(item);
      this.queue.push(item);
      this.preferredConnections.set(item.id, connection);
      this._activeCount++;
      this.emitQueueUpdate(true);

      if (this.active) {this.wakeQueue?.();}
      else {this.scheduleProcessing();}
    });
  }

  /**
   * Process the transfer queue using per-item connections.
   * Each item stores its own config, ensuring transfers go to the correct server.
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) {return;}

    this.isProcessing = true;
    this.active = true;
    this.cancelled = false;

    const concurrency = vscode.workspace.getConfiguration('stackerftp').get<number>('transferConcurrency', 4);
    let activeTransfers = 0;
    logger.info(`Transfer queue starting: ${this.queue.filter(item => item.status === 'pending').length} pending, concurrency ${concurrency}`);

    const processNext = async () => {
      if (this.cancelled) {return;}

      const item = this.queue.find(i => i.status === 'pending');
      if (!item) {return;}

      item.status = 'transferring';
      item.startTime = new Date();
      const abortController = new AbortController();
      this.abortControllers.set(item.id, abortController);
      activeTransfers++;
      logger.debug(`Transfer worker started: ${item.direction} ${item.remotePath} (${activeTransfers}/${concurrency} active)`);
      this.emit('transferStart', item);

      let pooledConnection: BaseConnection | undefined;
      let usingPrimaryConnection = false;
      let progressConnection: BaseConnection | undefined;
      let transferProgressListener: ((progress: { filename: string; transferred: number; total: number; percentage: number }) => void) | undefined;
      try {
        if (!item.config) {
          throw new Error('Transfer item missing config - cannot determine target server');
        }
        const config = item.config;

        // Start the first transfer immediately on the authenticated primary
        // session. Additional simultaneous workers acquire pooled sessions.
        const preferredConnection = this.preferredConnections.get(item.id);
        if (preferredConnection?.connected && !this.primaryTransfers.has(preferredConnection)) {
          pooledConnection = preferredConnection;
          usingPrimaryConnection = true;
          this.primaryTransfers.add(preferredConnection);
          logger.debug(`Transfer worker using active primary connection: ${item.remotePath}`);
        } else {
          pooledConnection = await this.acquirePooledConnection(item.config, abortController.signal);
        }
        const connection = pooledConnection;
        this.activeConnections.set(item.id, {
          connection,
          config: item.config,
          retired: false
        });
        if (abortController.signal.aborted) {
          throw abortController.signal.reason || new TransferCancelledError();
        }
        const expectedProgressPath = item.direction === 'upload' ? item.localPath : item.remotePath;
        transferProgressListener = (progress): void => {
          if (progress.filename !== expectedProgressPath) {return;}
          item.transferred = Math.max(0, Number(progress.transferred) || 0);
          const total = Math.max(0, Number(item.size) || Number(progress.total) || 0);
          item.progress = total > 0 ? Math.min(99, Math.round((item.transferred / total) * 100)) : 0;
          this.emitQueueUpdate();
        };
        progressConnection = connection;
        progressConnection.on('progress', transferProgressListener);

        if (item.direction === 'upload') {
          const localStat = await fs.promises.stat(item.localPath);
          if (!localStat.isFile()) {throw new Error(`Cannot upload non-file source: ${item.localPath}`);}
          item.size = localStat.size;

          await withSerializedRemoteWrite(config, item.remotePath, async () => {
            this.assertLatestRequest(item);
            // Scan metadata is a display hint only; overwrite authorization is
            // based on a fresh stat inside the same-target write lock.
            const remoteStat = await connection.stat(item.remotePath);
            let replaceRemoteDirectory = false;
            if (remoteStat) {
              if (remoteStat.type !== 'file') {
                if (remoteStat.type !== 'directory'
                  || !this.hasTypeReplacementAuthorization(item, 'file', 'directory')) {
                  throw new Error(`Cannot upload a file over remote ${remoteStat.type}: ${item.remotePath}`);
                }
                this.assertRemoteTypeCollisionTarget(config, item.remotePath);
                replaceRemoteDirectory = true;
              } else {
                let action: 'overwrite' | 'skip';
                if (config.syncMode === 'update') {
                  action = updateTransferAction(
                    'upload', localStat.size, remoteStat.size,
                    localStat.mtimeMs, remoteStat.modifyTime.getTime()
                  );
                } else {
                  action = config.collisionPolicy && config.collisionPolicy !== 'ask'
                    ? config.collisionPolicy === 'overwrite' ? 'overwrite' : 'skip'
                    : await this.handleCollision(item.remotePath, 'remote');
                }
                if (action === 'skip') {
                  throw new TransferSkippedError(
                    config.syncMode === 'update' ? 'upload source is not newer than the remote target' : 'collision policy'
                  );
                }
              }
            }

            beginRemoteWatcherWrite(config, item.remotePath);
            const replacementStaging = replaceRemoteDirectory
              ? uniqueRemoteSiblingPath(item.remotePath, 'upload')
              : undefined;
            try {
              const uploadTarget = replacementStaging || item.remotePath;
              await this.withTransferTimeout(
                connection.upload(item.localPath, uploadTarget, { writeLockHeld: true }),
                TransferManager.TRANSFER_TIMEOUT_MS,
                `upload ${path.basename(item.localPath)}`,
                abortController.signal,
                () => {void this.retireActiveConnection(item.id, 'timed-out');}
              );
              if (abortController.signal.aborted) {throw abortController.signal.reason;}
              let timestampPreserved = false;
              const verifyUploadTarget = async (): Promise<void> => {
                timestampPreserved = await connection.setModifyTime(item.remotePath, localStat.mtime);
                const verifiedTarget = await connection.stat(item.remotePath);
                assertTransferredFile(verifiedTarget, localStat.size, `Remote upload target ${item.remotePath}`);
                if (timestampPreserved
                  && (!isUsableModifyTime(verifiedTarget.modifyTime)
                    || !modificationTimesMatch(verifiedTarget.modifyTime, localStat.mtime))) {
                  throw new Error(`Remote upload timestamp verification failed for ${item.remotePath}`);
                }
              };
              if (replacementStaging) {
                assertTransferredFile(
                  await connection.stat(replacementStaging),
                  localStat.size,
                  `Remote upload replacement staging ${replacementStaging}`
                );
                await this.promoteRemoteTypeReplacement(
                  connection,
                  item.remotePath,
                  replacementStaging,
                  'directory',
                  verifyUploadTarget
                );
              } else {
                await verifyUploadTarget();
              }
              completeRemoteWatcherWrite(config, item.remotePath, {
                type: 'file',
                size: localStat.size,
                mtimeMs: timestampPreserved ? localStat.mtimeMs : undefined
              });
            } catch (error) {
              clearRemoteWatcherWrite(config, item.remotePath);
              throw error;
            } finally {
              if (replacementStaging) {
                await this.cleanupRemoteReplacementStaging(connection, replacementStaging, 'file');
              }
            }
          });
        } else {
          await withSerializedLocalWrite(item.localPath, async () => {
            this.assertLatestRequest(item);
            const remoteStat = await connection.stat(item.remotePath);
            if (!remoteStat) {throw new Error(`Remote download source is missing: ${item.remotePath}`);}
            assertTransferredFile(remoteStat, remoteStat.size, `Remote download source ${item.remotePath}`);
            item.size = remoteStat.size;

            let localStat: fs.Stats | undefined;
            try {
              localStat = await fs.promises.lstat(item.localPath);
            } catch (error) {
              if (errorCode(error) !== 'ENOENT') {throw error;}
            }
            if (localStat?.isSymbolicLink()) {
              throw new Error(`Refusing to replace symbolic link download target: ${item.localPath}`);
            }

            let replaceLocalDirectory = false;
            if (localStat) {
              if (localStat.isDirectory()) {
                if (!this.hasTypeReplacementAuthorization(item, 'file', 'directory')) {
                  throw new Error(`Cannot download a file over a local directory: ${item.localPath}`);
                }
                this.assertLocalTypeCollisionTarget(config, item.localPath);
                replaceLocalDirectory = true;
              } else {
                let action: 'overwrite' | 'skip';
                if (config.syncMode === 'update' && localStat.isFile()) {
                  action = updateTransferAction(
                    'download', localStat.size, remoteStat.size,
                    localStat.mtimeMs, remoteStat.modifyTime.getTime()
                  );
                } else {
                  action = config.collisionPolicy && config.collisionPolicy !== 'ask'
                    ? config.collisionPolicy === 'overwrite' ? 'overwrite' : 'skip'
                    : await this.handleCollision(item.localPath, 'local');
                }
                if (action === 'skip') {
                  throw new TransferSkippedError(
                    config.syncMode === 'update' ? 'download source is not newer than the local target' : 'collision policy'
                  );
                }
                if (!localStat.isFile()) {
                  throw new Error(`Cannot download a file over an unsafe local target: ${item.localPath}`);
                }
              }
            }

            // Downloads write locally and fire the filesystem watcher. Suppress
            // that event before the first byte is written so Auto Sync cannot
            // immediately upload the same file back to the server.
            beginWatcherWrite(item.localPath, TransferManager.TRANSFER_TIMEOUT_MS + 5000);
            const replacementStaging = replaceLocalDirectory
              ? uniqueLocalSiblingPath(item.localPath, 'download')
              : undefined;
            try {
              await this.withTransferTimeout(
                connection.download(item.remotePath, replacementStaging || item.localPath, { writeLockHeld: true }),
                TransferManager.TRANSFER_TIMEOUT_MS,
                `download ${path.basename(item.remotePath)}`,
                abortController.signal,
                () => {void this.retireActiveConnection(item.id, 'timed-out');}
              );
              if (abortController.signal.aborted) {throw abortController.signal.reason;}
              const verifyDownloadTarget = async (): Promise<void> => {
                const verifiedTarget = await fs.promises.lstat(item.localPath);
                if (!verifiedTarget.isFile() || verifiedTarget.isSymbolicLink()) {
                  throw new Error(`Local download target has an unsafe type after transfer: ${item.localPath}`);
                }
                if (verifiedTarget.size !== remoteStat.size) {
                  throw new Error(`Local download size mismatch after transfer: expected ${remoteStat.size} bytes, received ${verifiedTarget.size}`);
                }
                if (isUsableModifyTime(remoteStat.modifyTime)
                  && !modificationTimesMatch(verifiedTarget.mtime, remoteStat.modifyTime)) {
                  throw new Error(`Local download timestamp verification failed for ${item.localPath}`);
                }
              };
              if (replacementStaging) {
                const staged = await fs.promises.lstat(replacementStaging);
                if (!staged.isFile() || staged.isSymbolicLink() || staged.size !== remoteStat.size) {
                  throw new Error(`Local download replacement staging is invalid: ${replacementStaging}`);
                }
                await this.promoteLocalTypeReplacement(
                  item.localPath,
                  replacementStaging,
                  'directory',
                  verifyDownloadTarget
                );
              } else {
                await verifyDownloadTarget();
              }
            } finally {
              if (replacementStaging) {
                await fs.promises.rm(replacementStaging, { recursive: true, force: true });
              }
              // Cover the final filesystem event after success or partial-write
              // cleanup, without suppressing genuine edits for the full timeout.
              completeWatcherWrite(item.localPath, 3000);
            }
          });
        }

        if (abortController.signal.aborted) {
          throw abortController.signal.reason || new TransferCancelledError();
        }
        item.status = 'completed';
        item.progress = 100;
        this.resolveItem(item, { status: 'completed' });
      } catch (error) {
        const message = errorMessage(error, 'Unknown transfer error');
        if (abortController.signal.aborted || errorCode(error) === 'TRANSFER_CANCELLED') {
          item.status = 'cancelled';
          item.progress = 0;
          item.error = message;
          this.rejectItem(item, error instanceof Error ? error : new TransferCancelledError(message));
          logger.debug(`Transfer cancelled: ${item.remotePath}`);
        } else if (errorCode(error) === 'TRANSFER_SKIPPED') {
          const reason = error instanceof TransferSkippedError ? error.reason : message.replace(/^Skipped:\s*/i, '');
          item.status = 'skipped';
          item.progress = 0;
          item.error = reason;
          this.resolveItem(item, { status: 'skipped', reason });
          logger.debug(`Transfer skipped: ${item.remotePath}`, { reason });
        } else {
          item.status = 'error';
          item.error = message;
          logger.error(`Transfer failed: ${item.remotePath}`, error);
          this.rejectItem(item, error);
        }
      } finally {
        if (progressConnection && transferProgressListener) {
          progressConnection.removeListener('progress', transferProgressListener);
        }
        const activeConnection = this.activeConnections.get(item.id);
        if (activeConnection?.retirement) {await activeConnection.retirement;}
        // Release pooled connection back to pool
        if (usingPrimaryConnection && pooledConnection) {
          this.primaryTransfers.delete(pooledConnection);
        } else if (pooledConnection && item.config && !activeConnection?.retired) {
          connectionManager.releasePooledConnection(item.config, pooledConnection);
        }
        this.activeConnections.delete(item.id);
        this.abortControllers.delete(item.id);
        this.preferredConnections.delete(item.id);
        this.releaseRequestGeneration(item);
        item.endTime = new Date();
        if (item.status === 'completed') {
          this.recordCompletedTransfer(item);
        }
        activeTransfers--;
        if (this._activeCount > 0) {
          this._activeCount--;
        }
        this.emit('transferComplete', item);
        this.emitQueueUpdate();

        // Spawn workers up to concurrency for pending items
        const pendingCount = this.queue.filter(i => i.status === 'pending').length;
        if (!this.cancelled && pendingCount > 0) {
            const slotsAvailable = concurrency - activeTransfers;
            const toSpawn = Math.min(pendingCount, slotsAvailable);
            for (let i = 0; i < toSpawn; i++) {
              processNext().catch(() => {});
            }
        } else if (activeTransfers === 0 && this.completionResolve) {
          this.completionResolve();
          this.completionResolve = null;
        }
      }
    };

    const spawnAvailableWorkers = (): void => {
      const slotsAvailable = Math.max(0, concurrency - activeTransfers);
      const count = Math.min(slotsAvailable, this.queue.filter(item => item.status === 'pending').length);
      for (let index = 0; index < count; index++) {void processNext();}
    };

    try {
      await new Promise<void>(resolve => {
        this.completionResolve = resolve;
        this.wakeQueue = spawnAvailableWorkers;
        spawnAvailableWorkers();
        if (activeTransfers === 0 && !this.queue.some(item => item.status === 'pending')) {resolve();}
      });
    } finally {
      this.wakeQueue = undefined;
      this.completionResolve = null;
      this.isProcessing = false;
      this.active = false;
      this.emit('queueComplete');
    }
  }

  public getAnalytics(days = 14): TransferAnalytics {
    const now = new Date();
    const dayEntries = Array.from({ length: days }, (_, offset) => {
      const day = new Date(now);
      day.setHours(0, 0, 0, 0);
      day.setDate(day.getDate() - (days - 1 - offset));
      return {
        date: day.toISOString().slice(0, 10),
        uploadedBytes: 0,
        downloadedBytes: 0,
        uploadedFiles: 0,
        downloadedFiles: 0
      };
    });
    const byDate = new Map(dayEntries.map(entry => [entry.date, entry]));
    let uploadedFiles = 0;
    let downloadedFiles = 0;
    let uploadedBytes = 0;
    let downloadedBytes = 0;
    let totalDurationMs = 0;

    for (const item of this.transferHistory) {
      if (!item.endTime) {continue;}
      const date = item.endTime.toISOString().slice(0, 10);
      const entry = byDate.get(date);
      if (!entry) {continue;}
      const size = Math.max(0, item.size || item.transferred || 0);
      const duration = item.startTime ? Math.max(0, item.endTime.getTime() - item.startTime.getTime()) : 0;
      totalDurationMs += duration;

      if (item.direction === 'upload') {
        uploadedFiles++;
        uploadedBytes += size;
        entry.uploadedFiles++;
        entry.uploadedBytes += size;
      } else {
        downloadedFiles++;
        downloadedBytes += size;
        entry.downloadedFiles++;
        entry.downloadedBytes += size;
      }
    }

    const completed = uploadedFiles + downloadedFiles;
    return {
      uploadedFiles,
      downloadedFiles,
      uploadedBytes,
      downloadedBytes,
      averageDurationMs: completed ? Math.round(totalDurationMs / completed) : 0,
      days: dayEntries
    };
  }

  private recordCompletedTransfer(item: TransferItem): void {
    this.transferHistory.push({ ...item });
    if (this.transferHistory.length > 500) {
      this.transferHistory.splice(0, this.transferHistory.length - 500);
    }
  }

  async uploadDirectory(
    connection: BaseConnection,
    localPath: string,
    remotePath: string,
    config: FTPConfig,
    options?: TransferRequestOptions
  ): Promise<SyncResult> {
    const localSource = await fs.promises.lstat(localPath);
    if (!localSource.isDirectory() || localSource.isSymbolicLink()) {
      throw new Error(`Cannot upload non-directory source: ${localPath}`);
    }
    if (options?.replaceTypeCollision) {
      if (options.sourceType !== 'directory' || options.targetType !== 'file') {
        throw new Error('Directory upload replacement requires exact directory-to-file type authorization');
      }
      this.assertRemoteTypeCollisionTarget(config, remotePath);
      const replacementStaging = uniqueRemoteSiblingPath(remotePath, 'upload');
      try {
        const stagedResult = await this.uploadDirectory(connection, localPath, replacementStaging, config);
        if (stagedResult.failed.length || stagedResult.skipped.length) {
          throw new Error(
            `Unable to stage complete directory replacement: ${stagedResult.failed.length} failed, ${stagedResult.skipped.length} skipped`
          );
        }
        const staged = await connection.stat(replacementStaging);
        if (!staged || staged.type !== 'directory') {
          throw new Error(`Remote directory replacement staging is missing: ${replacementStaging}`);
        }

        await withSerializedRemoteWrite(config, remotePath, async () => {
          const target = await connection.stat(remotePath);
          const verify = async (): Promise<void> => {
            const promoted = await connection.stat(remotePath);
            if (!promoted || promoted.type !== 'directory') {
              throw new Error(`Remote directory replacement verification failed: ${remotePath}`);
            }
          };
          if (!target) {
            await connection.rename(replacementStaging, remotePath);
            try {await verify();}
            catch (error) {
              await connection.rename(remotePath, replacementStaging);
              throw error;
            }
            return;
          }
          if (target.type !== 'file') {
            throw new Error(`Remote replacement target changed type before upload: ${remotePath}`);
          }
          await this.promoteRemoteTypeReplacement(
            connection,
            remotePath,
            replacementStaging,
            'file',
            verify
          );
        });
        return stagedResult;
      } finally {
        await this.cleanupRemoteReplacementStaging(connection, replacementStaging, 'directory');
      }
    }

    const result: SyncResult = {
      uploaded: [],
      downloaded: [],
      deleted: [],
      failed: [],
      skipped: []
    };

    statusBar.info(`Scanning local files: ${path.basename(localPath)}...`);
    const ignorePatterns = [...DEFAULT_IGNORE_PATTERNS, ...(config.ignore || [])];
    const localEntries = await this.getLocalFiles(localPath, ignorePatterns);
    const files = localEntries.files;

    // Create the selected root and every discovered directory before files so
    // an entirely empty tree is still represented remotely.
    try {
      await connection.mkdir(remotePath);
    } catch (error) {
      result.failed.push({ path: '.', error: errorMessage(error) });
      return result;
    }
    for (const directory of localEntries.directories) {
      const relativePath = path.relative(localPath, directory);
      const remoteDirectoryPath = normalizeRemotePath(path.join(remotePath, relativePath));
      try {
        await connection.mkdir(remoteDirectoryPath);
      } catch (error) {
        result.failed.push({ path: relativePath, error: errorMessage(error) });
      }
    }
    if (files.length === 0) {
      statusBar.info('Empty directory tree uploaded');
      return result;
    }

    this.sessionCollisionAction = 'ask';
    statusBar.info(`Adding ${files.length} files to queue...`);

    const filePromises = files.map(async (file) => {
      if (this.cancelled) {return;}

      const relativePath = path.relative(localPath, file);
      const remoteFilePath = normalizeRemotePath(path.join(remotePath, relativePath));

      if (isPathIgnored(relativePath, ignorePatterns)) {
        result.skipped.push(relativePath);
        return;
      }

      try {
        // Existence/collision checks are done lazily in processQueue.
        const outcome = await this.uploadFile(connection, file, remoteFilePath, config);
        if (outcome.status === 'completed') {result.uploaded.push(relativePath);}
        else {result.skipped.push(relativePath);}
      } catch (error) {
        logger.error(`Upload failed for ${relativePath}:`, error);
        result.failed.push({ path: relativePath, error: errorMessage(error) });
      }
    });

    // Wait for all queued items to complete
    await Promise.all(filePromises);

    logger.info(`Upload directory complete: ${result.uploaded.length} uploaded, ${result.failed.length} failed, ${result.skipped.length} skipped`);
    return result;
  }

  async downloadDirectory(
    connection: BaseConnection,
    remotePath: string,
    localPath: string,
    config: FTPConfig,
    options?: TransferRequestOptions
  ): Promise<SyncResult> {
    if (options?.replaceTypeCollision) {
      if (options.sourceType !== 'directory' || options.targetType !== 'file') {
        throw new Error('Directory download replacement requires exact directory-to-file type authorization');
      }
      const remoteSource = await connection.stat(remotePath);
      if (!remoteSource || remoteSource.type !== 'directory') {
        throw new Error(`Remote directory source changed type before download: ${remotePath}`);
      }
      this.assertLocalTypeCollisionTarget(config, localPath);
      const replacementStaging = uniqueLocalSiblingPath(localPath, 'download');
      try {
        const stagedResult = await this.downloadDirectory(connection, remotePath, replacementStaging, config);
        if (stagedResult.failed.length || stagedResult.skipped.length) {
          throw new Error(
            `Unable to stage complete directory replacement: ${stagedResult.failed.length} failed, ${stagedResult.skipped.length} skipped`
          );
        }
        const staged = await fs.promises.lstat(replacementStaging);
        if (!staged.isDirectory() || staged.isSymbolicLink()) {
          throw new Error(`Local directory replacement staging is invalid: ${replacementStaging}`);
        }

        await withSerializedLocalWrite(localPath, async () => {
          let target: fs.Stats | undefined;
          try {target = await fs.promises.lstat(localPath);}
          catch (error) {if (errorCode(error) !== 'ENOENT') {throw error;}}
          const verify = async (): Promise<void> => {
            const promoted = await fs.promises.lstat(localPath);
            if (!promoted.isDirectory() || promoted.isSymbolicLink()) {
              throw new Error(`Local directory replacement verification failed: ${localPath}`);
            }
          };
          if (!target) {
            await fs.promises.rename(replacementStaging, localPath);
            try {await verify();}
            catch (error) {
              await fs.promises.rename(localPath, replacementStaging);
              throw error;
            }
            return;
          }
          if (!target.isFile() || target.isSymbolicLink()) {
            throw new Error(`Local replacement target changed type before download: ${localPath}`);
          }
          await this.promoteLocalTypeReplacement(localPath, replacementStaging, 'file', verify);
        });
        return stagedResult;
      } finally {
        await fs.promises.rm(replacementStaging, { recursive: true, force: true });
      }
    }

    const result: SyncResult = {
      uploaded: [],
      downloaded: [],
      deleted: [],
      failed: [],
      skipped: []
    };

    statusBar.info(`Scanning remote files: ${path.basename(remotePath)}...`);
    const ignorePatterns = [...DEFAULT_IGNORE_PATTERNS, ...(config.ignore || [])];
    const files = await this.getRemoteFiles(connection, remotePath, ignorePatterns);
    await fs.promises.mkdir(localPath, { recursive: true });
    if (files.length === 0) {
      statusBar.info('Empty directory tree downloaded');
      return result;
    }

    this.sessionCollisionAction = 'ask';

    // Process directory creation first
    statusBar.info(`Creating directory structure...`);
    for (const file of files) {
      if (file.type === 'directory' || file.isSymlinkToDirectory) {
        const relativePath = path.relative(remotePath, file.path);
        const localFilePath = path.join(localPath, relativePath);
        try {
          await fs.promises.mkdir(localFilePath, { recursive: true });
        } catch (error) {
          result.failed.push({ path: relativePath, error: errorMessage(error) });
        }
      }
    }

    const dataFiles = files.filter(f => f.type !== 'directory' && !f.isSymlinkToDirectory);
    statusBar.info(`Adding ${dataFiles.length} files to queue...`);

    const filePromises = dataFiles.map(async (file) => {
      if (this.cancelled) {return;}

      const relativePath = path.relative(remotePath, file.path);
      const localFilePath = path.join(localPath, relativePath);

      if (isPathIgnored(relativePath, ignorePatterns)) {
        result.skipped.push(relativePath);
        return;
      }

      try {
        // Bypass redundant stat calls by passing known remote and local metadata
        const outcome = await this.downloadFile(connection, file.path, localFilePath, config, {
          size: file.size,
          targetType: 'file'
        });
        if (outcome.status === 'completed') {result.downloaded.push(relativePath);}
        else {result.skipped.push(relativePath);}
      } catch (error) {
        result.failed.push({ path: relativePath, error: errorMessage(error) });
      }
    });

    await Promise.all(filePromises);
    logger.info(`Download directory complete: ${result.downloaded.length} downloaded, ${result.failed.length} failed, ${result.skipped.length} skipped`);
    return result;
  }

  async syncToRemote(
    connection: BaseConnection,
    localPath: string,
    remotePath: string,
    config: FTPConfig
  ): Promise<SyncResult> {
    return this.uploadDirectory(connection, localPath, remotePath, config);
  }

  async syncToLocal(
    connection: BaseConnection,
    remotePath: string,
    localPath: string,
    config: FTPConfig
  ): Promise<SyncResult> {
    return this.downloadDirectory(connection, remotePath, localPath, config);
  }

  async syncBothWays(
    connection: BaseConnection,
    localPath: string,
    remotePath: string,
    config: FTPConfig
  ): Promise<SyncResult> {
    // First download from remote
    const downloadResult = await this.downloadDirectory(connection, remotePath, localPath, config);

    // Then upload to remote
    const uploadResult = await this.uploadDirectory(connection, localPath, remotePath, config);

    return {
      uploaded: uploadResult.uploaded,
      downloaded: downloadResult.downloaded,
      deleted: [...downloadResult.deleted, ...uploadResult.deleted],
      failed: [...downloadResult.failed, ...uploadResult.failed],
      skipped: [...downloadResult.skipped, ...uploadResult.skipped]
    };
  }

  private async getLocalFiles(
    dir: string,
    ignorePatterns?: string[]
  ): Promise<{ files: string[]; directories: string[] }> {
    const files: string[] = [];
    const directories: string[] = [];
    const MAX_FILES = 100000;
    const MAX_DEPTH = 50;

    const traverse = async (currentDir: string, depth: number) => {
      if (depth > MAX_DEPTH) {
        throw new TransferTraversalLimitError(`Local directory traversal exceeded the maximum depth of ${MAX_DEPTH}: ${currentDir}`);
      }

      const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
      const subdirs: string[] = [];

      for (const entry of entries) {
        if (files.length + directories.length >= MAX_FILES) {
          throw new TransferTraversalLimitError(`Local directory traversal exceeded the maximum entry count of ${MAX_FILES}: ${dir}`);
        }
        const fullPath = path.join(currentDir, entry.name);
        const relativePath = path.relative(dir, fullPath);
        if (isPathIgnored(relativePath, ignorePatterns)) {continue;}

        if (entry.isDirectory()) {
          directories.push(fullPath);
          subdirs.push(fullPath);
        } else {
          files.push(fullPath);
        }
      }

      // Process subdirectories in parallel batches of 25
      for (let i = 0; i < subdirs.length; i += 25) {
        const batch = subdirs.slice(i, i + 25);
        await Promise.all(batch.map(d => traverse(d, depth + 1)));
      }
    };

    await traverse(dir, 0);
    return { files, directories };
  }

  private async getRemoteFiles(connection: BaseConnection, remotePath: string, ignorePatterns?: string[]): Promise<FileEntry[]> {
    const files: FileEntry[] = [];
    const MAX_FILES = 100000;
    const MAX_DEPTH = 50;
    const normalizedRoot = normalizeRemotePath(remotePath).replace(/\/+$/g, '');

    const traverse = async (currentPath: string, depth: number) => {
      if (depth > MAX_DEPTH) {
        throw new TransferTraversalLimitError(`Remote directory traversal exceeded the maximum depth of ${MAX_DEPTH}: ${currentPath}`);
      }

      const entries = await connection.list(currentPath);
      const subdirs: string[] = [];

      for (const entry of entries) {
        if (files.length >= MAX_FILES) {
          throw new TransferTraversalLimitError(`Remote directory traversal exceeded the maximum entry count of ${MAX_FILES}: ${remotePath}`);
        }
        const fullPath = normalizeRemotePath(path.join(currentPath, entry.name));
        const relativePath = fullPath.startsWith(`${normalizedRoot}/`) ? fullPath.slice(normalizedRoot.length + 1) : entry.name;
        if (isPathIgnored(relativePath, ignorePatterns)) {continue;}

        if (entry.type === 'directory') {
          files.push({ ...entry, path: fullPath });
          subdirs.push(fullPath);
        } else {
          files.push({ ...entry, path: fullPath });
        }
      }

      // Process remote subdirectories in parallel batches of 25
      for (let i = 0; i < subdirs.length; i += 25) {
        const batch = subdirs.slice(i, i + 25);
        await Promise.all(batch.map(d => traverse(d, depth + 1)));
      }
    };

    await traverse(remotePath, 0);
    return files;
  }

  cancel(): void {
    this.cancelled = true;
    const error = new TransferCancelledError('Transfer queue cancelled by user');
    for (const item of this.queue) {
      if (item.status !== 'pending' && item.status !== 'transferring') {continue;}
      const wasPending = item.status === 'pending';
      item.status = 'cancelled';
      item.error = error.message;
      item.endTime = new Date();
      this.rejectItem(item, error);
      this.abortControllers.get(item.id)?.abort(error);
      if (this.activeConnections.has(item.id)) {
        void this.retireActiveConnection(item.id, 'cancelled');
      } else if (wasPending) {
        this.preferredConnections.delete(item.id);
        this.releaseRequestGeneration(item);
        if (this._activeCount > 0) {this._activeCount--;}
      }
    }
    this.emitQueueUpdate();
  }

  /**
   * Cancel a specific transfer by ID
   */
  cancelItem(id: string): void {
    const item = this.queue.find(queueItem => queueItem.id === id);
    if (!item || (item.status !== 'pending' && item.status !== 'transferring')) {return;}
    const wasPending = item.status === 'pending';
    const error = new TransferCancelledError('Transfer cancelled by user');
    item.status = 'cancelled';
    item.error = error.message;
    item.endTime = new Date();
    this.rejectItem(item, error);
    this.abortControllers.get(item.id)?.abort(error);
    if (this.activeConnections.has(item.id)) {
      void this.retireActiveConnection(item.id, 'cancelled');
    } else if (wasPending) {
      this.preferredConnections.delete(item.id);
      this.releaseRequestGeneration(item);
      if (this._activeCount > 0) {this._activeCount--;}
    }
    this.emitQueueUpdate();
  }

  /**
   * Retry failed transfers by resetting them back to pending state.
   * Returns the number of transfers that were re-queued.
   */
  retryItems(ids: string[]): number {
    let retriedCount = 0;

    for (const id of ids) {
      const item = this.queue.find(queueItem => queueItem.id === id);
      if (!item || item.status !== 'error') {
        continue;
      }

      item.status = 'pending';
      item.progress = 0;
      item.transferred = 0;
      item.error = undefined;
      item.startTime = undefined;
      item.endTime = undefined;
      item.resolve = undefined;
      item.reject = undefined;
      this.registerLatestRequest(item);
      retriedCount++;
      this._activeCount++;
    }

    if (retriedCount > 0) {
      this.emitQueueUpdate();

      if (!this.active) {
        this.processQueue().catch(() => {});
      }
    }

    return retriedCount;
  }

  /**
   * Clear completed and error items from queue
   */
  clearCompleted(): void {
    this.queue = this.queue.filter(item =>
      item.status === 'pending' || item.status === 'transferring'
    );
    this.emitQueueUpdate();
  }

  getQueue(): TransferItem[] {
    return [...this.queue];
  }

  getCurrentItem(): TransferItem | undefined {
    return this.currentItem;
  }

  getActiveCount(): number {
    return this._activeCount;
  }

  isActive(): boolean {
    return this.active;
  }

  dispose(): void {
    this.cancel();
    this.removeAllListeners();
  }
}

export const transferManager = new TransferManager();

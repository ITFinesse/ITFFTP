/**
 * ITFFTP - File Watcher
 *
 * Observes both sides while the global watcher is enabled. Auto Sync controls
 * transfers; observation and UI invalidation remain active in every direction.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { FTPConfig } from '../types';
import { connectionManager } from './connection-manager';
import { transferManager } from './transfer-manager';
import { logger } from '../utils/logger';
import { DEFAULT_IGNORE_PATTERNS, normalizeRemotePath, isPathIgnored } from '../utils/helpers';
import {
  beginRemoteWatcherWrite,
  clearRemoteWatcherWrite,
  completeRemoteWatcherDelete,
  completeRemoteWatcherWrite,
  isGeneratedWatcherWrite,
  isRemoteWatcherWriteSuppressed,
  RemoteWatcherSignature
} from './watcher-suppression';
import { FTP_MODIFY_TIME_TOLERANCE_MS } from './diff-comparison';
import { isConnectionClosedError } from './connection-errors';
import { connectionEndpointIdentity } from './connection-identity';

export interface WatcherConflict {
  kind: 'both-sides-dirty' | 'confirmation-required' | 'local-protected';
  reason: string;
}

export interface WatchedChange {
  side: 'local' | 'remote';
  path: string;
  type: 'create' | 'change' | 'delete';
  /** Known at observation time so consumers can rescan new subtrees correctly. */
  kind?: 'file' | 'directory';
  /** True when this local event successfully changed the remote filesystem. */
  remoteMutated?: boolean;
  /** A completed file transfer whose source generation is still current. */
  completedDirection?: 'upload' | 'download';
  /** Explicit reason that observation completed without an automatic transfer. */
  conflict?: WatcherConflict;
}

type ChangeType = 'create' | 'change' | 'delete';
type WatchedChangeListener = (change: WatchedChange) => void | Promise<void>;

interface PendingLocalChange {
  filePath: string;
  type: ChangeType;
  version: number;
  quietUntil: number;
}

interface PendingRemoteChange {
  type: ChangeType;
  signature: RemoteWatcherSignature;
  directory: boolean;
  version: number;
  quietUntil: number;
}

class RemotePollPreemptedError extends Error {
  constructor(readonly reason: 'foreground-transfer' | 'watcher-stopped' = 'foreground-transfer') {
    super(reason === 'watcher-stopped'
      ? 'Remote watcher poll stopped with its owner'
      : 'Remote watcher poll preempted by a foreground transfer');
    this.name = 'RemotePollPreemptedError';
  }
}

export type AutoDownloadGuard = (relativePath: string) => boolean | Promise<boolean>;

const LOCAL_CHANGE_QUIET_MS = 1000;
const REMOTE_CHANGE_QUIET_MS = 1000;
const REMOTE_POLL_MIN_DELAY_MS = 1000;
const REMOTE_POLL_IDLE_MIN_DELAY_MS = 15_000;
// Keep external edits visible within half a minute while avoiding a perpetual
// directory walk on large or slow servers.
const REMOTE_POLL_IDLE_MAX_DELAY_MS = 30_000;
const REMOTE_POLL_SCAN_MULTIPLIER = 4;
const REMOTE_POLL_PATH_COST_MS = 20;

function normalizeLocalKey(localPath: string): string {
  const resolved = path.resolve(localPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function remoteSignature(entry: { type: string; size?: number; modifyTime?: Date | number }): RemoteWatcherSignature {
  const candidateSize = Number(entry.size);
  const candidateTime = entry.modifyTime instanceof Date
    ? entry.modifyTime.getTime()
    : Number(entry.modifyTime);
  return {
    type: entry.type === 'directory' ? 'directory' : entry.type === 'symlink' ? 'symlink' : 'file',
    size: Number.isFinite(candidateSize) && candidateSize >= 0 ? candidateSize : undefined,
    // Servers that omit, round, or return invalid timestamps must not produce a
    // new remote change on every poll. Unknown is deliberately distinct from 0.
    mtimeMs: Number.isFinite(candidateTime) && candidateTime > 0 ? candidateTime : undefined
  };
}

function signaturesEqual(left: RemoteWatcherSignature | undefined, right: RemoteWatcherSignature): boolean {
  return !!left
    && left.type === right.type
    && left.size === right.size
    && (left.mtimeMs === undefined || right.mtimeMs === undefined
      || Math.abs(left.mtimeMs - right.mtimeMs) <= FTP_MODIFY_TIME_TOLERANCE_MS);
}

export class FileWatcher implements vscode.Disposable {
  private readonly watchers = new Map<string, vscode.FileSystemWatcher>();
  private readonly workspaceRoot: string;
  private readonly config: FTPConfig;
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly pendingChanges = new Map<string, PendingLocalChange>();
  private readonly localVersions = new Map<string, number>();
  private readonly localProcessing = new Set<string>();
  private readonly remoteChangeTimers = new Map<string, NodeJS.Timeout>();
  private readonly pendingRemoteChanges = new Map<string, PendingRemoteChange>();
  private readonly remoteVersions = new Map<string, number>();
  private readonly remoteProcessing = new Set<string>();
  private readonly locallyDirtyPaths = new Set<string>();
  private readonly remotelyDirtyPaths = new Set<string>();
  private readonly reportedConflictPaths = new Set<string>();
  private remoteSnapshot = new Map<string, RemoteWatcherSignature>();
  private remotePollTimer?: NodeJS.Timeout;
  private remotePollRunning = false;
  private remoteSnapshotReady = false;
  private remotePollDelayMs = REMOTE_POLL_MIN_DELAY_MS;
  private disposed = false;
  private readonly onChange?: WatchedChangeListener;
  private readonly canAutoDownload?: AutoDownloadGuard;

  constructor(
    workspaceRoot: string,
    config: FTPConfig,
    onChange?: WatchedChangeListener,
    canAutoDownload?: AutoDownloadGuard
  ) {
    this.workspaceRoot = workspaceRoot;
    this.config = config;
    this.onChange = onChange;
    this.canAutoDownload = canAutoDownload;
  }

  start(): void {
    this.disposed = false;
    const watcherConfig = this.getWatcherConfig();
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.workspaceRoot, watcherConfig.files), false, false, false
    );
    watcher.onDidCreate(uri => this.handleFileChange(uri.fsPath, 'create'));
    watcher.onDidChange(uri => this.handleFileChange(uri.fsPath, 'change'));
    watcher.onDidDelete(uri => this.handleFileChange(uri.fsPath, 'delete'));
    this.watchers.set(this.getWatcherKey(), watcher);
    logger.info(`Local file watcher started for pattern: ${watcherConfig.files}`);

    this.scheduleRemotePoll(REMOTE_POLL_MIN_DELAY_MS);
    logger.info(`Remote file watcher started with adaptive ${REMOTE_POLL_MIN_DELAY_MS}-${REMOTE_POLL_IDLE_MAX_DELAY_MS}ms polling`);
  }

  stop(): void {
    this.disposed = true;
    for (const [key, watcher] of this.watchers) {
      watcher.dispose();
      logger.info(`File watcher stopped: ${key}`);
    }
    this.watchers.clear();
    this.clearDebounceTimers();
    if (this.remotePollTimer) {clearTimeout(this.remotePollTimer);}
    this.remotePollTimer = undefined;
    for (const timer of this.remoteChangeTimers.values()) {clearTimeout(timer);}
    this.remoteChangeTimers.clear();
    this.pendingRemoteChanges.clear();
    this.remoteVersions.clear();
    this.locallyDirtyPaths.clear();
    this.remotelyDirtyPaths.clear();
    this.reportedConflictPaths.clear();
    this.remoteSnapshot.clear();
    this.remoteSnapshotReady = false;
  }

  restart(): void {
    this.stop();
    this.start();
  }

  private getWatcherConfig(): { files: string; autoUpload: boolean; autoDelete: boolean } {
    if (typeof this.config.watcher === 'object') {
      return {
        files: this.config.watcher.files || '**/*',
        autoUpload: this.config.watcher.autoUpload !== false,
        autoDelete: this.config.watcher.autoDelete === true
      };
    }
    return {
      files: '**/*',
      autoUpload: this.config.watcher === true || this.config.uploadOnSave === true,
      autoDelete: false
    };
  }

  private getSyncDirections(): { upload: boolean; download: boolean } {
    switch (this.config.autoSync) {
      case 'upload': return { upload: true, download: false };
      case 'download': return { upload: false, download: true };
      case 'both': return { upload: true, download: true };
      case 'off': return { upload: false, download: false };
      default:
        // Legacy configs had upload-side switches only. downloadOnOpen remains
        // a Remote Explorer action and must never enable background downloads.
        return { upload: this.getWatcherConfig().autoUpload, download: false };
    }
  }

  private handleFileChange(filePath: string, type: ChangeType): void {
    const relativePath = path.relative(this.workspaceRoot, filePath);
    if (isPathIgnored(relativePath, [...DEFAULT_IGNORE_PATTERNS, ...(this.config.ignore || [])])) {return;}
    if (isGeneratedWatcherWrite(filePath)) {
      logger.debug(`Skipping ITFFTP-generated local write: ${relativePath}`);
      return;
    }

    logger.debug(`File ${type}: ${relativePath}`);
    this.locallyDirtyPaths.add(relativePath.replace(/\\/g, '/'));
    const localKey = normalizeLocalKey(filePath);
    const existingTimer = this.debounceTimers.get(localKey);
    if (existingTimer) {clearTimeout(existingTimer);}

    const version = (this.localVersions.get(localKey) || 0) + 1;
    this.localVersions.set(localKey, version);
    this.pendingChanges.set(localKey, {
      filePath,
      type,
      version,
      quietUntil: Date.now() + LOCAL_CHANGE_QUIET_MS
    });
    this.scheduleLocalFlush(localKey, LOCAL_CHANGE_QUIET_MS);
  }

  private scheduleLocalFlush(localKey: string, delayMs: number): void {
    const existing = this.debounceTimers.get(localKey);
    if (existing) {clearTimeout(existing);}
    const timer = setTimeout(() => {
      this.debounceTimers.delete(localKey);
      void this.flushLocalChange(localKey);
    }, Math.max(0, delayMs));
    this.debounceTimers.set(localKey, timer);
  }

  private async flushLocalChange(localKey: string): Promise<void> {
    if (this.disposed || this.localProcessing.has(localKey)) {return;}
    const pending = this.pendingChanges.get(localKey);
    if (!pending) {return;}
    const quietRemaining = pending.quietUntil - Date.now();
    if (quietRemaining > 0) {
      this.scheduleLocalFlush(localKey, quietRemaining);
      return;
    }

    this.pendingChanges.delete(localKey);
    this.localProcessing.add(localKey);
    try {
      await this.processChange(pending.filePath, pending, localKey);
    } finally {
      this.localProcessing.delete(localKey);
      const next = this.pendingChanges.get(localKey);
      if (next && !this.disposed) {
        this.scheduleLocalFlush(localKey, Math.max(0, next.quietUntil - Date.now()));
      } else {
        this.localVersions.delete(localKey);
      }
    }
  }

  private async processChange(
    filePath: string,
    change: Omit<PendingLocalChange, 'filePath'> & { filePath?: string },
    localKey = normalizeLocalKey(filePath)
  ): Promise<void> {
    if (this.disposed || isGeneratedWatcherWrite(filePath)) {return;}
    const relativePath = path.relative(this.workspaceRoot, filePath);
    const relativeDisplayPath = relativePath.replace(/\\/g, '/');
    const remotePath = normalizeRemotePath(path.join(this.config.remotePath, relativePath));
    const directions = this.getSyncDirections();
    const watcherConfig = this.getWatcherConfig();
    let remoteMutated = false;
    let completedDirection: WatchedChange['completedDirection'];
    let conflict: WatcherConflict | undefined;
    let kind: WatchedChange['kind'];

    // Observation is independent of Auto Sync and connection state. In
    // particular, the comparison consumer must know that a newly-created
    // directory needs a recursive subtree refresh even while transfers are off.
    let observedStat: fs.Stats | undefined;
    if (change.type === 'create' || change.type === 'change') {
      try {
        observedStat = await fs.promises.stat(filePath);
        kind = observedStat.isDirectory() ? 'directory' : 'file';
      } catch {
        // The path may have changed again before the quiet period elapsed. The
        // later event remains queued and the UI still receives this observation.
      }
    }

    try {
      if (change.type === 'create' || change.type === 'change') {
        if (!directions.upload) {
          logger.debug(`Auto-upload disabled, observed only: ${relativePath}`);
        } else if (this.hasTwoSidedConflict(relativeDisplayPath)) {
          conflict = this.reportConflict(
            relativeDisplayPath,
            'both-sides-dirty',
            'both the local and remote copies changed independently; choose Upload or Download in Transfer'
          );
        } else if (!connectionManager.isConnected(this.config)) {
          logger.debug(`No active connection, observed local change only: ${relativePath}`);
        } else {
          const connection = connectionManager.getConnection(this.config);
          if (connection && observedStat) {
            if (observedStat.isDirectory()) {
              beginRemoteWatcherWrite(this.config, remotePath);
              try {
                await connection.mkdir(remotePath);
                completeRemoteWatcherWrite(this.config, remotePath, { type: 'directory', size: 0, mtimeMs: 0 });
                remoteMutated = true;
                if (this.localVersions.get(localKey) === change.version) {
                  this.markPathSynchronized(relativeDisplayPath);
                }
              } catch (error) {
                clearRemoteWatcherWrite(this.config, remotePath);
                throw error;
              }
            } else {
              const remoteDirectory = normalizeRemotePath(path.dirname(remotePath));
              try { await connection.mkdir(remoteDirectory); } catch { /* Directory may already exist. */ }
              const remoteEntry = await connection.stat(remotePath);
              if (this.hasTwoSidedConflict(relativeDisplayPath)) {
                conflict = this.reportConflict(
                  relativeDisplayPath,
                  'both-sides-dirty',
                  'both the local and remote copies changed independently; choose Upload or Download in Transfer'
                );
                return;
              }
              if (this.requiresBackgroundConfirmation(remoteEntry?.type)) {
                conflict = this.reportConflict(
                  relativeDisplayPath,
                  'confirmation-required',
                  'the configured collision policy requires confirmation; choose Upload in Transfer'
                );
                return;
              }
              const outcome = await transferManager.uploadFile(
                connection,
                filePath,
                remotePath,
                this.backgroundTransferConfig()
              );
              if (outcome.status === 'completed') {
                remoteMutated = true;
                // A later filesystem event means this completed upload belongs
                // to an older generation. It changed the remote, but must not
                // clear the newer local edit from Transfer.
                if (this.localVersions.get(localKey) === change.version) {
                  completedDirection = 'upload';
                  this.markPathSynchronized(relativeDisplayPath);
                }
                logger.info(`Auto-uploaded: ${relativePath}`);
              } else {
                if (this.effectiveCollisionPolicy() === 'ask') {
                  conflict = this.reportConflict(
                    relativeDisplayPath,
                    'confirmation-required',
                    `the target changed before confirmation (${outcome.reason}); choose Upload in Transfer`
                  );
                }
                logger.info(`Auto-upload skipped: ${relativePath} (${outcome.reason})`);
              }
            }
          }
        }
      } else if (directions.upload && watcherConfig.autoDelete) {
        if (this.hasTwoSidedConflict(relativeDisplayPath)) {
          conflict = this.reportConflict(
            relativeDisplayPath,
            'both-sides-dirty',
            'the local delete conflicts with an independently changed remote path; resolve it in Transfer'
          );
        } else if (!connectionManager.isConnected(this.config)) {
          logger.debug(`No active connection, observed local delete only: ${relativePath}`);
        } else {
          const connection = connectionManager.getConnection(this.config);
          if (connection) {
            const remoteEntry = await connection.stat(remotePath);
            if (remoteEntry) {
              if (this.hasTwoSidedConflict(relativeDisplayPath)) {
                conflict = this.reportConflict(
                  relativeDisplayPath,
                  'both-sides-dirty',
                  'the local delete conflicts with an independently changed remote path; resolve it in Transfer'
                );
                return;
              }
              beginRemoteWatcherWrite(this.config, remotePath);
              try {
                if (remoteEntry.type === 'directory' || remoteEntry.isSymlinkToDirectory) {
                  await connection.rmdir(remotePath, true);
                } else {
                  await connection.delete(remotePath);
                }
                completeRemoteWatcherDelete(this.config, remotePath);
                remoteMutated = true;
                if (this.localVersions.get(localKey) === change.version) {
                  this.markPathSynchronized(relativeDisplayPath);
                }
                logger.info(`Auto-deleted: ${relativePath}`);
              } catch (error) {
                clearRemoteWatcherWrite(this.config, remotePath);
                throw error;
              }
            }
          }
        }
      }
    } catch (error) {
      logger.error(`Failed to process file change for ${relativePath}`, error);
    } finally {
      await this.notifyChange({
        side: 'local',
        path: relativeDisplayPath,
        type: change.type,
        kind,
        remoteMutated,
        completedDirection,
        conflict
      });
    }
  }

  private getWatcherKey(): string {
    return `${this.config.host}:${this.config.port}-${this.config.remotePath}`;
  }

  private scheduleRemotePoll(delayMs: number): void {
    if (this.disposed) {return;}
    if (this.remotePollTimer) {clearTimeout(this.remotePollTimer);}
    this.remotePollTimer = setTimeout(() => {
      this.remotePollTimer = undefined;
      void this.pollRemote();
    }, delayMs);
  }

  private async pollRemote(): Promise<void> {
    if (this.disposed || this.remotePollRunning) {return;}
    this.remotePollRunning = true;
    const startedAt = Date.now();
    let pollSucceeded = false;
    let detectedChanges = false;
    let scannedPathCount = 0;
    let pooledConnection = false;
    let discardPooledConnection = false;
    let connection: ReturnType<typeof connectionManager.getConnection> | undefined;
    try {
      if (!connectionManager.isConnected(this.config)) {return;}
      // The primary FTP connection is also used by click-upload and dashboard
      // scans. A background recursive LIST must never queue behind, or run in
      // parallel with, a foreground transfer on that session.
      if (transferManager.getActiveCount() > 0) {
        logger.debug('Deferring remote watcher poll while a transfer is active');
        return;
      }
      if (this.config.protocol === 'sftp') {
        connection = connectionManager.getConnection(this.config);
      } else {
        connection = await connectionManager.getStrictPooledConnection(this.config);
        pooledConnection = true;
      }
      if (!connection) {return;}
      if (this.disposed) {throw new RemotePollPreemptedError('watcher-stopped');}
      const pollConnection = connection;

      const next = new Map<string, RemoteWatcherSignature>();
      const root = normalizeRemotePath(this.config.remotePath || '/');
      const ignored = [...DEFAULT_IGNORE_PATTERNS, ...(this.config.ignore || [])];
      const throwIfPreempted = (): void => {
        if (this.disposed) {throw new RemotePollPreemptedError('watcher-stopped');}
        if (transferManager.getActiveCount() > 0) {throw new RemotePollPreemptedError();}
      };
      const visit = async (remoteDirectory: string, relativeDirectory: string): Promise<void> => {
        throwIfPreempted();
        const entries = await pollConnection.list(remoteDirectory);
        for (const entry of entries) {
          const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
          if (!entry.name || entry.name === '.' || entry.name === '..' || isPathIgnored(relativePath, ignored)) {continue;}
          next.set(relativePath, remoteSignature(entry));
          scannedPathCount++;
          if (entry.type === 'directory') {
            throwIfPreempted();
            await visit(entry.path, relativePath);
          }
        }
      };
      await visit(root, '');
      pollSucceeded = true;

      if (this.remoteSnapshotReady) {
        for (const [relativePath, signature] of next) {
          if (signaturesEqual(this.remoteSnapshot.get(relativePath), signature)) {continue;}
          detectedChanges = true;
          const remotePath = normalizeRemotePath(path.join(this.config.remotePath, relativePath));
          if (isRemoteWatcherWriteSuppressed(this.config, remotePath, signature)) {continue;}
          const type = this.remoteSnapshot.has(relativePath) ? 'change' : 'create';
          this.queueRemoteChange(relativePath, type, signature);
        }

        const removed = [...this.remoteSnapshot.entries()]
          .filter(([relativePath]) => !next.has(relativePath))
          .sort(([left], [right]) => left.split('/').length - right.split('/').length);
        const removedDirectories: string[] = [];
        for (const [relativePath, previousSignature] of removed) {
          detectedChanges = true;
          if (removedDirectories.some(parent => relativePath.startsWith(`${parent}/`))) {continue;}
          const remotePath = normalizeRemotePath(path.join(this.config.remotePath, relativePath));
          const deletedSignature: RemoteWatcherSignature = { type: 'deleted' };
          if (isRemoteWatcherWriteSuppressed(this.config, remotePath, deletedSignature)) {continue;}
          const wasDirectory = previousSignature.type === 'directory';
          if (wasDirectory) {removedDirectories.push(relativePath);}
          this.queueRemoteChange(relativePath, 'delete', deletedSignature, wasDirectory);
        }
      } else {
        this.remoteSnapshotReady = true;
        logger.info(`Remote watcher baseline ready: ${next.size} paths`);
      }
      this.remoteSnapshot = next;
    } catch (error) {
      if (error instanceof RemotePollPreemptedError) {
        logger.debug(error.reason === 'watcher-stopped'
          ? 'Stopped stale remote watcher poll'
          : 'Deferring remote watcher poll after foreground transfer preemption');
        return;
      }
      discardPooledConnection = pooledConnection && isConnectionClosedError(error);
      logger.warn('Remote watcher poll failed', error);
    } finally {
      if (pooledConnection && connection) {
        if (discardPooledConnection) {
          await connectionManager.discardPooledConnection(this.config, connection);
        } else {
          connectionManager.releasePooledConnection(this.config, connection);
        }
      }
      this.remotePollRunning = false;
      this.remotePollDelayMs = this.nextRemotePollDelay(
        pollSucceeded,
        detectedChanges,
        scannedPathCount,
        Date.now() - startedAt
      );
      logger.debug(
        `Remote watcher poll ${pollSucceeded ? 'completed' : 'deferred'}: ${scannedPathCount} paths, `
        + `${Date.now() - startedAt}ms, changed=${detectedChanges}, next=${this.remotePollDelayMs}ms`
      );
      this.scheduleRemotePoll(this.remotePollDelayMs);
    }
  }

  /**
   * Remote protocols cannot push directory changes, so polling is necessary.
   * Keep the first follow-up prompt, but make a quiet large tree increasingly
   * cheap: never schedule the next recursive walk before the last one had time
   * to settle, and back off to a bounded idle interval.
   */
  private nextRemotePollDelay(
    pollSucceeded: boolean,
    detectedChanges: boolean,
    scannedPathCount: number,
    scanDurationMs: number
  ): number {
    const scanCostDelay = Math.max(
      Math.max(0, scanDurationMs) * REMOTE_POLL_SCAN_MULTIPLIER,
      Math.max(0, scannedPathCount) * REMOTE_POLL_PATH_COST_MS
    );
    const idleFloor = Math.min(
      REMOTE_POLL_IDLE_MAX_DELAY_MS,
      Math.max(REMOTE_POLL_IDLE_MIN_DELAY_MS, scanCostDelay)
    );
    if (pollSucceeded && detectedChanges) {
      // A changed tree gets one prompt follow-up, but a slow scan must never
      // immediately trigger another full walk.
      return Math.min(REMOTE_POLL_IDLE_MAX_DELAY_MS, Math.max(REMOTE_POLL_MIN_DELAY_MS, scanCostDelay));
    }
    return Math.min(
      REMOTE_POLL_IDLE_MAX_DELAY_MS,
      Math.max(idleFloor, this.remotePollDelayMs * 2)
    );
  }

  private queueRemoteChange(
    relativePath: string,
    type: ChangeType,
    signature: RemoteWatcherSignature,
    directory = signature.type === 'directory'
  ): void {
    this.remotelyDirtyPaths.add(relativePath);
    const existing = this.remoteChangeTimers.get(relativePath);
    if (existing) {clearTimeout(existing);}
    if (type === 'delete' && directory) {
      for (const [pendingPath, timer] of this.remoteChangeTimers) {
        if (pendingPath.startsWith(`${relativePath}/`)) {
          clearTimeout(timer);
          this.remoteChangeTimers.delete(pendingPath);
          this.pendingRemoteChanges.delete(pendingPath);
          this.remoteVersions.delete(pendingPath);
        }
      }
    }
    const version = (this.remoteVersions.get(relativePath) || 0) + 1;
    this.remoteVersions.set(relativePath, version);
    this.pendingRemoteChanges.set(relativePath, {
      type,
      signature,
      directory,
      version,
      quietUntil: Date.now() + REMOTE_CHANGE_QUIET_MS
    });
    this.scheduleRemoteFlush(relativePath, REMOTE_CHANGE_QUIET_MS);
  }

  private scheduleRemoteFlush(relativePath: string, delayMs: number): void {
    const existing = this.remoteChangeTimers.get(relativePath);
    if (existing) {clearTimeout(existing);}
    const timer = setTimeout(() => {
      this.remoteChangeTimers.delete(relativePath);
      void this.flushRemoteChange(relativePath);
    }, Math.max(0, delayMs));
    this.remoteChangeTimers.set(relativePath, timer);
  }

  private async flushRemoteChange(relativePath: string): Promise<void> {
    if (this.disposed || this.remoteProcessing.has(relativePath)) {return;}
    const pending = this.pendingRemoteChanges.get(relativePath);
    if (!pending) {return;}
    const quietRemaining = pending.quietUntil - Date.now();
    if (quietRemaining > 0) {
      this.scheduleRemoteFlush(relativePath, quietRemaining);
      return;
    }

    this.pendingRemoteChanges.delete(relativePath);
    this.remoteProcessing.add(relativePath);
    try {
      await this.processRemoteChange(relativePath, pending);
    } finally {
      this.remoteProcessing.delete(relativePath);
      const next = this.pendingRemoteChanges.get(relativePath);
      if (next && !this.disposed) {
        this.scheduleRemoteFlush(relativePath, Math.max(0, next.quietUntil - Date.now()));
      } else {
        this.remoteVersions.delete(relativePath);
      }
    }
  }

  private async processRemoteChange(relativePath: string, change: PendingRemoteChange): Promise<void> {
    const { type, signature, directory } = change;
    const remotePath = normalizeRemotePath(path.join(this.config.remotePath, relativePath));
    let completedDirection: WatchedChange['completedDirection'];
    let conflict: WatcherConflict | undefined;
    try {
      if (this.disposed) {return;}
      if (isRemoteWatcherWriteSuppressed(this.config, remotePath, signature)) {return;}
      if (type === 'delete' || signature.type === 'directory' || !this.getSyncDirections().download) {return;}
      if (!connectionManager.isConnected(this.config)) {return;}
      const connection = connectionManager.getConnection(this.config);
      if (!connection) {return;}

      const remoteEntry = await connection.stat(remotePath);
      if (!remoteEntry || remoteEntry.type === 'directory') {return;}
      const localPath = path.join(this.workspaceRoot, ...relativePath.split('/'));
      if (this.hasTwoSidedConflict(relativePath)) {
        conflict = this.reportConflict(
          relativePath,
          'both-sides-dirty',
          'both the local and remote copies changed independently; choose Upload or Download in Transfer'
        );
        return;
      }
      if (this.hasDirtyDocument(localPath)) {
        conflict = this.reportConflict(relativePath, 'local-protected', 'the local editor has unsaved changes');
        return;
      }

      let localStat: fs.Stats | undefined;
      try { localStat = await fs.promises.stat(localPath); } catch { /* Missing locally. */ }
      if (localStat) {
        if (this.canAutoDownload) {
          let allowed = false;
          try { allowed = await this.canAutoDownload(relativePath); } catch (error) {
            logger.warn(`Could not verify local dirty state for ${relativePath}`, error);
          }
          if (!allowed) {
            conflict = this.reportConflict(relativePath, 'local-protected', 'the local copy has unsynced changes');
            return;
          }
        }
        if (!localStat.isFile()) {
          conflict = this.reportConflict(relativePath, 'local-protected', 'the local path is not a file');
          return;
        }
        if (this.requiresBackgroundConfirmation('file')) {
          conflict = this.reportConflict(
            relativePath,
            'confirmation-required',
            'the configured collision policy requires confirmation; choose Download in Transfer'
          );
          return;
        }
        const remoteMtime = remoteEntry.modifyTime instanceof Date
          ? remoteEntry.modifyTime.getTime()
          : Number(remoteEntry.modifyTime || 0);
        if (!Number.isFinite(remoteMtime) || remoteMtime <= 0) {
          if (Number(remoteEntry.size || 0) === localStat.size) {return;}
          conflict = this.reportConflict(relativePath, 'local-protected', 'the server timestamp is unavailable');
          return;
        }
        if (remoteMtime <= localStat.mtimeMs + FTP_MODIFY_TIME_TOLERANCE_MS) {
          if (Number(remoteEntry.size || 0) === localStat.size
            && Math.abs(remoteMtime - localStat.mtimeMs) <= FTP_MODIFY_TIME_TOLERANCE_MS) {return;}
          conflict = this.reportConflict(relativePath, 'local-protected', 'the local copy is newer or cannot be ordered safely');
          return;
        }
      }

      await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
      if (this.hasTwoSidedConflict(relativePath)) {
        conflict = this.reportConflict(
          relativePath,
          'both-sides-dirty',
          'both the local and remote copies changed independently; choose Upload or Download in Transfer'
        );
        return;
      }
      const outcome = await transferManager.downloadFile(
        connection,
        remotePath,
        localPath,
        this.backgroundTransferConfig(),
        { size: remoteEntry.size, targetExists: !!localStat, targetType: 'file' }
      );
      if (outcome.status === 'completed') {
        if (this.remoteVersions.get(relativePath) === change.version) {
          completedDirection = 'download';
          this.markPathSynchronized(relativePath);
        }
        logger.info(`Auto-downloaded remote ${type}: ${relativePath}`);
      } else {
        if (this.effectiveCollisionPolicy() === 'ask') {
          conflict = this.reportConflict(
            relativePath,
            'confirmation-required',
            `the target changed before confirmation (${outcome.reason}); choose Download in Transfer`
          );
        }
        logger.info(`Auto-download skipped: ${relativePath} (${outcome.reason})`);
      }
    } catch (error) {
      logger.error(`Failed to process remote ${type} for ${relativePath}`, error);
    } finally {
      // UI invalidation is observational and must not depend on connection state,
      // download policy, transfer success, or conflict resolution.
      await this.notifyChange({
        side: 'remote',
        path: relativePath,
        type,
        kind: directory ? 'directory' : signature.type === 'file' ? 'file' : undefined,
        completedDirection,
        conflict
      });
    }
  }

  private hasDirtyDocument(localPath: string): boolean {
    const target = normalizeLocalKey(localPath);
    return vscode.workspace.textDocuments.some(document => document.isDirty && normalizeLocalKey(document.fileName) === target);
  }

  private effectiveCollisionPolicy(): NonNullable<FTPConfig['collisionPolicy']> {
    return this.config.collisionPolicy || 'ask';
  }

  private backgroundTransferConfig(): FTPConfig {
    const collisionPolicy = this.effectiveCollisionPolicy();
    return collisionPolicy === 'ask'
      ? { ...this.config, collisionPolicy: 'skip' }
      : this.config;
  }

  private requiresBackgroundConfirmation(targetType?: string): boolean {
    if (!targetType || this.effectiveCollisionPolicy() !== 'ask') {return false;}
    return (this.config.syncMode || 'update') !== 'update' || targetType !== 'file';
  }

  private hasTwoSidedConflict(relativePath: string): boolean {
    const directions = this.getSyncDirections();
    return directions.upload && directions.download
      && this.locallyDirtyPaths.has(relativePath)
      && this.remotelyDirtyPaths.has(relativePath);
  }

  private reportConflict(
    relativePath: string,
    kind: WatcherConflict['kind'],
    reason: string
  ): WatcherConflict {
    logger.warn(`Auto Sync conflict for ${relativePath}: ${reason}`);
    if (!this.reportedConflictPaths.has(relativePath)) {
      this.reportedConflictPaths.add(relativePath);
      void vscode.window.showWarningMessage(`Auto Sync conflict for "${relativePath}": ${reason}.`);
    }
    return { kind, reason };
  }

  private markPathSynchronized(relativePath: string): void {
    this.locallyDirtyPaths.delete(relativePath);
    this.remotelyDirtyPaths.delete(relativePath);
    this.reportedConflictPaths.delete(relativePath);
  }

  public markTransferCompleted(config: FTPConfig, localPath: string, remotePath: string): void {
    if (connectionEndpointIdentity(config) !== connectionEndpointIdentity(this.config)) {return;}
    const localRelative = path.relative(this.workspaceRoot, localPath).replace(/\\/g, '/');
    if (!localRelative || localRelative === '..' || localRelative.startsWith('../') || path.isAbsolute(localRelative)) {return;}
    const root = normalizeRemotePath(this.config.remotePath || '/');
    const target = normalizeRemotePath(remotePath);
    const remoteRelative = root === '/'
      ? target.replace(/^\//, '')
      : target.startsWith(`${root}/`) ? target.slice(root.length + 1) : '';
    if (!remoteRelative || localRelative !== remoteRelative) {return;}
    this.markPathSynchronized(localRelative);
  }

  private async notifyChange(change: WatchedChange): Promise<void> {
    if (this.disposed || !this.onChange) {return;}
    try { await this.onChange(change); } catch (error) { logger.warn(`Watcher UI refresh failed for ${change.path}`, error); }
  }

  private clearDebounceTimers(): void {
    for (const timer of this.debounceTimers.values()) {clearTimeout(timer);}
    this.debounceTimers.clear();
    this.pendingChanges.clear();
    this.localVersions.clear();
  }

  dispose(): void {
    this.stop();
  }
}

export class FileWatcherManager {
  private static instance: FileWatcherManager;
  private readonly watchers = new Map<string, FileWatcher>();

  static getInstance(): FileWatcherManager {
    if (!FileWatcherManager.instance) {FileWatcherManager.instance = new FileWatcherManager();}
    return FileWatcherManager.instance;
  }

  private keyForWorkspace(workspaceRoot: string): string {
    return normalizeLocalKey(workspaceRoot);
  }

  startWatcher(
    workspaceRoot: string,
    localRoot: string,
    config: FTPConfig,
    onChange?: WatchedChangeListener,
    canAutoDownload?: AutoDownloadGuard
  ): void {
    const key = this.keyForWorkspace(workspaceRoot);
    const replacement = new FileWatcher(localRoot, config, onChange, canAutoDownload);
    const existing = this.watchers.get(key);
    existing?.dispose();
    this.watchers.delete(key);
    try {
      replacement.start();
      this.watchers.set(key, replacement);
    } catch (error) {
      replacement.dispose();
      throw error;
    }
  }

  stopWatcher(workspaceRoot: string): void {
    const key = this.keyForWorkspace(workspaceRoot);
    const existing = this.watchers.get(key);
    if (!existing) {return;}
    existing.dispose();
    this.watchers.delete(key);
  }

  stopAll(): void {
    for (const watcher of this.watchers.values()) {watcher.dispose();}
    this.watchers.clear();
  }

  isWatching(workspaceRoot: string): boolean {
    return this.watchers.has(this.keyForWorkspace(workspaceRoot));
  }

  markTransferCompleted(config: FTPConfig, localPath: string, remotePath: string): void {
    for (const watcher of this.watchers.values()) {
      watcher.markTransferCompleted(config, localPath, remotePath);
    }
  }
}

export const fileWatcherManager = FileWatcherManager.getInstance();

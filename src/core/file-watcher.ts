/**
 * ITFFTP - File Watcher
 * 
 * Monitors local files for changes and automatically syncs with remote
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { FTPConfig } from '../types';
import { connectionManager } from './connection-manager';
import { transferManager } from './transfer-manager';
import { logger } from '../utils/logger';
import { DEFAULT_IGNORE_PATTERNS, normalizeRemotePath, isPathIgnored } from '../utils/helpers';
import { isWatcherWriteSuppressed } from './watcher-suppression';

export interface WatchedChange {
  side: 'local' | 'remote';
  path: string;
  type: 'create' | 'change' | 'delete';
}

type WatchedChangeListener = (change: WatchedChange) => void | Promise<void>;

const REMOTE_POLL_DELAY_MS = 1000;
const REMOTE_CHANGE_QUIET_MS = 1000;

export class FileWatcher implements vscode.Disposable {
  private watchers: Map<string, vscode.FileSystemWatcher> = new Map();
  private workspaceRoot: string;
  private config: FTPConfig;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private pendingChanges: Map<string, 'create' | 'change' | 'delete'> = new Map();
  private remoteChangeTimers: Map<string, NodeJS.Timeout> = new Map();
  private remoteSnapshot = new Map<string, string>();
  private expectedRemoteWrites = new Map<string, string>();
  private remotePollTimer?: NodeJS.Timeout;
  private remotePollRunning = false;
  private remoteSnapshotReady = false;
  private disposed = false;
  private readonly onChange?: WatchedChangeListener;

  constructor(workspaceRoot: string, config: FTPConfig, onChange?: WatchedChangeListener) {
    this.workspaceRoot = workspaceRoot;
    this.config = config;
    this.onChange = onChange;
  }

  /**
   * Start watching files based on watcher configuration
   */
  start(): void {
    this.disposed = false;
    if (this.config.watcher || this.config.uploadOnSave) {
      const watcherConfig = this.config.watcher;
      const pattern = typeof watcherConfig === 'object' && watcherConfig.files ? watcherConfig.files : '**/*';
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(this.workspaceRoot, pattern), false, false, false
      );
      watcher.onDidCreate(uri => this.handleFileChange(uri.fsPath, 'create'));
      watcher.onDidChange(uri => this.handleFileChange(uri.fsPath, 'change'));
      watcher.onDidDelete(uri => this.handleFileChange(uri.fsPath, 'delete'));
      this.watchers.set(this.getWatcherKey(), watcher);
      logger.info(`Local file watcher started for pattern: ${pattern}`);
    }
    this.scheduleRemotePoll(REMOTE_POLL_DELAY_MS);
    logger.info(`Remote file watcher started with ${REMOTE_POLL_DELAY_MS}ms polling`);
  }

  /**
   * Stop watching files
   */
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
    this.remoteSnapshot.clear();
    this.expectedRemoteWrites.clear();
    this.remoteSnapshotReady = false;
  }

  /**
   * Restart the watcher with updated configuration
   */
  restart(): void {
    this.stop();
    this.start();
  }

  private handleFileChange(filePath: string, type: 'create' | 'change' | 'delete'): void {
    const relativePath = path.relative(this.workspaceRoot, filePath);

    // Check ignore patterns
    if (isPathIgnored(relativePath, [...DEFAULT_IGNORE_PATTERNS, ...(this.config.ignore || [])])) {
      return;
    }

    logger.debug(`File ${type}: ${relativePath}`);

    // Debounce rapid changes
    const existingTimer = this.debounceTimers.get(filePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Track the latest change type
    this.pendingChanges.set(filePath, type);

    // Debounce and process
    const timer = setTimeout(() => {
      this.processChange(filePath);
      this.debounceTimers.delete(filePath);
    }, 1000); // Wait for one full second without another edit.

    this.debounceTimers.set(filePath, timer);
  }

  private async processChange(filePath: string): Promise<void> {
    const changeType = this.pendingChanges.get(filePath);
    this.pendingChanges.delete(filePath);

    if (!changeType) {return;}

    const relativePath = path.relative(this.workspaceRoot, filePath);
    const remotePath = normalizeRemotePath(path.join(this.config.remotePath, relativePath));

    // Normalize watcher config (handle boolean case)
    const watcherConfig = typeof this.config.watcher === 'boolean'
      ? { files: '**/*', autoUpload: true, autoDelete: false }
      : this.config.watcher;

    try {
      switch (changeType) {
        case 'create':
        case 'change': {
          // Check if autoUpload is enabled BEFORE establishing connection
          if (watcherConfig?.autoUpload === false) {
            logger.debug(`Auto-upload disabled, skipping: ${relativePath}`);
            return;
          }

          // Check if this file was recently uploaded via uploadOnSave
          // to prevent duplicate uploads
          if (isWatcherWriteSuppressed(filePath)) {
            logger.debug(`Skipping ITFFTP-generated local write: ${relativePath}`);
            return;
          }

          let stat: fs.Stats;
          try {
            stat = await fs.promises.stat(filePath);
          } catch {
            return;
          }

          // Only upload if there's an active connection - don't auto-connect
          if (!connectionManager.isConnected(this.config)) {
            logger.debug(`No active connection, skipping auto-upload: ${relativePath}`);
            return;
          }

          const uploadConnection = connectionManager.getConnection(this.config);
          if (!uploadConnection) {
            return;
          }
          if (stat.isDirectory()) {
            await uploadConnection.mkdir(remotePath);
          } else {
            // Ensure parent directory exists
            const remoteDir = normalizeRemotePath(path.dirname(remotePath));
            try {
              await uploadConnection.mkdir(remoteDir);
            } catch {
              // Directory might already exist
            }
            const normalizedRelativePath = relativePath.replace(/\\/g, '/');
            this.expectedRemoteWrites.set(normalizedRelativePath, `file:${stat.size}`);
            const pendingRemoteTimer = this.remoteChangeTimers.get(normalizedRelativePath);
            if (pendingRemoteTimer) {clearTimeout(pendingRemoteTimer);}
            this.remoteChangeTimers.delete(normalizedRelativePath);
            try {
              await transferManager.uploadFile(uploadConnection, filePath, remotePath, {
                ...this.config,
                syncMode: 'full',
                collisionPolicy: 'overwrite'
              });
            } catch (error) {
              this.expectedRemoteWrites.delete(normalizedRelativePath);
              throw error;
            }
            logger.info(`Auto-uploaded: ${relativePath}`);
          }
          await this.notifyChange({ side: 'local', path: relativePath.replace(/\\/g, '/'), type: changeType });
          break;
        }

        case 'delete': {
          if (watcherConfig?.autoDelete !== false) {
            // Only delete if there's an active connection
            if (!connectionManager.isConnected(this.config)) {
              logger.debug(`No active connection, skipping auto-delete: ${relativePath}`);
              return;
            }

            const deleteConnection = connectionManager.getConnection(this.config);
            if (!deleteConnection) {
              return;
            }
            try {
              const remoteEntry = await deleteConnection.stat(remotePath);
              if (!remoteEntry) {
                logger.debug(`Remote path already missing, skipping auto-delete: ${relativePath}`);
                return;
              }

              if (remoteEntry.type === 'directory' || remoteEntry.isSymlinkToDirectory) {
                await deleteConnection.rmdir(remotePath, true);
                logger.info(`Auto-deleted directory: ${relativePath}`);
              } else {
                await deleteConnection.delete(remotePath);
                logger.info(`Auto-deleted: ${relativePath}`);
              }
              await this.notifyChange({ side: 'local', path: relativePath.replace(/\\/g, '/'), type: 'delete' });
            } catch (error) {
              logger.warn(`Failed to auto-delete ${relativePath}`, error);
            }
          }
          break;
        }
      }
    } catch (error: any) {
      logger.error(`Failed to process file change for ${relativePath}`, error);
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
    try {
      if (!connectionManager.isConnected(this.config)) {return;}
      const connection = connectionManager.getConnection(this.config);
      if (!connection) {return;}
      const next = new Map<string, string>();
      const root = normalizeRemotePath(this.config.remotePath || '/');
      const ignored = [...DEFAULT_IGNORE_PATTERNS, ...(this.config.ignore || [])];
      const visit = async (remoteDirectory: string, relativeDirectory: string): Promise<void> => {
        const entries = await connection.list(remoteDirectory);
        for (const entry of entries) {
          const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
          if (!entry.name || entry.name === '.' || entry.name === '..' || isPathIgnored(relativePath, ignored)) {continue;}
          const modified = entry.modifyTime instanceof Date ? entry.modifyTime.getTime() : Number(entry.modifyTime || 0);
          next.set(relativePath, `${entry.type}:${Number(entry.size || 0)}:${modified}`);
          if (entry.type === 'directory') {await visit(entry.path, relativePath);}
        }
      };
      await visit(root, '');
      if (this.remoteSnapshotReady) {
        for (const [relativePath, signature] of next) {
          if (signature === this.remoteSnapshot.get(relativePath)) {continue;}
          const expectedWrite = this.expectedRemoteWrites.get(relativePath);
          if (expectedWrite) {
            this.expectedRemoteWrites.delete(relativePath);
            if (signature.startsWith(`${expectedWrite}:`)) {continue;}
          }
          const type = this.remoteSnapshot.has(relativePath) ? 'change' : 'create';
          this.queueRemoteChange(relativePath, type, signature.startsWith('directory:'));
        }
        for (const relativePath of this.remoteSnapshot.keys()) {
          if (!next.has(relativePath)) {this.queueRemoteChange(relativePath, 'delete', false);}
        }
      } else {
        this.remoteSnapshotReady = true;
        logger.info(`Remote watcher baseline ready: ${next.size} paths`);
      }
      this.remoteSnapshot = next;
    } catch (error) {
      logger.warn('Remote watcher poll failed', error);
    } finally {
      this.remotePollRunning = false;
      this.scheduleRemotePoll(REMOTE_POLL_DELAY_MS);
    }
  }

  private queueRemoteChange(relativePath: string, type: 'create' | 'change' | 'delete', directory: boolean): void {
    const existing = this.remoteChangeTimers.get(relativePath);
    if (existing) {clearTimeout(existing);}
    const timer = setTimeout(() => {
      this.remoteChangeTimers.delete(relativePath);
      void this.processRemoteChange(relativePath, type, directory);
    }, REMOTE_CHANGE_QUIET_MS);
    this.remoteChangeTimers.set(relativePath, timer);
  }

  private async processRemoteChange(relativePath: string, type: 'create' | 'change' | 'delete', directory: boolean): Promise<void> {
    try {
      if (!connectionManager.isConnected(this.config)) {return;}
      const connection = connectionManager.getConnection(this.config);
      if (!connection) {return;}
      if (type !== 'delete' && !directory && this.config.downloadOnOpen) {
        const localPath = path.join(this.workspaceRoot, ...relativePath.split('/'));
        const remotePath = normalizeRemotePath(path.join(this.config.remotePath, relativePath));
        const remoteEntry = await connection.stat(remotePath);
        if (remoteEntry && remoteEntry.type !== 'directory') {
          let targetExists = false;
          try { targetExists = (await fs.promises.stat(localPath)).isFile(); } catch { /* Missing locally. */ }
          await transferManager.downloadFile(connection, remotePath, localPath, {
            ...this.config,
            syncMode: 'full',
            collisionPolicy: 'overwrite'
          }, { size: remoteEntry.size, targetExists, targetType: 'file' });
          logger.info(`Auto-downloaded remote ${type}: ${relativePath}`);
        }
      }
      await this.notifyChange({ side: 'remote', path: relativePath, type });
    } catch (error) {
      logger.error(`Failed to process remote ${type} for ${relativePath}`, error);
    }
  }

  private async notifyChange(change: WatchedChange): Promise<void> {
    if (!this.onChange) {return;}
    try { await this.onChange(change); } catch (error) { logger.warn(`Watcher UI refresh failed for ${change.path}`, error); }
  }

  private clearDebounceTimers(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.pendingChanges.clear();
  }

  dispose(): void {
    this.stop();
  }
}

export class FileWatcherManager {
  private static instance: FileWatcherManager;
  private watchers: Map<string, FileWatcher> = new Map();

  static getInstance(): FileWatcherManager {
    if (!FileWatcherManager.instance) {
      FileWatcherManager.instance = new FileWatcherManager();
    }
    return FileWatcherManager.instance;
  }

  startWatcher(workspaceRoot: string, config: FTPConfig, onChange?: WatchedChangeListener): void {
    const key = `${workspaceRoot}-${config.host}`;

    // Stop existing watcher if any
    this.stopWatcher(key);

    const watcher = new FileWatcher(workspaceRoot, config, onChange);
    watcher.start();
    this.watchers.set(key, watcher);
  }

  stopWatcher(key: string): void {
    const existing = this.watchers.get(key);
    if (existing) {
      existing.dispose();
      this.watchers.delete(key);
    }
  }

  stopAll(): void {
    for (const watcher of this.watchers.values()) {
      watcher.dispose();
    }
    this.watchers.clear();
  }

  isWatching(key: string): boolean {
    return this.watchers.has(key);
  }
}

export const fileWatcherManager = FileWatcherManager.getInstance();

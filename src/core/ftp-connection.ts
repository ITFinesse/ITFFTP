/**
 * ITFFTP - FTP/FTPS Connection Implementation
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { Client } from 'basic-ftp';
import {
  BaseConnection,
  assertTransferredFile,
  atomicDownloadToLocalFile,
  modificationTimesMatch,
  TransferSerializationOptions,
  uniqueRemoteSiblingPath,
  withSerializedLocalWrite,
  withSerializedRemoteWrite
} from './connection';
import { FileEntry, FTPConfig } from '../types';
import { logger } from '../utils/logger';
import { isRemoteMissingError } from './connection-errors';
import { errorCode, normalizeRemotePath } from '../utils/helpers';
import { isConnectionClosedError } from './connection-errors';

function isFtpMissingPathError(error: unknown): boolean {
  return /\b(?:550|553)\b.*(?:no such file|not found|does not exist|cannot find|can't find)/i
    .test(String((error as Error)?.message || error));
}

function isFtpTimestampUnsupported(error: unknown): boolean {
  return /\b(?:500|501|502|504)\b|not implemented|not supported|unknown command/i
    .test(String((error as Error)?.message || error));
}

export class FTPConnection extends BaseConnection {
  private client: Client;
  private keepaliveTimer: NodeJS.Timeout | undefined;

  protected handleOperationError(error: unknown): void {
    if (!isConnectionClosedError(error)) { return; }
    if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); }
    this.keepaliveTimer = undefined;
    if (this._connected) {
      this._connected = false;
      this.emit('disconnected');
    }
  }

  constructor(config: FTPConfig) {
    super(config);
    // Match the configured connection timeout instead of basic-ftp's
    // 30-second default, which can make startup auto-connect feel hung.
    this.client = new Client(config.connTimeout ?? 30000);
    this.client.ftp.verbose = false;
  }

  async connect(): Promise<void> {
    try {
      const secure = this.config.secure === 'implicit'
        ? 'implicit'
        : this.config.secure === true || this.config.secure === 'control';

      await this.client.access({
        host: this.config.host,
        port: this.config.port || 21,
        user: this.config.username,
        password: this.config.password || '',
        secure,
        secureOptions: this.config.secureOptions
      });

      // basic-ftp uses passive mode by default
      // No explicit configuration needed

      this._connected = true;
      this._currentPath = await this.client.pwd();
      this.startKeepalive();

      logger.info(`FTP${secure ? 'S' : ''} connected to ${this.config.host}:${this.config.port || 21}`);
      this.emit('connected');
    } catch (error) {
      logger.error('FTP connection error', error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.keepaliveTimer) {clearInterval(this.keepaliveTimer);}
    this.keepaliveTimer = undefined;
    this.client.close();
    this._connected = false;
    this.emit('disconnected');
    await super.disconnect();
  }

  private startKeepalive(): void {
    const interval = this.config.keepalive ?? 300000;
    if (interval <= 0) {return;}
    this.keepaliveTimer = setInterval(() => {
      if (!this.connected) {return;}
      void this.enqueue(async () => {
        try { await this.client.send('NOOP'); }
        catch (error) { logger.debug(`FTP keepalive failed for ${this.config.host}`, error); }
      });
    }, interval);
    this.keepaliveTimer.unref?.();
  }

  async list(remotePath: string): Promise<FileEntry[]> {
    return this.enqueue(async () => {
      try {
        // Many FTP servers handle CWD + bare LIST reliably but reject LIST
        // with a path because the server first performs an unsupported
        // existence probe. This mirrors established FTP-client behaviour.
        const originalDir = await this.client.pwd();
        let list;
        try {
          await this.client.cd(normalizeRemotePath(remotePath));
          list = await this.client.list();
        } finally {
          await this.client.cd(originalDir);
        }

        const entries: FileEntry[] = [];

        for (const item of list) {
          try {
            // Skip invalid entries
            if (!item.name || item.name === '.' || item.name === '..') {
              continue;
            }

            const user = item.permissions?.user;
            const group = item.permissions?.group;
            const other = item.permissions?.world;
            const type = this.mapFileType(item.type);
            let isSymlinkToDirectory: boolean | undefined = undefined;

            // For symlinks in FTP, try to determine if it's a directory
            // Note: symlink check is done inline to avoid extra queue operations
            if (type === 'symlink') {
              const currentDir = await this.client.pwd();
              try {
                const symlinkPath = normalizeRemotePath(path.join(remotePath, item.name));
                await this.client.cd(symlinkPath);
                await this.client.list();
                isSymlinkToDirectory = true;
              } catch {
                isSymlinkToDirectory = false;
              } finally {
                await this.client.cd(currentDir);
              }
            }

            entries.push({
              name: item.name,
              type,
              size: item.size || 0,
              // A missing FTP timestamp is unknown, not the current time.
              // Consumers can then fall back to size comparison safely.
              modifyTime: item.modifiedAt || new Date(0),
              rights: {
                user: user !== undefined ? String(user) : '',
                group: group !== undefined ? String(group) : '',
                other: other !== undefined ? String(other) : ''
              },
              path: normalizeRemotePath(path.join(remotePath, item.name)),
              target: item.link || undefined,
              isSymlinkToDirectory
            });
          } catch (itemErr) {
            logger.warn(`Skipping problematic FTP entry: ${item.name}`, itemErr);
          }
        }

        return entries;
      } catch (error) {
        const message = String((error as Error)?.message || error);
        if (/\b550\b/i.test(message)) {logger.debug(`FTP path is not listable: ${remotePath}`, { message });}
        else if (!isConnectionClosedError(error)) {logger.error('FTP list error', error);}
        throw error;
      }
    });
  }

  private mapFileType(type: unknown): FileEntry['type'] {
    // basic-ftp uses numeric types: 0 = unknown, 1 = file, 2 = directory, 3 = symlink
    if (typeof type === 'number') {
      switch (type) {
        case 2:
          return 'directory';
        case 3:
          return 'symlink';
        default:
          return 'file';
      }
    }

    switch (type) {
      case 'd':
      case 'directory':
        return 'directory';
      case 'l':
      case 'symlink':
        return 'symlink';
      default:
        return 'file';
    }
  }

  async download(remotePath: string, localPath: string, serialization?: TransferSerializationOptions): Promise<void> {
    const operation = () => this.enqueue(() => this._download(remotePath, localPath));
    return serialization?.writeLockHeld
      ? operation()
      : withSerializedLocalWrite(localPath, operation);
  }

  private async _download(remotePath: string, localPath: string): Promise<void> {
    try {
      this.emit('transferStart', { direction: 'download', remotePath, localPath });
      this.client.trackProgress(info => this.emitProgress(remotePath, info.bytes, 0));

      const source = await this._stat(remotePath);
      assertTransferredFile(source, source?.size ?? -1, `Remote download source ${remotePath}`);
      await atomicDownloadToLocalFile(localPath, source.size, source.modifyTime, async stagingPath => {
        await this.client.downloadTo(stagingPath, remotePath);
      });

      this.emit('transferComplete', { direction: 'download', remotePath, localPath });
    } catch (error) {
      logger.error('FTP download error', error);
      throw error;
    } finally {
      this.client.trackProgress();
    }
  }

  private async ensureRemoteDir(remotePath: string): Promise<void> {
    const normalizedPath = normalizeRemotePath(remotePath);
    if (!normalizedPath || normalizedPath === '/' || normalizedPath === '.') {
      return;
    }

    const originalDir = await this.client.pwd();
    try {
      try {
        await this.client.ensureDir(normalizedPath);
      } catch (error) {
        // Some FTP servers reject basic-ftp's existence probe even when the
        // directory already exists. Let the transfer itself determine whether
        // the parent is usable instead of failing a valid upload preflight.
        if (!/550\s+can'?t check for file existence/i.test(String((error as Error)?.message || error))) {throw error;}
        logger.debug(`FTP server cannot probe directory existence for ${normalizedPath}; continuing upload`);
      }
    } finally {
      await this.client.cd(originalDir);
    }
  }

  async upload(localPath: string, remotePath: string, serialization?: TransferSerializationOptions): Promise<void> {
    const operation = () => this.enqueue(() => this._upload(localPath, remotePath));
    return serialization?.writeLockHeld
      ? operation()
      : withSerializedRemoteWrite(this.config, remotePath, operation);
  }

  private async _upload(localPath: string, remotePath: string): Promise<void> {
    const stagingPath = uniqueRemoteSiblingPath(remotePath, 'upload');
    const backupPath = uniqueRemoteSiblingPath(remotePath, 'backup');
    let promoted = false;
    let backupCreated = false;
    let verified = false;
    try {
      this.emit('transferStart', { direction: 'upload', localPath, remotePath });
      this.client.trackProgress(info => this.emitProgress(localPath, info.bytes, 0));
      const source = await fs.promises.stat(localPath);
      if (!source.isFile()) {throw new Error(`Cannot upload non-file source: ${localPath}`);}
      const startedAt = Date.now();
      logger.info(`FTP upload started: ${remotePath}`);
      try {
        await this.client.uploadFrom(localPath, stagingPath);
      } catch (error) {
        if (!isRemoteMissingError(error)) {throw error;}
        const parentDir = path.dirname(remotePath);
        if (!parentDir || parentDir === '.' || parentDir === '/') {throw error;}
        logger.info(`FTP upload parent is missing; creating ${parentDir} and retrying once`);
        await this.ensureRemoteDir(parentDir);
        await this.client.uploadFrom(localPath, stagingPath);
      }

      const staged = await this._stat(stagingPath);
      assertTransferredFile(staged, source.size, `Remote upload staging file ${stagingPath}`);
      const targetBefore = await this._stat(remotePath);
      try {
        await this.client.rename(stagingPath, remotePath);
        promoted = true;
      } catch (directRenameError) {
        if (!targetBefore) {throw directRenameError;}
        await this.client.rename(remotePath, backupPath);
        backupCreated = true;
        try {
          await this.client.rename(stagingPath, remotePath);
          promoted = true;
        } catch (promotionError) {
          try {
            await this.client.rename(backupPath, remotePath);
            backupCreated = false;
          } catch (rollbackError) {
            throw Object.assign(
              new Error(`FTP upload promotion and rollback failed for ${remotePath}; previous data remains at ${backupPath}`),
              { promotionError, rollbackError }
            );
          }
          throw promotionError;
        }
      }

      assertTransferredFile(await this._stat(remotePath), source.size, `Remote upload target ${remotePath}`);
      verified = true;
      logger.info(`FTP upload data complete: ${remotePath}; ${Date.now() - startedAt}ms`);
      this.emit('transferComplete', { direction: 'upload', localPath, remotePath });
    } catch (error) {
      if (backupCreated && promoted && !verified) {
        try {
          await this.client.rename(remotePath, stagingPath);
          promoted = false;
          await this.client.rename(backupPath, remotePath);
          backupCreated = false;
        } catch (rollbackError) {
          throw Object.assign(
            new Error(`FTP upload verification and rollback failed for ${remotePath}; previous data remains at ${backupPath}`),
            { uploadError: error, rollbackError }
          );
        }
      }
      logger.error('FTP upload error', error);
      throw error;
    } finally {
      this.client.trackProgress();
      if (!promoted) {
        try {await this.client.remove(stagingPath);}
        catch (cleanupError) {
          if (!isFtpMissingPathError(cleanupError)) {logger.warn(`Failed to clean FTP upload staging file ${stagingPath}`, cleanupError);}
        }
      }
      if (backupCreated && verified) {
        try {await this.client.remove(backupPath);}
        catch (cleanupError) {logger.warn(`Failed to clean FTP upload backup ${backupPath}`, cleanupError);}
      }
    }
  }

  async setModifyTime(remotePath: string, modifyTime: Date): Promise<boolean> {
    return this.enqueue(async () => {
      const stamp = modifyTime.toISOString().replace(/[-:T]/g, '').replace(/\.\d{3}Z$/, '');
      try {
        // MFMT is supported by common FTP servers and uses UTC YYYYMMDDHHMMSS.
        await this.client.send(`MFMT ${stamp} ${remotePath}`);
        try {
          const observed = await this.client.lastMod(remotePath);
          if (!modificationTimesMatch(observed, modifyTime)) {
            throw new Error(`FTP timestamp verification failed for ${remotePath}`);
          }
        } catch (error) {
          if (isFtpTimestampUnsupported(error)) {
            logger.debug(`FTP server cannot read back timestamps for ${remotePath}`, error);
            return false;
          }
          throw error;
        }
        return true;
      } catch (error) {
        if (isFtpTimestampUnsupported(error)) {
          logger.debug(`FTP server does not support preserving timestamps for ${remotePath}`, error);
          return false;
        }
        throw error;
      }
    });
  }

  async delete(remotePath: string): Promise<void> {
    return this.enqueue(async () => {
      try {
        await this.client.remove(remotePath);
      } catch (error) {
        if (isRemoteMissingError(error)) {
          logger.info(`FTP delete skipped because the remote file is already missing: ${remotePath}`);
          return;
        }
        logger.error('FTP delete error', error);
        throw error;
      }
    });
  }

  async mkdir(remotePath: string): Promise<void> {
    return this.enqueue(async () => {
      try {
        await this.ensureRemoteDir(remotePath);
      } catch (error) {
        logger.error('FTP mkdir error', error);
        throw error;
      }
    });
  }

  async rmdir(remotePath: string, recursive = false): Promise<void> {
    return this.enqueue(async () => {
      try {
        // Safety checks - prevent deletion of critical paths
        const normalizedPath = normalizeRemotePath(remotePath);
        const dangerousPaths = ['/', '/home', '/root', '/var', '/etc', '/usr', '/bin', '/sbin', '/lib', '/opt', '/tmp'];

        if (dangerousPaths.includes(normalizedPath) || normalizedPath === '') {
          throw new Error(`Cannot delete critical system path: ${remotePath}`);
        }

        if (recursive) {
          await this.client.removeDir(remotePath);
        } else {
          await this.client.send(`RMD ${remotePath}`);
        }
      } catch (error) {
        logger.error('FTP rmdir error', error);
        throw error;
      }
    });
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    return this.enqueue(async () => {
      try {
        const parentDir = path.dirname(newPath);
        if (parentDir && parentDir !== '.' && parentDir !== '/') {
          await this.ensureRemoteDir(parentDir);
        }
        await this.client.rename(oldPath, newPath);
      } catch (error) {
        logger.error('FTP rename error', error);
        throw error;
      }
    });
  }

  async exists(remotePath: string): Promise<boolean> {
    return this.enqueue(async () => (await this._stat(remotePath)) !== null);
  }

  async stat(remotePath: string): Promise<FileEntry | null> {
    return this.enqueue(() => this._stat(remotePath));
  }

  private async _stat(remotePath: string): Promise<FileEntry | null> {
    let sizeError: unknown;
    try {
      const size = await this.client.size(remotePath);
      const fileName = path.basename(remotePath);
      let modifyTime = new Date(0);
      try {
        modifyTime = await this.client.lastMod(remotePath);
      } catch (error) {
        if (isConnectionClosedError(error)) {throw error;}
        logger.debug(`FTP modification time is unavailable for ${remotePath}`, error);
      }

      return {
        name: fileName,
        type: 'file',
        size,
        modifyTime,
        rights: { user: '', group: '', other: '' },
        path: remotePath
      };
    } catch (error) {
      if (isConnectionClosedError(error)) {throw error;}
      sizeError = error;
    }

    const originalDir = await this.client.pwd();
    let directoryError: unknown;
    try {
      await this.client.cd(remotePath);
      return {
        name: path.basename(remotePath),
        type: 'directory',
        size: 0,
        modifyTime: new Date(0),
        rights: { user: '', group: '', other: '' },
        path: remotePath
      };
    } catch (error) {
      if (isConnectionClosedError(error)) {throw error;}
      directoryError = error;
    } finally {
      await this.client.cd(originalDir);
    }

    // A successful parent listing is authoritative even on servers that do
    // not implement SIZE. It also preserves an available LIST timestamp.
    const parentDir = path.posix.dirname(remotePath.replace(/\\/g, '/'));
    const basename = path.posix.basename(remotePath.replace(/\\/g, '/'));
    try {
      await this.client.cd(parentDir || '.');
      const listed = (await this.client.list()).find(item => item.name === basename);
      if (!listed) {return null;}
      return {
        name: listed.name,
        type: this.mapFileType(listed.type),
        size: listed.size || 0,
        modifyTime: listed.modifiedAt || new Date(0),
        rights: { user: '', group: '', other: '' },
        path: remotePath
      };
    } catch (listingError) {
      if (isConnectionClosedError(listingError)) {throw listingError;}
      if (isFtpMissingPathError(sizeError) && isFtpMissingPathError(directoryError) && isFtpMissingPathError(listingError)) {
        return null;
      }
      throw sizeError || directoryError || listingError;
    } finally {
      await this.client.cd(originalDir);
    }
  }

  async chmod(remotePath: string, mode: number | string): Promise<void> {
    return this.enqueue(async () => {
      try {
        const modeStr = typeof mode === 'number' ? mode.toString(8) : mode;
        await this.client.send(`SITE CHMOD ${modeStr} ${remotePath}`);
      } catch (error) {
        logger.error('FTP chmod error', error);
        throw error;
      }
    });
  }

  async readFile(remotePath: string): Promise<Buffer> {
    return this.enqueue(async () => {
      const uniqueId = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      const tempPath = path.join(os.tmpdir(), `stackerftp-${uniqueId}.tmp`);
      try {
        await this.client.downloadTo(tempPath, remotePath);
        return await fs.promises.readFile(tempPath);
      } finally {
        // Her durumda temizle
        try {
          await fs.promises.unlink(tempPath);
        } catch (cleanupError) {
          if (errorCode(cleanupError) !== 'ENOENT') {logger.warn('Failed to cleanup temp file', cleanupError);}
        }
      }
    });
  }

  async writeFile(remotePath: string, content: Buffer | string): Promise<void> {
    return this.enqueue(async () => {
      const uniqueId = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      const tempPath = path.join(os.tmpdir(), `stackerftp-${uniqueId}.tmp`);
      try {
        // Ensure parent directory exists
        const parentDir = path.dirname(remotePath);
        if (parentDir && parentDir !== '.' && parentDir !== '/') {
          await this.ensureRemoteDir(parentDir);
        }

        const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8');
        await fs.promises.writeFile(tempPath, buffer);
        await this.client.uploadFrom(tempPath, remotePath);
      } finally {
        // Her durumda temizle
        try {
          await fs.promises.unlink(tempPath);
        } catch (cleanupError) {
          if (errorCode(cleanupError) !== 'ENOENT') {logger.warn('Failed to cleanup temp file', cleanupError);}
        }
      }
    });
  }

  async exec(_command: string): Promise<{ stdout: string; stderr: string; code: number }> {
    // FTP doesn't support remote command execution like SSH.
    throw new Error('Remote command execution is not supported in FTP. Use SFTP instead.');
  }
}

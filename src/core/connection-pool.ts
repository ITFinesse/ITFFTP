/**
 * ITFFTP - Connection Pool
 *
 * Manages a pool of connections per server for parallel transfers.
 * Primary connection (used by explorer/stat) remains separate.
 */

import { BaseConnection } from './connection';
import { SFTPConnection } from './sftp-connection';
import { FTPConnection } from './ftp-connection';
import { FTPConfig } from '../types';
import { logger } from '../utils/logger';

interface PoolEntry {
  connection: BaseConnection;
  inUse: boolean;
  lastUsed: number;
}

interface ServerPool {
  entries: PoolEntry[];
  config: FTPConfig;
  connecting: number;
}

const IDLE_TIMEOUT_MS = 60_000;
const MAX_POOL_SIZE = 100;
const CONNECT_TIMEOUT_MS = 15_000;

export class ConnectionPool {
  private pools: Map<string, ServerPool> = new Map();
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly debugThrottleMs = 2000;
  private readonly debugState = new Map<string, { lastEmittedAt: number; suppressed: number }>();

  constructor() {
    this.startIdleCleanup();
  }

  private getKey(config: FTPConfig): string {
    const port = config.port || (config.protocol === 'sftp' ? 22 : 21);
    return `${config.name || config.host}:${port}-${config.username}`;
  }

  private createConnection(config: FTPConfig): BaseConnection {
    switch (config.protocol) {
      case 'sftp':
        return new SFTPConnection(config);
      case 'ftp':
      case 'ftps':
        return new FTPConnection(config);
      default:
        throw new Error(`Unsupported protocol: ${config.protocol}`);
    }
  }

  private logPoolDebug(message: string, host: string, eventKey: string, trackSuppressed = true): void {
    const key = `${host}:${eventKey}`;
    const now = Date.now();
    const existing = this.debugState.get(key);
    if (!existing || now - existing.lastEmittedAt >= this.debugThrottleMs) {
      const suffix = existing && existing.suppressed > 0 ? ` (${existing.suppressed} suppressed)` : '';
      logger.debug(`${message}${suffix}`);
      this.debugState.set(key, { lastEmittedAt: now, suppressed: 0 });
      return;
    }

    if (trackSuppressed) {
      existing.suppressed += 1;
      this.debugState.set(key, existing);
    } else {
      logger.debug(message);
      this.debugState.set(key, { lastEmittedAt: now, suppressed: 0 });
    }
  }

  /**
   * Acquire a pooled connection for transfers.
   * Returns an existing idle connection or creates a new one up to poolSize.
   */
  async acquire(config: FTPConfig, poolSize?: number): Promise<BaseConnection> {
    const key = this.getKey(config);
    const maxSize = Math.min(poolSize || MAX_POOL_SIZE, MAX_POOL_SIZE);

    let pool = this.pools.get(key);
    if (!pool) {
      pool = { entries: [], config, connecting: 0 };
      this.pools.set(key, pool);
    }

    // Try to find an idle connection
    for (const entry of pool.entries) {
      if (!entry.inUse && entry.connection.connected) {
        entry.inUse = true;
        entry.lastUsed = Date.now();
        this.logPoolDebug(`Pool: reusing connection for ${config.host} (${pool.entries.length} in pool)`, config.host, 'reusing');
        return entry.connection;
      }
    }

    // Remove disconnected entries
    pool.entries = pool.entries.filter(e => e.connection.connected || e.inUse);

    // Create new connection if under limit (include in-flight connects to prevent race condition)
    if (pool.entries.length + pool.connecting < maxSize) {
      pool.connecting++;
      const connection = this.createConnection(config);
      try {
        let timeout: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            connection.connect(),
            new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`Pool connection timed out after ${CONNECT_TIMEOUT_MS / 1000} seconds`)), CONNECT_TIMEOUT_MS); })
          ]);
        } finally {
          if (timeout) {clearTimeout(timeout);}
        }
        const entry: PoolEntry = {
          connection,
          inUse: true,
          lastUsed: Date.now()
        };
        pool.entries.push(entry);
        this.logPoolDebug(`Pool: new connection for ${config.host} (${pool.entries.length}/${maxSize})`, config.host, 'new');
        return connection;
      } catch (error) {
        try { await connection.disconnect(); } catch { /* Best-effort cleanup after a failed pooled login. */ }
        logger.error(`Pool: failed to create connection for ${config.host}`, error);
        throw error;
      } finally {
        pool.connecting--;
      }
    }

    // All connections busy - wait for one to become available
    this.logPoolDebug(`Pool: all ${maxSize} connections busy for ${config.host}, waiting...`, config.host, 'wait');
    return this.waitForAvailable(pool, config);
  }

  /**
   * Release a connection back to the pool.
   */
  release(config: FTPConfig, connection: BaseConnection): void {
    const key = this.getKey(config);
    const pool = this.pools.get(key);
    if (!pool) {return;}

    for (let i = 0; i < pool.entries.length; i++) {
      const entry = pool.entries[i];
      if (entry.connection === connection) {
        if (!connection.connected) {
          // Dead connection - remove from pool immediately
          pool.entries.splice(i, 1);
          this.logPoolDebug(`Pool: removed dead connection for ${config.host}`, config.host, 'removed');
        } else {
          entry.inUse = false;
          entry.lastUsed = Date.now();
          this.logPoolDebug(`Pool: released connection for ${config.host}`, config.host, 'released');
        }
        return;
      }
    }
  }

  /**
   * Drain all pooled connections for a server (used on disconnect).
   */
  async drain(config: FTPConfig): Promise<void> {
    const key = this.getKey(config);
    const pool = this.pools.get(key);
    if (!pool) {return;}

    const disconnectPromises = pool.entries.map(async (entry) => {
      try {
        if (entry.connection.connected) {
          await entry.connection.disconnect();
        }
      } catch (error) {
        this.logPoolDebug(`Pool: error draining connection for ${config.host}`, config.host, 'drain-error', false);
      }
    });

    await Promise.all(disconnectPromises);
    this.pools.delete(key);
    this.logPoolDebug(`Pool: drained all connections for ${config.host}`, config.host, 'drained', false);
  }

  /**
   * Drain all pools (used on full disconnect).
   */
  async drainAll(): Promise<void> {
    const drainPromises: Promise<void>[] = [];
    for (const [, pool] of this.pools) {
      drainPromises.push(this.drain(pool.config));
    }
    await Promise.all(drainPromises);
  }

  private waitForAvailable(pool: ServerPool, config: FTPConfig): Promise<BaseConnection> {
    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        for (const entry of pool.entries) {
          if (!entry.inUse && entry.connection.connected) {
            clearInterval(checkInterval);
            clearTimeout(timeoutId);
            entry.inUse = true;
            entry.lastUsed = Date.now();
            resolve(entry.connection);
            return;
          }
        }
      }, 50);

      // Timeout after 30s
      const timeoutId = setTimeout(() => {
        clearInterval(checkInterval);
        reject(new Error(`Pool: timeout waiting for available connection to ${config.host}`));
      }, 30_000);
    });
  }

  private startIdleCleanup(): void {
    this.idleTimer = setInterval(() => {
      const now = Date.now();
      for (const [, pool] of this.pools) {
        // Keep at least one idle connection, close the rest if idle too long
        const idleEntries = pool.entries.filter(e => !e.inUse && e.connection.connected);
        if (idleEntries.length <= 1) {continue;}

        for (let i = 1; i < idleEntries.length; i++) {
          const entry = idleEntries[i];
          if (now - entry.lastUsed > IDLE_TIMEOUT_MS) {
            entry.connection.disconnect().catch(() => {});
            const idx = pool.entries.indexOf(entry);
            if (idx !== -1) {pool.entries.splice(idx, 1);}
            this.logPoolDebug(`Pool: closed idle connection for ${pool.config.host}`, pool.config.host, 'idle');
          }
        }
      }
    }, 30_000);
  }

  dispose(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    this.drainAll().catch(() => {});
  }
}

export const connectionPool = new ConnectionPool();

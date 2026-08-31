/**
 * ITFFTP - Connection Manager
 */

import * as vscode from 'vscode';
import { BaseConnection } from './connection';
import { SFTPConnection } from './sftp-connection';
import { FTPConnection } from './ftp-connection';
import { FTPConfig, ConnectionStatus } from '../types';
import { logger } from '../utils/logger';
import { errorMessage } from '../utils/helpers';
import { statusBar } from '../utils/status-bar';
import { connectionPool } from './connection-pool';
import { connectionEndpointIdentity } from './connection-identity';

export type ConnectionLifecycleState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ConnectionLifecycle {
  state: ConnectionLifecycleState;
  error?: string;
}

class ConnectionAttemptSupersededError extends Error {
  constructor() {
    super('Connection attempt was superseded by a newer lifecycle action');
    this.name = 'ConnectionAttemptSupersededError';
  }
}

export class ConnectionManager {
  private static instance: ConnectionManager;
  private connections: Map<string, BaseConnection> = new Map();
  private statusBarItem: vscode.StatusBarItem;
  private activeConnectionKey: string | undefined;
  private primaryConnectionKey: string | undefined;
  private manualDisconnects: Set<string> = new Set();
  private reconnectTimers: Map<string, NodeJS.Timeout> = new Map();
  private reconnectAttempts: Map<string, number> = new Map();
  private ongoingConnections: Map<string, Promise<BaseConnection>> = new Map();
  private recoveryConnections: Map<string, Promise<BaseConnection>> = new Map();
  private retiredConnections: WeakSet<BaseConnection> = new WeakSet();
  private connectionGenerations: Map<string, number> = new Map();
  private connectionStates: Map<string, ConnectionLifecycle> = new Map();

  private _onConnectionChanged: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
  public readonly onConnectionChanged: vscode.Event<void> = this._onConnectionChanged.event;

  private constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBarItem.command = 'stackerftp.selectPrimaryConnection';
    this.updateStatusBar();
  }

  static getInstance(): ConnectionManager {
    if (!ConnectionManager.instance) {
      ConnectionManager.instance = new ConnectionManager();
    }
    return ConnectionManager.instance;
  }

  private getConnectionKey(config: FTPConfig): string {
    return connectionEndpointIdentity(config);
  }

  private getConnectionGeneration(key: string): number {
    return this.connectionGenerations.get(key) || 0;
  }

  private invalidateConnectionGeneration(key: string): number {
    const generation = this.getConnectionGeneration(key) + 1;
    this.connectionGenerations.set(key, generation);
    return generation;
  }

  private isConnectionGenerationCurrent(key: string, generation: number): boolean {
    return this.getConnectionGeneration(key) === generation;
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

  getActiveConnection(): BaseConnection | undefined {
    if (!this.activeConnectionKey) {return undefined;}
    const conn = this.connections.get(this.activeConnectionKey);
    return conn?.connected ? conn : undefined;
  }

  getActiveConfig(): FTPConfig | undefined {
    const conn = this.getActiveConnection();
    return conn?.getConfig();
  }

  // Primary connection - used for file explorer uploads
  getPrimaryConnection(): BaseConnection | undefined {
    if (this.primaryConnectionKey) {
      const conn = this.connections.get(this.primaryConnectionKey);
      if (conn?.connected) {return conn;}
    }
    // Fallback to first active connection
    const activeConns = this.getAllActiveConnections();
    return activeConns.length > 0 ? activeConns[0].connection : undefined;
  }

  getPrimaryConfig(): FTPConfig | undefined {
    const conn = this.getPrimaryConnection();
    return conn?.getConfig();
  }

  setPrimaryConnection(config: FTPConfig): void {
    const key = this.getConnectionKey(config);
    const conn = this.connections.get(key);
    if (conn?.connected) {
      this.primaryConnectionKey = key;
      this.updateStatusBar();
      statusBar.success(`Primary: ${config.name || config.host}`);
    }
  }

  getAllActiveConnections(): Array<{ connection: BaseConnection; config: FTPConfig }> {
    const result: Array<{ connection: BaseConnection; config: FTPConfig }> = [];
    for (const conn of this.connections.values()) {
      if (conn.connected) {
        result.push({ connection: conn, config: conn.getConfig() });
      }
    }
    return result;
  }

  private updateStatusBar(): void {
    const activeConns = this.getAllActiveConnections();

    if (activeConns.length === 0) {
      this.statusBarItem.text = `$(cloud) ITFFTP`;
      this.statusBarItem.tooltip = 'Click to select connection';
      this.statusBarItem.show();
      return;
    }

    if (activeConns.length === 1) {
      const config = activeConns[0].config;
      const name = config.name || config.host;
      this.statusBarItem.text = `$(cloud-upload) ${name}`;
      this.statusBarItem.tooltip = `Connected to ${name}\nClick to manage connections`;
      this.statusBarItem.show();
      return;
    }

    // Multiple connections
    const primaryConn = this.getPrimaryConnection();
    const primaryConfig = primaryConn?.getConfig();
    const primaryName = primaryConfig?.name || primaryConfig?.host || 'None';

    this.statusBarItem.text = `$(cloud-upload) ${primaryName} (+${activeConns.length - 1})`;
    this.statusBarItem.tooltip = `Primary: ${primaryName}\n${activeConns.length} connections active\nClick to change primary`;
    this.statusBarItem.show();
  }

  // Select target connection for upload/download when multiple are active
  async selectConnectionForTransfer(operation: 'upload' | 'download'): Promise<{ connection: BaseConnection; config: FTPConfig } | undefined> {
    const activeConns = this.getAllActiveConnections();

    if (activeConns.length === 0) {
      statusBar.warn('No active connections. Please connect first.');
      return undefined;
    }

    if (activeConns.length === 1) {
      return activeConns[0];
    }

    // Multiple connections - ask user
    const items = activeConns.map(({ connection, config }) => ({
      label: config.name || config.host,
      description: `${config.protocol?.toUpperCase()} • ${config.username}@${config.host}`,
      config,
      connection
    }));

    // Add "Primary" indicator
    const primaryConfig = this.getPrimaryConfig();
    if (primaryConfig) {
      const primaryKey = this.getConnectionKey(primaryConfig);
      const primaryItem = items.find(i => this.getConnectionKey(i.config) === primaryKey);
      if (primaryItem) {
        primaryItem.label = `$(star-full) ${primaryItem.label} (Primary)`;
      }
    }

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: `Select connection for ${operation}`,
      title: `${operation === 'upload' ? 'Upload' : 'Download'} - Select Target`
    });

    if (!selected) {return undefined;}
    return { connection: selected.connection, config: selected.config };
  }

  async connect(config: FTPConfig): Promise<BaseConnection> {
    const key = this.getConnectionKey(config);
    const recovery = this.recoveryConnections.get(key);
    if (recovery) {
      return recovery;
    }

    let generation = this.getConnectionGeneration(key);
    if (this.manualDisconnects.has(key)) {
      generation = this.invalidateConnectionGeneration(key);
      this.manualDisconnects.delete(key);
    }
    return this.connectNewOrExisting(config, generation);
  }

  private async connectNewOrExisting(config: FTPConfig, generation: number): Promise<BaseConnection> {
    const key = this.getConnectionKey(config);
    const displayName = config.name || config.host;
    if (!this.isConnectionGenerationCurrent(key, generation)) {
      throw new ConnectionAttemptSupersededError();
    }

    // Check if already connected
    const existing = this.connections.get(key);
    if (existing && existing.connected) {
      logger.info(`Already connected to ${config.host}`);
      statusBar.info(`Already connected: ${displayName}`);
      return existing;
    }
    if (existing) {
      // A replacement owns this key from this point on. Ignore any delayed
      // transport events emitted by the retired wrapper.
      this.retiredConnections.add(existing);
      this.connections.delete(key);
    }

    // Check if there is an ongoing connection attempt for this key
    const ongoing = this.ongoingConnections.get(key);
    if (ongoing) {
      return ongoing;
    }

    // Defer the attempt body until its promise is registered. Lifecycle event
    // listeners can synchronously request disconnect/reconnect.
    const attempt = Promise.resolve().then(async () => {
      if (!this.isConnectionGenerationCurrent(key, generation)) {
        throw new ConnectionAttemptSupersededError();
      }

      this.setLifecycle(key, { state: 'connecting' });
      logger.info(`Connecting to ${displayName} (${config.protocol.toUpperCase()})`);

      // If no password and no private key, prompt for password
      const workingConfig = { ...config };
      if (!workingConfig.password && !workingConfig.privateKeyPath) {
        const password = await vscode.window.showInputBox({
          prompt: `Enter password for ${workingConfig.username}@${workingConfig.host}`,
          password: true,
          ignoreFocusOut: true
        });

        if (password === undefined) {
          this.setLifecycle(key, { state: 'disconnected' });
          throw new Error('Connection cancelled - no password provided');
        }

        workingConfig.password = password;
      }

      if (!this.isConnectionGenerationCurrent(key, generation)) {
        throw new ConnectionAttemptSupersededError();
      }

      const progress = statusBar.startProgress(`connect:${key}`, `Connecting to ${displayName}...`);
      let connection: BaseConnection | undefined;
      try {
        connection = this.createConnection(workingConfig);
        const candidate = connection;

        // Set up event handlers
        let hasConnected = false;
        candidate.on('connected', () => {
          if (this.retiredConnections.has(candidate) || !this.isConnectionGenerationCurrent(key, generation)) {return;}
          hasConnected = true;
        });

        candidate.on('disconnected', () => {
          if (this.retiredConnections.has(candidate) || !this.isConnectionGenerationCurrent(key, generation)) {return;}
          logger.info(`Disconnected from ${config.host}`);
          this.setLifecycle(key, { state: 'disconnected' });
          statusBar.info(`Disconnected: ${displayName}`);
          // Auto-reconnect if enabled and not a manual disconnect
          if (hasConnected && !this.manualDisconnects.has(key)) {
            this.scheduleReconnect(config, key, generation);
          } else {
            this.manualDisconnects.delete(key);
          }
          // Clear primary if this was it
          if (this.primaryConnectionKey === key) {
            this.primaryConnectionKey = undefined;
          }
          this.updateStatusBar();
          this._onConnectionChanged.fire();
        });

        candidate.on('error', (error) => {
          if (this.retiredConnections.has(candidate) || !this.isConnectionGenerationCurrent(key, generation)) {return;}
          logger.error(`Connection error on ${config.host}`, error);
          this.setLifecycle(key, { state: 'error', error: error.message });
          statusBar.error(`Error: ${error.message}`, true);
        });

        await this.connectWithTimeout(candidate, workingConfig);
        if (!this.isConnectionGenerationCurrent(key, generation)) {
          this.retiredConnections.add(candidate);
          await candidate.disconnect().catch(() => {});
          throw new ConnectionAttemptSupersededError();
        }

        hasConnected = true;
        this.connections.set(key, candidate);
        this.activeConnectionKey = key;
        if (!this.primaryConnectionKey) {this.primaryConnectionKey = key;}
        this.manualDisconnects.delete(key);
        this.clearReconnectState(key);
        logger.info(`Connected to ${displayName}`);
        this.setLifecycle(key, { state: 'connected' });
        if (!this.isConnectionGenerationCurrent(key, generation)) {
          this.retiredConnections.add(candidate);
          if (this.connections.get(key) === candidate) {
            this.connections.delete(key);
            await candidate.disconnect().catch(() => {});
          }
          throw new ConnectionAttemptSupersededError();
        }
        progress.complete(`Connected: ${displayName}`);
        this.updateStatusBar();
        this._onConnectionChanged.fire();
        return candidate;
      } catch (error) {
        if (!this.isConnectionGenerationCurrent(key, generation) || error instanceof ConnectionAttemptSupersededError) {
          if (connection) {this.retiredConnections.add(connection);}
          throw new ConnectionAttemptSupersededError();
        }
        const message = errorMessage(error);
        this.setLifecycle(key, { state: 'error', error: message });
        logger.error(`Connection failed for ${displayName}`, error);
        progress.fail(`Connection failed: ${displayName}`);
        throw error;
      }
    });

    const connectionPromise = attempt.finally(() => {
      if (this.ongoingConnections.get(key) === connectionPromise) {
        this.ongoingConnections.delete(key);
      }
    });
    this.ongoingConnections.set(key, connectionPromise);
    return connectionPromise;
  }

  /**
   * Retire a manager-owned connection whose transport has been classified as
   * closed, then establish a fresh primary session for the same config.
   *
   * This is deliberately different from a manual disconnect: pooled transfer
   * sessions remain available and automatic lifecycle state is preserved.
   */
  async invalidateAndReconnect(config: FTPConfig, failedConnection: BaseConnection): Promise<BaseConnection> {
    const key = this.getConnectionKey(config);
    const existingRecovery = this.recoveryConnections.get(key);
    if (existingRecovery) {
      return existingRecovery;
    }

    const generation = this.getConnectionGeneration(key);
    const recoveryAttempt = Promise.resolve().then(async () => {
      try {
        if (!this.isConnectionGenerationCurrent(key, generation)) {
          throw new ConnectionAttemptSupersededError();
        }
        const current = this.connections.get(key);
        if (current === failedConnection) {
          const displayName = config.name || config.host;
          this.retiredConnections.add(failedConnection);
          this.connections.delete(key);
          this.clearReconnectState(key);

          if (this.activeConnectionKey === key) {
            this.activeConnectionKey = undefined;
          }
          if (this.primaryConnectionKey === key) {
            this.primaryConnectionKey = undefined;
          }

          this.setLifecycle(key, { state: 'disconnected' });
          statusBar.info(`Disconnected: ${displayName}`);
          this.updateStatusBar();
          this._onConnectionChanged.fire();

          await failedConnection.disconnect().catch(disconnectError => {
            logger.warn(`Failed to close invalidated connection to ${config.host}`, disconnectError);
          });
        }

        if (!this.isConnectionGenerationCurrent(key, generation)) {
          throw new ConnectionAttemptSupersededError();
        }
        return await this.connectNewOrExisting(config, generation);
      } catch (error) {
        if (this.isConnectionGenerationCurrent(key, generation)
          && !this.manualDisconnects.has(key)
          && !(error instanceof ConnectionAttemptSupersededError)) {
          this.scheduleReconnect(config, key, generation);
        }
        throw error;
      }
    });

    const recovery = recoveryAttempt.finally(() => {
      if (this.recoveryConnections.get(key) === recovery) {
        this.recoveryConnections.delete(key);
      }
    });
    this.recoveryConnections.set(key, recovery);
    return recovery;
  }

  /**
   * Validate credentials and the configured remote path without registering a
   * primary connection or disturbing an existing manager/pool session.
   */
  async testConnection(config: FTPConfig): Promise<void> {
    const workingConfig = { ...config };
    if (!workingConfig.password && !workingConfig.privateKeyPath) {
      const password = await vscode.window.showInputBox({
        prompt: `Enter password for ${workingConfig.username}@${workingConfig.host}`,
        password: true,
        ignoreFocusOut: true
      });

      if (password === undefined) {
        throw new Error('Connection cancelled - no password provided');
      }
      workingConfig.password = password;
    }

    const connection = this.createConnection(workingConfig);

    connection.on('error', error => {
      logger.error(`Transient connection test failed for ${workingConfig.host}`, error);
    });

    try {
      await this.connectWithTimeout(connection, workingConfig);
      await connection.list(workingConfig.remotePath || '/');
    } finally {
      await connection.disconnect().catch(disconnectError => {
        logger.warn(`Failed to close transient connection to ${workingConfig.host}`, disconnectError);
      });
    }
  }

  async disconnect(config?: FTPConfig): Promise<void> {
    if (config) {
      const key = this.getConnectionKey(config);
      const connection = this.connections.get(key);
      const disconnectGeneration = this.invalidateConnectionGeneration(key);
      this.manualDisconnects.add(key);
      this.clearReconnectState(key);
      this.ongoingConnections.delete(key);
      this.recoveryConnections.delete(key);
      if (connection) {
        this.retiredConnections.add(connection);
        this.connections.delete(key);
        if (this.activeConnectionKey === key) {this.activeConnectionKey = undefined;}
        if (this.primaryConnectionKey === key) {this.primaryConnectionKey = undefined;}
      }
      try {
        await connectionPool.drain(config);
        if (connection) {await connection.disconnect();}
      } finally {
        if (this.isConnectionGenerationCurrent(key, disconnectGeneration)) {
          this.manualDisconnects.delete(key);
          if (!this.connections.get(key)?.connected) {
            this.setLifecycle(key, { state: 'disconnected' });
          }
        }
      }
    } else {
      // Disconnect all
      const connections = [...this.connections.entries()];
      const keys = new Set([
        ...this.connections.keys(),
        ...this.ongoingConnections.keys(),
        ...this.recoveryConnections.keys(),
        ...this.reconnectTimers.keys(),
        ...this.connectionStates.keys()
      ]);
      const disconnectGenerations = new Map<string, number>();
      for (const key of keys) {
        disconnectGenerations.set(key, this.invalidateConnectionGeneration(key));
        this.manualDisconnects.add(key);
        this.clearReconnectState(key);
        this.ongoingConnections.delete(key);
        this.recoveryConnections.delete(key);
      }
      for (const [, connection] of connections) {this.retiredConnections.add(connection);}
      this.connections.clear();
      this.activeConnectionKey = undefined;
      this.primaryConnectionKey = undefined;
      try {
        await connectionPool.drainAll();
        await Promise.all(connections.map(([, connection]) => connection.disconnect()));
      } finally {
        for (const [key, generation] of disconnectGenerations) {
          if (!this.isConnectionGenerationCurrent(key, generation)) {continue;}
          this.manualDisconnects.delete(key);
          if (!this.connections.get(key)?.connected) {this.connectionStates.delete(key);}
        }
      }
    }
    this.updateStatusBar();
    this._onConnectionChanged.fire();
  }

  getConnection(config: FTPConfig): BaseConnection | undefined {
    const key = this.getConnectionKey(config);
    return this.connections.get(key);
  }

  isConnected(config: FTPConfig): boolean {
    const key = this.getConnectionKey(config);
    const connection = this.connections.get(key);
    return connection ? connection.connected : false;
  }

  getActiveConnections(): BaseConnection[] {
    return Array.from(this.connections.values()).filter(c => c.connected);
  }

  getStatus(config: FTPConfig): ConnectionStatus {
    const connection = this.getConnection(config);
    if (connection) {
      return connection.getStatus();
    }
    return { connected: false };
  }

  getLifecycle(config: FTPConfig): ConnectionLifecycle {
    const key = this.getConnectionKey(config);
    if (this.isConnected(config)) {return { state: 'connected' };}
    return this.connectionStates.get(key) || { state: 'disconnected' };
  }

  private setLifecycle(key: string, lifecycle: ConnectionLifecycle): void {
    this.connectionStates.set(key, lifecycle);
    this._onConnectionChanged.fire();
  }

  private async connectWithTimeout(connection: BaseConnection, config: FTPConfig): Promise<void> {
    const timeoutMs = Math.max(1000, config.connTimeout ?? 10000) + 2000;
    let timeout: NodeJS.Timeout | undefined;

    try {
      await Promise.race([
        connection.connect(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            reject(new Error(`Connection timed out after ${timeoutMs / 1000} seconds`));
          }, timeoutMs);
        })
      ]);
    } catch (error) {
      await connection.disconnect().catch(disconnectError => {
        logger.warn(`Failed to close timed-out connection to ${config.host}`, disconnectError);
      });
      throw error;
    } finally {
      if (timeout) {clearTimeout(timeout);}
    }
  }

  async ensureConnection(config: FTPConfig): Promise<BaseConnection> {
    const connection = this.getConnection(config);
    if (connection && connection.connected) {
      return connection;
    }
    return this.connect(config);
  }

  private scheduleReconnect(config: FTPConfig, key: string, generation = this.getConnectionGeneration(key)): void {
    if (config.autoReconnect === false
      || this.manualDisconnects.has(key)
      || !this.isConnectionGenerationCurrent(key, generation)) {return;}

    // Avoid auto reconnect if no credentials are available
    if (!config.password && !config.privateKeyPath) {
      logger.warn(`Auto-reconnect skipped for ${config.host}: no stored credentials`);
      return;
    }

    if (this.reconnectTimers.has(key)) {return;}

    const attempt = (this.reconnectAttempts.get(key) || 0) + 1;
    this.reconnectAttempts.set(key, attempt);

    const delay = Math.min(30000, 2000 * attempt);
    logger.info(`Scheduling reconnect to ${config.host} in ${delay}ms (attempt ${attempt})`);

    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(key);
      if (this.manualDisconnects.has(key) || !this.isConnectionGenerationCurrent(key, generation)) {return;}
      try {
        const existing = this.getConnection(config);
        if (existing && existing.connected) {
          this.clearReconnectState(key);
          return;
        }
        await this.connect(config);
      } catch (error) {
        logger.warn(`Reconnect attempt ${attempt} failed for ${config.host}`, error);
        this.scheduleReconnect(config, key, generation);
      }
    }, delay);

    this.reconnectTimers.set(key, timer);
  }

  private clearReconnectState(key: string): void {
    const timer = this.reconnectTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(key);
    }
    this.reconnectAttempts.delete(key);
  }

  /** Acquire a connection for an additional parallel transfer worker. */
  async getPooledConnection(config: FTPConfig): Promise<BaseConnection> {
    // Ensure primary connection exists first
    const primary = this.getConnection(config);
    if (!primary || !primary.connected) {
      throw new Error(`No active connection for ${config.host}`);
    }

    const primaryConfig = primary.getConfig();

    // SFTP is more stable with a single authenticated session.
    // Pooled SFTP sessions can stall when runtime credentials are prompt-based.
    if (primaryConfig.protocol === 'sftp') {
      return primary;
    }

    return this.getStrictPooledConnection(config);
  }

  /** Acquire a distinct pooled FTP session without reusing the primary. */
  async getStrictPooledConnection(config: FTPConfig): Promise<BaseConnection> {
    const primary = this.getConnection(config);
    if (!primary || !primary.connected) {
      throw new Error(`No active connection for ${config.host}`);
    }

    const primaryConfig = primary.getConfig();
    if (primaryConfig.protocol === 'sftp') {
      throw new Error('SFTP comparison scans must use the serial primary connection');
    }

    const configuredConcurrency = vscode.workspace.getConfiguration('stackerftp').get<number>('transferConcurrency', 4);
    const poolSize = Math.min(100, Math.max(1, Math.round(configuredConcurrency)));
    const pooled = await connectionPool.acquire(primaryConfig, poolSize);
    if (this.getConnection(config) !== primary || !primary.connected) {
      await connectionPool.discard(primaryConfig, pooled);
      throw new ConnectionAttemptSupersededError();
    }
    return pooled;
  }

  /**
   * Release a pooled connection back to the pool.
   */
  releasePooledConnection(config: FTPConfig, connection: BaseConnection): void {
    const primary = this.getConnection(config);
    if (primary && primary === connection) {
      // Primary connection is not owned by pool.
      return;
    }
    connectionPool.release(config, connection);
  }

  /** Close and remove one failed pooled transport without draining siblings. */
  async discardPooledConnection(config: FTPConfig, connection: BaseConnection): Promise<void> {
    const primary = this.getConnection(config);
    if (primary === connection) {
      throw new Error('Cannot discard the manager-owned primary as a pooled connection');
    }
    await connectionPool.discard(config, connection);
  }

  dispose(): void {
    connectionPool.dispose();
    this.disconnect().catch(err => logger.error('Error disconnecting', err));
    this.statusBarItem.dispose();
  }
}

export const connectionManager = ConnectionManager.getInstance();

/**
 * ITFFTP - Connection Hopping (Jump Host) Support
 *  
 * Enables connections through intermediate SSH servers (hop/bastion hosts)
 * local -> hop -> target
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { Client, ConnectConfig } from 'ssh2';
import { FTPConfig, HopConfig } from '../types';
import { logger } from '../utils/logger';
import { errorMessage } from '../utils/helpers';

export class ConnectionHopping {

  /**
   * Create a connection through a hop (jump host)
   */
  async connectThroughHop(targetConfig: FTPConfig): Promise<Client> {
    if (!targetConfig.hop) {
      throw new Error('No hop configuration provided');
    }

    const hops = Array.isArray(targetConfig.hop) ? targetConfig.hop : [targetConfig.hop];
    if (hops.length === 0) {
      throw new Error('No hop configuration provided');
    }

    logger.info(`Connecting through ${hops.length} hop(s)`);

    const clients: Client[] = [];
    try {
      // Start with first hop (direct connection)
      let currentClient = await this.createSSHConnection(hops[0]);
      clients.push(currentClient);

      // Chain through additional hops
      for (let i = 1; i < hops.length; i++) {
        const hop = hops[i];
        logger.info(`Connecting to hop ${i + 1}: ${hop.host}`);

        // Forward connection through current client to next hop
        currentClient = await this.forwardThroughClient(currentClient, hop);
        clients.push(currentClient);
      }

      // Finally connect to target through last hop
      const targetHop = this.toHopConfig(targetConfig);
      logger.info(`Connecting to target through hops: ${targetConfig.host}`);
      currentClient = await this.forwardThroughClient(currentClient, targetHop);
      clients.push(currentClient);

      this.closeUpstreamWithTerminal(currentClient, clients.slice(0, -1));
      return currentClient;
    } catch (error) {
      this.closeClients(clients);
      throw error;
    }
  }

  private closeUpstreamWithTerminal(terminal: Client, upstream: Client[]): void {
    let closed = false;
    const closeUpstream = (): void => {
      if (closed) {return;}
      closed = true;
      this.closeClients(upstream);
    };
    terminal.once('error', closeUpstream);
    terminal.once('close', closeUpstream);
  }

  private closeClients(clients: Client[]): void {
    for (const client of [...clients].reverse()) {
      try {
        client.end();
      } catch (error) {
        logger.warn('Failed to close SSH hop client', error);
      }
    }
  }

  private createSSHConnection(config: HopConfig): Promise<Client> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      let settled = false;

      const connectConfig: ConnectConfig = {
        host: config.host,
        port: config.port || 22,
        username: config.username,
        readyTimeout: 20000
      };

      if (config.privateKeyPath) {
        try {
          connectConfig.privateKey = fs.readFileSync(config.privateKeyPath);
          if (config.passphrase) {
            connectConfig.passphrase = config.passphrase;
          }
        } catch (error) {
          reject(new Error(`Failed to load private key: ${errorMessage(error)}`));
          return;
        }
      } else if (config.password) {
        connectConfig.password = config.password;
      }

      client.on('ready', () => {
        settled = true;
        resolve(client);
      });

      client.on('error', (err) => {
        if (settled) {return;}
        settled = true;
        try {client.end();} catch { /* Best-effort cleanup for a failed login. */ }
        reject(err);
      });

      try {
        client.connect(connectConfig);
      } catch (error) {
        if (!settled) {
          settled = true;
          try {client.end();} catch { /* Best-effort cleanup for a failed login. */ }
          reject(error);
        }
      }
    });
  }

  private forwardThroughClient(client: Client, target: HopConfig): Promise<Client> {
    return new Promise((resolve, reject) => {
      // Create a socket forward to the target through the current client
      client.forwardOut('127.0.0.1', 0, target.host, target.port || 22, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        // Create new client connection through the forwarded stream
        const newClient = new Client();
        let settled = false;

        const fail = (error: unknown): void => {
          if (settled) {return;}
          settled = true;
          stream.destroy();
          try {newClient.end();} catch { /* Best-effort cleanup for a failed forward. */ }
          reject(error);
        };

        const connectConfig: ConnectConfig = {
          sock: stream,
          username: target.username,
          readyTimeout: 20000
        };

        if (target.privateKeyPath) {
          try {
            connectConfig.privateKey = fs.readFileSync(target.privateKeyPath);
            if (target.passphrase) {
              connectConfig.passphrase = target.passphrase;
            }
          } catch (error) {
            fail(new Error(`Failed to load private key for hop: ${errorMessage(error)}`));
            return;
          }
        } else if (target.password) {
          connectConfig.password = target.password;
        }

        newClient.on('ready', () => {
          settled = true;
          resolve(newClient);
        });

        newClient.on('error', (err) => {
          fail(err);
        });

        try {
          newClient.connect(connectConfig);
        } catch (error) {
          fail(error);
        }
      });
    });
  }

  private toHopConfig(config: FTPConfig): HopConfig {
    return {
      host: config.host,
      port: config.port || 22,
      username: config.username,
      password: config.password,
      privateKeyPath: config.privateKeyPath,
      passphrase: config.passphrase
    };
  }

  /**
   * Setup connection hopping configuration through UI
   */
  static async configureHopping(): Promise<FTPConfig['hop'] | undefined> {
    const hops: HopConfig[] = [];
    let addMore = true;

    while (addMore) {
      const hopConfig = await this.configureSingleHop(hops.length + 1);
      if (!hopConfig) {
        break;
      }

      hops.push(hopConfig);

      const choice = await vscode.window.showQuickPick(
        ['Add another hop', 'Done'],
        { placeHolder: 'Would you like to add another hop?' }
      );

      addMore = choice === 'Add another hop';
    }

    if (hops.length === 0) {
      return undefined;
    }

    return hops.length === 1 ? hops[0] : hops;
  }

  private static async configureSingleHop(hopNumber: number): Promise<HopConfig | undefined> {
    // Host
    const host = await vscode.window.showInputBox({
      title: `Hop ${hopNumber} - Host`,
      placeHolder: 'hop-server.example.com',
      prompt: 'Enter the hop server hostname or IP',
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value?.trim()) {return 'Host is required';}
        return null;
      }
    });

    if (!host) {return undefined;}

    // Port
    const portStr = await vscode.window.showInputBox({
      title: `Hop ${hopNumber} - Port`,
      value: '22',
      prompt: 'Enter the SSH port',
      ignoreFocusOut: true,
      validateInput: (value) => {
        const port = parseInt(value || '22');
        if (isNaN(port) || port < 1 || port > 65535) {
          return 'Please enter a valid port (1-65535)';
        }
        return null;
      }
    });

    if (portStr === undefined) {return undefined;}

    // Username
    const username = await vscode.window.showInputBox({
      title: `Hop ${hopNumber} - Username`,
      placeHolder: 'username',
      prompt: 'Enter the username for the hop server',
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value?.trim()) {return 'Username is required';}
        return null;
      }
    });

    if (!username) {return undefined;}

    // Authentication method
    const authMethod = await vscode.window.showQuickPick(
      [
        { label: 'Password', value: 'password' },
        { label: 'Private Key', value: 'key' }
      ],
      {
        title: `Hop ${hopNumber} - Authentication`,
        placeHolder: 'Select authentication method'
      }
    );

    if (!authMethod) {return undefined;}

    let password: string | undefined;
    let privateKeyPath: string | undefined;
    let passphrase: string | undefined;

    if (authMethod.value === 'password') {
      password = await vscode.window.showInputBox({
        title: `Hop ${hopNumber} - Password`,
        prompt: 'Enter the password (optional)',
        password: true,
        ignoreFocusOut: true
      });
    } else {
      const keyFiles = await vscode.window.showOpenDialog({
        title: `Hop ${hopNumber} - Select Private Key`,
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: {
          'Key Files': ['pem', 'key', 'ppk'],
          'All Files': ['*']
        }
      });

      if (!keyFiles || keyFiles.length === 0) {return undefined;}
      privateKeyPath = keyFiles[0].fsPath;

      const hasPassphrase = await vscode.window.showQuickPick(
        ['Yes', 'No'],
        {
          title: 'Does your key have a passphrase?',
          placeHolder: 'Select Yes if your private key is encrypted'
        }
      );

      if (hasPassphrase === 'Yes') {
        passphrase = await vscode.window.showInputBox({
          title: 'Passphrase',
          prompt: 'Enter the passphrase for your private key',
          password: true,
          ignoreFocusOut: true
        });
      }
    }

    return {
      host: host.trim(),
      port: parseInt(portStr || '22'),
      username: username.trim(),
      password,
      privateKeyPath,
      passphrase
    };
  }
}

export const connectionHopping = new ConnectionHopping();

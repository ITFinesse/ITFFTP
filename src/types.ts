/**
 * ITFFTP - Type Definitions
 */

import type { ConnectionOptions as TlsConnectionOptions } from 'tls';

export type Protocol = 'ftp' | 'ftps' | 'sftp';

export interface HopConfig {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
}

export interface FTPConfig {
  name?: string;
  /** The location selected by default when a workspace has multiple hosts. */
  default?: boolean;
  host: string;
  port?: number;
  protocol: Protocol;
  username: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  remotePath: string;
  localPath?: string;
  /** Transfer direction for file-watcher changes; independent of opening files in Remote Explorer. */
  autoSync?: 'off' | 'upload' | 'download' | 'both';
  uploadOnSave?: boolean;
  downloadOnOpen?: boolean;
  remoteExplorerOrder?: 'name' | 'size' | 'date' | 'type';
  syncMode?: 'update' | 'full';
  syncOption?: {
    delete?: boolean;
    skipCreate?: boolean;
    ignoreExisting?: boolean;
    update?: boolean;
  };
  collisionPolicy?: 'ask' | 'overwrite' | 'skip';
  ignore?: string[];
  watcher?: boolean | {
    files?: string;
    autoUpload?: boolean;
    autoDelete?: boolean;
  };
  profiles?: { [key: string]: FTPProfileOverride };
  defaultProfile?: string;
  connTimeout?: number;
  keepalive?: number;
  secure?: boolean | 'control' | 'implicit';
  secureOptions?: TlsConnectionOptions;
  passive?: boolean;
  hop?: HopConfig | HopConfig[];
  // Remote-FS Integration: reference to a remote defined in user settings
  remote?: string;
  autoReconnect?: boolean;
}

/** A named profile is applied after its base connection has been resolved, so
 * it cannot switch to another reusable remote or recursively define profiles. */
export type FTPProfileOverride = Partial<Omit<FTPConfig, 'profiles' | 'defaultProfile' | 'remote'>>;

/** The JSON file may store a direct, fully identified connection or a partial
 * connection that references `stackerftp.remotes`. Runtime consumers use the
 * resolved `FTPConfig` returned by the configuration contract. */
export type StoredFTPConfig = FTPConfig | (
  Omit<Partial<FTPConfig>, 'remote' | 'profiles'> & {
    remote: string;
    profiles?: { [key: string]: FTPProfileOverride };
  }
);

// Remote-FS Integration: Remote definition in user settings
export interface RemoteFsConfig {
  name?: string;
  host: string;
  port?: number;
  protocol?: Protocol;
  username?: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  remotePath?: string;
}

export interface FileEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  modifyTime: Date;
  accessTime?: Date;
  rights?: {
    user: string;
    group: string;
    other: string;
  };
  owner?: string | number;
  group?: string | number;
  path: string;
  target?: string; // For symlinks - the path they point to
  isSymlinkToDirectory?: boolean; // Whether symlink points to a directory
}

export type TransferOutcome =
  | { status: 'completed' }
  | { status: 'skipped'; reason: string };

export interface TransferRequestOptions {
  /** Optional queue/display hints. Execution always re-stats the target. */
  size?: number;
  targetExists?: boolean;
  sourceType?: 'file' | 'directory' | 'symlink';
  targetType?: 'file' | 'directory' | 'symlink';
  /** Explicit authorization to transactionally replace the opposing file or
   * directory type after a fresh target stat. */
  replaceTypeCollision?: boolean;
}

export interface TransferItem {
  id: string;
  localPath: string;
  remotePath: string;
  direction: 'upload' | 'download';
  status: 'pending' | 'transferring' | 'completed' | 'skipped' | 'error' | 'cancelled';
  progress: number;
  size: number;
  transferred: number;
  error?: string;
  startTime?: Date;
  endTime?: Date;
  /** Connection reference for this specific transfer - prevents cross-server bugs */
  connectionId?: string;
  /** Config for this transfer to ensure correct server targeting */
  config?: FTPConfig;
  /** Internal promise resolution - used for awaiting specific transfers */
  resolve?: (outcome: TransferOutcome) => void;
  /** Internal promise rejection - used for awaiting specific transfers */
  reject?: (error: unknown) => void;
  /** Metadata to avoid redundant stat calls */
  targetExists?: boolean;
  sourceType?: 'file' | 'directory' | 'symlink';
  targetType?: 'file' | 'directory' | 'symlink';
  replaceTypeCollision?: boolean;
}

export interface SyncResult {
  uploaded: string[];
  downloaded: string[];
  deleted: string[];
  failed: { path: string; error: string }[];
  skipped: string[];
}

export interface ConnectionStatus {
  connected: boolean;
  host?: string;
  protocol?: Protocol;
  currentPath?: string;
  error?: string;
}

export interface FilePermissions {
  mode: number;
  user: { read: boolean; write: boolean; execute: boolean };
  group: { read: boolean; write: boolean; execute: boolean };
  others: { read: boolean; write: boolean; execute: boolean };
}

export interface ChecksumResult {
  algorithm: 'md5' | 'sha1' | 'sha256' | 'sha512';
  local?: string;
  remote?: string;
  match?: boolean;
}

export interface SearchResult {
  file: string;
  path: string;
  line: number;
  column: number;
  content: string;
}

export interface FileInfo {
  path: string;
  name: string;
  size: number;
  sizeFormatted: string;
  modified: Date;
  modifiedFormatted: string;
  permissions: string;
  owner: string;
  group: string;
  mimeType?: string;
  checksum?: ChecksumResult;
}

export interface BackupInfo {
  name: string;
  path: string;
  created: Date;
  size: number;
}

export interface WebMasterSettings {
  enableBackupBeforeUpload: boolean;
  backupRetentionDays: number;
  autoCalculateChecksum: boolean;
  defaultChecksumAlgorithm: 'md5' | 'sha1' | 'sha256';
  enableFilePermissionsCheck: boolean;
  showHiddenFiles: boolean;
}

// ==================== Folder Comparison Types ====================

export interface CompareItem {
  path: string;
  size?: number;
  mtime?: number;
  side: 'local' | 'remote' | 'different';
  // For different items
  localSize?: number;
  remoteSize?: number;
  localMtime?: number;
  remoteMtime?: number;
}

export interface CompareTreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children: CompareTreeNode[];
  localItem?: CompareItem;
  remoteItem?: CompareItem;
}

export interface CompareResult {
  onlyLocal: CompareItem[];
  onlyRemote: CompareItem[];
  different: CompareItem[];
  tree: CompareTreeNode;
}

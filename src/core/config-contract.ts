import type {
  FTPConfig,
  FTPProfileOverride,
  Protocol,
  RemoteFsConfig,
  StoredFTPConfig
} from '../types';

export type ResolvedConnectionConfig = {
  config: FTPConfig;
  remoteName?: string;
};

type UnknownRecord = Record<string, unknown>;

const PROTOCOLS = ['sftp', 'ftp', 'ftps'] as const satisfies readonly Protocol[];
const AUTO_SYNC_MODES = ['off', 'upload', 'download', 'both'] as const;
const REMOTE_EXPLORER_ORDERS = ['name', 'size', 'date', 'type'] as const;
const SYNC_MODES = ['update', 'full'] as const;
const COLLISION_POLICIES = ['ask', 'overwrite', 'skip'] as const;
const SECURE_MODES = ['control', 'implicit'] as const;

const PROFILE_FIELDS = new Set([
  'name', 'default', 'host', 'port', 'protocol', 'username', 'password',
  'privateKeyPath', 'passphrase', 'remotePath', 'localPath', 'autoSync',
  'uploadOnSave', 'downloadOnOpen', 'remoteExplorerOrder', 'syncMode',
  'syncOption', 'collisionPolicy', 'ignore', 'watcher', 'connTimeout',
  'keepalive', 'secure', 'secureOptions', 'passive', 'hop', 'autoReconnect'
]);
const CONFIG_FIELDS = new Set([...PROFILE_FIELDS, 'profiles', 'defaultProfile', 'remote']);
const REMOTE_FIELDS = new Set([
  'name', 'host', 'port', 'protocol', 'username', 'password',
  'privateKeyPath', 'passphrase', 'remotePath'
]);

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasOwn(record: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function assertKnownFields(record: UnknownRecord, fields: ReadonlySet<string>, label: string): void {
  const unknownField = Object.keys(record).find(key => !fields.has(key));
  if (unknownField) {throw new Error(`${label} contains unsupported field "${unknownField}".`);}
}

function assertOptionalType(
  record: UnknownRecord,
  key: string,
  predicate: (value: unknown) => boolean,
  description: string,
  label: string
): void {
  if (hasOwn(record, key) && !predicate(record[key])) {
    throw new Error(`${label}.${key} must be ${description}.`);
  }
}

function isEnumValue(values: readonly string[]): (value: unknown) => boolean {
  return value => typeof value === 'string' && values.includes(value);
}

function isPort(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65535;
}

function isWorkspaceRelativePath(value: unknown): boolean {
  if (typeof value !== 'string' || /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]/.test(value)) {return false;}
  return !value.split(/[\\/]/).some(segment => segment === '..');
}

function validateSyncOptions(value: unknown, label: string): void {
  if (!isRecord(value)) {throw new Error(`${label} must be an object.`);}
  const fields = new Set(['delete', 'skipCreate', 'ignoreExisting', 'update']);
  assertKnownFields(value, fields, label);
  for (const key of fields) {
    assertOptionalType(value, key, item => typeof item === 'boolean', 'true or false', label);
  }
}

function validateWatcher(value: unknown, label: string): void {
  if (typeof value === 'boolean') {return;}
  if (!isRecord(value)) {throw new Error(`${label} must be true, false, or an options object.`);}
  assertKnownFields(value, new Set(['files', 'autoUpload', 'autoDelete']), label);
  assertOptionalType(value, 'files', isNonBlankString, 'a non-empty string', label);
  assertOptionalType(value, 'autoUpload', item => typeof item === 'boolean', 'true or false', label);
  assertOptionalType(value, 'autoDelete', item => typeof item === 'boolean', 'true or false', label);
}

function validateIgnore(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.some(item => !isNonBlankString(item))) {
    throw new Error(`${label} must be an array of non-empty strings.`);
  }
  if (new Set(value).size !== value.length) {throw new Error(`${label} must not contain duplicate entries.`);}
}

function validateHopEntry(value: unknown, label: string): void {
  if (!isRecord(value)) {throw new Error(`${label} must be an object.`);}
  const fields = new Set(['host', 'port', 'username', 'password', 'privateKeyPath', 'passphrase']);
  assertKnownFields(value, fields, label);
  if (!isNonBlankString(value.host)) {throw new Error(`${label}.host must be a non-empty string.`);}
  if (!isNonBlankString(value.username)) {throw new Error(`${label}.username must be a non-empty string.`);}
  assertOptionalType(value, 'port', isPort, 'a whole number between 1 and 65535', label);
  assertOptionalType(value, 'password', item => typeof item === 'string', 'a string', label);
  assertOptionalType(value, 'privateKeyPath', isNonBlankString, 'a non-empty string', label);
  assertOptionalType(value, 'passphrase', item => typeof item === 'string', 'a string', label);
}

function validateHop(value: unknown, label: string): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {throw new Error(`${label} must contain at least one jump host.`);}
    value.forEach((entry, index) => validateHopEntry(entry, `${label}[${index}]`));
    return;
  }
  validateHopEntry(value, label);
}

function validateCommonConnectionFields(record: UnknownRecord, label: string): void {
  assertOptionalType(record, 'name', item => typeof item === 'string', 'a string', label);
  assertOptionalType(record, 'default', item => typeof item === 'boolean', 'true or false', label);
  assertOptionalType(record, 'host', isNonBlankString, 'a non-empty string', label);
  assertOptionalType(record, 'port', isPort, 'a whole number between 1 and 65535', label);
  assertOptionalType(record, 'protocol', isEnumValue(PROTOCOLS), 'sftp, ftp, or ftps', label);
  assertOptionalType(record, 'username', isNonBlankString, 'a non-empty string', label);
  assertOptionalType(record, 'password', item => typeof item === 'string', 'a string', label);
  assertOptionalType(record, 'privateKeyPath', isNonBlankString, 'a non-empty string', label);
  assertOptionalType(record, 'passphrase', item => typeof item === 'string', 'a string', label);
  assertOptionalType(record, 'remotePath', isNonBlankString, 'a non-empty string', label);
  assertOptionalType(record, 'localPath', isWorkspaceRelativePath, 'a workspace-relative path', label);
  assertOptionalType(record, 'autoSync', isEnumValue(AUTO_SYNC_MODES), 'off, upload, download, or both', label);
  assertOptionalType(record, 'uploadOnSave', item => typeof item === 'boolean', 'true or false', label);
  assertOptionalType(record, 'downloadOnOpen', item => typeof item === 'boolean', 'true or false', label);
  assertOptionalType(record, 'remoteExplorerOrder', isEnumValue(REMOTE_EXPLORER_ORDERS), 'name, size, date, or type', label);
  assertOptionalType(record, 'syncMode', isEnumValue(SYNC_MODES), 'update or full', label);
  assertOptionalType(record, 'collisionPolicy', isEnumValue(COLLISION_POLICIES), 'ask, overwrite, or skip', label);
  assertOptionalType(record, 'defaultProfile', isNonBlankString, 'a non-empty string', label);
  assertOptionalType(record, 'connTimeout', item => Number.isInteger(item) && Number(item) >= 1, 'a positive whole number', label);
  assertOptionalType(record, 'keepalive', item => Number.isInteger(item) && Number(item) >= 0, 'a non-negative whole number', label);
  assertOptionalType(
    record,
    'secure',
    item => typeof item === 'boolean' || isEnumValue(SECURE_MODES)(item),
    'true, false, control, or implicit',
    label
  );
  assertOptionalType(record, 'secureOptions', isRecord, 'an object', label);
  assertOptionalType(record, 'passive', item => typeof item === 'boolean', 'true or false', label);
  assertOptionalType(record, 'autoReconnect', item => typeof item === 'boolean', 'true or false', label);
  if (hasOwn(record, 'syncOption')) {validateSyncOptions(record.syncOption, `${label}.syncOption`);}
  if (hasOwn(record, 'ignore')) {validateIgnore(record.ignore, `${label}.ignore`);}
  if (hasOwn(record, 'watcher')) {validateWatcher(record.watcher, `${label}.watcher`);}
  if (hasOwn(record, 'hop')) {validateHop(record.hop, `${label}.hop`);}
}

function validateProfile(value: unknown, label: string): FTPProfileOverride {
  if (!isRecord(value)) {throw new Error(`${label} must be an object.`);}
  assertKnownFields(value, PROFILE_FIELDS, label);
  validateCommonConnectionFields(value, label);
  return value as FTPProfileOverride;
}

function validateProfiles(value: unknown, label: string): void {
  if (!isRecord(value)) {throw new Error(`${label} must be an object of named profiles.`);}
  for (const [name, profile] of Object.entries(value)) {
    if (!name.trim()) {throw new Error(`${label} contains a blank profile name.`);}
    validateProfile(profile, `${label}.${name}`);
  }
}

function validateStoredConnection(value: unknown, label: string): StoredFTPConfig {
  if (!isRecord(value)) {throw new Error(`${label} must be a JSON object.`);}
  assertKnownFields(value, CONFIG_FIELDS, label);
  validateCommonConnectionFields(value, label);
  if (hasOwn(value, 'profiles')) {validateProfiles(value.profiles, `${label}.profiles`);}

  if (hasOwn(value, 'remote')) {
    if (!isNonBlankString(value.remote)) {
      throw new Error('ITFFTP remote reference must be a non-empty string.');
    }
  } else {
    if (!isNonBlankString(value.host)) {throw new Error(`${label}.host must be a non-empty string.`);}
    if (!isEnumValue(PROTOCOLS)(value.protocol)) {throw new Error(`${label}.protocol must be sftp, ftp, or ftps.`);}
    if (!isNonBlankString(value.username)) {throw new Error(`${label}.username must be a non-empty string.`);}
    if (!isNonBlankString(value.remotePath)) {throw new Error(`${label}.remotePath must be a non-empty string.`);}
  }

  return value as StoredFTPConfig;
}

/** Validate parsed sftp.json data without trusting JSON.parse's `any` result. */
export function parseConfiguredConnections(value: unknown): StoredFTPConfig[] {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) {return [];}
  const configs = values.map((entry, index) => validateStoredConnection(entry, `Connection ${index + 1}`));
  if (configs.filter(config => config.default === true).length > 1) {
    throw new Error('Only one connection can be the default host.');
  }
  return configs;
}

function validateReusableRemote(value: unknown, label: string): RemoteFsConfig {
  if (!isRecord(value)) {throw new Error(`${label} must be an object.`);}
  assertKnownFields(value, REMOTE_FIELDS, label);
  if (!isNonBlankString(value.host)) {throw new Error(`${label}.host must be a non-empty string.`);}
  assertOptionalType(value, 'name', item => typeof item === 'string', 'a string', label);
  assertOptionalType(value, 'port', isPort, 'a whole number between 1 and 65535', label);
  assertOptionalType(value, 'protocol', isEnumValue(PROTOCOLS), 'sftp, ftp, or ftps', label);
  assertOptionalType(value, 'username', isNonBlankString, 'a non-empty string', label);
  assertOptionalType(value, 'password', item => typeof item === 'string', 'a string', label);
  assertOptionalType(value, 'privateKeyPath', isNonBlankString, 'a non-empty string', label);
  assertOptionalType(value, 'passphrase', item => typeof item === 'string', 'a string', label);
  assertOptionalType(value, 'remotePath', isNonBlankString, 'a non-empty string', label);
  return value as unknown as RemoteFsConfig;
}

export function parseReusableRemotes(value: unknown): Record<string, RemoteFsConfig> {
  if (value === undefined || value === null) {return {};}
  if (!isRecord(value)) {throw new Error('stackerftp.remotes must be an object.');}
  return Object.fromEntries(Object.entries(value).map(([name, config]) => {
    if (!name.trim()) {throw new Error('stackerftp.remotes contains a blank remote name.');}
    return [name, validateReusableRemote(config, `stackerftp.remotes.${name}`)];
  }));
}

export function applyRuntimeConfigDefaults(config: FTPConfig, autoReconnect: boolean): FTPConfig {
  return {
    uploadOnSave: false,
    syncMode: 'update',
    connTimeout: 10_000,
    keepalive: 300_000,
    passive: true,
    secure: false,
    autoReconnect,
    ...config,
    port: config.port ?? (config.protocol === 'sftp' ? 22 : 21)
  };
}

function assertResolvedIdentity(config: Partial<FTPConfig>): asserts config is FTPConfig {
  if (!isNonBlankString(config.host)) {throw new Error('ITFFTP connection requires a non-empty host.');}
  if (!isEnumValue(PROTOCOLS)(config.protocol)) {throw new Error('ITFFTP connection requires a supported protocol.');}
  if (!isNonBlankString(config.username)) {throw new Error('ITFFTP connection requires a non-empty username.');}
  if (!isNonBlankString(config.remotePath)) {throw new Error('ITFFTP connection requires a non-empty remote path.');}
}

export function resolveConfiguredConnection(
  input: StoredFTPConfig,
  remotes: Record<string, RemoteFsConfig>
): ResolvedConnectionConfig {
  const config = validateStoredConnection(input, 'ITFFTP connection');
  if (!('remote' in config)) {
    assertResolvedIdentity(config);
    return { config };
  }

  const remoteName = config.remote;
  if (!isNonBlankString(remoteName)) {
    throw new Error('ITFFTP remote reference must be a non-empty string.');
  }
  const configuredRemote = remotes[remoteName];
  if (!configuredRemote) {
    throw new Error('ITFFTP remote reference is not defined in stackerftp.remotes.');
  }
  const remoteConfig = validateReusableRemote(configuredRemote, `stackerftp.remotes.${remoteName}`);
  const resolvedConfig: Partial<FTPConfig> = {
    ...remoteConfig,
    ...config,
    host: config.host ?? remoteConfig.host,
    username: config.username ?? remoteConfig.username,
    protocol: config.protocol ?? remoteConfig.protocol ?? 'sftp',
    remotePath: config.remotePath ?? remoteConfig.remotePath ?? '/',
    name: config.name ?? remoteConfig.name ?? remoteName
  };
  assertResolvedIdentity(resolvedConfig);

  return { config: resolvedConfig, remoteName };
}

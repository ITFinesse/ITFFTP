export function normalizeRemoteRelativePath(value: unknown, allowEmpty = false): string | undefined {
  if (value === undefined || value === null) {return allowEmpty ? '' : undefined;}
  if (typeof value !== 'string') {return undefined;}
  const normalized = value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalized) {return allowEmpty ? '' : undefined;}
  const segments = normalized.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || /[\u0000-\u001f\u007f]/.test(segment))) {
    return undefined;
  }
  return normalized;
}

export function safeRemoteEntryName(value: unknown): string | undefined {
  if (typeof value !== 'string') {return undefined;}
  if (!value || value === '.' || value === '..' || /[\\/\u0000-\u001f\u007f]/.test(value)) {return undefined;}
  return value;
}

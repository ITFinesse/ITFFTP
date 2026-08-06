import { describe, it, expect } from 'vitest';
import { normalizeRemotePath, sanitizeRelativePath, matchesPattern, isPathIgnored, formatFileSize } from '../src/utils/helpers';

describe('helpers', () => {
  it('normalizeRemotePath collapses slashes and backslashes', () => {
    expect(normalizeRemotePath('\\var\\www//html//')).toBe('/var/www/html/');
  });

  it('sanitizeRelativePath rejects path traversal', () => {
    expect(() => sanitizeRelativePath('../secrets.txt')).toThrow();
    expect(() => sanitizeRelativePath('..\\secrets.txt')).toThrow();
  });

  it('sanitizeRelativePath rejects absolute paths', () => {
    expect(() => sanitizeRelativePath('/etc/passwd')).toThrow();
  });

  it('matchesPattern supports double star', () => {
    expect(matchesPattern('src/utils/helpers.ts', ['**/*.ts'])).toBe(true);
    expect(matchesPattern('src/utils/helpers.ts', ['**/*.js'])).toBe(false);
  });

  it('matches ignored folder descendants using Windows paths', () => {
    expect(matchesPattern('storage\\logs\\app.log', ['storage/logs/**'])).toBe(true);
    expect(matchesPattern('node_modules\\package\\index.js', ['node_modules'])).toBe(true);
    expect(matchesPattern('src\\index.ts', ['storage/logs/**', 'node_modules'])).toBe(false);
  });

  it('fully ignores a directory, its contents, and matching basenames', () => {
    const patterns = ['storage/logs/**', '.env*', 'node_modules'];
    expect(isPathIgnored('storage/logs', patterns)).toBe(true);
    expect(isPathIgnored('storage/logs/archive/old.log', patterns)).toBe(true);
    expect(isPathIgnored('packages/app/node_modules/lib/index.js', patterns)).toBe(true);
    expect(isPathIgnored('config/.env.local', patterns)).toBe(true);
    expect(isPathIgnored('storage/uploads/image.png', patterns)).toBe(false);
  });

  it('formatFileSize formats bytes', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(1024)).toBe('1 KB');
  });
});

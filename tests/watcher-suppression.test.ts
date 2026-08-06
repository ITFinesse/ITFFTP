import { afterEach, describe, expect, it, vi } from 'vitest';
import { isWatcherWriteSuppressed, suppressWatcherWrite } from '../src/core/watcher-suppression';

afterEach(() => vi.useRealTimers());

describe('watcher write suppression', () => {
  it('suppresses an ITFFTP-generated local write only for its configured window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-06T15:00:00Z'));
    const file = 'X:\\workspace\\downloaded.php';
    suppressWatcherWrite(file, 3000);
    expect(isWatcherWriteSuppressed(file)).toBe(true);
    vi.advanceTimersByTime(3001);
    expect(isWatcherWriteSuppressed(file)).toBe(false);
  });
});

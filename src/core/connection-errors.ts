export function connectionErrorMessage(error: unknown): string {
  if (error instanceof Error) { return `${error.message}\n${error.stack || ''}`; }
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message || '');
  }
  return String(error || '');
}

/** Errors that mean the underlying control socket cannot be reused. */
export function isConnectionClosedError(error: unknown): boolean {
  return /server sent fin|client is closed|connection (?:closed|reset)|econnreset|econnaborted|epipe|socket hang up|not connected/i
    .test(connectionErrorMessage(error));
}

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

/** Missing-path responses are safe to treat idempotently for delete/list flows. */
export function isRemoteMissingError(error: unknown): boolean {
  return /\b550\b.*(?:no such file|not found|existence)|no such file|not found/i
    .test(connectionErrorMessage(error));
}

/** A path exists but cannot be listed because it is a file, not a directory. */
export function isRemoteNotDirectoryError(error: unknown): boolean {
  const message = connectionErrorMessage(error);
  if (/\b(?:permission|access) denied\b|\b(?:operation )?not permitted\b|\bunauthori[sz]ed\b|\bforbidden\b|\binsufficient privileges?\b/i.test(message)) {
    return false;
  }

  return /\benotdir\b|\bnot (?:a )?directory\b/i.test(message)
    || /\b(?:failed to|unable to|cannot|can't|could not) change (?:working )?directory\b|\b(?:change (?:working )?directory|cwd) failed\b/i.test(message);
}

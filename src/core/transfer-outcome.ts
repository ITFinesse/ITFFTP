import * as path from 'path';
import type { TransferOutcome } from '../types';

export function isTransferCompleted(outcome: TransferOutcome): outcome is Extract<TransferOutcome, { status: 'completed' }> {
  return outcome.status === 'completed';
}

export function skippedTransferMessage(
  action: 'Upload' | 'Download' | 'Auto-upload',
  target: string,
  outcome: TransferOutcome
): string {
  if (isTransferCompleted(outcome)) {
    throw new Error('A completed transfer does not have a skip message');
  }
  return `${action} skipped: ${path.basename(target)} — ${outcome.reason}`;
}

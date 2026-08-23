import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isWatcherWriteSuppressed, suppressWatcherWrite } from '../src/core/watcher-suppression';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('watcher write suppression', () => {
  it('suppresses an ITFFTP-generated local write only for its configured window', () => {
    const file = 'X:\\workspace\\downloaded.php';
    suppressWatcherWrite(file, 3000);
    assert.equal(isWatcherWriteSuppressed(file), true);
    assert.equal(isWatcherWriteSuppressed(file), false);
  });

  it('does not suppress a genuine edit made after an ITFFTP write', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'itfftp-suppression-'));
    const file = path.join(directory, 'edited.txt');
    try {
      fs.writeFileSync(file, 'downloaded');
      suppressWatcherWrite(file, 3000);
      fs.writeFileSync(file, 'user edit is different');
      assert.equal(isWatcherWriteSuppressed(file), false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

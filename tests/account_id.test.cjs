const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { accountIdFromBackupDirectory } = require('../electron/account_id.cjs');

test('reads the account folder name without opening any save files', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'garlic-account-test-'));
  try {
    const backup = path.join(folder, 'PS4', 'SAVEDATA', '0102030405060708');
    fs.mkdirSync(backup, { recursive: true });
    for (const selected of [folder, path.join(folder, 'PS4'), path.dirname(backup), backup]) {
      assert.equal(accountIdFromBackupDirectory(selected), '72623859790382856');
    }
    fs.mkdirSync(path.join(folder, 'PS4', 'SAVEDATA', '1111111111111111'));
    assert.throws(() => accountIdFromBackupDirectory(folder), /one account folder/);
    assert.equal(accountIdFromBackupDirectory(backup), '72623859790382856');
  } finally {
    // Only remove the unique directory this test created beneath the temp root.
    const resolved = fs.realpathSync(folder);
    assert.ok(resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

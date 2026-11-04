const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pairingPrefixPath, existingPairingPrefix } = require('../electron/pairing_store.cjs');

const consoleIdentity = { hostId: '5c96661f7c1a', systemVersion: '14220000' };

test('pairing is isolated by console and firmware and requires a 32-byte file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garlic-pair-test-'));
  try {
    const file = pairingPrefixPath(root, consoleIdentity);
    assert.equal(existingPairingPrefix(root, consoleIdentity), null);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(31));
    assert.equal(existingPairingPrefix(root, consoleIdentity), null);
    fs.writeFileSync(file, Buffer.alloc(32));
    assert.equal(existingPairingPrefix(root, consoleIdentity), file);
    assert.equal(existingPairingPrefix(root, { ...consoleIdentity, systemVersion: '14230000' }), null);
    assert.equal(existingPairingPrefix(root, { ...consoleIdentity, hostId: '000000000001' }), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('untrusted console identifiers cannot escape the pairing directory', () => {
  const root = os.tmpdir();
  assert.throws(() => pairingPrefixPath(root, { ...consoleIdentity, hostId: '../elsewhere' }));
  assert.throws(() => pairingPrefixPath(root, { ...consoleIdentity, systemVersion: '../firmware' }));
});

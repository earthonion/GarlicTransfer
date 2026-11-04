const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { inspectLocalSave } = require('../electron/local_save.cjs');

function header(entryId, sourcePath, size, final = false) {
  const data = Buffer.alloc(1304);
  data.writeUInt32LE(0x35504647, 0);
  data.writeUInt32LE(entryId, 4);
  data.writeBigUInt64LE(BigInt(size), 240);
  data[274] = final ? 1 : 0;
  Buffer.from(sourcePath).copy(data, 276);
  return data.toString('hex');
}

test('accepts an intact downloaded save folder and rejects changed bytes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garlic-local-save-'));
  try {
    const folder = path.join(root, '108');
    fs.mkdirSync(folder);
    const content = Buffer.from('save bytes');
    const sourcePath = '/user/home/abcdef12/savedata/CUSA09303/sdimg_save';
    fs.writeFileSync(path.join(folder, 'sdimg_save'), content);
    fs.writeFileSync(path.join(root, 'metadata.db'), 'placeholder');
    fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({
      entry_id: 108,
      108: {
        files: [{
          file: 'sdimg_save', path: sourcePath, size: content.length,
          sha256: crypto.createHash('sha256').update(content).digest('hex'),
          header: header(108, sourcePath, content.length),
        }],
        final_header: header(108, '', 0, true),
      },
    }));
    const inspected = await inspectLocalSave(folder);
    assert.equal(inspected.entryId, 108);
    assert.equal(inspected.title, 'CUSA09303');
    assert.equal(inspected.kind, 'PS4');
    assert.equal(inspected.sizeBytes, content.length);
    assert.equal(inspected.sourceMetadata, path.join(root, 'metadata.db'));
    fs.writeFileSync(path.join(folder, 'sdimg_save'), Buffer.from('not a save'));
    await assert.rejects(() => inspectLocalSave(folder), /checksum/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a filename that escapes the selected folder', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garlic-local-save-'));
  try {
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
      entry_id: 1,
      1: {
        files: [{ file: '../outside', path: '/user/home/abcdef12/savedata/ABCDEFGHI/outside' }],
        final_header: header(1, '', 0, true),
      },
    }));
    await assert.rejects(() => inspectLocalSave(root), /invalid or duplicate filename/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { planWorkspaceSaves } = require('../electron/workspace_saves.cjs');

// Function Test Workspace
async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'garlic-workspace-saves-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

// Function Test SFO
function sfo(accountId = '1122334455667788', titleId = 'PPSA38500', padding = 0) {
  const fields = [['TITLE_ID', Buffer.from(`${titleId}\0`), 0x0204]];
  if (padding) fields.push(['PADDING', Buffer.alloc(padding, 0xa5), 0x0004]);
  fields.push(['ACCOUNT_ID', Buffer.from(accountId, 'hex'), 0x0004]);
  const keys = [], data = [], entries = Buffer.alloc(fields.length * 16);
  let keySize = 0, dataSize = 0;
  for (const [index, [key, value, format]] of fields.entries()) {
    const capacity = (value.length + 3) & ~3, entry = index * 16;
    entries.writeUInt16LE(keySize, entry);
    entries.writeUInt16LE(format, entry + 2);
    entries.writeUInt32LE(value.length, entry + 4);
    entries.writeUInt32LE(capacity, entry + 8);
    entries.writeUInt32LE(dataSize, entry + 12);
    keys.push(Buffer.from(`${key}\0`)); keySize += key.length + 1;
    data.push(value, Buffer.alloc(capacity - value.length)); dataSize += capacity;
  }
  const keyOffset = 20 + entries.length, dataOffset = (keyOffset + keySize + 3) & ~3;
  const header = Buffer.alloc(20);
  Buffer.from('\0PSF').copy(header);
  header.writeUInt32LE(0x101, 4);
  header.writeUInt32LE(keyOffset, 8);
  header.writeUInt32LE(dataOffset, 12);
  header.writeUInt32LE(fields.length, 16);
  return Buffer.concat([header, entries, ...keys, Buffer.alloc(dataOffset - keyOffset - keySize), ...data]);
}

// Function Test Save
async function save(root, name, options = {}) {
  const directory = path.join(root, name);
  await fs.mkdir(path.join(directory, 'sce_sys'), { recursive: true });
  await fs.writeFile(path.join(directory, 'sce_sys', 'param.sfo'), options.sfo || sfo(options.accountId, options.titleId, options.padding));
  await fs.writeFile(path.join(directory, 'memory.dat'), `payload for ${name}`);
  if (options.metadata !== false) {
    const metadata = {
      schema_version: 1, platform: 'PS5', title_id: options.titleId || 'PPSA38500',
      encrypted_name: path.basename(name), original_image_size_bytes: 131072,
      pfs: { version: 2, block_size_bytes: 65536, block_count: 2, mode_raw: 0, backup_header_count: 0, fs_ext: 0 },
      ownership: [{ path: 'memory.dat', uid: 0, gid: 0, mode: 0o600 }],
      ...options.metadata,
    };
    await fs.writeFile(path.join(directory, 'chives.json'), JSON.stringify(metadata));
  }
  return directory;
}

// Function Test Snapshot
async function snapshot(root) {
  const values = {};
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else values[path.relative(root, filename)] = (await fs.readFile(filename)).toString('hex');
    }
  }
  await visit(root);
  return values;
}

test('plans five independent decrypted containers without changing any files', async (t) => {
  const root = await workspace(t), expected = [];
  for (let index = 1; index <= 5; index++) {
    const name = `sdimg_SLOT${index}`, accountId = `123456789abc000${index}`;
    expected.push({ root: await save(root, name, { accountId }), label: name, titleId: 'PPSA38500', accountId, encryptedName: name });
  }
  const before = await snapshot(root);
  assert.deepEqual(await planWorkspaceSaves(root), expected);
  assert.deepEqual(await snapshot(root), before);
});

test('zero or one save keeps the existing single-save flow', async (t) => {
  const root = await workspace(t);
  assert.deepEqual(await planWorkspaceSaves(root), []);
  await save(root, 'sdimg_SLOT1', { metadata: false, sfo: Buffer.from('legacy test SFO') });
  for (let index = 1; index <= 20; index++) await fs.writeFile(path.join(root, 'sdimg_SLOT1', `data-${index}.dat`), 'data');
  assert.deepEqual(await planWorkspaceSaves(root), []);
  assert.deepEqual(await planWorkspaceSaves(path.join(root, 'sdimg_SLOT1')), []);
});

test('a workspace with its own SFO remains one save even with a nested payload SFO', async (t) => {
  const root = await workspace(t);
  await save(root, '.');
  await fs.mkdir(path.join(root, 'nested', 'sce_sys'), { recursive: true });
  await fs.writeFile(path.join(root, 'nested', 'sce_sys', 'param.sfo'), 'ordinary payload');
  assert.deepEqual(await planWorkspaceSaves(root), []);
});

test('supports wrappers and reads account fields beyond the old fixed offsets', async (t) => {
  const root = await workspace(t);
  const first = await save(root, 'wrapped/one/slot-a', { accountId: 'fedcba9876543210', padding: 1024 });
  const second = await save(root, 'wrapped/two/slot-b', { accountId: '0102030405060708', padding: 1536 });
  const planned = await planWorkspaceSaves(root);
  assert.deepEqual(planned.map(({ root: directory, label, accountId }) => ({ root: directory, label, accountId })), [
    { root: first, label: 'wrapped/one/slot-a', accountId: 'fedcba9876543210' },
    { root: second, label: 'wrapped/two/slot-b', accountId: '0102030405060708' },
  ]);
});

test('uses SFO title and folder name when descriptive metadata fields are absent', async (t) => {
  const root = await workspace(t);
  await save(root, 'a', { titleId: 'PPSA00001', metadata: { title_id: '', encrypted_name: '' } });
  await save(root, 'b', { titleId: 'PPSA00002', metadata: { title_id: '', encrypted_name: '' } });
  assert.deepEqual((await planWorkspaceSaves(root)).map(({ titleId, encryptedName }) => ({ titleId, encryptedName })), [
    { titleId: 'PPSA00001', encryptedName: 'a' }, { titleId: 'PPSA00002', encryptedName: 'b' },
  ]);
});

test('rejects mismatched SFO and chives titles', async (t) => {
  const root = await workspace(t);
  await save(root, 'a');
  await save(root, 'b', { titleId: 'PPSA12345', metadata: { title_id: 'PPSA54321' } });
  await assert.rejects(planWorkspaceSaves(root), /title ID does not match param\.sfo/);
});

test('rejects stray files outside the separate save folders', async (t) => {
  const root = await workspace(t);
  await save(root, 'wrapper/a'); await save(root, 'wrapper/b');
  await fs.writeFile(path.join(root, 'wrapper', 'forgotten.dat'), 'must not be dropped');
  await assert.rejects(planWorkspaceSaves(root), /move this file into its save folder.*forgotten\.dat/);
});

test('requires each container to have its own geometry before planning any jobs', async (t) => {
  const root = await workspace(t);
  await save(root, 'a');
  await save(root, 'b', { metadata: false });
  await assert.rejects(planWorkspaceSaves(root), /cannot prepare batch save b.*chives\.json/);
});

test('rejects shared wrapper metadata and nested metadata outside save roots', async (t) => {
  const root = await workspace(t);
  await save(root, 'a'); await save(root, 'b');
  for (const filename of ['chives.json', 'PS5IMAGE', 'PS5KEY', 'PS5PARAM', 'PS5PARAM_SIZE']) {
    const shared = path.join(root, filename);
    await fs.writeFile(shared, 'shared metadata');
    await assert.rejects(planWorkspaceSaves(root), /separate metadata/);
    await fs.rm(shared);
  }
  await fs.mkdir(path.join(root, 'a', 'nested'));
  await fs.writeFile(path.join(root, 'a', 'nested', 'chives.json'), '{}');
  await assert.rejects(planWorkspaceSaves(root), /separate metadata/);
});

test('rejects overlapping save roots and extra param.sfo files', async (t) => {
  const root = await workspace(t);
  await save(root, 'a'); await save(root, 'b');
  const nested = await save(root, 'a/nested');
  await assert.rejects(planWorkspaceSaves(root), /overlap/);
  await fs.rm(nested, { recursive: true });
  await fs.writeFile(path.join(root, 'a', 'param.sfo'), sfo());
  await assert.rejects(planWorkspaceSaves(root), /multiple param\.sfo/);
});

test('rejects duplicate encrypted output names case-insensitively for the same title', async (t) => {
  const root = await workspace(t);
  await save(root, 'a', { metadata: { encrypted_name: 'sdimg_Save' } });
  await save(root, 'b', { metadata: { encrypted_name: 'sdimg_SAVE' } });
  await assert.rejects(planWorkspaceSaves(root), /duplicate encrypted save filename/);
  const metadata = JSON.parse(await fs.readFile(path.join(root, 'b', 'chives.json'), 'utf8'));
  metadata.title_id = 'PPSA00002';
  await fs.writeFile(path.join(root, 'b', 'chives.json'), JSON.stringify(metadata));
  await fs.writeFile(path.join(root, 'b', 'sce_sys', 'param.sfo'), sfo(undefined, metadata.title_id));
  await fs.writeFile(path.join(root, 'b', 'sce_sys', 'param.sfo'), sfo(undefined, 'PPSA00002'));
  assert.equal((await planWorkspaceSaves(root)).length, 2);
});

test('rejects malformed SFO headers, table bounds, duplicate fields, and account lengths', async (t) => {
  const root = await workspace(t);
  await save(root, 'a');
  const second = await save(root, 'b'), filename = path.join(second, 'sce_sys', 'param.sfo');
  const variants = [Buffer.from('bad SFO'), sfo().subarray(0, 19)];
  for (const [offset, value] of [[4, 0x102], [8, 20], [12, 0xffffffff], [16, 0xffffffff], [24, 0xffffffff], [32, 0xffffffff]]) {
    const invalid = sfo(); invalid.writeUInt32LE(value, offset); variants.push(invalid);
  }
  const shortAccount = sfo(); shortAccount.writeUInt32LE(4, 40); variants.push(shortAccount);
  const duplicate = sfo(); duplicate.writeUInt16LE(0, 36); variants.push(duplicate);
  for (const invalid of variants) {
    await fs.writeFile(filename, invalid);
    await assert.rejects(planWorkspaceSaves(root), /param\.sfo/);
  }
});

test('requires a structured account field instead of accepting bytes at a fixed offset', async (t) => {
  const root = await workspace(t);
  await save(root, 'a');
  const malformed = Buffer.alloc(0x400);
  Buffer.from('1122334455667788', 'hex').copy(malformed, 0x1b8);
  await save(root, 'b', { sfo: malformed });
  await assert.rejects(planWorkspaceSaves(root), /invalid param\.sfo/);
});

test('rejects invalid or duplicate chives geometry without changing the workspace', async (t) => {
  const root = await workspace(t);
  await save(root, 'a');
  const second = await save(root, 'b'), filename = path.join(second, 'chives.json');
  const valid = JSON.parse(await fs.readFile(filename, 'utf8'));
  const variants = [null, {}, { ...valid, platform: 'PS4' }, { ...valid, original_image_size_bytes: 0 },
    { ...valid, pfs: { ...valid.pfs, version: 1 } }, { ...valid, pfs: { ...valid.pfs, block_count: 1 } },
    { ...valid, pfs: { ...valid.pfs, fs_ext: 2 } }, { ...valid, ownership: [{ path: '../escape', uid: 0, gid: 0, mode: 0 }] }];
  for (const invalid of variants) {
    await fs.writeFile(filename, JSON.stringify(invalid));
    await assert.rejects(planWorkspaceSaves(root), /chives\.json/);
  }
  await fs.writeFile(filename, JSON.stringify(valid).replace('"schema_version":1', '"schema_version":1,"schema_version":1'));
  await assert.rejects(planWorkspaceSaves(root), /duplicate chives\.json field/);
  await fs.writeFile(filename, 'x'.repeat(262145));
  await assert.rejects(planWorkspaceSaves(root), /invalid save metadata/);
});

test('rejects unsafe encrypted names before any worker use', async (t) => {
  const root = await workspace(t);
  await save(root, 'a');
  const second = await save(root, 'b'), filename = path.join(second, 'chives.json');
  const metadata = JSON.parse(await fs.readFile(filename, 'utf8'));
  for (const encrypted_name of ['../outside', 'a/b', 'a\\b', 'C:save', '..', 'name.', 'a<b', 'a>b', 'a"b', 'a|b', 'a?b', 'a*b', 'x'.repeat(256)]) {
    await fs.writeFile(filename, JSON.stringify({ ...metadata, encrypted_name }));
    await assert.rejects(planWorkspaceSaves(root), /invalid encrypted save filename/);
  }
});

test('rejects symbolic links and linked workspace roots', async (t) => {
  const root = await workspace(t);
  await save(root, 'a'); await save(root, 'b');
  const link = path.join(root, 'linked');
  try { await fs.symlink(path.join(root, 'a'), link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('symbolic links unavailable'); throw error; }
  await assert.rejects(planWorkspaceSaves(root), /links or special files/);
  await assert.rejects(planWorkspaceSaves(link), /links or special files/);
  await fs.rm(link, { recursive: true, force: true });
  try { await fs.symlink(path.join(root, 'a', 'memory.dat'), path.join(root, 'linked.dat')); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('file symbolic links unavailable'); throw error; }
  await assert.rejects(planWorkspaceSaves(root), /links or special files/);
});

test('rejects hard links shared between save folders', async (t) => {
  const root = await workspace(t);
  await save(root, 'a'); await save(root, 'b');
  await fs.link(path.join(root, 'a', 'memory.dat'), path.join(root, 'b', 'shared.dat'));
  await assert.rejects(planWorkspaceSaves(root), /links or special files/);
});

test('rejects special files', { skip: process.platform === 'win32' }, async (t) => {
  const root = await workspace(t);
  await save(root, 'a'); await save(root, 'b');
  try { execFileSync('mkfifo', [path.join(root, 'pipe')]); }
  catch (error) { if (error.code === 'ENOENT') return t.skip('mkfifo unavailable'); throw error; }
  await assert.rejects(planWorkspaceSaves(root), /links or special files/);
});

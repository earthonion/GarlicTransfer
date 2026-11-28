const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { workspaceInfo, writeWorkspaceFile, registerSaveEditor } = require('../electron/save_editor.cjs');

// Function Test Names
const names = new Map([['PPSA01547', 'Example Adventure'], ['PPSA12345', 'Second Game']]);
const titleName = id => names.get(id) || 'Unknown title';

// Function Test Workspace
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'garlic-game-names-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  return { root, workspace };
}

// Function Test SFO
function sfo(titleId) {
  const fields = [['TITLE_ID', Buffer.from(`${titleId}\0`), 0x0204], ['ACCOUNT_ID', Buffer.from('1122334455667788', 'hex'), 0x0004]];
  const keys = Buffer.from(fields.map(([key]) => `${key}\0`).join(''));
  const keyStart = 20 + fields.length * 16;
  const dataStart = (keyStart + keys.length + 3) & ~3;
  const bytes = Buffer.alloc(dataStart + fields.reduce((total, [, value]) => total + value.length, 0));
  bytes.write('\0PSF', 0, 'binary'); bytes.writeUInt32LE(0x101, 4);
  bytes.writeUInt32LE(keyStart, 8); bytes.writeUInt32LE(dataStart, 12); bytes.writeUInt32LE(fields.length, 16);
  keys.copy(bytes, keyStart);
  let keyOffset = 0, dataOffset = 0;
  for (const [index, [key, value, format]] of fields.entries()) {
    const entry = 20 + index * 16;
    bytes.writeUInt16LE(keyOffset, entry); bytes.writeUInt16LE(format, entry + 2);
    bytes.writeUInt32LE(value.length, entry + 4); bytes.writeUInt32LE(value.length, entry + 8);
    bytes.writeUInt32LE(dataOffset, entry + 12); value.copy(bytes, dataStart + dataOffset);
    keyOffset += key.length + 1; dataOffset += value.length;
  }
  return bytes;
}

// Function Test Save
async function save(root, titleId, encryptedName = 'sdimg_DATA') {
  await fs.mkdir(path.join(root, 'sce_sys'), { recursive: true });
  await fs.writeFile(path.join(root, 'sce_sys/param.sfo'), sfo(titleId));
  await fs.writeFile(path.join(root, 'game.dat'), 'original bytes');
  await fs.writeFile(path.join(root, 'chives.json'), JSON.stringify({
    schema_version: 1, platform: 'PS5', title_id: titleId, encrypted_name: encryptedName,
    original_image_size_bytes: 2 * 65536,
    pfs: { version: 2, block_size_bytes: 65536, block_count: 2, fs_ext: 0 },
  }));
}

test('workspace names use the title catalog and remain present after editing', async t => {
  const { workspace } = await fixture(t);
  await save(workspace, 'PPSA01547');
  const before = await fs.readFile(path.join(workspace, 'chives.json'));
  const info = await workspaceInfo(workspace, undefined, titleName);
  assert.equal(info.gameName, 'Example Adventure');
  assert.equal(info.titleId, 'PPSA01547');
  const changed = await writeWorkspaceFile(workspace, 'game.dat', Buffer.from('edited bytes').toString('base64'), titleName);
  assert.equal(changed.gameName, 'Example Adventure');
  assert.deepEqual(await fs.readFile(path.join(workspace, 'chives.json')), before);
});

test('unknown or unavailable catalog names have an explicit fallback', async t => {
  const { workspace } = await fixture(t);
  await save(workspace, 'PPSA99999');
  assert.equal((await workspaceInfo(workspace, undefined, titleName)).gameName, 'Unknown title');
  assert.equal((await workspaceInfo(workspace)).gameName, 'Unknown title');
});

test('batch workspaces retain the game name for each independent title', async t => {
  const { workspace } = await fixture(t);
  await save(path.join(workspace, 'slot-a'), 'PPSA01547', 'sdimg_A');
  await save(path.join(workspace, 'slot-b'), 'PPSA12345', 'sdimg_B');
  const info = await workspaceInfo(workspace, undefined, titleName);
  assert.deepEqual(info.saves.map(save => [save.titleId, save.gameName]), [
    ['PPSA01547', 'Example Adventure'], ['PPSA12345', 'Second Game'],
  ]);
});

test('workspace IPC refreshes keep catalog names after writes, additions, replacement and deletion', async t => {
  const { root, workspace } = await fixture(t);
  await save(workspace, 'PPSA01547');
  const handlers = new Map(), selections = [];
  registerSaveEditor({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    app: { getPath: () => root },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: selections.shift() }) },
    shell: {}, python: 'unused', resourceRoot: root, workDir: root, titleName,
  });
  const event = { sender: { isDestroyed: () => false, send() {} } };
  const invoke = (name, options) => handlers.get(`save-editor:${name}`)(event, options);
  selections.push([workspace]);
  assert.equal((await invoke('choose-workspace')).gameName, 'Example Adventure');
  assert.equal((await invoke('info', workspace)).gameName, 'Example Adventure');
  assert.equal((await invoke('write', { root: workspace, path: 'game.dat', data: Buffer.from('edited').toString('base64') })).gameName, 'Example Adventure');
  const extra = path.join(root, 'extra.dat');
  await fs.writeFile(extra, 'extra bytes'); selections.push([extra]);
  assert.equal((await invoke('add', { root: workspace })).gameName, 'Example Adventure');
  const replacement = path.join(root, 'replacement.dat');
  await fs.writeFile(replacement, 'replacement bytes'); selections.push([replacement]);
  assert.equal((await invoke('replace', { root: workspace, path: 'game.dat' })).gameName, 'Example Adventure');
  assert.equal(await fs.readFile(path.join(workspace, 'game.dat'), 'utf8'), 'replacement bytes');
  assert.equal((await invoke('delete', { root: workspace, path: 'extra.dat' })).gameName, 'Example Adventure');
});

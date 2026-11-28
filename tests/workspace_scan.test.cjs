const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { makeSfo } = require('./fixtures/sfo.cjs');
const { workspaceInfo, runSaveJob } = require('../electron/save_editor.cjs');

function editorWithReads(reads, opens = new Map()) {
  const filename = path.resolve(__dirname, '../electron/save_editor.cjs');
  const localRequire = createRequire(filename);
  const observed = { ...fs,
    async readdir(...args) {
      const selected = path.resolve(args[0]);
      reads.set(selected, (reads.get(selected) || 0) + 1);
      return (await fs.readdir(...args)).sort((a, b) => b.name.localeCompare(a.name));
    },
    async open(...args) {
      const selected = path.resolve(args[0]);
      opens.set(selected, (opens.get(selected) || 0) + 1);
      return fs.open(...args);
    },
  };
  function load(filename, extra = {}) {
    const module = { exports: {} };
    const context = vm.createContext({ module, Buffer, require: name => name === 'node:fs/promises' ? observed : extra[name] || localRequire(name) });
    new vm.Script(syncFs.readFileSync(filename, 'utf8'), { filename }).runInContext(context);
    return module.exports;
  }
  const saves = load(path.resolve(__dirname, '../electron/workspace_saves.cjs'));
  return load(filename, { './workspace_saves.cjs': saves });
}

async function fixture(t, includeSfo = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'garlic-workspace-scan-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [folder, account] of [['A', '1122334455667788'], ['Z', '8877665544332211']]) {
    await fs.mkdir(path.join(root, folder, 'sce_sys'), { recursive: true });
    if (includeSfo) {
      const bytes = makeSfo(account);
      await fs.writeFile(path.join(root, folder, 'sce_sys', 'param.sfo'), bytes);
    }
    await fs.writeFile(path.join(root, folder, 'save.dat'), 'payload');
  }
  await fs.writeFile(path.join(root, 'chives.json'), JSON.stringify({ title_id: 'PPSA24003' }));
  return root;
}

test('workspace scans each folder once and preserves standalone account selection', async t => {
  const root = await fixture(t);
  const reads = new Map();
  const editor = editorWithReads(reads);
  const account = await editor.accountIdFromSfo(root);
  assert.equal(account, '8877665544332211');
  reads.clear();
  const info = await editor.workspaceInfo(root);
  assert.equal(info.accountId, account);
  assert.equal(info.titleId, 'PPSA24003');
  assert.match(info.batchError, /separate metadata/);
  assert.equal(info.saves.length, 0);
  assert.equal(info.files.length, 5);
  assert.equal(reads.size, 5);
  for (const count of reads.values()) assert.equal(count, 1);
});

test('workspace without SFO avoids another traversal and reads fresh metadata next time', async t => {
  const root = await fixture(t, false);
  const reads = new Map();
  const { workspaceInfo } = editorWithReads(reads);
  assert.equal((await workspaceInfo(root)).accountId, '');
  assert.equal(reads.size, 5);
  for (const count of reads.values()) assert.equal(count, 1);
  const bytes = makeSfo('aabbccddeeff0011');
  await fs.writeFile(path.join(root, 'A', 'sce_sys', 'PARAM.SFO'), bytes);
  await fs.writeFile(path.join(root, 'chives.json'), JSON.stringify({ title_id: 'PPSA99999' }));
  reads.clear();
  const info = await workspaceInfo(root);
  assert.equal(info.accountId, 'aabbccddeeff0011');
  assert.equal(info.titleId, 'PPSA99999');
  for (const count of reads.values()) assert.equal(count, 1);
});

test('editing refreshes current sizes and metadata in a single folder walk', async t => {
  const root = await fixture(t);
  const reads = new Map();
  const editor = editorWithReads(reads);
  const data = Buffer.from('changed payload length');
  const info = await editor.writeWorkspaceFile(root, 'A/save.dat', data.toString('base64'));
  assert.equal(info.files.find(file => file.path === 'A/save.dat').size, data.length);
  assert.equal(info.accountId, '8877665544332211');
  assert.equal(await fs.readFile(path.join(root, 'A', 'save.dat'), 'utf8'), data.toString());
  assert.equal(reads.size, 5);
  for (const count of reads.values()) assert.equal(count, 1);
});

// Function = Test Metadata
async function batchMetadata(root) {
  await fs.unlink(path.join(root, 'chives.json'));
  for (const folder of ['A', 'Z']) {
    await fs.writeFile(path.join(root, folder, 'chives.json'), JSON.stringify({
      schema_version: 1, platform: 'PS5', title_id: 'PPSA24003', encrypted_name: `sdimg_${folder}`,
      original_image_size_bytes: 131072,
      pfs: { version: 2, block_size_bytes: 65536, block_count: 2, fs_ext: 0 },
    }));
  }
}

test('batch header, planning and current account share one fresh scan and SFO read', async t => {
  const root = await fixture(t);
  await batchMetadata(root);
  const reads = new Map(), opens = new Map();
  const editor = editorWithReads(reads, opens);
  const info = await editor.workspaceInfo(root);
  assert.equal(info.saves.length, 2);
  assert.equal(info.accountId, '8877665544332211');
  assert.equal(reads.size, 5);
  for (const count of reads.values()) assert.equal(count, 1);
  for (const folder of ['A', 'Z']) {
    assert.equal(opens.get(path.join(root, folder, 'sce_sys/param.sfo')), 1);
    assert.equal(opens.get(path.join(root, folder, 'chives.json')), 1);
  }
  await fs.writeFile(path.join(root, 'Z', 'sce_sys/param.sfo'), makeSfo('fedcba9876543210'));
  const chives = path.join(root, 'Z', 'chives.json');
  const metadata = JSON.parse(await fs.readFile(chives, 'utf8'));
  await fs.writeFile(chives, JSON.stringify({ ...metadata, encrypted_name: 'sdimg_UPDATED' }));
  reads.clear(); opens.clear();
  const refreshed = await editor.workspaceInfo(root);
  assert.equal(refreshed.accountId, 'fedcba9876543210');
  assert.equal(refreshed.saves.find(save => save.label === 'Z').encryptedName, 'sdimg_UPDATED');
  for (const count of reads.values()) assert.equal(count, 1);
  for (const folder of ['A', 'Z']) assert.equal(opens.get(path.join(root, folder, 'sce_sys/param.sfo')), 1);
});

test('damaged metadata keeps the tree visible and blocks encryption before packaging', async t => {
  const root = await fixture(t);
  await batchMetadata(root);
  const userDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'garlic-metadata-job-'));
  t.after(() => fs.rm(userDataRoot, { recursive: true, force: true }));
  const output = path.join(userDataRoot, 'result.zip');
  const options = { operation: 'encrypt', output, userDataRoot, accountId: '1122334455667788', workerKey: 'test' };
  for (const folder of ['A', 'Z']) {
    const single = path.join(root, folder);
    const filename = path.join(single, 'chives.json');
    const original = await fs.readFile(filename);
    await fs.writeFile(filename, '{broken');
    for (const workspace of [root, single]) {
      const info = await workspaceInfo(workspace);
      const prefix = workspace === root ? folder + '/' : '';
      assert.ok(info.files.some(file => file.path === prefix + 'save.dat'));
      assert.ok(info.batchError.includes(prefix + 'chives.json'));
      for (const useRemoteOracle of [true, false]) {
        await assert.rejects(runSaveJob({
          ...options, workspace, useRemoteOracle, oracleHost: '127.0.0.1',
          ensureLocalWorker: () => assert.fail('unexpected worker startup'),
        }), { message: info.batchError });
      }
    }
    await assert.rejects(fs.stat(output), { code: 'ENOENT' });
    await fs.writeFile(filename, original);
    const restored = await workspaceInfo(root);
    assert.equal(restored.batchError, '');
    assert.equal(restored.saves.length, 2);
  }
});

test('structured account reads ignore bytes at historical fixed offsets', async t => {
  const root = await fixture(t, false);
  const filename = path.join(root, 'A', 'sce_sys/param.sfo');
  const bytes = makeSfo('1020304050607080', 'PPSA24003', 1024);
  Buffer.from('aabbccddeeff0011', 'hex').copy(bytes, 0x1b8);
  Buffer.from('1122334455667788', 'hex').copy(bytes, 0x15c);
  await fs.writeFile(filename, bytes);
  const editor = editorWithReads(new Map());
  assert.equal(await editor.accountIdFromSfo(root), '1020304050607080');
  assert.equal((await editor.workspaceInfo(root)).accountId, '1020304050607080');
  await fs.writeFile(filename, makeSfo('fedcba9876543210', 'CUSA12345'));
  assert.equal(await editor.accountIdFromSfo(root), 'fedcba9876543210');
});

test('malformed, missing-account and oversized SFO files never invent a current ID', async t => {
  const root = await fixture(t, false), filename = path.join(root, 'A', 'sce_sys/param.sfo');
  const editor = editorWithReads(new Map());
  const junk = Buffer.alloc(0x400); Buffer.from('aabbccddeeff0011', 'hex').copy(junk, 0x1b8);
  const missing = makeSfo('1122334455667788');
  missing.write('OTHER_DATA', missing.indexOf(Buffer.from('ACCOUNT_ID')), 'ascii');
  for (const bytes of [junk, missing, makeSfo('1122334455667788', 'PPSA24003', 0x8000)]) {
    await fs.writeFile(filename, bytes);
    assert.equal(await editor.accountIdFromSfo(root), '');
    assert.equal((await editor.workspaceInfo(root)).accountId, '');
  }
});

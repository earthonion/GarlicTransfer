const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const root = path.join(__dirname, '..');
const CURRENT = '0000000000000001';
const TARGET = '8a7b6c5d4e3f2011';
const OTHER = '1234567890abcdef';
const plain = value => JSON.parse(JSON.stringify(value));
const pause = () => new Promise(resolve => setTimeout(resolve, 10));

// Function Test Waiting
async function until(condition, message, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(message);
    await pause();
  }
}

// Function Test App
async function app(t, remote, selectedId = TARGET, useCurrent = false, storedState = null) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  const info = {
    root: '/app/workspace', titleId: 'PPSA12345', accountId: CURRENT,
    files: [{ path: 'DATA/save.dat', size: 8, protected: false }],
  };
  const state = storedState || { accounts: [{ id: TARGET, name: 'Target account' }, { id: OTHER, name: 'Other account' }], selectedId, displayMode: 'name', useCurrent };
  const calls = { jobs: [], encrypt: [], writes: [], select: [], display: [], add: [], rename: [], closeFlush: null, closeResume: null, chooseInput: 0, releases: [], outputs: [] };
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'electron/index.html'), 'utf8'), {
    url: `file://${path.join(root, 'electron/index.html')}`,
    runScripts: 'dangerously', resources: 'usable', virtualConsole,
    beforeParse(window) {
      window.TextEncoder = TextEncoder;
      window.TextDecoder = TextDecoder;
      window.eval(fs.readFileSync(path.join(__dirname, 'fixtures/cmp_bridge.js'), 'utf8'));
      const loader = require('../electron/skins.cjs');
      const bundled = path.join(root, 'electron/skins');
      window.saveTransfer.getSkins = async () => loader.loadSkins(bundled, '/nonexistent');
      window.saveTransfer.getSkinMascot = async id => loader.getSkinMascot(bundled, '/nonexistent', id);
      window.saveTransfer.openSkinsFolder = async () => '/Skins';
      const getSettings = window.saveTransfer.getSettings;
      window.saveTransfer.getSettings = async () => ({ ...await getSettings(), useRemoteOracle: remote });
      window.saveTransfer.localProfiles = async () => ({ profiles: [] });
      const inventory = {
        root: '/pc/Saves', active: true, warnings: [], users: [{ id: 'unassigned', name: 'Unassigned' }],
        entries: [{ id: 'PPSA12345', owner: 'unassigned', title: 'PPSA12345', name: 'Test Game', localSource: 'pc',
          files: [{ file: 'sdimg_DATA', path: 'PPSA12345/sdimg_DATA', size: 4096, sha256: '' }] }],
      };
      window.saveTransfer.localPcState = async () => ({ root: inventory.root, active: true, warnings: [] });
      window.saveTransfer.localPcInventory = async () => plain(inventory);
      window.saveTransfer.setLocalPcActive = async () => {};
      window.saveTransfer.importLocalSave = async value => {
        window.cmpFixture.calls.imports.push(plain(value));
        return { backup: '/app/backups/original-save' };
      };
      window.saveEditor.localFile = async () => ['/pc/Saves/PPSA12345/sdimg_DATA'];
      window.saveEditor.chooseInput = async () => { calls.chooseInput++; return ['/external/sdimg_DATA']; };
      window.saveEditor.chooseOutput = async value => { calls.outputs.push(value); return '/exports/result.zip'; };
      window.saveEditor.run = async value => {
        calls.jobs.push(plain(value));
        return value.operation === 'decrypt'
          ? { operation: 'decrypt', workspace: info.root, archivePath: '/app/decrypted.zip', info: plain(info), temporaryId: 'workspace-1' }
          : { operation: value.operation, output: '/exports/result.zip' };
      };
      window.saveEditor.encryptLocal = async value => {
        calls.encrypt.push(plain(value));
        return { output: '/app/encrypted/sdimg_DATA', temporaryId: 'encrypted-1' };
      };
      window.saveEditor.read = async () => ({ data: Buffer.from('save data').toString('base64') });
      window.saveEditor.write = async value => { calls.writes.push(plain(value)); return plain(info); };
      window.saveEditor.releaseTemporary = async id => { calls.releases.push(id); return true; };
      window.saveAccounts = {
        onBeforeClose: (flush, resume) => { calls.closeFlush = flush; calls.closeResume = resume; return () => {}; },
        getState: async () => plain(state),
        select: async id => { calls.select.push(id); state.selectedId = id; return plain(state); },
        setUseCurrent: async value => { state.useCurrent = value; return plain(state); },
        setDisplayMode: async mode => { calls.display.push(mode); state.displayMode = mode; return plain(state); },
        add: async (id, name = '') => { calls.add.push({ id, name }); if (!state.accounts.some(account => account.id === id)) state.accounts.push({ id, name }); return plain(state); },
        rename: async (id, name) => { calls.rename.push({ id, name }); state.accounts.find(account => account.id === id).name = name; return plain(state); },
        remove: async id => { state.accounts = state.accounts.filter(account => account.id !== id); if (state.selectedId === id) state.selectedId = ''; return plain(state); },
      };
    },
  });
  t.after(() => dom.window.close());
  await new Promise(resolve => dom.window.addEventListener('load', resolve, { once: true }));
  const document = dom.window.document;
  await until(() => document.querySelector(`#targetAccountSelect option[value="${TARGET}"]`), 'Saved account selector did not load');
  document.querySelector('[data-page="library"]').click();
  await until(() => document.querySelector('#cmpLibraryTree .cmp-file-open'), 'Local PC file did not load');
  const idle = () => until(() => !document.getElementById('refreshMySavesBtn').disabled, 'Save action did not finish');
  async function selectAndDecrypt() {
    document.querySelector('#cmpLibraryTree .cmp-file-open').click();
    await until(() => !document.getElementById('selectedSavePanel').hidden, 'PC save was not selected');
    document.getElementById('mySaveDecryptBtn').click();
    await until(() => document.querySelector('.wizard-panel[data-wizard="2"]').classList.contains('active'), 'Decrypted workspace did not open');
    await idle();
  }
  return { dom, window: dom.window, document, state, calls, errors, info, idle, selectAndDecrypt };
}

for (const remote of [false, true]) {
  test(`saved target reaches Save & encrypt and resign in ${remote ? 'remote' : 'local'} worker mode`, async t => {
    const f = await app(t, remote);
    const { document, calls, window } = f;
    await f.selectAndDecrypt();
    assert.equal(document.getElementById('workspaceAccountId').textContent.includes(CURRENT), true);
    assert.equal(document.getElementById('encryptAccountId').value, TARGET);
    assert.equal(document.getElementById('targetAccountSelect').value, TARGET);

    openWorkspaceLeaf(f, document.querySelector('#workspaceFiles tr[data-file-path]'));
    await until(() => !document.getElementById('fileEditorPanel').hidden, 'Workspace editor did not open');
    await f.idle();
    assert.equal(document.getElementById('encryptAccountId').value, TARGET, 'File refresh restored the source account over the selected target');
    const editor = document.getElementById('fileEditor');
    chooseEditorMode(f, 'text');
    editor.value = 'edited save'; editor.dispatchEvent(new window.Event('input'));
    document.getElementById('saveEncryptFileBtn').click();
    await until(() => calls.encrypt.length === 1, 'Save & encrypt did not run');
    await f.idle();
    assert.equal(calls.writes.length, 1);
    assert.equal(calls.encrypt[0].accountId, TARGET);
    assert.equal(calls.encrypt[0].useRemoteOracle, remote);
    assert.equal(window.cmpFixture.calls.imports.length, 1);

    document.getElementById('mySaveResignBtn').click();
    assert.equal(document.getElementById('resignAccountId').value, TARGET);
    document.getElementById('confirmResignBtn').click();
    await until(() => calls.jobs.some(job => job.operation === 'resign'), 'Resign did not run');
    await f.idle();
    const resigned = calls.jobs.find(job => job.operation === 'resign');
    assert.equal(resigned.accountId, TARGET);
    assert.equal(resigned.useRemoteOracle, remote);
    assert.deepEqual(resigned.inputs, ['/pc/Saves/PPSA12345/sdimg_DATA']);
    assert.deepEqual(f.errors, []);
  });
}

test('rebased library search preserves the editor draft, account target and ReRegion export', async t => {
  const f = await app(t, false);
  const { document, window, calls, state, info } = f;
  info.gameName = 'Resolved Test Game';
  const search = document.getElementById('mySavesSearch');
  search.value = 'no matching save';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(document.querySelector('#cmpLibraryTree .cmp-file-open'), null);
  assert.match(document.getElementById('mySavesSearchCount').textContent, /0 of 1 saves/);
  search.value = 'TEST ppsa12345 sdimg_DATA';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(document.querySelectorAll('#cmpLibraryTree .cmp-file-open').length, 1);
  assert.match(document.getElementById('mySavesSearchCount').textContent, /1 of 1 saves/);
  await f.selectAndDecrypt();
  const summary = document.getElementById('workspaceSummary');
  assert.match(summary.textContent.replace(/\s+/g, ' '), /1 save.*1 file.*Current account.*PPSA12345.*Resolved Test Game/i);
  assert.equal(document.getElementById('workspaceAccountId').textContent, CURRENT);
  assert.equal(document.getElementById('addCurrentAccountBtn').hidden, false);
  assert.equal(document.getElementById('addCurrentAccountBtn').disabled, false);

  const selector = document.getElementById('targetAccountSelect');
  selector.value = OTHER;
  selector.dispatchEvent(new window.Event('change', { bubbles: true }));
  await until(() => state.selectedId === OTHER && document.getElementById('encryptAccountId').value === OTHER,
    'The selected account did not reach the editor');
  document.getElementById('reRegionBtn').click();
  await until(() => document.getElementById('reRegionDialog').open, 'ReRegion did not open after searching');
  document.getElementById('targetTitleId').value = 'ppsa54321';
  document.getElementById('reRegionForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(document.getElementById('reRegionDialog').open, false);
  assert.match(document.getElementById('workspaceTargetTitle').textContent, /PPSA54321/);

  openWorkspaceLeaf(f, 'DATA/save.dat');
  await until(() => document.getElementById('fileEditorDialog').open, 'The matched save editor did not open');
  await f.idle();
  const editor = document.getElementById('fileEditor');
  chooseEditorMode(f, 'text');
  const draft = 'rebased search draft';
  editor.value = draft;
  editor.dispatchEvent(new window.Event('input', { bubbles: true }));
  search.value = 'no matching save';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(document.querySelector('#cmpLibraryTree .cmp-file-open'), null);
  assert.equal(document.getElementById('fileEditorDialog').open, true);
  assert.equal(editor.value, draft);
  assert.match(document.getElementById('saveFileBtn').textContent, /\*/);
  search.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(search.value, '');
  assert.equal(document.querySelectorAll('#cmpLibraryTree .cmp-file-open').length, 1);
  assert.equal(document.getElementById('mySavesSearchCount').hidden, true);
  assert.equal(editor.value, draft);
  assert.equal(selector.value, OTHER);
  assert.equal(document.getElementById('targetTitleId').value, 'PPSA54321');

  document.getElementById('saveEncryptFileBtn').click();
  await until(() => calls.jobs.some(job => job.operation === 'encrypt'), 'The edited PPSA copy was not exported');
  await f.idle();
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].path, 'DATA/save.dat');
  assert.equal(Buffer.from(calls.writes[0].data, 'base64').toString('utf8'), draft);
  const encrypted = calls.jobs.find(job => job.operation === 'encrypt');
  assert.equal(encrypted.accountId, OTHER);
  assert.equal(encrypted.targetTitleId, 'PPSA54321');
  assert.equal(encrypted.useRemoteOracle, false);
  assert.equal(calls.encrypt.length, 0);
  assert.equal(window.cmpFixture.calls.imports.length, 0);
  assert.deepEqual(f.errors, []);
});

test('display labels and target changes keep external encryption account bytes exact', async t => {
  const f = await app(t, true);
  const { document, calls, window, state } = f;
  await f.selectAndDecrypt();
  const selector = document.getElementById('targetAccountSelect');
  selector.value = OTHER; selector.dispatchEvent(new window.Event('change'));
  await until(() => state.selectedId === OTHER && document.getElementById('encryptAccountId').value === OTHER, 'Changing target did not update encryption');
  const display = document.getElementById('savedAccountDisplay');
  display.value = 'id'; display.dispatchEvent(new window.Event('change'));
  await until(() => selector.options[selector.selectedIndex].textContent.includes(OTHER), 'Account ID display did not update');
  assert.equal(selector.value, OTHER);

  document.getElementById('decryptExternalBtn').click();
  await until(() => calls.jobs.filter(job => job.operation === 'decrypt').length === 2, 'External save did not decrypt');
  await f.idle();
  document.getElementById('encryptSaveBtn').click();
  await until(() => calls.jobs.some(job => job.operation === 'encrypt'), 'External encryption did not run');
  await f.idle();
  assert.equal(calls.jobs.find(job => job.operation === 'encrypt').accountId, OTHER);
  assert.equal(document.getElementById('workspaceAccountId').textContent.includes(CURRENT), true);
  assert.deepEqual(f.errors, []);
});

test('Use current ID keeps source ownership for encryption and blocks a resign job', async t => {
  const f = await app(t, false, TARGET, true);
  const { document, calls } = f;
  await f.selectAndDecrypt();
  assert.equal(document.getElementById('useCurrentAccountId').checked, true);
  assert.equal(document.getElementById('targetAccountSelect').disabled, true);
  assert.equal(document.getElementById('encryptAccountId').value, CURRENT);
  document.getElementById('encryptSaveBtn').click();
  await until(() => calls.encrypt.length === 1, 'Source-account encryption did not run');
  await f.idle();
  assert.equal(calls.encrypt[0].accountId, CURRENT);
  document.getElementById('mySaveResignBtn').click();
  document.getElementById('resignAccountId').value = TARGET;
  document.getElementById('confirmResignBtn').click();
  await f.idle();
  assert.equal(calls.jobs.some(job => job.operation === 'resign'), false);
  assert.deepEqual(f.errors, []);
});

test('local PPSA encryption exports a new ZIP without replacing the original save', async t => {
  const f = await app(t, false, TARGET, true);
  const { document, calls, window } = f;
  await f.selectAndDecrypt();
  const target = document.getElementById('targetTitleId');
  assert.equal(target.disabled, false);
  target.value = 'ppsa54321';
  document.getElementById('encryptSaveBtn').click();
  await until(() => calls.jobs.some(job => job.operation === 'encrypt'), 'PPSA encryption did not run');
  await f.idle();
  const encrypted = calls.jobs.find(job => job.operation === 'encrypt');
  assert.equal(encrypted.targetTitleId, 'PPSA54321');
  assert.equal(encrypted.accountId, CURRENT);
  assert.equal(encrypted.useRemoteOracle, false);
  assert.deepEqual(calls.outputs, ['PPSA54321-encrypted.zip']);
  assert.equal(calls.encrypt.length, 0);
  assert.equal(window.cmpFixture.calls.imports.length, 0);
  assert.match(document.getElementById('mySavesStatus').textContent, /Add it under PPSA54321/);
  document.getElementById('uploadEncryptedBtn').click();
  await pause();
  assert.equal(window.cmpFixture.calls.uploads.length, 0);
  assert.match(document.getElementById('mySavesStatus').textContent, /add it under its target PPSA/);
  assert.deepEqual(f.errors, []);
});

// Function Batch Fixture
function batchWorkspace(info, { sameTitle = false, sameAccount = false } = {}) {
  info.saves = Array.from({ length: 5 }, (_, index) => ({
    root: `${info.root}/sdimg_slot${index + 1}`,
    label: `sdimg_slot${index + 1}`,
    titleId: sameTitle || index === 0 ? 'PPSA12345' : 'PPSA54321',
    accountId: sameAccount || index === 0 ? CURRENT : OTHER,
    encryptedName: `sdimg_slot${index + 1}`,
  }));
  info.saveCount = info.saves.length;
  info.files = info.saves.map(save => ({ path: `${save.label}/save.dat`, size: 8, protected: false }));
}

for (const useCurrent of [true, false]) {
  test(`batch encryption exports every save and ${useCurrent ? 'keeps each source account' : 'uses the selected target account'}`, async t => {
    const f = await app(t, false, TARGET, useCurrent);
    const { document, calls, window, info } = f;
    batchWorkspace(info);
    await f.selectAndDecrypt();
    assert.match(document.getElementById('workspaceSummary').textContent.replace(/\s+/g, ' '), /5 saves.*Multiple PPSAs/);
    assert.equal(document.getElementById('workspaceAccountId').hidden, true);
    assert.equal(document.getElementById('workspaceBatchAccountId').hidden, false);
    assert.equal(document.getElementById('encryptSaveBtn').textContent, 'Encrypt all 5 saves');
    assert.equal(document.getElementById('encryptAccountId').value, useCurrent ? '' : TARGET);
    document.getElementById('targetTitleId').value = 'PPSA12345';
    document.getElementById('encryptSaveBtn').click();
    await until(() => calls.jobs.some(job => job.operation === 'encrypt'), 'Batch encryption did not run');
    await f.idle();
    const encrypted = calls.jobs.find(job => job.operation === 'encrypt');
    assert.equal(encrypted.useCurrentAccount, useCurrent);
    assert.equal(encrypted.accountId, useCurrent ? '' : TARGET);
    assert.equal(encrypted.targetTitleId, 'PPSA12345', 'A target equal to only the first save must still be submitted');
    assert.equal(encrypted.workspace, info.root);
    assert.deepEqual(calls.outputs, ['PPSA12345-5-saves-encrypted.zip']);
    assert.equal(calls.encrypt.length, 0, 'A batch must not use the original-save replacement path');
    assert.equal(window.cmpFixture.calls.imports.length, 0);
    assert.match(document.getElementById('mySavesStatus').textContent, /5 encrypted saves exported/);
    document.getElementById('uploadEncryptedBtn').click();
    await pause();
    assert.equal(window.cmpFixture.calls.uploads.length, 0);
    assert.match(document.getElementById('mySavesStatus').textContent, /Extract the encrypted batch ZIP/);
    assert.deepEqual(f.errors, []);
  });
}

test('an unchanged PPSA across all batch saves exports a bundle without a title-change field', async t => {
  const f = await app(t, false, TARGET, true);
  const { document, calls, info } = f;
  batchWorkspace(info, { sameTitle: true, sameAccount: true });
  await f.selectAndDecrypt();
  assert.equal(document.getElementById('workspaceAccountId').hidden, false);
  assert.equal(document.getElementById('workspaceBatchAccountId').hidden, true);
  assert.equal(document.getElementById('encryptAccountId').value, CURRENT);
  document.getElementById('targetTitleId').value = 'PPSA12345';
  document.getElementById('encryptSaveBtn').click();
  await until(() => calls.jobs.some(job => job.operation === 'encrypt'), 'Unchanged batch encryption did not run');
  await f.idle();
  const encrypted = calls.jobs.find(job => job.operation === 'encrypt');
  assert.equal(Object.hasOwn(encrypted, 'targetTitleId'), false);
  assert.equal(encrypted.useCurrentAccount, true);
  assert.equal(calls.encrypt.length, 0);
  assert.deepEqual(calls.outputs, ['5-saves-encrypted.zip']);
  assert.deepEqual(f.errors, []);
});

test('batch encryption explains that the local worker is required before choosing an output', async t => {
  const f = await app(t, true, TARGET, true);
  const { document, calls, info } = f;
  batchWorkspace(info);
  await f.selectAndDecrypt();
  document.getElementById('encryptSaveBtn').click();
  await f.idle();
  assert.match(document.getElementById('mySavesStatus').textContent, /local worker.*batch/i);
  assert.equal(calls.jobs.some(job => job.operation === 'encrypt'), false);
  assert.equal(calls.encrypt.length, 0);
  assert.deepEqual(calls.outputs, []);
  assert.deepEqual(f.errors, []);
});

test('invalid PPSA prevents encryption and an unchanged PPSA preserves the normal workflow', async t => {
  const f = await app(t, false);
  const { document, calls, window } = f;
  await f.selectAndDecrypt();
  document.getElementById('targetTitleId').value = 'PPSA1234X';
  document.getElementById('encryptSaveBtn').click();
  await f.idle();
  assert.match(document.getElementById('mySavesStatus').textContent, /PPSA followed by five digits/);
  assert.equal(calls.encrypt.length, 0);
  assert.equal(calls.jobs.some(job => job.operation === 'encrypt'), false);
  assert.deepEqual(calls.outputs, []);
  document.getElementById('targetTitleId').value = 'PPSA12345';
  document.getElementById('encryptSaveBtn').click();
  await until(() => calls.encrypt.length === 1, 'Unchanged PPSA encryption did not run');
  await f.idle();
  assert.equal(Object.hasOwn(calls.encrypt[0], 'targetTitleId'), false);
  assert.equal(window.cmpFixture.calls.imports.length, 1);
  assert.deepEqual(f.errors, []);
});

test('remote mode disables PPSA changes and never submits a stale local target', async t => {
  const f = await app(t, false);
  const { document, calls, window } = f;
  await f.selectAndDecrypt();
  const target = document.getElementById('targetTitleId');
  target.value = 'PPSA54321';
  const remote = document.getElementById('useRemoteOracle');
  remote.checked = true;
  remote.dispatchEvent(new window.Event('change'));
  assert.equal(target.disabled, true);
  assert.equal(target.value, '');
  target.value = 'PPSA54321';
  document.getElementById('encryptSaveBtn').click();
  await until(() => calls.encrypt.length === 1, 'Remote encryption did not run');
  await f.idle();
  assert.equal(calls.encrypt[0].useRemoteOracle, true);
  assert.equal(Object.hasOwn(calls.encrypt[0], 'targetTitleId'), false);
  assert.equal(calls.jobs.some(job => job.operation === 'encrypt'), false);
  assert.deepEqual(f.errors, []);
});

test('PPSA resign keeps the current account only after that save has been decrypted', async t => {
  const f = await app(t, false, TARGET, true);
  const { document, calls } = f;
  document.querySelector('#cmpLibraryTree .cmp-file-open').click();
  await until(() => !document.getElementById('selectedSavePanel').hidden, 'PC save was not selected');
  document.getElementById('targetTitleId').value = 'PPSA54321';
  document.getElementById('mySaveResignBtn').click();
  document.getElementById('confirmResignBtn').click();
  await f.idle();
  assert.equal(calls.jobs.some(job => job.operation === 'resign'), false);
  assert.match(document.getElementById('mySavesStatus').textContent, /Decrypt this save first/);
  await f.selectAndDecrypt();
  assert.equal(document.getElementById('targetTitleId').value, '');
  document.getElementById('targetTitleId').value = 'PPSA54321';
  document.getElementById('mySaveResignBtn').click();
  document.getElementById('confirmResignBtn').click();
  await until(() => calls.jobs.some(job => job.operation === 'resign'), 'PPSA resign did not run');
  await f.idle();
  const resigned = calls.jobs.find(job => job.operation === 'resign');
  assert.equal(resigned.targetTitleId, 'PPSA54321');
  assert.equal(resigned.accountId, CURRENT);
  assert.deepEqual(calls.outputs, ['PPSA54321-sdimg_DATA-resigned.zip']);
  assert.deepEqual(f.errors, []);
});

test('opening another workspace clears a prior PPSA target', async t => {
  const f = await app(t, false);
  const { document, calls } = f;
  await f.selectAndDecrypt();
  document.getElementById('targetTitleId').value = 'PPSA54321';
  document.getElementById('decryptExternalBtn').click();
  await until(() => calls.jobs.filter(job => job.operation === 'decrypt').length === 2, 'Another workspace did not open');
  await f.idle();
  assert.equal(document.getElementById('targetTitleId').value, '');
  assert.deepEqual(f.errors, []);
});

test('unchecking Use current ID enables the remembered target for subsequent saves', async t => {
  const f = await app(t, false, TARGET, true);
  const { document, calls, window, state } = f;
  await f.selectAndDecrypt();
  const checkbox = document.getElementById('useCurrentAccountId');
  checkbox.checked = false; checkbox.dispatchEvent(new window.Event('change'));
  await until(() => !state.useCurrent && !document.getElementById('targetAccountSelect').disabled
    && document.getElementById('encryptAccountId').value === TARGET, 'Saved target did not become active');
  document.getElementById('encryptSaveBtn').click();
  await until(() => calls.encrypt.length === 1, 'Target-account encryption did not run');
  await f.idle();
  assert.equal(calls.encrypt[0].accountId, TARGET);
  assert.deepEqual(f.errors, []);
});

test('an empty saved target allows manual Account ID entry when Use current ID is off', async t => {
  const f = await app(t, false, '', false);
  const { document, calls } = f;
  await f.selectAndDecrypt();
  document.getElementById('encryptAccountId').value = OTHER;
  document.getElementById('encryptSaveBtn').click();
  await until(() => calls.encrypt.length === 1, 'Manual encryption did not run');
  await f.idle();
  assert.equal(calls.encrypt[0].accountId, OTHER);
  assert.equal(document.getElementById('targetAccountSelect').value, '');
  assert.deepEqual(f.errors, []);
});

test('a saved target can be selected for resigning before decrypting a PC save', async t => {
  const f = await app(t, false, TARGET, true);
  const { document, calls, state, window } = f;
  document.querySelector('#cmpLibraryTree .cmp-file-open').click();
  await until(() => !document.getElementById('selectedSavePanel').hidden, 'PC save was not selected');
  assert.equal(document.getElementById('workspaceAccountControls').closest('#selectedSavePanel'), document.getElementById('selectedSavePanel'));
  assert.equal(document.querySelector('.wizard-panel[data-wizard="2"]').classList.contains('active'), false);
  const current = document.getElementById('useCurrentAccountId');
  assert.equal(current.checked, true);
  current.checked = false; current.dispatchEvent(new window.Event('change'));
  const selector = document.getElementById('targetAccountSelect');
  await until(() => !state.useCurrent && !selector.disabled, 'Target selector did not become available');
  selector.value = OTHER; selector.dispatchEvent(new window.Event('change'));
  await until(() => state.selectedId === OTHER && document.getElementById('resignAccountId').value === OTHER, 'Selected account did not reach resign input');
  document.getElementById('mySaveResignBtn').click();
  document.getElementById('confirmResignBtn').click();
  await until(() => calls.jobs.some(job => job.operation === 'resign'), 'Resign did not run');
  await f.idle();
  assert.equal(calls.jobs.some(job => job.operation === 'decrypt'), false);
  assert.equal(calls.jobs.find(job => job.operation === 'resign').accountId, OTHER);
  assert.equal(document.querySelector('.wizard-panel[data-wizard="2"]').classList.contains('active'), false);
  assert.deepEqual(f.errors, []);
});

for (const action of ['encrypt', 'resign']) {
  for (const succeeds of [true, false]) {
    test(`${action} waits for a pending target selection and ${succeeds ? 'uses its committed ID' : 'stops after persistence fails'}`, async t => {
      const f = await app(t, false);
      const { document, window, calls, state } = f;
      await f.selectAndDecrypt();
      if (action === 'resign') document.getElementById('mySaveResignBtn').click();
      let finishSelection;
      window.saveAccounts.select = id => {
        calls.select.push(id);
        return new Promise((resolve, reject) => {
          finishSelection = () => {
            if (!succeeds) { reject(new Error('Test account write failed')); return; }
            state.selectedId = id;
            resolve(plain(state));
          };
        });
      };
      const selector = document.getElementById('targetAccountSelect');
      selector.value = OTHER; selector.dispatchEvent(new window.Event('change'));
      await until(() => typeof finishSelection === 'function', 'Target persistence did not start');
      document.getElementById(action === 'encrypt' ? 'encryptSaveBtn' : 'confirmResignBtn').click();
      await pause(); await pause();
      assert.equal(calls.encrypt.length, 0, 'Encryption must not use the previously selected ID');
      assert.equal(calls.jobs.some(job => job.operation === 'resign'), false, 'Resign must not use the previously selected ID');
      finishSelection();
      if (succeeds) {
        await until(() => action === 'encrypt' ? calls.encrypt.length === 1 : calls.jobs.some(job => job.operation === 'resign'), 'Save action did not resume after target persistence');
        const job = action === 'encrypt' ? calls.encrypt[0] : calls.jobs.find(job => job.operation === 'resign');
        assert.equal(job.accountId, OTHER);
      } else {
        await until(() => document.getElementById('savedAccountStatus').textContent.includes('Test account write failed'), 'Account failure was not shown');
        assert.equal(state.selectedId, TARGET);
      }
      await f.idle();
      assert.equal(calls.encrypt.length, succeeds && action === 'encrypt' ? 1 : 0);
      assert.equal(calls.jobs.filter(job => job.operation === 'resign').length, succeeds && action === 'resign' ? 1 : 0);
      assert.deepEqual(f.errors, []);
    });
  }
}

test('a manual target survives workspace file changes and resets for a new workspace', async t => {
  const f = await app(t, false, '', false);
  const { document, window, calls } = f;
  await f.selectAndDecrypt();
  const target = document.getElementById('encryptAccountId');
  target.value = OTHER;
  openWorkspaceLeaf(f, document.querySelector('#workspaceFiles tr[data-file-path]'));
  await until(() => !document.getElementById('fileEditorPanel').hidden, 'Workspace editor did not open');
  await f.idle();
  assert.equal(target.value, OTHER, 'Opening a file discarded the manual target');
  const editor = document.getElementById('fileEditor');
  chooseEditorMode(f, 'text');
  editor.value = 'edited bytes'; editor.dispatchEvent(new window.Event('input'));
  document.getElementById('saveFileBtn').click();
  await until(() => calls.writes.length === 1, 'File changes did not save');
  await f.idle();
  assert.equal(target.value, OTHER, 'Saving a file discarded the manual target');

  const base = { root: '/app/workspace', titleId: 'PPSA12345', accountId: CURRENT,
    files: [{ path: 'DATA/save.dat', size: 8, protected: false }] };
  window.saveEditor.add = async () => ({ ...base, files: [...base.files, { path: 'added.dat', size: 8, protected: false }] });
  document.getElementById('addFilesBtn').click();
  await until(() => document.querySelectorAll('#workspaceFiles tr[data-file-path]').length === 2, 'Added file did not refresh the workspace');
  await f.idle();
  assert.equal(target.value, OTHER, 'Adding a file discarded the manual target');
  openWorkspaceLeaf(f, [...document.querySelectorAll('#workspaceFiles tr[data-file-path]')].find(row => row.textContent.includes('added.dat')));
  await f.idle();
  window.saveEditor.delete = async () => plain(base);
  document.getElementById('deleteFileBtn').click();
  await until(() => document.querySelectorAll('#workspaceFiles tr[data-file-path]').length === 1, 'Deleted file did not refresh the workspace');
  await f.idle();
  assert.equal(target.value, OTHER, 'Deleting a file discarded the manual target');
  document.getElementById('encryptSaveBtn').click();
  await until(() => calls.encrypt.length === 1, 'Manual target encryption did not run');
  await f.idle();
  assert.equal(calls.encrypt[0].accountId, OTHER);

  const run = window.saveEditor.run;
  window.saveEditor.run = async options => {
    const result = await run(options);
    return options.operation === 'decrypt'
      ? { ...result, workspace: '/app/next-workspace', info: { ...result.info, root: '/app/next-workspace' } }
      : result;
  };
  document.getElementById('decryptExternalBtn').click();
  await until(() => calls.jobs.filter(job => job.operation === 'decrypt').length === 2, 'Another save did not decrypt');
  await f.idle();
  assert.equal(target.value, CURRENT, 'A manual target from the previous workspace leaked into a new save');
  assert.deepEqual(f.errors, []);
});

// Function Test Settings
async function openAccountSettings(f) {
  f.document.querySelector('[data-page="settings"]').click();
  const details = f.document.getElementById('accountListDetails');
  if (!details.open) details.querySelector('summary').click();
  await until(() => !f.document.getElementById('settingsPage').hidden && details.open, 'Saved accounts Settings did not open');
  return details;
}

// Function Test Name Guard
function enforceUniqueNames(f) {
  const key = value => String(value || '').trim().toLowerCase();
  const available = (id, name) => {
    const normalized = key(name);
    if (normalized && f.state.accounts.some(account => account.id !== id && key(account.name) === normalized)) {
      throw new Error('Name already in use.');
    }
  };
  const add = f.window.saveAccounts.add;
  const rename = f.window.saveAccounts.rename;
  f.window.saveAccounts.add = async (id, name) => { available(id, name); return add(id, name.trim()); };
  f.window.saveAccounts.rename = async (id, name) => { available(id, name); return rename(id, name.trim()); };
}

for (const useCurrent of [false, true]) {
  test(`Add current ID asks for a name and Settings editing persists while Use current ID is ${useCurrent ? 'on' : 'off'}`, async t => {
    const f = await app(t, false, TARGET, useCurrent);
    const { document, state, calls, window } = f;
    await f.selectAndDecrypt();
    document.getElementById('addCurrentAccountBtn').click();
    const dialog = document.getElementById('accountNameDialog');
    await until(() => dialog.open, 'Add account name dialog did not open');
    const name = document.getElementById('accountNameInput');
    assert.equal(document.getElementById('accountNameId').textContent, CURRENT);
    assert.equal(name.value, '');
    assert.equal(name.disabled, false);
    assert.equal(name.readOnly, false);
    assert.equal(document.activeElement, name);
    assert.equal(state.accounts.some(account => account.id === CURRENT), false, 'Opening the name dialog must not create an unnamed account');
    name.value = 'Main PS5'; name.dispatchEvent(new window.Event('input', { bubbles: true }));
    document.getElementById('accountNameSaveBtn').click();
    await until(() => !dialog.open && state.accounts.some(account => account.id === CURRENT), 'Named account did not save');
    assert.deepEqual(calls.add, [{ id: CURRENT, name: 'Main PS5' }]);
    assert.equal(document.getElementById('workspaceAccountId').textContent, 'Main PS5');
    assert.ok(document.getElementById('workspaceAccountId').title.includes(CURRENT));
    assert.equal(state.selectedId, TARGET);
    assert.equal(state.useCurrent, useCurrent);

    await openAccountSettings(f);
    const inline = document.querySelector(`#savedAccountRows input[data-account-id="${CURRENT}"]`);
    assert.ok(inline);
    assert.equal(inline.value, 'Main PS5');
    assert.equal(inline.disabled, false);
    assert.equal(inline.readOnly, false);
    assert.ok(inline.tabIndex >= 0);
    inline.click(); inline.focus();
    assert.equal(document.activeElement, inline);
    inline.value = 'Renamed PS5'; inline.dispatchEvent(new window.Event('input', { bubbles: true }));
    inline.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await until(() => state.accounts.find(account => account.id === CURRENT)?.name === 'Renamed PS5'
      && document.getElementById('workspaceAccountId').textContent === 'Renamed PS5', 'Settings Enter rename did not persist');
    await until(() => !document.querySelector(`#savedAccountRows input[data-account-id="${CURRENT}"]`).disabled, 'Settings names stayed disabled after saving');
    assert.deepEqual(calls.rename, [{ id: CURRENT, name: 'Renamed PS5' }]);
    assert.equal(document.getElementById('workspaceAccountId').textContent, 'Renamed PS5');
    assert.ok(document.getElementById('workspaceAccountId').title.includes(CURRENT));
    assert.equal(state.selectedId, TARGET);
    assert.equal(state.useCurrent, useCurrent);
    assert.equal(document.getElementById('useCurrentAccountId').checked, useCurrent);

    const reloaded = await app(t, false, TARGET, useCurrent, plain(state));
    await reloaded.selectAndDecrypt();
    assert.equal(reloaded.document.getElementById('workspaceAccountId').textContent, 'Renamed PS5');
    assert.ok(reloaded.document.getElementById('workspaceAccountId').title.includes(CURRENT));
    await openAccountSettings(reloaded);
    assert.equal(reloaded.document.querySelector(`#savedAccountRows input[data-account-id="${CURRENT}"]`).value, 'Renamed PS5');
    assert.equal(reloaded.state.selectedId, TARGET);
    assert.equal(reloaded.state.useCurrent, useCurrent);
    document.querySelector('[data-page="library"]').click();
    await f.idle();
    document.getElementById('encryptSaveBtn').click();
    await until(() => calls.encrypt.length === 1, 'Named account encryption did not run');
    await f.idle();
    assert.equal(calls.encrypt[0].accountId, useCurrent ? CURRENT : TARGET, 'A display name changed the submitted Account ID');
    assert.deepEqual(f.errors, []);
    assert.deepEqual(reloaded.errors, []);
  });
}

test('inline Settings typing retains its node, focus and caret while earlier names are saving', async t => {
  const stored = { accounts: [{ id: CURRENT, name: 'Source account' }, { id: TARGET, name: 'Target account' },
    { id: OTHER, name: 'Other account' }], selectedId: TARGET, displayMode: 'name', useCurrent: false };
  const f = await app(t, false, TARGET, false, stored);
  const { document, window, state } = f;
  await f.selectAndDecrypt();
  await openAccountSettings(f);
  assert.equal(document.querySelectorAll('#savedAccountRows button[data-action="edit"]').length, 0);
  const input = document.querySelector(`#savedAccountRows input[data-account-id="${CURRENT}"]`);
  const requested = [];
  const rename = window.saveAccounts.rename;
  window.saveAccounts.rename = (id, name) => new Promise((resolve, reject) => {
    requested.push({ id, name, finish: () => rename(id, name).then(resolve, reject) });
  });
  input.click(); input.focus();
  input.value = 'Source One'; input.setSelectionRange(input.value.length, input.value.length);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await until(() => requested.length === 1, 'First inline name save did not start');
  assert.equal(requested[0].id, CURRENT);
  assert.equal(requested[0].name, 'Source One');
  assert.equal(document.querySelector(`#savedAccountRows input[data-account-id="${CURRENT}"]`), input);
  assert.equal(input.disabled, false);
  assert.equal(input.readOnly, false);
  assert.equal(document.activeElement, input);
  assert.equal(input.selectionStart, 'Source One'.length);

  input.setRangeText(' plus', input.selectionStart, input.selectionEnd, 'end');
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  const draft = input.value;
  const caret = input.selectionStart;
  assert.equal(draft, 'Source One plus');
  assert.equal(document.activeElement, input);
  assert.equal(input.disabled, false);
  requested[0].finish();
  await until(() => requested.length === 2, 'Latest typed name was not queued after the first save');
  assert.equal(document.querySelector(`#savedAccountRows input[data-account-id="${CURRENT}"]`), input);
  assert.equal(input.value, draft, 'An earlier save overwrote the newer typed name');
  assert.equal(document.activeElement, input, 'Refreshing a saved name stole focus');
  assert.equal(input.selectionStart, caret, 'Refreshing a saved name moved the caret');
  assert.equal(input.selectionEnd, caret);
  assert.equal(input.disabled, false);
  assert.equal(requested[1].name, draft);
  requested[1].finish();
  await until(() => state.accounts.find(account => account.id === CURRENT)?.name === draft, 'Latest typed name did not persist');
  await until(() => document.getElementById('workspaceAccountId').textContent === draft, 'Current account label did not refresh');
  assert.equal(document.querySelector(`#savedAccountRows input[data-account-id="${CURRENT}"]`), input);
  assert.equal(document.activeElement, input);
  assert.equal(input.selectionStart, caret);
  assert.equal(input.selectionEnd, caret);
  assert.equal(state.selectedId, TARGET);
  assert.equal(state.useCurrent, false);

  const reloaded = await app(t, false, TARGET, false, plain(state));
  await openAccountSettings(reloaded);
  assert.equal(reloaded.document.querySelector(`#savedAccountRows input[data-account-id="${CURRENT}"]`).value, draft);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(reloaded.errors, []);
});

test('Cancel and Escape leave the account list unchanged, and a failed Add can be retried', async t => {
  const f = await app(t, false);
  const { document, state, calls, window } = f;
  await f.selectAndDecrypt();
  const add = document.getElementById('addCurrentAccountBtn');
  const dialog = document.getElementById('accountNameDialog');
  const input = document.getElementById('accountNameInput');
  add.click(); await until(() => dialog.open, 'Add dialog did not open');
  input.value = 'Canceled name';
  document.getElementById('accountNameCancelBtn').click();
  assert.equal(dialog.open, false);
  assert.equal(calls.add.length, 0);
  assert.equal(state.accounts.some(account => account.id === CURRENT), false);
  add.click(); await until(() => dialog.open, 'Add dialog did not reopen');
  input.value = 'Escape name';
  dialog.dispatchEvent(new window.Event('cancel', { cancelable: true }));
  assert.equal(dialog.open, false);
  assert.equal(calls.add.length, 0);

  const save = window.saveAccounts.add;
  let attempts = 0;
  window.saveAccounts.add = async (...args) => {
    attempts++;
    if (attempts === 1) throw new Error('Test name storage failure');
    return save(...args);
  };
  add.click(); await until(() => dialog.open, 'Retry name dialog did not open');
  input.value = 'Retained name';
  document.getElementById('accountNameSaveBtn').click();
  await until(() => document.getElementById('accountNameError').textContent.includes('Test name storage failure'), 'Name-save error did not appear in the dialog');
  assert.equal(dialog.open, true);
  assert.equal(input.value, 'Retained name');
  assert.equal(state.accounts.some(account => account.id === CURRENT), false);
  assert.equal(document.getElementById('accountNameSaveBtn').disabled, false);
  document.getElementById('accountNameSaveBtn').click();
  await until(() => !dialog.open && state.accounts.some(account => account.id === CURRENT), 'Retry did not create the named account');
  assert.equal(state.accounts.find(account => account.id === CURRENT).name, 'Retained name');
  assert.equal(attempts, 2);
  assert.equal(state.selectedId, TARGET);
  assert.equal(state.useCurrent, false);
  assert.deepEqual(f.errors, []);
});

test('Add rejects a duplicate display name and can retry without changing existing accounts or target IDs', async t => {
  const f = await app(t, false);
  const { document, window, state, calls } = f;
  enforceUniqueNames(f);
  await f.selectAndDecrypt();
  document.getElementById('addCurrentAccountBtn').click();
  const dialog = document.getElementById('accountNameDialog');
  await until(() => dialog.open, 'Add account dialog did not open');
  const name = document.getElementById('accountNameInput');
  name.value = '  tArGeT aCcOuNt  '; name.dispatchEvent(new window.Event('input', { bubbles: true }));
  document.getElementById('accountNameSaveBtn').click();
  await until(() => document.getElementById('accountNameError').textContent.includes('already in use'), 'Duplicate name error did not appear');
  assert.equal(dialog.open, true);
  assert.equal(name.value, '  tArGeT aCcOuNt  ');
  assert.equal(state.accounts.some(account => account.id === CURRENT), false);
  assert.deepEqual(state.accounts, [{ id: TARGET, name: 'Target account' }, { id: OTHER, name: 'Other account' }]);
  assert.equal(state.selectedId, TARGET);
  assert.equal(state.useCurrent, false);
  assert.equal(calls.add.length, 0);
  name.value = 'Personal PS5'; name.dispatchEvent(new window.Event('input', { bubbles: true }));
  document.getElementById('accountNameSaveBtn').click();
  await until(() => !dialog.open && state.accounts.some(account => account.id === CURRENT), 'Retry did not add the unique account name');
  assert.equal(state.accounts.find(account => account.id === CURRENT).name, 'Personal PS5');
  assert.equal(state.accounts.find(account => account.id === TARGET).name, 'Target account');
  assert.equal(state.accounts.find(account => account.id === OTHER).name, 'Other account');
  assert.equal(state.selectedId, TARGET);
  document.getElementById('encryptSaveBtn').click();
  await until(() => calls.encrypt.length === 1, 'Encryption after successful Add retry did not run');
  await f.idle();
  assert.equal(calls.encrypt[0].accountId, TARGET);
  assert.deepEqual(f.errors, []);
});

test('a duplicate inline name retains its draft, lets another row save, and blocks encryption until corrected', async t => {
  const f = await app(t, false);
  const { document, window, state, calls } = f;
  enforceUniqueNames(f);
  await f.selectAndDecrypt();
  await openAccountSettings(f);
  const duplicate = document.querySelector(`#savedAccountRows input[data-account-id="${OTHER}"]`);
  duplicate.focus(); duplicate.value = '  TARGET ACCOUNT  ';
  duplicate.dispatchEvent(new window.Event('input', { bubbles: true }));
  duplicate.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await until(() => duplicate.getAttribute('aria-invalid') === 'true', 'Duplicate rename was not marked invalid');
  assert.equal(duplicate.value, '  TARGET ACCOUNT  ');
  assert.equal(state.accounts.find(account => account.id === OTHER).name, 'Other account');
  assert.equal(state.accounts.find(account => account.id === TARGET).name, 'Target account');
  assert.equal(document.querySelector(`[data-account-error="${OTHER}"]`).textContent.includes('already in use'), true);
  const target = document.querySelector(`#savedAccountRows input[data-account-id="${TARGET}"]`);
  assert.equal(target.disabled, false);
  target.focus(); target.value = 'Updated target';
  target.dispatchEvent(new window.Event('input', { bubbles: true }));
  target.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await until(() => state.accounts.find(account => account.id === TARGET).name === 'Updated target', 'A failed row prevented another row from saving');
  assert.equal(duplicate.value, '  TARGET ACCOUNT  ');
  assert.equal(duplicate.getAttribute('aria-invalid'), 'true');
  assert.equal(state.selectedId, TARGET);

  document.querySelector('[data-page="library"]').click();
  await f.idle();
  document.getElementById('encryptSaveBtn').click();
  await until(() => /already in use|unsaved|failed/i.test(document.getElementById('mySavesStatus').textContent), 'Unsaved duplicate names did not block the save action');
  await f.idle();
  assert.equal(calls.encrypt.length, 0);
  await openAccountSettings(f);
  duplicate.focus(); duplicate.value = 'Second profile';
  duplicate.dispatchEvent(new window.Event('input', { bubbles: true }));
  duplicate.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await until(() => state.accounts.find(account => account.id === OTHER).name === 'Second profile'
    && duplicate.getAttribute('aria-invalid') !== 'true', 'Correcting the duplicate did not persist');
  assert.equal(document.querySelector(`[data-account-error="${OTHER}"]`).textContent, '');
  document.querySelector('[data-page="library"]').click();
  await f.idle();
  document.getElementById('encryptSaveBtn').click();
  await until(() => calls.encrypt.length === 1, 'Encryption did not resume after correcting the name');
  await f.idle();
  assert.equal(calls.encrypt[0].accountId, TARGET);
  assert.equal(state.accounts.find(account => account.id === TARGET).name, 'Updated target');
  assert.equal(state.selectedId, TARGET);
  assert.equal(state.useCurrent, false);
  assert.deepEqual(f.errors, []);
});

test('closing flushes the latest inline name before debounce and freezes it until closing is canceled', async t => {
  const f = await app(t, false);
  const { document, state, calls, window } = f;
  await f.selectAndDecrypt();
  await openAccountSettings(f);
  await until(() => typeof calls.closeFlush === 'function', 'Account close hook was not registered');
  const input = document.querySelector(`#savedAccountRows input[data-account-id="${TARGET}"]`);
  input.focus(); input.value = 'Saved before exit';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(state.accounts.find(account => account.id === TARGET).name, 'Target account');
  await calls.closeFlush();
  assert.equal(state.accounts.find(account => account.id === TARGET).name, 'Saved before exit');
  assert.equal(input.disabled, true, 'A successful close flush must keep names frozen until the close decision');
  assert.equal(document.querySelector(`#savedAccountRows input[data-account-id="${TARGET}"]`), input);
  calls.closeResume();
  assert.equal(input.disabled, false);
  assert.equal(input.value, 'Saved before exit');
  assert.equal(state.selectedId, TARGET);
  assert.equal(state.useCurrent, false);
  assert.deepEqual(f.errors, []);
});

test('closing rejects an unsaved duplicate name and canceled closing preserves the editable draft', async t => {
  const f = await app(t, false);
  const { document, state, calls, window } = f;
  enforceUniqueNames(f);
  await f.selectAndDecrypt();
  await openAccountSettings(f);
  await until(() => typeof calls.closeFlush === 'function', 'Account close hook was not registered');
  const input = document.querySelector(`#savedAccountRows input[data-account-id="${OTHER}"]`);
  input.focus(); input.value = '  target ACCOUNT  ';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await assert.rejects(calls.closeFlush(), /Name already in use/);
  assert.equal(state.accounts.find(account => account.id === OTHER).name, 'Other account');
  assert.equal(input.value, '  target ACCOUNT  ');
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  calls.closeResume();
  assert.equal(input.disabled, false);
  assert.equal(input.readOnly, false);
  assert.equal(input.value, '  target ACCOUNT  ');
  assert.equal(state.selectedId, TARGET);
  assert.equal(state.useCurrent, false);
  assert.deepEqual(f.errors, []);
});

test('canceling a failed close during browsing unlocks names when browsing ends and preserves an active close freeze', async t => {
  const f = await app(t, false);
  const { document, state, calls, window } = f;
  await f.selectAndDecrypt();
  await openAccountSettings(f);
  const input = document.querySelector(`#savedAccountRows input[data-account-id="${TARGET}"]`);
  const rename = window.saveAccounts.rename;
  let failing = true;
  window.saveAccounts.rename = (...args) => {
    if (failing) return Promise.reject(new Error('Test rename storage failed'));
    return rename(...args);
  };
  input.value = 'Unsaved name'; input.dispatchEvent(new window.Event('input', { bubbles: true }));
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await until(() => input.getAttribute('aria-invalid') === 'true', 'Rename failure was not retained');
  window.cmpFixture.emit({ type: 'ready', users: window.cmpFixture.users, message: 'Browse session active' });
  await assert.rejects(calls.closeFlush(), /Test rename storage failed/);
  calls.closeResume();
  assert.equal(input.disabled, true, 'Names must remain disabled while a browse session is active');
  window.cmpFixture.emit({ type: 'done', message: 'Browse session finished' });
  await until(() => !input.disabled, 'Names stayed disabled after browsing and canceled closing finished');
  assert.equal(document.querySelector(`#savedAccountRows input[data-account-id="${TARGET}"]`), input);
  assert.equal(input.value, 'Unsaved name');
  assert.equal(state.accounts.find(account => account.id === TARGET).name, 'Target account');

  failing = false;
  input.value = 'Recovered name'; input.dispatchEvent(new window.Event('input', { bubbles: true }));
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await until(() => state.accounts.find(account => account.id === TARGET).name === 'Recovered name'
    && input.getAttribute('aria-invalid') !== 'true', 'Failed name did not recover');
  await calls.closeFlush();
  assert.equal(input.disabled, true);
  window.cmpFixture.emit({ type: 'ready', users: window.cmpFixture.users, message: 'Browse session active' });
  assert.equal(input.disabled, true);
  window.cmpFixture.emit({ type: 'done', message: 'Browse session finished' });
  assert.equal(input.disabled, true, 'Transfer completion must not release an active close freeze');
  calls.closeResume();
  assert.equal(input.disabled, false);
  assert.equal(input.value, 'Recovered name');
  assert.deepEqual(f.errors, []);
});

test('a late duplicate-name error does not invalidate a newer draft or block encryption', async t => {
  const f = await app(t, false);
  const { document, window, state, calls } = f;
  await f.selectAndDecrypt();
  await openAccountSettings(f);
  const input = document.querySelector(`#savedAccountRows input[data-account-id="${OTHER}"]`);
  const rename = window.saveAccounts.rename;
  let rejectOld;
  let submissions = 0;
  window.saveAccounts.rename = (id, name) => {
    if (submissions++ > 0) return rename(id, name);
    calls.rename.push({ id, name });
    return new Promise((_resolve, reject) => { rejectOld = reject; });
  };
  input.focus(); input.value = 'Target account';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await until(() => typeof rejectOld === 'function', 'The first name save did not start');
  input.value = 'Valid latest name';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  rejectOld(new Error('Name already in use.'));
  await until(() => state.accounts.find(account => account.id === OTHER)?.name === 'Valid latest name'
    && input.getAttribute('aria-invalid') !== 'true', 'A stale error prevented the latest draft from saving');
  assert.equal(document.querySelector(`[data-account-error="${OTHER}"]`).textContent, '');
  assert.equal(input.value, 'Valid latest name');
  assert.equal(document.querySelector(`#savedAccountRows input[data-account-id="${OTHER}"]`), input);
  assert.equal(calls.rename.length, 2);
  document.querySelector('[data-page="library"]').click();
  await f.idle();
  document.getElementById('encryptSaveBtn').click();
  await until(() => calls.encrypt.length === 1, 'A resolved stale name error still blocked encryption');
  await f.idle();
  assert.equal(calls.encrypt[0].accountId, TARGET);
  assert.deepEqual(f.errors, []);
});

test('reverting a pending duplicate name to the saved name clears the stale error and permits closing', async t => {
  const f = await app(t, false);
  const { document, window, state, calls } = f;
  await f.selectAndDecrypt();
  await openAccountSettings(f);
  const input = document.querySelector(`#savedAccountRows input[data-account-id="${OTHER}"]`);
  let rejectOld;
  let submissions = 0;
  window.saveAccounts.rename = () => {
    submissions++;
    return new Promise((_resolve, reject) => { rejectOld = reject; });
  };
  input.value = 'Target account';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await until(() => typeof rejectOld === 'function', 'The pending name save did not start');
  input.value = 'Other account'; input.dispatchEvent(new window.Event('input', { bubbles: true }));
  const closing = calls.closeFlush();
  rejectOld(new Error('Name already in use.'));
  await closing;
  assert.equal(submissions, 1, 'Reverting to the saved value should not submit another rename');
  assert.equal(input.getAttribute('aria-invalid'), null);
  assert.equal(document.querySelector(`[data-account-error="${OTHER}"]`).textContent, '');
  assert.equal(input.value, 'Other account');
  assert.equal(state.accounts.find(account => account.id === OTHER).name, 'Other account');
  assert.equal(input.disabled, true);
  calls.closeResume();
  assert.equal(input.disabled, false);
  assert.deepEqual(f.errors, []);
});

test('pending account close flushing blocks discovery, downloads and uploads until closing resumes', async t => {
  const f = await app(t, false);
  const { document, window, state, calls } = f;
  await f.selectAndDecrypt();
  await openAccountSettings(f);
  const consoleSelect = document.getElementById('consoleSelect');
  const option = document.createElement('option');
  option.value = '192.168.0.42'; option.textContent = 'Test PS5';
  option.dataset.hostId = 'TEST-HOST'; option.dataset.firmware = '13600000';
  consoleSelect.appendChild(option); consoleSelect.value = option.value;
  const uploadDialog = document.getElementById('uploadModal');
  const userSelect = document.getElementById('userSelect');
  const user = document.createElement('option');
  user.value = 'remembered-user'; user.textContent = 'Remembered user';
  userSelect.appendChild(user); userSelect.value = user.value;
  uploadDialog.showModal();
  const started = { discover: 0, download: 0, inventory: 0, upload: 0 };
  for (const name of Object.keys(started)) {
    const original = window.saveTransfer[name];
    window.saveTransfer[name] = async (...args) => { started[name]++; return original(...args); };
  }
  const rename = window.saveAccounts.rename;
  let complete;
  window.saveAccounts.rename = (...args) => new Promise((resolve, reject) => {
    complete = () => Promise.resolve(rename(...args)).then(resolve, reject);
  });
  const input = document.querySelector(`#savedAccountRows input[data-account-id="${TARGET}"]`);
  input.value = 'Name before exit'; input.dispatchEvent(new window.Event('input', { bubbles: true }));
  const closing = calls.closeFlush();
  await until(() => typeof complete === 'function', 'Closing did not flush the pending name');
  for (const id of ['discoverBtn', 'downloadBtn', 'uploadBtn']) {
    const button = document.getElementById(id);
    assert.equal(button.disabled, true, `${id} was enabled during the close flush`);
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  }
  await pause(); await pause();
  assert.deepEqual(started, { discover: 0, download: 0, inventory: 0, upload: 0 }, 'An app action bypassed the pending close guard');
  assert.equal(uploadDialog.open, true, 'Pending closing hid an existing transfer dialog');
  assert.equal(userSelect.value, 'remembered-user');
  complete(); await closing;
  assert.equal(state.accounts.find(account => account.id === TARGET).name, 'Name before exit');
  for (const id of ['discoverBtn', 'downloadBtn', 'uploadBtn']) assert.equal(document.getElementById(id).disabled, true);
  calls.closeResume();
  for (const id of ['discoverBtn', 'downloadBtn', 'uploadBtn']) assert.equal(document.getElementById(id).disabled, false);
  assert.equal(uploadDialog.open, true, 'Canceled closing hid the existing transfer dialog');
  assert.equal(userSelect.value, 'remembered-user', 'Canceled closing discarded the selected destination user');
  document.getElementById('discoverBtn').click();
  await until(() => started.discover === 1, 'Discovery did not become available after canceled closing');
  assert.deepEqual(f.errors, []);
});

// Function Test File Drop
function dropEvent(f, type, files, destination = 'decryptExternalDropZone') {
  const event = new f.window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: {
    files, types: ['Files'], dropEffect: 'none',
    items: files.map(file => ({ kind: 'file', type: file.type, getAsFile: () => file })),
  } });
  (typeof destination === 'string' ? f.document.getElementById(destination) : destination).dispatchEvent(event);
  return event;
}

// Function Test ZIP
function zipFile(f, name = 'save.zip', nativePath = '/external/save.zip') {
  const file = new f.window.File(['encrypted archive'], name, { type: 'application/zip' });
  if (nativePath !== null) Object.defineProperty(file, 'path', { value: nativePath });
  return file;
}

for (const remote of [false, true]) {
  test(`dropping one ${remote ? '.ZIP' : '.zip'} automatically decrypts through the ${remote ? 'remote' : 'local'} worker and keeps target IDs`, async t => {
    const f = await app(t, remote);
    const { document, calls } = f;
    await f.idle();
    const name = remote ? 'My Save.ZIP' : 'My Save.zip';
    const nativePath = `/external/${name}`;
    const files = [zipFile(f, name, nativePath)];
    const zone = document.getElementById('decryptExternalDropZone');
    assert.ok(zone);
    assert.equal(dropEvent(f, 'dragover', files).defaultPrevented, true);
    assert.equal(zone.classList.contains('drag-active'), true);
    assert.equal(dropEvent(f, 'drop', files).defaultPrevented, true);
    await until(() => calls.jobs.some(job => job.operation === 'decrypt'), 'Dropping the ZIP did not start decrypting');
    await f.idle();
    const decrypted = calls.jobs.find(job => job.operation === 'decrypt');
    assert.deepEqual(decrypted.inputs, [nativePath]);
    assert.equal(decrypted.useRemoteOracle, remote);
    assert.equal(decrypted.platform, 'ps5');
    assert.equal(calls.chooseInput, 0);
    assert.deepEqual(calls.writes, [], 'Dropping an archive must not write to its original file');
    assert.deepEqual(calls.releases, [], 'The original archive must not be released as a temporary workspace');
    assert.equal(zone.classList.contains('drag-active'), false);
    assert.equal(document.querySelector('.wizard-panel[data-wizard="2"]').classList.contains('active'), true);
    assert.equal(document.getElementById('selectedSavePanel').hidden, true);
    assert.equal(document.getElementById('workspaceAccountId').textContent, CURRENT);
    assert.equal(document.getElementById('targetAccountSelect').value, TARGET);
    document.getElementById('encryptSaveBtn').click();
    await until(() => calls.jobs.some(job => job.operation === 'encrypt'), 'Dropped workspace could not be encrypted');
    await f.idle();
    const encrypted = calls.jobs.find(job => job.operation === 'encrypt');
    assert.equal(encrypted.accountId, TARGET);
    assert.equal(encrypted.useRemoteOracle, remote);
    assert.equal(calls.encrypt.length, 0, 'An external ZIP must not replace a selected local save');
    assert.deepEqual(calls.writes, []);
    assert.deepEqual(calls.releases, []);
    assert.deepEqual(f.errors, []);
  });
}

for (const invalid of ['multiple', 'non-ZIP', 'missing native path']) {
  test(`an encrypted ZIP drop rejects ${invalid} without opening a chooser or starting a job`, async t => {
    const f = await app(t, false);
    await f.idle();
    const files = invalid === 'multiple' ? [zipFile(f), zipFile(f, 'second.zip', '/external/second.zip')]
      : invalid === 'non-ZIP' ? [zipFile(f, 'save.dat', '/external/save.dat')]
      : [zipFile(f, 'save.zip', null)];
    assert.equal(dropEvent(f, 'drop', files).defaultPrevented, true);
    const message = invalid === 'multiple' ? 'one encrypted save ZIP' : invalid === 'non-ZIP' ? '(.zip)' : 'no local file path';
    await until(() => f.document.getElementById('mySavesStatus').textContent.includes(message), 'Invalid drop did not explain the problem');
    await f.idle();
    assert.equal(f.calls.jobs.length, 0);
    assert.equal(f.calls.chooseInput, 0);
    assert.equal(f.document.getElementById('decryptExternalDropZone').classList.contains('drag-active'), false);
    assert.deepEqual(f.errors, []);
  });
}

test('file drops outside the encrypted ZIP target prevent navigation without decrypting', async t => {
  const f = await app(t, false);
  await f.idle();
  const files = [zipFile(f)];
  assert.equal(dropEvent(f, 'dragover', files, f.document.body).defaultPrevented, true);
  assert.equal(dropEvent(f, 'drop', files, f.document.body).defaultPrevented, true);
  await pause();
  assert.equal(f.calls.jobs.length, 0);
  assert.equal(f.calls.chooseInput, 0);
  assert.deepEqual(f.errors, []);
});

test('a second ZIP drop while decryption is pending starts no additional job', async t => {
  const f = await app(t, false);
  const { window, document, calls } = f;
  await f.idle();
  const run = window.saveEditor.run;
  let release;
  window.saveEditor.run = async options => {
    const result = await run(options);
    await new Promise(resolve => { release = resolve; });
    return result;
  };
  dropEvent(f, 'drop', [zipFile(f)]);
  await until(() => typeof release === 'function', 'First ZIP did not start decrypting');
  assert.equal(dropEvent(f, 'drop', [zipFile(f, 'second.zip', '/external/second.zip')]).defaultPrevented, true);
  await pause();
  assert.equal(calls.jobs.length, 1);
  assert.equal(calls.chooseInput, 0);
  release();
  await f.idle();
  assert.equal(document.getElementById('decryptExternalDropZone').classList.contains('drag-active'), false);
  assert.deepEqual(f.errors, []);
});

test('ZIP drops during pending app close flushing start no decryption', async t => {
  const f = await app(t, false);
  const { window, document, calls, state } = f;
  await f.selectAndDecrypt();
  await openAccountSettings(f);
  const input = document.querySelector(`#savedAccountRows input[data-account-id="${TARGET}"]`);
  const rename = window.saveAccounts.rename;
  let release;
  window.saveAccounts.rename = (...args) => new Promise(resolve => { release = async () => resolve(await rename(...args)); });
  input.value = 'Closing name'; input.dispatchEvent(new window.Event('input', { bubbles: true }));
  const closing = calls.closeFlush();
  await until(() => typeof release === 'function', 'Close flushing did not wait for the edited name');
  assert.equal(dropEvent(f, 'drop', [zipFile(f)]).defaultPrevented, true);
  await pause();
  assert.equal(calls.jobs.filter(job => job.operation === 'decrypt').length, 1);
  assert.equal(calls.chooseInput, 0);
  await release(); await closing;
  assert.equal(state.accounts.find(account => account.id === TARGET).name, 'Closing name');
  calls.closeResume();
  assert.equal(document.getElementById('decryptExternalDropZone').classList.contains('drag-active'), false);
  assert.deepEqual(f.errors, []);
});

test('canceling the ZIP drop discard confirmation keeps the current edited workspace', async t => {
  const f = await app(t, false);
  const { document, window, calls } = f;
  await f.selectAndDecrypt();
  openWorkspaceLeaf(f, document.querySelector('#workspaceFiles tr[data-file-path]'));
  await f.idle();
  const editor = document.getElementById('fileEditor');
  chooseEditorMode(f, 'text');
  editor.value = 'Keep these unsaved edits'; editor.dispatchEvent(new window.Event('input'));
  const prompts = [];
  window.saveTransfer.confirm = async message => { prompts.push(message); return false; };
  dropEvent(f, 'drop', [zipFile(f)]);
  await until(() => prompts.length === 1, 'Dropping another ZIP did not ask before discarding edits');
  await f.idle();
  assert.match(prompts[0], /discard|close/i);
  assert.equal(calls.jobs.filter(job => job.operation === 'decrypt').length, 1);
  assert.equal(editor.value, 'Keep these unsaved edits');
  assert.equal(document.getElementById('workspaceAccountId').textContent, CURRENT);
  assert.equal(document.getElementById('targetAccountSelect').value, TARGET);
  assert.deepEqual(calls.releases, []);
  assert.deepEqual(f.errors, []);
});

test('a failed ZIP drop decryption keeps the old workspace and removes drag highlighting', async t => {
  const f = await app(t, false);
  const { document, window, calls } = f;
  await f.selectAndDecrypt();
  openWorkspaceLeaf(f, document.querySelector('#workspaceFiles tr[data-file-path]'));
  await f.idle();
  const previousText = document.getElementById('fileEditor').value;
  window.saveEditor.run = async options => { calls.jobs.push(plain(options)); throw new Error('Test ZIP decrypt failed'); };
  const files = [zipFile(f)];
  dropEvent(f, 'dragover', files);
  dropEvent(f, 'drop', files);
  await until(() => document.getElementById('mySavesStatus').textContent.includes('Test ZIP decrypt failed'), 'Decryption failure was not reported');
  await f.idle();
  assert.equal(document.getElementById('fileEditor').value, previousText);
  assert.equal(document.getElementById('workspaceAccountId').textContent, CURRENT);
  assert.equal(document.getElementById('decryptExternalDropZone').classList.contains('drag-active'), false);
  assert.deepEqual(calls.releases, []);
  assert.deepEqual(f.errors, []);
});

test('upload instructions close from their button and from normal transfer completion', async t => {
  const f = await app(t, false);
  const { document, window } = f;
  await f.idle();
  const consoleSelect = document.getElementById('consoleSelect');
  const option = document.createElement('option');
  option.value = '192.168.0.42'; option.textContent = 'Test PS5';
  option.dataset.hostId = 'TEST-HOST'; option.dataset.firmware = '13600000';
  consoleSelect.appendChild(option); consoleSelect.value = option.value;
  const pending = [];
  window.saveTransfer.upload = value => new Promise(resolve => {
    window.cmpFixture.calls.uploads.push(plain(value));
    pending.push(resolve);
  });
  const instructions = document.getElementById('uploadModal');
  async function beginUpload() {
    const count = pending.length;
    document.querySelector('[data-page="upload"]').click();
    document.getElementById('uploadBtn').click();
    await until(() => !document.getElementById('confirmUploadBtn').hidden,
      'Preparing upload did not expose the upload selection');
    const entry = document.getElementById('uploadSaveSelect').options[0];
    assert.ok(entry, 'The downloaded fixture save was unavailable for upload');
    entry.selected = true;
    document.getElementById('confirmUploadBtn').click();
    await until(() => pending.length === count + 1 && instructions.open,
      'Starting the upload did not show its instructions');
    assert.equal(document.getElementById('uploadBtn').disabled, true);
  }

  await beginUpload();
  assert.deepEqual(window.cmpFixture.calls.uploads[0].entryIds, [122]);
  document.getElementById('uploadModalCloseBtn').click();
  assert.equal(instructions.open, false);
  pending[0]();
  window.cmpFixture.emit({ type: 'done', message: 'First upload finished.' });
  await until(() => !document.getElementById('uploadBtn').disabled,
    'Completing the first upload did not restore idle controls');

  await beginUpload();
  assert.equal(instructions.open, true);
  window.cmpFixture.emit({ type: 'done', message: 'Second upload finished.' });
  await until(() => !instructions.open && !document.getElementById('uploadBtn').disabled,
    'Normal upload completion did not dismiss its instructions and restore idle controls');
  pending[1]();
  assert.equal(document.getElementById('confirmUploadBtn').hidden, true);
  assert.deepEqual(f.errors, []);
});

// Function Workspace File
function workspaceLeaf(f, path) {
  return [...f.document.querySelectorAll('#workspaceFiles tr[data-file-path]')]
    .find(row => row.dataset.filePath === path);
}

// Function File Opening
function openWorkspaceLeaf(f, selected) {
  const row = typeof selected === 'string' ? workspaceLeaf(f, selected) : selected;
  assert.ok(row, 'The workspace file could not be opened');
  row.click();
  row.dispatchEvent(new f.window.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
}

// Function = Choose Mode
function chooseEditorMode(f, value) {
  const mode = f.document.getElementById('editorMode');
  mode.value = value;
  mode.dispatchEvent(new f.window.Event('change'));
}

// Function Tree Action
async function workspaceAction(f, path, action) {
  const row = workspaceLeaf(f, path);
  assert.ok(row, `The workspace tree is missing ${path}`);
  row.dispatchEvent(new f.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }));
  await until(() => f.document.querySelector(`#workspaceFileContextMenu button[data-action="${action}"]`),
    `The workspace context menu is missing ${action}`);
  const button = f.document.querySelector(`#workspaceFileContextMenu button[data-action="${action}"]`);
  assert.equal(button.disabled, false, `${action} is unavailable for ${path}`);
  button.click();
}

test('the decrypted tree replaces an unopened large nested file at its exact original path', async t => {
  const f = await app(t, false);
  const { document, window, calls, info } = f;
  const path = 'DATA/slot one/save.dat';
  info.files = [
    { path, size: 9 * 1024 * 1024, protected: false },
    { path: 'DATA/slot two/save.dat', size: 8, protected: false },
    { path: 'chives.json', size: 20, protected: true, readOnly: true },
  ];
  const reads = [], replacements = [];
  window.saveEditor.read = window.saveEditor.readPage = async value => { reads.push(plain(value)); throw new Error('Unexpected editor read'); };
  window.saveEditor.replace = async value => {
    replacements.push(plain(value));
    return { ...plain(info), files: info.files.map(file => ({ ...file, size: file.path === path ? 10 * 1024 * 1024 : file.size })) };
  };
  await f.selectAndDecrypt();
  assert.ok(document.querySelector('#workspaceFiles tr[data-folder-path="DATA"]'));
  assert.ok(document.querySelector('#workspaceFiles tr[data-folder-path="DATA/slot one"]'));
  await workspaceAction(f, path, 'replace');
  await until(() => replacements.length === 1, 'Replacing the unopened tree leaf did not reach the bridge');
  await f.idle();
  assert.deepEqual(replacements, [{ root: info.root, path }]);
  assert.deepEqual(reads, [], 'Replacing an unopened file must not try to read it into the editor');
  assert.deepEqual([...document.querySelectorAll('#workspaceFiles tr[data-file-path]')].map(row => row.dataset.filePath).sort(),
    [path, 'DATA/slot two/save.dat', 'chives.json'].sort());
  assert.match(workspaceLeaf(f, path).textContent, /10240/);
  assert.equal(document.getElementById('fileEditorPanel').hidden, true);
  assert.match(document.getElementById('mySavesStatus').textContent, /replaced in the decrypted workspace/);
  const prompts = [];
  window.saveTransfer.confirm = async message => { prompts.push(message); return false; };
  document.getElementById('closeWorkspaceBtn').click(); await f.idle();
  assert.equal(prompts.length, 1, 'A successful replacement must mark the workspace as modified');
  assert.match(prompts[0], /have not been encrypted/);
  assert.ok(workspaceLeaf(f, path));
  window.saveTransfer.confirm = async () => true;
  document.getElementById('encryptSaveBtn').click();
  await until(() => calls.encrypt.length === 1, 'The replaced workspace did not encrypt');
  await f.idle();
  assert.equal(calls.encrypt[0].accountId, TARGET);
  assert.deepEqual(f.errors, []);
});

for (const remote of [false, true]) {
  test(`replacing the current file refreshes its editor and retains the ${remote ? 'remote' : 'local'} encryption target`, async t => {
    const f = await app(t, remote);
    const { document, window, info, calls } = f;
    const replacements = [], reads = [];
    let replaced = false;
    window.saveEditor.read = async value => {
      reads.push(plain(value));
      return { data: Buffer.from(replaced ? 'replacement content' : 'original content').toString('base64') };
    };
    window.saveEditor.replace = async value => {
      replacements.push(plain(value)); replaced = true;
      return { ...plain(info), files: info.files.map(file => ({ ...file, size: 19 })) };
    };
    await f.selectAndDecrypt();
    openWorkspaceLeaf(f, 'DATA/save.dat'); await f.idle();
    const editor = document.getElementById('fileEditor');
    chooseEditorMode(f, 'text');
    editor.value = 'unsaved current content'; editor.dispatchEvent(new window.Event('input'));
    const prompts = [];
    window.saveTransfer.confirm = async message => { prompts.push(message); return true; };
    document.getElementById('replaceFileBtn').click();
    await until(() => replacements.length === 1 && editor.value === window.EditorBytes.formatHex(Buffer.from('replacement content')), 'The current editor did not refresh after replacement');
    await f.idle();
    assert.match(prompts[0], /Discard unsaved changes.*replace/i);
    assert.deepEqual(replacements, [{ root: info.root, path: 'DATA/save.dat' }]);
    assert.deepEqual(reads, [{ root: info.root, path: 'DATA/save.dat' }, { root: info.root, path: 'DATA/save.dat' }]);
    assert.equal(document.getElementById('editorFileName').textContent, 'DATA/save.dat');
    assert.equal(document.getElementById('saveFileBtn').textContent, 'Save changes');
    document.getElementById('saveEncryptFileBtn').click();
    await until(() => calls.encrypt.length === 1, 'Save and encrypt did not run after replacement');
    await f.idle();
    assert.deepEqual(calls.writes, [], 'Encrypt should use the replacement already in the workspace');
    assert.equal(calls.encrypt[0].accountId, TARGET);
    assert.equal(calls.encrypt[0].useRemoteOracle, remote);
    assert.deepEqual(f.errors, []);
  });
}

test('replacement cancellation and bridge failure preserve the current unsaved editor', async t => {
  const f = await app(t, false);
  const { document, window, info } = f;
  const replacements = [];
  let behavior = 'cancel';
  window.saveEditor.replace = async value => {
    replacements.push(plain(value));
    if (behavior === 'fail') throw new Error('Test replacement failed');
    return null;
  };
  await f.selectAndDecrypt();
  openWorkspaceLeaf(f, 'DATA/save.dat'); await f.idle();
  const editor = document.getElementById('fileEditor');
  chooseEditorMode(f, 'text');
  editor.value = 'keep my unsaved bytes'; editor.dispatchEvent(new window.Event('input'));
  window.saveTransfer.confirm = async () => false;
  await workspaceAction(f, 'DATA/save.dat', 'replace'); await f.idle();
  assert.equal(replacements.length, 0, 'Canceling discard must not open the replacement chooser');
  window.saveTransfer.confirm = async () => true;
  await workspaceAction(f, 'DATA/save.dat', 'replace'); await f.idle();
  assert.deepEqual(replacements, [{ root: info.root, path: 'DATA/save.dat' }]);
  assert.equal(editor.value, 'keep my unsaved bytes');
  assert.match(document.getElementById('saveFileBtn').textContent, /\*/);
  behavior = 'fail';
  await workspaceAction(f, 'DATA/save.dat', 'replace');
  await until(() => document.getElementById('mySavesStatus').textContent === 'Test replacement failed', 'Replacement failure was not reported');
  await f.idle();
  assert.equal(editor.value, 'keep my unsaved bytes');
  assert.equal(document.getElementById('editorFileName').textContent, 'DATA/save.dat');
  assert.equal(document.getElementById('saveFileBtn').disabled, false);
  assert.equal(document.getElementById('targetAccountSelect').value, TARGET);
  assert.deepEqual(f.errors, []);
});

test('replacing another leaf preserves the current dirty editor and a manual account target', async t => {
  const f = await app(t, false, '');
  const { document, window, info, calls } = f;
  info.files.push({ path: 'OTHER/save.dat', size: 5, protected: false });
  const reads = [], replacements = [], prompts = [];
  window.saveEditor.read = async value => { reads.push(plain(value)); return { data: Buffer.from('original').toString('base64') }; };
  window.saveEditor.replace = async value => { replacements.push(plain(value)); return plain(info); };
  window.saveTransfer.confirm = async message => { prompts.push(message); return true; };
  await f.selectAndDecrypt();
  document.getElementById('encryptAccountId').value = OTHER;
  openWorkspaceLeaf(f, 'DATA/save.dat'); await f.idle();
  const editor = document.getElementById('fileEditor');
  chooseEditorMode(f, 'text');
  editor.value = 'unsaved selected file'; editor.dispatchEvent(new window.Event('input'));
  await workspaceAction(f, 'OTHER/save.dat', 'replace');
  await until(() => replacements.length === 1, 'Replacing another leaf did not start');
  await f.idle();
  assert.deepEqual(replacements, [{ root: info.root, path: 'OTHER/save.dat' }]);
  assert.deepEqual(reads, [{ root: info.root, path: 'DATA/save.dat' }]);
  assert.deepEqual(prompts, [], 'Replacing another leaf must not discard or prompt about the current editor');
  assert.equal(editor.value, 'unsaved selected file');
  assert.equal(document.getElementById('editorFileName').textContent, 'DATA/save.dat');
  assert.match(document.getElementById('saveFileBtn').textContent, /\*/);
  assert.equal(document.getElementById('encryptAccountId').value, OTHER);
  document.getElementById('saveEncryptFileBtn').click();
  await until(() => calls.encrypt.length === 1, 'The preserved editor could not save and encrypt');
  await f.idle();
  assert.equal(calls.writes[0].path, 'DATA/save.dat');
  assert.equal(Buffer.from(calls.writes[0].data, 'base64').toString(), 'unsaved selected file');
  assert.equal(calls.encrypt[0].accountId, OTHER);
  assert.deepEqual(f.errors, []);
});

test('replacing the open file with a large one reloads its first page and clears stale editor bytes', async t => {
  const f = await app(t, false);
  const { document, window, info, calls } = f;
  let wholeReads = 0;
  const pages = [];
  const size = 9 * 1024 * 1024;
  window.saveEditor.read = async () => {
    wholeReads++;
    return { data: Buffer.from('old editor bytes').toString('base64') };
  };
  window.saveEditor.readPage = async ({ offset, length }) => {
    pages.push({ offset, length });
    return { data: Buffer.alloc(Math.min(length, size - offset), 0x5e).toString('base64'), size, version: 'replacement' };
  };
  window.saveEditor.replace = async () => {
    info.files[0].size = size;
    return plain(info);
  };
  await f.selectAndDecrypt();
  openWorkspaceLeaf(f, 'DATA/save.dat'); await f.idle();
  await workspaceAction(f, 'DATA/save.dat', 'replace');
  await until(() => pages.length > 0, 'The replacement did not open in the paged editor');
  await f.idle();
  assert.equal(wholeReads, 1);
  assert.equal(pages[0].offset, 0);
  assert.ok(pages.every(page => page.length < size));
  assert.equal(document.getElementById('fileEditorPanel').hidden, false);
  assert.match(document.getElementById('fileEditor').value, /5e 5e 5e/);
  assert.doesNotMatch(document.getElementById('saveFileBtn').textContent, /\*/);
  assert.deepEqual(calls.writes, []);
  assert.deepEqual(f.errors, []);
});

// Function = Size Scroll View
function editorScrollFixture(f) {
  const rail = f.document.getElementById('editorScroll');
  const track = f.document.getElementById('editorScrollTrack');
  const editor = f.document.getElementById('fileEditor');
  Object.defineProperty(rail, 'clientHeight', { value: 180 });
  Object.defineProperty(rail, 'scrollHeight', { get: () => Math.max(180, Number.parseFloat(track.style.height) || 0) });
  Object.defineProperty(editor, 'clientHeight', { value: 180 });
  Object.defineProperty(editor, 'scrollHeight', { get: () => Math.max(180, editor.value.split('\n').length * 18) });
  return {
    rail, editor,
    scroll(fraction) {
      rail.scrollTop = Math.round((rail.scrollHeight - rail.clientHeight) * fraction);
      rail.dispatchEvent(new f.window.Event('scroll'));
    },
  };
}

test('a 100 MiB game file scrolls, keeps edits, grows and saves from the editor', async t => {
  const f = await app(t, false);
  const { document, window, info } = f;
  const { readWorkspacePage, writeWorkspacePages } = require('../electron/save_editor.cjs');
  const byId = id => document.getElementById(id);
  const lastPage = 100 * 1024 * 1024;
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'garlic-large-editor-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  await fs.promises.mkdir(path.join(root, 'DATA'));
  const selected = path.join(root, 'DATA', 'save.dat');
  const original = await fs.promises.open(selected, 'wx');
  try {
    await original.truncate(lastPage + 3);
    await original.write(Buffer.from([0x11]), 0, 1, 0);
    await original.write(Buffer.from([0xa5]), 0, 1, lastPage / 2);
    await original.write(Buffer.from([0xde, 0xad, 0xef]), 0, 3, lastPage);
  } finally { await original.close(); }
  info.root = root;
  info.files[0].size = lastPage + 3;
  const ranges = [], saves = [];
  window.saveEditor.read = window.saveEditor.write = () => assert.fail('Unexpected whole-file editor operation');
  window.saveEditor.readPage = options => {
    ranges.push({ offset: options.offset, length: options.length });
    return readWorkspacePage(options);
  };
  window.saveEditor.writePages = async options => {
    const result = await writeWorkspacePages(options);
    saves.push(result);
    return result;
  };
  const viewport = editorScrollFixture(f);
  const { editor } = viewport;
  await f.selectAndDecrypt();
  openWorkspaceLeaf(f, 'DATA/save.dat');
  await until(() => editor.value.includes('11 00 00'), 'The first page did not open');
  await f.idle();
  assert.equal(byId('editorMode').value, 'hex');
  editor.value = editor.value.replace('11 00 00', 'aa 00 00');
  editor.dispatchEvent(new window.Event('input'));
  assert.equal(byId('editorNextPage'), null);
  assert.equal(byId('editorPrevPage'), null);
  viewport.scroll(0.3);
  await until(() => Number.parseInt(editor.value, 16) > 65536, 'Scrolling did not load a later part of the file');
  viewport.scroll(0);
  await until(() => editor.value.includes('aa 00 00'), 'Scrolling back lost the first edit');
  await f.idle();
  byId('editorOffset').value = lastPage.toString(16);
  byId('editorGoOffset').click();
  await until(() => editor.value.includes('de ad ef'), 'Go did not open the final page');
  await f.idle();
  editor.value += '\n7b';
  editor.dispatchEvent(new window.Event('input'));
  byId('saveFileBtn').click();
  await until(() => saves.length === 1, 'The paged edits did not save', 15000);
  await f.idle();
  const saved = await fs.promises.open(selected, 'r');
  try {
    assert.equal((await saved.stat()).size, lastPage + 4);
    for (const [offset, expected] of [[0, [0xaa, 0]], [lastPage / 2, [0xa5]], [lastPage, [0xde, 0xad, 0xef, 0x7b]]]) {
      const bytes = Buffer.alloc(expected.length);
      assert.equal((await saved.read(bytes, 0, bytes.length, offset)).bytesRead, bytes.length);
      assert.deepEqual([...bytes], expected);
    }
  } finally { await saved.close(); }
  assert.ok(ranges.every(page => page.length <= 1024 * 1024), 'Opening and editing should use bounded reads');
  assert.deepEqual(f.errors, []);
});

test('the wheel scrolls one row at a time and crosses a large file buffer boundary', async t => {
  const f = await app(t, false);
  const { window, document, info } = f;
  const { editor } = editorScrollFixture(f);
  const byId = id => document.getElementById(id);
  info.files[0].size = 9 * 1024 * 1024;
  window.saveEditor.readPage = async ({ offset, length }) => ({
    data: Buffer.alloc(Math.min(length, info.files[0].size - offset)).toString('base64'),
    size: info.files[0].size, version: 'original',
  });
  const topOffset = () => Number.parseInt(editor.value, 16) + Math.floor(editor.scrollTop / 18) * 16;
  const wheel = deltaY => editor.dispatchEvent(new window.WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }));
  await f.selectAndDecrypt();
  openWorkspaceLeaf(f, 'DATA/save.dat');
  await until(() => byId('fileEditorDialog').open, 'The large file did not open');
  await f.idle();
  assert.equal(topOffset(), 0);
  wheel(18);
  await until(() => topOffset() > 0, 'A one-line wheel movement did not scroll');
  assert.equal(topOffset(), 16);
  byId('editorOffset').value = 'fff0';
  byId('editorGoOffset').click();
  await until(() => /moved to offset 0xfff0/i.test(byId('mySavesStatus').textContent), 'Could not jump near the buffer boundary');
  await f.idle();
  const before = topOffset();
  wheel(30 * 18);
  await until(() => topOffset() > before && topOffset() >= 0x10000, 'The wheel stopped at the end of the loaded bytes');
  wheel(-30 * 18);
  await until(() => topOffset() < 0x10000, 'The wheel could not cross back into the earlier bytes');
  const key = value => editor.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, ctrlKey: true, cancelable: true }));
  key('End');
  await until(() => topOffset() >= info.files[0].size - 256, 'Ctrl+End did not reach the last bytes');
  key('Home');
  await until(() => topOffset() === 0, 'Ctrl+Home did not return to the first byte');
  assert.deepEqual(f.errors, []);
});

test('typing while a distant scroll is loading preserves the newer draft', async t => {
  const f = await app(t, false);
  const { window, info, document } = f;
  const viewport = editorScrollFixture(f);
  const size = 9 * 1024 * 1024;
  info.files[0].size = size;
  let release, finished = false;
  window.saveEditor.readPage = async ({ offset, length }) => {
    if (offset > size / 4 && !finished) {
      await new Promise(resolve => { release = resolve; });
      finished = true;
    }
    return { data: Buffer.alloc(Math.min(length, size - offset)).toString('base64'), size, version: 'original' };
  };
  await f.selectAndDecrypt();
  openWorkspaceLeaf(f, 'DATA/save.dat');
  await f.idle();
  viewport.scroll(0.6);
  await until(() => typeof release === 'function', 'The distant read did not start');
  viewport.editor.value = 'aa bb cc';
  viewport.editor.dispatchEvent(new window.Event('input'));
  release();
  await until(() => finished, 'The distant read did not finish');
  await pause();
  assert.equal(viewport.editor.value, 'aa bb cc');
  assert.match(document.getElementById('saveFileBtn').textContent, /\*/);
  assert.deepEqual(f.errors, []);
});

test('scrolling keeps an incomplete hex draft in place until it is corrected', async t => {
  const f = await app(t, false);
  const { window, document, info } = f;
  const viewport = editorScrollFixture(f);
  const size = 9 * 1024 * 1024;
  info.files[0].size = size;
  window.saveEditor.readPage = async ({ offset, length }) => ({
    data: Buffer.alloc(Math.min(length, size - offset)).toString('base64'), size, version: 'original',
  });
  await f.selectAndDecrypt();
  openWorkspaceLeaf(f, 'DATA/save.dat');
  await f.idle();
  const editor = viewport.editor;
  editor.value = 'a';
  editor.dispatchEvent(new window.Event('input'));
  viewport.scroll(0.6);
  await until(() => /complete bytes/i.test(document.getElementById('editorStatus').textContent), 'The invalid draft was not reported');
  assert.equal(editor.value, 'a');
  editor.value = 'aa bb';
  editor.dispatchEvent(new window.Event('input'));
  viewport.scroll(0.6);
  await until(() => Number.parseInt(editor.value, 16) > 65536, 'Correcting the draft did not re-enable scrolling');
  viewport.scroll(0);
  await until(() => /aa bb 00/i.test(editor.value), 'The corrected bytes were lost');
  assert.deepEqual(f.errors, []);
});

test('large-file Find spans adjacent pages and Text checks bytes outside the displayed page', async t => {
  const f = await app(t, false);
  const { window, document, info, calls } = f;
  const byId = id => document.getElementById(id);
  const pageSize = 64 * 1024;
  const bytes = Buffer.alloc(9 * 1024 * 1024, 0x20);
  bytes.write('FIND', pageSize - 2);
  bytes[bytes.length - 1] = 0xff;
  info.files[0].size = bytes.length;
  window.saveEditor.readPage = async ({ offset, length }) => ({
    data: bytes.subarray(offset, offset + length).toString('base64'), size: bytes.length, version: 'original',
  });
  await f.selectAndDecrypt();
  openWorkspaceLeaf(f, 'DATA/save.dat');
  await until(() => byId('fileEditorDialog').open, 'The large file did not open');
  await f.idle();
  byId('editorSearch').value = '46 49 4e 44';
  byId('editorSearch').dispatchEvent(new window.Event('input'));
  byId('editorFindNext').click();
  await until(() => /at 0x/i.test(byId('mySavesStatus').textContent), 'Find missed the cross-page match');
  await f.idle();
  assert.equal(foundEditorOffset(document), pageSize - 2);
  const previous = byId('fileEditor').value;
  chooseEditorMode(f, 'text');
  await until(() => /converted to text mode/i.test(byId('editorStatus').textContent), 'A later invalid UTF-8 byte went undetected', 15000);
  await f.idle();
  assert.equal(byId('editorMode').value, 'hex');
  assert.equal(byId('fileEditor').value, previous);
  assert.deepEqual(calls.writes, []);
  assert.deepEqual(f.errors, []);
});

test('a replacement read-back failure reports the committed replacement and allows retrying the editor', async t => {
  const f = await app(t, false);
  const { document, window, info } = f;
  let reads = 0;
  window.saveEditor.read = async () => {
    reads++;
    if (reads === 2) throw new Error('Test editor read failed');
    return { data: Buffer.from(reads > 2 ? 'replaced bytes' : 'old bytes').toString('base64') };
  };
  window.saveEditor.replace = async () => plain(info);
  await f.selectAndDecrypt();
  openWorkspaceLeaf(f, 'DATA/save.dat'); await f.idle();
  await workspaceAction(f, 'DATA/save.dat', 'replace');
  await until(() => reads === 2, 'Replacement did not attempt to refresh the editor');
  await f.idle();
  assert.match(document.getElementById('mySavesStatus').textContent, /replaced.*retry opening/);
  assert.equal(document.getElementById('fileEditorPanel').hidden, true);
  openWorkspaceLeaf(f, 'DATA/save.dat'); await f.idle();
  assert.equal(document.getElementById('fileEditor').value, window.EditorBytes.formatHex(Buffer.from('replaced bytes')));
  assert.equal(document.getElementById('fileEditorPanel').hidden, false);
  assert.deepEqual(f.errors, []);
});

test('damaged workspace metadata blocks only encryption and a clean refresh enables it again', async t => {
  const f = await app(t, false);
  const { document, window, info, calls } = f;
  const byId = id => document.getElementById(id);
  info.batchError = 'DATA/chives.json is invalid';
  await f.selectAndDecrypt();
  assert.equal(byId('workspaceBatchWarning').textContent, 'Encryption unavailable: DATA/chives.json is invalid');
  for (const id of ['encryptSaveBtn', 'confirmEncryptBtn']) assert.equal(byId(id).disabled, true);
  assert.equal(byId('exportDecryptedBtn').disabled, false);
  openWorkspaceLeaf(f, 'DATA/save.dat'); await f.idle();
  assert.equal(byId('fileEditorDialog').open, true);
  assert.equal(byId('downloadFileBtn').disabled, false);
  assert.equal(byId('saveFileBtn').disabled, false);
  assert.equal(byId('saveEncryptFileBtn').disabled, true);
  byId('encryptSaveBtn').click();
  byId('saveEncryptFileBtn').click();
  assert.equal(calls.encrypt.length, 0);
  assert.equal(calls.writes.length, 0);

  info.batchError = '';
  byId('fileEditor').value = '61 62';
  byId('fileEditor').dispatchEvent(new window.Event('input'));
  byId('saveFileBtn').click(); await f.idle();
  assert.equal(calls.writes.length, 1);
  assert.equal(byId('workspaceBatchWarning').hidden, true);
  for (const id of ['encryptSaveBtn', 'confirmEncryptBtn', 'saveEncryptFileBtn']) assert.equal(byId(id).disabled, false);
  assert.deepEqual(f.errors, []);
});

test('nested chives metadata stays selectable and exportable while all editor actions are blocked', async t => {
  const f = await app(t, false);
  const { document, window, info } = f;
  const path = 'DATA/SLOT/CHIVES.JSON';
  info.files.push({ path, size: 20, protected: true, readOnly: true });
  const requests = [];
  for (const method of ['read', 'write', 'replace', 'delete', 'downloadFile']) {
    window.saveEditor[method] = async value => { requests.push([method, plain(value)]); return '/export/chives.json'; };
  }
  await f.selectAndDecrypt();
  const row = workspaceLeaf(f, path);
  openWorkspaceLeaf(f, row);
  row.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await f.idle();
  assert.equal(row.getAttribute('aria-selected'), 'true');
  assert.equal(document.getElementById('fileEditorDialog').open, false);
  row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  const menu = document.getElementById('workspaceFileContextMenu');
  for (const action of ['edit', 'replace', 'delete']) {
    const button = menu.querySelector(`[data-action="${action}"]`);
    assert.equal(button.disabled, true);
    assert.match(button.title, /read-only/);
    button.click();
  }
  menu.querySelector('[data-action="export"]').click();
  await f.idle();
  assert.deepEqual(requests, [['downloadFile', { root: info.root, path }]]);
  assert.deepEqual(f.errors, []);
});

test('sce_sys replacement is available while protected-file deletion remains disabled', async t => {
  const f = await app(t, false);
  const { document, window, info } = f;
  info.files.push({ path: 'sce_sys/param.sfo', size: 50, protected: true });
  const replacements = [];
  window.saveEditor.replace = async value => { replacements.push(plain(value)); return plain(info); };
  await f.selectAndDecrypt();
  await workspaceAction(f, 'sce_sys/param.sfo', 'replace');
  await until(() => replacements.length === 1, 'Protected metadata could not be replaced like an editor write');
  await f.idle();
  assert.deepEqual(replacements, [{ root: info.root, path: 'sce_sys/param.sfo' }]);
  workspaceLeaf(f, 'sce_sys/param.sfo').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  assert.equal(document.querySelector('#workspaceFileContextMenu [data-action="delete"]').disabled, true);
  assert.equal(document.querySelector('#workspaceFileContextMenu [data-action="replace"]').disabled, false);
  assert.deepEqual(f.errors, []);
});

test('a pending replacement locks the workspace and retains its captured file target', async t => {
  const f = await app(t, false);
  const { document, window, info } = f;
  info.files.push({ path: 'OTHER/save.dat', size: 8, protected: false });
  const replacements = [], reads = [];
  let release;
  window.saveEditor.read = async value => { reads.push(plain(value)); return { data: Buffer.from('current bytes').toString('base64') }; };
  window.saveEditor.replace = value => {
    replacements.push(plain(value));
    return new Promise(resolve => { release = () => resolve(plain(info)); });
  };
  await f.selectAndDecrypt();
  openWorkspaceLeaf(f, 'DATA/save.dat'); await f.idle();
  await workspaceAction(f, 'OTHER/save.dat', 'replace');
  await until(() => typeof release === 'function', 'Replacement did not wait for the native file choice');
  workspaceLeaf(f, 'OTHER/save.dat').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  document.getElementById('replaceFileBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(document.getElementById('closeWorkspaceBtn').disabled, true);
  assert.equal(document.getElementById('fileEditor').disabled, true);
  assert.equal(replacements.length, 1, 'A forced event started a second replacement while the chooser was pending');
  assert.deepEqual(reads, [{ root: info.root, path: 'DATA/save.dat' }]);
  release(); await f.idle();
  assert.deepEqual(replacements, [{ root: info.root, path: 'OTHER/save.dat' }]);
  assert.equal(document.getElementById('editorFileName').textContent, 'DATA/save.dat');
  assert.equal(document.getElementById('fileEditor').disabled, false);
  assert.deepEqual(f.errors, []);
});

test('tree export and delete act on the clicked leaf while preserving another open editor', async t => {
  const f = await app(t, false);
  const { document, window, info } = f;
  info.files.push({ path: 'OTHER/save.dat', size: 8, protected: false });
  const exports = [], deletions = [], prompts = [];
  window.saveEditor.downloadFile = async value => { exports.push(plain(value)); return '/exports/save.dat'; };
  window.saveEditor.delete = async value => {
    deletions.push(plain(value));
    return { ...plain(info), files: info.files.filter(file => file.path !== value.path) };
  };
  window.saveTransfer.confirm = async message => { prompts.push(message); return true; };
  await f.selectAndDecrypt();
  openWorkspaceLeaf(f, 'DATA/save.dat'); await f.idle();
  const editor = document.getElementById('fileEditor');
  chooseEditorMode(f, 'text');
  editor.value = 'preserve this draft'; editor.dispatchEvent(new window.Event('input'));
  await workspaceAction(f, 'OTHER/save.dat', 'export');
  await until(() => exports.length === 1, 'The tree export did not run'); await f.idle();
  assert.deepEqual(exports, [{ root: info.root, path: 'OTHER/save.dat' }]);
  await workspaceAction(f, 'OTHER/save.dat', 'delete');
  await until(() => deletions.length === 1, 'The tree delete did not run'); await f.idle();
  assert.deepEqual(deletions, [{ root: info.root, path: 'OTHER/save.dat' }]);
  assert.deepEqual(prompts, ['Delete OTHER/save.dat from the decrypted workspace?']);
  assert.equal(workspaceLeaf(f, 'OTHER/save.dat'), undefined);
  assert.equal(document.getElementById('editorFileName').textContent, 'DATA/save.dat');
  assert.equal(editor.value, 'preserve this draft');
  assert.match(document.getElementById('saveFileBtn').textContent, /\*/);
  assert.deepEqual(f.errors, []);
});

// Function Popup Selection
test('a single tree click selects a file without reading it; Edit opens its popup', async t => {
  const f = await app(t, false);
  const { document, window, calls } = f;
  const reads = [];
  window.saveEditor.read = async value => { reads.push(plain(value)); return { data: Buffer.from('popup bytes').toString('base64') }; };
  await f.selectAndDecrypt();
  const row = workspaceLeaf(f, 'DATA/save.dat');
  row.click();
  await pause();
  assert.equal(row.getAttribute('aria-selected'), 'true');
  assert.deepEqual(reads, []);
  assert.equal(document.getElementById('fileEditorDialog').open, false);
  assert.equal(document.getElementById('fileEditorPanel').hidden, true);
  assert.equal(document.querySelector('.workspace-grid').contains(document.getElementById('fileEditorPanel')), false);
  assert.equal(document.getElementById('fileEditorDialog').contains(document.getElementById('fileEditorPanel')), true);
  await workspaceAction(f, 'DATA/save.dat', 'edit');
  await until(() => document.getElementById('fileEditorDialog').open, 'Edit did not open the file popup');
  await f.idle();
  assert.deepEqual(reads, [{ root: f.info.root, path: 'DATA/save.dat' }]);
  assert.equal(document.getElementById('fileEditor').value, window.EditorBytes.formatHex(Buffer.from('popup bytes')));
  assert.equal(document.getElementById('targetAccountSelect').value, TARGET);
  assert.equal(document.getElementById('encryptAccountId').value, TARGET);
  assert.deepEqual(calls.writes, []);
  assert.deepEqual(f.errors, []);
});

test('closing the editor asks before discarding a draft and restores its tree focus', async t => {
  const f = await app(t, false);
  const { document, window, calls } = f;
  await f.selectAndDecrypt();
  openWorkspaceLeaf(f, 'DATA/save.dat');
  await until(() => document.getElementById('fileEditorDialog').open, 'Editor popup did not open');
  await f.idle();
  const editor = document.getElementById('fileEditor');
  chooseEditorMode(f, 'text');
  editor.value = 'my unsaved draft'; editor.dispatchEvent(new window.Event('input'));
  const prompts = [];
  window.saveTransfer.confirm = async message => { prompts.push(message); return false; };
  const dialog = document.getElementById('fileEditorDialog');
  const canceled = new window.Event('cancel', { cancelable: true });
  dialog.dispatchEvent(canceled);
  await until(() => prompts.length === 1, 'Escape did not request a discard decision');
  await pause();
  assert.equal(canceled.defaultPrevented, true);
  assert.equal(dialog.open, true);
  assert.equal(editor.value, 'my unsaved draft');
  assert.match(document.getElementById('saveFileBtn').textContent, /\*/);
  window.saveTransfer.confirm = async message => { prompts.push(message); return true; };
  document.getElementById('closeFileEditorBtn').click();
  await until(() => !dialog.open, 'Approved close did not dismiss the editor');
  assert.equal(document.getElementById('fileEditorPanel').hidden, true);
  assert.equal(editor.value, '');
  assert.equal(document.activeElement, workspaceLeaf(f, 'DATA/save.dat'));
  assert.deepEqual(calls.writes, []);
  openWorkspaceLeaf(f, 'DATA/save.dat');
  await until(() => dialog.open, 'The editor could not be reopened');
  await f.idle();
  assert.equal(editor.value, window.EditorBytes.formatHex(Buffer.from('save data')));
  assert.deepEqual(f.errors, []);
});

test('ReRegion applies a validated target and Cancel preserves the previous PPSA', async t => {
  const f = await app(t, false);
  const { document, window, calls } = f;
  await f.selectAndDecrypt();
  await workspaceAction(f, 'DATA/save.dat', 'reregion');
  const dialog = document.getElementById('reRegionDialog');
  await until(() => dialog.open, 'ReRegion did not open');
  assert.match(document.getElementById('reRegionCurrentTitle').textContent, /PPSA12345/);
  const input = document.getElementById('targetTitleId');
  const apply = () => document.getElementById('reRegionForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  input.value = 'PPSA12X45'; apply();
  await until(() => document.getElementById('reRegionError').textContent, 'Invalid PPSA was not explained');
  assert.equal(dialog.open, true);
  assert.match(document.getElementById('reRegionError').textContent, /PPSA|five digits/i);
  assert.deepEqual(calls.encrypt, []);
  input.value = 'ppsa54321'; apply();
  await until(() => !dialog.open, 'Valid PPSA did not apply');
  assert.equal(input.value, 'PPSA54321');
  assert.match(document.getElementById('workspaceTargetTitle').textContent, /PPSA54321/);
  assert.equal(document.getElementById('targetAccountSelect').value, TARGET);
  document.getElementById('reRegionBtn').click();
  await until(() => dialog.open, 'ReRegion could not be reopened');
  input.value = 'PPSA99999';
  document.getElementById('cancelReRegionBtn').click();
  await until(() => !dialog.open, 'Cancel did not close ReRegion');
  assert.equal(input.value, 'PPSA54321');
  document.getElementById('reRegionBtn').click();
  await until(() => dialog.open, 'ReRegion could not be reopened to clear the target');
  input.value = '';
  apply();
  await until(() => !dialog.open, 'Blank target did not apply');
  assert.equal(input.value, '');
  assert.doesNotMatch(document.getElementById('workspaceTargetTitle').textContent, /PPSA54321/);
  assert.deepEqual(calls.jobs.filter(job => job.operation !== 'decrypt'), []);
  assert.deepEqual(f.errors, []);
});

test('ReRegion identifies mixed batch titles and uses one target for every save', async t => {
  const f = await app(t, false);
  const { document, window, info, calls } = f;
  batchWorkspace(info);
  await f.selectAndDecrypt();
  document.getElementById('reRegionBtn').click();
  await until(() => document.getElementById('reRegionDialog').open, 'Mixed-title ReRegion did not open');
  assert.match(document.getElementById('reRegionCurrentTitle').textContent, /Multiple PPSAs/i);
  document.getElementById('targetTitleId').value = 'ppsa99999';
  document.getElementById('reRegionForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(document.getElementById('reRegionDialog').open, false);
  document.getElementById('encryptSaveBtn').click();
  await until(() => calls.jobs.some(job => job.operation === 'encrypt'), 'The re-regioned batch was not exported');
  await f.idle();
  assert.equal(calls.jobs.find(job => job.operation === 'encrypt').targetTitleId, 'PPSA99999');
  assert.equal(calls.encrypt.length, 0);
  assert.deepEqual(f.errors, []);
});

test('hosted worker mode disables ReRegion in both the toolbar menu and right-click menu', async t => {
  const f = await app(t, true);
  const { document, window } = f;
  await f.selectAndDecrypt();
  assert.equal(document.getElementById('reRegionBtn').disabled, true);
  workspaceLeaf(f, 'DATA/save.dat').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  const action = document.querySelector('#workspaceFileContextMenu [data-action="reregion"]');
  assert.ok(action);
  assert.equal(action.disabled, true);
  document.getElementById('reRegionBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(document.getElementById('reRegionDialog').open, false);
  assert.deepEqual(f.errors, []);
});

test('right-click Add Account reuses naming and blocks accounts already saved', async t => {
  const f = await app(t, false);
  const { document, window, calls } = f;
  await f.selectAndDecrypt();
  await workspaceAction(f, 'DATA/save.dat', 'add-account');
  await until(() => document.getElementById('accountNameDialog').open, 'Context Add Account did not open naming');
  assert.equal(document.getElementById('accountNameId').textContent, CURRENT);
  document.getElementById('accountNameInput').value = 'Current player';
  document.getElementById('accountNameForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => calls.add.length === 1, 'The context action did not save the account');
  await until(() => !document.getElementById('accountNameDialog').open, 'The saved account dialog stayed open');
  assert.deepEqual(calls.add, [{ id: CURRENT, name: 'Current player' }]);
  assert.equal(document.getElementById('workspaceAccountId').textContent, 'Current player');
  workspaceLeaf(f, 'DATA/save.dat').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  const action = document.querySelector('#workspaceFileContextMenu [data-action="add-account"]');
  assert.equal(action.disabled, true);
  action.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(document.getElementById('accountNameDialog').open, false);
  assert.equal(calls.add.length, 1);
  assert.deepEqual(f.errors, []);
});

test('app close flushing blocks popup close and new ReRegion actions until resumed', async t => {
  const f = await app(t, false);
  const { document, window, calls } = f;
  await f.selectAndDecrypt();
  openWorkspaceLeaf(f, 'DATA/save.dat');
  await until(() => document.getElementById('fileEditorDialog').open, 'Editor popup did not open');
  await f.idle();
  await calls.closeFlush();
  assert.equal(document.getElementById('closeFileEditorBtn').disabled, true);
  assert.equal(document.getElementById('reRegionBtn').disabled, true);
  document.getElementById('closeFileEditorBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  document.getElementById('reRegionBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await pause();
  assert.equal(document.getElementById('fileEditorDialog').open, true);
  assert.equal(document.getElementById('reRegionDialog').open, false);
  calls.closeResume();
  assert.equal(document.getElementById('closeFileEditorBtn').disabled, false);
  document.getElementById('closeFileEditorBtn').click();
  await until(() => !document.getElementById('fileEditorDialog').open, 'The editor stayed blocked after close resumed');
  assert.deepEqual(f.errors, []);
});

test('every file opens in Hex and explicit Text preserves the BOM and multibyte edits', async t => {
  const f = await app(t, false);
  const { document, window, calls, info } = f;
  const original = Buffer.from('\uFEFFcafé\n🍋');
  info.files.push({ path: 'OTHER/plain.txt', size: 5, protected: false });
  window.saveEditor.read = async ({ path }) => ({
    data: (path === 'DATA/save.dat' ? original : Buffer.from('plain')).toString('base64'),
  });
  await f.selectAndDecrypt();
  openWorkspaceLeaf(f, 'DATA/save.dat');
  await f.idle();
  const mode = document.getElementById('editorMode');
  const editor = document.getElementById('fileEditor');
  assert.equal(mode.value, 'hex');
  const originalHex = editor.value;
  chooseEditorMode(f, 'text');
  assert.equal(mode.value, 'text');
  assert.match(editor.value, /café\n🍋$/u);
  chooseEditorMode(f, 'hex');
  assert.equal(editor.value, originalHex);
  chooseEditorMode(f, 'text');
  editor.value += '!';
  editor.dispatchEvent(new window.Event('input'));
  chooseEditorMode(f, 'hex');
  const expected = Buffer.concat([original, Buffer.from('!')]);
  assert.equal(editor.value, window.EditorBytes.formatHex(expected));
  chooseEditorMode(f, 'text');
  document.getElementById('saveFileBtn').click();
  await f.idle();
  assert.equal(calls.writes.length, 1);
  assert.deepEqual(Buffer.from(calls.writes[0].data, 'base64'), expected);
  openWorkspaceLeaf(f, 'OTHER/plain.txt');
  await f.idle();
  assert.equal(mode.value, 'hex');
  assert.equal(editor.value, window.EditorBytes.formatHex(Buffer.from('plain')));
  assert.deepEqual(f.errors, []);
});

test('unsafe Text switches keep the current Hex draft and clean saves preserve its bytes', async t => {
  const f = await app(t, false);
  const { document, window, calls } = f;
  window.saveEditor.read = async () => ({ data: Buffer.from([0xff, 0x80, 0xfe]).toString('base64') });
  await f.selectAndDecrypt();
  openWorkspaceLeaf(f, 'DATA/save.dat');
  await f.idle();
  const editor = document.getElementById('fileEditor');
  const mode = document.getElementById('editorMode');
  const original = editor.value;
  assert.equal(mode.value, 'hex');
  chooseEditorMode(f, 'text');
  assert.equal(mode.value, 'hex');
  assert.equal(editor.value, original);
  assert.equal(document.getElementById('editorByteCount').textContent, '3 bytes');
  assert.equal(document.getElementById('editorStatus').textContent, 'Cant be converted to text mode');
  document.getElementById('saveFileBtn').click();
  await f.idle();
  assert.deepEqual(calls.writes, []);
  for (const hex of ['41 0d 0a 42', '41 0d 42', '41 f']) {
    editor.value = hex;
    editor.dispatchEvent(new window.Event('input'));
    chooseEditorMode(f, 'text');
    assert.equal(mode.value, 'hex');
    assert.equal(editor.value, hex);
    assert.equal(document.getElementById('editorStatus').textContent, 'Cant be converted to text mode');
    assert.match(document.getElementById('saveFileBtn').textContent, /\*/);
    assert.deepEqual(calls.writes, []);
  }
  window.saveTransfer.confirm = async () => true;
  document.getElementById('editorRevert').click();
  await f.idle();
  assert.equal(editor.value, original);
  document.getElementById('saveEncryptFileBtn').click();
  await until(() => calls.encrypt.length === 1, 'Save & encrypt did not continue with the original file');
  await f.idle();
  assert.deepEqual(calls.writes, []);
  assert.deepEqual(f.errors, []);
});

test('switching editor modes preserves an unsaved draft until its bytes are saved', async t => {
  const f = await app(t, false);
  const { document, window, calls } = f;
  await f.selectAndDecrypt();
  openWorkspaceLeaf(f, 'DATA/save.dat');
  const dialog = document.getElementById('fileEditorDialog');
  await until(() => dialog.open, 'Editor popup did not open');
  await f.idle();
  const editor = document.getElementById('fileEditor');
  const mode = document.getElementById('editorMode');
  chooseEditorMode(f, 'text');
  const draft = 'edited café ☃';
  editor.value = draft;
  editor.dispatchEvent(new window.Event('input'));
  mode.value = 'hex';
  mode.dispatchEvent(new window.Event('change'));
  assert.match(editor.value, /65 64 69 74 65 64/);
  assert.match(document.getElementById('saveFileBtn').textContent, /\*/);
  const prompts = [];
  window.saveTransfer.confirm = async message => { prompts.push(message); return false; };
  document.getElementById('closeFileEditorBtn').click();
  await until(() => prompts.length === 1, 'Mode switching lost the unsaved-change warning');
  await f.idle();
  assert.equal(dialog.open, true);
  assert.match(editor.value, /65 64 69 74 65 64/);
  mode.value = 'text';
  mode.dispatchEvent(new window.Event('change'));
  assert.equal(editor.value, draft);
  assert.match(document.getElementById('saveFileBtn').textContent, /\*/);
  document.getElementById('saveFileBtn').click();
  await until(() => calls.writes.length === 1, 'The converted draft did not save');
  await f.idle();
  assert.equal(Buffer.from(calls.writes[0].data, 'base64').toString('utf8'), draft);
  assert.doesNotMatch(document.getElementById('saveFileBtn').textContent, /\*/);
  document.getElementById('closeFileEditorBtn').click();
  await until(() => !dialog.open, 'A saved draft did not close');
  assert.equal(prompts.length, 1, 'Saving the bytes did not clear the dirty state');
  assert.deepEqual(f.errors, []);
});

test('editor header orders save details and keeps saved account names live with a hex tooltip', async t => {
  const stored = {
    accounts: [{ id: CURRENT, name: 'My current player' }, { id: TARGET, name: 'Target account' }],
    selectedId: TARGET, displayMode: 'name', useCurrent: false,
  };
  const f = await app(t, false, TARGET, false, stored);
  const { document, window, info } = f;
  info.gameName = 'Resolved Game Name';
  await f.selectAndDecrypt();
  const summary = document.getElementById('workspaceSummary');
  const ids = ['workspaceCounts', 'workspaceCurrentAccount', 'workspaceGameId', 'workspaceGameName'];
  const details = ids.map(id => document.getElementById(id));
  for (const detail of details) assert.equal(summary.contains(detail), true);
  for (let index = 1; index < details.length; index++) {
    assert.ok(details[index - 1].compareDocumentPosition(details[index]) & window.Node.DOCUMENT_POSITION_FOLLOWING);
  }
  assert.match(summary.textContent.replace(/\s+/g, ' '), /1 save.*1 file.*Current account.*My current player.*PPSA12345.*Resolved Game Name/i);
  assert.equal(document.getElementById('workspaceAccountId').title, CURRENT);
  assert.equal(document.getElementById('addCurrentAccountBtn').hidden, true);
  const name = document.querySelector(`#savedAccountRows input[data-account-id="${CURRENT}"]`);
  name.value = 'Renamed current player';
  name.dispatchEvent(new window.Event('input', { bubbles: true }));
  name.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await until(() => document.getElementById('workspaceAccountId').textContent === name.value, 'The inline header account did not update after renaming');
  assert.match(summary.textContent, /Renamed current player/);
  assert.equal(document.getElementById('workspaceAccountId').title, CURRENT);
  assert.equal(document.getElementById('workspaceGameName').textContent, 'Resolved Game Name');
  assert.deepEqual(f.errors, []);
});

test('Add Account stays beside the target selector only while the current account is unknown', async t => {
  const f = await app(t, false);
  const { document, window, calls, state } = f;
  await f.selectAndDecrypt();
  const add = document.getElementById('addCurrentAccountBtn');
  const group = add.closest('.workspace-target-group');
  assert.ok(group, 'The Add Account button must share the target selector group');
  assert.equal(group.contains(document.getElementById('targetAccountSelect')), true);
  assert.equal(add.closest('#workspaceMoreOptions'), null);
  assert.equal(add.hidden, false);
  assert.equal(add.disabled, false);
  add.click();
  await until(() => document.getElementById('accountNameDialog').open, 'The adjacent button did not open account naming');
  document.getElementById('accountNameInput').value = 'Added current player';
  document.getElementById('accountNameForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => calls.add.length === 1 && add.hidden, 'The known account button did not hide after saving');
  assert.equal(document.getElementById('workspaceAccountId').textContent, 'Added current player');
  const remove = document.querySelector(`#savedAccountRows button[data-action="remove"][data-account-id="${CURRENT}"]`);
  assert.ok(remove);
  remove.click();
  await until(() => !state.accounts.some(account => account.id === CURRENT) && !add.hidden, 'Removing the current account did not restore Add Account');
  assert.equal(add.disabled, false);
  assert.equal(document.getElementById('workspaceAccountId').textContent, CURRENT);
  assert.equal(document.getElementById('workspaceAccountId').title, CURRENT);
  assert.deepEqual(f.errors, []);
});

test('external workspaces display resolved game names and never borrow a stale selected game', async t => {
  const f = await app(t, false);
  const { document, calls, info } = f;
  await f.selectAndDecrypt();
  info.titleId = 'PPSA54321';
  info.gameName = 'Imported Game';
  document.getElementById('decryptExternalBtn').click();
  await until(() => calls.jobs.filter(job => job.operation === 'decrypt').length === 2, 'The external workspace did not decrypt');
  await f.idle();
  assert.equal(document.getElementById('workspaceGameId').textContent, 'PPSA54321');
  assert.equal(document.getElementById('workspaceGameName').textContent, 'Imported Game');
  info.titleId = 'PPSA99999';
  delete info.gameName;
  document.getElementById('decryptExternalBtn').click();
  await until(() => calls.jobs.filter(job => job.operation === 'decrypt').length === 3, 'The unknown workspace did not decrypt');
  await f.idle();
  assert.equal(document.getElementById('workspaceGameId').textContent, 'PPSA99999');
  assert.equal(document.getElementById('workspaceGameName').textContent, 'Unknown title');
  assert.doesNotMatch(document.getElementById('workspaceSummary').textContent, /Test Game|Imported Game/);
  assert.deepEqual(f.errors, []);
});

test('mixed batches show multiple accounts, PPSAs and game names in the same summary', async t => {
  const f = await app(t, false);
  const { document, info } = f;
  batchWorkspace(info);
  info.saves.forEach((save, index) => { save.gameName = index === 0 ? 'First Game' : 'Second Game'; });
  await f.selectAndDecrypt();
  const summary = document.getElementById('workspaceSummary');
  assert.match(summary.textContent.replace(/\s+/g, ' '), /5 saves.*5 file.*Multiple accounts.*Multiple PPSAs.*Multiple games/i);
  assert.equal(summary.contains(document.getElementById('workspaceCurrentAccount')), true);
  assert.equal(document.getElementById('workspaceBatchAccountId').hidden, false);
  assert.equal(document.getElementById('addCurrentAccountBtn').hidden, true);
  assert.deepEqual(f.errors, []);
});

// Function = Found Offset
function foundEditorOffset(document) {
  const found = document.getElementById('mySavesStatus').textContent.match(/at 0x([0-9a-f]+)/i);
  assert.ok(found, 'The editor did not report a found offset');
  return parseInt(found[1], 16);
}

// Function = Find Draft Bytes
test('hex Find searches unsaved bytes and advances, wraps and resets for a new query or mode', async t => {
  const f = await app(t, false);
  const { document, window } = f;
  window.saveEditor.read = async () => ({ data: Buffer.alloc(64, 0x20).toString('base64') });
  await f.selectAndDecrypt();
  openWorkspaceLeaf(f, 'DATA/save.dat');
  await until(() => document.getElementById('fileEditorDialog').open, 'The hex editor did not open');
  await f.idle();
  const editor = document.getElementById('fileEditor');
  const search = document.getElementById('editorSearch');
  const mode = document.getElementById('editorMode');
  editor.value = editor.value.replace(/^(00000000\s+)20 20/m, (_, prefix) => `${prefix}41 42`).replace(/^(00000020\s+)20 20/m, (_, prefix) => `${prefix}41 42`);
  editor.dispatchEvent(new window.Event('input'));
  assert.equal(mode.value, 'hex');
  assert.match(document.getElementById('saveFileBtn').textContent, /\*/);
  const find = (query, offset) => {
    if (search.value !== query) {
      search.value = query;
      search.dispatchEvent(new window.Event('input'));
    }
    document.getElementById('editorFindNext').click();
    assert.equal(foundEditorOffset(document), parseInt(offset, 16));
  };
  find('41 42', '0');
  find('41 42', '20');
  find('41 42', '0');
  find('20 20', '2');
  find('41 42', '0');
  find('41 42', '20');
  mode.value = 'text'; mode.dispatchEvent(new window.Event('change'));
  mode.value = 'hex'; mode.dispatchEvent(new window.Event('change'));
  find('41 42', '0');
  assert.match(document.getElementById('saveFileBtn').textContent, /\*/);
  assert.deepEqual(f.calls.writes, []);
  assert.deepEqual(f.errors, []);
});

test('Text Find keeps original positions after Unicode and wraps literal matches', async t => {
  const f = await app(t, false);
  const { document, window } = f;
  const text = 'İx[a] X[A]';
  window.saveEditor.read = async () => ({ data: Buffer.from(text).toString('base64') });
  await f.selectAndDecrypt();
  openWorkspaceLeaf(f, 'DATA/save.dat');
  await f.idle();
  chooseEditorMode(f, 'text');
  const editor = document.getElementById('fileEditor');
  editor.setSelectionRange(0, 0);
  document.getElementById('editorSearch').value = 'x[a]';
  for (const expected of [1, 6, 1]) {
    document.getElementById('editorFindNext').click();
    assert.deepEqual([editor.selectionStart, editor.selectionEnd], [expected, expected + 4]);
  }
  document.getElementById('editorSearch').value = 'i\u0307';
  document.getElementById('editorFindNext').click();
  assert.equal(editor.value.slice(editor.selectionStart, editor.selectionEnd), 'İ');
});

test('Hex Find and Go select exact bytes in a pasted draft with irregular row lengths', async t => {
  const f = await app(t, false);
  const { document, window } = f;
  await f.selectAndDecrypt();
  openWorkspaceLeaf(f, 'DATA/save.dat');
  await f.idle();
  const editor = document.getElementById('fileEditor');
  editor.value = '00 01\n02 03 04\n05 06';
  editor.dispatchEvent(new window.Event('input'));
  document.getElementById('editorSearch').value = '03 04';
  document.getElementById('editorFindNext').click();
  assert.equal(foundEditorOffset(document), 3);
  assert.equal(editor.value.slice(editor.selectionStart, editor.selectionEnd), '03 04');
  document.getElementById('editorOffset').value = '6';
  document.getElementById('editorGoOffset').click();
  assert.equal(editor.value.slice(editor.selectionStart, editor.selectionEnd), '06');
  assert.deepEqual(f.errors, []);
});

// Function = Validate Search
test('hex Find explains an incomplete draft without changing its bytes', async t => {
  const f = await app(t, false);
  const { document, window, calls } = f;
  window.saveEditor.read = async () => ({ data: Buffer.from([0, 0, 0, 0]).toString('base64') });
  await f.selectAndDecrypt();
  openWorkspaceLeaf(f, 'DATA/save.dat');
  await until(() => document.getElementById('fileEditorDialog').open, 'The hex editor did not open');
  await f.idle();
  const editor = document.getElementById('fileEditor');
  editor.value = '00 0'; editor.dispatchEvent(new window.Event('input'));
  document.getElementById('editorSearch').value = '00';
  document.getElementById('editorFindNext').click();
  assert.match(document.getElementById('mySavesStatus').textContent, /complete|invalid|hex|bytes/i);
  assert.equal(editor.value, '00 0');
  assert.match(document.getElementById('saveFileBtn').textContent, /\*/);
  assert.deepEqual(calls.writes, []);
  assert.deepEqual(f.errors, []);
});

// Function = Reset File Search
test('opening a different file resets the hex Find position', async t => {
  const f = await app(t, false);
  const { document, window, info } = f;
  info.files.push({ path: 'OTHER/save.dat', size: 64, protected: false });
  window.saveEditor.read = async ({ path }) => {
    const bytes = Buffer.alloc(64);
    for (const offset of path === 'DATA/save.dat' ? [0, 32] : [16, 48]) Buffer.from('AB').copy(bytes, offset);
    return { data: bytes.toString('base64') };
  };
  await f.selectAndDecrypt();
  openWorkspaceLeaf(f, 'DATA/save.dat');
  await until(() => document.getElementById('fileEditorDialog').open, 'The first editor did not open');
  await f.idle();
  document.getElementById('editorSearch').value = '41 42';
  const find = () => document.getElementById('editorFindNext').click();
  find(); find();
  assert.equal(foundEditorOffset(document), 0x20);
  openWorkspaceLeaf(f, 'OTHER/save.dat');
  await until(() => document.getElementById('editorFileName').textContent === 'OTHER/save.dat', 'The second file did not open');
  await f.idle();
  find();
  assert.equal(foundEditorOffset(document), 0x10);
  assert.deepEqual(f.errors, []);
});

// Function = Cancel Byte Count
test('a pending byte count cannot update another file or a closed editor', async t => {
  const f = await app(t, false);
  const { document, window, info } = f;
  info.files.push({ path: 'OTHER/save.dat', size: 3, protected: false });
  window.saveEditor.read = async ({ path }) => ({ data: Buffer.from(path === 'DATA/save.dat' ? 'first file' : 'new').toString('base64') });
  window.saveTransfer.confirm = async () => true;
  await f.selectAndDecrypt();
  openWorkspaceLeaf(f, 'DATA/save.dat');
  await until(() => document.getElementById('fileEditorDialog').open, 'The first editor did not open');
  await f.idle();
  const editor = document.getElementById('fileEditor');
  const count = document.getElementById('editorByteCount');
  chooseEditorMode(f, 'text');
  editor.value = 'x'.repeat(4096); editor.dispatchEvent(new window.Event('input'));
  openWorkspaceLeaf(f, 'OTHER/save.dat');
  await until(() => document.getElementById('editorFileName').textContent === 'OTHER/save.dat', 'The second editor did not open');
  await f.idle();
  await until(() => count.textContent === '3 bytes', 'The second file count is incorrect');
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.equal(count.textContent, '3 bytes');
  chooseEditorMode(f, 'text');
  editor.value = 'é'.repeat(2048); editor.dispatchEvent(new window.Event('input'));
  document.getElementById('closeFileEditorBtn').click();
  await until(() => !document.getElementById('fileEditorDialog').open, 'The editor did not close');
  await f.idle();
  const closedCount = count.textContent;
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.equal(count.textContent, closedCount);
  assert.deepEqual(f.errors, []);
});

// Function = Jump Draft Offset
test('Go to offset follows the current grown and shortened draft byte length', async t => {
  const f = await app(t, false);
  const { document, window, calls } = f;
  window.saveEditor.read = async () => ({ data: Buffer.alloc(16).toString('base64') });
  await f.selectAndDecrypt();
  openWorkspaceLeaf(f, 'DATA/save.dat');
  await until(() => document.getElementById('fileEditorDialog').open, 'The editor did not open');
  await f.idle();
  const editor = document.getElementById('fileEditor');
  const offset = document.getElementById('editorOffset');
  const status = document.getElementById('mySavesStatus');
  const mode = document.getElementById('editorMode');
  editor.value = window.EditorBytes.formatHex(new Uint8Array(64));
  editor.dispatchEvent(new window.Event('input'));
  offset.value = '30';
  document.getElementById('editorGoOffset').click();
  assert.match(status.textContent, /offset 0x30\b/);
  assert.equal(editor.selectionStart, editor.value.indexOf('00000030  00') + 10);
  assert.equal(editor.selectionEnd, editor.selectionStart + 2);
  editor.value = window.EditorBytes.formatHex(Buffer.from('abcd!'));
  editor.dispatchEvent(new window.Event('input'));
  document.getElementById('editorGoOffset').click();
  assert.match(status.textContent, /offset 0x4\b/);
  assert.equal(editor.selectionStart, editor.value.indexOf('21'));
  assert.equal(editor.selectionEnd, editor.selectionStart + 2);
  mode.value = 'text';
  mode.dispatchEvent(new window.Event('change'));
  editor.value = 'é☃';
  editor.dispatchEvent(new window.Event('input'));
  document.getElementById('editorGoOffset').click();
  assert.match(status.textContent, /offset 0x4\b/, 'Text offsets must use UTF-8 bytes rather than character count');
  assert.equal(editor.value.slice(editor.selectionStart, editor.selectionEnd), '☃');
  assert.equal(editor.value, 'é☃');
  assert.match(document.getElementById('saveFileBtn').textContent, /\*/);
  assert.deepEqual(calls.writes, []);
  assert.deepEqual(f.errors, []);
});

// Function = Validate Draft Offset
test('Go to offset leaves incomplete and empty drafts and their cursor unchanged', async t => {
  const f = await app(t, false);
  const { document, window, calls } = f;
  window.saveEditor.read = async () => ({ data: Buffer.alloc(16).toString('base64') });
  await f.selectAndDecrypt();
  openWorkspaceLeaf(f, 'DATA/save.dat');
  await until(() => document.getElementById('fileEditorDialog').open, 'The editor did not open');
  await f.idle();
  const editor = document.getElementById('fileEditor');
  document.getElementById('editorOffset').value = '10';
  editor.value = '00 0';
  editor.dispatchEvent(new window.Event('input'));
  editor.setSelectionRange(2, 2);
  document.getElementById('editorGoOffset').click();
  assert.match(document.getElementById('mySavesStatus').textContent, /complete|invalid|hex|bytes/i);
  assert.equal(editor.value, '00 0');
  assert.equal(editor.selectionStart, 2);
  assert.equal(editor.selectionEnd, 2);
  editor.value = '';
  editor.dispatchEvent(new window.Event('input'));
  editor.setSelectionRange(0, 0);
  document.getElementById('editorGoOffset').click();
  assert.match(document.getElementById('mySavesStatus').textContent, /empty|no bytes/i);
  assert.equal(editor.value, '');
  assert.equal(editor.selectionStart, 0);
  assert.equal(document.getElementById('fileEditorDialog').open, true);
  assert.match(document.getElementById('saveFileBtn').textContent, /\*/);
  assert.deepEqual(calls.writes, []);
  assert.deepEqual(f.errors, []);
});

// Function = Dismiss Editor Menu
test('Escape dismisses More before asking to discard an editor draft', async t => {
  const f = await app(t, false);
  const { document, window, calls } = f;
  await f.selectAndDecrypt();
  openWorkspaceLeaf(f, 'DATA/save.dat');
  await until(() => document.getElementById('fileEditorDialog').open, 'The editor did not open');
  await f.idle();
  const editor = document.getElementById('fileEditor');
  const dialog = document.getElementById('fileEditorDialog');
  const more = document.getElementById('fileMoreBtn');
  const menu = document.getElementById('fileMoreOptions');
  const prompts = [];
  window.saveTransfer.confirm = async message => { prompts.push(message); return false; };
  chooseEditorMode(f, 'text');
  editor.value = 'keep this draft';
  editor.dispatchEvent(new window.Event('input'));
  for (const origin of [more, document.getElementById('replaceFileBtn')]) {
    more.click();
    assert.equal(menu.hidden, false);
    origin.focus();
    const escape = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    origin.dispatchEvent(escape);
    await pause();
    assert.equal(escape.defaultPrevented, true);
    assert.equal(menu.hidden, true);
    assert.equal(more.getAttribute('aria-expanded'), 'false');
    assert.equal(document.activeElement, more);
    assert.equal(prompts.length, 0, 'Dismissing More must not ask to discard the draft');
    assert.equal(dialog.open, true);
    assert.equal(editor.value, 'keep this draft');
    assert.match(document.getElementById('saveFileBtn').textContent, /\*/);
  }
  editor.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await until(() => prompts.length === 1, 'The next Escape did not ask to close the dirty editor');
  await f.idle();
  assert.equal(dialog.open, true);
  assert.equal(editor.value, 'keep this draft');
  assert.deepEqual(calls.writes, []);
  assert.deepEqual(f.errors, []);
});

// Function = Cancel Editor Menu
test('native cancel respects More dismissal and the app-close editor lock', async t => {
  const f = await app(t, false);
  const { document, window, calls } = f;
  await f.selectAndDecrypt();
  openWorkspaceLeaf(f, 'DATA/save.dat');
  await until(() => document.getElementById('fileEditorDialog').open, 'The editor did not open');
  await f.idle();
  const editor = document.getElementById('fileEditor');
  const dialog = document.getElementById('fileEditorDialog');
  const more = document.getElementById('fileMoreBtn');
  const menu = document.getElementById('fileMoreOptions');
  const prompts = [];
  window.saveTransfer.confirm = async message => { prompts.push(message); return false; };
  chooseEditorMode(f, 'text');
  editor.value = 'keep while closing';
  editor.dispatchEvent(new window.Event('input'));
  more.click();
  await calls.closeFlush();
  const blocked = new window.Event('cancel', { cancelable: true });
  dialog.dispatchEvent(blocked);
  await pause();
  assert.equal(blocked.defaultPrevented, true);
  assert.equal(prompts.length, 0);
  assert.equal(dialog.open, true);
  assert.equal(editor.value, 'keep while closing');
  calls.closeResume();
  await f.idle();
  if (menu.hidden) more.click();
  const dismiss = new window.Event('cancel', { cancelable: true });
  dialog.dispatchEvent(dismiss);
  await pause();
  assert.equal(dismiss.defaultPrevented, true);
  assert.equal(menu.hidden, true);
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, more);
  assert.equal(prompts.length, 0);
  assert.equal(dialog.open, true);
  dialog.dispatchEvent(new window.Event('cancel', { cancelable: true }));
  await until(() => prompts.length === 1, 'A second native cancel did not ask to close the dirty editor');
  await f.idle();
  assert.equal(dialog.open, true);
  assert.equal(editor.value, 'keep while closing');
  assert.deepEqual(calls.writes, []);
  assert.deepEqual(f.errors, []);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const sourceRoot = path.join(__dirname, '..');
const PC = '__local_pc__';
const owner = '11223344';
const firstId = `${owner}/PPSA12345`;
const plain = (value) => JSON.parse(JSON.stringify(value));
const pause = () => new Promise((resolve) => setTimeout(resolve, 15));

// Function Test Console
async function discoverConsole(document) {
  document.getElementById('discoverBtn').click();
  await until(() => document.querySelector('#consoleLocatorRows input[data-role="ofw"][value="192.168.0.125"]'), 'The discovered fixture PS5 was unavailable as an OFW target');
  document.querySelector('#consoleLocatorRows input[data-role="ofw"][value="192.168.0.125"]').click();
  await until(() => document.getElementById('consoleSelect').value === '192.168.0.125', 'The OFW target was not selected');
}

// Function Test Inventory
function inventory(root = '/pc/Saves', active = true) {
  return {
    root, active, warnings: [],
    users: [{ id: owner, name: 'PC user' }, { id: 'unassigned', name: 'Unassigned' }],
    entries: [
      { id: firstId, owner, title: 'PPSA12345', name: 'PC Adventure', localSource: 'pc', files: [
        { file: 'sdimg_DATA', path: `${firstId}/sdimg_DATA`, size: 4096, sha256: '' },
        { file: 'sdimg_sce_sdmemory', path: `${firstId}/sdimg_sce_sdmemory`, size: 1024, sha256: '' },
      ] },
      { id: 'PPSA54321', owner: 'unassigned', title: 'PPSA54321', name: 'PC Racing', localSource: 'pc', files: [
        { file: 'sdimg_OTHER', path: 'PPSA54321/sdimg_OTHER', size: 2048, sha256: '' },
      ] },
    ],
  };
}

// Function Test Wait
async function until(condition, message) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(message);
    await pause();
  }
}

// Function Test Idle
async function idle(context) {
  await until(() => !context.document.getElementById('refreshMySavesBtn').disabled, 'Local save operation did not finish');
}

// Function Test App
async function app({ profiles = true, active = true, folder = '/pc/Saves', profilesError = false } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(error.message));
  const dom = new JSDOM(fs.readFileSync(path.join(sourceRoot, 'electron/index.html'), 'utf8'), {
    url: `file://${path.join(sourceRoot, 'electron/index.html')}`,
    runScripts: 'dangerously', resources: 'usable', virtualConsole,
    beforeParse(window) {
      window.TextEncoder = TextEncoder;
      window.TextDecoder = TextDecoder;
      window.eval(fs.readFileSync(path.join(__dirname, 'fixtures/cmp_bridge.js'), 'utf8'));
      const loader = require('../electron/skins.cjs');
      const bundled = path.join(sourceRoot, 'electron/skins');
      window.saveTransfer.getSkins = async () => loader.loadSkins(bundled, '/nonexistent');
      window.saveTransfer.getSkinMascot = async (id) => loader.getSkinMascot(bundled, '/nonexistent', id);
      window.saveTransfer.openSkinsFolder = async () => '/Skins';
      if (!profiles) window.saveTransfer.localProfiles = async () => ({ profiles: [] });
      if (profilesError) window.saveTransfer.localProfiles = async () => { throw new Error('test transfer profile unavailable'); };
      const data = inventory(folder, active);
      if (!folder) { data.entries = []; data.users = []; }
      const pc = window.pcFixture = {
        state: data, chooseResult: inventory(),
        calls: { state: 0, inventory: 0, choose: 0, active: [], prepare: [], files: [], backups: [], jobs: [], encrypt: [], writes: [], temporaryRelease: [], stageRelease: [] },
      };
      window.saveTransfer.localPcState = async () => { pc.calls.state++; return plain({ root: pc.state.root, active: pc.state.active, warnings: pc.state.warnings }); };
      window.saveTransfer.localPcInventory = async () => { pc.calls.inventory++; return plain(pc.state); };
      window.saveTransfer.chooseLocalPcFolder = async () => {
        pc.calls.choose++;
        if (!pc.chooseResult) return null;
        pc.state = plain(pc.chooseResult);
        return plain(pc.state);
      };
      window.saveTransfer.setLocalPcActive = async (value) => { pc.calls.active.push(value); pc.state.active = value; };
      window.saveTransfer.prepareLocalPcUpload = async (value) => {
        pc.calls.prepare.push(plain(value));
        return { folder: '/app/staging/upload-1/PPSA12345', titleId: 'PPSA12345', files: ['sdimg_DATA', 'sdimg_sce_sdmemory'], stageId: `stage-${pc.calls.prepare.length}` };
      };
      window.saveTransfer.releaseLocalPcUpload = async id => { pc.calls.stageRelease.push(id); return true; };
      window.saveEditor.releaseTemporary = async id => { pc.calls.temporaryRelease.push(id); return true; };
      window.saveTransfer.importLocalSave = async (value) => {
        window.cmpFixture.calls.imports.push(value);
        return { backup: '/app/backups/old-save' };
      };
      window.saveEditor.localFile = async (value) => {
        pc.calls.files.push(plain(value));
        return [`${pc.state.root}/${value.entryId}/${value.filename}`];
      };
      const info = { root: '/app/workspace', titleId: 'PPSA12345', accountId: '0000000000000001', files: [{ path: 'DATA/save.dat', size: 8, protected: false }] };
      window.saveEditor.chooseOutput = async () => '/exports/resigned.zip';
      window.saveEditor.run = async (value) => {
        pc.calls.jobs.push(plain(value));
        return value.operation === 'decrypt'
          ? { workspace: '/app/workspace', archivePath: '/app/decrypted.zip', info: plain(info), temporaryId: `workspace-${pc.calls.jobs.length}` }
          : { output: value.output };
      };
      window.saveEditor.read = async () => ({ data: Buffer.from('original').toString('base64') });
      window.saveEditor.write = async (value) => { pc.calls.writes.push(plain(value)); return plain(info); };
      window.saveEditor.backupLocal = async (value) => { pc.calls.backups.push(plain(value)); return '/app/backups/old-save'; };
      window.saveEditor.encryptLocal = async (value) => {
        pc.calls.encrypt.push(plain(value));
        return { output: '/app/encrypted/sdimg_DATA', archivePath: '/app/encrypted.zip', temporaryId: `replacement-${pc.calls.encrypt.length}` };
      };
    },
  });
  await new Promise((resolve) => dom.window.addEventListener('load', resolve, { once: true }));
  await pause();
  assert.deepEqual(errors, []);
  return { dom, window: dom.window, document: dom.window.document, errors, pc: dom.window.pcFixture };
}

// Function Test Library
async function openLibrary(context) {
  context.document.querySelector('[data-page="library"]').click();
  await until(() => context.document.querySelector(`#localConsoleSelect option[value="${PC}"]`), 'Local PC option was not available');
  await pause();
}

// Function Test PC Selection
async function selectPc(context) {
  const select = context.document.getElementById('localConsoleSelect');
  select.value = PC;
  select.dispatchEvent(new context.window.Event('change'));
  await until(() => context.document.getElementById('cmpLibraryTree').textContent.includes('PC Adventure'), 'PC folder inventory did not load');
}

// Function Test Save Selection
async function selectFirstFile(context) {
  await until(() => context.document.querySelector('#cmpLibraryTree .cmp-file-open'), 'No PC save file was rendered');
  context.document.querySelector('#cmpLibraryTree .cmp-file-open').click();
  await until(() => !context.document.getElementById('selectedSavePanel').hidden, 'PC save was not selected');
}

// Function Test Editor
async function openTextEditorFile(context) {
  const row = context.document.querySelector('#workspaceFiles tr[data-file-path]');
  assert.ok(row, 'No decrypted workspace file was rendered');
  row.dispatchEvent(new context.window.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  await until(() => !context.document.getElementById('fileEditorPanel').hidden, 'Workspace file editor did not open');
  const mode = context.document.getElementById('editorMode');
  mode.value = 'text';
  mode.dispatchEvent(new context.window.Event('change'));
}

test('Local PC remains available without a prepared transfer profile and browses an unassigned save', async () => {
  const context = await app({ profiles: false, active: false, folder: '' });
  const { dom, document, pc, window, errors } = context;
  try {
    const originalPaths = ['output', 'assets', 'metadata'].map((id) => document.getElementById(id).value);
    await openLibrary(context);
    assert.equal(document.getElementById('localConsoleSelect').value, PC);
    assert.equal(document.getElementById('chooseLocalPcFolderBtn').hidden, false);
    document.getElementById('chooseLocalPcFolderBtn').click();
    await until(() => document.getElementById('cmpLibraryTree').textContent.includes('PC Racing'), 'Chosen PC folder was not listed');
    assert.equal(pc.calls.choose, 1);
    assert.ok(document.getElementById('localPcFolderLabel').textContent.includes('/pc/Saves'));
    assert.equal(document.querySelectorAll('#cmpLibraryTree .cmp-file-open').length, 3);
    const users = document.getElementById('localUserSelect');
    assert.ok([...users.options].some((option) => option.value === 'unassigned' && option.textContent.includes('Unassigned')));
    users.value = 'unassigned'; users.dispatchEvent(new window.Event('change'));
    await until(() => document.querySelectorAll('#cmpLibraryTree .cmp-file-open').length === 1, 'PC source-user filter was not applied');
    assert.ok(document.getElementById('cmpLibraryTree').textContent.includes('sdimg_OTHER'));
    assert.deepEqual(['output', 'assets', 'metadata'].map((id) => document.getElementById(id).value), originalPaths);
    assert.deepEqual(errors, []);
  } finally { await pause(); dom.window.close(); }
});

test('a failed console profile lookup still allows Local PC browsing', async () => {
  const context = await app({ profilesError: true });
  try {
    await openLibrary(context);
    await idle(context);
    assert.equal(context.document.getElementById('localConsoleSelect').value, PC);
    assert.ok(context.document.getElementById('cmpLibraryTree').textContent.includes('PC Adventure'));
    assert.ok(context.document.getElementById('mySavesLog').textContent.includes('test transfer profile unavailable'));
    assert.deepEqual(context.errors, []);
  } finally { context.dom.window.close(); }
});

test('switching to Local PC preserves transfer paths and returning to a console restores its files', async () => {
  const context = await app({ active: false });
  const { dom, document, window, pc, errors } = context;
  try {
    await openLibrary(context);
    await until(() => document.querySelectorAll('#cmpLibraryTree .cmp-file-open').length === 6, 'Console inventory did not load');
    const originalPaths = ['output', 'assets', 'metadata'].map((id) => document.getElementById(id).value);
    await selectPc(context);
    assert.deepEqual(['output', 'assets', 'metadata'].map((id) => document.getElementById(id).value), originalPaths);
    assert.equal(document.getElementById('chooseLocalPcFolderBtn').hidden, false);
    const select = document.getElementById('localConsoleSelect');
    select.value = 'HOST1'; select.dispatchEvent(new window.Event('change'));
    await until(() => document.querySelectorAll('#cmpLibraryTree .cmp-file-open').length === 6, 'Console inventory was not restored');
    assert.equal(document.getElementById('chooseLocalPcFolderBtn').hidden, true);
    assert.ok(pc.calls.active.includes(false));
    assert.deepEqual(errors, []);
  } finally { await pause(); dom.window.close(); }
});

test('canceling a PC folder choice keeps the previous inventory', async () => {
  const context = await app({ profiles: false });
  const { dom, document, pc, errors } = context;
  try {
    await openLibrary(context);
    await until(() => document.getElementById('cmpLibraryTree').textContent.includes('PC Adventure'), 'Saved PC folder was not restored');
    const original = document.getElementById('cmpLibraryTree').textContent;
    pc.chooseResult = null;
    document.getElementById('chooseLocalPcFolderBtn').click();
    await until(() => pc.calls.choose === 1, 'Folder chooser was not called');
    await pause();
    assert.equal(document.getElementById('cmpLibraryTree').textContent, original);
    assert.ok(document.getElementById('localPcFolderLabel').textContent.includes('/pc/Saves'));
    assert.deepEqual(errors, []);
  } finally { await pause(); dom.window.close(); }
});

test('Local PC files remain usable in Garlic Classic', async () => {
  const context = await app({ profiles: false });
  const { dom, document, window, pc, errors } = context;
  try {
    await openLibrary(context);
    await until(() => document.getElementById('cmpLibraryTree').textContent.includes('PC Adventure'), 'PC inventory was not loaded');
    const layout = document.getElementById('uiLayout');
    layout.value = 'classic'; layout.dispatchEvent(new window.Event('change'));
    await until(() => document.querySelector('#myTitleEntries button'), 'Classic PC titles were not rendered');
    document.querySelector('#myTitleEntries button').click();
    await until(() => document.querySelector('#mySaveEntries button'), 'Classic PC files were not rendered');
    document.querySelector('#mySaveEntries button').click();
    await idle(context);
    document.getElementById('mySaveDecryptBtn').click();
    await until(() => pc.calls.files.length === 1, 'Classic PC decryption was not requested');
    await idle(context);
    assert.equal(pc.calls.files[0].localSource, 'pc');
    assert.equal(document.getElementById('localConsoleSelect').value, PC);
    assert.deepEqual(errors, []);
  } finally { await pause(); dom.window.close(); }
});

test('Classic Local PC context menus open by keyboard and mouse and export the chosen file', async () => {
  const context = await app({ profiles: false });
  const { dom, document, window, errors } = context;
  try {
    await openLibrary(context);
    const layout = document.getElementById('uiLayout');
    layout.value = 'classic'; layout.dispatchEvent(new window.Event('change'));
    await until(() => document.querySelector('#myTitleEntries tr'), 'Classic PC titles were not rendered');
    const title = document.querySelector('#myTitleEntries tr');
    title.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true }));
    assert.deepEqual([...document.querySelectorAll('.save-context-menu:not(.workspace-file-menu) button')].map((button) => button.textContent), ['View saves']);
    document.querySelector('.save-context-menu:not(.workspace-file-menu) button').click();
    await until(() => document.querySelector('#mySaveEntries tr'), 'Classic PC files were not rendered');
    const file = document.querySelector('#mySaveEntries tr');
    file.getBoundingClientRect = () => ({ left: 100, bottom: 120 });
    file.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));
    const menu = document.querySelector('.save-context-menu:not(.workspace-file-menu)');
    assert.ok(menu);
    assert.equal(menu.style.left, '120px');
    assert.equal(menu.style.top, '120px');
    assert.equal(menu.querySelectorAll('button').length, 7);
    [...menu.querySelectorAll('button')].find((button) => button.textContent === 'Export original').click();
    await until(() => window.cmpFixture.calls.exports.length === 1, 'Keyboard PC export was not requested');
    await idle(context);
    assert.equal(window.cmpFixture.calls.exports[0].localSource, 'pc');
    assert.equal(window.cmpFixture.calls.exports[0].filename, 'sdimg_DATA');
    assert.equal(document.querySelector('.save-context-menu:not(.workspace-file-menu)'), null);
    const other = [...document.querySelectorAll('#mySaveEntries tr')].find((row) => row.textContent.includes('sdimg_sce_sdmemory'));
    other.dispatchEvent(new window.MouseEvent('contextmenu', { clientX: 200, clientY: 180, bubbles: true, cancelable: true }));
    [...document.querySelectorAll('.save-context-menu:not(.workspace-file-menu) button')].find((button) => button.textContent === 'Export original').click();
    await until(() => window.cmpFixture.calls.exports.length === 2, 'Mouse PC export was not requested');
    await idle(context);
    assert.equal(window.cmpFixture.calls.exports[1].filename, 'sdimg_sce_sdmemory');
    assert.deepEqual(errors, []);
  } finally { await pause(); dom.window.close(); }
});

for (const view of ['classic', 'cmp']) {
  test(`${view} Local PC context actions stop when another save selection is canceled`, async () => {
    const context = await app({ profiles: false });
    const { dom, document, window, pc, errors } = context;
    try {
      await openLibrary(context);
      if (view === 'classic') {
        const layout = document.getElementById('uiLayout');
        layout.value = 'classic'; layout.dispatchEvent(new window.Event('change'));
        await until(() => document.querySelector('#myTitleEntries button'), 'Classic PC titles were not rendered');
        document.querySelector('#myTitleEntries button').click();
        await until(() => document.querySelector('#mySaveEntries button'), 'Classic PC files were not rendered');
        document.querySelector('#mySaveEntries button').click();
        await idle(context);
      } else await selectFirstFile(context);
      document.getElementById('mySaveDecryptBtn').click();
      await until(() => pc.calls.jobs.some((job) => job.operation === 'decrypt')
        && document.querySelector('.wizard-panel[data-wizard="2"]').classList.contains('active'), 'First PC save did not decrypt');
      await idle(context);
      document.querySelector('.wizard-panel[data-wizard="2"] [data-go="1"]').click();
      document.querySelector('.wizard-panel[data-wizard="1"] [data-go="0"]').click();
      let prompts = 0;
      window.confirm = () => { prompts++; return false; };
      const target = view === 'classic'
        ? [...document.querySelectorAll('#mySaveEntries tr')].find((row) => row.textContent.includes('sdimg_sce_sdmemory'))
        : [...document.querySelectorAll('#cmpLibraryTree .cmp-file')].find((row) => row.textContent.includes('sdimg_sce_sdmemory'));
      assert.ok(target);
      target.dispatchEvent(new window.MouseEvent('contextmenu', { clientX: 30, clientY: 30, bubbles: true, cancelable: true }));
      const selector = view === 'classic' ? '.save-context-menu:not(.workspace-file-menu) button' : '.cmp-context button';
      [...document.querySelectorAll(selector)].find((button) => button.textContent === 'Export original').click();
      await pause();
      assert.equal(prompts, 1);
      assert.equal(window.cmpFixture.calls.exports.length, 0);
      assert.ok(document.getElementById('selectedSaveDetails').textContent.includes('sdimg_DATA'));
      assert.equal(document.getElementById('workspacePanel').hidden, false);
      assert.equal(pc.calls.jobs.length, 1);
      if (view === 'classic') {
        target.querySelector('button').click();
        assert.equal(prompts, 2);
        assert.ok(document.getElementById('selectedSaveDetails').textContent.includes('sdimg_DATA'));
      }
      assert.deepEqual(errors, []);
    } finally { await pause(); dom.window.close(); }
  });
}

test('a late PC inventory cannot replace a newly selected console', async () => {
  const context = await app();
  const { dom, document, window, errors } = context;
  try {
    await openLibrary(context);
    await until(() => document.getElementById('cmpLibraryTree').textContent.includes('PC Adventure'), 'PC inventory was not loaded');
    let resolveInventory;
    window.saveTransfer.localPcInventory = () => new Promise((resolve) => { resolveInventory = resolve; });
    document.dispatchEvent(new window.Event('local-save-replaced'));
    assert.equal(typeof resolveInventory, 'function');
    const select = document.getElementById('localConsoleSelect');
    select.value = 'HOST1'; select.dispatchEvent(new window.Event('change'));
    await until(() => document.querySelectorAll('#cmpLibraryTree .cmp-file-open').length === 6, 'Console inventory was not loaded');
    resolveInventory(inventory()); await pause();
    assert.equal(select.value, 'HOST1');
    assert.equal(document.querySelectorAll('#cmpLibraryTree .cmp-file-open').length, 6);
    assert.ok(!document.getElementById('cmpLibraryTree').textContent.includes('PC Adventure'));
    assert.deepEqual(errors, []);
  } finally { await pause(); dom.window.close(); }
});

test('PC decrypt and save-encrypt keep their source context and preserve the workspace during navigation', async () => {
  const context = await app({ profiles: false });
  const { dom, document, window, pc, errors } = context;
  try {
    await openLibrary(context); await selectFirstFile(context);
    document.getElementById('mySaveDecryptBtn').click();
    await until(() => pc.calls.jobs.some((job) => job.operation === 'decrypt')
      && document.querySelector('.wizard-panel[data-wizard="2"]').classList.contains('active'), 'PC decryption did not open a workspace');
    await idle(context);
    assert.equal(pc.calls.files[0].localSource, 'pc');
    assert.equal(pc.calls.files[0].entryId, firstId);
    assert.equal(pc.calls.jobs[0].operation, 'decrypt');
    document.querySelector('#workspaceFiles tr[data-file-path]').click();
    await pause();
    assert.equal(document.getElementById('fileEditorPanel').hidden, true, 'Selecting a file should not open its editor');
    assert.equal(document.getElementById('fileEditorDialog').open, false);
    await openTextEditorFile(context);
    await until(() => !document.getElementById('fileEditorPanel').hidden, 'Workspace file did not open');
    assert.equal(document.getElementById('fileEditorDialog').open, true);
    const editor = document.getElementById('fileEditor');
    editor.value = 'edited PC save'; editor.dispatchEvent(new window.Event('input'));
    document.querySelector('[data-page="library"]').click();
    await pause(); await pause();
    assert.equal(document.getElementById('workspacePanel').hidden, false);
    assert.equal(document.getElementById('fileEditor').value, 'edited PC save');
    document.getElementById('saveEncryptFileBtn').click();
    await until(() => window.cmpFixture.calls.imports.length === 1, 'Encrypted PC save was not written back');
    await idle(context);
    assert.ok(document.getElementById('mySavesLog').textContent.includes('/app/backups/old-save'));
    assert.equal(pc.calls.writes.length, 1);
    assert.equal(pc.calls.encrypt.length, 1);
    const replacement = window.cmpFixture.calls.imports[0];
    assert.equal(replacement.localSource, 'pc');
    assert.equal(replacement.entryId, firstId);
    assert.equal(replacement.source, '/app/encrypted/sdimg_DATA');
    assert.deepEqual(errors, []);
  } finally { await pause(); dom.window.close(); }
});

test('switching PC saves requires closing the previous decrypted workspace before writeback', async () => {
  const context = await app({ profiles: false });
  const { dom, document, window, pc, errors } = context;
  try {
    await openLibrary(context); await selectFirstFile(context);
    document.getElementById('mySaveDecryptBtn').click();
    await until(() => pc.calls.jobs.some((job) => job.operation === 'decrypt')
      && document.querySelector('.wizard-panel[data-wizard="2"]').classList.contains('active'), 'First PC save did not decrypt');
    await idle(context);
    await openTextEditorFile(context);
    await until(() => !document.getElementById('fileEditorPanel').hidden, 'First PC editor file did not open');
    await idle(context);
    const editor = document.getElementById('fileEditor');
    editor.value = 'unsaved first-save edits'; editor.dispatchEvent(new window.Event('input'));
    document.querySelector('.wizard-panel[data-wizard="2"] [data-go="1"]').click();
    document.querySelector('.wizard-panel[data-wizard="1"] [data-go="0"]').click();
    const second = [...document.querySelectorAll('#cmpLibraryTree .cmp-file-open')]
      .find((button) => button.textContent.includes('sdimg_OTHER'));
    assert.ok(second);
    const prompts = [];
    window.confirm = (message) => { prompts.push(message); return false; };
    second.click();
    await idle(context);
    assert.equal(prompts.length, 1);
    assert.equal(document.getElementById('selectedSaveName').textContent, 'PC Adventure');
    assert.equal(document.getElementById('workspacePanel').hidden, false);
    assert.equal(editor.value, 'unsaved first-save edits');
    assert.ok(document.querySelector('#cmpLibraryTree .cmp-file-selected').textContent.includes('sdimg_DATA'));
    window.confirm = (message) => { prompts.push(message); return true; };
    second.click();
    await idle(context);
    assert.equal(prompts.length, 2);
    assert.equal(document.getElementById('selectedSaveName').textContent, 'PC Racing');
    assert.equal(document.getElementById('workspacePanel').hidden, true);
    assert.equal(document.getElementById('fileEditorDialog').open, false, 'Switching source saves should close the old file editor');
    assert.equal(document.querySelector('.wizard-panel[data-wizard="2"]').classList.contains('active'), false);
    document.getElementById('encryptSaveBtn').click();
    await idle(context);
    assert.equal(pc.calls.encrypt.length, 0);
    assert.equal(window.cmpFixture.calls.imports.length, 0);
    assert.equal(pc.calls.jobs.length, 1);
    assert.deepEqual(errors, []);
  } finally { await pause(); dom.window.close(); }
});

test('PC export, resign and replacement use the selected PC file', async () => {
  const context = await app({ profiles: false });
  const { dom, document, window, pc, errors } = context;
  try {
    await openLibrary(context); await selectFirstFile(context);
    document.getElementById('saveMoreBtn').click(); document.getElementById('mySaveExportBtn').click();
    await until(() => window.cmpFixture.calls.exports.length === 1, 'PC export was not requested');
    await idle(context);
    assert.equal(window.cmpFixture.calls.exports[0].localSource, 'pc');
    document.getElementById('saveMoreBtn').click(); document.getElementById('mySaveResignBtn').click();
    document.getElementById('resignAccountId').value = '0000000000000001';
    document.getElementById('confirmResignBtn').click();
    await until(() => pc.calls.jobs.some((job) => job.operation === 'resign'), 'PC resign was not requested');
    await idle(context);
    assert.equal(pc.calls.files.at(-1).localSource, 'pc');
    assert.deepEqual(pc.calls.jobs.at(-1).inputs, [`/pc/Saves/${firstId}/sdimg_DATA`]);
    document.getElementById('saveMoreBtn').click(); document.getElementById('mySaveImportBtn').click();
    await until(() => document.getElementById('importModal').open, 'Replacement confirmation did not open');
    document.getElementById('confirmImportBtn').click();
    await until(() => window.cmpFixture.calls.imports.length === 1, 'PC replacement was not requested');
    await idle(context);
    assert.equal(window.cmpFixture.calls.imports[0].localSource, 'pc');
    assert.equal(window.cmpFixture.calls.imports[0].entryId, firstId);
    assert.equal(document.getElementById('localConsoleSelect').value, PC);
    assert.deepEqual(errors, []);
  } finally { await pause(); dom.window.close(); }
});

test('PC upload prepares the complete title folder and retains the chosen destination user', async () => {
  const context = await app({ profiles: false });
  const { dom, document, window, pc, errors } = context;
  try {
    await discoverConsole(document);
    await openLibrary(context); await selectFirstFile(context);
    document.getElementById('uploadSaveBtn').click();
    await until(() => pc.calls.prepare.length === 1 && [...document.getElementById('uploadSaveSelect').selectedOptions].some((option) => option.value === 'external'), 'PC upload was not prepared as an external save');
    assert.equal(pc.calls.prepare[0].entryId, firstId);
    const destination = document.getElementById('userSelect');
    destination.value = '22aabbcc';
    document.getElementById('confirmUploadBtn').click();
    await until(() => window.cmpFixture.calls.uploads.length === 1, 'PC upload did not start');
    const upload = window.cmpFixture.calls.uploads[0];
    assert.equal(upload.uploadKind, 'external');
    assert.equal(upload.externalImage, '/app/staging/upload-1/PPSA12345');
    assert.equal(upload.titleId, 'PPSA12345');
    assert.equal(upload.userId, '22aabbcc');
    assert.deepEqual(Array.from(upload.entryIds), []);
    assert.notEqual(upload.output, '/pc/Saves');
    assert.deepEqual(errors, []);
  } finally { await pause(); dom.window.close(); }
});

test('PC upload continues with its staged folder after fetching console metadata', async () => {
  const context = await app({ profiles: false });
  const { dom, document, window, pc, errors } = context;
  try {
    await discoverConsole(document);
    await openLibrary(context); await selectFirstFile(context);
    window.saveTransfer.inventory = async () => { throw new Error('No cached metadata'); };
    window.saveTransfer.download = async (value) => { window.cmpFixture.calls.downloads.push(value); };
    document.getElementById('uploadSaveBtn').click();
    await until(() => window.cmpFixture.calls.downloads.length === 1, 'Console metadata fetch did not start');
    assert.equal(window.cmpFixture.calls.downloads[0].metadataOnly, true);
    window.cmpFixture.emit({ type: 'entries', entries: window.cmpFixture.entries, users: window.cmpFixture.users });
    window.cmpFixture.emit({ type: 'done', metadataOnly: true, users: window.cmpFixture.users });
    await until(() => [...document.getElementById('uploadSaveSelect').selectedOptions].some((option) => option.value === 'external'), 'PC selection did not continue after metadata fetch');
    document.getElementById('userSelect').value = '22aabbcc';
    document.getElementById('confirmUploadBtn').click();
    await until(() => window.cmpFixture.calls.uploads.length === 1, 'PC upload did not start after metadata fetch');
    const upload = window.cmpFixture.calls.uploads[0];
    assert.equal(upload.externalImage, '/app/staging/upload-1/PPSA12345');
    assert.equal(upload.titleId, 'PPSA12345');
    assert.equal(upload.userId, '22aabbcc');
    assert.equal(pc.calls.prepare.length, 1);
    assert.deepEqual(errors, []);
  } finally { await pause(); dom.window.close(); }
});

for (const outcome of ['cancel', 'error', 'rejection']) {
  test(`a PC metadata ${outcome} cannot select an old PC folder in a later ordinary upload`, async () => {
    const context = await app({ profiles: false });
    const { dom, document, window, errors } = context;
    try {
      await discoverConsole(document);
      await openLibrary(context); await selectFirstFile(context);
      window.saveTransfer.inventory = async () => { throw new Error('No cached metadata'); };
      window.saveTransfer.download = async (value) => {
        window.cmpFixture.calls.downloads.push(value);
        if (outcome === 'rejection') throw new Error('Test metadata failure');
      };
      document.getElementById('uploadSaveBtn').click();
      await until(() => window.cmpFixture.calls.downloads.length === 1, 'PC metadata fetch did not start');
      if (outcome === 'cancel') document.getElementById('cancelBtn').click();
      if (outcome === 'error') window.cmpFixture.emit({ type: 'error', message: 'Test metadata failure' });
      await until(() => document.getElementById('cancelBtn').disabled, 'Stopped metadata fetch remained busy');
      window.saveTransfer.inventory = async () => ({ entries: window.cmpFixture.entries, users: window.cmpFixture.users });
      document.getElementById('uploadBtn').click();
      await until(() => document.getElementById('uploadSaveSelect').options.length === window.cmpFixture.entries.length, 'Ordinary upload did not load console entries');
      assert.ok(![...document.getElementById('uploadSaveSelect').options].some((option) => option.value === 'external'));
      assert.equal(document.getElementById('externalTitleId').value, '');
      assert.equal(window.cmpFixture.calls.uploads.length, 0);
      assert.deepEqual(errors, []);
    } finally { await pause(); dom.window.close(); }
  });
}

test('Local PC user filters reuse the loaded inventory and explicit refresh scans again', async () => {
  const context = await app({ profiles: false });
  const { document, window, pc, dom } = context;
  try {
    await openLibrary(context); await idle(context);
    const scans = pc.calls.inventory;
    const users = document.getElementById('localUserSelect');
    users.value = owner; users.dispatchEvent(new window.Event('change'));
    await idle(context);
    assert.equal(pc.calls.inventory, scans);
    assert.ok(document.getElementById('cmpLibraryTree').textContent.includes('PC Adventure'));
    assert.ok(!document.getElementById('cmpLibraryTree').textContent.includes('PC Racing'));
    users.value = ''; users.dispatchEvent(new window.Event('change'));
    await idle(context);
    assert.equal(pc.calls.inventory, scans);
    assert.ok(document.getElementById('cmpLibraryTree').textContent.includes('PC Racing'));
    pc.state.entries[0].name = 'Updated PC Adventure';
    document.getElementById('refreshMySavesBtn').click();
    await until(() => pc.calls.inventory > scans, 'Explicit refresh did not scan the PC folder');
    await idle(context);
    assert.ok(document.getElementById('cmpLibraryTree').textContent.includes('Updated PC Adventure'));
    assert.deepEqual(context.errors, []);
  } finally { dom.window.close(); }
});

test('owned workspace cleanup follows confirmed closure and preserves canceled edits', async () => {
  const context = await app({ profiles: false });
  const { document, window, pc, dom } = context;
  try {
    await openLibrary(context); await selectFirstFile(context);
    document.getElementById('mySaveDecryptBtn').click(); await idle(context);
    await openTextEditorFile(context);
    await until(() => !document.getElementById('fileEditorPanel').hidden, 'Editor did not open');
    const editor = document.getElementById('fileEditor');
    editor.value = 'unsaved changes'; editor.dispatchEvent(new window.Event('input'));
    document.querySelector('[data-page="settings"]').click();
    document.querySelector('[data-page="library"]').click(); await pause();
    assert.deepEqual(pc.calls.temporaryRelease, []);
    window.confirm = () => false;
    document.getElementById('closeWorkspaceBtn').click(); await pause();
    assert.deepEqual(pc.calls.temporaryRelease, []);
    assert.equal(editor.value, 'unsaved changes');
    assert.equal(document.getElementById('workspacePanel').hidden, false);
    window.confirm = () => true;
    document.getElementById('closeWorkspaceBtn').click();
    await until(() => pc.calls.temporaryRelease.length === 1, 'Owned workspace was not released');
    assert.equal(document.getElementById('fileEditorDialog').open, false, 'Closing the workspace should close its file editor');
    assert.deepEqual(pc.calls.temporaryRelease, ['workspace-1']);
    document.getElementById('closeWorkspaceBtn').click(); await pause();
    assert.deepEqual(pc.calls.temporaryRelease, ['workspace-1']);
    assert.deepEqual(context.errors, []);
  } finally { dom.window.close(); }
});

test('replacement cleanup waits for the import attempt and leaves the editable workspace open', async () => {
  const context = await app({ profiles: false });
  const { document, window, pc, dom } = context;
  try {
    await openLibrary(context); await selectFirstFile(context);
    document.getElementById('mySaveDecryptBtn').click(); await idle(context);
    let imported;
    window.saveTransfer.importLocalSave = () => new Promise(resolve => { imported = resolve; });
    document.getElementById('encryptSaveBtn').click();
    await until(() => typeof imported === 'function', 'Replacement import did not start');
    assert.deepEqual(pc.calls.temporaryRelease, []);
    imported({ backup: '/safe/backup' }); await idle(context);
    assert.deepEqual(pc.calls.temporaryRelease, ['replacement-1']);
    assert.equal(document.getElementById('workspacePanel').hidden, false);
    assert.ok(document.getElementById('mySavesLog').textContent.includes('/safe/backup'));
    assert.deepEqual(context.errors, []);
  } finally { dom.window.close(); }
});

test('saved workspace edits still require discard confirmation before owned cleanup', async () => {
  const context = await app({ profiles: false });
  const { document, window, pc, dom } = context;
  try {
    await openLibrary(context); await selectFirstFile(context);
    document.getElementById('mySaveDecryptBtn').click(); await idle(context);
    await openTextEditorFile(context);
    await until(() => !document.getElementById('fileEditorPanel').hidden, 'Editor did not open');
    const editor = document.getElementById('fileEditor');
    editor.value = 'saved but not encrypted'; editor.dispatchEvent(new window.Event('input'));
    document.getElementById('saveFileBtn').click(); await idle(context);
    assert.equal(document.getElementById('saveFileBtn').textContent, 'Save changes');
    const prompts = [];
    window.confirm = message => { prompts.push(message); return false; };
    document.getElementById('closeWorkspaceBtn').click(); await pause();
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /not been encrypted/);
    assert.equal(document.getElementById('workspacePanel').hidden, false);
    assert.deepEqual(pc.calls.temporaryRelease, []);
    window.confirm = () => true;
    document.getElementById('closeWorkspaceBtn').click(); await pause();
    assert.deepEqual(pc.calls.temporaryRelease, ['workspace-1']);
    assert.deepEqual(context.errors, []);
  } finally { dom.window.close(); }
});

test('canceling a decrypt-and-export replacement keeps the workspace and skips export', async () => {
  const context = await app({ profiles: false });
  const { document, window, pc, dom } = context;
  try {
    await openLibrary(context); await selectFirstFile(context);
    document.getElementById('mySaveDecryptBtn').click(); await idle(context);
    let downloads = 0;
    window.saveEditor.downloadArchive = async () => { downloads++; return '/export/old.zip'; };
    window.confirm = () => false;
    document.getElementById('saveMoreBtn').click();
    document.getElementById('decryptExportBtn').click(); await idle(context);
    assert.equal(downloads, 0);
    assert.equal(pc.calls.jobs.length, 1);
    assert.deepEqual(pc.calls.temporaryRelease, []);
    assert.equal(document.getElementById('workspacePanel').hidden, false);
    assert.deepEqual(context.errors, []);
  } finally { dom.window.close(); }
});

test('failed replacement cleanup releases its staging without closing the editable workspace', async () => {
  const context = await app({ profiles: false });
  const { document, window, pc, dom } = context;
  try {
    await openLibrary(context); await selectFirstFile(context);
    document.getElementById('mySaveDecryptBtn').click(); await idle(context);
    window.saveTransfer.importLocalSave = async () => { throw new Error('Test import failure'); };
    document.getElementById('encryptSaveBtn').click(); await idle(context);
    assert.deepEqual(pc.calls.temporaryRelease, ['replacement-1']);
    assert.equal(document.getElementById('workspacePanel').hidden, false);
    assert.equal(document.getElementById('mySavesStatus').textContent, 'Test import failure');
    assert.deepEqual(context.errors, []);
  } finally { dom.window.close(); }
});

test('decrypt replacement releases the previous owned workspace only after a successful new result', async () => {
  const context = await app({ profiles: false });
  const { document, window, pc, dom } = context;
  try {
    await openLibrary(context); await selectFirstFile(context);
    document.getElementById('mySaveDecryptBtn').click(); await idle(context);
    const run = window.saveEditor.run;
    window.saveEditor.chooseInput = async () => ['/external/save'];
    window.confirm = () => false;
    document.getElementById('decryptExternalBtn').click(); await idle(context);
    assert.equal(pc.calls.jobs.length, 1);
    assert.deepEqual(pc.calls.temporaryRelease, []);
    window.confirm = () => true;
    window.saveEditor.run = async () => { throw new Error('Test decrypt failure'); };
    document.getElementById('decryptExternalBtn').click(); await idle(context);
    assert.deepEqual(pc.calls.temporaryRelease, []);
    assert.equal(document.getElementById('workspacePanel').hidden, false);
    window.saveEditor.run = run;
    document.getElementById('decryptExternalBtn').click(); await idle(context);
    assert.deepEqual(pc.calls.temporaryRelease, ['workspace-1']);
    document.getElementById('closeWorkspaceBtn').click(); await pause();
    assert.deepEqual(pc.calls.temporaryRelease, ['workspace-1', 'workspace-2']);
    assert.deepEqual(context.errors, []);
  } finally { dom.window.close(); }
});

test('a workspace without an ownership token never requests filesystem cleanup', async () => {
  const context = await app({ profiles: false });
  const { document, window, pc, dom } = context;
  try {
    await openLibrary(context);
    window.saveEditor.chooseInput = async () => ['/external/save'];
    window.saveEditor.run = async () => ({ workspace: '/user/kept-folder', archivePath: '/user/kept.zip', info: { files: [] } });
    document.getElementById('decryptExternalBtn').click(); await idle(context);
    document.getElementById('closeWorkspaceBtn').click(); await pause();
    assert.deepEqual(pc.calls.temporaryRelease, []);
    assert.deepEqual(context.errors, []);
  } finally { dom.window.close(); }
});

test('PC staging stays through metadata success and is released after the upload completes', async () => {
  const context = await app({ profiles: false });
  const { document, window, pc, dom } = context;
  try {
    await discoverConsole(document);
    await openLibrary(context); await selectFirstFile(context);
    window.saveTransfer.inventory = async () => { throw new Error('No prior metadata'); };
    window.saveTransfer.download = async value => { window.cmpFixture.calls.downloads.push(value); };
    window.saveTransfer.upload = async value => { window.cmpFixture.calls.uploads.push(value); };
    document.getElementById('uploadSaveBtn').click();
    await until(() => window.cmpFixture.calls.downloads.length === 1, 'Metadata fetch did not begin');
    assert.deepEqual(pc.calls.stageRelease, []);
    window.cmpFixture.emit({ type: 'entries', entries: window.cmpFixture.entries, users: window.cmpFixture.users });
    window.cmpFixture.emit({ type: 'done', metadataOnly: true, users: window.cmpFixture.users });
    await until(() => !document.getElementById('confirmUploadBtn').hidden, 'Upload selection did not resume');
    assert.deepEqual(pc.calls.stageRelease, []);
    document.getElementById('confirmUploadBtn').click();
    await until(() => window.cmpFixture.calls.uploads.length === 1, 'Upload did not begin');
    assert.equal(window.cmpFixture.calls.uploads[0].localPcUploadId, 'stage-1');
    assert.deepEqual(pc.calls.stageRelease, []);
    window.cmpFixture.emit({ type: 'done', message: 'Upload finished.' });
    await until(() => pc.calls.stageRelease.length === 1, 'Completed upload stage was not released');
    assert.deepEqual(pc.calls.stageRelease, ['stage-1']);
    assert.deepEqual(context.errors, []);
  } finally { dom.window.close(); }
});

for (const outcome of ['cancel', 'error', 'rejection']) {
  test(`PC staging is released after a metadata ${outcome}`, async () => {
    const context = await app({ profiles: false });
    const { document, window, pc, dom } = context;
    try {
      await discoverConsole(document);
      await openLibrary(context); await selectFirstFile(context);
      window.saveTransfer.inventory = async () => { throw new Error('No prior metadata'); };
      window.saveTransfer.download = async value => {
        window.cmpFixture.calls.downloads.push(value);
        if (outcome === 'rejection') throw new Error('Test metadata failure');
      };
      document.getElementById('uploadSaveBtn').click();
      await until(() => window.cmpFixture.calls.downloads.length === 1, 'Metadata fetch did not begin');
      if (outcome === 'cancel') document.getElementById('cancelBtn').click();
      if (outcome === 'error') window.cmpFixture.emit({ type: 'error', message: 'Test metadata failure' });
      await until(() => pc.calls.stageRelease.length === 1, 'Discarded stage was not released');
      assert.deepEqual(pc.calls.stageRelease, ['stage-1']);
      assert.deepEqual(context.errors, []);
    } finally { dom.window.close(); }
  });
}

test('manual external selection releases a PC stage only after a new file is chosen', async () => {
  const context = await app({ profiles: false });
  const { document, window, pc, dom } = context;
  try {
    await discoverConsole(document);
    await openLibrary(context); await selectFirstFile(context);
    document.getElementById('uploadSaveBtn').click();
    await until(() => !document.getElementById('confirmUploadBtn').hidden, 'PC upload was not prepared');
    window.saveTransfer.chooseExternalSave = async () => null;
    document.getElementById('addExternalSaveBtn').click(); await pause();
    assert.deepEqual(pc.calls.stageRelease, []);
    window.saveTransfer.chooseExternalSave = async () => '/user/PPSA99999/save';
    document.getElementById('addExternalSaveBtn').click();
    await until(() => pc.calls.stageRelease.length === 1, 'Overridden PC stage was not released');
    assert.deepEqual(pc.calls.stageRelease, ['stage-1']);
    assert.deepEqual(context.errors, []);
  } finally { dom.window.close(); }
});

test('an inactive PC folder is not scanned on console startup, refresh or source changes', async () => {
  const context = await app({ active: false });
  const { document, window, pc, dom } = context;
  try {
    assert.equal(pc.calls.inventory, 0);
    await openLibrary(context); await idle(context);
    const consoleSelect = document.getElementById('localConsoleSelect');
    assert.equal(consoleSelect.value, 'HOST1');
    assert.equal(pc.calls.state, 1);
    assert.equal(pc.calls.inventory, 0);
    document.getElementById('refreshMySavesBtn').click(); await idle(context);
    assert.equal(pc.calls.state, 2);
    assert.equal(pc.calls.inventory, 0);
    await selectPc(context); await idle(context);
    assert.equal(pc.calls.inventory, 1);
    consoleSelect.value = 'HOST1'; consoleSelect.dispatchEvent(new window.Event('change'));
    await idle(context);
    assert.equal(pc.calls.inventory, 1);
    document.getElementById('refreshMySavesBtn').click(); await idle(context);
    assert.equal(pc.calls.inventory, 1);
    await selectPc(context); await idle(context);
    assert.equal(pc.calls.inventory, 2);
    document.getElementById('refreshMySavesBtn').click(); await idle(context);
    assert.equal(pc.calls.inventory, 3);
    assert.deepEqual(context.errors, []);
  } finally { dom.window.close(); }
});

for (const options of [{ profiles: true, active: true }, { profiles: false, active: false }]) {
  test(`${options.active ? 'stored PC selection' : 'PC fallback'} scans once when the library opens`, async () => {
    const context = await app(options);
    try {
      await openLibrary(context); await idle(context);
      assert.equal(context.document.getElementById('localConsoleSelect').value, PC);
      assert.equal(context.pc.calls.state, 1);
      assert.equal(context.pc.calls.inventory, 1);
      assert.deepEqual(context.errors, []);
    } finally { context.dom.window.close(); }
  });
}

test('save cancellation uses the editor and stays busy until the original job settles', async () => {
  const context = await app({ profiles: false });
  const { document, window, pc, dom } = context;
  let rejectJob, resolveCancel, editorCancels = 0, transferCancels = 0;
  try {
    await openLibrary(context); await selectFirstFile(context); await idle(context);
    window.saveEditor.run = () => new Promise((resolve, reject) => { rejectJob = reject; });
    window.saveEditor.cancel = () => { editorCancels++; return new Promise(resolve => { resolveCancel = resolve; }); };
    window.saveTransfer.cancel = async () => { transferCancels++; };
    document.getElementById('mySaveDecryptBtn').click();
    await until(() => rejectJob, 'Decrypt job did not start');
    document.getElementById('cancelBtn').click();
    await until(() => resolveCancel, 'Editor cancellation did not start');
    assert.equal(editorCancels, 1);
    assert.equal(transferCancels, 0);
    assert.equal(document.getElementById('refreshMySavesBtn').disabled, true);
    assert.equal(document.getElementById('discoverBtn').disabled, true);
    resolveCancel(true); await pause();
    assert.equal(document.getElementById('refreshMySavesBtn').disabled, true);
    assert.equal(document.getElementById('discoverBtn').disabled, true);
    assert.equal(document.getElementById('cancelBtn').disabled, true);
    rejectJob(new Error('Save job aborted')); await idle(context);
    assert.equal(document.getElementById('discoverBtn').disabled, false);
    assert.equal(document.getElementById('mySavesStatus').textContent, 'Save operation canceled.');
    assert.equal(document.getElementById('status').textContent, 'Save operation canceled.');
    assert.equal(transferCancels, 0);
    assert.deepEqual(pc.calls.temporaryRelease, []);
    assert.deepEqual(context.errors, []);
  } finally { dom.window.close(); }
});

test('canceling during a file dialog keeps the operation busy without claiming it stopped', async () => {
  const context = await app({ profiles: false });
  const { document, window, pc, dom } = context;
  let resolveInput, transferCancels = 0, editorCancels = 0;
  try {
    await openLibrary(context); await idle(context);
    window.saveEditor.chooseInput = () => new Promise(resolve => { resolveInput = resolve; });
    window.saveEditor.cancel = async () => { editorCancels++; return false; };
    window.saveTransfer.cancel = async () => { transferCancels++; };
    document.getElementById('decryptExternalBtn').click();
    await until(() => resolveInput, 'Input dialog did not open');
    document.getElementById('cancelBtn').click(); await pause();
    assert.equal(editorCancels, 1);
    assert.equal(transferCancels, 0);
    assert.equal(document.getElementById('refreshMySavesBtn').disabled, true);
    assert.equal(document.getElementById('discoverBtn').disabled, true);
    assert.equal(document.getElementById('cancelBtn').disabled, false);
    assert.match(document.getElementById('mySavesStatus').textContent, /Close any open file dialog or wait/);
    resolveInput([]); await idle(context);
    assert.equal(pc.calls.jobs.length, 0);
    assert.deepEqual(context.errors, []);
  } finally { dom.window.close(); }
});

for (const finished of [false, true]) {
test(`a late save cancellation reply cannot clear a later ${finished ? 'completed' : 'active'} transfer or its status`, async () => {
  const context = await app({ profiles: false });
  const { document, window, dom } = context;
  let rejectJob, resolveCancel, downloads = 0;
  try {
    await discoverConsole(document);
    await openLibrary(context); await selectFirstFile(context); await idle(context);
    window.saveEditor.run = () => new Promise((resolve, reject) => { rejectJob = reject; });
    window.saveEditor.cancel = () => new Promise(resolve => { resolveCancel = resolve; });
    document.getElementById('mySaveDecryptBtn').click();
    await until(() => rejectJob, 'Decrypt job did not start');
    document.getElementById('cancelBtn').click();
    await until(() => resolveCancel, 'Cancellation did not start');
    rejectJob(new Error('Save job aborted')); await idle(context);
    window.saveTransfer.download = async () => { downloads++; };
    document.getElementById('downloadBtn').click();
    await until(() => downloads === 1, 'Later transfer did not start');
    if (finished) window.cmpFixture.emit({ type: 'done', message: 'Later transfer complete.' });
    const message = document.getElementById('status').textContent;
    resolveCancel(true); await pause();
    assert.equal(document.getElementById('discoverBtn').disabled, !finished);
    assert.equal(document.getElementById('downloadBtn').disabled, !finished);
    assert.equal(document.getElementById('status').textContent, message);
    assert.deepEqual(context.errors, []);
  } finally { dom.window.close(); }
});
}

test('canceling an export waits for the copy to finish and retains its successful result', async () => {
  const context = await app({ profiles: false });
  const { document, window, dom } = context;
  let resolveExport, editorCancels = 0, transferCancels = 0;
  try {
    await openLibrary(context); await selectFirstFile(context); await idle(context);
    window.saveTransfer.exportLocalSave = () => new Promise(resolve => { resolveExport = resolve; });
    window.saveEditor.cancel = async () => { editorCancels++; return false; };
    window.saveTransfer.cancel = async () => { transferCancels++; };
    document.getElementById('mySaveExportBtn').click();
    await until(() => resolveExport, 'Export did not start');
    document.getElementById('cancelBtn').click(); await pause();
    assert.equal(editorCancels, 1);
    assert.equal(transferCancels, 0);
    assert.equal(document.getElementById('refreshMySavesBtn').disabled, true);
    assert.match(document.getElementById('mySavesStatus').textContent, /Close any open file dialog or wait/);
    resolveExport({ destination: '/exports/finished-save' }); await idle(context);
    assert.equal(document.getElementById('mySavesStatus').textContent, 'Original save exported to /exports/finished-save');
    assert.deepEqual(context.errors, []);
  } finally { dom.window.close(); }
});

test('a late save cancellation reply preserves a newly decrypted workspace', async () => {
  const context = await app({ profiles: false });
  const { document, window, pc, dom } = context;
  let rejectJob, resolveCancel;
  try {
    await openLibrary(context); await selectFirstFile(context); await idle(context);
    const run = window.saveEditor.run;
    window.saveEditor.run = () => new Promise((resolve, reject) => { rejectJob = reject; });
    window.saveEditor.cancel = () => new Promise(resolve => { resolveCancel = resolve; });
    document.getElementById('mySaveDecryptBtn').click();
    await until(() => rejectJob, 'First save job did not start');
    document.getElementById('cancelBtn').click();
    await until(() => resolveCancel, 'Save cancellation did not start');
    rejectJob(new Error('Canceled first job')); await idle(context);
    window.saveEditor.run = run;
    document.getElementById('mySaveDecryptBtn').click(); await idle(context);
    const message = document.getElementById('mySavesStatus').textContent;
    assert.equal(document.getElementById('workspacePanel').hidden, false);
    assert.equal(pc.calls.jobs.length, 1);
    resolveCancel(true); await pause();
    assert.equal(document.getElementById('workspacePanel').hidden, false);
    assert.equal(document.getElementById('mySavesStatus').textContent, message);
    assert.deepEqual(pc.calls.temporaryRelease, []);
    assert.deepEqual(context.errors, []);
  } finally { dom.window.close(); }
});

test('a delayed native selection confirmation gates the requested context action', async () => {
  const context = await app({ profiles: false });
  const { dom, document, window, pc } = context;
  try {
    await openLibrary(context); await selectFirstFile(context);
    document.getElementById('mySaveDecryptBtn').click(); await idle(context);
    document.querySelector('.wizard-panel[data-wizard="2"] [data-go="1"]').click();
    document.querySelector('.wizard-panel[data-wizard="1"] [data-go="0"]').click();
    let complete, prompts = 0;
    window.saveTransfer.confirm = async () => { prompts++; return new Promise(resolve => { complete = resolve; }); };
    const target = [...document.querySelectorAll('#cmpLibraryTree .cmp-file')].find(row => row.textContent.includes('sdimg_sce_sdmemory'));
    const openExport = () => {
      target.dispatchEvent(new window.MouseEvent('contextmenu', { clientX: 30, clientY: 30, bubbles: true, cancelable: true }));
      [...document.querySelectorAll('.cmp-context button')].find(button => button.textContent === 'Export original').click();
    };
    openExport();
    await until(() => typeof complete === 'function', 'Native confirmation did not open');
    assert.equal(prompts, 1);
    assert.equal(window.cmpFixture.calls.exports.length, 0);
    assert.equal(document.getElementById('workspacePanel').hidden, false);
    complete(false); await idle(context);
    assert.equal(window.cmpFixture.calls.exports.length, 0);
    assert.deepEqual(pc.calls.temporaryRelease, []);
    complete = null;
    openExport();
    await until(() => typeof complete === 'function', 'Second native confirmation did not open');
    complete(true);
    await until(() => window.cmpFixture.calls.exports.length === 1, 'Confirmed export did not run');
    await idle(context);
    assert.equal(window.cmpFixture.calls.exports[0].filename, 'sdimg_sce_sdmemory');
    assert.equal(pc.calls.temporaryRelease.length, 1);
    assert.deepEqual(context.errors, []);
  } finally { dom.window.close(); }
});

test('a failed native confirmation reports its error and preserves edits until a later confirmation succeeds', async () => {
  const context = await app({ profiles: false });
  const { dom, document, window, pc } = context;
  try {
    await openLibrary(context); await selectFirstFile(context);
    document.getElementById('mySaveDecryptBtn').click(); await idle(context);
    await openTextEditorFile(context); await idle(context);
    const editor = document.getElementById('fileEditor');
    editor.value = 'preserve these edits'; editor.dispatchEvent(new window.Event('input'));
    let prompts = 0;
    window.saveTransfer.confirm = async () => { prompts++; throw new Error('native dialog unavailable'); };
    document.getElementById('closeWorkspaceBtn').click(); await idle(context);
    assert.equal(prompts, 1);
    assert.match(document.getElementById('status').textContent, /Could not show confirmation: native dialog unavailable/);
    assert.equal(document.getElementById('workspacePanel').hidden, false);
    assert.equal(editor.value, 'preserve these edits');
    assert.deepEqual(pc.calls.temporaryRelease, []);
    assert.deepEqual(pc.calls.writes, []);
    assert.deepEqual(pc.calls.encrypt, []);
    window.saveTransfer.confirm = async () => { prompts++; return true; };
    document.getElementById('closeWorkspaceBtn').click(); await idle(context);
    assert.equal(prompts, 2);
    assert.equal(document.getElementById('workspacePanel').hidden, true);
    assert.deepEqual(pc.calls.temporaryRelease, ['workspace-1']);
    assert.deepEqual(context.errors, []);
  } finally { dom.window.close(); }
});

test('canceling while a native close confirmation waits preserves edits after late acceptance', async () => {
  const context = await app({ profiles: false });
  const { dom, document, window, pc } = context;
  try {
    await openLibrary(context); await selectFirstFile(context);
    document.getElementById('mySaveDecryptBtn').click(); await idle(context);
    await openTextEditorFile(context); await idle(context);
    const editor = document.getElementById('fileEditor');
    editor.value = 'keep these edits'; editor.dispatchEvent(new window.Event('input'));
    let complete;
    window.saveTransfer.confirm = async () => new Promise(resolve => { complete = resolve; });
    window.saveEditor.cancel = async () => false;
    document.getElementById('closeWorkspaceBtn').click();
    await until(() => typeof complete === 'function', 'Close confirmation did not open');
    document.getElementById('cancelBtn').click(); await pause();
    complete(true); await idle(context);
    assert.equal(document.getElementById('workspacePanel').hidden, false);
    assert.equal(editor.value, 'keep these edits');
    assert.deepEqual(pc.calls.temporaryRelease, []);
    assert.deepEqual(context.errors, []);
  } finally { dom.window.close(); }
});

test('a late Finish confirmation cannot close a newer transfer session', async () => {
  const context = await app({ profiles: false });
  const { dom, document, window } = context;
  try {
    let complete, finishes = 0;
    window.saveTransfer.confirm = async () => new Promise(resolve => { complete = resolve; });
    window.saveTransfer.finish = async () => { finishes++; };
    window.cmpFixture.emit({ type: 'ready', message: 'First transfer ready', users: [] });
    document.getElementById('finishBtn').click();
    await until(() => typeof complete === 'function', 'Finish confirmation did not open');
    window.cmpFixture.emit({ type: 'error', message: 'First transfer stopped' });
    window.cmpFixture.emit({ type: 'ready', message: 'Second transfer ready', users: [] });
    complete(true); await pause();
    assert.equal(finishes, 0);
    assert.deepEqual(context.errors, []);
  } finally { dom.window.close(); }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { Readable } = require('node:stream');
const { prepareWorkspaceReplacement, replaceWorkspaceFile } = require('../electron/workspace_io.cjs');
const { registerSaveEditor, workspaceInfo, MAX_EDITOR_BYTES } = require('../electron/save_editor.cjs');
const { SaveTemps } = require('../electron/save_temps.cjs');

// Function Replacement Fixture
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'garlic-replace-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const folder = path.join(workspace, 'sdimg_sce_sdmemory');
  await fs.mkdir(folder, { recursive: true });
  const selected = path.join(folder, 'memory.dat');
  const original = Buffer.from([0, 1, 128, 255]);
  const source = path.join(root, 'different-pc-filename.bin');
  const replacement = Buffer.from([255, 0, 254, 42, 5]);
  await fs.writeFile(selected, original);
  await fs.writeFile(source, replacement);
  await fs.writeFile(path.join(workspace, 'chives.json'), '{"title_id":"PPSA12345"}');
  return { root, workspace, folder, selected, source, original, replacement, relative: 'sdimg_sce_sdmemory/memory.dat' };
}

// Function Replacement Module
function isolatedIo(overrides = {}) {
  const module = { exports: {} };
  const filename = path.join(__dirname, '../electron/workspace_io.cjs');
  vm.runInNewContext(syncFs.readFileSync(filename, 'utf8'), { module, require: name => {
    if (name === 'node:fs/promises') return { ...fs, ...overrides };
    if (name === 'node:crypto') return { randomUUID: () => 'owned-test' };
    return require(name);
  } }, { filename });
  return module.exports;
}

// Function Replacement Handlers
function handlers(f, showOpenDialog, showSaveDialog) {
  const routes = new Map();
  registerSaveEditor({ ipcMain: { handle: (name, handler) => routes.set(name, handler) },
    app: { getPath: () => f.root }, dialog: { showOpenDialog, showSaveDialog }, shell: {} });
  return routes;
}

// Function Replacement Cleanup
async function unchanged(f) {
  assert.deepEqual(await fs.readFile(f.selected), f.original);
  assert.deepEqual(await fs.readFile(f.source), f.replacement);
  assert.deepEqual(await fs.readdir(f.folder), ['memory.dat']);
}

test('Replace chooses one PC file and changes bytes at the exact nested workspace name', async t => {
  const f = await fixture(t);
  let options;
  const routes = handlers(f, async value => { options = value; return { canceled: false, filePaths: [f.source] }; });
  const info = await routes.get('save-editor:replace')({}, { root: f.workspace, path: f.relative });
  assert.deepEqual(options.properties, ['openFile']);
  assert.match(options.title, /memory\.dat/);
  assert.deepEqual(await fs.readFile(f.selected), f.replacement);
  assert.deepEqual(await fs.readFile(f.source), f.replacement);
  assert.deepEqual(await fs.readdir(f.folder), ['memory.dat']);
  assert.deepEqual(info.files.map(file => file.path), ['chives.json', f.relative]);
  assert.equal(info.files.find(file => file.path === f.relative).size, f.replacement.length);
  assert.equal(info.titleId, 'PPSA12345');
  assert.equal(info.totalBytes, f.replacement.length + Buffer.byteLength('{"title_id":"PPSA12345"}'));
});

test('Replace streams a file larger than the editor limit without reading it into a buffer', async t => {
  const f = await fixture(t);
  const payload = Buffer.alloc(MAX_EDITOR_BYTES + 65537, 0xa5);
  await fs.writeFile(f.source, payload);
  const io = isolatedIo({ readFile: async () => assert.fail('Replacement must stream file bytes') });
  await io.replaceWorkspaceFile(await io.prepareWorkspaceReplacement(f.workspace, f.relative), f.source);
  assert.deepEqual(await fs.readFile(f.selected), payload);
  assert.deepEqual(await fs.readFile(f.source), payload);
  assert.deepEqual(await fs.readdir(f.folder), ['memory.dat']);
});

test('canceling the replacement dialog changes no files', async t => {
  const f = await fixture(t);
  const routes = handlers(f, async () => ({ canceled: true, filePaths: [] }));
  assert.equal(await routes.get('save-editor:replace')({}, { root: f.workspace, path: f.relative }), null);
  await unchanged(f);
});

test('replacement rejects directories, missing files and traversal before opening the dialog', async t => {
  const f = await fixture(t);
  let opened = 0;
  const routes = handlers(f, async () => { opened++; return { canceled: false, filePaths: [f.source] }; });
  for (const relative of ['../different-pc-filename.bin', '..\\different-pc-filename.bin', '/outside.dat', 'C:\\outside.dat',
    'sdimg_sce_sdmemory', 'missing.dat', 'sdimg_sce_sdmemory/../chives.json']) {
    await assert.rejects(routes.get('save-editor:replace')({}, { root: f.workspace, path: relative }));
  }
  assert.equal(opened, 0);
  await unchanged(f);
});

test('a directory source or the current file itself cannot replace the target', async t => {
  const f = await fixture(t);
  const target = await prepareWorkspaceReplacement(f.workspace, f.relative);
  await assert.rejects(replaceWorkspaceFile(target, f.root), /regular replacement file/);
  await assert.rejects(replaceWorkspaceFile(target, f.selected), /different file/);
  await unchanged(f);
});

test('read-only hardlinked sources are allowed while the same destination inode is rejected', async t => {
  const f = await fixture(t);
  const sourceAlias = path.join(f.root, 'source-alias.bin');
  await fs.link(f.source, sourceAlias);
  await replaceWorkspaceFile(await prepareWorkspaceReplacement(f.workspace, f.relative), sourceAlias);
  assert.deepEqual(await fs.readFile(f.selected), f.replacement);
  assert.deepEqual(await fs.readFile(f.source), f.replacement);
  assert.deepEqual(await fs.readFile(sourceAlias), f.replacement);
  const targetAlias = path.join(f.root, 'target-alias.bin');
  await fs.link(f.selected, targetAlias);
  await assert.rejects(replaceWorkspaceFile(await prepareWorkspaceReplacement(f.workspace, f.relative), targetAlias), /different file/);
});

test('atomic replacement does not modify another hardlink to the original destination', async t => {
  const f = await fixture(t);
  const outsideAlias = path.join(f.root, 'original-link.bin');
  await fs.link(f.selected, outsideAlias);
  await replaceWorkspaceFile(await prepareWorkspaceReplacement(f.workspace, f.relative), f.source);
  assert.deepEqual(await fs.readFile(f.selected), f.replacement);
  assert.deepEqual(await fs.readFile(outsideAlias), f.original);
});

for (const linked of ['source', 'destination', 'parent']) {
  test(`replacement rejects a symbolic ${linked} link`, async t => {
    const f = await fixture(t);
    let selected = f.source, relative = f.relative;
    const link = path.join(f.root, 'linked-source');
    try {
      if (linked === 'source') { await fs.symlink(f.source, link, 'file'); selected = link; }
      else if (linked === 'destination') {
        relative = 'linked-target.dat';
        await fs.symlink(f.source, path.join(f.workspace, relative), 'file');
      } else {
        relative = 'linked-parent/different-pc-filename.bin';
        await fs.symlink(f.root, path.join(f.workspace, 'linked-parent'), process.platform === 'win32' ? 'junction' : 'dir');
      }
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) return t.skip('Symlink creation is unavailable');
      throw error;
    }
    if (linked === 'source') await assert.rejects(replaceWorkspaceFile(await prepareWorkspaceReplacement(f.workspace, relative), selected), /regular replacement file/);
    else await assert.rejects(prepareWorkspaceReplacement(f.workspace, relative), /regular|linked folders/);
    assert.deepEqual(await fs.readFile(f.selected), f.original);
    assert.deepEqual(await fs.readFile(f.source), f.replacement);
  });
}

test('a file changed while the dialog is open is preserved instead of overwritten', async t => {
  const f = await fixture(t);
  const changed = Buffer.from('newer external edit');
  const routes = handlers(f, async () => {
    const incoming = path.join(f.root, 'newer.dat');
    await fs.writeFile(incoming, changed);
    await fs.rename(incoming, f.selected);
    return { canceled: false, filePaths: [f.source] };
  });
  await assert.rejects(routes.get('save-editor:replace')({}, { root: f.workspace, path: f.relative }), /selected file changed/);
  assert.deepEqual(await fs.readFile(f.selected), changed);
  assert.deepEqual(await fs.readFile(f.source), f.replacement);
  assert.deepEqual(await fs.readdir(f.folder), ['memory.dat']);
});

test('a folder swapped while the dialog is open cannot redirect replacement', async t => {
  const f = await fixture(t);
  const moved = path.join(f.root, 'original-folder');
  const routes = handlers(f, async () => {
    await fs.rename(f.folder, moved);
    await fs.mkdir(f.folder);
    await fs.writeFile(f.selected, 'new folder file');
    return { canceled: false, filePaths: [f.source] };
  });
  await assert.rejects(routes.get('save-editor:replace')({}, { root: f.workspace, path: f.relative }), /workspace changed/);
  assert.equal(await fs.readFile(f.selected, 'utf8'), 'new folder file');
  assert.deepEqual(await fs.readFile(path.join(moved, 'memory.dat')), f.original);
  assert.deepEqual(await fs.readFile(f.source), f.replacement);
});

test('a symlink swapped between path inspection and canonical resolution is rejected', async t => {
  const f = await fixture(t);
  const moved = path.join(f.folder, 'moved-memory.dat');
  let swapped = false;
  let linkFailure;
  const io = isolatedIo({ realpath: async selected => {
    if (selected === f.selected && !swapped) {
      swapped = true;
      await fs.rename(f.selected, moved);
      try { await fs.symlink(moved, f.selected, 'file'); }
      catch (error) { linkFailure = error; throw error; }
    }
    return fs.realpath(selected);
  } });
  try {
    await assert.rejects(io.prepareWorkspaceReplacement(f.workspace, f.relative), /selected file changed/);
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(linkFailure?.code)) return t.skip('Symlink creation is unavailable');
    throw error;
  }
  assert.equal(swapped, true);
  assert.deepEqual(await fs.readFile(moved), f.original);
  assert.deepEqual(await fs.readFile(f.source), f.replacement);
});

for (const phase of ['copy', 'backup', 'sync', 'close', 'rename']) {
  test(`replacement ${phase} failure preserves the original and removes owned stages`, async t => {
    const f = await fixture(t);
    const failure = new Error(`${phase} failed`);
    let handles = 0;
    const io = isolatedIo({
      open: async (...args) => {
        const handle = await fs.open(...args);
        handles++;
        let closed = false;
        const destination = args[0].endsWith('.tmp');
        const backup = args[0].endsWith('.backup');
        return {
          stat: options => handle.stat(options),
          createReadStream: options => phase === 'copy' && args[0] === f.source
            ? Readable.from((async function* () { yield Buffer.from('partial'); throw failure; })())
            : handle.createReadStream(options),
          write: async (...values) => { if (phase === 'backup' && backup) { await handle.write('partial'); throw failure; } return handle.write(...values); },
          sync: async () => { if (phase === 'sync' && destination) throw failure; return handle.sync(); },
          close: async () => {
            if (!closed) { closed = true; handles--; await handle.close(); }
            if (phase === 'close' && destination) throw failure;
          },
        };
      },
      rename: async (...args) => { if (phase === 'rename') throw failure; return fs.rename(...args); },
    });
    await assert.rejects(io.replaceWorkspaceFile(await io.prepareWorkspaceReplacement(f.workspace, f.relative), f.source), error => error === failure);
    assert.equal(handles, 0);
    await unchanged(f);
  });
}

for (const extension of ['tmp', 'backup']) {
  test(`a pre-existing replacement ${extension} collision is never removed`, async t => {
    const f = await fixture(t);
    const collision = path.join(f.folder, `.garlic-replace-owned-test.${extension}`);
    await fs.writeFile(collision, 'unrelated user file');
    const io = isolatedIo();
    await assert.rejects(io.replaceWorkspaceFile(await io.prepareWorkspaceReplacement(f.workspace, f.relative), f.source), { code: 'EEXIST' });
    assert.deepEqual(await fs.readFile(f.selected), f.original);
    assert.deepEqual(await fs.readFile(f.source), f.replacement);
    assert.equal(await fs.readFile(collision, 'utf8'), 'unrelated user file');
    assert.deepEqual((await fs.readdir(f.folder)).sort(), [path.basename(collision), 'memory.dat'].sort());
  });
}

test('root and nested chives metadata can be read and exported but not edited, replaced or deleted', async t => {
  const f = await fixture(t);
  const original = await fs.readFile(path.join(f.workspace, 'chives.json'));
  const nested = 'sdimg_sce_sdmemory/CHIVES.Json';
  await fs.writeFile(path.join(f.workspace, nested), original);
  let output = path.join(f.root, 'chives.json');
  const routes = handlers(f, () => assert.fail('Protected files must not open the replacement picker'),
    async () => ({ canceled: false, filePath: output }));
  const info = await workspaceInfo(f.workspace);
  assert.equal(info.files.find(file => file.path === f.relative).readOnly, false);
  for (const relative of ['chives.json', nested]) {
    const request = { root: f.workspace, path: relative };
    assert.equal(info.files.find(file => file.path === relative).readOnly, true);
    assert.equal(info.files.find(file => file.path === relative).protected, true);
    assert.equal((await routes.get('save-editor:read')({}, request)).data, original.toString('base64'));
    await assert.rejects(routes.get('save-editor:write')({}, { ...request, data: 'eA==' }), /read-only/);
    await assert.rejects(routes.get('save-editor:replace')({}, request), /read-only/);
    await assert.rejects(routes.get('save-editor:delete')({}, request), /read-only/);
    await routes.get('save-editor:download-file')({}, request);
    assert.deepEqual(await fs.readFile(output), original);
    assert.deepEqual(await fs.readFile(path.join(f.workspace, relative)), original);
  }
  output = path.join(f.workspace, nested);
  await assert.rejects(routes.get('save-editor:download-file')({}, { root: f.workspace, path: f.relative }), /read-only/);
  await assert.rejects(routes.get('save-editor:download-archive')({}, { archivePath: f.source }), /read-only/);
  assert.deepEqual(await fs.readFile(output), original);
  await assert.rejects(routes.get('save-editor:write')({}, { root: f.workspace, path: nested + '. ', data: 'eA==' }), /read-only/);
});

test('adding files refuses new chives metadata before copying any selected file', async t => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.workspace, 'chives.json'));
  const metadata = path.join(f.root, 'CHIVES.json');
  await fs.writeFile(metadata, '{}');
  const routes = handlers(f, async () => ({ canceled: false, filePaths: [f.source, metadata] }));
  await assert.rejects(routes.get('save-editor:add')({}, { root: f.workspace }), /read-only/);
  assert.deepEqual(await fs.readdir(f.workspace), ['sdimg_sce_sdmemory']);
});

test('an export destination linked to workspace metadata leaves the metadata untouched', async t => {
  const f = await fixture(t);
  const metadata = path.join(f.workspace, 'chives.json');
  const original = await fs.readFile(metadata);
  const alias = path.join(f.root, 'export.dat');
  try { await fs.symlink(metadata, alias, 'file'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('File links unavailable'); throw error; }
  const routes = handlers(f, null, async () => ({ filePath: alias }));
  await assert.rejects(routes.get('save-editor:download-file')({}, { root: f.workspace, path: f.relative }), /read-only/);
  assert.deepEqual(await fs.readFile(metadata), original);
});

test('a failed completion refresh restores the original before reporting failure', async t => {
  const f = await fixture(t);
  const failure = new Error('workspace scan failed');
  await assert.rejects(replaceWorkspaceFile(await prepareWorkspaceReplacement(f.workspace, f.relative), f.source, async ignored => {
    assert.deepEqual(await fs.readFile(f.selected), f.replacement);
    assert.equal(ignored.size, 1);
    const info = await workspaceInfo(f.workspace, ignored);
    assert.equal(info.files.length, 2);
    throw failure;
  }), error => error === failure);
  await unchanged(f);
});

test('the replacement dialog keeps a temporary workspace leased until copying finishes', async t => {
  const f = await fixture(t);
  let store, completeDialog, opened;
  class CapturedTemps extends SaveTemps { constructor(base) { super(base); store = this; } }
  const filename = path.join(__dirname, '../electron/save_editor.cjs');
  const actualRequire = createRequire(filename);
  const context = vm.createContext({ module: { exports: {} }, Buffer, process, URL, setTimeout, clearTimeout, AbortController,
    require: name => name === './save_temps.cjs' ? { SaveTemps: CapturedTemps } : actualRequire(name) });
  vm.runInContext(syncFs.readFileSync(filename, 'utf8'), context);
  const routes = new Map();
  const dialogOpened = new Promise(resolve => { opened = resolve; });
  context.module.exports.registerSaveEditor({ ipcMain: { handle: (name, handler) => routes.set(name, handler) },
    app: { getPath: () => f.root }, dialog: { showOpenDialog: () => { opened(); return new Promise(resolve => { completeDialog = resolve; }); } }, shell: {} });
  const temporary = await store.create();
  const workspace = path.join(temporary.directory, 'workspace');
  await fs.rename(f.workspace, workspace);
  const pending = routes.get('save-editor:replace')({}, { root: workspace, path: f.relative });
  await dialogOpened;
  assert.equal(await store.release(temporary.id), false);
  assert.equal((await fs.stat(workspace)).isDirectory(), true);
  completeDialog({ canceled: false, filePaths: [f.source] });
  const info = await pending;
  assert.equal(info.files.find(file => file.path === f.relative).size, f.replacement.length);
  await assert.rejects(fs.stat(temporary.directory), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(f.source), f.replacement);
});

test('preload exposes replacement with the exact selected workspace path', async () => {
  const exposed = {}, calls = [];
  vm.runInNewContext(syncFs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8'), {
    process, require: () => ({ contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } },
      ipcRenderer: { invoke: async (...args) => { calls.push(args); return 'updated'; } } }),
  });
  const options = { root: '/decrypted/workspace', path: 'sdimg_sce_sdmemory/memory.dat' };
  assert.equal(await exposed.saveEditor.replace(options), 'updated');
  assert.deepEqual(calls, [['save-editor:replace', options]]);
});

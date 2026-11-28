const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readWorkspacePage, writeWorkspacePages } = require('../electron/save_editor.cjs');

async function setup(t, bytes) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'garlic-editor-pages-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pathName = 'memory.dat';
  await fs.writeFile(path.join(root, pathName), bytes);
  return { root, path: pathName };
}

const encode = text => Buffer.from(text).toString('base64');

test('save page edits with original offsets, insertions and deletions', async t => {
  const file = await setup(t, '0123456789');
  const initial = await readWorkspacePage({ ...file, offset: 7, length: 100 });
  assert.equal(initial.data, encode('789'));
  assert.equal(initial.size, 10);
  const result = await writeWorkspacePages({ ...file, version: initial.version, edits: [
    { offset: 0, length: 0, data: encode('a') },
    { offset: 0, length: 0, data: encode('b') },
    { offset: 0, length: 1, data: '' },
    { offset: 4, length: 3, data: encode('X') },
    { offset: 9, length: 1, data: '' },
    { offset: 10, length: 0, data: encode('!') },
  ] });
  const after = await readWorkspacePage({ ...file, version: result.editorVersion, offset: 0, length: 100 });
  assert.equal(after.data, encode('ab123X78!'));
  assert.equal((await readWorkspacePage({ ...file, offset: after.size, length: 2048 })).data, '');
  assert.equal(result.files[0].size, after.size);
  assert.deepEqual(await fs.readdir(file.root), [file.path]);
});

test('supports inserting into and deleting to an empty file', async t => {
  const file = await setup(t, '');
  const empty = await readWorkspacePage({ ...file, offset: 0, length: 256 });
  const one = await writeWorkspacePages({ ...file, version: empty.version, edits: [{ offset: 0, length: 0, data: encode('z') }] });
  const zero = await writeWorkspacePages({ ...file, version: one.editorVersion, edits: [{ offset: 0, length: 1, data: '' }] });
  assert.equal(zero.files[0].size, 0);
  assert.equal((await readWorkspacePage({ ...file, version: zero.editorVersion, offset: 0, length: 100 })).data, '');
});

test('stale versions block navigation and saves after an external replacement', async t => {
  const file = await setup(t, 'test');
  const old = await readWorkspacePage({ ...file, offset: 0, length: 2 });
  const destination = path.join(file.root, file.path);
  await fs.writeFile(destination + '.new', 'next');
  await fs.rename(destination + '.new', destination);
  await assert.rejects(readWorkspacePage({ ...file, offset: 2, length: 2, version: old.version }), /changed on disk/);
  await assert.rejects(writeWorkspacePages({ ...file, version: old.version, edits: [{ offset: 3, length: 1, data: '' }] }), /changed on disk/);
  assert.equal(await fs.readFile(destination, 'utf8'), 'next');
});

test('malformed changes preserve the original bytes and remove staging files', async t => {
  const file = await setup(t, 'original');
  const { version } = await readWorkspacePage({ ...file, offset: 0, length: 4 });
  const destination = path.join(file.root, file.path);
  for (const change of [
    { offset: 3, length: 6, data: '' }, { offset: 1, length: 1, data: '' },
    { offset: 4, length: 1, data: 'not base64' }, { offset: 4, length: 1, data: 'Zh==' },
  ]) {
    await assert.rejects(writeWorkspacePages({ ...file, version, edits: [{ offset: 2, length: 1, data: encode('ok') }, change] }));
    assert.equal(await fs.readFile(destination, 'utf8'), 'original');
    assert.deepEqual(await fs.readdir(file.root), [file.path]);
  }
});

test('pages enforce metadata protection, regular files and bounded read ranges', async t => {
  const file = await setup(t, 'abc');
  const protectedFile = { ...file, path: 'CHIVES.JSON' };
  await fs.writeFile(path.join(file.root, protectedFile.path), '{}');
  await assert.rejects(readWorkspacePage({ ...protectedFile, offset: 0, length: 1 }), /read-only/);
  await assert.rejects(writeWorkspacePages({ ...protectedFile, version: 'x', edits: [] }), /read-only/);
  await assert.rejects(readWorkspacePage({ ...file, path: '../outside', offset: 0, length: 1 }), /outside/);
  await assert.rejects(readWorkspacePage({ ...file, offset: -1, length: 1 }), /range/);
  await assert.rejects(readWorkspacePage({ ...file, offset: 0, length: 1024 * 1024 + 1 }), /range/);
  await assert.rejects(readWorkspacePage({ ...file, offset: 4, length: 0 }), /end of the file/);
  await fs.mkdir(path.join(file.root, 'folder'));
  await assert.rejects(readWorkspacePage({ ...file, path: 'folder', offset: 0, length: 0 }), /regular file/);
});

test('an outside edit during staging survives a paged save', async t => {
  const file = await setup(t, 'original bytes');
  const filename = await fs.realpath(path.join(file.root, file.path));
  const { version } = await readWorkspacePage({ ...file, offset: 0, length: 4 });
  const open = fs.open;
  let changed = false;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (args[0] === filename && typeof args[1] === 'number' && !changed) {
      const read = handle.read.bind(handle);
      handle.read = async (...range) => {
        const result = await read(...range);
        if (!changed) {
          changed = true;
          await fs.writeFile(filename, 'external edit');
        }
        return result;
      };
    }
    return handle;
  });
  await assert.rejects(writeWorkspacePages({ ...file, version, edits: [{ offset: 7, length: 1, data: encode('x') }] }), /changed/);
  assert.equal(changed, true);
  assert.equal(await fs.readFile(filename, 'utf8'), 'external edit');
  assert.deepEqual(await fs.readdir(file.root), [file.path]);
});

test('concurrent paged saves with the same revision publish exactly once', async t => {
  const file = await setup(t, 'abc');
  const { version } = await readWorkspacePage({ ...file, offset: 0, length: 3 });
  const save = char => writeWorkspacePages({ ...file, version, edits: [{ offset: 1, length: 1, data: encode(char) }] });
  const results = await Promise.allSettled([save('x'), save('y')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const end = await readWorkspacePage({ ...file, offset: 0, length: 3 });
  assert.equal(end.version, results.find(result => result.status === 'fulfilled').value.editorVersion);
  assert.match(Buffer.from(end.data, 'base64').toString(), /^a[xy]c$/);
});

test('a refresh failure identifies a committed save', async t => {
  const file = await setup(t, 'abc');
  const { version } = await readWorkspacePage({ ...file, offset: 0, length: 3 });
  const saved = writeWorkspacePages({ ...file, version, edits: [{ offset: 0, length: 1, data: encode('x') }] },
    () => { throw new Error('title lookup failed'); });
  await assert.rejects(saved, /file was saved.*workspace could not refresh/);
  assert.equal(await fs.readFile(path.join(file.root, file.path), 'utf8'), 'xbc');
});

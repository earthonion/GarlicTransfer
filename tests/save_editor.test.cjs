const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { makeSfo } = require('./fixtures/sfo.cjs');

const {
  MAX_EDITOR_BYTES,
  createRemoteJob,
  readWorkspaceFile,
  readWorkspacePage,
  resolveInside,
  runSaveJob,
  runZip,
  workspaceInfo,
  writeWorkspaceFile,
} = require('../electron/save_editor.cjs');

const root = path.join(__dirname, '..');
const python = process.platform === 'win32' ? 'python' : 'python3';

async function makeWorkspace(parent) {
  const workspace = path.join(parent, 'source-workspace');
  await fsPromises.mkdir(path.join(workspace, 'DATA', 'sce_sys'), { recursive: true });
  const sfo = makeSfo('3e338f700e51db91');
  await fsPromises.writeFile(path.join(workspace, 'DATA', 'sce_sys', 'param.sfo'), sfo);
  await fsPromises.writeFile(path.join(workspace, 'DATA', 'save.dat'), Buffer.from([0, 1, 2, 255]));
  await fsPromises.writeFile(path.join(workspace, 'DATA', 'empty.dat'), '');
  await fsPromises.writeFile(path.join(workspace, 'chives.json'), JSON.stringify({ title_id: 'PPSA24003' }));
  return workspace;
}

test('an inline edit can grow past 8 MiB and reopen in pages', async t => {
  const workspace = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'garlic-editor-boundary-'));
  t.after(() => fsPromises.rm(workspace, { recursive: true, force: true }));
  const file = 'data.bin';
  const original = Buffer.alloc(MAX_EDITOR_BYTES, 0xab);
  await writeWorkspaceFile(workspace, file, original.toString('base64'));
  assert.equal((await readWorkspaceFile(workspace, file)).data, original.toString('base64'));
  const grown = Buffer.concat([original, Buffer.from([0xcd])]);
  await writeWorkspaceFile(workspace, file, grown.toString('base64'));
  assert.deepEqual(await readWorkspaceFile(workspace, file), { path: file, size: grown.length, paged: true });
  const end = await readWorkspacePage({ root: workspace, path: file, offset: grown.length - 2, length: 1024 });
  assert.deepEqual(Buffer.from(end.data, 'base64'), grown.subarray(-2));
});

test('workspace editing preserves bytes and reads account ID', async () => {
  const parent = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'garlic-editor-info-'));
  const workspace = await makeWorkspace(parent);
  const info = await workspaceInfo(workspace);
  assert.equal(info.accountId, '3e338f700e51db91');
  assert.equal(info.titleId, 'PPSA24003');
  assert.equal(info.files.length, 4);
  assert.equal(info.files.find((file) => file.path === 'DATA/empty.dat').size, 0);
  assert.equal(info.files.find((file) => file.path === 'chives.json').protected, true);
  assert.throws(() => resolveInside(workspace, '../outside'), /outside the save workspace/);

  const replacement = Buffer.from([0, 255, 10, 20]);
  await writeWorkspaceFile(workspace, 'DATA/save.dat', replacement.toString('base64'));
  const result = await readWorkspaceFile(workspace, 'DATA/save.dat');
  assert.deepEqual(Buffer.from(result.data, 'base64'), replacement);
  await assert.rejects(
    writeWorkspaceFile(workspace, 'DATA/save.dat', 'not base64'),
    /not valid base64/,
  );
});

test('workspace info finds and protects per-save chives metadata', async () => {
  const parent = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'garlic-editor-chives-'));
  const workspace = await makeWorkspace(parent);
  await fsPromises.rename(path.join(workspace, 'chives.json'), path.join(workspace, 'DATA', 'chives.json'));
  const info = await workspaceInfo(workspace);
  assert.equal(info.titleId, 'PPSA24003');
  assert.equal(info.files.find((file) => file.path === 'DATA/chives.json').protected, true);
});

test('multipart upload streams save fields and file bytes', async () => {
  const parent = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'garlic-editor-upload-'));
  const input = path.join(parent, 'sdimg_DATA');
  const payload = Buffer.alloc(1024 * 1024, 0x5a);
  await fsPromises.writeFile(input, payload);
  let body = Buffer.alloc(0);
  let workerKey = '';
  let requestHeaders = {};
  const server = http.createServer((request, response) => {
    workerKey = request.headers['x-worker-key'];
    requestHeaders = request.headers;
    request.on('data', (chunk) => { body = Buffer.concat([body, chunk]); });
    request.on('end', () => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ job_id: 'upload-test', status: 'queued' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await createRemoteJob({
      serverUrl: `http://127.0.0.1:${server.address().port}`,
      workerKey: 'test-key',
      operation: 'decrypt',
      inputs: [input],
      platform: 'ps5',
    });
    assert.equal(result.job_id, 'upload-test');
    assert.equal(workerKey, 'test-key');
    const text = body.toString('latin1');
    assert.match(text, /name="operation"\r\n\r\ndecrypt/);
    assert.match(text, /name="include_sce_sys"\r\n\r\ntrue/);
    assert.match(text, /filename="sdimg_DATA"/);
    assert.ok(body.includes(payload));
    assert.equal(Number(requestHeaders['content-length']), body.length);
    assert.equal(requestHeaders['transfer-encoding'], undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('multipart upload reports an early server response', async () => {
  const parent = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'garlic-editor-early-response-'));
  const input = path.join(parent, 'large-save');
  await fsPromises.writeFile(input, Buffer.alloc(1024 * 1024, 0x5a));
  const server = http.createServer((request, response) => {
    response.writeHead(413, { 'Content-Type': 'text/plain' });
    response.end('payload too large');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(createRemoteJob({
      serverUrl: `http://127.0.0.1:${server.address().port}`,
      workerKey: 'test-key',
      operation: 'decrypt',
      inputs: [input],
    }), /HTTP 413: payload too large/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('decrypt, encrypt, and resign complete through the API workflow', async () => {
  const parent = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'garlic-editor-jobs-'));
  const sourceWorkspace = await makeWorkspace(parent);
  const resultArchive = path.join(parent, 'result.zip');
  await runZip(python, root, root, 'pack', sourceWorkspace, resultArchive);
  const records = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'POST' && url.pathname === '/api/v1/jobs') {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks);
        records.push({ headers: request.headers, body });
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ job_id: `job-${records.length}`, status: 'queued' }));
      });
      return;
    }
    if (url.pathname.endsWith('/result')) {
      response.setHeader('Content-Type', 'application/zip');
      fs.createReadStream(resultArchive).pipe(response);
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({
      id: url.pathname.split('/').pop(),
      operation: 'decrypt',
      status: 'done',
      error: null,
      logs: [{ level: 'INFO', msg: 'worker complete' }],
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const events = [];
  const sender = { isDestroyed: () => false, send: (_channel, event) => events.push(event) };
  const shared = {
    sender,
    serverUrl: `http://127.0.0.1:${server.address().port}`,
    workerKey: 'test-key',
    python,
    resourceRoot: root,
    workDir: root,
    userDataRoot: path.join(parent, 'user-data'),
    pollIntervalMs: 1,
    timeoutMs: 10000,
  };
  try {
    const encryptedInput = path.join(parent, 'encrypted.img');
    await fsPromises.writeFile(encryptedInput, 'encrypted');
    const decrypted = await runSaveJob({ ...shared, operation: 'decrypt', inputs: [encryptedInput] });
    assert.equal(decrypted.info.accountId, '3e338f700e51db91');
    assert.deepEqual(
      await fsPromises.readFile(path.join(decrypted.workspace, 'DATA', 'save.dat')),
      Buffer.from([0, 1, 2, 255]),
    );

    const encryptedOutput = path.join(parent, 'encrypted-output.zip');
    const encrypted = await runSaveJob({
      ...shared,
      operation: 'encrypt',
      workspace: decrypted.workspace,
      accountId: decrypted.info.accountId,
      output: encryptedOutput,
    });
    assert.equal(encrypted.output, encryptedOutput);
    assert.equal((await fsPromises.stat(encryptedOutput)).size > 0, true);

    const resignedOutput = path.join(parent, 'resigned-output.zip');
    const resigned = await runSaveJob({
      ...shared,
      operation: 'resign',
      inputs: [encryptedInput],
      accountId: '0000000000000001',
      output: resignedOutput,
    });
    assert.equal(resigned.output, resignedOutput);
    assert.equal(records.length, 3);
    assert.match(records[0].body.toString('latin1'), /name="include_sce_sys"/);
    assert.match(records[1].body.toString('latin1'), /name="account_id"\r\n\r\n3e338f700e51db91/);
    assert.match(records[1].body.toString('latin1'), /DATA\/save.dat/);
    assert.match(records[2].body.toString('latin1'), /name="account_id"\r\n\r\n0000000000000001/);
    assert.equal(events.some((event) => event.type === 'log' && event.message === 'worker complete'), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('My Saves tab exposes the complete local workflow', () => {
  const html = fs.readFileSync(path.join(root, 'electron', 'index.html'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'electron', 'my_saves.js'), 'utf8');
  for (const id of [
    'mySaveEntries', 'myTitleEntries', 'mySavesBackBtn', 'localConsoleSelect', 'localUserSelect', 'decryptExternalBtn', 'mySaveDecryptBtn', 'mySaveResignBtn',
    'mySaveExportBtn', 'mySaveImportBtn', 'exportDecryptedBtn', 'addFilesBtn',
    'encryptSaveBtn', 'editorMode', 'editorSearch', 'editorOffset', 'editorRevert', 'saveFileBtn', 'saveEncryptFileBtn', 'saveMoreBtn', 'decryptExportBtn', 'deleteFileBtn',
    'uploadSaveBtn', 'uploadEncryptedBtn', 'workspaceMoreBtn', 'fileMoreBtn',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /data-page="library"/);
  assert.match(renderer, /operation: 'decrypt'/);
  assert.match(renderer, /operation: 'encrypt'/);
  assert.match(renderer, /operation: 'resign'/);
  assert.match(renderer, /editorDirty/);
  for (const method of ['chooseInput', 'localFile', 'localProfiles', 'backupLocal', 'encryptLocal', 'read', 'write', 'add', 'delete', 'downloadFile', 'downloadArchive', 'run']) {
    assert.match(preload, new RegExp(`${method}:`));
  }
});

test('hex editor includes UTF-8 text and parses it back losslessly', () => {
  const source = fs.readFileSync(path.join(root, 'electron', 'my_saves.js'), 'utf8');
  const start = source.indexOf('function bytesToHex');
  const end = source.indexOf('function updateEditorByteCount');
  const context = {
    window: { EditorBytes: require('../electron/editor_bytes.js') },
    myControls: {
      editorMode: { value: 'hex' },
      fileEditor: { value: '' },
    },
    TextEncoder,
  };
  vm.runInNewContext(source.slice(start, end), context);
  const original = new Uint8Array([0x41, 0x00, 0x42, 0x7e, 0x80]);
  const formatted = context.bytesToHex(original);
  assert.match(formatted, /\|A\.B~\.\|/);
  context.myControls.fileEditor.value = formatted;
  assert.deepEqual([...context.editorBytes()], [...original]);
});

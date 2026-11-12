const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const {
  createRemoteJob,
  readWorkspaceFile,
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
  const sfo = Buffer.alloc(0x1c0);
  Buffer.from('3e338f700e51db91', 'hex').copy(sfo, 0x1b8);
  await fsPromises.writeFile(path.join(workspace, 'DATA', 'sce_sys', 'param.sfo'), sfo);
  await fsPromises.writeFile(path.join(workspace, 'DATA', 'save.dat'), Buffer.from([0, 1, 2, 255]));
  await fsPromises.writeFile(path.join(workspace, 'DATA', 'empty.dat'), '');
  await fsPromises.writeFile(path.join(workspace, 'chives.json'), JSON.stringify({ title_id: 'PPSA24003' }));
  return workspace;
}

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

test('multipart upload streams save fields and file bytes', async () => {
  const parent = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'garlic-editor-upload-'));
  const input = path.join(parent, 'sdimg_DATA');
  const payload = Buffer.alloc(1024 * 1024, 0x5a);
  await fsPromises.writeFile(input, payload);
  let body = Buffer.alloc(0);
  let workerKey = '';
  const server = http.createServer((request, response) => {
    workerKey = request.headers['x-worker-key'];
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

test('save editor tab exposes the complete local workflow', () => {
  const html = fs.readFileSync(path.join(root, 'electron', 'index.html'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'electron', 'renderer.js'), 'utf8');
  const editor = fs.readFileSync(path.join(root, 'electron', 'save_editor.js'), 'utf8');
  for (const id of [
    'editorChooseFiles', 'editorUseDownloaded', 'editorOpenWorkspace', 'editorDecrypt',
    'editorResign', 'editorAddFiles', 'editorEncrypt', 'editorTextMode', 'editorHexMode',
    'editorSaveFile', 'editorDownloadArchive',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /data-tab="saveEditor"/);
  assert.match(renderer, /saveEditorTab/);
  for (const method of ['chooseInput', 'chooseWorkspace', 'localFile', 'read', 'write', 'add', 'delete', 'downloadFile', 'downloadArchive', 'run']) {
    assert.match(preload, new RegExp(`${method}:`));
  }
  assert.match(editor, /Unsaved changes/);
  assert.match(editor, /Delete this file from the decrypted workspace/);
});

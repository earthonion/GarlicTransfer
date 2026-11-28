const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

const editorPath = path.join(__dirname, '../electron/save_editor.cjs');
const actualRequire = createRequire(editorPath);

// Function Routing Fixture
async function fixture(t, { workerError = null, helperError = null, allowRemote = false, imageResult = false } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'garlic-routing-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const calls = { helper: [], worker: [], zip: [], events: [], fetch: 0 };
  const source = path.join(root, 'sdimg_DATA');
  const workspace = path.join(root, 'edited');
  await fsp.writeFile(source, 'original encrypted save');
  await fsp.mkdir(workspace);
  await fsp.writeFile(path.join(workspace, 'game.dat'), 'edited save data');
  const context = vm.createContext({
    module: { exports: {} },
    require(name) {
      if (name === './local_worker.cjs') return {
        async runLocalWorkerJob(options) {
          calls.worker.push(options);
          assert.equal(await fsp.readFile(options.inputArchive, 'utf8'), 'stored input fixture');
          if (workerError) throw new Error(workerError);
          options.onLog('Local worker processed save');
          options.onStatus('done');
          await fsp.mkdir(path.dirname(options.resultPath), { recursive: true });
          await fsp.writeFile(options.resultPath, 'worker result fixture');
          return { jobId: 'local-job', output: options.resultPath };
        },
      };
      if (name === 'node:child_process') return {
        spawn(_python, args) {
          const child = new EventEmitter();
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          const [, , command, ...files] = args;
          calls.zip.push({ command, files });
          setImmediate(async () => {
            try {
              if (command === 'extract') {
                await fsp.mkdir(files[1], { recursive: true });
                if (imageResult) {
                  await fsp.writeFile(path.join(files[1], 'sdimg_DATA'), 'replacement image');
                } else {
                  await fsp.writeFile(path.join(files[1], 'game.dat'), 'decrypted save data');
                  await fsp.writeFile(path.join(files[1], 'chives.json'), JSON.stringify({ title_id: 'PPSA12345' }));
                }
              } else {
                const archive = command === 'local-inputs' ? files[0] : files[1];
                await fsp.writeFile(archive, 'stored input fixture');
              }
              child.stdout.emit('data', Buffer.from('{}\n'));
              child.emit('close', 0);
            } catch (error) { child.emit('error', error); }
          });
          return child;
        },
      };
      return actualRequire(name);
    },
    process, Buffer, URL, console, setTimeout, clearTimeout, AbortController,
    fetch: async (...args) => {
      calls.fetch++;
      if (allowRemote) return fetch(...args);
      throw new Error('Unexpected HTTP fetch in local mode');
    },
  });
  vm.runInContext(fs.readFileSync(editorPath, 'utf8'), context, { filename: editorPath });
  const common = {
    useRemoteOracle: false,
    oracleHost: ' 192.168.0.42 ',
    serverUrl: 'not a server URL',
    workerKey: '',
    python: 'test-python', resourceRoot: root, workDir: root,
    userDataRoot: path.join(root, 'settings'),
    ensureLocalWorker: async (host) => {
      calls.helper.push(host);
      if (helperError) throw new Error(helperError);
    },
    sender: { isDestroyed: () => false, send: (_channel, event) => calls.events.push(event) },
  };
  return { root, source, workspace, calls, common, api: context.module.exports };
}

test('local decrypt uses the PS5 helper without a server URL or key and opens its workspace', async (t) => {
  const f = await fixture(t);
  const sidecar = `${f.source}.bin`;
  await fsp.writeFile(sidecar, 'companion');
  const result = await f.api.runSaveJob({ ...f.common, operation: 'decrypt', inputs: [f.source, sidecar] });
  assert.deepEqual(f.calls.helper, ['192.168.0.42']);
  assert.equal(f.calls.fetch, 0);
  assert.equal(f.calls.worker.length, 1);
  const job = f.calls.worker[0];
  assert.equal(job.host, '192.168.0.42');
  assert.equal(job.operation, 'decrypt');
  assert.equal(job.params.include_sce_sys, true);
  assert.equal('serverUrl' in job, false);
  assert.equal('workerKey' in job, false);
  assert.equal(f.calls.zip[0].command, 'local-inputs');
  assert.deepEqual(f.calls.zip[0].files.slice(1), [f.source, sidecar]);
  assert.equal(f.calls.zip[1].command, 'extract');
  assert.equal(result.info.titleId, 'PPSA12345');
  assert.equal(await fsp.readFile(path.join(result.workspace, 'game.dat'), 'utf8'), 'decrypted save data');
  assert.ok(f.calls.events.some((event) => event.type === 'log' && event.message === 'Local worker processed save'));
  assert.equal(await fsp.readFile(f.source, 'utf8'), 'original encrypted save');
});

test('local encrypt packs a stored workspace and local resign packs original save files', async (t) => {
  const f = await fixture(t);
  const accountId = '0833114e9585c53c';
  for (const operation of ['encrypt', 'resign']) {
    const output = path.join(f.root, `${operation}.zip`);
    const result = await f.api.runSaveJob({
      ...f.common, operation, accountId, output,
      ...(operation === 'encrypt' ? { workspace: f.workspace } : { inputs: [f.source] }),
    });
    const worker = f.calls.worker.at(-1);
    const packing = f.calls.zip.at(-1);
    assert.equal(worker.operation, operation);
    assert.equal(worker.params.account_id, accountId);
    assert.equal(packing.command, operation === 'encrypt' ? 'local-pack' : 'local-inputs');
    if (operation === 'encrypt') assert.equal(packing.files[0], f.workspace);
    assert.equal(result.output, output);
    assert.equal(await fsp.readFile(output, 'utf8'), 'worker result fixture');
  }
  assert.equal(f.calls.fetch, 0);
  assert.equal(await fsp.readFile(path.join(f.workspace, 'game.dat'), 'utf8'), 'edited save data');
  assert.equal(await fsp.readFile(f.source, 'utf8'), 'original encrypted save');
});

test('PPSA changes reach local encrypt and resign without editing their source files', async (t) => {
  const f = await fixture(t);
  for (const operation of ['encrypt', 'resign']) {
    await f.api.runSaveJob({
      ...f.common, operation, accountId: '0833114e9585c53c', targetTitleId: ' ppsa54321 ',
      output: path.join(f.root, `${operation}-new-title.zip`),
      ...(operation === 'encrypt' ? { workspace: f.workspace } : { inputs: [f.source] }),
    });
    const job = f.calls.worker.at(-1);
    assert.equal(job.operation, operation);
    assert.equal(job.params.target_title_id, 'PPSA54321');
    assert.equal(job.params.account_id, '0833114e9585c53c');
  }
  assert.equal(f.calls.fetch, 0);
  assert.equal(await fsp.readFile(f.source, 'utf8'), 'original encrypted save');
  assert.equal(await fsp.readFile(path.join(f.workspace, 'game.dat'), 'utf8'), 'edited save data');
});

test('invalid or unsupported PPSA changes stop before packing, deployment or upload', async (t) => {
  const f = await fixture(t);
  const options = {
    ...f.common, operation: 'encrypt', workspace: f.workspace,
    accountId: '0833114e9585c53c', output: path.join(f.root, 'retitled.zip'),
  };
  for (const targetTitleId of ['PPSA1234', 'PPSA123456', 'CUSA12345', 'PPSA12A45', 'PPSA12345/../']) {
    await assert.rejects(f.api.runSaveJob({ ...options, targetTitleId }), /PPSA|title ID/i);
  }
  await assert.rejects(f.api.runSaveJob({
    ...options, targetTitleId: 'PPSA54321', operation: 'decrypt', inputs: [f.source],
  }), /encrypt|resign|PPSA|title ID/i);
  await assert.rejects(f.api.runSaveJob({
    ...options, targetTitleId: 'PPSA54321', useRemoteOracle: true, workerKey: 'test-key',
  }), /local|PPSA|title ID/i);
  assert.deepEqual(f.calls.zip, []);
  assert.deepEqual(f.calls.helper, []);
  assert.deepEqual(f.calls.worker, []);
  assert.equal(f.calls.fetch, 0);
  await assert.rejects(fsp.access(options.output), { code: 'ENOENT' });
});

test('a blank PPSA target retains the normal local job format', async (t) => {
  const f = await fixture(t);
  await f.api.runSaveJob({
    ...f.common, operation: 'encrypt', workspace: f.workspace, targetTitleId: '   ',
    accountId: '0833114e9585c53c', output: path.join(f.root, 'unchanged-title.zip'),
  });
  assert.equal(Object.hasOwn(f.calls.worker[0].params, 'target_title_id'), false);
});

test('local routing validates the PS5 address and never falls back to a hosted worker', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.api.runSaveJob({ ...f.common, oracleHost: 'https://garlicsaves.com', operation: 'decrypt', inputs: [f.source] }), /valid local oracle IP/);
  await assert.rejects(f.api.runSaveJob({ ...f.common, platform: 'ps4', operation: 'decrypt', inputs: [f.source] }), /supports PS5 saves/);
  await assert.rejects(f.api.runSaveJob({ ...f.common, ensureLocalWorker: undefined, operation: 'decrypt', inputs: [f.source] }), /local save helper is not available/);
  assert.equal(f.calls.fetch, 0);
  assert.deepEqual(f.calls.helper, []);
  assert.deepEqual(f.calls.worker, []);
});

test('local worker failure preserves the original save and existing export', async (t) => {
  const f = await fixture(t, { workerError: 'PS5 could not encrypt the save' });
  const output = path.join(f.root, 'existing-export.zip');
  await fsp.writeFile(output, 'previous successful export');
  await assert.rejects(f.api.runSaveJob({
    ...f.common, operation: 'encrypt', workspace: f.workspace,
    accountId: '0833114e9585c53c', output,
  }), /could not encrypt/);
  assert.equal(await fsp.readFile(output, 'utf8'), 'previous successful export');
  assert.equal(await fsp.readFile(f.source, 'utf8'), 'original encrypted save');
  assert.equal(f.calls.fetch, 0);
  assert.ok(f.calls.events.some((event) => event.type === 'error' && /could not encrypt/.test(event.message)));
  assert.deepEqual(await fsp.readdir(path.join(f.common.userDataRoot, 'save-editor')), []);
});

test('a missing local helper fails after input packing and before submitting saves', async (t) => {
  const f = await fixture(t, { helperError: 'Could not start the local helper' });
  await assert.rejects(f.api.runSaveJob({ ...f.common, operation: 'decrypt', inputs: [f.source] }), /Could not start/);
  assert.equal(f.calls.zip.length, 1);
  assert.equal(f.calls.zip[0].command, 'local-inputs');
  assert.deepEqual(f.calls.worker, []);
  assert.equal(f.calls.fetch, 0);
  assert.deepEqual(await fsp.readdir(path.join(f.common.userDataRoot, 'save-editor')), []);
});

test('remote routing still requires its server key by default and when explicitly enabled', async (t) => {
  const f = await fixture(t);
  for (const flag of [undefined, true]) {
    await assert.rejects(f.api.runSaveJob({ ...f.common, useRemoteOracle: flag, operation: 'decrypt', inputs: [f.source] }), /Authorize the app first!/);
  }
  assert.deepEqual(f.calls.helper, []);
  assert.deepEqual(f.calls.worker, []);
});

test('registered local jobs use the trusted helper callback from the main process', async (t) => {
  const f = await fixture(t);
  const handlers = new Map();
  f.api.registerSaveEditor({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    app: { getPath: () => f.common.userDataRoot },
    dialog: {}, shell: {}, python: f.common.python,
    resourceRoot: f.common.resourceRoot, workDir: f.common.workDir,
    ensureLocalWorker: f.common.ensureLocalWorker,
  });
  const output = path.join(f.root, 'resigned.zip');
  const result = await handlers.get('save-editor:job')({ sender: f.common.sender }, {
    useRemoteOracle: false, oracleHost: '192.168.0.42',
    ensureLocalWorker: 'renderer value must be ignored',
    operation: 'resign', inputs: [f.source], accountId: '0833114e9585c53c', output,
  });
  assert.equal(result.output, output);
  assert.deepEqual(f.calls.helper, ['192.168.0.42']);
  assert.equal(f.calls.worker.length, 1);
});


test('explicit remote mode submits, polls and downloads through its configured HTTP server', async (t) => {
  const f = await fixture(t, { allowRemote: true });
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({
      method: request.method, path: request.url,
      key: request.headers['x-worker-key'], jobToken: request.headers['x-job-token'],
    });
    request.resume();
    request.on('end', () => {
      if (request.method === 'POST') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ job_id: 'remote-routing', job_token: 'read-secret' }));
      } else if (request.url.endsWith('/result')) {
        response.end('remote encrypted result');
      } else {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ status: 'done', logs: [{ msg: 'remote processed save' }] }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const output = path.join(f.root, 'remote.zip');
  const result = await f.api.runSaveJob({
    ...f.common, useRemoteOracle: true,
    serverUrl: `http://127.0.0.1:${server.address().port}`, workerKey: 'test-key',
    operation: 'resign', inputs: [f.source], accountId: '0833114e9585c53c', output,
  });
  assert.equal(result.jobId, 'remote-routing');
  assert.equal(await fsp.readFile(output, 'utf8'), 'remote encrypted result');
  assert.deepEqual(requests.map((request) => [request.method, request.path]), [
    ['POST', '/api/v1/jobs'],
    ['GET', '/api/v1/jobs/remote-routing'],
    ['GET', '/api/v1/jobs/remote-routing/result'],
  ]);
  assert.ok(requests.every((request) => request.key === 'test-key'));
  assert.deepEqual(requests.slice(1).map(request => request.jobToken), ['read-secret', 'read-secret']);
  assert.deepEqual(f.calls.helper, []);
  assert.deepEqual(f.calls.worker, []);
  assert.equal(f.calls.fetch, 2);
});


test('completed local encrypt and resign release app inputs while preserving exports and source folders', async t => {
  const f = await fixture(t);
  for (const operation of ['encrypt', 'resign']) {
    const output = path.join(f.root, operation + '-clean.zip');
    await f.api.runSaveJob({ ...f.common, operation, output, accountId: '0833114e9585c53c',
      ...(operation === 'encrypt' ? { workspace: f.workspace } : { inputs: [f.source] }) });
    assert.deepEqual(await fsp.readdir(path.join(f.common.userDataRoot, 'save-editor')), []);
    assert.equal(await fsp.readFile(output, 'utf8'), 'worker result fixture');
  }
  assert.equal(await fsp.readFile(f.source, 'utf8'), 'original encrypted save');
  assert.equal(await fsp.readFile(path.join(f.workspace, 'game.dat'), 'utf8'), 'edited save data');
});

test('decrypted workspace retains its archive until released by its opaque temporary ID', async t => {
  const f = await fixture(t);
  const { SaveTemps } = actualRequire('./save_temps.cjs');
  const temporaryStore = new SaveTemps(path.join(f.common.userDataRoot, 'save-editor'));
  const result = await f.api.runSaveJob({ ...f.common, temporaryStore, operation: 'decrypt', inputs: [f.source] });
  assert.ok(result.temporaryId);
  assert.equal(await fsp.readFile(result.archivePath, 'utf8'), 'worker result fixture');
  await assert.rejects(fsp.access(path.join(path.dirname(result.archivePath), 'local-input.zip')), { code: 'ENOENT' });
  assert.equal(await temporaryStore.release(result.workspace), false);
  assert.equal(await temporaryStore.release(result.temporaryId), true);
  await assert.rejects(fsp.access(result.workspace), { code: 'ENOENT' });
  assert.equal(await fsp.readFile(f.source, 'utf8'), 'original encrypted save');
});

test('replacement images remain available through import and are released through their own temporary ID', async t => {
  const f = await fixture(t, { imageResult: true });
  const handlers = new Map();
  f.api.registerSaveEditor({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    app: { getPath: () => f.common.userDataRoot }, dialog: {}, shell: {},
    python: f.common.python, resourceRoot: f.common.resourceRoot, workDir: f.common.workDir,
    ensureLocalWorker: f.common.ensureLocalWorker });
  const event = { sender: f.common.sender };
  const result = await handlers.get('save-editor:encrypt-local')(event, { ...f.common,
    operation: 'encrypt', workspace: f.workspace, accountId: '0833114e9585c53c' });
  assert.ok(result.temporaryId);
  const imported = path.join(f.root, 'imported-save');
  await fsp.copyFile(result.output, imported);
  await handlers.get('save-editor:release-temporary')(event, result.temporaryId);
  await assert.rejects(fsp.access(result.output), { code: 'ENOENT' });
  assert.equal(await fsp.readFile(imported, 'utf8'), 'replacement image');
  assert.equal(await fsp.readFile(path.join(f.workspace, 'game.dat'), 'utf8'), 'edited save data');
});

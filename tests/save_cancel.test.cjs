const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const net = require('node:net');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { runLocalWorkerJob } = require('../electron/local_worker.cjs');
const { runSaveJob } = require('../electron/save_editor.cjs');
const { SaveTemps } = require('../electron/save_temps.cjs');

const editorPath = path.join(__dirname, '../electron/save_editor.cjs');
const actualRequire = createRequire(editorPath);

// Function Test Signal
function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Function Test Waiting
async function waitForFile(directory, matches) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if ((await fsp.readdir(directory)).some(matches)) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('the staged result did not appear');
}

// Function Cancel Fixture
async function fixture(t, { pack, worker, ensure } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'garlic-save-cancel-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'sdimg_DATA');
  const output = path.join(root, 'export.zip');
  await fsp.writeFile(source, 'original source save');
  await fsp.writeFile(output, 'previous export');
  const calls = { zip: [], helper: [], worker: [] };
  let store;
  class CapturedTemps extends SaveTemps {
    constructor(base) { super(base); store = this; }
  }
  const context = vm.createContext({
    module: { exports: {} }, process, Buffer, URL, AbortController, setTimeout, clearTimeout, fetch,
    require(name) {
      if (name === './save_temps.cjs') return { SaveTemps: CapturedTemps };
      if (name === './local_worker.cjs') return {
        async runLocalWorkerJob(options) {
          calls.worker.push(options);
          if (worker) return worker(options);
          await fsp.writeFile(options.resultPath, 'completed export');
          return { jobId: 'local-test', output: options.resultPath };
        },
      };
      if (name === 'node:child_process') return {
        spawn(_python, args) {
          const child = new EventEmitter();
          Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 12345 });
          child.kill = () => { setImmediate(() => child.emit('close', null)); return true; };
          const [, , command, ...files] = args;
          const entry = { child, command, files };
          calls.zip.push(entry);
          setImmediate(async () => {
            try {
              if (pack && await pack(entry, calls.zip.length)) return;
              if (command === 'extract') {
                await fsp.mkdir(files[1], { recursive: true });
                await fsp.writeFile(path.join(files[1], 'game.dat'), 'decrypted data');
              } else {
                await fsp.writeFile(command === 'local-inputs' ? files[0] : files[1], 'PK input archive');
              }
              child.stdout.emit('data', '{}\n');
              child.emit('close', 0);
            } catch (error) { child.emit('error', error); child.emit('close', 1); }
          });
          return child;
        },
      };
      return actualRequire(name);
    },
  });
  vm.runInContext(fs.readFileSync(editorPath, 'utf8'), context, { filename: editorPath });
  const handlers = new Map();
  const sender = { isDestroyed: () => false, send() {} };
  const userDataRoot = path.join(root, 'settings');
  context.module.exports.registerSaveEditor({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    app: { getPath: () => userDataRoot }, dialog: {}, shell: {}, python: 'fixture-python',
    resourceRoot: root, workDir: root,
    ensureLocalWorker: async host => { calls.helper.push(host); return ensure?.(host); },
  });
  const options = {
    useRemoteOracle: false, oracleHost: '127.0.0.1', operation: 'resign',
    accountId: '0123456789abcdef', inputs: [source], output,
    signal: 'untrusted renderer signal',
  };
  const invoke = (name, data) => handlers.get(`save-editor:${name}`)({ sender }, data);
  return { root, source, output, userDataRoot, calls, store, options, invoke, api: context.module.exports };
}

test('app shutdown cancels a save job, waits for cleanup and blocks new save jobs', async t => {
  const started = gate(), canceled = gate(), cleanup = gate();
  const f = await fixture(t, { worker: async ({ signal }) => {
    started.resolve();
    await new Promise(resolve => signal.addEventListener('abort', () => { canceled.resolve(); resolve(); }, { once: true }));
    await cleanup.promise;
    throw Object.assign(new Error('Local save operation canceled'), { name: 'AbortError' });
  } });
  const running = f.invoke('job', f.options);
  const rejected = assert.rejects(running, { name: 'AbortError' });
  await started.promise;
  let stopped = false;
  const closing = f.api.stopSaveJobs().then(() => { stopped = true; });
  const repeated = f.api.stopSaveJobs();
  await canceled.promise;
  assert.equal(stopped, false);
  await assert.rejects(f.invoke('job', f.options), /closing/);
  cleanup.resolve();
  await Promise.all([closing, repeated, rejected]);
  assert.equal(stopped, true);
  assert.equal(await fsp.readFile(f.source, 'utf8'), 'original source save');
  assert.equal(await fsp.readFile(f.output, 'utf8'), 'previous export');
  assert.deepEqual(await fsp.readdir(path.join(f.userDataRoot, 'save-editor')), []);
});

test('app shutdown without an active save still prevents a late save job', async t => {
  const f = await fixture(t);
  await f.api.stopSaveJobs();
  await assert.rejects(f.invoke('job', f.options), /closing/);
  assert.deepEqual(f.calls.zip, []);
  assert.deepEqual(f.calls.helper, []);
  assert.deepEqual(f.calls.worker, []);
});

test('cancel waits for the packing child to close and preserves workspace leases until cleanup', { timeout: 10000 }, async t => {
  const packing = gate();
  let killed = 0;
  const f = await fixture(t, { pack: async (entry, count) => {
    if (count !== 1) return false;
    await fsp.writeFile(entry.files[1], 'partial packing output');
    entry.child.kill = () => { killed++; return true; };
    packing.resolve(entry);
    return true;
  } });
  const owned = await f.store.create();
  const workspace = path.join(owned.directory, 'workspace');
  await fsp.mkdir(workspace);
  await fsp.writeFile(path.join(workspace, 'game.dat'), 'source workspace');
  const running = f.invoke('job', { ...f.options, operation: 'encrypt', workspace });
  const rejected = assert.rejects(running, /canceled/i);
  const entry = await packing.promise;
  await f.invoke('release-temporary', owned.id);
  let finished = false;
  const canceled = f.invoke('cancel').then(result => { finished = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(killed, 1);
  assert.equal(finished, false);
  assert.equal(fs.existsSync(owned.directory), true);
  assert.equal(fs.existsSync(entry.files[1]), true);
  assert.equal(f.calls.helper.length, 0);
  await assert.rejects(f.invoke('job', f.options), /already running/);
  entry.child.emit('close', null);
  await rejected;
  assert.equal(await canceled, true);
  assert.equal(fs.existsSync(owned.directory), false);
  assert.deepEqual(await fsp.readdir(path.join(f.userDataRoot, 'save-editor')), []);
  assert.equal(await fsp.readFile(f.output, 'utf8'), 'previous export');
  assert.equal(await fsp.readFile(f.source, 'utf8'), 'original source save');
  await f.invoke('job', f.options);
  assert.equal(await fsp.readFile(f.output, 'utf8'), 'completed export');
  assert.equal(await f.invoke('cancel'), false);
});

test('canceling shared helper startup stops only the waiting save job and allows retry', { timeout: 10000 }, async t => {
  const starting = gate(), helperReady = gate();
  let starts = 0;
  const f = await fixture(t, { ensure: () => {
    starts++;
    if (starts === 1) { starting.resolve(); return helperReady.promise; }
  } });
  const running = f.invoke('job', f.options);
  const rejected = assert.rejects(running, /canceled/i);
  await starting.promise;
  assert.equal(f.calls.zip.length, 1);
  assert.equal(await f.invoke('cancel'), true);
  await rejected;
  assert.equal(f.calls.worker.length, 0);
  assert.equal(await fsp.readFile(f.output, 'utf8'), 'previous export');
  helperReady.resolve();
  await f.invoke('job', f.options);
  assert.equal(starts, 2);
  assert.equal(f.calls.worker.length, 1);
  assert.equal(await fsp.readFile(f.source, 'utf8'), 'original source save');
});

// Function Test Peer
class Peer {
  constructor(socket) {
    this.socket = socket;
    this.data = Buffer.alloc(0);
    socket.on('data', data => { this.data = Buffer.concat([this.data, data]); this.wake?.(); });
    socket.on('close', () => { this.closed = true; this.wake?.(); });
    socket.on('error', () => {});
  }
  async read(size) {
    while (this.data.length < size) {
      if (this.closed) throw new Error('peer closed');
      await new Promise(resolve => { this.wake = resolve; });
    }
    const data = this.data.subarray(0, size);
    this.data = this.data.subarray(size);
    return data;
  }
  async message() { return JSON.parse((await this.read((await this.read(4)).readUInt32BE())).toString()); }
  send(message) {
    const body = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    return this.write(Buffer.concat([header, body]));
  }
  write(data) { return new Promise((resolve, reject) => this.socket.write(data, error => error ? reject(error) : resolve())); }
}

test('canceling a real local result stream preserves an existing export and permits a fresh job', { timeout: 10000 }, async t => {
  const partial = gate(), closed = gate();
  const sockets = new Set();
  const errors = [];
  let connections = 0;
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const attempt = ++connections;
    const peer = new Peer(socket);
    (async () => {
      await peer.send({ type: 'hello', protocol: 'garlic-local-v1', platform: 'ps5' });
      const job = await peer.message();
      await peer.send({ type: 'file_request', job_id: job.id });
      const input = await peer.message();
      await peer.read(input.size);
      const bytes = Buffer.from('PK completed output');
      await peer.send({ type: 'result_start', job_id: job.id, size: bytes.length });
      if (attempt === 1) {
        await peer.write(bytes.subarray(0, 3));
        socket.once('close', () => closed.resolve());
        partial.resolve();
      } else {
        await peer.write(bytes);
        assert.equal((await peer.message()).type, 'result_ok');
        await peer.send({ type: 'status', job_id: job.id, status: 'done' });
        socket.end();
      }
    })().catch(error => { errors.push(error); socket.destroy(); partial.resolve(error); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  const port = server.address().port;
  const f = await fixture(t, { worker: options => runLocalWorkerJob({ ...options, port }) });
  const running = f.invoke('job', f.options);
  const rejected = assert.rejects(running, /canceled/i);
  const failure = await partial.promise;
  if (failure) throw failure;
  await waitForFile(f.root, name => name.includes('.local-'));
  assert.equal(await f.invoke('cancel'), true);
  await rejected;
  await closed.promise;
  assert.equal(await fsp.readFile(f.output, 'utf8'), 'previous export');
  assert.equal(await fsp.readFile(f.source, 'utf8'), 'original source save');
  assert.deepEqual((await fsp.readdir(f.root)).filter(name => name.includes('.local-')), []);
  assert.deepEqual(await fsp.readdir(path.join(f.userDataRoot, 'save-editor')), []);
  await f.invoke('job', f.options);
  assert.equal(await fsp.readFile(f.output, 'utf8'), 'PK completed output');
  assert.equal(connections, 2);
  assert.deepEqual(errors, []);
});

test('invalid local save archives fail validation before attempting helper startup', { timeout: 10000 }, async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'garlic-invalid-local-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'invalid.zip');
  await fsp.writeFile(input, 'not a ZIP archive');
  let starts = 0;
  await assert.rejects(runSaveJob({
    useRemoteOracle: false, oracleHost: '127.0.0.1', operation: 'decrypt', inputs: [input],
    python: process.platform === 'win32' ? 'python' : 'python3',
    resourceRoot: path.join(__dirname, '..'), workDir: root, userDataRoot: root,
    ensureLocalWorker: async () => { starts++; },
  }), /zip/i);
  assert.equal(starts, 0);
  assert.equal(await fsp.readFile(input, 'utf8'), 'not a ZIP archive');
  assert.deepEqual(await fsp.readdir(path.join(root, 'save-editor')), []);
});

test('remote cancellation aborts a result download without publishing partial bytes', { timeout: 10000 }, async t => {
  const downloading = gate(), disconnected = gate();
  let retry = false;
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    request.resume();
    request.on('end', () => {
      if (request.method === 'POST') {
        response.end(JSON.stringify({ job_id: 'remote-cancel' }));
      } else if (request.url.endsWith('/result')) {
        if (retry) { response.end('complete remote output'); return; }
        response.writeHead(200, { 'Content-Length': '100000' });
        response.write('partial bytes');
        response.once('close', () => disconnected.resolve());
        downloading.resolve();
      } else response.end(JSON.stringify({ status: 'done', logs: [] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const f = await fixture(t);
  const options = { ...f.options, useRemoteOracle: true,
    serverUrl: `http://127.0.0.1:${server.address().port}`, workerKey: 'test-key' };
  const running = f.invoke('job', options);
  const rejected = assert.rejects(running, /canceled/i);
  await downloading.promise;
  await waitForFile(f.root, name => name.includes('.download-'));
  assert.equal(await f.invoke('cancel'), true);
  await rejected;
  await disconnected.promise;
  assert.equal(await fsp.readFile(f.output, 'utf8'), 'previous export');
  assert.equal(await fsp.readFile(f.source, 'utf8'), 'original source save');
  assert.deepEqual((await fsp.readdir(f.root)).filter(name => name.includes('.download-')), []);
  assert.deepEqual(requests, ['/api/v1/jobs', '/api/v1/jobs/remote-cancel', '/api/v1/jobs/remote-cancel/result']);
  retry = true;
  await f.invoke('job', options);
  assert.equal(await fsp.readFile(f.output, 'utf8'), 'complete remote output');
});

test('remote cancellation aborts an outstanding status request and releases the job slot', { timeout: 10000 }, async t => {
  const polling = gate(), disconnected = gate();
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      if (request.method === 'POST') response.end(JSON.stringify({ job_id: 'polling' }));
      else {
        response.once('close', () => disconnected.resolve());
        polling.resolve();
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const f = await fixture(t);
  const running = f.invoke('job', { ...f.options, useRemoteOracle: true,
    serverUrl: `http://127.0.0.1:${server.address().port}`, workerKey: 'test-key' });
  const rejected = assert.rejects(running, /canceled/i);
  await polling.promise;
  assert.equal(await f.invoke('cancel'), true);
  await rejected;
  await disconnected.promise;
  assert.equal(await f.invoke('cancel'), false);
  assert.equal(await fsp.readFile(f.output, 'utf8'), 'previous export');
  await f.invoke('job', f.options);
  assert.equal(await fsp.readFile(f.output, 'utf8'), 'completed export');
});

test('remote cancellation closes an in-flight multipart request without waiting for a server response', { timeout: 10000 }, async t => {
  const uploading = gate(), disconnected = gate();
  const server = http.createServer((request, response) => {
    response.once('close', () => disconnected.resolve());
    request.once('data', () => uploading.resolve());
    request.on('error', () => {});
    request.resume();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const f = await fixture(t);
  const running = f.invoke('job', { ...f.options, useRemoteOracle: true,
    serverUrl: `http://127.0.0.1:${server.address().port}`, workerKey: 'test-key' });
  const rejected = assert.rejects(running, /canceled/i);
  await uploading.promise;
  assert.equal(await f.invoke('cancel'), true);
  await rejected;
  await disconnected.promise;
  assert.equal(await fsp.readFile(f.output, 'utf8'), 'previous export');
  assert.equal(await fsp.readFile(f.source, 'utf8'), 'original source save');
  assert.deepEqual(await fsp.readdir(path.join(f.userDataRoot, 'save-editor')), []);
});

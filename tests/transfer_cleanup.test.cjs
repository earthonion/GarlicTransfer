const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

const mainPath = path.join(__dirname, '../electron/main.cjs');
const originalRequire = createRequire(mainPath);
const tick = () => new Promise(resolve => setImmediate(resolve));

// Function Transfer Fixture
function fixture(t, pendingHelper = false, network) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'garlic-session-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'metadata.db'), 'fixture');
  const children = [], releases = [], helpers = [];
  let resolveHelper;
  const helper = pendingHelper ? new Promise(resolve => { resolveHelper = resolve; }) : Promise.resolve();
  const handlers = new Map();
  class Store {
    retainUpload(id, folder) { assert.equal(id, 'owned-stage'); assert.equal(folder, '/staged'); return async () => { releases.push(id); }; }
    releaseUpload(id) { releases.push('request:' + id); }
  }
  const context = vm.createContext({
    require(name) {
      if (network && name === './windows_network.cjs') return network;
      if (name === 'electron') return { app: { getPath: () => root, whenReady: () => ({ then() {} }), on() {} },
        ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, dialog: {}, shell: {} };
      if (name === 'node:child_process') return { spawn(command, args) {
        const child = new EventEmitter();
        child.args = args; child.command = command; child.exitCode = null;
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.stdin = { writable: true, write() {}, end() {} };
        child.kill = () => { child.killed = true; };
        children.push(child); return child;
      } };
      if (name === './local_pc.cjs') return { LocalPcStore: Store };
      if (name === './local_helper.cjs') return { LocalHelper: class {
        ensureTransfer(host, port) { helpers.push([host, port]); return helper; }
        ensure() { return helper; } stop() {}
      } };
      if (name === './paths.cjs') return { resourceRoot: root, localWorkerElf: '/helper.elf', workDir: root, pythonBin: () => 'fixture-python' };
      if (name === './titles.cjs') return { titleName: title => title };
      if (name === './config.cjs') return { loadSettings() {}, saveSettings() {} };
      return originalRequire(name);
    },
    __dirname: path.dirname(mainPath), process: network ? { platform: 'win32' } : process, Buffer, console, setTimeout, clearTimeout,
  });
  vm.runInContext(fs.readFileSync(mainPath, 'utf8'), context, { filename: mainPath });
  const options = { accountId: '0833114e9585c53c', hostId: 'AABBCCDDEEFF', systemVersion: '13600000', output: root, assets: root, metadata: path.join(root, 'metadata.db'),
    useRemoteOracle: false, oracleHost: '192.168.0.42', userId: '1', userName: 'Demo', uploadKind: 'external',
    externalImage: '/staged', titleId: 'PPSA12345', localPcUploadId: 'owned-stage' };
  return { context, root, options, children, releases, helpers, resolveHelper, handlers };
}

test('the Windows enable action accepts the app page and excludes overlapping transfers', async t => {
  const { pathToFileURL } = require('node:url');
  let rejectEnable;
  const network = { enableIpv6: () => new Promise((_resolve, reject) => { rejectEnable = reject; }) };
  const f = fixture(t, false, network);
  const frame = { url: pathToFileURL(path.join(path.dirname(mainPath), 'index.html')).href + '?language=en' };
  const sender = { mainFrame: frame, isDestroyed: () => false, send() {} };
  f.context.appWindow = { isDestroyed: () => false, webContents: sender };
  vm.runInContext('window = appWindow', f.context);
  const enable = f.handlers.get('windows:enable-ipv6');
  await assert.rejects(enable({ sender, senderFrame: { ...frame } }, '192.0.2.40', 7), /GarlicTransfer window/);
  const event = { sender, senderFrame: frame };
  const pending = enable(event, '192.0.2.40', 7);
  for (const start of ['startUpload', 'startPairing', 'startDownload']) {
    assert.throws(() => f.context[start](f.options), /IPv6 change/);
  }
  await assert.rejects(enable(event, '192.0.2.40', 7), /IPv6 change/);
  rejectEnable(new Error('Canceled'));
  await assert.rejects(pending, /Canceled/);
  f.context.startDownload(f.options);
  await assert.rejects(enable(event, '192.0.2.40', 7), /Finish the active transfer/);
  f.context.stopActive();
});

test('canceling during shared helper startup cannot spawn an orphan download', async t => {
  const f = fixture(t, true);
  f.context.startDownload({ ...f.options });
  assert.equal(f.helpers.length, 1);
  f.context.stopActive();
  f.resolveHelper(); await tick();
  assert.equal(f.children.length, 0);
  assert.equal(vm.runInContext('active', f.context), null);
});

test('cached metadata does not skip pairing in a fresh app session', t => {
  const f = fixture(t);
  vm.runInContext('let requestedPairing = false; startPairing = () => { requestedPairing = true; };', f.context);
  f.context.startDownload({ ...f.options, accountId: '' });
  assert.equal(vm.runInContext('requestedPairing', f.context), true);
  assert.equal(f.children.length, 0);
});

test('canceling metadata preparation keeps the PC snapshot until that child closes', async t => {
  const f = fixture(t);
  f.context.startUpload({ ...f.options });
  assert.equal(f.children.length, 1);
  f.context.stopActive();
  assert.equal(f.children[0].killed, true);
  assert.deepEqual(f.releases, []);
  f.children[0].emit('close', 0); await tick();
  assert.deepEqual(f.releases, ['owned-stage']);
  assert.deepEqual(f.helpers, []);
  assert.equal(f.children.length, 1);
});

test('canceling an active upload releases staging only after the source process closes', async t => {
  const f = fixture(t);
  f.context.startUpload({ ...f.options });
  f.children[0].emit('close', 0); await tick();
  assert.equal(f.children.length, 2);
  const source = f.children[1];
  f.context.stopActive();
  assert.equal(source.killed, true);
  assert.deepEqual(f.releases, []);
  source.emit('close', 1); await tick();
  assert.deepEqual(f.releases, ['owned-stage']);
});

test('a completed upload releases staging after close and leaves no retained consumer', async t => {
  const f = fixture(t);
  f.context.startUpload({ ...f.options });
  f.children[0].emit('close', 0); await tick();
  const source = f.children[1];
  source.stdout.emit('data', Buffer.from('cmd=0xb3\n'));
  assert.deepEqual(f.releases, []);
  source.emit('close', 0); await tick();
  assert.deepEqual(f.releases, ['owned-stage']);
  assert.equal(vm.runInContext('active', f.context), null);
});

test('a canceled old child cannot finish a newer transfer session', async t => {
  const f = fixture(t);
  f.context.startDownload({ ...f.options }); await tick();
  const old = f.children[0];
  f.context.stopActive();
  f.context.startDownload({ ...f.options }); await tick();
  const current = f.children[1];
  old.emit('close', 1); await tick();
  assert.equal(vm.runInContext('active.process', f.context), current);
  assert.equal(current.killed, undefined);
  f.context.stopActive(); current.emit('close', 0);
});

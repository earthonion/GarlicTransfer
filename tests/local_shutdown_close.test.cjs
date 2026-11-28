const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Function Close Fixture
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garlic-shutdown-close-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mainPath = path.join(__dirname, '../electron/main.cjs');
  const actualRequire = createRequire(mainPath);
  const app = new EventEmitter(), ipcMain = new EventEmitter();
  const calls = [], stopped = gate(), shutdown = gate();
  let ready, beforeClose;
  app.getPath = () => root;
  app.getPreferredSystemLanguages = () => ['en'];
  app.whenReady = () => ({ then(callback) { ready = Promise.resolve().then(callback); } });
  ipcMain.handle = () => {};
  class Window {
    constructor() { this.webContents = { send() {} }; }
    isDestroyed() { return false; }
    async loadFile() {}
  }
  class LocalHelper {
    async shutdown() { calls.push('worker shutdown'); await shutdown.promise; }
    stop() { calls.push('helper stop'); }
  }
  const context = vm.createContext({
    require(name) {
      if (name === 'electron') return { app, ipcMain, BrowserWindow: Window, dialog: {}, shell: {} };
      if (name === './local_helper.cjs') return { LocalHelper };
      if (name === './save_editor.cjs') return {
        registerSaveEditor() {},
        async stopSaveJobs() { calls.push('save cancellation'); await stopped.promise; },
      };
      if (name === './account_close.cjs') return {
        registerAccountClose(options) { beforeClose = options.beforeClose; },
      };
      if (name === './config.cjs') return { loadSettings: () => ({ uiLanguage: 'en' }), saveSettings() {} };
      if (name === './titles.cjs') return { titleName: value => value };
      if (name === './paths.cjs') return {
        resourceRoot: root, localWorkerElf: '/local-helper.elf', workDir: root, pythonBin: () => 'python3',
      };
      return actualRequire(name);
    },
    __dirname: path.dirname(mainPath), process, console, Buffer, setTimeout, clearTimeout,
  });
  vm.runInContext(fs.readFileSync(mainPath, 'utf8'), context, { filename: mainPath });
  await ready;
  assert.equal(typeof beforeClose, 'function');
  return { context, calls, stopped, shutdown, beforeClose };
}

test('approved app close stops transfers, drains save cleanup and requests helper shutdown once', async t => {
  const f = await fixture(t);
  f.context.sessionForShutdownTest = {
    kind: 'upload',
    process: { exitCode: null, stdin: { writable: true, end() { f.calls.push('transfer end'); } },
      kill() { f.calls.push('transfer stop'); } },
  };
  vm.runInContext('active = sessionForShutdownTest', f.context);
  const closing = f.beforeClose();
  assert.equal(f.beforeClose(), closing);
  assert.deepEqual(f.calls, ['transfer end', 'transfer stop', 'save cancellation']);
  let finished = false;
  closing.then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(f.calls.includes('worker shutdown'), false);
  f.stopped.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.at(-1), 'worker shutdown');
  assert.equal(finished, false);
  f.shutdown.resolve();
  await closing;
  assert.equal(finished, true);
  await f.beforeClose();
  assert.equal(f.calls.filter(item => item === 'worker shutdown').length, 1);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { registerAccountClose } = require('../electron/account_close.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Function Close Fixture
function fixture(t, options = {}) {
  const app = new EventEmitter(), window = new EventEmitter(), ipcMain = new EventEmitter();
  const contents = new EventEmitter(), sent = [], dialogs = [], errors = [];
  let destroyed = false, contentsDestroyed = false, quitCalls = 0, closeCalls = 0;
  window.webContents = contents;
  window.isDestroyed = () => destroyed;
  contents.isDestroyed = () => contentsDestroyed;
  contents.send = (...args) => sent.push(args);
  const close = () => {
    closeCalls++;
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    window.emit('close', event);
    if (!event.defaultPrevented) { destroyed = true; window.emit('closed'); }
    return event;
  };
  window.close = close;
  app.quit = () => { quitCalls++; app.emit('before-quit'); close(); };
  const dialog = { showMessageBox: async (owner, settings) => { dialogs.push({ owner, settings }); return { response: 0 }; } };
  const controller = registerAccountClose({ app, window, ipcMain, dialog, onError: error => errors.push(error), ...options });
  t.after(controller.dispose);
  const ready = (sender = contents) => ipcMain.emit('accounts:ready', { sender });
  const token = () => sent.findLast ? sent.findLast(item => item[0] === 'accounts:flush')?.[1]
    : [...sent].reverse().find(item => item[0] === 'accounts:flush')?.[1];
  const reply = (result = { ok: true }, request = token(), sender = contents) => ipcMain.emit('accounts:flushed', { sender }, request, result);
  const commit = () => contents.emit('did-navigate', {}, 'file:///index.html');
  return { app, window, ipcMain, contents, sent, dialogs, errors, dialog, controller, close, ready, token, reply, commit,
    isDestroyed: () => destroyed, quits: () => quitCalls, closes: () => closeCalls,
    destroyContents: () => { contentsDestroyed = true; },
    destroyWindow: () => { destroyed = true; window.emit('closed'); } };
}

test('close waits for the account flush and closes only after its acknowledgement', async t => {
  const f = fixture(t);
  f.ready();
  assert.equal(f.close().defaultPrevented, true);
  assert.equal(f.isDestroyed(), false);
  assert.match(f.token(), /^[0-9a-f-]{36}$/);
  await tick();
  assert.equal(f.isDestroyed(), false);
  f.reply(); await tick();
  assert.equal(f.isDestroyed(), true);
  assert.equal(f.dialogs.length, 0);
  assert.equal(f.quits(), 0);
  assert.equal(f.closes(), 2);
});

test('startup and a crashed idle renderer can close without waiting for an absent listener', t => {
  const startup = fixture(t);
  assert.equal(startup.close().defaultPrevented, false);
  assert.equal(startup.isDestroyed(), true);
  assert.deepEqual(startup.sent, []);
  const crashed = fixture(t);
  crashed.ready(); crashed.contents.emit('render-process-gone');
  assert.equal(crashed.close().defaultPrevented, false);
  assert.equal(crashed.isDestroyed(), true);
});

test('unrelated senders cannot register readiness or acknowledge another close', async t => {
  const startup = fixture(t);
  startup.ready({});
  assert.equal(startup.close().defaultPrevented, false);
  const f = fixture(t);
  f.ready(); f.close();
  f.reply({ ok: true }, f.token(), {});
  f.reply({ ok: true }, 'stale-token');
  f.reply({ ok: 'yes' });
  await tick();
  assert.equal(f.isDestroyed(), false);
  assert.equal(f.dialogs.length, 0);
  f.reply(); await tick();
  assert.equal(f.isDestroyed(), true);
});

test('repeated close requests share one flush and one failure decision', async t => {
  const f = fixture(t);
  let choose;
  f.dialog.showMessageBox = async (owner, settings) => {
    f.dialogs.push({ owner, settings });
    return new Promise(resolve => { choose = resolve; });
  };
  f.ready(); f.close(); f.close(); f.close();
  assert.equal(f.sent.filter(item => item[0] === 'accounts:flush').length, 1);
  f.reply({ ok: false, error: 'Name already in use.' }); await tick();
  f.close(); f.reply(); await tick();
  assert.equal(f.dialogs.length, 1);
  assert.equal(f.isDestroyed(), false);
  assert.equal(f.dialogs[0].owner, f.window);
  assert.equal(f.dialogs[0].settings.defaultId, 0);
  assert.equal(f.dialogs[0].settings.cancelId, 0);
  assert.equal(f.dialogs[0].settings.detail, 'Name already in use.');
  choose({ response: 0 }); await tick();
  assert.equal(f.isDestroyed(), false);
  assert.equal(f.sent.at(-1)[0], 'accounts:close-cancelled');
});

test('a declined close resumes editing and stale acknowledgements cannot close a later attempt', async t => {
  const f = fixture(t);
  f.ready(); f.close();
  const previous = f.token();
  f.reply({ ok: false, error: 'Write failed.' }); await tick();
  assert.equal(f.isDestroyed(), false);
  assert.deepEqual(f.sent.at(-1), ['accounts:close-cancelled', previous]);
  f.close();
  assert.notEqual(f.token(), previous);
  f.reply({ ok: true }, previous); await tick();
  assert.equal(f.isDestroyed(), false);
  f.reply(); await tick();
  assert.equal(f.isDestroyed(), true);
});

test('discarding unsaved names intentionally closes after a failed flush', async t => {
  const f = fixture(t);
  f.dialog.showMessageBox = async () => ({ response: 1 });
  f.ready(); f.close(); f.reply({ ok: false, error: 'Permission denied.' }); await tick();
  assert.equal(f.isDestroyed(), true);
  assert.equal(f.sent.some(item => item[0] === 'accounts:close-cancelled'), false);
});

test('a timed-out flush keeps the app open and ignores the late acknowledgement', async t => {
  const f = fixture(t, { timeoutMs: 10 });
  f.ready(); f.close();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(f.dialogs.length, 1);
  assert.match(f.dialogs[0].settings.detail, /Timed out/);
  assert.equal(f.isDestroyed(), false);
  f.reply(); await tick();
  assert.equal(f.isDestroyed(), false);
  assert.equal(f.sent.at(-1)[0], 'accounts:close-cancelled');
});

test('a failed recovery dialog reports the error and resumes editing', async t => {
  const f = fixture(t);
  const failure = new Error('Native dialog unavailable.');
  f.dialog.showMessageBox = async () => { throw failure; };
  f.ready(); f.close(); f.reply({ ok: false, error: 'Could not save.' }); await tick();
  assert.equal(f.isDestroyed(), false);
  assert.deepEqual(f.errors, [failure]);
  assert.equal(f.sent.at(-1)[0], 'accounts:close-cancelled');
});

test('explicit Quit resumes app.quit after the flush while normal Close only closes the window', async t => {
  const f = fixture(t);
  f.ready(); f.app.quit();
  assert.equal(f.quits(), 1);
  assert.equal(f.isDestroyed(), false);
  f.reply(); await tick();
  assert.equal(f.quits(), 2);
  assert.equal(f.isDestroyed(), true);
});

test('declining an explicit Quit resets quit intent for a later normal Close', async t => {
  const f = fixture(t);
  f.ready(); f.app.quit(); f.reply({ ok: false, error: 'Write failed.' }); await tick();
  assert.equal(f.quits(), 1);
  assert.equal(f.isDestroyed(), false);
  f.close(); f.reply(); await tick();
  assert.equal(f.quits(), 1);
  assert.equal(f.isDestroyed(), true);
});

test('Quit during an already-pending window Close retains explicit quit intent', async t => {
  const f = fixture(t);
  f.ready(); f.close(); f.app.quit();
  assert.equal(f.sent.filter(item => item[0] === 'accounts:flush').length, 1);
  f.reply(); await tick();
  assert.equal(f.quits(), 2);
  assert.equal(f.isDestroyed(), true);
});

test('closing disposes every listener and pending timers without accepting later replies', async t => {
  const f = fixture(t, { timeoutMs: 10 });
  f.ready(); f.close(); f.destroyWindow();
  assert.equal(f.ipcMain.listenerCount('accounts:ready'), 0);
  assert.equal(f.ipcMain.listenerCount('accounts:flushed'), 0);
  assert.equal(f.app.listenerCount('before-quit'), 0);
  assert.equal(f.contents.listenerCount('render-process-gone'), 0);
  assert.equal(f.contents.listenerCount('did-start-navigation'), 0);
  assert.equal(f.contents.listenerCount('did-navigate'), 0);
  assert.equal(f.window.listenerCount('close'), 0);
  f.reply();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(f.dialogs.length, 0);
});

test('a destroyed renderer or a window closed during a decision cannot receive approval', async t => {
  const dead = fixture(t);
  dead.ready(); dead.destroyContents();
  assert.equal(dead.close().defaultPrevented, false);
  const f = fixture(t);
  let choose;
  f.dialog.showMessageBox = async () => new Promise(resolve => { choose = resolve; });
  f.ready(); f.close(); f.reply({ ok: false, error: 'Could not save.' }); await tick();
  f.destroyWindow(); choose({ response: 1 }); await tick();
  assert.equal(f.quits(), 0);
  assert.equal(f.closes(), 1);
});

test('a request send failure still offers editing or an explicit discard', async t => {
  const f = fixture(t);
  const failure = new Error('Renderer unavailable.');
  f.contents.send = (channel, token) => {
    if (channel === 'accounts:flush') throw failure;
    f.sent.push([channel, token]);
  };
  f.ready(); f.close(); await tick();
  assert.equal(f.isDestroyed(), false);
  assert.equal(f.dialogs.length, 1);
  assert.equal(f.dialogs[0].settings.detail, failure.message);
  assert.deepEqual(f.errors, [failure]);
  assert.equal(f.sent.at(-1)[0], 'accounts:close-cancelled');
});

test('closing during a full reload waits for the replacement listener then flushes it', async t => {
  const f = fixture(t);
  f.ready();
  f.contents.emit('did-start-navigation', {}, 'file:///index.html', false, true);
  assert.equal(f.close().defaultPrevented, true);
  assert.equal(f.isDestroyed(), false);
  assert.equal(f.sent.length, 0);
  f.commit(); f.ready();
  assert.match(f.token(), /^[0-9a-f-]{36}$/);
  f.reply(); await tick();
  assert.equal(f.isDestroyed(), true);
  assert.equal(f.dialogs.length, 0);
});

test('a pending flush is invalidated by reload and old-page acknowledgements cannot close', async t => {
  const f = fixture(t);
  f.ready(); f.close();
  const previous = f.token();
  f.contents.emit('did-start-navigation', {}, 'file:///index.html', false, true);
  f.reply({ ok: true }, previous); await tick();
  assert.equal(f.isDestroyed(), false);
  assert.equal(f.sent.length, 1);
  f.commit(); f.ready();
  const current = f.token();
  assert.notEqual(current, previous);
  f.reply({ ok: true }, previous); await tick();
  assert.equal(f.isDestroyed(), false);
  f.reply({ ok: true }, current); await tick();
  assert.equal(f.isDestroyed(), true);
});

test('a native decision from the old page cannot discard or cancel a replacement-page close', async t => {
  const f = fixture(t);
  let decide;
  f.dialog.showMessageBox = async () => new Promise(resolve => { decide = resolve; });
  f.ready(); f.app.quit();
  f.reply({ ok: false, error: 'Old page failure.' }); await tick();
  f.contents.emit('did-start-navigation', {}, 'file:///index.html', false, true);
  f.commit(); f.ready();
  const current = f.token();
  decide({ response: 1 }); await tick();
  assert.equal(f.isDestroyed(), false);
  assert.equal(f.sent.some(item => item[0] === 'accounts:close-cancelled'), false);
  f.reply({ ok: true }, current); await tick();
  assert.equal(f.isDestroyed(), true);
  assert.equal(f.quits(), 2);
});

test('replacement-page failure waits for the old native decision instead of stacking dialogs', async t => {
  const f = fixture(t);
  const decisions = [];
  f.dialog.showMessageBox = async (_owner, options) => {
    f.dialogs.push(options);
    return new Promise(resolve => decisions.push(resolve));
  };
  f.ready(); f.close(); f.reply({ ok: false, error: 'Old page failure.' }); await tick();
  f.contents.emit('did-start-navigation', {}, 'file:///index.html', false, true);
  f.commit(); f.ready(); f.reply({ ok: false, error: 'New page failure.' }); await tick();
  assert.equal(f.dialogs.length, 1);
  decisions[0]({ response: 1 }); await tick();
  assert.equal(f.isDestroyed(), false);
  assert.equal(f.dialogs.length, 2);
  assert.equal(f.dialogs[1].detail, 'New page failure.');
  decisions[1]({ response: 0 }); await tick();
  assert.equal(f.isDestroyed(), false);
  assert.equal(f.sent.at(-1)[0], 'accounts:close-cancelled');
});

test('subframe and in-place navigations leave the current flush and listener ready', async t => {
  const f = fixture(t);
  f.ready(); f.close();
  const current = f.token();
  f.contents.emit('did-start-navigation', {}, 'file:///child.html', false, false);
  f.contents.emit('did-start-navigation', {}, 'file:///index.html#section', true, true);
  f.contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  f.reply({ ok: true }, current); await tick();
  assert.equal(f.isDestroyed(), true);
  assert.equal(f.sent.filter(item => item[0] === 'accounts:flush').length, 1);
});

test('modern full-navigation details also invalidate readiness while initial startup stays closable', async t => {
  const startup = fixture(t);
  startup.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  assert.equal(startup.close().defaultPrevented, false);
  const f = fixture(t);
  f.ready();
  f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  assert.equal(f.close().defaultPrevented, true);
  assert.equal(f.sent.length, 0);
  f.commit(); f.ready(); f.reply(); await tick();
  assert.equal(f.isDestroyed(), true);
});

test('waiting for reload readiness retains the close deadline and offers a safe timeout', async t => {
  const f = fixture(t, { timeoutMs: 10 });
  f.ready(); f.close();
  f.contents.emit('did-start-navigation', {}, 'file:///index.html', false, true);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(f.dialogs.length, 1);
  assert.match(f.dialogs[0].settings.detail, /Timed out/);
  assert.equal(f.isDestroyed(), false);
  assert.equal(f.sent.at(-1)[0], 'accounts:close-cancelled');
});

test('navigation while a decision is open cannot restart an expired close deadline', async t => {
  const f = fixture(t, { timeoutMs: 10 });
  let firstDecision;
  f.dialog.showMessageBox = async (_owner, settings) => {
    f.dialogs.push(settings);
    if (f.dialogs.length === 1) return new Promise(resolve => { firstDecision = resolve; });
    return { response: 0 };
  };
  f.ready(); f.close(); f.reply({ ok: false, error: 'Could not save.' }); await tick();
  await new Promise(resolve => setTimeout(resolve, 20));
  f.contents.emit('did-start-navigation', {}, 'file:///index.html', false, true);
  f.commit(); f.ready(); await tick();
  assert.equal(f.sent.filter(item => item[0] === 'accounts:flush').length, 1);
  firstDecision({ response: 1 }); await tick();
  assert.equal(f.isDestroyed(), false);
  assert.equal(f.dialogs.length, 2);
  assert.match(f.dialogs[1].detail, /Timed out/);
});

test('ready and flush IPC reject stale or subframe senders when a current main frame is available', async t => {
  const f = fixture(t);
  const mainFrame = {};
  f.contents.mainFrame = mainFrame;
  f.ready(); f.close();
  const previous = f.token();
  f.contents.emit('did-start-navigation', {}, 'file:///index.html', false, true);
  f.ipcMain.emit('accounts:ready', { sender: f.contents, senderFrame: mainFrame });
  assert.equal(f.sent.length, 1, 'The old main frame registered readiness before the new document committed');
  f.contents.mainFrame = {};
  f.commit();
  f.ipcMain.emit('accounts:ready', { sender: f.contents, senderFrame: mainFrame });
  assert.equal(f.sent.length, 1);
  f.ipcMain.emit('accounts:ready', { sender: f.contents, senderFrame: f.contents.mainFrame });
  const current = f.token();
  assert.notEqual(current, previous);
  f.ipcMain.emit('accounts:flushed', { sender: f.contents, senderFrame: mainFrame }, current, { ok: true });
  await tick();
  assert.equal(f.isDestroyed(), false);
  f.ipcMain.emit('accounts:flushed', { sender: f.contents, senderFrame: f.contents.mainFrame }, current, { ok: true });
  await tick();
  assert.equal(f.isDestroyed(), true);
});

test('approved close awaits one service shutdown across repeated Close, Quit and navigation', async t => {
  const stopping = gate();
  let calls = 0;
  const f = fixture(t, { beforeClose: async () => { calls++; await stopping.promise; } });
  f.ready(); f.close();
  assert.equal(calls, 0);
  f.reply(); await tick();
  assert.equal(calls, 1);
  assert.equal(f.isDestroyed(), false);
  f.close(); f.app.quit();
  f.contents.emit('did-start-navigation', {}, 'file:///index.html', false, true);
  f.contents.emit('render-process-gone');
  await tick();
  assert.equal(calls, 1);
  assert.equal(f.sent.filter(item => item[0] === 'accounts:flush').length, 1);
  stopping.resolve(); await tick();
  assert.equal(f.isDestroyed(), true);
  assert.equal(f.quits(), 2);
});

test('Keep editing leaves services running while explicit discard shuts them down', async t => {
  let calls = 0;
  const f = fixture(t, { beforeClose: async () => { calls++; } });
  f.ready(); f.close(); f.reply({ ok: false, error: 'Name save failed.' }); await tick();
  assert.equal(calls, 0);
  assert.equal(f.isDestroyed(), false);
  f.dialog.showMessageBox = async () => ({ response: 1 });
  f.close(); f.reply({ ok: false, error: 'Name save failed.' }); await tick();
  assert.equal(calls, 1);
  assert.equal(f.isDestroyed(), true);
});

test('service shutdown also runs without a ready or surviving renderer', async t => {
  for (const state of ['startup', 'crashed', 'destroyed']) {
    const stopping = gate();
    let calls = 0;
    const f = fixture(t, { beforeClose: async () => { calls++; await stopping.promise; } });
    if (state !== 'startup') f.ready();
    if (state === 'crashed') f.contents.emit('render-process-gone');
    if (state === 'destroyed') f.destroyContents();
    assert.equal(f.close().defaultPrevented, true, state);
    f.close(); await tick();
    assert.equal(calls, 1, state);
    assert.equal(f.isDestroyed(), false, state);
    assert.deepEqual(f.sent, [], state);
    stopping.resolve(); await tick();
    assert.equal(f.isDestroyed(), true, state);
  }
});

test('a service shutdown failure is reported and does not strand an approved close', async t => {
  const error = new Error('Local PS5 is unreachable.');
  const f = fixture(t, { beforeClose: async () => { throw error; } });
  f.ready(); f.close(); f.reply(); await tick();
  assert.deepEqual(f.errors, [error]);
  assert.equal(f.isDestroyed(), true);
});

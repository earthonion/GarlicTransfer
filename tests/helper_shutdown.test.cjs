const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { LocalHelper } = require('../electron/local_helper.cjs');
const { shutdownLocalWorker } = require('../electron/local_worker.cjs');

const INSTANCE = '0123456789abcdef0123456789abcdef';
const RESTARTED = 'fedcba9876543210fedcba9876543210';

// Function Test Frame
function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(body.length);
  return Buffer.concat([prefix, body]);
}

// Function Test Messages
function messages(socket, receive) {
  let pending = Buffer.alloc(0);
  socket.on('data', chunk => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4 && pending.length >= pending.readUInt32BE() + 4) {
      const size = pending.readUInt32BE();
      const message = JSON.parse(pending.subarray(4, size + 4));
      pending = pending.subarray(size + 4);
      receive(message);
    }
  });
}

// Function Test Worker
async function fixture(t, { instance = INSTANCE, controlInstance = instance, legacy = false, controlHello, onRequest, saveHello } = {}) {
  const sockets = new Set();
  const requests = [];
  const logs = [];
  let controlConnections = 0;
  const servers = [];
  const open = async handler => {
    const server = net.createServer(socket => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.once('close', () => sockets.delete(socket));
      handler(socket);
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server;
  };
  const control = await open(socket => {
    controlConnections++;
    if (controlHello !== null) socket.write(frame(controlHello || {
      type: 'hello', protocol: 'garlic-local-control-v1', platform: 'ps5', instance_id: controlInstance,
    }));
    messages(socket, message => {
      requests.push(message);
      if (onRequest) onRequest(socket, message);
      else socket.end(frame({ type: 'shutdown_accepted', instance_id: controlInstance }));
    });
  });
  const controlPort = control.address().port;
  const save = await open(socket => {
    if (saveHello === null) return;
    socket.end(frame(saveHello || {
      type: 'hello', protocol: 'garlic-local-v1', platform: 'ps5',
      ...(legacy ? {} : { capabilities: ['shutdown'], instance_id: instance, shutdown_port: controlPort, owns_ppr: true }),
    }));
  });
  const helper = new LocalHelper({ elfPath: '/unused-local-worker.elf', port: save.address().port,
    controlPort, shutdownTimeoutMs: 100, onLog: message => logs.push(message), probeTimeoutMs: 100 });
  t.after(async () => {
    helper.stop();
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.filter(server => server.listening).map(server => new Promise(resolve => server.close(resolve))));
  });
  return { helper, control, save, requests, logs, open, controlPort,
    connections: () => controlConnections,
    shutdown: extra => shutdownLocalWorker({ host: '127.0.0.1', port: controlPort, instanceId: instance,
      timeoutMs: 100, ...extra }),
  };
}

test('closing without a used local worker sends no shutdown request', async t => {
  const f = await fixture(t);
  await f.helper.shutdown();
  assert.equal(f.connections(), 0);
  assert.deepEqual(f.requests, []);
  await assert.rejects(f.helper.ensure('127.0.0.1'), /stopped/i);
});

test('a reused local worker receives one instance-bound shutdown for concurrent closes', async t => {
  const f = await fixture(t);
  await f.helper.ensure('127.0.0.1');
  await f.helper.ensure('127.0.0.1');
  await Promise.all([f.helper.shutdown(), f.helper.shutdown()]);
  assert.equal(f.connections(), 1);
  assert.deepEqual(f.requests, [{ type: 'shutdown', instance_id: INSTANCE }]);
});

test('a restarted worker is left untouched when its instance no longer matches', async t => {
  const f = await fixture(t, { controlInstance: RESTARTED });
  await f.helper.ensure('127.0.0.1');
  await f.helper.shutdown();
  assert.equal(f.connections(), 1);
  assert.deepEqual(f.requests, []);
  assert.ok(f.logs.some(message => /could not stop/i.test(message)));
});

test('legacy local helpers are reused without sending an unsupported stop command', async t => {
  const f = await fixture(t, { legacy: true });
  await f.helper.ensure('127.0.0.1');
  await f.helper.shutdown();
  assert.equal(f.connections(), 0);
  assert.deepEqual(f.requests, []);
});

test('an unrelated transfer oracle is not treated as a local save worker', async t => {
  const f = await fixture(t);
  const oracle = await f.open(socket => socket.end('standalone PPR oracle'));
  await f.helper.ensureTransfer('127.0.0.1', oracle.address().port);
  await f.helper.shutdown();
  assert.equal(f.connections(), 0);
  assert.deepEqual(f.requests, []);
});

test('an unreachable used worker is reported without hanging application close', async t => {
  const f = await fixture(t);
  await f.helper.ensure('127.0.0.1');
  await new Promise(resolve => f.control.close(resolve));
  const start = Date.now();
  await f.helper.shutdown();
  assert.ok(Date.now() - start < 3000);
  assert.deepEqual(f.requests, []);
  assert.ok(f.logs.some(message => /shutdown|stop|close/i.test(message)));
});

test('shutdown cancels an occupied startup wait before closing', async t => {
  const f = await fixture(t, { saveHello: null });
  const ensuring = f.helper.ensure('127.0.0.1').then(() => null, error => error);
  const deadline = Date.now() + 3000;
  while (!f.logs.some(message => /Waiting for the save helper/.test(message))) {
    assert.ok(Date.now() < deadline, 'Startup did not reach its occupied-port wait');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await f.helper.shutdown();
  assert.match((await ensuring).message, /stopped/i);
  assert.equal(f.helper.pending.size, 0);
  assert.equal(f.helper.controllers.size, 0);
  assert.deepEqual(f.requests, []);
});

test('a delivered worker that starts during close still receives shutdown', async t => {
  const f = await fixture(t);
  const savePort = f.save.address().port;
  await new Promise(resolve => f.save.close(resolve));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'garlic-closing-helper-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const elfPath = path.join(directory, 'local.elf');
  await fs.writeFile(elfPath, 'local worker payload');
  let delivered;
  const received = new Promise(resolve => { delivered = resolve; });
  const loader = await f.open(socket => {
    socket.resume();
    socket.once('end', delivered);
  });
  f.helper.elfPath = elfPath;
  f.helper.loaderPort = loader.address().port;
  f.helper.retryIntervalMs = 5;
  f.helper.shutdownTimeoutMs = 500;
  const ensuring = f.helper.ensure('127.0.0.1').then(() => null, error => error);
  await received;
  const appearing = new Promise(resolve => {
    setTimeout(() => {
      f.save.listen(savePort, '127.0.0.1', resolve);
    }, 40);
  });
  await f.helper.shutdown();
  await ensuring;
  await appearing;
  assert.deepEqual(f.requests, [{ type: 'shutdown', instance_id: INSTANCE }]);
});

test('the shutdown client binds its command to the verified helper instance', async t => {
  const f = await fixture(t);
  await f.shutdown();
  assert.deepEqual(f.requests, [{ type: 'shutdown', instance_id: INSTANCE }]);
});

test('an unrelated control service receives no shutdown command', async t => {
  const f = await fixture(t, { controlHello: { type: 'hello', protocol: 'unrelated', platform: 'ps5', instance_id: INSTANCE } });
  await assert.rejects(f.shutdown(), /helper|control|compatible|shutdown/i);
  assert.deepEqual(f.requests, []);
});

test('a silent control listener times out without sending a shutdown command', async t => {
  const f = await fixture(t, { controlHello: null });
  const start = Date.now();
  await assert.rejects(f.shutdown({ timeoutMs: 40 }), /timed out|timeout/i);
  assert.ok(Date.now() - start < 3000);
  assert.deepEqual(f.requests, []);
});

test('shutdown acknowledgement must identify the requested process instance', async t => {
  const f = await fixture(t, { onRequest(socket) {
    socket.end(frame({ type: 'shutdown_accepted', instance_id: RESTARTED }));
  } });
  await assert.rejects(f.shutdown(), /instance|shutdown|response/i);
  assert.deepEqual(f.requests, [{ type: 'shutdown', instance_id: INSTANCE }]);
});

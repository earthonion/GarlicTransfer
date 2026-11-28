const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const { runLocalWorkerJob } = require('../electron/local_worker.cjs');

// Function Test Frame
function frame(message) {
  const data = Buffer.from(JSON.stringify(message));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(data.length);
  return Buffer.concat([prefix, data]);
}

// Function Test Peer
class Peer {
  constructor(socket) {
    this.socket = socket;
    this.data = Buffer.alloc(0);
    this.ended = false;
    socket.on('data', (chunk) => { this.data = Buffer.concat([this.data, chunk]); this.wake?.(); });
    socket.on('close', () => { this.ended = true; this.wake?.(); });
    socket.on('error', () => {});
  }

  async read(size) {
    while (this.data.length < size) {
      if (this.ended) throw Object.assign(new Error('Test peer closed'), { code: 'EOF' });
      await new Promise((resolve) => { this.wake = resolve; });
    }
    const result = this.data.subarray(0, size);
    this.data = this.data.subarray(size);
    return result;
  }

  async message() {
    const size = (await this.read(4)).readUInt32BE();
    return JSON.parse((await this.read(size)).toString());
  }

  write(data) {
    return new Promise((resolve, reject) => this.socket.write(data, (error) => error ? reject(error) : resolve()));
  }

  send(message) { return this.write(frame(message)); }
}

// Function Test Signal
function gate() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// Function Test Worker
async function fixture(t, handler, input = Buffer.from('PK\x03\x04encrypted input')) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'garlic-local-worker-'));
  const inputArchive = path.join(root, 'input.zip');
  const resultPath = path.join(root, 'result.zip');
  await fs.writeFile(inputArchive, input);
  await fs.writeFile(resultPath, 'existing result');
  const sockets = new Set();
  const tasks = [];
  const errors = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    tasks.push(Promise.resolve().then(() => handler(new Peer(socket))).catch((error) => {
      if (!['EOF', 'ECONNRESET', 'EPIPE', 'ERR_STREAM_DESTROYED'].includes(error.code)) errors.push(error);
      socket.destroy();
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await Promise.all(tasks);
    await fs.rm(root, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  const options = { host: '127.0.0.1', port: server.address().port, operation: 'decrypt', inputArchive, resultPath, timeoutMs: 3000 };
  return {
    root, input, options,
    run: (extra = {}) => runLocalWorkerJob({ ...options, ...extra }),
    async unchanged() {
      assert.equal(await fs.readFile(resultPath, 'utf8'), 'existing result');
      assert.deepEqual((await fs.readdir(root)).sort(), ['input.zip', 'result.zip']);
    },
  };
}

// Function Test Job
async function begin(peer, hello = { type: 'hello', protocol: 'garlic-local-v1', platform: 'ps5' }) {
  await peer.send(hello);
  return peer.message();
}

// Function Test Input
async function inputFor(peer, job) {
  await peer.send({ type: 'file_request', job_id: job.id });
  const header = await peer.message();
  assert.equal(header.type, 'file_data');
  assert.equal(header.job_id, job.id);
  return peer.read(header.size);
}

// Function Test Result
async function resultFor(peer, job, data) {
  await peer.write(Buffer.concat([frame({ type: 'result_start', job_id: job.id, size: data.length }), data]));
  assert.deepEqual(await peer.message(), { type: 'result_ok', job_id: job.id });
}

test('local worker streams fragmented binary archives and publishes only after done', async (t) => {
  const input = Buffer.concat([Buffer.from('PK\x03\x04'), randomBytes(2 * 1024 * 1024)]);
  const output = Buffer.concat([Buffer.from('PK\x03\x04'), randomBytes(1024 * 1024)]);
  const received = gate();
  const finish = gate();
  const logs = [];
  const statuses = [];
  const f = await fixture(t, async (peer) => {
    const hello = frame({ type: 'hello', protocol: 'garlic-local-v1', platform: 'ps5' });
    await peer.write(hello.subarray(0, 2));
    await new Promise((resolve) => setImmediate(resolve));
    await peer.write(hello.subarray(2, 9));
    await new Promise((resolve) => setImmediate(resolve));
    await peer.write(hello.subarray(9));
    const job = await peer.message();
    assert.equal(job.type, 'job');
    assert.equal(job.operation, 'encrypt');
    assert.deepEqual(job.params, { account_id: '1234567890abcdef' });
    await peer.write(Buffer.concat([
      frame({ type: 'log', job_id: job.id, msg: 'Processing locally' }),
      frame({ type: 'file_request', job_id: job.id }),
    ]));
    const header = await peer.message();
    assert.equal(header.size, input.length);
    assert.deepEqual(await peer.read(header.size), input);
    const resultHeader = frame({ type: 'result_start', job_id: job.id, size: output.length });
    await peer.write(resultHeader.subarray(0, 3));
    await new Promise((resolve) => setImmediate(resolve));
    await peer.write(Buffer.concat([resultHeader.subarray(3), output.subarray(0, 11)]));
    for (let offset = 11; offset < output.length; offset += 32768) await peer.write(output.subarray(offset, offset + 32768));
    assert.deepEqual(await peer.message(), { type: 'result_ok', job_id: job.id });
    received.resolve(job.id);
    await finish.promise;
    peer.socket.end(frame({ type: 'status', job_id: job.id, status: 'done' }));
  }, input);
  const running = f.run({ operation: 'encrypt', params: { account_id: '1234567890abcdef' }, onLog: (s) => logs.push(s), onStatus: (s) => statuses.push(s) });
  const jobId = await received.promise;
  assert.equal(await fs.readFile(f.options.resultPath, 'utf8'), 'existing result');
  finish.resolve();
  assert.deepEqual(await running, { jobId, output: f.options.resultPath });
  assert.deepEqual(await fs.readFile(f.options.resultPath), output);
  assert.deepEqual(await fs.readFile(f.options.inputArchive), input);
  assert.deepEqual(logs, ['Processing locally']);
  assert.deepEqual(statuses, ['running', 'done']);
  assert.deepEqual((await fs.readdir(f.root)).sort(), ['input.zip', 'result.zip']);
});

test('local worker failure after receiving a result preserves the previous output', async (t) => {
  const f = await fixture(t, async (peer) => {
    const job = await begin(peer);
    await inputFor(peer, job);
    await resultFor(peer, job, Buffer.from('PK\x03\x04uncommitted'));
    peer.socket.end(frame({ type: 'status', job_id: job.id, status: 'failed', error: 'Mount validation failed' }));
  });
  await assert.rejects(f.run(), /Mount validation failed/);
  await f.unchanged();
});

test('a truncated worker result cannot replace the previous output', async (t) => {
  const f = await fixture(t, async (peer) => {
    const job = await begin(peer);
    await inputFor(peer, job);
    peer.socket.end(Buffer.concat([frame({ type: 'result_start', job_id: job.id, size: 100 }), Buffer.from('short')]));
  });
  await assert.rejects(f.run(), /disconnected/);
  await f.unchanged();
});

test('a complete result without final done is discarded', async (t) => {
  const f = await fixture(t, async (peer) => {
    const job = await begin(peer);
    await inputFor(peer, job);
    await resultFor(peer, job, Buffer.from('PK\x03\x04complete'));
    peer.socket.end();
  });
  await assert.rejects(f.run(), /disconnected/);
  await f.unchanged();
});

test('local worker job deadline stops a stalled connection without modifying output', async (t) => {
  const f = await fixture(t, async (peer) => { await begin(peer); });
  await assert.rejects(f.run({ timeoutMs: 50 }), /timed out/);
  await f.unchanged();
});

test('a silent helper must complete its handshake before the connection deadline', async (t) => {
  const f = await fixture(t, () => {});
  await assert.rejects(f.run({ connectTimeoutMs: 50, timeoutMs: 1000 }), /connection timed out/);
  await f.unchanged();
});

test('canceling a local worker job discards its staged result', async (t) => {
  const received = gate();
  const f = await fixture(t, async (peer) => {
    const job = await begin(peer);
    await inputFor(peer, job);
    await resultFor(peer, job, Buffer.from('PK\x03\x04not committed'));
    received.resolve();
  });
  const controller = new AbortController();
  const result = f.run({ signal: controller.signal });
  await received.promise;
  controller.abort();
  await assert.rejects(result, /canceled/);
  await f.unchanged();
});

test('pre-canceled local jobs do not connect to the helper', async (t) => {
  let connections = 0;
  const f = await fixture(t, () => { connections++; });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.run({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(connections, 0);
  await f.unchanged();
});

test('canceling during a fragmented control message retains abort semantics', async (t) => {
  const partial = gate();
  const f = await fixture(t, async (peer) => {
    const job = await begin(peer);
    await peer.write(frame({ type: 'log', job_id: job.id, msg: 'Still processing' }).subarray(0, 8));
    partial.resolve();
  });
  const controller = new AbortController();
  const running = f.run({ signal: controller.signal });
  const rejection = assert.rejects(running, { name: 'AbortError' });
  await partial.promise;
  controller.abort();
  await rejection;
  await f.unchanged();
});

test('local worker requires the matching PS5 helper protocol', async (t) => {
  const f = await fixture(t, async (peer) => {
    await peer.send({ type: 'hello', protocol: 'different-helper', platform: 'ps5' });
  });
  await assert.rejects(f.run(), /compatible Garlic local save helper/);
  await f.unchanged();
});

test('local PPSA changes negotiate support and stream the target with encrypt and resign', async (t) => {
  for (const operation of ['encrypt', 'resign']) {
    await t.test(operation, async t => {
      const f = await fixture(t, async peer => {
        const job = await begin(peer, {
          type: 'hello', protocol: 'garlic-local-v1', platform: 'ps5', capabilities: ['target_title_id'],
        });
        assert.equal(job.operation, operation);
        assert.equal(job.params.target_title_id, 'PPSA54321');
        assert.equal(job.params.account_id, '0833114e9585c53c');
        assert.deepEqual(await inputFor(peer, job), f.input);
        await resultFor(peer, job, Buffer.from('PK\x03\x04retitled'));
        peer.socket.end(frame({ type: 'status', job_id: job.id, status: 'done' }));
      });
      await f.run({ operation, params: { account_id: '0833114e9585c53c', target_title_id: 'PPSA54321' } });
      assert.equal(await fs.readFile(f.options.resultPath, 'utf8'), 'PK\x03\x04retitled');
      assert.deepEqual(await fs.readFile(f.options.inputArchive), f.input);
    });
  }
});

test('older or unsupported helpers receive no PPSA-change job or input archive', async (t) => {
  for (const capabilities of [undefined, [], 'target_title_id', ['other_feature']]) {
    await t.test(JSON.stringify(capabilities) || 'no capabilities', async t => {
      let receivedBytes = 0;
      const closed = gate();
      const f = await fixture(t, async peer => {
        peer.socket.on('data', chunk => { receivedBytes += chunk.length; });
        peer.socket.once('close', closed.resolve);
        await peer.send({ type: 'hello', protocol: 'garlic-local-v1', platform: 'ps5', capabilities });
      });
      await assert.rejects(f.run({
        operation: 'encrypt', params: { account_id: '0833114e9585c53c', target_title_id: 'PPSA54321' },
      }), /PPSA|title.?ID|restart|update|upgrade/i);
      await closed.promise;
      assert.equal(receivedBytes, 0);
      await f.unchanged();
    });
  }
});

test('invalid PPSA parameters are rejected before a local helper connection opens', async (t) => {
  let connections = 0;
  const f = await fixture(t, () => { connections++; });
  for (const target_title_id of ['PPSA1234', 'PPSA123456', 'CUSA12345', 'PPSA12A45']) {
    await assert.rejects(f.run({
      operation: 'encrypt', params: { account_id: '0833114e9585c53c', target_title_id },
    }), /PPSA|title ID/i);
  }
  await assert.rejects(f.run({
    operation: 'decrypt', params: { target_title_id: 'PPSA54321' },
  }), /encrypt|resign|PPSA|title ID/i);
  assert.equal(connections, 0);
  await f.unchanged();
});

test('local worker rejects mismatched IDs for file, log, result and status messages', async (t) => {
  for (const message of [
    { type: 'file_request' }, { type: 'log', msg: 'wrong job' },
    { type: 'result_start', size: 10 }, { type: 'status', status: 'done' },
  ]) {
    await t.test(message.type, async (t) => {
      const f = await fixture(t, async (peer) => {
        await begin(peer);
        peer.socket.end(frame({ ...message, job_id: 'not-this-job' }));
      });
      await assert.rejects(f.run(), /mismatched job ID/);
      await f.unchanged();
    });
  }
});

test('local worker rejects invalid message framing before any job can run', async (t) => {
  for (const [name, data] of [
    ['oversized', Buffer.from([0, 2, 0, 0])],
    ['empty', Buffer.alloc(4)],
    ['invalid JSON', Buffer.concat([Buffer.from([0, 0, 0, 3]), Buffer.from('bad')])],
  ]) {
    await t.test(name, async (t) => {
      const f = await fixture(t, (peer) => { peer.socket.end(data); });
      await assert.rejects(f.run(), /Invalid local helper message/);
      await f.unchanged();
    });
  }
});

test('local worker validates result sizes without accepting a partial archive', async (t) => {
  for (const size of [0, -1, 1.5, 0x100000000, null]) {
    await t.test(String(size), async (t) => {
      const f = await fixture(t, async (peer) => {
        const job = await begin(peer);
        await inputFor(peer, job);
        peer.socket.end(frame({ type: 'result_start', job_id: job.id, size }));
      });
      await assert.rejects(f.run(), /result archive size/);
      await f.unchanged();
    });
  }
});

test('duplicate result messages cannot publish an earlier uncommitted result', async (t) => {
  const f = await fixture(t, async (peer) => {
    const job = await begin(peer);
    await inputFor(peer, job);
    await resultFor(peer, job, Buffer.from('PK\x03\x04first'));
    peer.socket.end(frame({ type: 'result_start', job_id: job.id, size: 5 }));
  });
  await assert.rejects(f.run(), /duplicate local helper result/);
  await f.unchanged();
});

test('unexpected helper responses and success without a result fail safely', async (t) => {
  for (const message of [{ type: 'other' }, { type: 'status', status: 'queued' }, { type: 'status', status: 'done' }]) {
    await t.test(JSON.stringify(message), async (t) => {
      const f = await fixture(t, async (peer) => {
        const job = await begin(peer);
        peer.socket.end(frame({ ...message, job_id: job.id }));
      });
      await assert.rejects(f.run(), /Unexpected|without a complete result/);
      await f.unchanged();
    });
  }
});

test('invalid or empty local inputs fail before contacting a worker', async (t) => {
  let connections = 0;
  const f = await fixture(t, () => { connections++; });
  await fs.writeFile(f.options.inputArchive, '');
  await assert.rejects(f.run(), /nonempty classic ZIP/);
  await assert.rejects(f.run({ host: '' }), /helper IP/);
  await assert.rejects(f.run({ port: 70000 }), /helper port/);
  await assert.rejects(f.run({ operation: 'unrecognized' }), /Unsupported local/);
  await assert.rejects(f.run({ timeoutMs: 0 }), /timeout/);
  assert.equal(connections, 0);
  assert.equal(await fs.readFile(f.options.resultPath, 'utf8'), 'existing result');
});

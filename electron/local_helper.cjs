const net = require('node:net');
const fs = require('node:fs');
const { SAVE_PORT, PPR_PORT, CONTROL_PORT, LOADER_PORT, MAX_GREETING_BYTES, isWorkerGreeting } = require('./local_protocol.cjs');
const { shutdownLocalWorker } = require('./local_worker.cjs');

// Function Helper Check
function probeHelper(host, port, timeoutMs, signal, greeting = true) {
  if (signal?.aborted) return Promise.resolve({ ready: false, connected: false });
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    let finished = false;
    let connected = false;
    let buffer = Buffer.alloc(0);
    const finish = (ready, hello) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', canceled);
      socket.destroy();
      resolve({ ready, connected, ...(hello ? { hello } : {}) });
    };
    const canceled = () => finish(false);
    const timer = setTimeout(canceled, timeoutMs);
    signal?.addEventListener('abort', canceled, { once: true });
    socket.once('connect', () => { connected = true; if (!greeting) finish(true); });
    socket.on('data', data => {
      if (finished) return;
      if (buffer.length + data.length > MAX_GREETING_BYTES + 4) return finish(false);
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length < 4) return;
      const size = buffer.readUInt32BE();
      if (!size || size > MAX_GREETING_BYTES) return finish(false);
      if (buffer.length < size + 4) return;
      try {
        const hello = JSON.parse(buffer.subarray(4, size + 4).toString('utf8'));
        finish(isWorkerGreeting(hello), isWorkerGreeting(hello) ? hello : undefined);
      } catch { finish(false); }
    });
    socket.once('end', canceled);
    socket.once('close', canceled);
    socket.once('error', canceled);
  });
}

// Function Helper Delay
function delay(ms, signal) {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}

// Function Local Helper
class LocalHelper {
  constructor({ elfPath, onLog = () => {}, port = SAVE_PORT, loaderPort = LOADER_PORT, readyTimeoutMs = 15000,
    connectTimeoutMs = 10000, uploadTimeoutMs = 30000, probeTimeoutMs = 500, retryIntervalMs = 150,
    controlPort = CONTROL_PORT, shutdownTimeoutMs = 5000 }) {
    Object.assign(this, { elfPath, onLog, port, loaderPort, readyTimeoutMs, connectTimeoutMs,
      uploadTimeoutMs, probeTimeoutMs, retryIntervalMs, controlPort, shutdownTimeoutMs });
    this.pending = new Map();
    this.hostTasks = new Map();
    this.sockets = new Set();
    this.controllers = new Set();
    this.reads = new Map();
    this.usedHelpers = new Map();
    this.deployedHosts = new Set();
    this.shutdownWarnings = new Set();
    this.shutdownTask = null;
    this.stopped = false;
  }

  // Function Helper Identity
  async remember(host, service, result, signal) {
    if (!service.greeting && service.port !== PPR_PORT) return;
    const checked = service.greeting ? result : await probeHelper(host, this.port, this.probeTimeoutMs, signal);
    const hello = checked.hello;
    if (!checked.ready || !hello || (!service.greeting && hello.owns_ppr !== true)) return;
    if (!Array.isArray(hello.capabilities) || !hello.capabilities.includes('shutdown')
        || !/^[0-9a-f]{32}$/.test(hello.instance_id || '') || hello.shutdown_port !== this.controlPort) {
      if (!this.shutdownWarnings.has(host)) {
        this.shutdownWarnings.add(host);
        this.onLog(`[local] The helper at ${host} cannot stop automatically. Restart it with the updated payload.`);
      }
      return;
    }
    this.shutdownWarnings.delete(host);
    this.usedHelpers.set(host, { host, instanceId: hello.instance_id, port: hello.shutdown_port });
  }

  // Function Helper Loading
  async ensure(host) {
    return this.ensureService(host, { port: this.port, greeting: true, name: 'Save helper' });
  }

  // Function Transfer Helper
  async ensureTransfer(host, port = PPR_PORT) {
    return this.ensureService(host, { port, greeting: false, name: 'Transfer helper' });
  }

  // Function Helper Service
  async ensureService(host, service) {
    if (net.isIP(host) !== 4) throw new Error('Enter the jailbroken PS5 IPv4 address for local save processing.');
    if (!Number.isInteger(service.port) || service.port < 1 || service.port > 65535) throw new Error('Enter a valid local helper port.');
    if (this.stopped) throw new Error('Local save helper has stopped.');
    const key = `${host}:${service.port}:${service.greeting}`;
    if (this.pending.has(key)) return this.pending.get(key);
    let shared = this.hostTasks.get(host);
    if (!shared) {
      shared = { tail: Promise.resolve(), pending: 0, readyDeadline: null };
      this.hostTasks.set(host, shared);
    }
    shared.pending++;
    const task = shared.tail.catch(() => {}).then(() => {
      if (this.stopped) throw new Error('Local save helper has stopped.');
      return this.start(host, service, shared);
    });
    this.pending.set(key, task);
    shared.tail = task;
    try { return await task; }
    finally {
      this.pending.delete(key);
      if (!--shared.pending) this.hostTasks.delete(host);
    }
  }

  // Function Helper Starting
  async start(host, service, shared) {
    const controller = new AbortController();
    const { signal } = controller;
    this.controllers.add(controller);
    let delivery;
    try {
      const probe = () => probeHelper(host, service.port, this.probeTimeoutMs, signal, service.greeting);
      const initial = await probe();
      if (initial.ready) { await this.remember(host, service, initial, signal); return; }
      if (signal.aborted) throw new Error('Local save helper has stopped.');
      const occupied = service.greeting && initial.connected;
      const fresh = !shared.readyDeadline && !occupied;
      if (fresh) {
        try { await fs.promises.access(this.elfPath); }
        catch { throw new Error('The local save helper payload is missing. Reinstall this test build.'); }
      }
      if (signal.aborted) throw new Error('Local save helper has stopped.');
      let settled = !fresh;
      let deliveryError;
      let readyDeadline = shared.readyDeadline || (occupied ? Date.now() + this.readyTimeoutMs : null);
      if (occupied) this.onLog(`[local] Waiting for the save helper at ${host}:${service.port}`);
      if (fresh) {
        delivery = this.deploy(host, { signal, service }).then(() => {
          this.deployedHosts.add(host);
          settled = true;
          readyDeadline = Date.now() + this.readyTimeoutMs;
        }, error => { settled = true; deliveryError = error; });
      }
      while (!signal.aborted) {
        const current = await probe();
        if (current.ready) {
          await this.remember(host, service, current, signal);
          if (fresh) shared.readyDeadline = Date.now() + this.readyTimeoutMs;
          this.onLog(`[local] ${service.name} ready at ${host}:${service.port}`);
          return;
        }
        if (signal.aborted) break;
        if (settled && deliveryError) {
          const retried = await probe();
          if (retried.ready) {
            await this.remember(host, service, retried, signal);
            if (fresh) shared.readyDeadline = Date.now() + this.readyTimeoutMs;
            this.onLog(`[local] ${service.name} ready at ${host}:${service.port}`);
            return;
          }
          if (signal.aborted) break;
          throw deliveryError;
        }
        if (settled && Date.now() >= readyDeadline) {
          const expected = service.greeting ? 'compatible save helper' : 'transfer key listener';
          if (occupied) throw new Error(`The PS5 helper port ${host}:${service.port} is open, but no compatible save helper answered. Wait for the current PS5 operation to finish and retry.`);
          throw new Error(`Helper was sent to ${host}:${this.loaderPort}, but no ${expected} answered on ${host}:${service.port}. Check the PS5 payload log and try loading the helper manually.`);
        }
        await delay(this.retryIntervalMs, signal);
      }
      throw new Error('Local save helper has stopped.');
    } finally {
      const closed = this.reads.get(signal);
      controller.abort();
      if (delivery) await delivery;
      if (closed) await closed;
      this.controllers.delete(controller);
    }
  }

  // Function Helper Sending
  deploy(host, { signal, service = { port: this.port } } = {}) {
    return new Promise((resolve, reject) => {
      if (this.stopped || signal?.aborted) return reject(new Error('Local save helper has stopped.'));
      this.onLog(`[local] Connecting to PS5 payload listener ${host}:${this.loaderPort}`);
      const socket = net.createConnection({ host, port: this.loaderPort });
      this.sockets.add(socket);
      let input;
      let settled = false;
      let connected = false;
      let timer;
      const bytes = () => `${socket.bytesWritten || 0} bytes written`;
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) { socket.destroy(); input?.destroy(); reject(error); }
        else resolve();
      };
      const canceled = () => {
        socket.destroy();
        input?.destroy();
        finish(new Error('Local save helper has stopped.'));
      };
      signal?.addEventListener('abort', canceled, { once: true });
      timer = setTimeout(() => finish(new Error(`Could not connect to the PS5 payload listener at ${host}:${this.loaderPort} within ${this.connectTimeoutMs} ms. Start the console's ELF payload listener and check the address/network.`)), this.connectTimeoutMs);
      socket.on('data', data => this.onLog(data.toString('utf8').trim()));
      socket.on('error', error => finish(new Error(connected
        ? `Could not send the local save helper to ${host}:${this.loaderPort} (${bytes()}): ${error.message}`
        : `Could not connect to the PS5 payload listener at ${host}:${this.loaderPort}: ${error.message}. Start the console's ELF payload listener and check the address/network.`)));
      socket.once('close', () => {
        this.sockets.delete(socket);
        signal?.removeEventListener('abort', canceled);
        input?.destroy();
        if (!settled) finish(new Error(`PS5 payload listener at ${host}:${this.loaderPort} closed ${connected ? `during upload (${bytes()})` : 'before connecting'}.`));
      });
      socket.once('connect', () => {
        if (this.stopped || signal?.aborted) return canceled();
        connected = true;
        clearTimeout(timer);
        this.onLog(`[local] Connected; sending save helper to ${host}:${this.loaderPort}`);
        timer = setTimeout(() => finish(new Error(`Timed out uploading the local save helper to ${host}:${this.loaderPort} (${bytes()}). The listener accepted the connection but did not finish receiving the ELF.`)), this.uploadTimeoutMs);
        input = fs.createReadStream(this.elfPath);
        const closed = new Promise(resolveClosed => input.once('close', resolveClosed));
        this.reads.set(signal, closed);
        closed.then(() => { if (this.reads.get(signal) === closed) this.reads.delete(signal); });
        input.once('error', finish);
        socket.once('finish', () => {
          if (!input.readableEnded) return finish(new Error(`PS5 payload listener at ${host}:${this.loaderPort} closed during upload (${bytes()}) before the full ELF was sent.`));
          this.onLog(`[local] Helper sent (${bytes()}); waiting for ${host}:${service.port}`);
          finish();
        });
        input.pipe(socket);
      });
    });
  }

  // Function Helper Closing
  stop() {
    this.stopped = true;
    for (const controller of this.controllers) controller.abort();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  // Function Helper Shutdown
  shutdown() {
    if (this.shutdownTask) return this.shutdownTask;
    this.stop();
    this.shutdownTask = (async () => {
      await Promise.allSettled([...this.pending.values(), ...this.reads.values()]);
      await Promise.all([...this.deployedHosts].filter(host => !this.usedHelpers.has(host)).map(async host => {
        const deadline = Date.now() + this.readyTimeoutMs;
        do {
          const result = await probeHelper(host, this.port, this.probeTimeoutMs);
          await this.remember(host, { greeting: true }, result);
          if (this.usedHelpers.has(host) || result.ready) break;
          if (Date.now() >= deadline) break;
          await new Promise(resolve => setTimeout(resolve, this.retryIntervalMs));
        } while (Date.now() < deadline);
      }));
      await Promise.all([...this.usedHelpers.values()].map(async identity => {
        try {
          await shutdownLocalWorker({ ...identity, timeoutMs: this.shutdownTimeoutMs });
          this.onLog(`[local] Shutdown requested for GarlicWorker.elf at ${identity.host}; it will stop after save cleanup.`);
        } catch (error) {
          this.onLog(`[local] Could not stop GarlicWorker.elf at ${identity.host}: ${error.message}`);
        }
      }));
      this.usedHelpers.clear();
      this.deployedHosts.clear();
      this.shutdownWarnings.clear();
    })();
    return this.shutdownTask;
  }
}

module.exports = { LocalHelper };

const net = require('node:net');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { TextDecoder } = require('node:util');

const { SAVE_PORT, MAX_MESSAGE_BYTES, MAX_JOB_BYTES, MAX_ARCHIVE_BYTES, CHUNK_BYTES,
  CONTROL_PORT, CONTROL_PROTOCOL, isWorkerGreeting } = require('./local_protocol.cjs');

// Function Worker Reading
class WorkerReader {
  constructor(socket) {
    this.iterator = socket[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
  }

  async chunk(limit) {
    while (!this.buffer.length) {
      const next = await this.iterator.next();
      if (next.done) throw new Error('Local PS5 helper disconnected before the job finished');
      this.buffer = next.value;
    }
    const result = this.buffer.subarray(0, limit);
    this.buffer = this.buffer.subarray(result.length);
    return result;
  }

  async exactly(size) {
    const chunks = [];
    let remaining = size;
    while (remaining) {
      const chunk = await this.chunk(remaining);
      chunks.push(chunk);
      remaining -= chunk.length;
    }
    return Buffer.concat(chunks, size);
  }

  async message() {
    const size = (await this.exactly(4)).readUInt32BE();
    if (!size || size > MAX_MESSAGE_BYTES) throw new Error('Invalid local helper message size');
    const body = await this.exactly(size);
    try {
      const message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
      if (!message || Array.isArray(message) || typeof message !== 'object' || typeof message.type !== 'string') {
        throw new Error('invalid message object');
      }
      return message;
    } catch (error) {
      throw new Error(`Invalid local helper message: ${error.message}`);
    }
  }
}

// Function Worker Writing
function socketWrite(socket, data) {
  return new Promise((resolve, reject) => {
    socket.write(data, (error) => error ? reject(error) : resolve());
  });
}

// Function Worker Message
async function sendMessage(socket, message) {
  const body = Buffer.from(JSON.stringify(message));
  if (body.length > MAX_JOB_BYTES) throw new Error('Local helper job parameters are too large');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  await socketWrite(socket, Buffer.concat([header, body]));
}

// Function Worker Connection
function connectWorker(socket, host, port) {
  return new Promise((resolve, reject) => {
    const connected = () => { cleanup(); resolve(); };
    const failed = (error) => { cleanup(); reject(error); };
    const cleanup = () => {
      socket.off('connect', connected);
      socket.off('error', failed);
    };
    socket.once('connect', connected);
    socket.once('error', failed);
    socket.connect({ host, port });
  });
}

// Function Worker Archive
async function sendArchive(socket, handle, size) {
  let sent = 0;
  const stream = handle.createReadStream({ autoClose: false, start: 0, end: size - 1, highWaterMark: CHUNK_BYTES });
  try {
    for await (const chunk of stream) {
      await socketWrite(socket, chunk);
      sent += chunk.length;
    }
  } finally {
    stream.destroy();
  }
  if (sent !== size) throw new Error('The local job input archive changed while sending');
}

// Function Worker Result
async function receiveArchive(reader, handle, size) {
  let remaining = size;
  while (remaining) {
    const chunk = await reader.chunk(Math.min(remaining, CHUNK_BYTES));
    let offset = 0;
    while (offset < chunk.length) {
      const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
      if (!bytesWritten) throw new Error('Could not write the local helper result');
      offset += bytesWritten;
    }
    remaining -= chunk.length;
  }
}

// Function Local Worker
async function runLocalWorkerJob({
  host, port = SAVE_PORT, operation, params = {}, inputArchive, resultPath,
  onLog = () => {}, onStatus = () => {}, connectTimeoutMs = 5000,
  timeoutMs = 60 * 60 * 1000, signal,
} = {}) {
  if (typeof host !== 'string' || !host.trim()) throw new Error('Enter the local PS5 helper IP address');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local PS5 helper port');
  if (!['decrypt', 'encrypt', 'resign'].includes(operation)) throw new Error('Unsupported local save operation');
  if (!params || Array.isArray(params) || typeof params !== 'object') throw new Error('Invalid local save parameters');
  const targetTitleId = params.target_title_id;
  if (targetTitleId !== undefined && (typeof targetTitleId !== 'string' || !/^PPSA\d{5}$/.test(targetTitleId)
      || !['encrypt', 'resign'].includes(operation))) {
    throw new Error('Invalid target PPSA for the local save operation');
  }
  if (typeof inputArchive !== 'string' || !inputArchive || typeof resultPath !== 'string' || !resultPath) {
    throw new Error('Choose the local job input and result paths');
  }
  for (const value of [connectTimeoutMs, timeoutMs]) {
    if (!Number.isInteger(value) || value < 1 || value > 0x7fffffff) throw new Error('Invalid local helper timeout');
  }
  if (signal?.aborted) throw Object.assign(new Error('Local save operation canceled'), { name: 'AbortError' });
  const jobId = randomUUID();
  const socket = new net.Socket();
  socket.setNoDelay(true);
  socket.on('error', () => {});
  let input;
  let result;
  let temporary;
  let connectTimer;
  let jobTimer;
  let stopped;
  const stop = (error) => { stopped ||= error; socket.destroy(stopped); };
  const aborted = () => stop(Object.assign(new Error('Local save operation canceled'), { name: 'AbortError' }));
  const clearLimits = () => {
    clearTimeout(connectTimer);
    clearTimeout(jobTimer);
    signal?.removeEventListener('abort', aborted);
  };
  try {
    input = await fs.open(inputArchive, 'r');
    const info = await input.stat();
    if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 1 || info.size > MAX_ARCHIVE_BYTES) {
      throw new Error('Local helper input must be a nonempty classic ZIP archive smaller than 4 GiB');
    }
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
    if (stopped) throw stopped;
    jobTimer = setTimeout(() => stop(new Error('Local PS5 save operation timed out')), timeoutMs);
    connectTimer = setTimeout(() => stop(new Error('Local PS5 helper connection timed out')), connectTimeoutMs);
    await connectWorker(socket, host.trim(), port);
    const reader = new WorkerReader(socket);
    const hello = await reader.message();
    if (!isWorkerGreeting(hello)) {
      throw new Error('The PS5 is not running the compatible Garlic local save helper');
    }
    if (targetTitleId && (!Array.isArray(hello.capabilities) || !hello.capabilities.includes('target_title_id'))) {
      throw new Error('Restart the local PS5 helper with the updated GarlicWorker.elf payload to change the PPSA.');
    }
    clearTimeout(connectTimer);
    await sendMessage(socket, { type: 'job', id: jobId, operation, params });
    onStatus('running');
    let inputSent = false;
    let resultReceived = false;
    while (true) {
      const message = await reader.message();
      if (message.job_id !== jobId) throw new Error('Local helper returned a mismatched job ID');
      if (message.type === 'log') {
        if (typeof message.msg !== 'string') throw new Error('Invalid local helper log message');
        onLog(message.msg);
      } else if (message.type === 'file_request') {
        if (inputSent || resultReceived) throw new Error('Unexpected duplicate local helper file request');
        inputSent = true;
        await sendMessage(socket, { type: 'file_data', job_id: jobId, size: info.size });
        await sendArchive(socket, input, info.size);
      } else if (message.type === 'result_start') {
        if (!inputSent || resultReceived) throw new Error('Unexpected duplicate local helper result');
        if (!Number.isSafeInteger(message.size) || message.size < 1 || message.size > MAX_ARCHIVE_BYTES) {
          throw new Error('Invalid local helper result archive size');
        }
        resultReceived = true;
        await fs.mkdir(path.dirname(resultPath), { recursive: true });
        temporary = path.join(path.dirname(resultPath), `.${path.basename(resultPath)}.local-${jobId}.tmp`);
        result = await fs.open(temporary, 'wx', 0o600);
        await receiveArchive(reader, result, message.size);
        await sendMessage(socket, { type: 'result_ok', job_id: jobId });
      } else if (message.type === 'status') {
        if (message.status === 'failed') {
          throw new Error(typeof message.error === 'string' && message.error ? message.error : 'Local PS5 save operation failed');
        }
        if (message.status === 'running') {
          onStatus('running');
          continue;
        }
        if (message.status !== 'done') throw new Error('Unexpected local helper job status');
        if (!resultReceived || !result) throw new Error('Local helper finished without a complete result archive');
        if (reader.buffer.length) throw new Error('Unexpected data after the local helper finished');
        await result.sync();
        await result.close();
        result = null;
        if (stopped) throw stopped;
        clearLimits();
        await fs.rename(temporary, resultPath);
        temporary = null;
        onStatus('done');
        return { jobId, output: resultPath };
      } else {
        throw new Error(`Unexpected local helper message type: ${message.type}`);
      }
    }
  } finally {
    clearLimits();
    socket.destroy();
    if (input) await input.close().catch(() => {});
    if (result) await result.close().catch(() => {});
    if (temporary) await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

// Function Worker Shutdown
async function shutdownLocalWorker({ host, port = CONTROL_PORT, instanceId, timeoutMs = 5000 }) {
  if (typeof host !== 'string' || !host.trim() || !/^[0-9a-f]{32}$/.test(instanceId || '')
      || !Number.isInteger(port) || port < 1 || port > 65535
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 0x7fffffff) {
    throw new Error('Invalid local helper shutdown settings');
  }
  const socket = new net.Socket();
  socket.on('error', () => {});
  const timer = setTimeout(() => socket.destroy(new Error('Timed out requesting local PS5 helper shutdown')), timeoutMs);
  try {
    await connectWorker(socket, host.trim(), port);
    const reader = new WorkerReader(socket);
    const hello = await reader.message();
    if (hello.type !== 'hello' || hello.protocol !== CONTROL_PROTOCOL || hello.platform !== 'ps5'
        || hello.instance_id !== instanceId) {
      throw new Error('The local PS5 helper changed; its process was left running');
    }
    await sendMessage(socket, { type: 'shutdown', instance_id: instanceId });
    const reply = await reader.message();
    if (reply.type !== 'shutdown_accepted' || reply.instance_id !== instanceId) {
      throw new Error('The local PS5 helper did not confirm shutdown');
    }
    return { accepted: true };
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}

module.exports = { runLocalWorkerJob, shutdownLocalWorker };

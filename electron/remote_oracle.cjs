const net = require('node:net');

function apiBase(serverUrl) {
  return serverUrl.replace(/\/+$/, '');
}

async function responseJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`HTOS returned a non-JSON response (${response.status}): ${text.slice(0, 200)}`);
  }
}

async function submitDerivation(serverUrl, workerKey, clientValue, serverValue) {
  const form = new FormData();
  form.append('operation', 'ppr_derive');
  form.append('client_value', clientValue);
  form.append('server_value', serverValue);
  const response = await fetch(`${apiBase(serverUrl)}/api/v1/jobs`, {
    method: 'POST',
    headers: { 'X-Worker-Key': workerKey },
    body: form,
  });
  const data = await responseJson(response);
  if (!response.ok) throw new Error(data.error || `HTOS rejected the derivation (${response.status})`);
  if (!data.job_id) throw new Error('HTOS did not return a job ID');
  return data.job_id;
}

async function derivationResult(serverUrl, workerKey, jobId, onLog) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const response = await fetch(`${apiBase(serverUrl)}/api/v1/jobs/${jobId}`, {
      headers: { 'X-Worker-Key': workerKey },
    });
    const data = await responseJson(response);
    if (!response.ok) throw new Error(data.error || 'Could not read the derivation job');
    for (const entry of data.logs || []) {
      if (entry.msg) onLog(`[worker] ${entry.msg}`);
    }
    if (data.status === 'done') break;
    if (data.status === 'failed') throw new Error(data.error || 'The volunteer worker failed');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const response = await fetch(`${apiBase(serverUrl)}/api/v1/jobs/${jobId}/result`, {
    headers: { 'X-Worker-Key': workerKey },
  });
  const data = await responseJson(response);
  if (!response.ok) throw new Error(data.error || 'Could not download the derivation result');
  for (const name of ['key1', 'key2', 'nonce1', 'nonce2']) {
    if (typeof data[name] !== 'string') throw new Error(`Worker result is missing ${name}`);
    const expected = name.startsWith('key') ? 32 : 8;
    if (data[name].length !== expected || !/^[0-9a-f]+$/i.test(data[name])) {
      throw new Error(`Worker returned an invalid ${name}`);
    }
  }
  return Buffer.concat([
    Buffer.from(data.key1, 'hex'),
    Buffer.from(data.key2, 'hex'),
    Buffer.from(data.nonce1, 'hex'),
    Buffer.from(data.nonce2, 'hex'),
  ]);
}

async function startRemoteOracle({ serverUrl, workerKey, onLog }) {
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    let input = Buffer.alloc(0);
    let running = false;
    socket.on('data', (chunk) => {
      if (running) return;
      input = Buffer.concat([input, chunk]);
      if (input.length < 32) return;
      running = true;
      const clientValue = input.subarray(0, 16).toString('hex');
      const serverValue = input.subarray(16, 32).toString('hex');
      (async () => {
        onLog('[oracle] local transfer source requested a PPR derivation');
        const jobId = await submitDerivation(serverUrl, workerKey, clientValue, serverValue);
        onLog(`[oracle] submitted PPR job ${jobId}`);
        const result = await derivationResult(serverUrl, workerKey, jobId, onLog);
        socket.end(result);
      })().catch((error) => {
        onLog(`[oracle] ${error.message}`);
        socket.destroy();
      });
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, sockets, port: server.address().port };
}

function stopRemoteOracle(relay) {
  if (!relay) return;
  for (const socket of relay.sockets) socket.destroy();
  relay.server.close();
}

module.exports = { startRemoteOracle, stopRemoteOracle };

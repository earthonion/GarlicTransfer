const { localSaveFile } = require('./download_layout.cjs');
const { otherDataPath } = require('./folder_paths.js');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { isIP } = require('node:net');
const { runLocalWorkerJob } = require('./local_worker.cjs');
const { SaveTemps } = require('./save_temps.cjs');
const { writeEditedFile, addWorkspaceFiles, prepareWorkspaceReplacement, replaceWorkspaceFile } = require('./workspace_io.cjs');
const { randomUUID } = require('node:crypto');
const { setTimeout: wait } = require('node:timers/promises');

const MAX_EDITOR_BYTES = 8 * 1024 * 1024;
const PROTECTED_FILES = new Set(['PS5IMAGE', 'PS5KEY', 'PS5PARAM', 'PS5PARAM_SIZE', 'chives.json']);
let activeJob = null;

// Function Save Cancellation
function cancellationError() {
  return Object.assign(new Error('Save operation canceled.'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function checkCanceled(signal) {
  if (signal?.aborted) throw cancellationError();
}

// Function Remote Deadline
async function withRemoteDeadline({ signal, timeoutMs, operation }, action) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 0x7fffffff) {
    throw new Error('invalid remote save timeout');
  }
  const controller = new AbortController();
  let failure;
  const abort = error => {
    if (controller.signal.aborted) return;
    failure = error;
    controller.abort(error);
  };
  const canceled = () => abort(cancellationError());
  const unit = timeoutMs >= 60000 ? 'minute' : 'second';
  const amount = Math.ceil(timeoutMs / (timeoutMs >= 60000 ? 60000 : 1000));
  const duration = `${amount} ${unit}${amount === 1 ? '' : 's'}`;
  const timer = setTimeout(() => abort(Object.assign(new Error(`${operation} timed out after ${duration}`), {
    name: 'TimeoutError', code: 'ETIMEDOUT',
  })), timeoutMs);
  timer.unref?.();
  signal?.addEventListener('abort', canceled, { once: true });
  if (signal?.aborted) canceled();
  try {
    checkCanceled(controller.signal);
    return await action(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw failure;
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', canceled);
    controller.abort();
  }
}

// Function Save Waiting
function waitForSave(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const canceled = () => reject(cancellationError());
    signal.addEventListener('abort', canceled, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', canceled));
    if (signal.aborted) canceled();
  });
}

function resolveInside(root, relative) {
  const base = path.resolve(root);
  const destination = path.resolve(base, relative);
  if (destination !== base && !destination.startsWith(`${base}${path.sep}`)) {
    throw new Error('the selected path is outside the save workspace');
  }
  return destination;
}

function protectedFile(relative) {
  const normalized = relative.split(path.sep).join('/');
  return PROTECTED_FILES.has(path.basename(normalized)) || normalized.split('/').includes('sce_sys');
}

// Function Account Reading
async function accountIdFromSfo(root, candidates = null) {
  if (candidates === null) {
    candidates = [];
    async function visit(directory) {
      for (const entry of await fsPromises.readdir(directory, { withFileTypes: true })) {
        const current = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(current);
        else if (entry.isFile() && entry.name.toLowerCase() === 'param.sfo') candidates.push(current);
      }
    }
    await visit(root);
  }
  for (const candidate of candidates) {
    const data = await fsPromises.readFile(candidate);
    for (const offset of [0x1b8, 0x15c]) {
      if (data.length < offset + 8) continue;
      const value = data.subarray(offset, offset + 8);
      if (value.some((byte) => byte !== 0)) return Buffer.from(value).toString('hex');
    }
  }
  return '';
}

// Function Workspace Scan
async function workspaceInfo(root, ignoredPaths = new Set()) {
  const base = path.resolve(root);
  const files = [];
  const sfoCandidates = [];
  async function visit(directory) {
    for (const entry of await fsPromises.readdir(directory, { withFileTypes: true })) {
      const current = path.join(directory, entry.name);
      if (ignoredPaths.has(current)) continue;
      if (entry.isDirectory()) {
        await visit(current);
      } else if (entry.isFile()) {
        if (entry.name.toLowerCase() === 'param.sfo') sfoCandidates.push(current);
        const stat = await fsPromises.stat(current);
        const relative = path.relative(base, current);
        files.push({
          path: relative.split(path.sep).join('/'),
          size: stat.size,
          protected: protectedFile(relative),
        });
      }
    }
  }
  await visit(base);
  files.sort((left, right) => left.path.localeCompare(right.path));
  let titleId = '';
  const chivesEntry = files.find((file) => file.path === 'chives.json' || file.path.endsWith('/chives.json'));
  if (chivesEntry) {
    const chives = JSON.parse(await fsPromises.readFile(path.join(base, chivesEntry.path), 'utf8'));
    titleId = chives.title_id || '';
  }
  return {
    root: base,
    files,
    accountId: await accountIdFromSfo(base, sfoCandidates),
    titleId,
    totalBytes: files.reduce((total, file) => total + file.size, 0),
  };
}

async function readWorkspaceFile(root, relative) {
  const selected = resolveInside(root, relative);
  const stat = await fsPromises.stat(selected);
  if (!stat.isFile()) throw new Error('select a file in the save workspace');
  if (stat.size > MAX_EDITOR_BYTES) {
    throw new Error('this file is larger than 8 MiB; download it to edit with another application');
  }
  const data = await fsPromises.readFile(selected);
  return { path: relative.split(path.sep).join('/'), size: stat.size, data: data.toString('base64') };
}

async function writeWorkspaceFile(root, relative, encoded) {
  const selected = resolveInside(root, relative);
  if (typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_EDITOR_BYTES / 3) * 4 + 4) {
    throw new Error('the edited file is larger than 8 MiB');
  }
  const data = Buffer.from(encoded, 'base64');
  if (data.toString('base64') !== encoded) throw new Error('the edited file is not valid base64 data');
  await writeEditedFile(selected, data);
  return workspaceInfo(root);
}

async function runZip(python, resourceRoot, cwd, command, ...files) {
  const options = files.length && typeof files[files.length - 1] === 'object' ? files.pop() : {};
  const { signal } = options;
  checkCanceled(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-m', 'poc.dt_save_editor', command, ...files], {
      cwd,
      env: { ...process.env, PYTHONPATH: resourceRoot },
    });
    let output = '';
    let failure;
    let killTimer;
    let settled = false;
    const settle = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', canceled);
      if (error) reject(error); else resolve(result);
    };
    const canceled = () => {
      failure = cancellationError();
      try { child.kill(); } catch {}
      killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1000);
      killTimer.unref?.();
    };
    signal?.addEventListener('abort', canceled, { once: true });
    if (signal?.aborted) canceled();
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.on('error', error => {
      failure ||= error;
      if (!child.pid && !signal?.aborted) settle(error);
    });
    child.on('close', code => {
      if (signal?.aborted) return settle(cancellationError());
      if (failure) return settle(failure);
      if (code !== 0) return settle(new Error(output.trim() || `ZIP ${command} failed`));
      try { settle(null, JSON.parse(output.trim().split('\n').pop())); }
      catch (error) { settle(error); }
    });
  });
}

function apiOrigin(serverUrl) {
  const origin = String(serverUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(origin)) throw new Error('enter a valid GarlicSaves server URL in Settings');
  return origin;
}

async function apiResponse(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    let message = text.slice(0, 300);
    try {
      message = JSON.parse(text).error || message;
    } catch {}
    throw new Error(`GarlicSaves returned HTTP ${response.status}: ${message}`);
  }
  return response;
}

function apiHeaders(workerKey, jobToken = '') {
  return { 'X-Worker-Key': workerKey, 'X-Job-Token': jobToken };
}

async function postMultipart({ serverUrl, workerKey, operation, accountId, inputs, platform, signal }) {
  checkCanceled(signal);
  const crypto = require('node:crypto');
  const http = require('node:http');
  const https = require('node:https');
  const { once } = require('node:events');
  const boundary = `----GarlicTransfer${crypto.randomBytes(16).toString('hex')}`;
  const url = new URL(`${apiOrigin(serverUrl)}/api/v1/jobs`);
  const transport = url.protocol === 'https:' ? https : http;
  const fields = [['operation', operation]];
  if (operation === 'decrypt') fields.push(['include_sce_sys', 'true']);
  if (operation === 'encrypt' || operation === 'resign') fields.push(['account_id', accountId]);
  if (platform) fields.push(['platform', platform]);
  const encodedFields = fields.map(([name, value]) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  const encodedFiles = inputs.map(selected => {
    const filename = path.basename(selected).replace(/["\r\n]/g, '_');
    return {
      selected,
      size: fs.statSync(selected).size,
      header: `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    };
  });
  const closing = `--${boundary}--\r\n`;
  const contentLength = encodedFields.reduce((total, field) => total + Buffer.byteLength(field), 0) +
    encodedFiles.reduce((total, file) => total + Buffer.byteLength(file.header) + file.size + 2, 0) +
    Buffer.byteLength(closing);
  const request = transport.request(url, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': contentLength,
      'X-Worker-Key': workerKey,
    },
  });
  const requestClosed = new Promise(resolve => request.once('close', resolve));
  const responsePromise = new Promise((resolve, reject) => {
    request.on('response', (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
      response.on('error', reject);
    });
    request.on('error', reject);
  });
  responsePromise.catch(() => {});
  async function write(data) {
    checkCanceled(signal);
    if (!request.write(data)) await once(request, 'drain', { signal });
  }
  let response;
  try {
    for (const field of encodedFields) await write(field);
    for (const file of encodedFiles) {
      await write(file.header);
      await pipeline(fs.createReadStream(file.selected), request, { end: false, signal });
      await write('\r\n');
    }
    request.end(closing);
    response = await responsePromise;
    checkCanceled(signal);
  } catch (error) {
    request.destroy();
    await requestClosed;
    const earlyResponse = await Promise.race([responsePromise, Promise.resolve(null)]);
    if (earlyResponse) {
      throw new Error(`GarlicSaves returned HTTP ${earlyResponse.status}: ${earlyResponse.body.slice(0, 300)}`);
    }
    throw error;
  }

  let result;
  try {
    result = JSON.parse(response.body);
  } catch {
    throw new Error(`GarlicSaves returned an invalid response (HTTP ${response.status})`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`GarlicSaves returned HTTP ${response.status}: ${result.error || response.body.slice(0, 300)}`);
  }
  return result;
}

async function createRemoteJob(options) {
  return postMultipart(options);
}

async function downloadRemoteResult({ serverUrl, workerKey, jobId, jobToken = '', output, signal }) {
  checkCanceled(signal);
  const response = await apiResponse(`${apiOrigin(serverUrl)}/api/v1/jobs/${jobId}/result`, {
    headers: apiHeaders(workerKey, jobToken), signal,
  });
  if (!response.body) throw new Error('GarlicSaves returned an empty result');
  await fsPromises.mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.download-${randomUUID()}`;
  try {
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary, { flags: 'wx' }), { signal });
    checkCanceled(signal);
    await fsPromises.rename(temporary, output);
  } finally {
    await fsPromises.rm(temporary, { force: true });
  }
}

async function runSaveJob(options) {
  const {
    sender, serverUrl, workerKey, operation, accountId = '', inputs = [], workspace,
    output, python, resourceRoot, workDir, userDataRoot, platform = 'ps5',
    pollIntervalMs = 1000, timeoutMs = 60 * 60 * 1000,
    useRemoteOracle = true, oracleHost, ensureLocalWorker, temporaryStore, signal,
  } = options;
  checkCanceled(signal);
  if (!['decrypt', 'encrypt', 'resign'].includes(operation)) throw new Error('unsupported save operation');
  const local = useRemoteOracle === false;
  const localHost = String(oracleHost || '').trim();
  if (local) {
    if (!isIP(localHost)) throw new Error('enter a valid local oracle IP in Settings');
    if (platform !== 'ps5') throw new Error('the local save helper supports PS5 saves');
    if (typeof ensureLocalWorker !== 'function') throw new Error('the local save helper is not available; restart GarlicTransfer');
  } else if (!String(workerKey || '').trim()) {
    if (sender && !sender.isDestroyed()) sender.send('device:event', { type: 'required' });
    throw new Error('Authorize the app first!');
  }
  if ((operation === 'encrypt' || operation === 'resign') && !/^[0-9a-fA-F]{16}$/.test(accountId)) {
    throw new Error('enter a 16-digit hexadecimal account ID');
  }
  if (operation !== 'encrypt' && !inputs.length) throw new Error('choose at least one encrypted save file');
  if (operation === 'encrypt' && !workspace) throw new Error('open a decrypted workspace first');
  if (operation !== 'decrypt' && !output) throw new Error('choose where to save the encrypted result');
  const emit = (type, detail) => {
    if (sender && !sender.isDestroyed()) sender.send('save-editor:event', { type, ...detail });
  };
  emit('status', { message: `Preparing ${operation}…` });
  const temps = temporaryStore || new SaveTemps(path.join(userDataRoot, 'save-editor'));
  const releaseWorkspace = temps.use(workspace);
  let temporary;
  let keepWorkspace = false;
  try {
    temporary = await temps.create();
    const uploadRoot = temporary.directory;
    const resultPath = operation === 'decrypt' ? path.join(uploadRoot, 'decrypted.zip') : path.resolve(output);
    let jobId;
    if (local) {
      // Function Local Save Job
      emit('status', { message: 'Preparing local save files…' });
      const inputArchive = path.join(uploadRoot, 'local-input.zip');
      if (operation === 'encrypt') {
        await runZip(python, resourceRoot, workDir, 'local-pack', workspace, inputArchive, { signal });
      } else {
        await runZip(python, resourceRoot, workDir, 'local-inputs', inputArchive, ...inputs, { signal });
      }
      checkCanceled(signal);
      emit('status', { message: 'Connecting to the local PS5 save helper…' });
      await waitForSave(ensureLocalWorker(localHost), signal);
      checkCanceled(signal);
      const params = operation === 'decrypt' ? { include_sce_sys: true } : { account_id: accountId };
      const completed = await runLocalWorkerJob({
        host: localHost, operation, params, inputArchive, resultPath, timeoutMs, signal,
        onLog: (message) => emit('log', { message }),
        onStatus: (message) => emit('status', { message: `${operation}: ${message}` }),
      });
      jobId = completed.jobId;
      emit('job', { jobId, operation });
    } else {
      let uploadInputs = inputs;
      if (operation === 'encrypt') {
        const archive = path.join(uploadRoot, 'workspace.zip');
        await runZip(python, resourceRoot, workDir, 'pack', workspace, archive, { signal });
        uploadInputs = [archive];
      }
      await withRemoteDeadline({ signal, timeoutMs, operation }, async remoteSignal => {
        emit('status', { message: `Uploading ${operation === 'decrypt' ? 'encrypted save' : 'save files'}…` });
        const workerAccountId = platform === 'ps5' && accountId
          ? Buffer.from(accountId, 'hex').toString('hex')
          : accountId;
        const created = await createRemoteJob({
          serverUrl, workerKey, operation, accountId: workerAccountId, inputs: uploadInputs, platform, signal: remoteSignal,
        });
        jobId = created.job_id;
        const jobToken = created.job_token || '';
        if (!jobId) throw new Error('GarlicSaves did not return a job ID');
        emit('job', { jobId, operation });
        let logCount = 0;
        let previousStatus = '';
        while (true) {
          checkCanceled(remoteSignal);
          const response = await apiResponse(`${apiOrigin(serverUrl)}/api/v1/jobs/${jobId}`, {
            headers: apiHeaders(workerKey, jobToken), signal: remoteSignal,
          });
          const job = await response.json();
          for (const entry of (job.logs || []).slice(logCount)) {
            if (entry.msg) emit('log', { message: entry.msg });
          }
          logCount = (job.logs || []).length;
          if (job.status !== previousStatus) {
            emit('status', { message: `${operation}: ${job.status}` });
            previousStatus = job.status;
          }
          if (job.status === 'failed') throw new Error(job.error || `${operation} failed`);
          if (job.status === 'done') break;
          if (!['queued', 'running'].includes(job.status)) throw new Error(`unexpected job status: ${job.status}`);
          await wait(pollIntervalMs, undefined, { signal: remoteSignal });
        }
        emit('status', { message: 'Downloading the result…' });
        await downloadRemoteResult({ serverUrl, workerKey, jobId, jobToken, output: resultPath, signal: remoteSignal });
      });
    }
    if (operation === 'decrypt') {
      checkCanceled(signal);
      const workspaceRoot = path.join(uploadRoot, 'workspace');
      await runZip(python, resourceRoot, workDir, 'extract', resultPath, workspaceRoot, { signal });
      emit('status', { message: 'Decrypted save is ready to edit.' });
      const info = await workspaceInfo(workspaceRoot);
      checkCanceled(signal);
      await fsPromises.rm(path.join(uploadRoot, 'local-input.zip'), { force: true });
      keepWorkspace = true;
      return { operation, jobId, archivePath: resultPath, workspace: workspaceRoot, info, temporaryId: temporary.id };
    }
    emit('status', { message: `${operation === 'resign' ? 'Resigned' : 'Encrypted'} save is ready.` });
    return { operation, jobId, output: resultPath };
  } catch (error) {
    if (signal?.aborted && error?.name !== 'TimeoutError') error = cancellationError();
    emit('error', { message: error.message });
    throw error;
  } finally {
    if (temporary && !keepWorkspace) await temps.release(temporary.id).catch(error => emit('log', { message: `Temporary cleanup: ${error.message}` }));
    await releaseWorkspace().catch(error => emit('log', { message: `Workspace cleanup: ${error.message}` }));
  }
}

// Register save-editor actions.
function registerSaveEditor({ ipcMain, app, dialog, shell, python, resourceRoot, workDir, pcStore, ensureLocalWorker }) {
  const userDataRoot = app.getPath('userData');
  const temporaryStore = new SaveTemps(path.join(userDataRoot, 'save-editor'));

  // Function Workspace Use
  async function useWorkspace(event, selected, action) {
    const release = temporaryStore.use(selected);
    try { return await action(); }
    finally {
      await release().catch(error => {
        const sender = event?.sender;
        if (sender && !sender.isDestroyed?.()) sender.send('save-editor:event', { type: 'log', message: `Temporary cleanup: ${error.message}` });
      });
    }
  }
  ipcMain.handle('save-editor:release-temporary', (_event, id) => temporaryStore.release(id));
  ipcMain.handle('save-editor:choose-input', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'All files', extensions: ['*'] }],
    });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle('save-editor:choose-workspace', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.canceled ? null : workspaceInfo(result.filePaths[0]);
  });
  ipcMain.handle('save-editor:choose-output', async (_event, defaultPath) => {
    const result = await dialog.showSaveDialog({ defaultPath });
    return result.canceled ? null : result.filePath;
  });
  ipcMain.handle('save-editor:local-file', async (_event, { assets, entryId, filename, localSource }) => {
    if (localSource === 'pc') {
      if (!pcStore) throw new Error('choose a Local PC saves folder first');
      return pcStore.inputs(entryId, filename);
    }
    const selected = localSaveFile(assets, entryId, filename);
    const paths = [selected];
    if (fs.existsSync(`${selected}.bin`)) paths.push(`${selected}.bin`);
    return paths;
  });
  ipcMain.handle('save-editor:info', (event, root) => useWorkspace(event, root, () => workspaceInfo(root)));
  ipcMain.handle('save-editor:read', (event, { root, path: relative }) => useWorkspace(event, root, () => readWorkspaceFile(root, relative)));
  ipcMain.handle('save-editor:write', (event, { root, path: relative, data }) => useWorkspace(event, root, () => writeWorkspaceFile(root, relative, data)));
  ipcMain.handle('save-editor:add', (event, { root }) => useWorkspace(event, root, async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
    if (result.canceled) return null;
    return addWorkspaceFiles(root, result.filePaths, () => workspaceInfo(root));
  }));
  // Function File Replacement
  ipcMain.handle('save-editor:replace', (event, { root, path: relative }) => useWorkspace(event, root, async () => {
    const target = await prepareWorkspaceReplacement(root, relative);
    const result = await dialog.showOpenDialog({
      title: `Replace ${path.basename(target.selected)}`,
      properties: ['openFile'],
    });
    if (result.canceled) return null;
    if (!Array.isArray(result.filePaths) || result.filePaths.length !== 1) throw new Error('choose one replacement file');
    return replaceWorkspaceFile(target, result.filePaths[0], ignored => workspaceInfo(target.root, ignored));
  }));
  ipcMain.handle('save-editor:delete', (event, { root, path: relative }) => useWorkspace(event, root, async () => {
    if (protectedFile(relative)) throw new Error('metadata required to rebuild the save cannot be deleted');
    await fsPromises.unlink(resolveInside(root, relative));
    return workspaceInfo(root);
  }));
  ipcMain.handle('save-editor:download-file', (event, { root, path: relative }) => useWorkspace(event, root, async () => {
    const result = await dialog.showSaveDialog({ defaultPath: path.basename(relative) });
    if (result.canceled) return null;
    await fsPromises.copyFile(resolveInside(root, relative), result.filePath);
    return result.filePath;
  }));
  ipcMain.handle('save-editor:download-archive', (event, { archivePath }) => useWorkspace(event, archivePath, async () => {
    const result = await dialog.showSaveDialog({ defaultPath: path.basename(archivePath) });
    if (result.canceled) return null;
    await fsPromises.copyFile(archivePath, result.filePath);
    return result.filePath;
  }));
  ipcMain.handle('save-editor:show', (_event, selected) => shell.showItemInFolder(selected));
  ipcMain.handle('save-editor:backup-local', async (_event, { assets, entryId, filename, localSource }) => {
    if (localSource === 'pc') {
      if (!pcStore) throw new Error('choose a Local PC saves folder first');
      return pcStore.backup(entryId, filename);
    }
    const selected = localSaveFile(assets, entryId, filename);
    const backupDirectory = otherDataPath(assets, 'Backups', String(entryId));
    await fsPromises.mkdir(backupDirectory, { recursive: true });
    const backup = path.join(backupDirectory, `${filename}.backup-${Date.now()}`);
    await fsPromises.copyFile(selected, backup);
    return backup;
  });
  // Function Save Operation
  async function saveOperation(event, action) {
    if (activeJob) throw new Error('another save operation is already running');
    const controller = new AbortController();
    let completed;
    const done = new Promise(resolve => { completed = resolve; });
    const job = { controller, done, sender: event.sender };
    activeJob = job;
    try { return await action(controller.signal); }
    finally {
      if (activeJob === job) activeJob = null;
      completed();
    }
  }

  // Function Save Cancel
  ipcMain.handle('save-editor:cancel', async event => {
    const job = activeJob;
    if (!job || (job.sender && event?.sender && job.sender !== event.sender)) return false;
    job.controller.abort();
    await job.done;
    return true;
  });

  ipcMain.handle('save-editor:encrypt-local', (event, options) => saveOperation(event, async signal => {
    let replacement;
    let retained = false;
    try {
      checkCanceled(signal);
      replacement = await temporaryStore.create('replacement-');
      const output = path.join(replacement.directory, 'encrypted.zip');
      const result = await runSaveJob({
        ...options, operation: 'encrypt', output,
        sender: event.sender, python, resourceRoot, workDir, userDataRoot,
        ensureLocalWorker, temporaryStore, signal,
      });
      const imageRoot = path.join(replacement.directory, 'image');
      await runZip(python, resourceRoot, workDir, 'extract', output, imageRoot, { signal });
      const images = await fsPromises.readdir(imageRoot);
      checkCanceled(signal);
      if (images.length !== 1) throw new Error('expected one encrypted image in the result');
      retained = true;
      return { ...result, output: path.join(imageRoot, images[0]), archivePath: output, temporaryId: replacement.id };
    } finally {
      if (replacement && !retained) await temporaryStore.release(replacement.id).catch(() => {});
    }
  }));
  ipcMain.handle('save-editor:job', (event, options) => saveOperation(event, signal => runSaveJob({
    ...options,
    sender: event.sender,
    python,
    resourceRoot,
    workDir,
    userDataRoot,
    ensureLocalWorker,
    temporaryStore,
    signal,
  })));
}

module.exports = {
  MAX_EDITOR_BYTES,
  accountIdFromSfo,
  createRemoteJob,
  downloadRemoteResult,
  readWorkspaceFile,
  registerSaveEditor,
  resolveInside,
  runSaveJob,
  runZip,
  workspaceInfo,
  writeWorkspaceFile,
};

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
const { readInlineFile, readWorkspacePage, applyWorkspacePages } = require('./editor_pages.cjs');
const { planWorkspaceSaves, scanWorkspace, readSfoFile, readChivesFile } = require('./workspace_saves.cjs');
const {
  isReadOnlyFile, requireWritableFile, checkExportDestination,
  writeEditedFile, addWorkspaceFiles, prepareWorkspaceReplacement, replaceWorkspaceFile,
} = require('./workspace_io.cjs');
const { randomUUID } = require('node:crypto');
const { setTimeout: wait } = require('node:timers/promises');

const MAX_EDITOR_BYTES = 8 * 1024 * 1024;
const PROTECTED_FILES = new Set(['PS5IMAGE', 'PS5KEY', 'PS5PARAM', 'PS5PARAM_SIZE']);
let activeJob = null;
let jobsClosing = false;

// Function Save Shutdown
async function stopSaveJobs() {
  jobsClosing = true;
  const job = activeJob;
  if (!job) return;
  job.controller.abort();
  await job.done;
}

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

// Function = Read Account
async function accountIdFromSfo(root, candidates = null, cache = new Map()) {
  if (candidates === null) candidates = (await scanWorkspace(root, undefined, fsPromises)).sfoCandidates;
  for (const candidate of candidates) {
    try { return (await readSfoFile(candidate, cache)).accountId; }
    catch (error) {
      if (error.code && !['ENOENT', 'ELOOP'].includes(error.code)) throw error;
    }
  }
  return '';
}

// Function = Check Metadata
async function workspaceMetadata(scan, allowBatch = true) {
  let titleId = '', batchError = '', saves = [];
  const files = scan.files.filter(file => isReadOnlyFile(file.filename))
    .sort((left, right) => left.filename.localeCompare(right.filename));
  for (const { filename } of files) {
    try {
      const metadata = await readChivesFile(scan, filename);
      if (!titleId && typeof metadata.title_id === 'string') titleId = metadata.title_id;
    } catch (error) {
      const relative = path.relative(scan.root, filename).split(path.sep).join('/');
      batchError ||= `Invalid metadata in ${relative}: ${error.message}`;
    }
  }
  if (!batchError && allowBatch && scan.sfoCandidates.length > 1) {
    try { saves = await planWorkspaceSaves(scan.root, scan); }
    catch (error) { batchError = error.message; }
  }
  return { saves, titleId: titleId || saves[0]?.titleId || '', batchError };
}

// Function = Scan Workspace
async function workspaceInfo(root, ignoredPaths = new Set(), titleName) {
  const base = path.resolve(root);
  const scan = await scanWorkspace(base, ignoredPaths, fsPromises);
  const files = scan.files.map(({ filename, size }) => {
    const relative = path.relative(base, filename);
    const readOnly = isReadOnlyFile(relative);
    return { path: relative.split(path.sep).join('/'), size, protected: readOnly || protectedFile(relative), readOnly };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const { saves, titleId, batchError } = await workspaceMetadata(scan);
  const gameName = id => (typeof titleName === 'function' && titleName(id)) || 'Unknown title';
  return {
    root: base,
    files,
    accountId: await accountIdFromSfo(base, scan.sfoCandidates, scan.sfoInfo),
    titleId,
    gameName: gameName(titleId),
    saves: saves.map(save => ({ ...save, gameName: gameName(save.titleId) })),
    batchError,
    totalBytes: files.reduce((total, file) => total + file.size, 0),
  };
}

async function readWorkspaceFile(root, relative) {
  const selected = resolveInside(root, relative);
  const result = await readInlineFile(selected, MAX_EDITOR_BYTES);
  return { path: relative.split(path.sep).join('/'), ...result };
}

async function writeWorkspaceFile(root, relative, encoded, titleName) {
  const selected = resolveInside(root, relative);
  if (typeof encoded !== 'string') throw new Error('the edited file is not valid base64 data');
  const data = Buffer.from(encoded, 'base64');
  if (data.toString('base64') !== encoded) throw new Error('the edited file is not valid base64 data');
  await writeEditedFile(selected, data);
  return workspaceInfo(root, undefined, titleName);
}

// Function = Save Pages
async function writeWorkspacePages(options, titleName) {
  const editorVersion = await applyWorkspacePages(options);
  try {
    const workspace = await workspaceInfo(options.root, undefined, titleName);
    return { ...workspace, editorVersion };
  } catch (error) {
    throw new Error(`The file was saved, but the workspace could not refresh. Reopen the workspace. ${error.message}`, { cause: error });
  }
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

// Function Output Location
async function batchOutputPath(output, workspace, createParent = false) {
  const destination = path.resolve(output);
  const parentDirectory = path.dirname(destination);
  const base = await fsPromises.realpath(workspace);
  const requireOutside = selected => {
    const relative = path.relative(base, selected);
    if (relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) {
      throw new Error('Choose a batch output outside the decrypted workspace.');
    }
    return selected;
  };
  requireOutside(destination);
  let ancestor = parentDirectory;
  while (true) {
    try {
      requireOutside(await fsPromises.realpath(ancestor));
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  if (!createParent) return destination;
  await fsPromises.mkdir(parentDirectory, { recursive: true });
  const parent = requireOutside(await fsPromises.realpath(parentDirectory));
  return path.join(parent, path.basename(destination));
}

// Function = Publish Batch
async function publishSaveBundle(options, manifest) {
  const { output, workspace, signal, python, resourceRoot, workDir } = options;
  const destination = await batchOutputPath(output, workspace, true);
  checkCanceled(signal);
  const staging = await fsPromises.mkdtemp(path.join(path.dirname(destination), '.garlic-batch-'));
  try {
    const staged = path.join(staging, 'result.zip');
    await runZip(python, resourceRoot, workDir, 'bundle-results', manifest, staged, { signal });
    checkCanceled(signal);
    await fsPromises.rename(staged, destination);
  } finally {
    await fsPromises.rm(staging, { recursive: true, force: true });
  }
}

// Function Batch Encryption
async function runBatchSaveJob(options, saves, temporary, temps, emit) {
  const { signal, accountId, targetTitleId = '', output, workspace } = options;
  const destination = await batchOutputPath(output, workspace);
  const results = [];
  const jobIds = [];
  const names = new Set();
  for (const save of saves) {
    const titleId = targetTitleId || save.titleId;
    const name = `${titleId}/${save.encryptedName}`.toLowerCase();
    if (names.has(name)) throw new Error(`Batch results would duplicate ${titleId}/${save.encryptedName}. Rename the save folders or process them separately.`);
    names.add(name);
    if (!/^[0-9a-fA-F]{16}$/.test(options.useCurrentAccount === true ? save.accountId : accountId)) {
      throw new Error(`Could not read the Account ID for ${save.label}. Choose a target account or repair its param.sfo.`);
    }
  }
  for (const [index, save] of saves.entries()) {
    checkCanceled(signal);
    const prefix = `Save ${index + 1} of ${saves.length}: ${save.label}`;
    emit('status', { message: `Encrypting ${prefix}` });
    const sender = options.sender ? {
      isDestroyed: () => options.sender.isDestroyed(),
      send(channel, event) {
        if (channel === 'save-editor:event' && event.type === 'error') return;
        if (channel === 'save-editor:event' && ['status', 'log'].includes(event.type)) {
          options.sender.send(channel, { ...event, message: `${prefix} — ${event.message}` });
        } else options.sender.send(channel, event);
      },
    } : undefined;
    const archive = path.join(temporary.directory, `result-${index + 1}.zip`);
    let result;
    try {
      result = await runSaveJob({
        ...options, sender, temporaryStore: temps,
        workspace: save.root, output: archive,
        batchSaveName: save.encryptedName,
        accountId: options.useCurrentAccount === true ? save.accountId : accountId,
        useCurrentAccount: false,
      });
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError') throw error;
      throw Object.assign(new Error(`${prefix} — ${error.message}`, { cause: error }), { name: error.name, code: error.code });
    }
    jobIds.push(result.jobId);
    results.push({ archive, titleId: targetTitleId || save.titleId, encryptedName: save.encryptedName });
  }
  checkCanceled(signal);
  emit('status', { message: `Collecting ${saves.length} encrypted saves…` });
  const manifest = path.join(temporary.directory, 'results.json');
  await fsPromises.writeFile(manifest, JSON.stringify({ results }));
  await publishSaveBundle(options, manifest);
  emit('status', { message: `${saves.length} encrypted saves are ready.` });
  return { operation: 'encrypt', jobIds, output: destination, saveCount: saves.length };
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
  // Function Target Title
  if (options.targetTitleId !== undefined && typeof options.targetTitleId !== 'string') {
    throw new Error('Enter the target PPSA as PPSA followed by five digits.');
  }
  const targetTitleId = (options.targetTitleId || '').trim().toUpperCase();
  if (targetTitleId) {
    if (!/^PPSA\d{5}$/.test(targetTitleId)) throw new Error('Enter the target PPSA as PPSA followed by five digits.');
    if (!local) throw new Error('Changing the PPSA requires the local PS5 worker.');
    if (platform !== 'ps5' || !['encrypt', 'resign'].includes(operation)) {
      throw new Error('Changing the PPSA is available when encrypting or resigning a PS5 save.');
    }
  }
  const localHost = String(oracleHost || '').trim();
  if (local) {
    if (!isIP(localHost)) throw new Error('enter a valid local oracle IP in Settings');
    if (platform !== 'ps5') throw new Error('the local save helper supports PS5 saves');
    if (typeof ensureLocalWorker !== 'function') throw new Error('the local save helper is not available; restart GarlicTransfer');
  } else if (!String(workerKey || '').trim()) {
    if (sender && !sender.isDestroyed()) sender.send('device:event', { type: 'required' });
    throw new Error('Authorize the app first!');
  }
  const currentBatchAccount = local && platform === 'ps5' && operation === 'encrypt' && options.useCurrentAccount === true;
  if ((operation === 'encrypt' || operation === 'resign') && !currentBatchAccount && !/^[0-9a-fA-F]{16}$/.test(accountId)) {
    throw new Error('enter a 16-digit hexadecimal account ID');
  }
  if (operation !== 'encrypt' && !inputs.length) throw new Error('choose at least one encrypted save file');
  if (operation === 'encrypt' && !workspace) throw new Error('open a decrypted workspace first');
  if (operation !== 'decrypt' && !output) throw new Error('choose where to save the encrypted result');
  if (operation !== 'decrypt') requireWritableFile(output);
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
    if (operation === 'encrypt') {
      const scan = await scanWorkspace(workspace, undefined, fsPromises);
      if (scan.error) throw scan.error;
      const { saves, batchError } = await workspaceMetadata(scan, platform === 'ps5');
      if (batchError) throw new Error(batchError);
      checkCanceled(signal);
      if (saves.length > 1) {
        if (!local) throw new Error('Encrypting multiple saves requires the local PS5 worker.');
        if (options.singleSaveOnly) throw new Error('Export multiple saves as a new ZIP.');
        return await runBatchSaveJob({ ...options, targetTitleId }, saves, temporary, temps, emit);
      }
      if (!/^[0-9a-fA-F]{16}$/.test(accountId)) throw new Error('enter a 16-digit hexadecimal account ID');
    }
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
      if (options.batchSaveName) params.savename = options.batchSaveName;
      if (targetTitleId) params.target_title_id = targetTitleId;
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
      const info = await workspaceInfo(workspaceRoot, undefined, options.titleName);
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
function registerSaveEditor({ ipcMain, app, dialog, shell, python, resourceRoot, workDir, pcStore, ensureLocalWorker, titleName, requireStableNetwork }) {
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
    return result.canceled ? null : workspaceInfo(result.filePaths[0], undefined, titleName);
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
  ipcMain.handle('save-editor:info', (event, root) => useWorkspace(event, root, () => workspaceInfo(root, undefined, titleName)));
  ipcMain.handle('save-editor:read', (event, { root, path: relative }) => useWorkspace(event, root, () => readWorkspaceFile(root, relative)));
  ipcMain.handle('save-editor:write', (event, { root, path: relative, data }) => useWorkspace(event, root, () => writeWorkspaceFile(root, relative, data, titleName)));
  ipcMain.handle('save-editor:read-page', (event, options) => useWorkspace(event, options.root, () => readWorkspacePage(options)));
  ipcMain.handle('save-editor:write-pages', (event, options) => useWorkspace(event, options.root, () => writeWorkspacePages(options, titleName)));
  ipcMain.handle('save-editor:add', (event, { root }) => useWorkspace(event, root, async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
    if (result.canceled) return null;
    return addWorkspaceFiles(root, result.filePaths, () => workspaceInfo(root, undefined, titleName));
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
    return replaceWorkspaceFile(target, result.filePaths[0], ignored => workspaceInfo(target.root, ignored, titleName));
  }));
  ipcMain.handle('save-editor:delete', (event, { root, path: relative }) => useWorkspace(event, root, async () => {
    const selected = resolveInside(root, relative);
    requireWritableFile(selected);
    if (protectedFile(path.relative(root, selected))) throw new Error('metadata required to rebuild the save cannot be deleted');
    await fsPromises.unlink(selected);
    return workspaceInfo(root, undefined, titleName);
  }));
  ipcMain.handle('save-editor:download-file', (event, { root, path: relative }) => useWorkspace(event, root, async () => {
    const result = await dialog.showSaveDialog({ defaultPath: path.basename(relative) });
    if (result.canceled) return null;
    await checkExportDestination(result.filePath, root);
    await fsPromises.copyFile(resolveInside(root, relative), result.filePath);
    return result.filePath;
  }));
  ipcMain.handle('save-editor:download-archive', (event, { archivePath }) => useWorkspace(event, archivePath, async () => {
    const result = await dialog.showSaveDialog({ defaultPath: path.basename(archivePath) });
    if (result.canceled) return null;
    await checkExportDestination(result.filePath);
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
    if (jobsClosing) throw new Error('GarlicTransfer is closing.');
    requireStableNetwork?.();
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
        ...options, operation: 'encrypt', output, singleSaveOnly: true,
        sender: event.sender, python, resourceRoot, workDir, userDataRoot,
        ensureLocalWorker, temporaryStore, signal, titleName,
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
    titleName,
  })));
}

module.exports = {
  MAX_EDITOR_BYTES,
  accountIdFromSfo,
  createRemoteJob,
  downloadRemoteResult,
  readWorkspaceFile,
  readWorkspacePage,
  registerSaveEditor,
  hasActiveSaveJob: () => activeJob !== null,
  stopSaveJobs,
  resolveInside,
  runSaveJob,
  runZip,
  workspaceInfo,
  writeWorkspaceFile,
  writeWorkspacePages,
};

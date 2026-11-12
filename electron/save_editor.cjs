const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const MAX_EDITOR_BYTES = 8 * 1024 * 1024;
const PROTECTED_ROOT_FILES = new Set(['PS5IMAGE', 'PS5KEY', 'PS5PARAM', 'PS5PARAM_SIZE', 'chives.json']);
let activeJob = false;

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
  return PROTECTED_ROOT_FILES.has(normalized) || normalized.split('/').includes('sce_sys');
}

async function accountIdFromSfo(root) {
  const candidates = [];
  async function visit(directory) {
    for (const entry of await fsPromises.readdir(directory, { withFileTypes: true })) {
      const current = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(current);
      else if (entry.isFile() && entry.name.toLowerCase() === 'param.sfo') candidates.push(current);
    }
  }
  await visit(root);
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

async function workspaceInfo(root) {
  const base = path.resolve(root);
  const files = [];
  async function visit(directory) {
    for (const entry of await fsPromises.readdir(directory, { withFileTypes: true })) {
      const current = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(current);
      } else if (entry.isFile()) {
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
  try {
    const chives = JSON.parse(await fsPromises.readFile(path.join(base, 'chives.json'), 'utf8'));
    titleId = chives.title_id || '';
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  return {
    root: base,
    files,
    accountId: await accountIdFromSfo(base),
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
  const temporary = `${selected}.save-editor.tmp`;
  await fsPromises.writeFile(temporary, data);
  await fsPromises.rename(temporary, selected);
  return workspaceInfo(root);
}

async function runZip(python, resourceRoot, cwd, command, first, second) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-m', 'poc.dt_save_editor', command, first, second], {
      cwd,
      env: { ...process.env, PYTHONPATH: resourceRoot },
    });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(output.trim() || `ZIP ${command} failed`));
      try {
        resolve(JSON.parse(output.trim().split('\n').pop()));
      } catch (error) {
        reject(error);
      }
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

async function postMultipart({ serverUrl, workerKey, operation, accountId, inputs, platform }) {
  const crypto = require('node:crypto');
  const http = require('node:http');
  const https = require('node:https');
  const { once } = require('node:events');
  const boundary = `----GarlicTransfer${crypto.randomBytes(16).toString('hex')}`;
  const url = new URL(`${apiOrigin(serverUrl)}/api/v1/jobs`);
  const transport = url.protocol === 'https:' ? https : http;
  const request = transport.request(url, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'X-Worker-Key': workerKey,
    },
  });
  const responsePromise = new Promise((resolve, reject) => {
    request.on('response', (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('error', reject);
  });
  async function write(data) {
    if (!request.write(data)) await once(request, 'drain');
  }
  async function field(name, value) {
    await write(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  await field('operation', operation);
  if (operation === 'decrypt') await field('include_sce_sys', 'true');
  if (operation === 'encrypt' || operation === 'resign') await field('account_id', accountId);
  if (platform) await field('platform', platform);
  for (const selected of inputs) {
    const filename = path.basename(selected).replace(/["\r\n]/g, '_');
    await write(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    await pipeline(fs.createReadStream(selected), request, { end: false });
    await write('\r\n');
  }
  request.end(`--${boundary}--\r\n`);
  const response = await responsePromise;
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

async function downloadRemoteResult({ serverUrl, workerKey, jobId, output }) {
  const response = await apiResponse(`${apiOrigin(serverUrl)}/api/v1/jobs/${jobId}/result`, {
    headers: { 'X-Worker-Key': workerKey },
  });
  if (!response.body) throw new Error('GarlicSaves returned an empty result');
  await fsPromises.mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.download`;
  try {
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary));
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
  } = options;
  if (!['decrypt', 'encrypt', 'resign'].includes(operation)) throw new Error('unsupported save operation');
  if (!String(workerKey || '').trim()) throw new Error('enter a server key in Settings before using Save Editor');
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
  const jobRoot = path.join(userDataRoot, 'save-editor');
  await fsPromises.mkdir(jobRoot, { recursive: true });
  const uploadRoot = await fsPromises.mkdtemp(path.join(jobRoot, 'upload-'));
  try {
    let uploadInputs = inputs;
    if (operation === 'encrypt') {
      const archive = path.join(uploadRoot, 'workspace.zip');
      await runZip(python, resourceRoot, workDir, 'pack', workspace, archive);
      uploadInputs = [archive];
    }
    emit('status', { message: `Uploading ${operation === 'decrypt' ? 'encrypted save' : 'save files'}…` });
    const workerAccountId = platform === 'ps5' && accountId
      ? Buffer.from(accountId, 'hex').toString('hex')
      : accountId;
    const created = await createRemoteJob({
      serverUrl, workerKey, operation, accountId: workerAccountId, inputs: uploadInputs, platform,
    });
    const jobId = created.job_id;
    if (!jobId) throw new Error('GarlicSaves did not return a job ID');
    emit('job', { jobId, operation });
    const deadline = Date.now() + timeoutMs;
    let logCount = 0;
    let previousStatus = '';
    while (true) {
      if (Date.now() > deadline) throw new Error(`${operation} timed out after ${Math.round(timeoutMs / 60000)} minutes`);
      const response = await apiResponse(`${apiOrigin(serverUrl)}/api/v1/jobs/${jobId}`, {
        headers: { 'X-Worker-Key': workerKey },
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
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    const resultPath = operation === 'decrypt' ? path.join(uploadRoot, 'decrypted.zip') : path.resolve(output);
    emit('status', { message: 'Downloading the result…' });
    await downloadRemoteResult({ serverUrl, workerKey, jobId, output: resultPath });
    if (operation === 'decrypt') {
      const workspaceRoot = path.join(uploadRoot, 'workspace');
      await runZip(python, resourceRoot, workDir, 'extract', resultPath, workspaceRoot);
      emit('status', { message: 'Decrypted save is ready to edit.' });
      return { operation, jobId, archivePath: resultPath, workspace: workspaceRoot, info: await workspaceInfo(workspaceRoot) };
    }
    emit('status', { message: `${operation === 'resign' ? 'Resigned' : 'Encrypted'} save is ready.` });
    return { operation, jobId, output: resultPath };
  } catch (error) {
    emit('error', { message: error.message });
    throw error;
  }
}

function registerSaveEditor({ ipcMain, app, dialog, shell, python, resourceRoot, workDir }) {
  const userDataRoot = app.getPath('userData');
  ipcMain.handle('save-editor:choose-input', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'All files', extensions: ['*'] },
        { name: 'Save containers and archives', extensions: ['zip', 'bin', 'img', 'save', 'dat'] },
      ],
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
  ipcMain.handle('save-editor:local-file', async (_event, { assets, entryId, filename }) => {
    const candidates = [path.join(assets, String(entryId), filename), path.join(assets, filename)];
    const selected = candidates.find((candidate) => fs.existsSync(candidate));
    if (!selected) throw new Error('the downloaded save file no longer exists');
    const paths = [selected];
    if (fs.existsSync(`${selected}.bin`)) paths.push(`${selected}.bin`);
    return paths;
  });
  ipcMain.handle('save-editor:info', (_event, root) => workspaceInfo(root));
  ipcMain.handle('save-editor:read', (_event, { root, path: relative }) => readWorkspaceFile(root, relative));
  ipcMain.handle('save-editor:write', async (_event, { root, path: relative, data }) => writeWorkspaceFile(root, relative, data));
  ipcMain.handle('save-editor:add', async (_event, { root }) => {
    const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
    if (result.canceled) return null;
    for (const selected of result.filePaths) {
      const destination = resolveInside(root, path.basename(selected));
      if (fs.existsSync(destination)) throw new Error(`${path.basename(selected)} already exists; delete it before adding a replacement`);
    }
    for (const selected of result.filePaths) {
      await fsPromises.copyFile(selected, resolveInside(root, path.basename(selected)));
    }
    return workspaceInfo(root);
  });
  ipcMain.handle('save-editor:delete', async (_event, { root, path: relative }) => {
    if (protectedFile(relative)) throw new Error('metadata required to rebuild the save cannot be deleted');
    await fsPromises.unlink(resolveInside(root, relative));
    return workspaceInfo(root);
  });
  ipcMain.handle('save-editor:download-file', async (_event, { root, path: relative }) => {
    const result = await dialog.showSaveDialog({ defaultPath: path.basename(relative) });
    if (result.canceled) return null;
    await fsPromises.copyFile(resolveInside(root, relative), result.filePath);
    return result.filePath;
  });
  ipcMain.handle('save-editor:download-archive', async (_event, { archivePath }) => {
    const result = await dialog.showSaveDialog({ defaultPath: path.basename(archivePath) });
    if (result.canceled) return null;
    await fsPromises.copyFile(archivePath, result.filePath);
    return result.filePath;
  });
  ipcMain.handle('save-editor:show', (_event, selected) => shell.showItemInFolder(selected));
  ipcMain.handle('save-editor:job', async (event, options) => {
    if (activeJob) throw new Error('another save operation is already running');
    activeJob = true;
    try {
      return await runSaveJob({
        ...options,
        sender: event.sender,
        python,
        resourceRoot,
        workDir,
        userDataRoot,
      });
    } finally {
      activeJob = false;
    }
  });
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

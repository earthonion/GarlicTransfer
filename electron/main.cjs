const { loadSkins, getSkinMascot, externalSkinsFolder } = require('./skins.cjs');
const { resolveMetadata } = require('./download_layout.cjs');
const { metadataPath, otherDataPath } = require('./folder_paths.js');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { getNetworkStatus, enableIpv6 } = require('./windows_network.cjs');
const { allowFirewallAccess } = require('./windows_firewall.cjs');
const { startRemoteOracle, stopRemoteOracle } = require('./remote_oracle.cjs');
const { loadSettings, saveSettings } = require('./config.cjs');
const { authorizeDevice } = require('./device_auth.cjs');
const { checkForUpdates } = require('./updates.cjs');
const i18n = require('./i18n.js');
const { titleName } = require('./titles.cjs');
const { pairingPrefixPath, existingPairingPrefix, pairingInfo, pairingInfos } = require('./pairing_store.cjs');
const { registerSaveEditor, stopSaveJobs, hasActiveSaveJob } = require('./save_editor.cjs');
const { LocalPcStore } = require('./local_pc.cjs');
const { AccountStore } = require('./account_store.cjs');
const { registerAccountClose } = require('./account_close.cjs');
const { LocalHelper } = require('./local_helper.cjs');
const { recordConsoleNames } = require('./console_names.cjs');
const { resourceRoot, localWorkerElf, workDir, pythonBin } = require('./paths.cjs');
let window;
let interfaceLanguage = 'en';
let active = null;
let ipv6ChangePending = false;
let oracleRelay = null;
let confirmationPending = false;
let deviceAuthorizationPending = false;
const localPcRoot = path.join(app.getPath('userData'), 'local-pc');
const accountStore = new AccountStore(path.join(app.getPath('userData'), 'account-list.json'));
const pcStore = new LocalPcStore({
  stateFile: path.join(app.getPath('userData'), 'local-pc.json'),
  backupRoot: path.join(localPcRoot, 'backups'),
  stagingRoot: path.join(localPcRoot, 'staging'),
});
const localHelper = new LocalHelper({
  elfPath: localWorkerElf,
  onLog: message => send('log', { message }),
});
let closeServicesTask;

// Function Local Shutdown
function closeLocalServices() {
  if (!closeServicesTask) closeServicesTask = (async () => {
    stopActive();
    await stopSaveJobs();
    await localHelper.shutdown();
  })();
  return closeServicesTask;
}

function send(type, detail = {}) {
  if (type === 'entries' && Array.isArray(detail.entries)) {
    detail = {
      ...detail,
      entries: detail.entries.map((entry) => ({ ...entry, name: titleName(entry.title) })),
    };
  }
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send('transfer:event', { type, ...detail });
  }
}

function stopOracle() {
  stopRemoteOracle(oracleRelay);
  oracleRelay = null;
}

async function ensureOracle(options, session) {
  if (options.useRemoteOracle) {
    if (!options.workerKey) {
      if (window && !window.isDestroyed()) window.webContents.send('device:event', { type: 'required' });
      throw new Error('Authorize the app first!');
    }
    const relay = await startRemoteOracle({
      serverUrl: options.serverUrl,
      workerKey: options.workerKey,
      onLog: (message) => { if (!session || active === session) send('log', { message }); },
    });
    if (session && active !== session) { stopRemoteOracle(relay); return; }
    oracleRelay = relay;
    options.oracleHost = '127.0.0.1';
    options.oraclePort = oracleRelay.port;
    send('log', { message: `[oracle] using volunteer workers through ${options.serverUrl}` });
    return;
  }

  const host = options.oracleHost;
  const port = Number(options.oraclePort || 9022);
  await localHelper.ensureTransfer(host, port);
  send('log', { message: `[oracle] using ${host}:${port}` });
}

// Function Upload Cleanup
function releaseUploadSession(session) {
  if (!session || !session.releaseStage || session.preparing ||
      (session.process && !session.processClosed) || (session.metadataProcess && !session.metadataClosed)) return;
  const release = session.releaseStage;
  session.releaseStage = null;
  release().catch(error => send('log', { message: `[local] Upload cleanup: ${error.message}` }));
}

function stopActive() {
  const session = active;
  active = null;
  if (session) session.canceled = true;
  if (session && session.powerTimer) clearTimeout(session.powerTimer);
  if (session && session.metadataProcess && !session.metadataClosed) session.metadataProcess.kill();
  if (session && session.process && session.process.exitCode === null) {
    if (session.kind === 'upload' && session.process.stdin.writable) session.process.stdin.end();
    session.process.kill();
  }
  releaseUploadSession(session);
  stopOracle();
}

let pairingSessionDirectory;

function pairingSessionRoot() {
  pairingSessionDirectory ??= fs.mkdtempSync(path.join(app.getPath('temp'), 'garlic-pairing-'));
  return pairingSessionDirectory;
}

// Function Transfer Guard
function requireTransferAvailable() {
  requireStableNetwork();
  if (active) throw new Error('another transfer is already running');
}

// Function Adapter Guard
function requireStableNetwork() {
  if (ipv6ChangePending) throw new Error('Wait for the IPv6 change to finish.');
}

function startDownload(options) {
  requireTransferAvailable();
  // The renderer never chooses a local credential file. Resolve it only from
  // the console identity reported by discovery, inside the main process.
  delete options.approvalPrefixPath;
  let paired = null;
  if (options.hostId && options.systemVersion) {
    paired = existingPairingPrefix(pairingSessionRoot(), options);
    if (paired) options.approvalPrefixPath = paired;
  }
  if (!String(options.accountId || '').trim() && !paired) {
    startPairing(options);
    return;
  }
  const session = { kind: 'download', completed: false, awaitingSelection: false, process: null };
  active = session;
  (async () => {
    await ensureOracle(options, session);
    if (active !== session) return;
    const child = spawn(pythonBin(), ['-u', '-m', 'poc.dt_backend', 'download', '-'], {
      cwd: workDir,
      env: { ...process.env, PYTHONPATH: resourceRoot },
    });
    session.process = child;
    child.stdin.write(`${JSON.stringify(options)}\n`);
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      while (active === session && buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'done') session.completed = true;
          if (event.type === 'ready') session.awaitingSelection = true;
          send(event.type, event);
        } catch {
          send('log', { message: line });
        }
      }
    });
    child.stderr.on('data', (data) => { if (active === session) send('log', { message: String(data).trim() }); });
    child.on('error', (error) => finish(error, session));
    child.on('close', (code) => {
      if (active === session && !session.completed && code !== 0) {
        finish(new Error(`download backend exited with status ${code}`), session);
      } else {
        finish(undefined, session);
      }
    });
  })().catch((error) => finish(error, session));
}

function startPairing(options) {
  requireTransferAvailable();
  if (net.isIP(options.clientHost) !== 4) throw new Error('Discover and select a PS5 IPv4 address first');
  const prefixPath = pairingPrefixPath(pairingSessionRoot(), options);
  fs.mkdirSync(path.dirname(prefixPath), { recursive: true, mode: 0o700 });
  active = { kind: 'pair', completed: false, process: null };
  const session = active;
  send('pairingStarted');
  (async () => {
    await ensureOracle(options, session);
    if (active !== session) {
      if (!active) stopOracle();
      return;
    }
    const python = pythonBin();
    let command = python;
    let args = ['-u', '-m', 'poc.dt_pair', '-'];
    let environment = { ...process.env, PYTHONPATH: resourceRoot };
    if (process.platform === 'linux' && process.getuid() !== 0) {
      command = 'pkexec';
      args = [
        '/usr/bin/env',
        `DT_PAIRING_UID=${process.getuid()}`, `DT_PAIRING_GID=${process.getgid()}`,
        python, '-u', '-c',
        `import sys, runpy; sys.path.insert(0, ${JSON.stringify(resourceRoot)}); sys.argv = ['poc.dt_pair', '-']; runpy.run_module('poc.dt_pair', run_name='__main__')`,
      ];
      environment = process.env;
    }
    const child = spawn(command, args, {
      cwd: workDir,
      env: environment,
    });
    session.process = child;
    child.stdin.end(`${JSON.stringify({
      ps5Ip: options.clientHost,
      hostId: options.hostId,
      systemVersion: options.systemVersion,
      oracleHost: options.oracleHost,
      oraclePort: Number(options.oraclePort || 9022),
      prefixPath,
      duration: 300,
    })}\n`);
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      while (active === session && buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          const event = JSON.parse(line);
          if (event.type === 'status') send('status', { message: String(event.message || '') });
          if (event.type === 'error') session.error = String(event.message || 'Pairing failed');
          if (event.type === 'paired') {
            if (!existingPairingPrefix(pairingSessionRoot(), options)) {
              session.error = 'Pairing helper did not save a valid identifier';
            } else {
              session.completed = true;
            }
          }
        } catch {
          // Do not forward unrecognized helper output; it could contain request data.
          session.error = 'Pairing helper sent an unreadable response';
        }
      }
    });
    child.stderr.on('data', (data) => {
      if (active !== session) return;
      send('log', { message: `[helper] ${String(data).trim()}` });
      session.error ||= 'Pairing helper failed';
    });
    child.on('error', (error) => {
      if (active === session) finish(error, session);
    });
    child.on('close', (code) => {
      if (active !== session) return;
      if (!session.completed || code !== 0) finish(new Error(session.error || `Pairing exited with status ${code}`), session);
      else {
        finish(undefined, session);
        send('paired', { message: 'Pairing saved for this PS5. Return to its home screen, then browse saves.' });
      }
    });
  })().catch((error) => {
    if (active === session) finish(error, session);
  });
}

function getConsoles(options) {
  return new Promise((resolve, reject) => {
    const { discoveryRoutes } = require('./discovery.cjs');
    const routes = net.isIP(options.targetHost) === 4
      ? [{ bind: '', target: options.targetHost }]
      : discoveryRoutes();
    const port = String(Number(options.discoveryPort) || 1006);
    const child = spawn(pythonBin(), [
      '-m', 'poc.dt_discovery', '--routes', JSON.stringify(routes), '--port', port,
    ], { cwd: workDir, env: { ...process.env, PYTHONPATH: resourceRoot } });
    let buffer = '';
    child.stdout.on('data', (data) => { buffer += data; });
    child.stderr.on('data', (data) => { buffer += data; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(buffer.trim() || 'console discovery failed'));
      try {
        const consoles = JSON.parse(buffer).consoles || [];
        const selectedId = String(options.hostId || '').trim().toUpperCase();
        const namedConsoles = consoles.map(console => typeof options.profileId === 'string' && selectedId
          && typeof console.hostId === 'string' && console.hostId.trim().toUpperCase() === selectedId
          ? { ...console, profileId: options.profileId } : console);
        recordConsoleNames(options.profileRoot || options.output, namedConsoles);
        resolve(consoles);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function getUsers(metadataPath) {
  metadataPath = resolveMetadata(metadataPath, path.dirname(metadataPath));
  if (!fs.existsSync(metadataPath)) return Promise.reject(new Error('Browse the console to obtain user metadata.'));
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin(), ['-m', 'poc.dt_backend', 'users', metadataPath], { cwd: workDir, env: { ...process.env, PYTHONPATH: resourceRoot } });
    let buffer = '';
    child.stdout.on('data', (data) => { buffer += data; });
    child.stderr.on('data', (data) => { buffer += data; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(buffer.trim() || 'could not read metadata users'));
      try {
        const event = JSON.parse(buffer.trim().split('\n').pop());
        resolve(event.users || []);
      } catch (error) {
        reject(error);
      }
    });
  });
}

// Read upload inventory.
function getInventory(metadataPath) {
  metadataPath = resolveMetadata(metadataPath, path.dirname(metadataPath));
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin(), ['-m', 'poc.dt_backend', 'inventory', metadataPath], { cwd: workDir, env: { ...process.env, PYTHONPATH: resourceRoot } });
    let buffer = '';
    child.stdout.on('data', (data) => { buffer += data; });
    child.stderr.on('data', (data) => { buffer += data; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(buffer.trim() || 'could not read metadata inventory'));
      try {
        const event = JSON.parse(buffer.trim().split('\n').pop());
        resolve({
          users: event.users || [],
          entries: (event.entries || []).map((entry) => ({ ...entry, name: titleName(entry.title) })),
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function runLocalSaveOperation(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin(), ['-m', 'poc.dt_local_saves', command, ...args], {
      cwd: workDir,
      env: { ...process.env, PYTHONPATH: resourceRoot },
    });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(output.trim() || `local save ${command} failed`));
      try {
        const result = JSON.parse(output.trim().split('\n').pop());
        if (command === 'list' && Array.isArray(result.entries)) {
          result.entries = result.entries.map((entry) => ({ ...entry, name: titleName(entry.title) }));
        }
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
  });
}

// Build upload metadata.
function createMetadata(options, session) {
  options.metadata = resolveMetadata(options.metadata, options.output);
  return new Promise((resolve, reject) => {
    fs.mkdirSync(metadataPath(options.output), { recursive: true });
    const generatedMetadata = metadataPath(options.output, 'generated-metadata.db');
    const generatedManifest = metadataPath(options.output, 'generated-upload-manifest.json');
    if (options.uploadKind === 'external') options.assets = otherDataPath(options.output, `external-save-${Date.now()}`);
    const args = [
      '-m', 'poc.dt_metadata',
      '--output', generatedMetadata,
      '--user-id', options.userId,
      '--assets', options.assets,
      '--user-name', options.userName || 'user',
      '--manifest-output', generatedManifest,
    ];
    const sourceMetadata = resolveMetadata(options.metadata, options.output);
    if (options.uploadKind === 'external') {
      args.push('--external-image', options.externalImage, '--title-id', options.titleId || '', '--source', sourceMetadata);
    } else if (options.uploadKind === 'other') {
      args.push('--other', '--source', sourceMetadata);
    } else {
      args.push('--source', sourceMetadata);
      if (options.serverUrl) args.push('--server-url', options.serverUrl);
      if (options.workerKey) args.push('--worker-key', options.workerKey);
    }
    const entryIds = Array.isArray(options.entryIds) ? options.entryIds : [];
    for (const entryId of entryIds) args.push('--entry-id', String(entryId));
    const child = spawn(pythonBin(), args, { cwd: workDir, env: { ...process.env, PYTHONPATH: resourceRoot } });
    if (session) session.metadataProcess = child;
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (session) { session.metadataClosed = true; releaseUploadSession(session); }
      if (session && active !== session) return reject(new Error('Upload canceled.'));
      if (code !== 0) return reject(new Error(output.trim() || 'metadata generation failed'));
      options.metadata = generatedMetadata;
      options.uploadManifest = generatedManifest;
      send('log', { message: `[metadata] generated ${options.metadata} for ${entryIds.length || 1} save(s)` });
      resolve();
    });
  });
}

function startUpload(options) {
  requireTransferAvailable();
  const releaseStage = options.localPcUploadId ? pcStore.retainUpload(options.localPcUploadId, options.externalImage) : null;
  const session = { kind: 'upload', completed: false, process: null, releaseStage, preparing: true };
  active = session;
  (async () => {
    await createMetadata(options, session);
    if (active !== session) return;
    await ensureOracle(options, session);
    if (active !== session) return;
    const prefixPath = pairingPrefixPath(pairingSessionRoot(), options);
    fs.mkdirSync(path.dirname(prefixPath), { recursive: true, mode: 0o700 });
    const sourceEnvironment = {
      DT_METADATA: path.resolve(options.metadata),
      DT_ASSETS: path.resolve(options.assets),
      DT_MANIFEST: path.resolve(options.uploadManifest),
      DT_UPLOAD_KIND: options.uploadKind || 'save',
      DT_LOG: metadataPath(path.resolve(options.output), 'dt-source.log'),
      DT_PAIRING_PREFIX: prefixPath,
      DT_EXPECTED_HOST_ID: String(options.hostId),
      DT_EXIT_ON_EOF: '1',
      DT_AUTO_POWER: '1',
      DT_PORT: String(options.sourcePort || 1004),
      DT_DATA_PORT: String(options.dataPort || 1005),
      DT_DISCOVERY_PORT: String(options.discoveryPort || 1006),
      DT_HOST_NAME: String(options.uploadDisplayName || 'GarlicTransfer'),
      // ensureOracle() has already resolved these: for the volunteer oracle it
      // points at the local relay it just started, otherwise at the configured
      // console.  dt_source used to fall back to its own 192.168.0.125:9022
      // default, so upload could never derive keys off the developer's LAN.
      DT_ORACLE_HOST: String(options.oracleHost || '127.0.0.1'),
      DT_ORACLE_PORT: String(options.oraclePort || 9022),
    };
    if (process.platform !== 'win32') {
      sourceEnvironment.DT_PAIRING_UID = String(process.getuid());
      sourceEnvironment.DT_PAIRING_GID = String(process.getgid());
    }
    if (options.advertiseAddress) {
      sourceEnvironment.DT_ADVERTISE = String(options.advertiseAddress);
    }
    if (options.systemVersion) {
      sourceEnvironment.DT_SYSTEM_VERSION = String(options.systemVersion);
    }
    const needsRoot = process.platform === 'linux' && process.getuid() !== 0 &&
      [sourceEnvironment.DT_PORT, sourceEnvironment.DT_DATA_PORT, sourceEnvironment.DT_DISCOVERY_PORT]
        .some((port) => Number(port) < 1024);
    const python = pythonBin();
    let command = python;
    let args = ['-u', '-m', 'poc.dt_source'];
    let environment = { ...process.env, PYTHONPATH: resourceRoot, ...sourceEnvironment };
    if (needsRoot) {
      command = 'pkexec';
      args = [
        '/usr/bin/env', `PYTHONPATH=${resourceRoot}`,
        ...Object.entries(sourceEnvironment).map(([name, value]) => `${name}=${value}`),
        python, '-u', '-m', 'poc.dt_source',
      ];
      environment = process.env;
      send('log', { message: '[privilege] authenticate to bind Data Transfer ports 1004–1006' });
    }
    const child = spawn(command, args, { cwd: workDir, env: environment });
    session.process = child;
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      while (active === session && buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        send('log', { message: line });
        if (line.includes("type 'power'")) {
          send('status', { step: 3, message: 'Sending the source power signal automatically in 1 second.' });
        }
        if (line.toLowerCase().includes('cmd=0xb3')) {
          session.transferFinished = true;
          send('status', { step: 3, message: 'Save data sent. Waiting for the console to disconnect.' });
        }
        if (line.toLowerCase().includes('response complete cmd=0xb0')) {
          session.rebootRequested = true;
          send('status', { step: 3, message: 'Reboot requested. Waiting for the console to reconnect for reboot authentication.' });
        }
        if (session.rebootRequested && line.toLowerCase().includes('response complete cmd=0x93')) {
          session.rebootAuthenticated = true;
          send('status', { step: 3, message: 'Reboot authentication acknowledged. Finishing the transfer.' });
        }
        if (session.transferFinished && !session.rebootRequested && line.toLowerCase().includes('response complete cmd=0x94')) {
          session.completed = true;
          send('done', { message: 'Save upload completed. The client may reboot to finish.' });
          stopActive();
          return;
        }
        if (session.rebootAuthenticated && line.includes('[cmd] session ended:')) {
          session.completed = true;
          send('done', { message: 'Save upload and reboot authentication completed.' });
          stopActive();
          return;
        }
        if (!session.transferFinished && !session.rebootRequested && line.includes('[cmd] session ended:')) {
          finish(new Error('The console closed the connection before any save data was sent. Please retry Data Transfer.'), session);
          return;
        }
      }
    });
    child.stderr.on('data', (data) => { if (active === session) send('log', { message: String(data).trim() }); });
    child.on('error', (error) => finish(error, session));
    child.on('close', (code) => {
      session.processClosed = true;
      releaseUploadSession(session);
      if (active !== session) return;
      if (active === session && session.transferFinished && !session.completed && code === 0) {
        session.completed = true;
        send('done', { message: 'Save upload completed. The console closed the transfer session.' });
      }
      if (active === session && !session.completed && code !== 0) {
        finish(new Error(`source emulator exited with status ${code}`), session);
      } else {
        finish(undefined, session);
      }
    });
  })().catch((error) => finish(error, session)).finally(() => {
    session.preparing = false;
    releaseUploadSession(session);
  });
}

function finish(error, session = active) {
  if (active !== session) return;
  const current = active;
  stopActive();
  if (error) send('error', { message: error.message });
  else if (current && !current.completed) send('status', { message: 'Transfer stopped.' });
}

function resolvedInterfaceLanguage(preference) {
  return i18n.resolve(preference, app.getPreferredSystemLanguages());
}

async function loadInterface(language, page) {
  const previous = interfaceLanguage;
  interfaceLanguage = language;
  i18n.setLanguage(language);
  const query = page ? { language, page } : { language };
  try {
    await window.loadFile(path.join(__dirname, 'index.html'), { query });
  } catch (error) {
    interfaceLanguage = previous;
    i18n.setLanguage(previous);
    throw error;
  }
}

app.whenReady().then(() => {
  window = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 1000,
    minHeight: 680,
    autoHideMenuBar: process.platform !== 'darwin',
    backgroundColor: '#11151b',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  registerAccountClose({ app, window, ipcMain, dialog,
    beforeClose: closeLocalServices,
    onError: error => send('log', { message: `Account close: ${error.message}` }) });
  return loadInterface(resolvedInterfaceLanguage(loadSettings().uiLanguage));
});

app.on('will-quit', stopActive);
app.on('will-quit', () => {
  if (!pairingSessionDirectory) return;
  try {
    fs.rmSync(pairingSessionDirectory, { recursive: true, force: true });
  } catch (error) {
    console.warn('Could not remove session pairing files:', error.message);
  }
});
app.on('will-quit', () => localHelper.stop());
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('dialog:output', async () => {
  const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:metadata', async () => {
  const result = await dialog.showOpenDialog(window, {
    properties: ['openFile'],
    filters: [{ name: i18n.t('SQLite metadata'), extensions: ['db'] }, { name: i18n.t('All files'), extensions: ['*'] }],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:assets', async () => {
  const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:external-folder', async () => {
  const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:external-save', async () => {
  const result = await dialog.showOpenDialog(window, {
    properties: ['openFile'],
    filters: [{ name: i18n.t('All files'), extensions: ['*'] }],
  });
  return result.canceled ? null : result.filePaths[0];
});

function runExportZip(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin(), ['-m', 'poc.dt_export_zip', ...args], {
      cwd: workDir,
      env: { ...process.env, PYTHONPATH: resourceRoot },
    });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(output.trim() || 'zip operation failed'));
      try {
        resolve(JSON.parse(output.trim().split('\n').pop()));
      } catch (error) {
        reject(error);
      }
    });
  });
}

ipcMain.handle('dialog:export-zip', async (_event, { output, entryId, suggestedName }) => {
  const result = await dialog.showSaveDialog(window, {
    defaultPath: suggestedName || `save-entry-${entryId}.zip`,
    filters: [{ name: i18n.t('ZIP archive'), extensions: ['zip'] }],
  });
  if (result.canceled || !result.filePath) return null;
  return runExportZip(['export', '--library', output, '--entry-id', String(entryId), '--out', result.filePath]);
});

ipcMain.handle('dialog:external-zip', async (_event, { output }) => {
  const result = await dialog.showOpenDialog(window, {
    properties: ['openFile'],
    filters: [{ name: i18n.t('ZIP archive'), extensions: ['zip'] }],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const workspace = otherDataPath(output, `external-zip-${Date.now()}`);
  const { title_id: titleId } = await runExportZip(['extract', '--archive', result.filePaths[0], '--out', workspace]);
  return { folder: workspace, titleId };
});

ipcMain.handle('transfer:download', (_event, options) => startDownload(options));
ipcMain.handle('transfer:pair', (_event, options) => startPairing(options));
ipcMain.handle('transfer:pair-status', (_event, identity) => {
  if (!identity?.hostId || !identity?.systemVersion) return false;
  return Boolean(existingPairingPrefix(pairingSessionRoot(), identity));
});
ipcMain.handle('transfer:pair-info', (_event, identity) => pairingInfo(pairingSessionRoot(), identity));
ipcMain.handle('transfer:pair-infos', (_event, identities) => pairingInfos(pairingSessionRoot(), identities));
ipcMain.handle('transfer:select', (_event, entryIds) => {
  if (!active || active.kind !== 'download' || !active.awaitingSelection || !active.process) {
    throw new Error('no download session is waiting for a selection');
  }
  if (!Array.isArray(entryIds) || !entryIds.length) throw new Error('select at least one save');
  active.awaitingSelection = false;
  active.process.stdin.write(`${JSON.stringify({ entryIds })}\n`);
});
ipcMain.handle('transfer:finish', () => {
  if (!active || active.kind !== 'download' || !active.awaitingSelection || !active.process) {
    throw new Error('no download session is ready to finish');
  }
  active.awaitingSelection = false;
  active.process.stdin.write(`${JSON.stringify({ action: 'finish' })}\n`);
});
ipcMain.handle('transfer:upload', (_event, options) => startUpload(options));
ipcMain.handle('transfer:users', (_event, metadataPath) => getUsers(metadataPath));
ipcMain.handle('transfer:inventory', (_event, metadataPath) => getInventory(metadataPath));
ipcMain.handle('local:inventory', (_event, assets) => runLocalSaveOperation('list', [assets]));
ipcMain.handle('local:profiles', (_event, assets) => runLocalSaveOperation('profiles', [assets]));

// Function PC Loading
function pcInventoryNames(result) {
  return { ...result, entries: result.entries.map((entry) => ({ ...entry, name: titleName(entry.title) })) };
}

ipcMain.handle('local-pc:state', () => pcStore.status());
ipcMain.handle('local-pc:inventory', async () => pcInventoryNames(await pcStore.inventory()));
ipcMain.handle('local-pc:choose-folder', async () => {
  if (active) throw new Error('stop the active transfer before choosing PC saves');
  const result = await dialog.showOpenDialog(window, {
    title: i18n.t('Choose PC saves folder'),
    properties: ['openDirectory'],
  });
  if (result.canceled) return null;
  if (active) throw new Error('stop the active transfer before choosing PC saves');
  return pcInventoryNames(await pcStore.setRoot(result.filePaths[0]));
});
ipcMain.handle('local-pc:active', async (_event, selected) => {
  if (active) throw new Error('stop the active transfer before changing local saves');
  return pcStore.setActive(Boolean(selected));
});
ipcMain.handle('local-pc:prepare-upload', (_event, { entryId }) => {
  if (active) throw new Error('stop the active transfer before preparing PC saves');
  return pcStore.prepareUpload(entryId);
});
ipcMain.handle('local-pc:release-upload', (_event, id) => pcStore.releaseUpload(id));

ipcMain.handle('local:export', async (_event, { assets, entryId, filename, localSource }) => {
  if (active) throw new Error('stop the active transfer before exporting a local save');
  const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] });
  if (result.canceled) return null;
  if (localSource === 'pc') return pcStore.export(entryId, filename, result.filePaths[0]);
  return runLocalSaveOperation('export', [assets, String(entryId), filename, result.filePaths[0]]);
});
ipcMain.handle('local:import', (_event, { assets, entryId, filename, source, localSource }) => {
  if (active) throw new Error('stop the active transfer before replacing a local save');
  if (localSource === 'pc') return pcStore.replace(entryId, filename, source);
  return runLocalSaveOperation('import', [assets, String(entryId), filename, source]);
});
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('updates:check', () => checkForUpdates(app.getVersion()));
ipcMain.handle('updates:open', (_event, downloadUrl) => {
  if (typeof downloadUrl !== 'string' || !/^https:\/\/github\.com\/earthonion\/GarlicTransfer\/releases\//.test(downloadUrl)) {
    throw new Error('Invalid update download URL');
  }
  return shell.openExternal(downloadUrl);
});
// Function Network Actions
function requireNetworkWindow(event) {
  if (process.platform !== 'win32') throw new Error('Network settings are only available on Windows.');
  const frame = event.senderFrame;
  const appPage = pathToFileURL(path.join(__dirname, 'index.html')).href;
  if (!window || window.isDestroyed() || event.sender !== window.webContents ||
      !frame || frame !== event.sender.mainFrame || frame.url.split(/[?#]/, 1)[0] !== appPage) {
    throw new Error('Open network settings from the GarlicTransfer window.');
  }
}

ipcMain.handle('windows:firewall-helper', event => {
  requireNetworkWindow(event);
  return allowFirewallAccess();
});
ipcMain.handle('windows:network-status', (event, host) => {
  requireNetworkWindow(event);
  return getNetworkStatus(host);
});
ipcMain.handle('windows:enable-ipv6', async (event, host, interfaceIndex) => {
  requireNetworkWindow(event);
  requireStableNetwork();
  if (active || hasActiveSaveJob()) throw new Error('Finish the active transfer or save operation before enabling IPv6.');
  ipv6ChangePending = true;
  try {
    return await enableIpv6(host, interfaceIndex);
  } finally {
    ipv6ChangePending = false;
  }
});
ipcMain.handle('transfer:discover', (_event, options) => getConsoles(options));
ipcMain.handle('transfer:power', () => {
  if (active && active.kind === 'upload' && active.process && active.process.exitCode === null) {
    active.process.stdin.write('power\n');
  }
});
ipcMain.handle('transfer:cancel', stopActive);
ipcMain.handle('device:authorize', async (_event, options) => {
  if (deviceAuthorizationPending) throw new Error('Installation authorization is already in progress');
  const settings = loadSettings();
  const serverUrl = String(options?.serverUrl || settings.serverUrl);
  deviceAuthorizationPending = true;
  try {
    const result = await authorizeDevice({
      serverUrl,
      name: settings.uploadDisplayName || 'GarlicTransfer installation',
      onPending: async detail => {
        if (window && !window.isDestroyed()) window.webContents.send('device:event', { type: 'pending', ...detail });
        await shell.openExternal(detail.verificationUri);
      },
    });
    saveSettings({ ...loadSettings(), serverUrl, ...result });
    return { installationId: result.installationId, authorizedUser: result.authorizedUser };
  } finally {
    deviceAuthorizationPending = false;
  }
});
ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:set', (_event, settings) => {
  saveSettings(settings);
  return resolvedInterfaceLanguage(settings.uiLanguage) !== interfaceLanguage;
});
ipcMain.handle('settings:reload-language', async (event) => {
  if (!window || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame || active || confirmationPending) return false;
  const language = resolvedInterfaceLanguage(loadSettings().uiLanguage);
  if (language !== interfaceLanguage) await loadInterface(language, 'settings');
  return true;
});

// Function Confirmation
ipcMain.handle('app:confirm', async (event, message) => {
  if (typeof message !== 'string' || !message.trim() || message.length > 4096) {
    throw new Error('Enter a confirmation message up to 4096 characters.');
  }
  const owner = window;
  if (!owner || owner.isDestroyed() || event?.sender !== owner.webContents
      || event.sender.isDestroyed?.() || confirmationPending) return false;
  confirmationPending = true;
  try {
    const result = await dialog.showMessageBox(owner, {
      type: 'question', title: 'GarlicTransfer', message: message.trim(),
      buttons: [i18n.t('Cancel'), i18n.t('Continue')], defaultId: 0, cancelId: 0, noLink: true,
    });
    return window === owner && !owner.isDestroyed() && !event.sender.isDestroyed?.() && result.response === 1;
  } finally {
    confirmationPending = false;
  }
});

// Function Account Actions
ipcMain.handle('accounts:get', () => accountStore.getState());
ipcMain.handle('accounts:add', (_event, id, name) => accountStore.add(id, name));
ipcMain.handle('accounts:rename', (_event, id, name) => accountStore.rename(id, name));
ipcMain.handle('accounts:remove', (_event, id) => accountStore.remove(id));
ipcMain.handle('accounts:select', (_event, id) => accountStore.select(id));
ipcMain.handle('accounts:display-mode', (_event, mode) => accountStore.setDisplayMode(mode));
ipcMain.handle('accounts:use-current', (_event, value) => accountStore.setUseCurrent(value));

registerSaveEditor({
  titleName,
  ipcMain,
  app,
  dialog,
  shell,
  python: pythonBin(),
  resourceRoot,
  workDir,
  pcStore,
  requireStableNetwork,
  ensureLocalWorker: host => localHelper.ensure(host),
});

// Function Skin Folder
function skinsFolder() { return externalSkinsFolder(app.isPackaged, app.getPath('exe'), app.getAppPath()); }
ipcMain.handle('skins:list', () => loadSkins(path.join(__dirname, 'skins'), skinsFolder()));
ipcMain.handle('skins:mascot', (_event, id) => getSkinMascot(path.join(__dirname, 'skins'), skinsFolder(), id));
ipcMain.handle('skins:open', async () => {
  const folder = skinsFolder(); fs.mkdirSync(folder, { recursive: true });
  const error = await shell.openPath(folder); if (error) throw new Error(error);
  return folder;
});

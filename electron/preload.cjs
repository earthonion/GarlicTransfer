const { contextBridge, ipcRenderer } = require('electron');

// Function Account Bridge
contextBridge.exposeInMainWorld('saveAccounts', {
  getState: () => ipcRenderer.invoke('accounts:get'),
  add: (id, name = '') => ipcRenderer.invoke('accounts:add', id, name),
  rename: (id, name) => ipcRenderer.invoke('accounts:rename', id, name),
  remove: id => ipcRenderer.invoke('accounts:remove', id),
  select: id => ipcRenderer.invoke('accounts:select', id),
  setDisplayMode: mode => ipcRenderer.invoke('accounts:display-mode', mode),
  setUseCurrent: value => ipcRenderer.invoke('accounts:use-current', value),
  onBeforeClose: (flush, resume) => {
    if (typeof flush !== 'function' || typeof resume !== 'function') throw new TypeError('Account close callbacks are required.');
    const listener = async (_event, token) => {
      if (typeof token !== 'string' || token.length > 128) return;
      try {
        await flush();
        ipcRenderer.send('accounts:flushed', token, { ok: true });
      } catch (error) {
        ipcRenderer.send('accounts:flushed', token, { ok: false, error: String(error?.message || 'Could not save account names.').slice(0, 2048) });
      }
    };
    const canceled = () => resume();
    ipcRenderer.on('accounts:flush', listener);
    ipcRenderer.on('accounts:close-cancelled', canceled);
    ipcRenderer.send('accounts:ready');
    return () => {
      ipcRenderer.removeListener('accounts:flush', listener);
      ipcRenderer.removeListener('accounts:close-cancelled', canceled);
    };
  },
});

contextBridge.exposeInMainWorld('saveTransfer', {
  confirm: (message) => ipcRenderer.invoke('app:confirm', message),
  getSkins: () => ipcRenderer.invoke('skins:list'),
  getSkinMascot: (id) => ipcRenderer.invoke('skins:mascot', id),
  openSkinsFolder: () => ipcRenderer.invoke('skins:open'),
  pairingAvailable: true,
  firewallAvailable: process.platform === 'win32',
  runFirewallHelper: () => ipcRenderer.invoke('windows:firewall-helper'),
  getNetworkStatus: host => ipcRenderer.invoke('windows:network-status', host),
  enableIpv6: (host, interfaceIndex) => ipcRenderer.invoke('windows:enable-ipv6', host, interfaceIndex),
  chooseOutput: () => ipcRenderer.invoke('dialog:output'),
  chooseMetadata: () => ipcRenderer.invoke('dialog:metadata'),
  chooseAssets: () => ipcRenderer.invoke('dialog:assets'),
  chooseExternalFolder: () => ipcRenderer.invoke('dialog:external-folder'),
  chooseExternalSave: () => ipcRenderer.invoke('dialog:external-save'),
  chooseExternalZip: (output) => ipcRenderer.invoke('dialog:external-zip', { output }),
  exportEntryZip: (output, entryId, suggestedName) => ipcRenderer.invoke('dialog:export-zip', { output, entryId, suggestedName }),
  pair: (options) => ipcRenderer.invoke('transfer:pair', options),
  pairingStatus: (identity) => ipcRenderer.invoke('transfer:pair-status', identity),
  pairingInfo: (identity) => ipcRenderer.invoke('transfer:pair-info', identity),
  pairingInfos: (identities) => ipcRenderer.invoke('transfer:pair-infos', identities),
  download: (options) => ipcRenderer.invoke('transfer:download', options),
  select: (entryIds) => ipcRenderer.invoke('transfer:select', entryIds),
  finish: () => ipcRenderer.invoke('transfer:finish'),
  upload: (options) => ipcRenderer.invoke('transfer:upload', options),
  users: (metadataPath) => ipcRenderer.invoke('transfer:users', metadataPath),
  inventory: (metadataPath) => ipcRenderer.invoke('transfer:inventory', metadataPath),
  localSaves: (assets) => ipcRenderer.invoke('local:inventory', assets),
  localProfiles: (assets) => ipcRenderer.invoke('local:profiles', assets),
  localPcState: () => ipcRenderer.invoke('local-pc:state'),
  localPcInventory: () => ipcRenderer.invoke('local-pc:inventory'),
  chooseLocalPcFolder: () => ipcRenderer.invoke('local-pc:choose-folder'),
  setLocalPcActive: (selected) => ipcRenderer.invoke('local-pc:active', selected),
  prepareLocalPcUpload: (options) => ipcRenderer.invoke('local-pc:prepare-upload', options),
  releaseLocalPcUpload: (id) => ipcRenderer.invoke('local-pc:release-upload', id),
  exportLocalSave: (options) => ipcRenderer.invoke('local:export', options),
  importLocalSave: (options) => ipcRenderer.invoke('local:import', options),
  discover: (options) => ipcRenderer.invoke('transfer:discover', options),
  power: () => ipcRenderer.invoke('transfer:power'),
  cancel: () => ipcRenderer.invoke('transfer:cancel'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:set', settings),
  authorizeDevice: (options) => ipcRenderer.invoke('device:authorize', options),
  onDeviceEvent: (callback) => {
    const listener = (_event, detail) => callback(detail);
    ipcRenderer.on('device:event', listener);
    return () => ipcRenderer.removeListener('device:event', listener);
  },
  reloadLanguage: () => ipcRenderer.invoke('settings:reload-language'),
  version: () => ipcRenderer.invoke('app:version'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  openUpdate: (downloadUrl) => ipcRenderer.invoke('updates:open', downloadUrl),
  onEvent: (callback) => {
    const listener = (_event, detail) => callback(detail);
    ipcRenderer.on('transfer:event', listener);
    return () => ipcRenderer.removeListener('transfer:event', listener);
  },
});

contextBridge.exposeInMainWorld('saveEditor', {
  cancel: () => ipcRenderer.invoke('save-editor:cancel'),
  chooseInput: () => ipcRenderer.invoke('save-editor:choose-input'),
  chooseWorkspace: () => ipcRenderer.invoke('save-editor:choose-workspace'),
  chooseOutput: (defaultPath) => ipcRenderer.invoke('save-editor:choose-output', defaultPath),
  localFile: (options) => ipcRenderer.invoke('save-editor:local-file', options),
  backupLocal: (options) => ipcRenderer.invoke('save-editor:backup-local', options),
  encryptLocal: (options) => ipcRenderer.invoke('save-editor:encrypt-local', options),
  info: (root) => ipcRenderer.invoke('save-editor:info', root),
  read: (options) => ipcRenderer.invoke('save-editor:read', options),
  write: (options) => ipcRenderer.invoke('save-editor:write', options),
  readPage: (options) => ipcRenderer.invoke('save-editor:read-page', options),
  writePages: (options) => ipcRenderer.invoke('save-editor:write-pages', options),
  add: (root) => ipcRenderer.invoke('save-editor:add', { root }),
  replace: (options) => ipcRenderer.invoke('save-editor:replace', options),
  delete: (options) => ipcRenderer.invoke('save-editor:delete', options),
  downloadFile: (options) => ipcRenderer.invoke('save-editor:download-file', options),
  downloadArchive: (archivePath) => ipcRenderer.invoke('save-editor:download-archive', { archivePath }),
  show: (path) => ipcRenderer.invoke('save-editor:show', path),
  run: (options) => ipcRenderer.invoke('save-editor:job', options),
  releaseTemporary: (id) => ipcRenderer.invoke('save-editor:release-temporary', id),
  onEvent: (callback) => {
    const listener = (_event, detail) => callback(detail);
    ipcRenderer.on('save-editor:event', listener);
    return () => ipcRenderer.removeListener('save-editor:event', listener);
  },
});

const folderPaths = window.transferFolders;
const consoleInfo = window.ConsoleInfo;
const { t: uiText } = window.GarlicI18n;
window.GarlicI18n.setLanguage(new URLSearchParams(location.search).get('language'));
window.GarlicI18n.localizeDocument(document);
const byId = (id) => document.getElementById(id);
const controls = {};
for (const id of [
  'uiLayout', 'uiLanguage', 'oracleHost', 'interface', 'hardware', 'output', 'metadata', 'assets',
  'useRemoteOracle', 'serverUrl', 'workerKey', 'workerKeyRevision', 'installationId', 'authorizedUser', 'authorizeDeviceBtn', 'deviceAuthStatus', 'deviceAuthFallback', 'deviceAuthUrl', 'deviceAuthCopyBtn', 'deviceAuthCode', 'settingsSave', 'settingsStatus', 'appVersion',
  'firewallSettings', 'firewallHelperBtn', 'firewallStatus',
  'addExternalFolderBtn', 'externalUploadControls', 'addExternalSaveBtn', 'addExternalZipBtn', 'exportZipBtn', 'externalTitleId', 'userSelect', 'userSelectLabel', 'uploadSaveSelect', 'uploadSaveSelectLabel', 'confirmUploadBtn', 'sourcePort', 'dataPort', 'discoveryPort', 'uploadDisplayName',
  'downloadBtn', 'downloadSelectedBtn', 'uploadBtn', 'finishBtn', 'cancelBtn', 'powerBtn', 'status', 'entries', 'appEntries', 'profileEntries', 'mediaEntries', 'otherEntries', 'log', 'saveSearch',
  'consoleSelect', 'consoleLocatorRows', 'jbFirmwareLimit', 'transferConsoleHost', 'transferConsoleLabel', 'discoverBtn', 'manualHost', 'manualConnectBtn', 'pairBtn', 'pairingState', 'preferIpv6', 'selectAllEntries', 'entryCount', 'powerModal',
  'pairingModal', 'pairingCancelBtn', 'uploadModal', 'uploadModalCloseBtn', 'authorizationModal', 'authorizationNowBtn', 'authorizationCancelBtn', 'authorizationDescription', 'authorizationFallback', 'authorizationUrl', 'authorizationCopyBtn', 'authorizationCode',
  'browseLocalBtn', 'localBrowser', 'localEntries', 'importModal', 'importWarning', 'confirmImportBtn', 'cancelImportBtn',
]) controls[id] = byId(id);
let activeTransfer = null;
let accountClosing = false;
let discoveryPending = false;
let manualConnectionPending = false;
let firewallPending = false;
let consoleScanVersion = 0;
let locatorPairingVersion = 0;
let selectedPairingVersion = 0;
let settingsSaveVersion = 0;
let firmwareLimitEditVersion = 0;
let locatedConsoles = [];
let selectedJbConsole = null;
let targetIdentityChanged = false;
let consoleLocator = null;
let currentPage = 'console';
let pendingImport = null;
let externalUploadImage = null;
let availableUsers = [];
let availableEntries = [];
let requestedDownloadIds = [];
let pendingUploadOptions = null;
let pendingUploadEntryIds = null;
let pendingUploadUserId = null;
let pendingExternalUpload = null;
let localPcUploadId = null;
let browserHost = null;
let pendingBrowserHost = null;
let dataTransferArmedHost = null;
let browseSessionActive = false;
let browseSessionVersion = 0;
let finishConfirmationPending = false;
let profileRoot = null;
const selectedEntryIds = new Set();
const downloadedEntryIds = new Set();
let cmpFilesRequest = 0;
const cmpLayout = window.CmpSkin.createController(document, {
  remoteSelection: () => [...selectedEntryIds],
  toggleRemote: (ids, checked) => {
    if (accountClosing) return;
    for (const id of ids) { if (checked) selectedEntryIds.add(Number(id)); else selectedEntryIds.delete(Number(id)); }
    updateSelection();
  },
  download: (id) => startDownload([Number(id)]),
  filterChanged: () => updateSelection(),
  localUser: (owner) => {
    const select = byId('localUserSelect');
    select.value = owner; select.dispatchEvent(new Event('change'));
  },
});

// Refresh cached tree filenames.
async function refreshCmpFiles() {
  if (!cmpLayout.active) return;
  const assets = options().assets;
  const request = ++cmpFilesRequest;
  try {
    const result = await window.saveTransfer.localSaves(assets);
    if (request === cmpFilesRequest && assets === options().assets) cmpLayout.setFiles(result.entries || []);
  } catch (error) { appendLog(uiText`[CMP] Could not load local filenames: ${error.message}`); }
}

// Function Upload Tree
const uploadTree = window.SaveTreeBridge.upload({
  layout: cmpLayout, select: controls.uploadSaveSelect, title: controls.externalTitleId,
  summary: byId('cmpUploadSummary'), getEntries: () => availableEntries,
});
function renderCmpUpload() { uploadTree.render(); }
controls.uploadSaveSelect.addEventListener('change', uploadTree.updateSelection);

// Mirror connection settings.
function updateCmpConnection() {
  const selected = controls.consoleSelect.selectedOptions[0];
  byId('cmpTarget').textContent = targetIdentityChanged ? uiText('Choose the OFW console again')
    : selected?.value ? selected.textContent : uiText('Locate a PS5 to begin');
  byId('cmpOracleHost').value = controls.oracleHost.value;
  byId('cmpWorker').checked = controls.useRemoteOracle.checked;
  byId('cmpOracleHost').disabled = accountClosing || controls.useRemoteOracle.checked || Boolean(activeTransfer);
  byId('cmpWorker').disabled = accountClosing;
  if (controls.transferConsoleHost) controls.transferConsoleHost.value = selected?.value || '';
  renderConsoleLocator();
}

// Function Skin Layout.
const skinAppearance = window.SkinAppearance.create(document, window.saveTransfer, (enabled) => {
  if (!cmpLayout.applyLayout(enabled)) return;
  if (!enabled) renderClassicSaveEntries();
  updateSelection(); updateCmpConnection();
  document.dispatchEvent(new Event('cmp-layout-changed'));
  refreshCmpFiles();
});
byId('cmpOracleHost').addEventListener('input', () => { selectedJbConsole = null; controls.oracleHost.value = byId('cmpOracleHost').value; renderConsoleLocator(); });
controls.oracleHost.addEventListener('input', () => { selectedJbConsole = null; byId('cmpOracleHost').value = controls.oracleHost.value; renderConsoleLocator(); });
byId('cmpWorker').addEventListener('change', () => { controls.useRemoteOracle.checked = byId('cmpWorker').checked; updateOracleMode(); });
byId('cmpConnectionSettings').addEventListener('click', () => showPage('settings'));
byId('cmpViewLog').addEventListener('click', () => byId('logDock').classList.toggle('expanded'));
byId('cmpCryptoNav').addEventListener('click', () => {
  document.querySelector('.nav-item[data-page="library"]').click();
  byId('decryptExternalBtn')?.focus();
});
controls.externalTitleId.addEventListener('input', renderCmpUpload);


// Function Confirmation
async function confirmAction(message) {
  if (typeof window.saveTransfer.confirm !== 'function') {
    status(uiText('Confirmation is unavailable. Restart GarlicTransfer and try again.'));
    return false;
  }
  try { return await window.saveTransfer.confirm(message) === true; }
  catch (error) {
    status(uiText`Could not show confirmation: ${error.message}`);
    return false;
  }
}

function options() {
  const clientHost = targetIdentityChanged ? '' : controls.consoleSelect.value;
  return {
    oracleHost: controls.oracleHost.value.trim(),
    oraclePort: 9022,
    useRemoteOracle: controls.useRemoteOracle.checked,
    serverUrl: controls.serverUrl.value.trim(),
    workerKey: controls.workerKey.value.trim(),
    workerKeyRevision: 2,
    installationId: controls.installationId.value,
    authorizedUser: controls.authorizedUser.value,
    clientHost,
    hostId: targetIdentityChanged ? '' : controls.consoleSelect.selectedOptions[0]?.dataset.hostId || '',
    profileId: targetIdentityChanged ? '' : controls.consoleSelect.selectedOptions[0]?.dataset.profileId || controls.consoleSelect.selectedOptions[0]?.dataset.hostId || '',
    uiLayout: controls.uiLayout.value,
    systemVersion: targetIdentityChanged ? '' : controls.consoleSelect.selectedOptions[0]?.dataset.firmware || '',
    interface: controls.interface.value.trim(),
    hardware: Number(controls.hardware.value || 0),
    output: controls.output.value.trim() || 'dt_downloads',
    profileRoot: profileRoot || controls.output.value.trim() || 'dt_downloads',
    metadata: controls.metadata.value.trim(),
    assets: controls.assets.value.trim() || controls.output.value.trim() || 'dt_downloads',
    userId: controls.userSelect.value,
    userName: controls.userSelect.selectedOptions[0]?.dataset.name || 'user',
    sourcePort: Number(controls.sourcePort.value || 1004),
    dataPort: Number(controls.dataPort.value || 1005),
    discoveryPort: Number(controls.discoveryPort.value || 1006),
    uploadDisplayName: controls.uploadDisplayName.value.trim() || 'GarlicTransfer',
    preferIpv6: controls.preferIpv6.checked,
    jbFirmwareLimit: controls.jbFirmwareLimit ? controls.jbFirmwareLimit.value.trim() : consoleInfo.DEFAULT_JB_FIRMWARE,
    skipLaunch: dataTransferArmedHost === clientHost && !controls.preferIpv6.checked,
    skipPower: dataTransferArmedHost === clientHost && !controls.preferIpv6.checked,
  };
}

function formatFirmware(value) {
  return consoleInfo.formatFirmware(value);
}

// Function Selected Console
function selectedConsoleInfo() {
  const option = controls.consoleSelect.selectedOptions[0];
  return consoleInfo.normalizeConsole({ host: option?.value, hostId: option?.dataset.hostId,
    profileId: option?.dataset.profileId, firmware: option?.dataset.firmware, type: 'PS5' });
}

// Function Console Identity
function consoleIdentity(console) {
  return console?.hostId || console?.host || '';
}

// Function Firmware Identity
function consoleFirmware(console) {
  return String(console?.firmware ?? '').toUpperCase();
}

// Function Session Reset
function resetConsoleSession(console) {
  dataTransferArmedHost = null;
  const pending = consoleInfo.normalizeConsole({ ...pendingUploadOptions,
    host: pendingUploadOptions?.clientHost, type: 'PS5' });
  if (pending?.host === console.host && consoleIdentity(pending) === consoleIdentity(console)) {
    Object.assign(pendingUploadOptions, { systemVersion: console.firmware || '',
      skipLaunch: false, skipPower: false });
  }
}

// Function Selected Pairing
function selectedLocatorConsole() {
  const current = selectedConsoleInfo();
  return locatedConsoles.find(console => console.host === current?.host
    && consoleIdentity(console) === consoleIdentity(current) && String(console.firmware || '') === String(current.firmware || ''));
}

// Function Console Lock
function consoleSelectionLocked() {
  return accountClosing || Boolean(activeTransfer) || browseSessionActive;
}

// Function Console List
function renderConsoleLocator() {
  const limit = consoleInfo.normalizeFirmwareLimit(controls.jbFirmwareLimit?.value ?? consoleInfo.DEFAULT_JB_FIRMWARE);
  if (selectedJbConsole && limit
    && controls.oracleHost.value.trim() === selectedJbConsole.host
    && (selectedJbConsole.type !== 'PS5' || !consoleInfo.firmwareEligible(selectedJbConsole.firmware, limit))) {
    selectedJbConsole = null;
    controls.oracleHost.value = ''; byId('cmpOracleHost').value = '';
    consoleLocatorStatus(uiText('The selected JB helper no longer meets the maximum JB firmware. Choose another helper.'));
  }
  const target = selectedConsoleInfo();
  const discoveredTarget = locatedConsoles.find(console => console.host === target?.host);
  const changedIdentity = discoveredTarget && consoleIdentity(discoveredTarget) !== consoleIdentity(target);
  consoleLocator?.render(locatedConsoles, {
    jbHost: controls.oracleHost.value.trim(), targetHost: changedIdentity ? '' : controls.consoleSelect.value,
    firmwareLimit: limit,
  });
  updateConsoleLocatorBusy();
}

// Function Locator Controls
function updateConsoleLocatorBusy() {
  consoleLocator?.setBusy(consoleSelectionLocked() || discoveryPending || manualConnectionPending);
  controls.downloadBtn.disabled = accountClosing || Boolean(activeTransfer) || targetIdentityChanged;
  controls.uploadBtn.disabled = accountClosing || Boolean(activeTransfer) || targetIdentityChanged;
  controls.confirmUploadBtn.disabled = accountClosing || Boolean(activeTransfer) || targetIdentityChanged;
}

// Function Locator Status
function consoleLocatorStatus(message) {
  if (byId('consoleLocatorStatus')) byId('consoleLocatorStatus').textContent = message;
  status(uiText(message));
}

// Function Console Direction
function updateConsoleDirection() {
  const label = currentPage === 'download' ? uiText('Source PS5') : currentPage === 'upload' ? uiText('Receiving PS5') : uiText('Source/Receiving PS5');
  if (controls.transferConsoleLabel) controls.transferConsoleLabel.textContent = label;
  if (byId('cmpTargetLabel')) byId('cmpTargetLabel').textContent = label;
}

// Function Console Option
function makeConsoleOption(console) {
  const option = document.createElement('option');
  option.value = console.host;
  option.dataset.hostId = console.hostId || '';
  option.dataset.profileId = console.profileId || console.hostId || '';
  option.dataset.firmware = console.firmware || '';
  option.textContent = `${console.name || 'PS5'} — ${console.host} (${formatFirmware(console.firmware)})`;
  return option;
}

// Function Transfer Console
function selectTransferConsole(console) {
  if (consoleSelectionLocked()) return;
  if (console.type !== 'PS5') return;
  const previous = controls.consoleSelect.selectedOptions[0];
  const previousConsole = selectedConsoleInfo();
  const changed = previous?.value !== console.host || consoleIdentity(previousConsole) !== consoleIdentity(console);
  if (consoleFirmware(previousConsole) !== consoleFirmware(console)) resetConsoleSession(console);
  let option = [...controls.consoleSelect.options].find(candidate => candidate.value === console.host);
  if (!option) { option = makeConsoleOption(console); controls.consoleSelect.appendChild(option); }
  else {
    const replacement = makeConsoleOption(console);
    option.dataset.hostId = replacement.dataset.hostId;
    option.dataset.profileId = changed ? replacement.dataset.profileId
      : previous.dataset.profileId || previous.dataset.hostId || replacement.dataset.profileId;
    option.dataset.firmware = replacement.dataset.firmware;
    option.textContent = replacement.textContent;
  }
  controls.consoleSelect.value = console.host;
  targetIdentityChanged = false;
  if (changed) { dataTransferArmedHost = null; resetUploadUI(); applyConsoleProfile(); }
  else { refreshPairingStatus(); updateSidebarConsole(); updateCmpConnection(); }
}

// Function Console Discovery
function showLocatedConsoles(consoles) {
  const selected = controls.consoleSelect.selectedOptions[0]?.cloneNode(true);
  const previous = selectedConsoleInfo();
  const host = controls.consoleSelect.value;
  locatedConsoles = consoles.map(console => ({ ...console, pairing: 'checking' }));
  const foundJb = locatedConsoles.find(console => console.host === selectedJbConsole?.host);
  if (foundJb) selectedJbConsole = foundJb;
  const jbHost = controls.oracleHost.value.trim();
  let identityChanged = false;
  const placeholder = document.createElement('option');
  placeholder.value = ''; placeholder.textContent = uiText('Select an OFW / transfer PS5');
  controls.consoleSelect.replaceChildren(placeholder);
  const seen = new Set();
  for (const console of consoles) {
    if (!console.host || seen.has(console.host)) continue;
    seen.add(console.host);
    if (console.host === host && selected && consoleFirmware(console) !== consoleFirmware(previous)) {
      resetConsoleSession(console);
    }
    if (console.host === host && selected
      && consoleIdentity(console) !== consoleIdentity(previous)) {
      controls.consoleSelect.appendChild(selected); identityChanged = true;
    } else {
      const option = makeConsoleOption(console);
      if (console.host === host && selected) option.dataset.profileId = selected.dataset.profileId || selected.dataset.hostId;
      controls.consoleSelect.appendChild(option);
    }
  }
  if (host && !seen.has(host) && selected) controls.consoleSelect.appendChild(selected);
  controls.consoleSelect.value = host;
  targetIdentityChanged = identityChanged || (targetIdentityChanged && !seen.has(host));
  refreshPairingStatus(); updateSidebarConsole(); updateCmpConnection();
  void refreshLocatorPairing();
  return [identityChanged ? 'The selected IP now reports a different console. Choose its OFW option to switch profiles.' : '',
    jbHost && !controls.oracleHost.value.trim() ? 'The JB helper no longer meets the maximum firmware; choose another helper.' : '']
    .filter(Boolean).join(' ');
}

// Function Locator Pairing
async function refreshLocatorPairing() {
  const version = ++locatorPairingVersion;
  const snapshot = locatedConsoles;
  const eligible = snapshot.filter(console => console.type === 'PS5' && console.hostId && console.firmware && window.saveTransfer.pairingAvailable);
  const eligibleSet = new Set(eligible);
  const identities = eligible.map(console => ({ hostId: console.hostId, systemVersion: console.firmware }));
  for (const console of snapshot) {
    console.pairing = eligibleSet.has(console) ? 'checking' : 'unknown';
    consoleLocator?.updatePairing(console.host, console.pairing);
  }
  if (selectedLocatorConsole()) refreshPairingStatus();
  let results;
  try {
    if (typeof window.saveTransfer.pairingInfos === 'function') results = identities.length ? await window.saveTransfer.pairingInfos(identities) : [];
    else results = await Promise.all(identities.map(async identity => {
      try {
        return typeof window.saveTransfer.pairingInfo === 'function'
          ? await window.saveTransfer.pairingInfo(identity)
          : { status: await window.saveTransfer.pairingStatus(identity) ? 'paired' : 'unpaired' };
      } catch { return { status: 'unknown' }; }
    }));
  } catch { results = []; }
  if (version !== locatorPairingVersion || locatedConsoles !== snapshot) return;
  for (const [index, console] of eligible.entries()) {
    const state = results?.[index]?.status;
    console.pairing = ['paired', 'previous', 'unpaired', 'unknown'].includes(state) ? state : 'unknown';
    consoleLocator?.updatePairing(console.host, console.pairing);
  }
  if (selectedLocatorConsole()) refreshPairingStatus();
}

// Function Console Roles
consoleLocator = controls.consoleLocatorRows && window.ConsoleLocator?.create(document, controls.consoleLocatorRows, {
  isBusy: consoleSelectionLocked,
  onSelect: (role, console) => {
    if (consoleSelectionLocked() || discoveryPending || manualConnectionPending) return;
    if (role === 'jb') {
      if (!consoleInfo.firmwareEligible(console.firmware, options().jbFirmwareLimit)) return;
      selectedJbConsole = console;
      controls.oracleHost.value = console.host;
      byId('cmpOracleHost').value = console.host;
      renderConsoleLocator();
    } else if (role === 'ofw') selectTransferConsole(console);
  },
});
controls.jbFirmwareLimit?.addEventListener('input', () => {
  firmwareLimitEditVersion++;
  renderConsoleLocator();
});

// Build profile path.
function profilePath(root, child) {
  return folderPaths.joinProfilePath(root, child);
}

function updateSidebarConsole() {
  const selected = controls.consoleSelect.selectedOptions[0];
  const connected = Boolean(selected?.value) && !targetIdentityChanged;
  const badge = byId('sidebarConsole');
  if (badge) {
    badge.classList.toggle('connected', connected);
    byId('sidebarConsoleName').textContent = connected
      ? selected.textContent.split(' — ')[0].trim()
      : targetIdentityChanged ? uiText('Choose OFW again') : uiText('Not connected');
    byId('sidebarConsoleDetail').textContent = connected
      ? selected.value
      : targetIdentityChanged ? uiText('Console identity changed') : uiText('Discover a PS5 to begin');
  }
}

function applyConsoleProfile() {
  const root = profileRoot || 'dt_downloads';
  const selected = controls.consoleSelect.selectedOptions[0];
  const identity = selected?.dataset.profileId || selected?.dataset.hostId || selected?.value || 'default';
  const profile = identity.replace(/[^A-Za-z0-9_.-]/g, '_');
  cmpFilesRequest++; cmpLayout.reset();
  controls.output.value = profilePath(root, profile);
  controls.assets.value = controls.output.value;
  controls.metadata.value = '';
  refreshPairingStatus();
  updateSidebarConsole();
  updateCmpConnection();
}

async function refreshPairingStatus() {
  const version = ++selectedPairingVersion;
  const selected = controls.consoleSelect.selectedOptions[0];
  const identity = { hostId: selected?.dataset.hostId || '', systemVersion: selected?.dataset.firmware || '' };
  const supported = window.saveTransfer.pairingAvailable && Boolean(selected?.value);
  controls.pairingState.classList.remove('paired');
  controls.pairBtn.disabled = accountClosing || !supported || Boolean(activeTransfer) || browseSessionActive || targetIdentityChanged;
  if (targetIdentityChanged) {
    controls.pairingState.textContent = uiText('Choose the OFW console again to confirm its identity.');
    return;
  }
  controls.pairingState.textContent = supported
    ? uiText('Checking whether this PS5 has been paired…')
    : uiText('Discover a PS5 to check pairing.');
  if (!supported) return;
  const row = selectedLocatorConsole();
  if (row) { showPairingState(row.pairing); return; }
  try {
    const paired = await window.saveTransfer.pairingStatus(identity);
    if (version !== selectedPairingVersion || targetIdentityChanged || controls.consoleSelect.selectedOptions[0] !== selected) return;
    showPairingState(paired ? 'paired' : 'unpaired');
  } catch (error) {
    if (version === selectedPairingVersion && !targetIdentityChanged && controls.consoleSelect.selectedOptions[0] === selected) {
      controls.pairingState.textContent = uiText`Could not check pairing: ${error.message}`;
    }
  }
}

// Function Pairing State
function showPairingState(state) {
  controls.pairingState.classList.toggle('paired', state === 'paired');
  controls.pairingState.textContent = state === 'paired' ? uiText('Paired!')
    : state === 'previous' ? uiText('Paired on another firmware. Pair this PS5 again.')
    : state === 'unpaired' ? uiText('Not paired yet. Pair this PS5 to continue.')
    : state === 'checking' ? uiText('Checking whether this PS5 has been paired…')
    : uiText('Pairing status unavailable. You can pair this PS5 to continue.');
}

function saveEntriesMatchingSearch() {
  return availableEntries.filter((entry) => entry.kind === 'save' && window.DownloadSearch.matches(entry, controls.saveSearch.value, availableUsers));
}

function updateSelection() {
  const count = selectedEntryIds.size;
  const visible = cmpLayout.active ? cmpLayout.visibleRemoteEntries() : saveEntriesMatchingSearch();
  const visibleSelected = visible.filter((entry) => selectedEntryIds.has(entry.id)).length;
  controls.entryCount.textContent = cmpLayout.active ? uiText`${count} entries selected · ${visible.length} visible` : count
    ? uiText`${count} of ${availableEntries.length} save(s) selected`
    : uiText`${availableEntries.length} save(s); none selected`;
  controls.selectAllEntries.checked = visibleSelected > 0 && visibleSelected === visible.length;
  controls.selectAllEntries.indeterminate = visibleSelected > 0 && visibleSelected < visible.length;
  controls.selectAllEntries.disabled = accountClosing || Boolean(activeTransfer) || !visible.length;
  controls.downloadSelectedBtn.disabled = accountClosing || Boolean(activeTransfer) || count === 0;
  controls.finishBtn.hidden = !browseSessionActive || Boolean(activeTransfer);
  controls.finishBtn.disabled = accountClosing || Boolean(activeTransfer) || finishConfirmationPending;
  for (const checkbox of document.querySelectorAll('.entry-check')) checkbox.disabled = accountClosing || Boolean(activeTransfer);
  for (const button of document.querySelectorAll('.row-download')) button.disabled = accountClosing || Boolean(activeTransfer);
  cmpLayout.syncSelection();
}

// Function App Closing
function setAccountClosing(value) {
  accountClosing = Boolean(value);
  busy(Boolean(activeTransfer), { keepDialogs: true });
}

function busy(value, { keepDialogs = false } = {}) {
  const disabled = Boolean(value) || accountClosing;
  if (disabled) consoleScanVersion++;
  cmpLayout.setBusy(disabled);
  updateCmpConnection();
  controls.downloadBtn.disabled = disabled || targetIdentityChanged;
  controls.uploadBtn.disabled = disabled || targetIdentityChanged;
  controls.addExternalSaveBtn.disabled = disabled;
  controls.addExternalFolderBtn.disabled = disabled;
  controls.addExternalZipBtn.disabled = disabled;
  controls.exportZipBtn.disabled = disabled;
  controls.externalTitleId.disabled = disabled;
  controls.browseLocalBtn.disabled = disabled;
  controls.confirmImportBtn.disabled = disabled;
  controls.confirmUploadBtn.disabled = disabled || targetIdentityChanged;
  controls.userSelect.disabled = disabled;
  controls.uploadSaveSelect.disabled = disabled;
  controls.powerBtn.disabled = accountClosing;
  for (const button of document.querySelectorAll('.local-action')) button.disabled = disabled;
  controls.pairBtn.disabled = !window.saveTransfer.pairingAvailable || !controls.consoleSelect.value || disabled || browseSessionActive || targetIdentityChanged;
  controls.cancelBtn.disabled = !value;
  controls.consoleSelect.disabled = disabled || browseSessionActive;
  controls.discoverBtn.disabled = disabled || browseSessionActive || discoveryPending;
  controls.manualConnectBtn.disabled = disabled || browseSessionActive || manualConnectionPending;
  if (controls.jbFirmwareLimit) controls.jbFirmwareLimit.disabled = disabled || browseSessionActive;
  controls.settingsSave.disabled = accountClosing;
  controls.firewallHelperBtn.disabled = accountClosing || firewallPending;
  for (const button of document.querySelectorAll('[data-action="output"], [data-action="metadata"], [data-action="assets"]')) button.disabled = accountClosing;
  if (!value && !keepDialogs) {
    hidePowerModal();
    hideUploadModal();
  }
  updateSelection();
  document.dispatchEvent(new Event('transfer-state-changed'));
}

function status(message) {
  controls.status.textContent = message;
}

function appendLog(message) {
  controls.log.textContent += `${message}\n`;
  controls.log.scrollTop = controls.log.scrollHeight;
}

function showPowerModal() {
  if (!controls.powerModal.open) controls.powerModal.showModal();
}

function hidePowerModal() {
  if (controls.powerModal.open) controls.powerModal.close();
}

function showPairingModal() {
  if (!controls.pairingModal.open) controls.pairingModal.showModal();
}

function hidePairingModal() {
  if (controls.pairingModal.open) controls.pairingModal.close();
}

function showUploadModal() {
  if (!controls.uploadModal.open) controls.uploadModal.showModal();
}

function hideUploadModal() {
  if (controls.uploadModal.open) controls.uploadModal.close();
}

function resetUploadUI() {
  releasePcUpload();
  pendingUploadOptions = null;
  pendingUploadEntryIds = null;
  pendingUploadUserId = null;
  pendingExternalUpload = null;
  externalUploadImage = null;
  controls.externalUploadControls.hidden = true;
  dataTransferArmedHost = null;
  hideUploadModal();
  controls.confirmUploadBtn.hidden = true;
  controls.userSelectLabel.hidden = true;
  controls.uploadSaveSelectLabel.hidden = true;
}

// Function Upload Release
function releasePcUpload(stageId = localPcUploadId) {
  if (stageId === localPcUploadId) localPcUploadId = null;
  if (!stageId) return;
  return Promise.resolve().then(() => window.saveTransfer.releaseLocalPcUpload(stageId))
    .catch(error => appendLog(uiText`[local] Could not remove upload staging: ${error.message}`));
}

function hideImportModal() {
  if (controls.importModal.open) controls.importModal.close();
  pendingImport = null;
}

function localEntryTitle(entry) {
  return entry.name || availableEntries.find((candidate) => candidate.id === entry.id)?.name || entry.title;
}

function renderLocalEntries(entries) {
  controls.localEntries.replaceChildren();
  if (!entries.length) {
    controls.localEntries.innerHTML = '<tr><td colspan="5" class="empty">No downloaded saves were found.</td></tr>';
    return;
  }
  for (const entry of entries) {
    for (const file of entry.files) {
      const row = document.createElement('tr');
      const title = document.createElement('td');
      title.textContent = uiText`${localEntryTitle(entry)} · entry ${entry.id}`;
      const owner = document.createElement('td');
      owner.textContent = entry.owner;
      const name = document.createElement('td');
      name.textContent = file.file;
      const size = document.createElement('td');
      size.textContent = (file.size / 0x100000).toFixed(1);
      const actions = document.createElement('td');
      const exportButton = document.createElement('button');
      exportButton.type = 'button';
      exportButton.className = 'local-action';
      exportButton.textContent = uiText('Export');
      exportButton.addEventListener('click', () => exportLocalSave(entry, file));
      const importButton = document.createElement('button');
      importButton.type = 'button';
      importButton.className = 'local-action';
      importButton.textContent = uiText('Import');
      importButton.addEventListener('click', () => chooseImportReplacement(entry, file));
      actions.append(exportButton, importButton);
      row.append(title, owner, name, size, actions);
      controls.localEntries.appendChild(row);
    }
  }
}

async function refreshLocalSaves() {
  const result = await window.saveTransfer.localSaves(options().assets);
  controls.localBrowser.hidden = false;
  renderLocalEntries(result.entries || []);
  return {
    count: (result.entries || []).reduce((count, entry) => count + entry.files.length, 0),
    warnings: result.warnings || [],
  };
}

async function browseLocalSaves() {
  if (accountClosing) return;
  if (!options().clientHost) {
    status(uiText('Discover your console first.'));
    return;
  }
  if (activeTransfer || browseSessionActive) {
    status(uiText('Stop the active transfer before changing local saves.'));
    return;
  }
  activeTransfer = 'local';
  busy(true);
  try {
    const { count, warnings } = await refreshLocalSaves();
    const warning = warnings.length ? uiText` Skipped ${warnings.length} invalid manifest(s): ${warnings.join('; ')}` : '';
    status(uiText`Found ${count} downloaded file(s). Export a copy or import a replacement.${warning}`);
  } catch (error) {
    status(uiText`Could not browse local saves: ${error.message}`);
  } finally {
    activeTransfer = null;
    busy(false);
  }
}

async function exportLocalSave(entry, file) {
  if (accountClosing || activeTransfer || browseSessionActive) return;
  activeTransfer = 'local';
  busy(true);
  try {
    const result = await window.saveTransfer.exportLocalSave({
      assets: options().assets,
      ...(entry.localSource === 'pc' ? { localSource: 'pc' } : {}),
      entryId: entry.id,
      filename: file.file,
    });
    if (result) status(uiText`Exported ${file.file} to ${result.destination}`);
  } catch (error) {
    status(uiText`Could not export ${file.file}: ${error.message}`);
  } finally {
    activeTransfer = null;
    busy(false);
  }
}

async function chooseImportReplacement(entry, file) {
  if (accountClosing || activeTransfer || browseSessionActive) return;
  const source = await window.saveTransfer.chooseExternalSave();
  if (accountClosing || !source) return;
  pendingImport = { assets: options().assets, ...(entry.localSource === 'pc' ? { localSource: 'pc' } : {}), entryId: entry.id, filename: file.file, source };
  controls.importWarning.textContent = entry.localSource === 'pc'
    ? uiText`This will replace ${file.file}. A backup will be kept before replacement. Continue?`
    : uiText`This will replace ${file.file}. Make sure you have backed it up. Are you sure you want to do this?`;
  if (!controls.importModal.open) controls.importModal.showModal();
}

controls.confirmImportBtn.addEventListener('click', async () => {
  if (accountClosing || !pendingImport) return;
  const replacement = pendingImport;
  pendingImport = null;
  if (controls.importModal.open) controls.importModal.close();
  activeTransfer = 'local';
  busy(true);
  try {
    await window.saveTransfer.importLocalSave(replacement);
    if (replacement.localSource !== 'pc') await refreshLocalSaves();
    status(replacement.localSource === 'pc' ? uiText`Replaced ${replacement.filename}. A backup is available.` : uiText`Replaced ${replacement.filename} and refreshed its upload metadata.`);
    document.dispatchEvent(new CustomEvent('local-save-replaced', { detail: replacement }));
  } catch (error) {
    status(uiText`Could not replace ${replacement.filename}: ${error.message}`);
  } finally {
    activeTransfer = null;
    busy(false);
  }
});
controls.cancelImportBtn.addEventListener('click', hideImportModal);

function renderEntryTable(container, entries, emptyText) {
  container.replaceChildren();
  if (!entries.length) {
    container.innerHTML = `<tr><td colspan="5" class="empty">${emptyText}</td></tr>`;
    return;
  }
  const userNames = new Map(availableUsers.map((user) => [user.id.toLowerCase(), user.name]));
  for (const entry of entries) {
    const row = document.createElement('tr');

    const selectCell = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'entry-check';
    checkbox.checked = selectedEntryIds.has(entry.id);
    checkbox.setAttribute('aria-label', uiText`Select ${entry.name || entry.title}`);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedEntryIds.add(entry.id);
      else selectedEntryIds.delete(entry.id);
      updateSelection();
    });
    selectCell.appendChild(checkbox);
    row.appendChild(selectCell);

    const titleCell = document.createElement('td');
    const name = document.createElement('span');
    name.className = 'title-name';
    name.textContent = entry.name || uiText('Unknown title');
    const titleId = document.createElement('span');
    titleId.className = 'title-id';
    titleId.textContent = uiText`${entry.title} · ${entry.kind || 'save'} · entry ${entry.id}`;
    titleCell.append(name, titleId);
    row.appendChild(titleCell);

    const ownerCell = document.createElement('td');
    const ownerName = userNames.get(String(entry.owner).toLowerCase());
    ownerCell.textContent = ownerName ? `${ownerName} (${entry.owner})` : entry.owner;
    row.appendChild(ownerCell);

    const sizeCell = document.createElement('td');
    sizeCell.textContent = (entry.size / 0x100000).toFixed(1);
    row.appendChild(sizeCell);

    const actionCell = document.createElement('td');
    const download = document.createElement('button');
    download.type = 'button';
    download.className = 'row-download';
    download.textContent = downloadedEntryIds.has(entry.id) ? uiText('Download again') : uiText('Download');
    download.addEventListener('click', () => startDownload([entry.id]));
    actionCell.appendChild(download);
    if (downloadedEntryIds.has(entry.id)) {
      const downloaded = document.createElement('span');
      downloaded.className = 'downloaded';
      downloaded.textContent = uiText('Downloaded');
      actionCell.appendChild(downloaded);
    }
    row.appendChild(actionCell);
    container.appendChild(row);
  }
}

// Function Classic Save List
function renderClassicSaveEntries() {
  renderEntryTable(controls.entries, saveEntriesMatchingSearch(), 'No save entries match your search.');
}

// Function Inventory List
function renderEntries() {
  cmpLayout.setRemote(saveEntriesMatchingSearch(), availableUsers);
  const others = availableEntries.filter((entry) => entry.kind !== 'save');
  if (!cmpLayout.active) renderClassicSaveEntries();
  byId('otherBlock').hidden = !others.length;
  for (const [kind, block, control] of [
    ['app', 'appBlock', controls.appEntries],
    ['profile', 'profileBlock', controls.profileEntries],
    ['media', 'mediaBlock', controls.mediaEntries],
    ['other', 'miscBlock', controls.otherEntries],
  ]) {
    const entries = others.filter((entry) => entry.kind === kind);
    byId(block).hidden = !entries.length;
    renderEntryTable(control, entries, `No ${kind} entries were found.`);
  }
  updateSelection();
}
controls.saveSearch.addEventListener('input', renderEntries);

async function browseSaves(forUpload = false) {
  if (accountClosing) return;
  if (!forUpload && browseSessionActive) {
    status(uiText('The download session is already open. Select saves from the browser.'));
    return;
  }
  const current = options();
  if (!current.clientHost) {
    status(uiText('Discover and select a console first.'));
    return;
  }
  pendingBrowserHost = current.clientHost;
  activeTransfer = forUpload ? 'upload-metadata' : 'browse';
  busy(true);
  status(uiText('Step 1/3: downloading the console save list.'));
  if (!forUpload) {
    byId('saveBrowser').hidden = true;
    if (!cmpLayout.active) controls.entries.innerHTML = '<tr><td colspan="5" class="empty">Downloading metadata…</td></tr>';
  }
  try {
    await window.saveTransfer.download({
      ...current,
      metadataOnly: forUpload,
      waitForSelection: !forUpload,
      entryIds: [],
    });
  } catch (error) {
    status(uiText`Could not browse saves: ${error.message}`);
    activeTransfer = null;
    busy(false);
  }
}

async function startDownload(entryIds) {
  if (accountClosing) return;
  if (!entryIds.length) {
    status(uiText('Select at least one save to download.'));
    return;
  }
  if (!browseSessionActive) {
    status(uiText('The download session is not open. Browse the console again first.'));
    return;
  }
  requestedDownloadIds = entryIds;
  activeTransfer = 'download';
  busy(true);
  status(uiText`Downloading ${entryIds.length} selected save(s) on the open Data Transfer session.`);
  try {
    await window.saveTransfer.select(entryIds);
  } catch (error) {
    status(uiText`Could not start download: ${error.message}`);
    activeTransfer = null;
    browseSessionActive = false;
    browseSessionVersion++;
    busy(false);
  }
}

async function startUploadSource() {
  if (accountClosing) return;
  if (targetIdentityChanged) { status(uiText('Choose the OFW console again before starting a transfer.')); return; }
  const selectedUser = controls.userSelect.selectedOptions[0];
  const externalSelected = [...controls.uploadSaveSelect.selectedOptions].some((option) => option.value === 'external');
  const entryIds = [...controls.uploadSaveSelect.selectedOptions].filter((option) => option.value !== 'external').map((option) => Number(option.value));
  const titleId = controls.externalTitleId.value.trim().toUpperCase();
  if (externalSelected && (entryIds.length || !externalUploadImage || !/^PPSA[0-9]{5}$/.test(titleId))) {
    status(uiText('Select the external save by itself and enter its PPSA title ID (for example PPSA12345).'));
    return;
  }
  if (!selectedUser || (!entryIds.length && !externalSelected)) {
    status(uiText('Select one user and at least one downloaded entry before continuing.'));
    return;
  }
  const uploadKinds = new Set(entryIds.map((id) => {
    const entry = availableEntries.find((candidate) => candidate.id === id);
    return entry?.kind === 'save' ? 'save' : 'other';
  }));
  if (!externalSelected && uploadKinds.size !== 1) {
    status(uiText('Upload saves and other content in separate batches.'));
    return;
  }
  const current = {
    ...(pendingUploadOptions || options()),
    userId: selectedUser.value,
    userName: selectedUser.dataset.name || 'user',
    entryIds,
    uploadKind: externalSelected ? 'external' : uploadKinds.values().next().value,
    externalImage: externalSelected ? externalUploadImage : undefined,
    titleId: externalSelected ? titleId : undefined,
    ...(externalSelected && localPcUploadId ? { localPcUploadId } : {}),
  };
  if (!externalSelected) releasePcUpload();
  activeTransfer = 'upload';
  showUploadModal();
  busy(true);
  controls.confirmUploadBtn.hidden = true;
  controls.userSelectLabel.hidden = true;
  controls.uploadSaveSelectLabel.hidden = true;
  status(uiText`Step 1/3: building metadata for ${externalSelected ? 1 : entryIds.length} entries.`);
  try {
    await window.saveTransfer.upload(current);
  } catch (error) {
    status(uiText`Could not start upload: ${error.message}`);
    activeTransfer = null;
    resetUploadUI();
    busy(false);
  }
}

function showUploadConfirmation() {
  cmpLayout.setRemote(availableEntries.filter((entry) => entry.kind === 'save'), availableUsers);
  externalUploadImage = null;
  controls.externalTitleId.value = '';
  controls.externalUploadControls.hidden = !availableUsers.length;
  controls.userSelect.replaceChildren();
  for (const user of availableUsers) {
    const option = document.createElement('option');
    option.value = user.id;
    option.dataset.name = user.name;
    option.textContent = `${user.name} (${user.id})`;
    controls.userSelect.appendChild(option);
  }
  if (pendingUploadUserId) {
    const owner = pendingUploadUserId.toLowerCase();
    const matchingUser = availableUsers.find((user) => String(user.id).toLowerCase() === owner);
    if (matchingUser) controls.userSelect.value = matchingUser.id;
    pendingUploadUserId = null;
  }
  controls.uploadSaveSelect.replaceChildren();
  const downloadedEntries = availableEntries.filter((entry) => entry.downloaded);
  for (const entry of downloadedEntries) {
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = uiText`${entry.name || entry.title} (${entry.title}) — ${entry.owner} — entry ${entry.id}`;
    controls.uploadSaveSelect.appendChild(option);
  }
  if (pendingUploadEntryIds) {
    for (const option of controls.uploadSaveSelect.options) {
      option.selected = pendingUploadEntryIds.includes(Number(option.value));
    }
    pendingUploadEntryIds = null;
  }
  if (pendingExternalUpload && availableUsers.length) {
    externalUploadImage = pendingExternalUpload.folder;
    controls.externalTitleId.value = pendingExternalUpload.titleId;
    const option = document.createElement('option'); option.value = 'external';
    option.textContent = uiText`Local PC: ${pendingExternalUpload.titleId}`;
    controls.uploadSaveSelect.appendChild(option);
    for (const item of controls.uploadSaveSelect.options) item.selected = item === option;
    pendingExternalUpload = null;
  }
  if (!availableUsers.length) {
    resetUploadUI();
    status(uiText('No downloaded files are available. Download content before uploading it.'));
    return;
  }
  controls.userSelectLabel.hidden = false;
  controls.uploadSaveSelectLabel.hidden = false;
  controls.confirmUploadBtn.hidden = false;
  renderCmpUpload();
  status(uiText('Select downloaded entries, or add an external encrypted save.'));
}

// Prepare upload selection.
async function startUpload({ entryIds = null, userId = null, external = null } = {}) {
  if (accountClosing) {
    if (external?.stageId) await releasePcUpload(external.stageId);
    return;
  }
  releasePcUpload();
  localPcUploadId = external?.stageId || null;
  pendingUploadEntryIds = entryIds;
  pendingUploadUserId = userId;
  pendingExternalUpload = external;
  const current = options();
  if (!current.clientHost) {
    resetUploadUI();
    status(uiText('Discover and select a console first.'));
    return;
  }
  byId('uploadDestination').hidden = false;
  if (browseSessionActive) {
    await window.saveTransfer.cancel();
    browseSessionActive = false;
    browseSessionVersion++;
    dataTransferArmedHost = null;
  }
  if (accountClosing) { await releasePcUpload(); return; }
  current.entryIds = [];
  pendingUploadOptions = current;
  const hasExplicitMetadata = Boolean(current.metadata);
  const previousMetadata = current.metadata || folderPaths.metadataPath(current.output, 'metadata.db');
  try {
    const inventory = await window.saveTransfer.inventory(previousMetadata);
    if (accountClosing) { await releasePcUpload(); return; }
    availableUsers = inventory.users;
    availableEntries = inventory.entries;
    if (!availableUsers.length) throw new Error('the metadata contains no users');
    current.metadata = previousMetadata;
    controls.metadata.value = previousMetadata;
    showUploadConfirmation();
    return;
  } catch (error) {
    if (accountClosing) { await releasePcUpload(); return; }
    if (hasExplicitMetadata) {
      resetUploadUI();
      status(uiText`Could not read metadata inventory: ${error.message}`);
      return;
    }
    appendLog(uiText`[metadata] no usable previous metadata at ${previousMetadata}; fetching from console`);
  }
  pendingBrowserHost = current.clientHost;
  activeTransfer = 'upload-metadata';
  busy(true);
  status(uiText('Step 1/3: fetching the client user and save list before upload.'));
  try {
    await window.saveTransfer.download({ ...current, metadataOnly: true, entryIds: [] });
  } catch (error) {
    status(uiText`Could not fetch metadata: ${error.message}`);
    activeTransfer = null;
    resetUploadUI();
    busy(false);
  }
}

function updateOracleMode() {
  updateCmpConnection();
  const remote = controls.useRemoteOracle.checked;
  controls.oracleHost.disabled = remote;
  controls.serverUrl.disabled = !remote;
  controls.workerKey.disabled = !remote;
}
controls.useRemoteOracle.addEventListener('change', updateOracleMode);
updateOracleMode();

function showPage(name) {
  currentPage = name;
  updateConsoleDirection();
  cmpLayout.setPage(name);
  for (const el of document.querySelectorAll('.page')) el.hidden = true;
  const target = byId(`${name}Page`);
  if (target) target.hidden = false;
  for (const btn of document.querySelectorAll('.nav-item')) {
    btn.classList.toggle('active', btn.dataset.page === name);
  }
}
for (const btn of document.querySelectorAll('.nav-item')) {
  btn.addEventListener('click', () => showPage(btn.dataset.page));
}
if (new URLSearchParams(location.search).get('page') === 'settings') showPage('settings');

byId('logToggle').addEventListener('click', () => {
  byId('logDock').classList.toggle('expanded');
});

controls.discoverBtn.addEventListener('click', async () => {
  if (consoleSelectionLocked() || discoveryPending) return;
  const request = ++consoleScanVersion;
  discoveryPending = true;
  controls.discoverBtn.disabled = true;
  renderConsoleLocator();
  consoleLocatorStatus(uiText('Discovering consoles with SRCH…'));
  try {
    const consoles = consoleInfo.normalizeConsoles(await window.saveTransfer.discover(options()));
    if (request !== consoleScanVersion || consoleSelectionLocked()) return;
    const notice = showLocatedConsoles(consoles);
    consoleLocatorStatus((consoles.length
      ? uiText`Found ${consoles.length} console(s). Choose JB for a helper or OFW for transfers.`
      : uiText('No consoles found. Check the network and firewall.')) + (notice ? ` ${notice}` : ''));
  } catch (error) {
    if (request === consoleScanVersion && !consoleSelectionLocked()) consoleLocatorStatus(uiText`Discovery failed: ${error.message}`);
  } finally {
    discoveryPending = false;
    controls.discoverBtn.disabled = accountClosing || Boolean(activeTransfer) || browseSessionActive;
    updateConsoleLocatorBusy();
  }
});

controls.manualConnectBtn.addEventListener('click', async () => {
  if (consoleSelectionLocked() || manualConnectionPending) return;
  const host = consoleInfo.canonicalIPv4(controls.manualHost.value.trim());
  if (!host) {
    consoleLocatorStatus(uiText('Enter a valid PS5 IPv4 address.'));
    return;
  }
  const request = ++consoleScanVersion;
  manualConnectionPending = true;
  controls.manualConnectBtn.disabled = true;
  renderConsoleLocator();
  consoleLocatorStatus(uiText`Contacting PS5 at ${host}…`);
  try {
    const consoles = consoleInfo.normalizeConsoles(await window.saveTransfer.discover({ ...options(), targetHost: host }));
    if (request !== consoleScanVersion || consoleSelectionLocked()) return;
    const selected = consoles.find(console => console.host === host && console.type === 'PS5');
    if (!selected) {
      consoleLocatorStatus(uiText`No PS5 responded at ${host}. Check the address and network.`);
      return;
    }
    showLocatedConsoles(consoles);
    selectTransferConsole(selected);
    consoleLocatorStatus(uiText`Using ${selected.name || 'PS5'} at ${host} (${formatFirmware(selected.firmware)}).`);
  } catch (error) {
    if (request === consoleScanVersion && !consoleSelectionLocked()) consoleLocatorStatus(uiText`Could not use ${host}: ${error.message}`);
  } finally {
    manualConnectionPending = false;
    controls.manualConnectBtn.disabled = accountClosing || Boolean(activeTransfer) || browseSessionActive;
    updateConsoleLocatorBusy();
  }
});

let deviceAuthorizationPending = false;
const authorizationDescriptionDefault = uiText('Remote oracle and online save tools require an authorized GarlicTransfer installation. Authorize this app with your GarlicSaves account to continue.');
function hideDeviceAuthFallback() {
  controls.deviceAuthFallback.hidden = true;
}
function showAuthorizationRequired() {
  if (!deviceAuthorizationPending) {
    controls.authorizationDescription.textContent = authorizationDescriptionDefault;
    controls.authorizationFallback.hidden = true;
    controls.authorizationNowBtn.disabled = false;
    controls.authorizationNowBtn.textContent = uiText('Authorize now');
  }
  if (!controls.authorizationModal.open) controls.authorizationModal.showModal();
}
controls.authorizationCancelBtn.addEventListener('click', () => controls.authorizationModal.close());
controls.authorizationNowBtn.addEventListener('click', () => {
  controls.authorizationDescription.textContent = uiText('Authorize in your browser. Keep this window open while you approve the request.');
  controls.authorizationNowBtn.disabled = true;
  controls.authorizationNowBtn.textContent = uiText('Waiting for approval…');
  showPage('settings');
  controls.authorizeDeviceBtn.click();
});
async function copyAuthorizationLink(input, button) {
  let copied = false;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
    await navigator.clipboard.writeText(input.value);
    copied = true;
  } catch {
    input.focus();
    input.select();
    copied = document.execCommand('copy');
  }
  button.textContent = copied ? uiText('Copied!') : uiText('Select link');
  if (!copied) { input.focus(); input.select(); }
  setTimeout(() => { button.textContent = uiText('Copy link'); }, 1500);
}
controls.deviceAuthCopyBtn.addEventListener('click', () => copyAuthorizationLink(controls.deviceAuthUrl, controls.deviceAuthCopyBtn));
controls.authorizationCopyBtn.addEventListener('click', () => copyAuthorizationLink(controls.authorizationUrl, controls.authorizationCopyBtn));
window.saveTransfer.onDeviceEvent?.(detail => {
  if (detail?.type === 'required') {
    showAuthorizationRequired();
    return;
  }
  if (detail?.type === 'pending') {
    controls.deviceAuthUrl.value = detail.verificationUri;
    controls.deviceAuthCode.textContent = detail.userCode;
    controls.deviceAuthFallback.hidden = false;
    controls.deviceAuthStatus.textContent = uiText`Approve the request in your browser. The code expires in ${Math.ceil((detail.expiresIn || 600) / 60)} minutes.`;
    controls.authorizationUrl.value = detail.verificationUri;
    controls.authorizationCode.textContent = detail.userCode;
    controls.authorizationFallback.hidden = false;
    controls.authorizationDescription.textContent = uiText`Authorize in your browser. If your browser doesn't open, copy the link below. The code expires in ${Math.ceil((detail.expiresIn || 600) / 60)} minutes.`;
  }
});
controls.authorizeDeviceBtn.addEventListener('click', async () => {
  if (accountClosing || deviceAuthorizationPending) return;
  deviceAuthorizationPending = true;
  controls.authorizeDeviceBtn.disabled = true;
  controls.settingsSave.disabled = true;
  hideDeviceAuthFallback();
  controls.authorizationFallback.hidden = true;
  controls.deviceAuthStatus.textContent = uiText('Starting installation authorization…');
  try {
    const result = await window.saveTransfer.authorizeDevice({ serverUrl: controls.serverUrl.value.trim() });
    await loadSettings();
    controls.deviceAuthStatus.textContent = uiText`Authorized${result.authorizedUser ? uiText` as ${result.authorizedUser}` : ''}. This installation has its own credential.`;
    controls.authorizationModal.close();
  } catch (error) {
    controls.deviceAuthStatus.textContent = uiText`Authorization failed: ${error.message}`;
    if (controls.authorizationModal.open) controls.authorizationDescription.textContent = uiText`Authorization failed: ${error.message}`;
  } finally {
    deviceAuthorizationPending = false;
    controls.authorizeDeviceBtn.disabled = false;
    controls.settingsSave.disabled = accountClosing;
    hideDeviceAuthFallback();
    if (controls.authorizationModal.open) {
      controls.authorizationNowBtn.disabled = false;
      controls.authorizationNowBtn.textContent = uiText('Try again');
    }
  }
});

function canReloadLanguage() {
  return !accountClosing && !activeTransfer && !browseSessionActive && !finishConfirmationPending
    && !deviceAuthorizationPending && !discoveryPending && !manualConnectionPending && !firewallPending && !decryptedWorkspace
    && !document.querySelector('dialog[open]');
}

controls.settingsSave.addEventListener('click', async () => {
  if (accountClosing) return;
  const request = ++settingsSaveVersion;
  const editVersion = firmwareLimitEditVersion;
  const entered = controls.jbFirmwareLimit?.value ?? consoleInfo.DEFAULT_JB_FIRMWARE;
  const current = options();
  const limit = consoleInfo.normalizeFirmwareLimit(entered);
  if (!limit) {
    controls.settingsStatus.textContent = uiText`Enter the maximum JB firmware as major.two digits, for example ${consoleInfo.DEFAULT_JB_FIRMWARE}.`;
    return;
  }
  current.jbFirmwareLimit = limit;
  let languageChanged = false;
  try {
    controls.settingsStatus.textContent = uiText('Saving settings…');
    languageChanged = await window.saveTransfer.saveSettings({
      ...current, output: profileRoot || current.output, uiLanguage: controls.uiLanguage.value,
    });
    if (request !== settingsSaveVersion || accountClosing) return;
    const latest = controls.jbFirmwareLimit?.value ?? consoleInfo.DEFAULT_JB_FIRMWARE;
    if (controls.jbFirmwareLimit && editVersion === firmwareLimitEditVersion && latest === entered) {
      controls.jbFirmwareLimit.value = limit;
    }
    if (!languageChanged) {
      controls.settingsStatus.textContent = consoleInfo.normalizeFirmwareLimit(latest) === limit
        ? uiText('Settings saved to config.ini.')
        : uiText('Settings saved. Newer firmware-limit edits are not saved yet.');
      return;
    }
    const deferred = uiText('Language saved. Finish the current work and save settings again to apply it.');
    if (canReloadLanguage()) {
      await savedAccounts?.prepareClose();
      if (canReloadLanguage() && await window.saveTransfer.reloadLanguage()) return;
    }
    controls.settingsStatus.textContent = deferred;
  } catch (error) {
    if (request === settingsSaveVersion && !accountClosing) {
      controls.settingsStatus.textContent = languageChanged
        ? uiText`Language saved, but could not reload: ${error.message}`
        : uiText`Could not save settings: ${error.message}`;
    }
  }
});

controls.firewallSettings.hidden = !window.saveTransfer.firewallAvailable;
controls.firewallHelperBtn.addEventListener('click', async () => {
  if (accountClosing || firewallPending) return;
  firewallPending = true;
  controls.firewallHelperBtn.disabled = true;
  controls.firewallStatus.textContent = uiText('Opening the firewall helper…');
  try {
    await window.saveTransfer.runFirewallHelper();
    controls.firewallStatus.textContent = uiText('Accept the Windows permission prompt. The helper will attach to GarlicTransfer and remove its rules when the app closes.');
  } catch (error) {
    controls.firewallStatus.textContent = uiText`Could not open the firewall helper: ${error.message}`;
  } finally {
    firewallPending = false;
    controls.firewallHelperBtn.disabled = accountClosing;
  }
});

async function loadSettings() {
  const settings = await window.saveTransfer.getSettings();
  for (const [name, value] of Object.entries(settings)) {
    const control = controls[name];
    if (!control || name === 'uiLayout') continue;
    if (control.type === 'checkbox') control.checked = Boolean(value);
    else control.value = String(value ?? '');
  }
  profileRoot = controls.output.value || 'dt_downloads';
  applyConsoleProfile();
  await skinAppearance.reload(settings.uiLayout);
  updateOracleMode();
  if (settings.installationId) {
    controls.deviceAuthStatus.textContent = uiText`Authorized${settings.authorizedUser ? uiText` as ${settings.authorizedUser}` : ''}. This installation has its own credential.`;
  }
  renderConsoleLocator(); updateConsoleDirection();
  window.saveTransfer.version().then((version) => {
    controls.appVersion.textContent = `v${version}`;
  });
}
controls.consoleSelect.addEventListener('change', applyConsoleProfile);
loadSettings();

controls.pairBtn.addEventListener('click', async () => {
  if (accountClosing) return;
  const current = options();
  if (!current.clientHost) {
    status(uiText('Discover and select the PS5 first.'));
    return;
  }
  activeTransfer = 'pair';
  showPairingModal();
  busy(true);
  status(uiText('Starting the pairing listener. Follow the instructions in the pairing window.'));
  try {
    await window.saveTransfer.pair(current);
  } catch (error) {
    activeTransfer = null;
    hidePairingModal();
    busy(false);
    status(uiText`Could not start pairing: ${error.message}`);
  }
});

controls.pairingCancelBtn.addEventListener('click', async () => {
  await window.saveTransfer.cancel();
  activeTransfer = null;
  hidePairingModal();
  busy(false);
  status(uiText('Pairing cancelled.'));
});

controls.uploadModalCloseBtn.addEventListener('click', hideUploadModal);

controls.downloadBtn.addEventListener('click', () => browseSaves(false));
controls.downloadSelectedBtn.addEventListener('click', () => startDownload([...selectedEntryIds]));
controls.selectAllEntries.addEventListener('change', () => {
  if (accountClosing) return;
  selectedEntryIds.clear();
  if (controls.selectAllEntries.checked) {
    for (const entry of (cmpLayout.active ? cmpLayout.visibleRemoteEntries() : availableEntries)) selectedEntryIds.add(entry.id);
  }
  renderEntries();
});
controls.uploadBtn.addEventListener('click', () => startUpload());
controls.browseLocalBtn.addEventListener('click', browseLocalSaves);
controls.confirmUploadBtn.addEventListener('click', startUploadSource);
controls.finishBtn.addEventListener('click', async () => {
  if (accountClosing || !browseSessionActive || activeTransfer || finishConfirmationPending) return;
  finishConfirmationPending = true;
  const version = browseSessionVersion;
  controls.finishBtn.disabled = true;
  try {
    if (!await confirmAction(uiText('Close Data Transfer and reboot the console now?'))) return;
    if (accountClosing || !browseSessionActive || activeTransfer || version !== browseSessionVersion) return;
    activeTransfer = 'finish';
    busy(true);
    status(uiText('Sending DisconnectPS5. The console will reboot.'));
    await window.saveTransfer.finish();
  } catch (error) {
    activeTransfer = null;
    status(uiText`Could not finish the download session: ${error.message}`);
    busy(false);
  } finally {
    finishConfirmationPending = false;
    if (browseSessionActive && !activeTransfer) controls.finishBtn.disabled = accountClosing;
  }
});
controls.cancelBtn.addEventListener('click', async () => {
  if (activeTransfer === 'save-editor') {
    await cancelMySaveOperation();
    return;
  }
  await window.saveTransfer.cancel();
  activeTransfer = null;
  hidePairingModal();
  resetUploadUI();
  browseSessionActive = false;
  browseSessionVersion++;
  busy(false);
  status(uiText('Transfer cancelled.'));
});
controls.powerBtn.addEventListener('click', async () => {
  if (accountClosing) return;
  await window.saveTransfer.power();
  controls.powerBtn.hidden = true;
  status(uiText('Power signal sent. Continue the transfer on the client console.'));
});

for (const name of ['output', 'metadata', 'assets']) {
  document.querySelector(`[data-action="${name}"]`).addEventListener('click', async () => {
    if (accountClosing) return;
    const path = await window.saveTransfer[`choose${name[0].toUpperCase()}${name.slice(1)}`]();
    if (accountClosing || !path) return;
    controls[name].value = path;
    if (name === 'output') {
      profileRoot = path;
      applyConsoleProfile();
    }
    if (name === 'metadata' && !controls.assets.value) controls.assets.value = folderPaths.profileRootPath(path.replace(/[/\\][^/\\]+$/, ''));
    if (name === 'assets' && !controls.metadata.value) {
      controls.metadata.value = folderPaths.metadataPath(path, 'metadata.db');
    }
  });
}

function transferStatus(event) {
  if (event.type === 'status' && event.progress) {
    const { entryId, current, total } = event.progress;
    return uiText`Downloading entry ${entryId} (${current}/${total}).`;
  }
  if (event.destination && Array.isArray(event.entryIds)) {
    return uiText`Downloaded ${event.entryIds.length} selected entries to ${event.destination}`;
  }
  return uiText(event.message);
}

window.saveTransfer.onEvent((event) => {
  if (event.type === 'log') appendLog(event.message);
  if (event.type === 'pairingStarted') {
    activeTransfer = 'pair';
    showPairingModal();
    busy(true);
  }
  if (event.type === 'paired') {
    hidePairingModal();
    activeTransfer = null;
    busy(false);
    void refreshLocatorPairing();
    if (!selectedLocatorConsole()) refreshPairingStatus();
    status(transferStatus(event));
  }
  if (event.type === 'powerRequired') showPowerModal();
  if (event.type === 'status') {
    status(transferStatus(event));
    if (event.step === 3) hidePowerModal();
    if (event.message === 'Transfer stopped.') {
      activeTransfer = null;
      resetUploadUI();
      browseSessionActive = false;
      browseSessionVersion++;
      busy(false);
    }
  }
  if (event.type === 'entries') {
    byId('saveBrowser').hidden = false;
    if (browserHost !== null && browserHost !== pendingBrowserHost) {
      selectedEntryIds.clear();
      downloadedEntryIds.clear();
    }
    browserHost = pendingBrowserHost;
    availableEntries = event.entries || [];
    availableUsers = event.users || [];
    for (const entry of availableEntries) {
      if (entry.downloaded) downloadedEntryIds.add(entry.id);
    }
    renderEntries();
    refreshCmpFiles();
  }
  if (event.type === 'ready') {
    browseSessionActive = true;
    browseSessionVersion++;
    dataTransferArmedHost = browserHost;
    activeTransfer = null;
    availableUsers = event.users || availableUsers;
    controls.metadata.value = folderPaths.metadataPath(options().output, 'metadata.db');
    status(transferStatus(event));
    busy(false);
  }
  if (event.type === 'downloaded') {
    refreshCmpFiles();
    for (const id of event.entryIds || requestedDownloadIds) downloadedEntryIds.add(id);
    controls.metadata.value = folderPaths.metadataPath(options().output, 'metadata.db');
    status(transferStatus(event));
    controls.powerBtn.hidden = true;
  }
  if (event.type === 'done' && event.metadataOnly) {
    const mode = activeTransfer;
    browseSessionActive = false;
    browseSessionVersion++;
    dataTransferArmedHost = event.consoleDisconnected ? null : browserHost;
    activeTransfer = null;
    availableUsers = event.users || [];
    controls.metadata.value = folderPaths.metadataPath(options().output, 'metadata.db');
    if (mode === 'upload-metadata') {
      pendingUploadOptions.metadata = controls.metadata.value;
      showUploadConfirmation();
    } else {
      status(uiText('Save list ready. Select saves to download, or select downloaded saves to upload.'));
    }
    busy(false);
    return;
  }
  if (event.type === 'done') {
    const mode = activeTransfer;
    browseSessionActive = false;
    browseSessionVersion++;
    if (mode === 'finish') dataTransferArmedHost = null;
    activeTransfer = null;
    availableUsers = event.users || availableUsers;
    if (mode === 'upload') resetUploadUI();
    if (mode === 'download') {
      dataTransferArmedHost = browserHost;
      for (const id of event.entryIds || requestedDownloadIds) downloadedEntryIds.add(id);
      controls.metadata.value = folderPaths.metadataPath(options().output, 'metadata.db');
      renderEntries();
    }
    status(transferStatus(event));
    busy(false);
    controls.powerBtn.hidden = true;
  }
  if (event.type === 'error') {
    activeTransfer = null;
    resetUploadUI();
    hidePairingModal();
    browseSessionActive = false;
    browseSessionVersion++;
    dataTransferArmedHost = null;
    status(uiText`Stopped: ${event.message}\nCheck the log and the current step, then retry.`);
    appendLog(uiText`[error] ${event.message}`);
    busy(false);
    controls.powerBtn.hidden = true;
  }
});

async function addExternalUpload(folder = false) {
  if (accountClosing) return;
  const image = folder ? await window.saveTransfer.chooseExternalFolder() : await window.saveTransfer.chooseExternalSave();
  if (accountClosing || !image) return;
  releasePcUpload();
  pendingExternalUpload = null;
  externalUploadImage = image;
  let option = [...controls.uploadSaveSelect.options].find((item) => item.value === 'external');
  if (!option) {
    option = document.createElement('option');
    option.value = 'external';
    controls.uploadSaveSelect.appendChild(option);
  }
  for (const item of controls.uploadSaveSelect.options) item.selected = false;
  option.textContent = uiText`External: ${image.split(/[\\/]/).pop()}`;
  option.selected = true;
  const title = image.toUpperCase().match(/PPSA[0-9]{5}/);
  controls.externalTitleId.value = title ? title[0] : '';
  renderCmpUpload();
  status(uiText('External save added. Check the PPSA title ID and destination user, then click Upload.'));
}
controls.addExternalSaveBtn.addEventListener('click', () => addExternalUpload(false));
controls.addExternalFolderBtn.addEventListener('click', () => addExternalUpload(true));

async function addExternalZip() {
  const result = await window.saveTransfer.chooseExternalZip(options().output);
  if (!result) return;
  externalUploadImage = result.folder;
  let option = [...controls.uploadSaveSelect.options].find((item) => item.value === 'external');
  if (!option) {
    option = document.createElement('option');
    option.value = 'external';
    controls.uploadSaveSelect.appendChild(option);
  }
  for (const item of controls.uploadSaveSelect.options) item.selected = false;
  option.textContent = uiText`External: ${result.folder.split(/[\\/]/).pop()}`;
  option.selected = true;
  controls.externalTitleId.value = result.titleId || '';
  renderCmpUpload();
  status(result.titleId
    ? uiText`ZIP extracted and added (title ${result.titleId}). Check the destination user, then click Upload.`
    : uiText('ZIP extracted and added. Enter the PPSA title ID and destination user, then click Upload.'));
}
controls.addExternalZipBtn.addEventListener('click', () => addExternalZip());

async function exportSelectedZip() {
  const selected = [...controls.uploadSaveSelect.selectedOptions].filter((option) => option.value !== 'external');
  if (selected.length !== 1) {
    status(uiText('Select exactly one downloaded save above, then click Export as ZIP.'));
    return;
  }
  const entryId = Number(selected[0].value);
  const suggestedName = `${controls.externalTitleId.value.trim() || `save-entry-${entryId}`}.zip`;
  try {
    const result = await window.saveTransfer.exportEntryZip(options().output, entryId, suggestedName);
    if (!result) { status(uiText('Export canceled.')); return; }
    status(uiText`Saved ${result.file_count} file(s) (${result.title_id}) to ${result.archive}`);
  } catch (error) {
    status(uiText`Could not export ZIP: ${error.message}`);
  }
}
controls.exportZipBtn.addEventListener('click', () => exportSelectedZip());

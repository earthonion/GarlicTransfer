const byId = (id) => document.getElementById(id);
const controls = {};
for (const id of [
  'oracleHost', 'interface', 'hardware', 'output', 'metadata', 'assets',
  'useRemoteOracle', 'serverUrl', 'workerKey', 'settingsSave', 'settingsStatus',
  'userSelect', 'userSelectLabel', 'uploadSaveSelect', 'uploadSaveSelectLabel', 'confirmUploadBtn', 'sourcePort', 'dataPort', 'discoveryPort',
  'downloadBtn', 'downloadSelectedBtn', 'uploadBtn', 'finishBtn', 'cancelBtn', 'powerBtn', 'status', 'entries', 'log',
  'consoleSelect', 'discoverBtn', 'accountId', 'findAccountIdBtn', 'pairBtn', 'pairingState', 'preferIpv6', 'selectAllEntries', 'entryCount', 'powerModal',
  'consoleLinkState', 'linkedConsole', 'linkedMessage', 'linkMethods', 'manageLinkBtn', 'keepLinkBtn', 'saveAccountIdBtn', 'forgetAccountIdBtn',
  'chooseLocalSaveBtn', 'clearLocalSaveBtn', 'localSaveState',
]) controls[id] = byId(id);
let activeTransfer = null;
let availableUsers = [];
let availableEntries = [];
let requestedDownloadIds = [];
let pendingUploadOptions = null;
let browserHost = null;
let pendingBrowserHost = null;
let dataTransferArmedHost = null;
let browseSessionActive = false;
let profileRoot = null;
let selectedHostId = '';
let selectedLocalSave = null;
let pairedConsole = false;
let managingLink = false;
const selectedEntryIds = new Set();
const downloadedEntryIds = new Set();

const accountIdKey = (hostId) => `garlictransfer.accountId.${hostId.toUpperCase()}`;

function consoleHostId() {
  const hostId = controls.consoleSelect.selectedOptions[0]?.dataset.hostId || '';
  return /^[0-9a-f]{12}$/i.test(hostId) ? hostId.toUpperCase() : '';
}

function decimalAccountId(value) {
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw) || BigInt(raw) >= (1n << 64n)) {
    throw new Error('Enter the unsigned decimal PSN account ID (up to 20 digits), not an online ID or password.');
  }
  return BigInt(raw).toString(10);
}

function storedAccountId(hostId = consoleHostId()) {
  if (!hostId) return '';
  try {
    const saved = localStorage.getItem(accountIdKey(hostId));
    return saved ? decimalAccountId(saved) : '';
  } catch {
    return '';
  }
}

function saveAccountId(value) {
  const hostId = consoleHostId();
  if (!hostId) throw new Error('Discover and select a console before saving its account ID.');
  const accountId = decimalAccountId(value);
  localStorage.setItem(accountIdKey(hostId), accountId);
  controls.accountId.value = accountId;
  managingLink = false;
  renderLinkState();
}

function rememberAccountIdAfterBrowse() {
  if (!controls.accountId.value.trim()) return;
  try {
    if (decimalAccountId(controls.accountId.value) === storedAccountId()) return;
    saveAccountId(controls.accountId.value);
  } catch (error) {
    appendLog(`[account] could not save this console's account ID: ${error.message}`);
  }
}

function renderLinkState() {
  const hostId = consoleHostId();
  const savedId = storedAccountId(hostId);
  const linked = Boolean(hostId && (savedId || pairedConsole));
  controls.linkedConsole.hidden = !linked || managingLink;
  controls.linkMethods.hidden = linked && !managingLink;
  controls.keepLinkBtn.hidden = !linked || !managingLink;
  controls.forgetAccountIdBtn.hidden = !savedId;
  controls.saveAccountIdBtn.disabled = !hostId || Boolean(activeTransfer) || browseSessionActive;
  controls.findAccountIdBtn.disabled = !hostId || Boolean(activeTransfer) || browseSessionActive;
  controls.manageLinkBtn.disabled = Boolean(activeTransfer) || browseSessionActive;
  controls.pairBtn.disabled = !window.saveTransfer.pairingAvailable || !hostId ||
    controls.consoleSelect.selectedOptions[0]?.dataset.firmware !== '14220000' ||
    Boolean(activeTransfer) || browseSessionActive;
  controls.consoleLinkState.textContent = !hostId
    ? 'Discover a console to check its saved link.'
    : linked && !managingLink
      ? 'Ready to browse from the PS5 home screen.'
      : linked
        ? 'Choose a different linking method, or keep the current one.'
        : 'Choose one linking method for this console.';
  controls.linkedMessage.textContent = pairedConsole
    ? 'This console is paired on this PC. Its approval identifier is saved for this console.'
    : 'This console’s decimal PSN account ID is saved on this PC.';
}

function renderLocalSave() {
  controls.clearLocalSaveBtn.hidden = !selectedLocalSave;
  controls.localSaveState.textContent = selectedLocalSave
    ? `Selected: ${selectedLocalSave.title} (${selectedLocalSave.kind} save) · ${(selectedLocalSave.sizeBytes / 0x100000).toFixed(1)} MiB · ${selectedLocalSave.saveDir}`
    : 'Use a save downloaded by GarlicTransfer, or choose one from this console profile below. Arbitrary files are not supported.';
}

function options() {
  const clientHost = controls.consoleSelect.value;
  return {
    oracleHost: controls.oracleHost.value.trim(),
    oraclePort: 9022,
    useRemoteOracle: controls.useRemoteOracle.checked,
    serverUrl: controls.serverUrl.value.trim(),
    workerKey: controls.workerKey.value.trim(),
    clientHost,
    hostId: controls.consoleSelect.selectedOptions[0]?.dataset.hostId || '',
    systemVersion: controls.consoleSelect.selectedOptions[0]?.dataset.firmware || '',
    accountId: controls.accountId.value.trim(),
    interface: controls.interface.value.trim(),
    hardware: Number(controls.hardware.value || 0),
    output: controls.output.value.trim() || 'dt_downloads',
    metadata: controls.metadata.value.trim(),
    assets: controls.assets.value.trim() || controls.output.value.trim() || 'dt_downloads',
    userId: controls.userSelect.value,
    userName: controls.userSelect.selectedOptions[0]?.dataset.name || 'user',
    sourcePort: Number(controls.sourcePort.value || 1004),
    dataPort: Number(controls.dataPort.value || 1005),
    discoveryPort: Number(controls.discoveryPort.value || 1006),
    preferIpv6: controls.preferIpv6.checked,
    skipLaunch: dataTransferArmedHost === clientHost && !controls.preferIpv6.checked,
    skipPower: dataTransferArmedHost === clientHost && !controls.preferIpv6.checked,
  };
}

function formatFirmware(value) {
  const text = String(value || 'unknown');
  return /^\d{8}$/.test(text) ? `${Number(text.slice(0, 2))}.${text.slice(2, 4)}` : text;
}

function profilePath(root, child) {
  const separator = root.includes('\\') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${separator}${child}`;
}

function applyConsoleProfile() {
  const root = profileRoot || 'dt_downloads';
  const selected = controls.consoleSelect.selectedOptions[0];
  const identity = selected?.dataset.hostId || selected?.value || 'default';
  const profile = identity.replace(/[^A-Za-z0-9_.-]/g, '_');
  controls.output.value = profilePath(root, profile);
  controls.assets.value = controls.output.value;
  controls.metadata.value = '';
  const hostId = consoleHostId();
  if (hostId !== selectedHostId) {
    selectedLocalSave = null;
    pendingUploadOptions = null;
    availableUsers = [];
    availableEntries = [];
    byId('uploadDestination').hidden = true;
    renderLocalSave();
  }
  selectedHostId = hostId;
  controls.accountId.value = storedAccountId(hostId);
  managingLink = false;
  pairedConsole = false;
  renderLinkState();
  refreshPairingStatus();
}

async function refreshPairingStatus() {
  const selected = controls.consoleSelect.selectedOptions[0];
  const identity = { hostId: selected?.dataset.hostId || '', systemVersion: selected?.dataset.firmware || '' };
  const supported = window.saveTransfer.pairingAvailable && Boolean(selected?.value) &&
    identity.systemVersion === '14220000';
  controls.pairingState.textContent = supported
    ? 'Checking whether this PS5 has been paired…'
    : window.saveTransfer.pairingAvailable
      ? 'Experimental one-time pairing is available for a discovered PS5 on firmware 14.22.'
      : 'On Linux and macOS, use a PS4 USB backup or enter the decimal account ID.';
  if (!supported) {
    pairedConsole = false;
    renderLinkState();
    return;
  }
  try {
    const paired = await window.saveTransfer.pairingStatus(identity);
    if (controls.consoleSelect.selectedOptions[0] !== selected) return;
    pairedConsole = Boolean(paired);
    controls.pairingState.textContent = paired
      ? 'Paired on this PC. Browse from the PS5 home screen.'
      : 'Not paired yet. Experimental pairing may let you browse without entering an account ID.';
    renderLinkState();
  } catch (error) {
    if (controls.consoleSelect.selectedOptions[0] === selected) {
      controls.pairingState.textContent = `Could not check pairing: ${error.message}`;
      pairedConsole = false;
      renderLinkState();
    }
  }
}

function updateSelection() {
  const count = selectedEntryIds.size;
  controls.entryCount.textContent = count
    ? `${count} of ${availableEntries.length} save(s) selected`
    : `${availableEntries.length} save(s); none selected`;
  controls.selectAllEntries.checked = count > 0 && count === availableEntries.length;
  controls.selectAllEntries.indeterminate = count > 0 && count < availableEntries.length;
  controls.selectAllEntries.disabled = Boolean(activeTransfer) || !availableEntries.length;
  controls.downloadSelectedBtn.disabled = Boolean(activeTransfer) || count === 0;
  controls.finishBtn.hidden = !browseSessionActive || Boolean(activeTransfer);
  for (const checkbox of document.querySelectorAll('.entry-check')) checkbox.disabled = Boolean(activeTransfer);
  for (const button of document.querySelectorAll('.row-download')) button.disabled = Boolean(activeTransfer);
}

function busy(value) {
  controls.downloadBtn.disabled = value;
  controls.uploadBtn.disabled = value;
  controls.accountId.disabled = value || browseSessionActive;
  controls.chooseLocalSaveBtn.disabled = value || browseSessionActive;
  controls.clearLocalSaveBtn.disabled = value || browseSessionActive;
  controls.cancelBtn.disabled = !value;
  controls.consoleSelect.disabled = value || browseSessionActive;
  controls.discoverBtn.disabled = value || browseSessionActive;
  if (!value) hidePowerModal();
  renderLinkState();
  updateSelection();
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

function renderEntries() {
  controls.entries.replaceChildren();
  if (!availableEntries.length) {
    controls.entries.innerHTML = '<tr><td colspan="5" class="empty">No save entries were found.</td></tr>';
    updateSelection();
    return;
  }
  const userNames = new Map(availableUsers.map((user) => [user.id.toLowerCase(), user.name]));
  for (const entry of availableEntries) {
    const row = document.createElement('tr');

    const selectCell = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'entry-check';
    checkbox.checked = selectedEntryIds.has(entry.id);
    checkbox.setAttribute('aria-label', `Select ${entry.name || entry.title}`);
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
    name.textContent = entry.name || 'Unknown title';
    const titleId = document.createElement('span');
    titleId.className = 'title-id';
    titleId.textContent = `${entry.title} · entry ${entry.id}`;
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
    download.textContent = downloadedEntryIds.has(entry.id) ? 'Download again' : 'Download';
    download.addEventListener('click', () => startDownload([entry.id]));
    actionCell.appendChild(download);
    if (downloadedEntryIds.has(entry.id)) {
      const downloaded = document.createElement('span');
      downloaded.className = 'downloaded';
      downloaded.textContent = 'Downloaded';
      actionCell.appendChild(downloaded);
    }
    row.appendChild(actionCell);
    controls.entries.appendChild(row);
  }
  updateSelection();
}

async function browseSaves(forUpload = false) {
  if (!forUpload && browseSessionActive) {
    status('The download session is already open. Select saves from the browser.');
    return;
  }
  const current = options();
  if (!current.clientHost) {
    status('Discover and select a console first.');
    return;
  }
  pendingBrowserHost = current.clientHost;
  activeTransfer = forUpload ? 'upload-metadata' : 'browse';
  busy(true);
  status('Step 1/3: downloading the console save list.');
  if (!forUpload) {
    byId('saveBrowser').hidden = true;
    controls.entries.innerHTML = '<tr><td colspan="5" class="empty">Downloading metadata…</td></tr>';
  }
  try {
    await window.saveTransfer.download({
      ...current,
      metadataOnly: forUpload,
      waitForSelection: !forUpload,
      entryIds: [],
    });
  } catch (error) {
    status(`Could not browse saves: ${error.message}`);
    activeTransfer = null;
    busy(false);
  }
}

async function startDownload(entryIds) {
  if (!entryIds.length) {
    status('Select at least one save to download.');
    return;
  }
  if (!browseSessionActive) {
    status('The download session is not open. Browse the console again first.');
    return;
  }
  requestedDownloadIds = entryIds;
  activeTransfer = 'download';
  busy(true);
  status(`Downloading ${entryIds.length} selected save(s) on the open Data Transfer session.`);
  try {
    await window.saveTransfer.select(entryIds);
  } catch (error) {
    status(`Could not start download: ${error.message}`);
    activeTransfer = null;
    browseSessionActive = false;
    busy(false);
  }
}

async function startUploadSource() {
  if (!validateUploadSelection()) return;
  const selectedUser = controls.userSelect.selectedOptions[0];
  const entryIds = [...controls.uploadSaveSelect.selectedOptions].map((option) => Number(option.value));
  if (!selectedUser || !entryIds.length) {
    status('Select one user and at least one downloaded save before continuing.');
    return;
  }
  const current = {
    ...(pendingUploadOptions || options()),
    userId: selectedUser.value,
    userName: selectedUser.dataset.name || 'user',
    entryIds,
    ...(selectedLocalSave ? { localSave: selectedLocalSave } : {}),
  };
  activeTransfer = 'upload';
  busy(true);
  controls.confirmUploadBtn.hidden = true;
  controls.userSelectLabel.hidden = true;
  controls.uploadSaveSelectLabel.hidden = true;
  status(`Step 1/3: building metadata for ${entryIds.length} save(s) and one user.`);
  try {
    await window.saveTransfer.upload(current);
  } catch (error) {
    status(`Could not start upload: ${error.message}`);
    activeTransfer = null;
    busy(false);
  }
}

function validateUploadSelection(alignOwner = false) {
  const selectedSaves = [...controls.uploadSaveSelect.selectedOptions];
  const owners = new Set(selectedSaves.map((option) => option.dataset.owner?.toLowerCase()));
  let message;
  if (!selectedSaves.length) {
    message = 'Select at least one save to upload.';
  } else if (owners.has(undefined) || owners.size !== 1) {
    message = 'Select saves belonging to one PS5 user. Saves from different users cannot be combined.';
  } else {
    const [owner] = owners;
    const matchingUser = [...controls.userSelect.options].find((option) => option.value.toLowerCase() === owner);
    if (!matchingUser) {
      message = `Save owner ${owner} is not in this console profile. Browse the matching console first.`;
    } else {
      if (alignOwner) controls.userSelect.value = matchingUser.value;
      const selectedUser = controls.userSelect.selectedOptions[0];
      message = selectedUser?.value.toLowerCase() === owner
        ? `Ready to upload ${selectedSaves.length} save(s) for ${matchingUser.dataset.name} (${owner}).`
        : `Save owner ${owner} differs from the selected target user. Select ${matchingUser.dataset.name} (${owner}).`;
      controls.confirmUploadBtn.disabled = selectedUser?.value.toLowerCase() !== owner;
      status(message);
      return !controls.confirmUploadBtn.disabled;
    }
  }
  controls.confirmUploadBtn.disabled = true;
  status(message);
  return false;
}

function showUploadConfirmation() {
  controls.userSelect.replaceChildren();
  for (const user of availableUsers) {
    const option = document.createElement('option');
    option.value = user.id;
    option.dataset.name = user.name;
    option.textContent = `${user.name} (${user.id})`;
    controls.userSelect.appendChild(option);
  }
  controls.uploadSaveSelect.replaceChildren();
  if (selectedLocalSave) {
    const option = document.createElement('option');
    option.value = selectedLocalSave.entryId;
    option.dataset.owner = selectedLocalSave.owner;
    option.textContent = `${selectedLocalSave.title} — selected PC save folder`;
    option.selected = true;
    controls.uploadSaveSelect.appendChild(option);
  } else {
    for (const entry of availableEntries.filter((item) => item.downloaded)) {
      const option = document.createElement('option');
      option.value = entry.id;
      option.dataset.owner = entry.owner;
      option.textContent = `${entry.name || entry.title} (${entry.title}) — ${entry.owner} — entry ${entry.id}`;
      controls.uploadSaveSelect.appendChild(option);
    }
  }
  if (!availableUsers.length || !controls.uploadSaveSelect.options.length) {
    controls.userSelectLabel.hidden = true;
    controls.uploadSaveSelectLabel.hidden = true;
    controls.confirmUploadBtn.hidden = true;
    status('No compatible save folder is selected. Download a save, or add an existing GarlicTransfer save folder.');
    return;
  }
  controls.userSelectLabel.hidden = false;
  controls.uploadSaveSelectLabel.hidden = false;
  controls.confirmUploadBtn.hidden = false;
  validateUploadSelection(Boolean(selectedLocalSave));
}

controls.uploadSaveSelect.addEventListener('change', () => validateUploadSelection(true));
controls.userSelect.addEventListener('change', () => validateUploadSelection());

async function startUpload() {
  const current = options();
  if (!current.clientHost) {
    status('Discover and select a console first.');
    return;
  }
  byId('uploadDestination').hidden = false;
  if (browseSessionActive) {
    await window.saveTransfer.cancel();
    browseSessionActive = false;
    dataTransferArmedHost = null;
  }
  current.entryIds = [];
  if (selectedLocalSave) current.localSave = selectedLocalSave;
  pendingUploadOptions = current;
  const hasExplicitMetadata = Boolean(current.metadata);
  const previousMetadata = current.metadata || `${current.output}/metadata.db`;
  try {
    const inventory = await window.saveTransfer.inventory(previousMetadata);
    availableUsers = inventory.users;
    availableEntries = inventory.entries;
    if (!availableUsers.length) throw new Error('the metadata contains no users');
    current.metadata = previousMetadata;
    controls.metadata.value = previousMetadata;
    showUploadConfirmation();
    return;
  } catch (error) {
    if (hasExplicitMetadata) {
      status(`Could not read metadata inventory: ${error.message}`);
      return;
    }
    appendLog(`[metadata] no usable previous metadata at ${previousMetadata}; fetching from console`);
  }
  pendingBrowserHost = current.clientHost;
  activeTransfer = 'upload-metadata';
  busy(true);
  status('Step 1/3: fetching the client user and save list before upload.');
  try {
    await window.saveTransfer.download({ ...current, metadataOnly: true, entryIds: [] });
  } catch (error) {
    status(`Could not fetch metadata: ${error.message}`);
    activeTransfer = null;
    busy(false);
  }
}

function updateOracleMode() {
  const remote = controls.useRemoteOracle.checked;
  controls.oracleHost.disabled = remote;
  controls.serverUrl.disabled = !remote;
  controls.workerKey.disabled = !remote;
}
controls.useRemoteOracle.addEventListener('change', updateOracleMode);
updateOracleMode();

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.tab')) other.classList.toggle('active', other === tab);
    byId('transferTab').hidden = tab.dataset.tab !== 'transfer';
    byId('settingsTab').hidden = tab.dataset.tab !== 'settings';
  });
}

controls.discoverBtn.addEventListener('click', async () => {
  controls.discoverBtn.disabled = true;
  status('Discovering consoles with SRCH…');
  try {
    const consoles = await window.saveTransfer.discover(options());
    controls.consoleSelect.replaceChildren();
    for (const console of consoles) {
      const option = document.createElement('option');
      option.value = console.host;
      option.dataset.hostId = console.hostId;
      option.dataset.firmware = console.firmware;
      option.textContent = `${console.name} — ${console.host} (${formatFirmware(console.firmware)})`;
      controls.consoleSelect.appendChild(option);
    }
    if (!consoles.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No consoles found';
      controls.consoleSelect.appendChild(option);
    }
    applyConsoleProfile();
    status(consoles.length
      ? `Found ${consoles.length} console(s). Each console uses its own metadata profile.`
      : 'No consoles found. Check the network and firewall.');
  } catch (error) {
    status(`Discovery failed: ${error.message}`);
  } finally {
    controls.discoverBtn.disabled = false;
  }
});

controls.settingsSave.addEventListener('click', async () => {
  const current = options();
  await window.saveTransfer.saveSettings({ ...current, output: profileRoot || current.output });
  controls.settingsStatus.textContent = 'Connection settings saved to config.ini. Console links remain stored separately on this PC.';
});

async function loadSettings() {
  const settings = await window.saveTransfer.getSettings();
  for (const [name, value] of Object.entries(settings)) {
    const control = controls[name];
    if (!control) continue;
    if (control.type === 'checkbox') control.checked = Boolean(value);
    else control.value = String(value ?? '');
  }
  profileRoot = controls.output.value || 'dt_downloads';
  applyConsoleProfile();
  updateOracleMode();
}
controls.consoleSelect.addEventListener('change', applyConsoleProfile);
loadSettings();

controls.manageLinkBtn.addEventListener('click', () => {
  managingLink = true;
  renderLinkState();
});
controls.keepLinkBtn.addEventListener('click', () => {
  managingLink = false;
  renderLinkState();
});
controls.saveAccountIdBtn.addEventListener('click', () => {
  try {
    saveAccountId(controls.accountId.value);
    status('PSN account ID saved for this console. Browse from its home screen.');
  } catch (error) {
    status(`Could not save account ID: ${error.message}`);
  }
});
controls.accountId.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    controls.saveAccountIdBtn.click();
  }
});
controls.forgetAccountIdBtn.addEventListener('click', () => {
  const hostId = consoleHostId();
  if (!hostId) return;
  localStorage.removeItem(accountIdKey(hostId));
  controls.accountId.value = '';
  managingLink = false;
  renderLinkState();
  status('Saved account ID removed for this console.');
});
controls.findAccountIdBtn.addEventListener('click', async () => {
  try {
    const accountId = await window.saveTransfer.chooseAccountId();
    if (accountId !== null) {
      saveAccountId(accountId);
      status('PSN account ID found in the PS4 USB backup and saved for this console. Browse from its home screen.');
    }
  } catch (error) {
    status(`Could not find an account ID: ${error.message}`);
  }
});

controls.pairBtn.addEventListener('click', async () => {
  const current = options();
  if (!current.clientHost) {
    status('Discover and select the PS5 first.');
    return;
  }
  activeTransfer = 'pair';
  busy(true);
  status('Starting the experimental pairing listener. When ready, open PS5 Data Transfer and select “GarlicTransfer Pairing”.');
  try {
    await window.saveTransfer.pair(current);
  } catch (error) {
    activeTransfer = null;
    busy(false);
    status(`Could not start pairing: ${error.message}`);
  }
});

controls.downloadBtn.addEventListener('click', () => browseSaves(false));
controls.downloadSelectedBtn.addEventListener('click', () => startDownload([...selectedEntryIds]));
controls.selectAllEntries.addEventListener('change', () => {
  selectedEntryIds.clear();
  if (controls.selectAllEntries.checked) {
    for (const entry of availableEntries) selectedEntryIds.add(entry.id);
  }
  renderEntries();
});
controls.uploadBtn.addEventListener('click', startUpload);
controls.confirmUploadBtn.addEventListener('click', startUploadSource);
controls.chooseLocalSaveBtn.addEventListener('click', async () => {
  try {
    const chosen = await window.saveTransfer.chooseUploadSave();
    if (!chosen || chosen.cancelled) return;
    if (chosen.error) throw new Error(chosen.error);
    if (!chosen.saveDir || !Number.isInteger(Number(chosen.entryId)) ||
        Number(chosen.entryId) < 1 || Number(chosen.entryId) > 0xffffffff) {
      throw new Error('The chosen folder is not a GarlicTransfer save download.');
    }
    selectedLocalSave = chosen;
    if (pendingUploadOptions) pendingUploadOptions.localSave = chosen;
    renderLocalSave();
    if (availableUsers.length) showUploadConfirmation();
    else status('Save folder selected. Fetch the destination console’s save list before uploading.');
  } catch (error) {
    status(`Could not add save folder: ${error.message}`);
  }
});
controls.clearLocalSaveBtn.addEventListener('click', () => {
  selectedLocalSave = null;
  if (pendingUploadOptions) delete pendingUploadOptions.localSave;
  renderLocalSave();
  if (availableUsers.length) showUploadConfirmation();
});
controls.finishBtn.addEventListener('click', async () => {
  if (!browseSessionActive || activeTransfer) return;
  if (!window.confirm('Close Data Transfer and reboot the console now?')) return;
  activeTransfer = 'finish';
  busy(true);
  status('Sending DisconnectPS5. The console will reboot.');
  try {
    await window.saveTransfer.finish();
  } catch (error) {
    activeTransfer = null;
    status(`Could not finish the download session: ${error.message}`);
    busy(false);
  }
});
controls.cancelBtn.addEventListener('click', async () => {
  await window.saveTransfer.cancel();
  activeTransfer = null;
  pendingUploadOptions = null;
  dataTransferArmedHost = null;
  browseSessionActive = false;
  busy(false);
  status('Transfer cancelled.');
});
controls.powerBtn.addEventListener('click', async () => {
  await window.saveTransfer.power();
  controls.powerBtn.hidden = true;
  status('Power signal sent. Continue the transfer on the client console.');
});

for (const name of ['output', 'metadata', 'assets']) {
  document.querySelector(`[data-action="${name}"]`).addEventListener('click', async () => {
    const path = await window.saveTransfer[`choose${name[0].toUpperCase()}${name.slice(1)}`]();
    if (!path) return;
    controls[name].value = path;
    if (name === 'output') {
      profileRoot = path;
      applyConsoleProfile();
    }
    if (name === 'metadata' && !controls.assets.value) controls.assets.value = path.replace(/[/\\][^/\\]+$/, '');
    if (name === 'assets' && !controls.metadata.value) {
      const parent = path.replace(/[/\\][^/\\]+$/, '');
      controls.metadata.value = `${parent}${parent.includes('\\') ? '\\' : '/'}metadata.db`;
    }
  });
}

window.saveTransfer.onEvent((event) => {
  if (event.type === 'log') appendLog(event.message);
  if (event.type === 'paired') {
    controls.accountId.value = '';
    pairedConsole = true;
    managingLink = false;
    activeTransfer = null;
    busy(false);
    controls.pairingState.textContent = 'Paired on this PC. Browse from the PS5 home screen.';
    renderLinkState();
    status(event.message);
  }
  if (event.type === 'powerRequired') showPowerModal();
  if (event.type === 'status') {
    status(event.message);
    if (event.step === 3) hidePowerModal();
    if (event.message === 'Transfer stopped.') {
      activeTransfer = null;
      browseSessionActive = false;
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
  }
  if (event.type === 'ready') {
    rememberAccountIdAfterBrowse();
    browseSessionActive = true;
    dataTransferArmedHost = browserHost;
    activeTransfer = null;
    availableUsers = event.users || availableUsers;
    controls.metadata.value = `${options().output}/metadata.db`;
    status(event.message);
    busy(false);
  }
  if (event.type === 'downloaded') {
    for (const id of event.entryIds || requestedDownloadIds) downloadedEntryIds.add(id);
    controls.metadata.value = `${options().output}/metadata.db`;
    status(event.message);
    controls.powerBtn.hidden = true;
  }
  if (event.type === 'done' && event.metadataOnly) {
    rememberAccountIdAfterBrowse();
    const mode = activeTransfer;
    browseSessionActive = false;
    dataTransferArmedHost = event.consoleDisconnected ? null : browserHost;
    activeTransfer = null;
    availableUsers = event.users || [];
    controls.metadata.value = `${options().output}/metadata.db`;
    if (mode === 'upload-metadata') {
      pendingUploadOptions.metadata = controls.metadata.value;
      showUploadConfirmation();
    } else {
      status('Save list ready. Select saves to download, or select downloaded saves to upload.');
    }
    busy(false);
    return;
  }
  if (event.type === 'done') {
    const mode = activeTransfer;
    browseSessionActive = false;
    if (mode === 'finish') dataTransferArmedHost = null;
    activeTransfer = null;
    availableUsers = event.users || availableUsers;
    if (mode === 'download') {
      dataTransferArmedHost = browserHost;
      for (const id of event.entryIds || requestedDownloadIds) downloadedEntryIds.add(id);
      controls.metadata.value = `${options().output}/metadata.db`;
      renderEntries();
    }
    status(event.message);
    busy(false);
    controls.powerBtn.hidden = true;
  }
  if (event.type === 'error') {
    activeTransfer = null;
    browseSessionActive = false;
    dataTransferArmedHost = null;
    status(`Stopped: ${event.message}\nCheck the log and the current step, then retry.`);
    appendLog(`[error] ${event.message}`);
    busy(false);
    controls.powerBtn.hidden = true;
  }
});

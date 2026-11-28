const myControls = {};
for (const id of [
  'mySavesTab', 'mySaveEntries', 'myTitleEntries', 'myTitleList', 'myTitleSaveList',
  'mySavesBackBtn', 'mySavesLibraryLabel', 'mySavesSearch', 'mySavesSearchCount', 'localConsoleSelect', 'localUserSelect', 'chooseLocalPcFolderBtn', 'localPcFolderLabel',
  'refreshMySavesBtn', 'decryptExternalBtn', 'selectedSavePanel',
  'selectedSaveName', 'selectedSaveDetails', 'mySaveDecryptBtn', 'mySaveResignBtn', 'mySaveExportBtn',
  'saveMoreBtn', 'saveMoreOptions', 'decryptExportBtn', 'saveEncryptFileBtn',
  'uploadSaveBtn', 'uploadEncryptedBtn', 'workspaceMoreBtn', 'workspaceMoreOptions', 'fileMoreBtn', 'fileMoreOptions',
  'mySaveImportBtn', 'resignPanel', 'resignAccountId', 'confirmResignBtn', 'workspacePanel',
  'workspaceSummary', 'closeWorkspaceBtn', 'exportDecryptedBtn', 'addFilesBtn', 'encryptSaveBtn',
  'workspaceCounts', 'workspaceGameId', 'workspaceGameName', 'workspaceBatchWarning',
  'workspaceAccountControls', 'workspaceCurrentAccount', 'workspaceAccountSlot', 'workspaceAccountId', 'workspaceBatchAccountId', 'addCurrentAccountBtn', 'reRegionScope',
  'encryptPanel', 'encryptAccountId', 'confirmEncryptBtn', 'workspaceFiles', 'fileEditorPanel',
  'editorFileName', 'editorMode', 'editorScroll', 'editorScrollTrack', 'fileEditor', 'editorHint', 'editorSearch', 'editorFindNext',
  'editorOffset', 'editorGoOffset', 'editorRevert', 'editorByteCount', 'saveFileBtn', 'downloadFileBtn',
  'replaceFileBtn', 'deleteFileBtn', 'mySavesStatus', 'mySavesLog',
  'targetTitleId', 'targetTitleIdHint',
  'fileEditorDialog', 'closeFileEditorBtn', 'editorStatus', 'reRegionBtn', 'resignReRegionBtn',
  'reRegionDialog', 'reRegionForm', 'reRegionCurrentTitle', 'reRegionError', 'applyReRegionBtn', 'cancelReRegionBtn', 'workspaceTargetTitle',
]) myControls[id] = document.getElementById(id);
myControls.mySavesTab = document.getElementById('libraryPage');
const editorButtons = [...myControls.fileEditorDialog.querySelectorAll('button')];
const editorInputs = [...myControls.fileEditorDialog.querySelectorAll('.editor-tools input')];

let currentWizardStep = 0;
function goToLibraryStep(step) {
  currentWizardStep = step;
  const accountControls = myControls.workspaceAccountControls;
  const accountHost = step === 1 ? myControls.selectedSavePanel : document.querySelector('.workspace-header');
  if (accountControls && accountHost && accountControls.parentElement !== accountHost) {
    if (step === 1) accountHost.prepend(accountControls);
    else accountHost.append(accountControls);
  }
  const currentAccount = myControls.workspaceCurrentAccount;
  const currentAccountHost = step === 1 ? accountControls : myControls.workspaceAccountSlot;
  if (currentAccount.parentElement !== currentAccountHost) currentAccountHost.prepend(currentAccount);
  for (const panel of document.querySelectorAll('.wizard-panel')) {
    const isTarget = panel.dataset.wizard === String(step);
    panel.classList.toggle('active', isTarget);
  }
  for (const btn of document.querySelectorAll('.wizard-step')) {
    const s = Number(btn.dataset.step);
    btn.classList.toggle('active', s === step);
    btn.classList.toggle('done', s < step);
  }
  updateTitleControls();
}
for (const btn of document.querySelectorAll('.wizard-step')) {
  btn.addEventListener('click', () => {
    const target = Number(btn.dataset.step);
    if (target === 1 && !selectedLocalSave) return;
    if (target === 2 && !decryptedWorkspace) return;
    goToLibraryStep(target);
  });
}
for (const btn of document.querySelectorAll('.wizard-back')) {
  btn.addEventListener('click', () => goToLibraryStep(Number(btn.dataset.go)));
}

let mySaves = [];
let cmpLocalUsers = [];
let cmpLocalRequest = 0;
let cmpInventoryRequest = 0;
let loadedLocalPath = null;
let localProfiles = [];
const LOCAL_PC_SOURCE = '__local_pc__';
let localPcMode = false;
let localPcInventory = { root: '', entries: [], users: [], warnings: [], active: false };
let localProfileRequest = 0;
let selectedLocalSource = '';
let selectedTitle = null;
let selectedLocalSave = null;
let decryptedWorkspace = null;
let decryptedArchive = null;
let decryptedTemporaryId = null;
let workspaceDetails = null;
let accountWorkspace = null;
let selectedWorkspaceFile = null;
let selectedWorkspacePath = '';
let editorOpener = null;
let reRegionDraft = null;
let selectedFileBytes = null;
let editorDirty = false;
let workspaceModified = false;
let mySaveOperation = false;
let myOperationSequence = 0;
let myCancelOperation = 0;
let myCancellationSequence = 0;
let workspaceTree = null;
let editorRevision = 0;
let editorCountTimer = null;
let editorParsedDraft = null;
let editorSearchState = null;
const PAGED_EDITOR_THRESHOLD = 256 * 1024;
let pagedEditor = null;
let editorPageStart = 0;
let editorPageChanged = false;
let editorVisibleLength = 0;
const editorScroller = window.EditorScroll?.create({
  editor: myControls.fileEditor,
  rail: myControls.editorScroll,
  track: myControls.editorScrollTrack,
  getView: () => pagedEditor && {
    key: pagedEditor, start: editorPageStart, length: editorVisibleLength,
    size: pagedEditor.size - selectedFileBytes.length + editorVisibleLength,
    mode: myControls.editorMode.value, dirty: editorPageChanged, blocked: saveControlsBlocked(),
  },
  move: scrollEditorTo,
  onError: error => myStatus(error.message),
});

function myStatus(message) {
  myControls.mySavesStatus.textContent = message;
  if (myControls.fileEditorDialog.open) myControls.editorStatus.textContent = message;
}

function myLog(message) {
  myControls.mySavesLog.textContent += `${message}\n`;
  myControls.mySavesLog.scrollTop = myControls.mySavesLog.scrollHeight;
}

// Function = Account Selection
const savedAccounts = window.saveAccounts && window.SavedAccounts?.create(document, window.saveAccounts, {
  isBusy: saveControlsBlocked,
  onTargetChange: id => {
    myControls.encryptAccountId.value = id || workspaceAccountId();
    myControls.resignAccountId.value = id || '';
    const fixedAccount = savedAccounts.isUsingCurrent() || Boolean(savedAccounts.getSelectedId());
    myControls.encryptAccountId.readOnly = fixedAccount;
    myControls.resignAccountId.readOnly = fixedAccount;
  },
});

// Function = Account Closing
window.saveAccounts?.onBeforeClose?.(async () => {
  setAccountClosing(true);
  savedAccounts?.setBusy(true);
  await savedAccounts?.prepareClose();
}, () => {
  setAccountClosing(false);
  savedAccounts?.setBusy(mySaveOperation);
});
document.addEventListener('transfer-state-changed', () => {
  savedAccounts?.setBusy(mySaveOperation || accountClosing);
  workspaceTree?.setBusy(mySaveOperation || accountClosing || Boolean(activeTransfer) || browseSessionActive);
  updateTitleControls();
  updateMyFileActions();
});

// Function = Title Selection
function updateTitleControls() {
  const remote = controls.useRemoteOracle.checked;
  const disabled = remote || saveControlsBlocked();
  myControls.targetTitleId.disabled = disabled;
  myControls.applyReRegionBtn.disabled = disabled;
  myControls.reRegionBtn.disabled = disabled || !decryptedWorkspace;
  myControls.resignReRegionBtn.disabled = disabled || !selectedLocalSave;
  myControls.cancelReRegionBtn.disabled = saveControlsBlocked();
  myControls.targetTitleIdHint.textContent = remote
    ? uiText('Use the local worker to change the PPSA title.')
    : uiText('Leave blank to keep the title. A changed PPSA exports a new encrypted ZIP.');
  const title = myControls.targetTitleId.value.trim().toUpperCase();
  myControls.workspaceTargetTitle.hidden = !title || remote;
  myControls.workspaceTargetTitle.textContent = title ? uiText`ReRegion to ${title} when encrypting` : '';
}

// Function = Region Dialog
function openReRegion(opener = document.activeElement) {
  if (myControls.targetTitleId.disabled || (!decryptedWorkspace && !selectedLocalSave) || reRegionDraft) return;
  closeExportMenu();
  reRegionDraft = { value: myControls.targetTitleId.value, opener };
  const sources = workspaceSaves().map(save => save.titleId);
  const titles = [...new Set(sources.length ? sources : [workspaceDetails?.titleId || selectedLocalSave?.entry.title || ''])].filter(Boolean);
  myControls.reRegionCurrentTitle.textContent = titles.length > 1 ? uiText('Multiple PPSAs') : titles[0] || uiText('Not available');
  myControls.reRegionCurrentTitle.title = titles.join(', ');
  const scope = myControls.reRegionScope;
  scope.hidden = workspaceSaves().length < 2;
  scope.textContent = workspaceSaves().length > 1 ? uiText`Applies to all ${workspaceSaves().length} saves when encrypting.` : '';
  myControls.reRegionError.textContent = '';
  myControls.targetTitleId.removeAttribute('aria-invalid');
  openSaveDialog(myControls.reRegionDialog);
  myControls.targetTitleId.focus();
  myControls.targetTitleId.select();
}

// Function = Region Closing
function closeReRegion(restore = true) {
  if (!reRegionDraft) return;
  const previous = reRegionDraft;
  reRegionDraft = null;
  if (restore) myControls.targetTitleId.value = previous.value;
  closeSaveDialog(myControls.reRegionDialog);
  updateTitleControls();
  if (previous.opener?.isConnected) previous.opener.focus();
}

// Function = Save Dialogs
function openSaveDialog(dialog) {
  if (dialog.open) return;
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function closeSaveDialog(dialog) {
  if (!dialog.open) return;
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

myControls.reRegionBtn.addEventListener('click', () => openReRegion(myControls.workspaceMoreBtn));
myControls.resignReRegionBtn.addEventListener('click', () => openReRegion(myControls.saveMoreBtn));
myControls.reRegionForm.addEventListener('submit', event => {
  event.preventDefault();
  if (!reRegionDraft || myControls.applyReRegionBtn.disabled) return;
  const title = myControls.targetTitleId.value.trim().toUpperCase();
  if (title && !/^PPSA\d{5}$/.test(title)) {
    myControls.reRegionError.textContent = uiText('Enter PPSA followed by five digits, for example PPSA12345.');
    myControls.targetTitleId.setAttribute('aria-invalid', 'true');
    myControls.targetTitleId.focus();
    return;
  }
  myControls.targetTitleId.value = title;
  myControls.targetTitleId.removeAttribute('aria-invalid');
  closeReRegion(false);
});
myControls.cancelReRegionBtn.addEventListener('click', () => { if (!myControls.cancelReRegionBtn.disabled) closeReRegion(); });
myControls.reRegionDialog.addEventListener('cancel', event => { event.preventDefault(); if (!myControls.cancelReRegionBtn.disabled) closeReRegion(); });
myControls.reRegionDialog.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); if (!myControls.cancelReRegionBtn.disabled) closeReRegion(); }
});

function selectedTargetTitleId(sourceTitleId, saves = []) {
  if (controls.useRemoteOracle.checked) return '';
  const title = myControls.targetTitleId.value.trim().toUpperCase();
  if (!title) return '';
  if (!/^PPSA\d{5}$/.test(title)) throw new Error('Enter a target title as PPSA followed by five digits, for example PPSA12345.');
  myControls.targetTitleId.value = title;
  const sources = saves.map(save => save.titleId);
  return (sources.length ? sources : [sourceTitleId]).every(source => title === String(source || '').toUpperCase()) ? '' : title;
}

// Function = Workspace Saves
function workspaceSaves() {
  return Array.isArray(workspaceDetails?.saves) && workspaceDetails.saves.length > 1 ? workspaceDetails.saves : [];
}

// Function = Workspace Account
function workspaceAccountId() {
  const saves = workspaceSaves();
  if (!saves.length) return workspaceDetails?.accountId || '';
  const ids = new Set(saves.map(save => String(save.accountId || '').toLowerCase()));
  return ids.size === 1 ? [...ids][0] : '';
}

for (const control of [controls.useRemoteOracle, document.getElementById('cmpWorker')]) {
  control?.addEventListener('change', () => {
    if (controls.useRemoteOracle.checked) { closeReRegion(); myControls.targetTitleId.value = ''; }
    updateTitleControls();
  });
}

function setMyOperation(value) {
  if (value) editorScroller?.pause();
  mySaveOperation = value;
  myControls.localConsoleSelect.disabled = value;
  myControls.localUserSelect.disabled = value;
  cmpLayout.setLibraryBusy(value);
  for (const button of document.querySelectorAll('#libraryPage button')) button.disabled = value;
  myControls.resignAccountId.disabled = value;
  myControls.encryptAccountId.disabled = value;
  myControls.workspaceFiles.style.pointerEvents = value ? 'none' : '';
  workspaceTree?.setBusy(value || accountClosing);
  savedAccounts?.setBusy(value || accountClosing);
  updateMyFileActions();
  updateTitleControls();
  if (!value) editorScroller?.sync();
}

async function runMyOperation(action) {
  if (accountClosing || mySaveOperation || activeTransfer || browseSessionActive) {
    myStatus(uiText('Finish the current transfer or save operation first.'));
    return null;
  }
  const operation = ++myOperationSequence;
  activeTransfer = 'save-editor';
  setMyOperation(true);
  busy(true);
  try {
    return await action();
  } catch (error) {
    if (myCancelOperation === operation) {
      myStatus(uiText('Save operation canceled.'));
      status(uiText('Save operation canceled.'));
      myLog(uiText('Save operation canceled.'));
    } else {
      myStatus(error.message);
      myLog(uiText`Error: ${error.message}`);
    }
    return null;
  } finally {
    if (myOperationSequence === operation) {
      if (myCancelOperation === operation) myCancelOperation = 0;
      if (activeTransfer === 'save-editor') activeTransfer = null;
      setMyOperation(false);
      busy(Boolean(activeTransfer));
    }
  }
}

// Function = Save Confirmation
async function confirmSaveAction(message) {
  const cancellation = myCancellationSequence;
  const confirmed = await confirmAction(message);
  return confirmed && cancellation === myCancellationSequence;
}

// Function = Save Cancellation
async function cancelMySaveOperation() {
  if (!mySaveOperation || activeTransfer !== 'save-editor') return;
  const operation = myOperationSequence;
  if (myCancelOperation === operation) return;
  myCancelOperation = operation;
  myCancellationSequence++;
  controls.cancelBtn.disabled = true;
  myStatus(uiText('Canceling the save operation…'));
  status(uiText('Canceling the save operation…'));
  try {
    const canceled = typeof window.saveEditor.cancel === 'function' && await window.saveEditor.cancel();
    if (myOperationSequence !== operation || !mySaveOperation || activeTransfer !== 'save-editor') return;
    if (!canceled) {
      if (myCancelOperation === operation) myCancelOperation = 0;
      if (mySaveOperation) {
        const message = 'Close any open file dialog or wait for this step to finish.';
        myStatus(message);
        status(message);
      }
    }
  } catch (error) {
    if (myCancelOperation === operation) myCancelOperation = 0;
    if (myOperationSequence === operation && mySaveOperation && activeTransfer === 'save-editor') {
      myStatus(uiText`Could not cancel the save operation: ${error.message}`);
      status(uiText`Could not cancel the save operation: ${error.message}`);
    }
  } finally {
    if (myOperationSequence === operation && mySaveOperation && activeTransfer === 'save-editor' && myCancelOperation !== operation) controls.cancelBtn.disabled = false;
  }
}

// Function = Save File Key
function localSaveKey(save) { return window.SaveTreeBridge.fileKey(save.entry, save.file); }

// Function = Save Source
function localSaveOptions(save = selectedLocalSave) {
  return { ...(save.entry.localSource === 'pc' ? { localSource: 'pc' } : { assets: options().assets }),
    entryId: save.entry.id, filename: save.file.file };
}

// Function = Save Options
function saveJobOptions() {
  const current = options();
  return { serverUrl: current.serverUrl, workerKey: current.workerKey,
    useRemoteOracle: current.useRemoteOracle, oracleHost: current.oracleHost };
}

// Function = Temporary Release
async function releaseSaveTemporary(id) {
  if (!id || typeof window.saveEditor.releaseTemporary !== 'function') return;
  try { await window.saveEditor.releaseTemporary(id); }
  catch (error) { myLog(uiText`Could not clear temporary save files: ${error.message}`); }
}

// Function = Empty Source
function emptyLocalMessage() {
  return localPcMode ? (localPcInventory.root ? 'No supported encrypted PS5 saves found in this folder.' : 'Choose a Saves folder on your PC to get started.')
    : 'Download a save with the Transfer tab, or decrypt another save.';
}

// Function = Source Users
function renderLocalUsers(ids, users) {
  const previous = myControls.localUserSelect.value;
  myControls.localUserSelect.replaceChildren();
  const all = document.createElement('option'); all.value = ''; all.textContent = uiText('All users');
  myControls.localUserSelect.appendChild(all);
  for (const value of ids) {
    const id = String(value).toLowerCase(), name = users.find(user => String(user.id).toLowerCase() === id)?.name;
    const option = document.createElement('option'); option.value = id;
    option.textContent = id === 'unassigned' ? uiText('Unassigned') : name && name !== id ? `${name} (${id})` : id;
    myControls.localUserSelect.appendChild(option);
  }
  myControls.localUserSelect.value = ids.some(id => String(id).toLowerCase() === previous) ? previous : '';
}

// Function = Local Tree
const libraryTree = window.SaveTreeBridge.library({
  layout: cmpLayout, onOpen: (save) => selectMySave(save),
  onAction: (action) => myControls[action].click(), isBusy: () => accountClosing || mySaveOperation,
});

// Function = Search Saves
function searchedMySaves() {
  const query = myControls.mySavesSearch.value;
  if (!query.trim()) return mySaves;
  return mySaves.filter((save) => window.DownloadSearch.matches(
    { ...save.entry, files: [save.file] }, query, cmpLocalUsers,
  ));
}

function myTitleGroups(saves = mySaves) {
  const groups = new Map();
  for (const save of saves) {
    const key = save.entry.title || save.entry.name;
    if (!groups.has(key)) groups.set(key, { key, name: save.entry.name || save.entry.title, titleId: save.entry.title, saves: [], bytes: 0 });
    const group = groups.get(key);
    group.saves.push(save);
    group.bytes += save.file.size;
  }
  return groups;
}

function selectMyTitle(title) {
  selectedTitle = title;
  selectedLocalSave = null;
  myControls.selectedSavePanel.hidden = true;
  renderMySaves();
  const group = myTitleGroups().get(title);
  myStatus(uiText`${group.name}: ${group.saves.length} save file(s). Select one to continue.`);
}

let saveContextMenu = null;

function closeSaveContextMenu() {
  if (saveContextMenu) saveContextMenu.remove();
  saveContextMenu = null;
}

document.addEventListener('pointerdown', (event) => {
  if (saveContextMenu && !saveContextMenu.contains(event.target)) closeSaveContextMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeSaveContextMenu();
});
window.addEventListener('blur', closeSaveContextMenu);

function openSaveContextMenu(event, actions, position = event) {
  event.preventDefault();
  event.stopPropagation();
  closeSaveContextMenu();
  if (accountClosing || mySaveOperation || activeTransfer || browseSessionActive) return;
  saveContextMenu = document.createElement('div');
  saveContextMenu.className = 'save-context-menu';
  saveContextMenu.setAttribute('role', 'menu');
  for (const action of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    button.setAttribute('role', 'menuitem');
    button.addEventListener('click', () => {
      closeSaveContextMenu();
      action.run();
    });
    saveContextMenu.appendChild(button);
  }
  document.body.appendChild(saveContextMenu);
  const bounds = saveContextMenu.getBoundingClientRect();
  saveContextMenu.style.left = `${Math.max(8, Math.min(position.clientX || 8, window.innerWidth - bounds.width - 8))}px`;
  saveContextMenu.style.top = `${Math.max(8, Math.min(position.clientY || 8, window.innerHeight - bounds.height - 8))}px`;
  saveContextMenu.querySelector('button')?.focus();
}

function attachSaveContextMenu(row, actions, select) {
  row.tabIndex = 0;
  row.addEventListener('contextmenu', (event) => openSaveContextMenu(event, actions));
  row.addEventListener('keydown', (event) => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      const bounds = row.getBoundingClientRect();
      openSaveContextMenu(event, actions, { clientX: bounds.left + 20, clientY: bounds.bottom });
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      select();
    }
  });
}

function localSaveActions(save) {
  const action = (label, control) => ({
    label,
    run: async () => {
      if (accountClosing || mySaveOperation || activeTransfer || browseSessionActive) return;
      if (!await selectMySave(save)) return;
      if (control) myControls[control].click();
    },
  });
  return [
    action('Select save'),
    action('Decrypt & edit', 'mySaveDecryptBtn'),
    action('Upload to PS5', 'uploadSaveBtn'),
    action('Decrypt and export', 'decryptExportBtn'),
    action('Export original', 'mySaveExportBtn'),
    action('Import replacement…', 'mySaveImportBtn'),
    action('Resign', 'mySaveResignBtn'),
  ];
}

function renderMySaves() {
  closeSaveContextMenu();
  const query = myControls.mySavesSearch.value.trim();
  const searched = searchedMySaves();
  myControls.mySavesSearchCount.hidden = !query || !mySaves.length;
  myControls.mySavesSearchCount.textContent = query
    ? uiText`· ${searched.length} of ${mySaves.length} saves in ${myTitleGroups(searched).size} titles` : '';
  if (cmpLayout.active) {
    libraryTree.render({ saves: searched, users: cmpLocalUsers,
      filter: myControls.localUserSelect.value.toLowerCase(), busy: mySaveOperation, selected: selectedLocalSave,
      emptyText: query && mySaves.length ? uiText`No saves match “${query}”.` : undefined });
    return;
  }
  renderClassicMySaves();
}

// Function = Empty Search
function emptySearchRow(tbody, colSpan, message) {
  const row = document.createElement('tr'), cell = document.createElement('td');
  cell.colSpan = colSpan; cell.className = 'empty'; cell.textContent = message;
  row.appendChild(cell); tbody.appendChild(row);
}

// Function = Classic Save List
function renderClassicMySaves() {
  const allGroups = myTitleGroups();
  const query = myControls.mySavesSearch.value.trim();
  const groups = query ? myTitleGroups(searchedMySaves()) : allGroups;
  const selectedGroup = selectedTitle ? allGroups.get(selectedTitle) : null;
  if (selectedTitle && !selectedGroup) selectedTitle = null;
  myControls.myTitleList.hidden = Boolean(selectedTitle);
  myControls.myTitleSaveList.hidden = !selectedTitle;
  myControls.mySavesBackBtn.hidden = !selectedTitle;
  myControls.mySavesLibraryLabel.textContent = selectedGroup ? selectedGroup.name : uiText('All titles');
  myControls.myTitleEntries.replaceChildren();
  myControls.mySaveEntries.replaceChildren();
  if (!mySaves.length) {
    emptySearchRow(myControls.myTitleEntries, 4, emptyLocalMessage());
    return;
  }
  if (!selectedTitle) {
    if (!groups.size) emptySearchRow(myControls.myTitleEntries, 4, uiText`No saves match “${query}”.`);
    for (const group of groups.values()) {
      const full = allGroups.get(group.key);
      const row = document.createElement('tr');
      const title = document.createElement('td');
      title.textContent = group.name;
      if (group.titleId && group.titleId !== group.name) {
        const titleId = document.createElement('span');
        titleId.className = 'title-id';
        titleId.textContent = group.titleId;
        title.appendChild(titleId);
      }
      const count = document.createElement('td');
      count.textContent = group.saves.length === full.saves.length
        ? `${full.saves.length}` : `${group.saves.length} / ${full.saves.length}`;
      const size = document.createElement('td');
      size.textContent = `${(full.bytes / 0x100000).toFixed(1)} MiB`;
      const actions = document.createElement('td');
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'secondary';
      open.textContent = uiText('View saves');
      open.addEventListener('click', (event) => { event.stopPropagation(); selectMyTitle(group.key); });
      actions.appendChild(open);
      row.append(title, count, size, actions);
      row.addEventListener('click', () => selectMyTitle(group.key));
      attachSaveContextMenu(row, [{ label: 'View saves', run: () => selectMyTitle(group.key) }], () => selectMyTitle(group.key));
      myControls.myTitleEntries.appendChild(row);
    }
    return;
  }
  const saves = query ? (groups.get(selectedTitle)?.saves || []) : selectedGroup.saves;
  if (!saves.length) emptySearchRow(myControls.mySaveEntries, 3, uiText`No saves in this title match “${query}”.`);
  for (const save of saves) {
    const row = document.createElement('tr');
    if (selectedLocalSave && localSaveKey(selectedLocalSave) === localSaveKey(save)) row.className = 'selected';
    const file = document.createElement('td');
    file.textContent = save.file.file;
    const entryLabel = document.createElement('span');
    entryLabel.className = 'title-id';
    entryLabel.textContent = uiText`Entry ${save.entry.id}`;
    file.appendChild(entryLabel);
    const size = document.createElement('td');
    size.textContent = `${(save.file.size / 0x100000).toFixed(1)} MiB`;
    const actions = document.createElement('td');
    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'secondary';
    select.textContent = selectedLocalSave && localSaveKey(selectedLocalSave) === localSaveKey(save) ? uiText('Selected') : uiText('Select');
    select.addEventListener('click', (event) => { event.stopPropagation(); selectMySave(save); });
    actions.appendChild(select);
    row.append(file, size, actions);
    row.addEventListener('click', () => selectMySave(save));
    attachSaveContextMenu(row, localSaveActions(save), () => selectMySave(save));
    myControls.mySaveEntries.appendChild(row);
  }
}

myControls.mySavesSearch.addEventListener('input', () => renderMySaves());
myControls.mySavesSearch.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && myControls.mySavesSearch.value) {
    event.preventDefault();
    event.stopPropagation();
    myControls.mySavesSearch.value = '';
    renderMySaves();
  }
});

myControls.mySavesBackBtn.addEventListener('click', () => {
  selectedTitle = null;
  selectedLocalSave = null;
  myControls.selectedSavePanel.hidden = true;
  renderMySaves();
  goToLibraryStep(0);
  myStatus(uiText('Select a title to see its saves.'));
});

// Function = Save Selection
function applyMySaveSelection(save) {
  if (!selectedLocalSave || localSaveKey(selectedLocalSave) !== localSaveKey(save)) myControls.targetTitleId.value = '';
  selectedLocalSave = save;
  myControls.selectedSavePanel.hidden = false;
  myControls.selectedSaveName.textContent = save.entry.name || save.entry.title;
  myControls.selectedSaveDetails.textContent = uiText`${save.file.file} · Entry ${save.entry.id} · ${(save.file.size / 0x100000).toFixed(1)} MiB · ${save.entry.title}`;
  myControls.resignPanel.hidden = true;
  renderMySaves();
  goToLibraryStep(1);
  myStatus(uiText`${save.file.file} selected. Choose what you want to do next.`);
  return true;
}

function selectMySave(save) {
  if (accountClosing || mySaveOperation || activeTransfer || browseSessionActive) return false;
  if (!decryptedWorkspace || (selectedLocalSave && localSaveKey(save) === localSaveKey(selectedLocalSave))) {
    return applyMySaveSelection(save);
  }
  return runMyOperation(async () => {
    if (!await confirmSaveAction(workspaceModified || editorDirty
      ? 'Discard changes that have not been encrypted and select another save?'
      : 'Close the current decrypted files before selecting another save?')) return false;
    await closeMyWorkspace(true);
    return applyMySaveSelection(save);
  });
}

// Function = Local Profile
async function selectLocalConsole(profileId, { inventory, persist = true, confirmed = false } = {}) {
  const pc = profileId === LOCAL_PC_SOURCE;
  const profile = localProfiles.find((candidate) => candidate.id === profileId);
  const nextPath = pc ? (inventory || localPcInventory).root || LOCAL_PC_SOURCE : profile?.path;
  const switching = localPcMode !== pc || loadedLocalPath !== nextPath;
  if (switching && decryptedWorkspace && !confirmed && !await confirmSaveAction(workspaceModified || editorDirty
    ? 'Discard changes that have not been encrypted and switch sources?'
    : 'Switch sources and close the current decrypted files?')) {
    myControls.localConsoleSelect.value = selectedLocalSource;
    return;
  }
  const selection = ++cmpLocalRequest;
  ++cmpInventoryRequest;
  if (switching) {
    cmpLayout.resetLibrary();
    if (decryptedWorkspace) await closeMyWorkspace(true);
    selectedTitle = null; selectedLocalSave = null;
    myControls.selectedSavePanel.hidden = true;
    myControls.localUserSelect.value = '';
  }
  localPcMode = pc;
  selectedLocalSource = profileId;
  myControls.chooseLocalPcFolderBtn.hidden = !pc;
  myControls.localPcFolderLabel.hidden = !pc;
  if (persist && typeof window.saveTransfer.setLocalPcActive === 'function') await window.saveTransfer.setLocalPcActive(pc);
  if (selection !== cmpLocalRequest) return;
  if (pc) {
    localPcInventory = inventory || (typeof window.saveTransfer.localPcInventory === 'function' ? await window.saveTransfer.localPcInventory() : localPcInventory);
    if (selection !== cmpLocalRequest) return;
    loadedLocalPath = localPcInventory.root || LOCAL_PC_SOURCE;
    myControls.localPcFolderLabel.textContent = localPcInventory.root || uiText('Choose a Saves folder with encrypted PS5 save files.');
    cmpLocalUsers = localPcInventory.users || [];
    renderLocalUsers(cmpLocalUsers.map(user => user.id), cmpLocalUsers);
    await refreshMySaves(localPcInventory);
    myStatus(mySaves.length ? uiText`Local PC: ${mySaves.length} save file(s).` : emptyLocalMessage());
    return;
  }
  if (!profile) {
    loadedLocalPath = null; cmpLocalRequest++; cmpInventoryRequest++;
    cmpLayout.resetLibrary();
    selectedTitle = null; selectedLocalSave = null;
    myControls.selectedSavePanel.hidden = true;
    cmpLocalUsers = [];
    mySaves = [];
    renderMySaves();
    myStatus(uiText('No downloaded saves were found in this profile.'));
    return;
  }
  loadedLocalPath = profile.path;
  controls.output.value = profile.path;
  controls.assets.value = profile.path;
  controls.metadata.value = '';
  cmpLocalUsers = profile.users.map((id) => ({ id, name: id }));
  try {
    const users = await window.saveTransfer.users(folderPaths.metadataPath(profile.path, 'metadata.db'));
    if (selection !== cmpLocalRequest) return;
    cmpLocalUsers = users;
  } catch { /* Older local saves may have no user catalogue. */ }
  if (selection !== cmpLocalRequest) return;
  renderLocalUsers(profile.users, cmpLocalUsers);
  await refreshMySaves();
  myStatus(uiText`${profile.id}: ${mySaves.length} save file(s)${myControls.localUserSelect.value ? ` for ${myControls.localUserSelect.value}` : ''}.`);
}

async function loadLocalProfiles() {
  const request = ++localProfileRequest, previous = selectedLocalSource;
  const root = profileRoot || options().output;
  const [result, pcState] = await Promise.all([
    window.saveTransfer.localProfiles(root).catch(error => {
      myLog(uiText`Console profiles unavailable: ${error.message}`);
      return { profiles: [] };
    }),
    typeof window.saveTransfer.localPcState === 'function' ? window.saveTransfer.localPcState() : localPcInventory,
  ]);
  if (request !== localProfileRequest) return;
  localProfiles = result.profiles || [];
  localPcInventory = pcState.root === localPcInventory.root
    ? { ...localPcInventory, ...pcState }
    : { ...pcState, entries: [], users: [] };
  const current = options().assets.split(/[\\/]/).pop();
  const selected = localProfiles.find((profile) => profile.id === current) || localProfiles[0];
  myControls.localConsoleSelect.replaceChildren();
  const pc = document.createElement('option'); pc.value = LOCAL_PC_SOURCE; pc.textContent = uiText('Local PC');
  myControls.localConsoleSelect.appendChild(pc);
  for (const profile of localProfiles) {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = uiText`${profile.name ? `${profile.name} — ` : ''}${profile.id} (${profile.save_count} saves)`;
    myControls.localConsoleSelect.appendChild(option);
  }
  if (previous === LOCAL_PC_SOURCE || (!previous && pcState.active) || !selected) {
    const pcInventory = typeof window.saveTransfer.localPcInventory === 'function' ? await window.saveTransfer.localPcInventory() : localPcInventory;
    if (request !== localProfileRequest) return;
    myControls.localConsoleSelect.value = LOCAL_PC_SOURCE;
    await selectLocalConsole(LOCAL_PC_SOURCE, { inventory: pcInventory, persist: false });
  } else if (selected) {
    myControls.localConsoleSelect.value = selected.id;
    await selectLocalConsole(selected.id, { persist: false });
  } else {
    await selectLocalConsole('');
  }
}

myControls.localConsoleSelect.addEventListener('change', () => runMyOperation(() => selectLocalConsole(myControls.localConsoleSelect.value)));

// Function = PC Folder
myControls.chooseLocalPcFolderBtn.addEventListener('click', () => runMyOperation(async () => {
  if (!localPcMode) return;
  if (decryptedWorkspace && !await confirmSaveAction(workspaceModified || editorDirty
    ? 'Choose another folder and discard changes that have not been encrypted?'
    : 'Choose another folder and close the current decrypted files?')) return;
  const inventory = await window.saveTransfer.chooseLocalPcFolder();
  if (!inventory) return;
  ++localProfileRequest;
  await selectLocalConsole(LOCAL_PC_SOURCE, { inventory, persist: false, confirmed: true });
}));
myControls.localUserSelect.addEventListener('change', () => runMyOperation(async () => {
  selectedTitle = null;
  selectedLocalSave = null;
  myControls.selectedSavePanel.hidden = true;
  await refreshMySaves(localPcMode ? localPcInventory : undefined);
  myStatus(uiText`${mySaves.length} save file(s) in this view.`);
}));

// Function = Save Refresh
async function refreshMySaves(inventory) {
  const pc = localPcMode, assets = pc ? loadedLocalPath : options().assets, owner = myControls.localUserSelect.value.toLowerCase();
  const request = ++cmpInventoryRequest;
  const result = pc ? inventory || await window.saveTransfer.localPcInventory() : await window.saveTransfer.localSaves(assets);
  if (request !== cmpInventoryRequest || pc !== localPcMode || assets !== (pc ? loadedLocalPath : options().assets)
      || owner !== myControls.localUserSelect.value.toLowerCase()) return mySaves.length;
  if (pc) {
    if ((result.root || LOCAL_PC_SOURCE) !== loadedLocalPath) return mySaves.length;
    localPcInventory = result; cmpLocalUsers = result.users || [];
    renderLocalUsers(cmpLocalUsers.map(user => user.id), cmpLocalUsers);
  }
  const filter = myControls.localUserSelect.value.toLowerCase();
  mySaves = (result.entries || [])
    .filter((entry) => !filter || entry.owner.toLowerCase() === filter)
    .flatMap((entry) => entry.files.map((file) => ({ entry, file })));
  if (selectedLocalSave) {
    selectedLocalSave = mySaves.find((save) => localSaveKey(save) === localSaveKey(selectedLocalSave)) || null;
    myControls.selectedSavePanel.hidden = !selectedLocalSave;
  }
  renderMySaves();
  for (const warning of result.warnings || []) myLog(uiText`Skipped invalid save metadata: ${warning}`);
  return mySaves.length;
}

// Function = Save Busy
function saveControlsBlocked() {
  return mySaveOperation || accountClosing || Boolean(activeTransfer) || browseSessionActive;
}

// Function = Editor Controls
function updateMyFileActions() {
  const blocked = saveControlsBlocked();
  const readOnly = Boolean(selectedWorkspaceFile?.readOnly);
  const editable = !blocked && selectedWorkspaceFile && !readOnly;
  const encryptionBlocked = blocked || !decryptedWorkspace || Boolean(workspaceDetails?.batchError);
  for (const button of editorButtons) button.disabled = blocked;
  myControls.fileEditor.disabled = blocked || readOnly;
  myControls.editorMode.disabled = blocked;
  for (const input of editorInputs) input.disabled = blocked;
  myControls.deleteFileBtn.disabled = !editable || selectedWorkspaceFile.protected;
  myControls.saveFileBtn.disabled = !editable || selectedFileBytes === null;
  myControls.saveEncryptFileBtn.disabled = myControls.saveFileBtn.disabled || encryptionBlocked;
  myControls.encryptSaveBtn.disabled = encryptionBlocked;
  myControls.confirmEncryptBtn.disabled = encryptionBlocked;
  myControls.downloadFileBtn.disabled = blocked || !selectedWorkspaceFile;
  if (myControls.replaceFileBtn) myControls.replaceFileBtn.disabled = !editable;
}

// Function = Workspace Tree
workspaceTree = window.WorkspaceTree?.create(document, myControls.workspaceFiles, {
  onSelect: file => { selectedWorkspacePath = file.path; },
  getWorkspaceActions: () => [
    { action: 'add-account', label: 'Add Account…', disabled: myControls.addCurrentAccountBtn.disabled, title: myControls.addCurrentAccountBtn.title },
    { action: 'reregion', label: 'ReRegion…', disabled: myControls.reRegionBtn.disabled, title: controls.useRemoteOracle.checked ? uiText('Use the local worker to change the PPSA title.') : '' },
  ],
  onOpen: file => runMyOperation(() => openWorkspaceFile(file)),
  onAction: (action, file) => {
    if (action === 'add-account') { savedAccounts?.addCurrentAccount(document.activeElement); closeExportMenu(); return; }
    if (action === 'reregion') return openReRegion();
    return runMyOperation(() => {
      if (action === 'replace') return replaceWorkspaceFile(file);
      if (action === 'export') return exportWorkspaceFile(file);
      if (action === 'delete') return deleteWorkspaceFile(file);
    });
  },
  isBusy: saveControlsBlocked,
});

// Function = Update Header
function renderWorkspaceSummary(saves) {
  const titles = new Set(saves.map(save => save.titleId));
  myControls.workspaceCounts.textContent = saves.length
    ? uiText`${saves.length} saves · ${workspaceDetails.files.length} file(s)`
    : uiText`1 save · ${workspaceDetails.files.length} file(s)`;
  const titleId = saves.length ? (titles.size === 1 ? [...titles][0] : '') : workspaceDetails.titleId;
  myControls.workspaceGameId.textContent = titles.size > 1 ? uiText('Multiple PPSAs') : titleId || uiText('Unknown title');
  myControls.workspaceGameId.title = [...titles].join(', ');
  const nameFor = (id, name) => {
    if (name && name !== 'Unknown title') return name;
    return selectedLocalSave?.entry.title === id && selectedLocalSave.entry.name
      ? selectedLocalSave.entry.name : uiText('Unknown title');
  };
  const gameNames = [...new Set(saves.length ? saves.map(save => nameFor(save.titleId, save.gameName)) : [nameFor(titleId, workspaceDetails.gameName)])];
  myControls.workspaceGameName.textContent = gameNames.length > 1 ? uiText('Multiple games') : gameNames[0];
  myControls.workspaceGameName.title = gameNames.join(', ');
}

function renderWorkspace() {
  myControls.workspacePanel.hidden = !decryptedWorkspace;
  const error = workspaceDetails?.batchError;
  myControls.workspaceBatchWarning.hidden = !error;
  myControls.workspaceBatchWarning.textContent = error ? uiText`Encryption unavailable: ${error}` : '';
  updateMyFileActions();
  if (!decryptedWorkspace || !workspaceDetails) return;
  goToLibraryStep(2);
  const saves = workspaceSaves();
  renderWorkspaceSummary(saves);
  myControls.encryptSaveBtn.textContent = saves.length ? uiText`Encrypt all ${saves.length} saves` : uiText('Save & encrypt');
  const newAccountWorkspace = accountWorkspace !== decryptedWorkspace;
  if (newAccountWorkspace) myControls.targetTitleId.value = '';
  accountWorkspace = decryptedWorkspace;
  const currentAccountId = workspaceAccountId();
  savedAccounts?.setCurrentAccount(currentAccountId);
  const mixedAccounts = saves.length > 1 && !currentAccountId;
  myControls.workspaceAccountId.hidden = mixedAccounts;
  myControls.workspaceBatchAccountId.hidden = !mixedAccounts;
  myControls.encryptAccountId.value = savedAccounts
    ? savedAccounts.getTargetId(newAccountWorkspace ? currentAccountId : myControls.encryptAccountId.value || currentAccountId)
    : currentAccountId || myControls.encryptAccountId.value;
  if (workspaceTree) {
    workspaceTree.render(workspaceDetails.files, selectedWorkspacePath, decryptedWorkspace);
    return;
  }
  myControls.workspaceFiles.replaceChildren();
  for (const file of workspaceDetails.files) {
    const row = document.createElement('tr');
    row.dataset.filePath = file.path;
    if (file.readOnly) row.title = uiText('chives.json is read-only.');
    if (selectedWorkspacePath === file.path) row.className = 'selected';
    const name = document.createElement('td');
    name.textContent = file.path;
    const size = document.createElement('td');
    size.textContent = file.size < 1024 ? `${file.size} B` : `${(file.size / 1024).toFixed(1)} KiB`;
    row.append(name, size);
    row.addEventListener('click', () => { selectedWorkspacePath = file.path; renderWorkspace(); });
    row.addEventListener('dblclick', () => runMyOperation(() => openWorkspaceFile(file)));
    myControls.workspaceFiles.appendChild(row);
  }
}

function bytesToHex(bytes, offset = 0) {
  return window.EditorBytes.formatHex(bytes, offset);
}

function editorBytes(mode = myControls.editorMode.value) {
  return window.EditorBytes.parse(myControls.fileEditor.value, mode);
}

// Function = Check Text
function losslessEditorText(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  // A textarea converts CR and CRLF to LF.
  if (!text.includes('\r')) {
    const encoded = new TextEncoder().encode(text);
    if (encoded.length === bytes.length && bytes.every((byte, index) => byte === encoded[index])) return text;
  }
  throw new Error('Text would change the file bytes.');
}

// Function = Count Bytes
function updateEditorByteCount() {
  let count = selectedFileBytes?.length || 0;
  if (pagedEditor ? editorPageChanged : editorDirty) {
    try { count = window.EditorBytes.count(myControls.fileEditor.value, myControls.editorMode.value); } catch {}
  }
  if (pagedEditor) {
    const resized = editorPageChanged && count !== editorVisibleLength;
    editorVisibleLength = count;
    count += pagedEditor.size - selectedFileBytes.length;
    if (resized) editorScroller.sync();
  }
  myControls.editorByteCount.textContent = uiText`${count} byte${count === 1 ? '' : 's'}`;
}

// Function = Reset Draft
function resetEditorDraft() {
  clearTimeout(editorCountTimer);
  editorCountTimer = null;
  editorRevision++;
  editorParsedDraft = null;
  editorSearchState = null;
}

// Function = Queue Count
function queueEditorByteCount() {
  clearTimeout(editorCountTimer);
  const revision = editorRevision;
  editorCountTimer = setTimeout(() => {
    editorCountTimer = null;
    if (revision === editorRevision && selectedWorkspaceFile && myControls.fileEditorDialog.open) updateEditorByteCount();
  }, 100);
}

// Function = Select Bytes
function selectEditorBytes(offset, length = 1) {
  const editor = myControls.fileEditor;
  const range = window.EditorBytes.byteRange(editor.value, myControls.editorMode.value, offset, length);
  if (!range) return;
  editor.focus();
  editor.setSelectionRange(range.start, range.end);
  editor.scrollTop = Math.max(0, editor.scrollHeight * (range.start / Math.max(1, editor.value.length)) - 40);
}

// Function = Find Text
function findEditorText(text, query, cursor) {
  const folded = text.toLowerCase();
  const needle = query.toLowerCase();
  const expanded = folded.length !== text.length;
  const from = expanded ? text.slice(0, cursor).toLowerCase().length : cursor;
  let index = folded.indexOf(needle, from);
  if (index < 0 && from > 0) index = folded.indexOf(needle);
  if (index < 0) return null;
  const end = index + needle.length;
  if (!expanded) return { start: index, end };

  let original = 0, foldedOffset = 0, start = 0;
  for (const character of text) {
    if (foldedOffset <= index) start = original;
    original += character.length;
    foldedOffset += character.toLowerCase().length;
    if (foldedOffset >= end) return { start, end: original };
  }
  return null;
}

// Function = Search Bytes
function editorSearchBytes(query) {
  const compact = query.replace(/\s+/g, '');
  if (compact.length % 2 === 0 && /^[0-9a-f]+$/i.test(compact)) {
    const needle = new Uint8Array(compact.length / 2);
    for (let index = 0; index < needle.length; index++) needle[index] = parseInt(compact.slice(index * 2, index * 2 + 2), 16);
    return needle;
  }
  return new TextEncoder().encode(query);
}

// Function = Find Match
function findInEditor() {
  if (!selectedFileBytes) return;
  const query = myControls.editorSearch.value;
  if (!query) return;
  if (pagedEditor) return navigateInEditor(() => findInPages(query));
  if (myControls.editorMode.value === 'text') {
    const editor = myControls.fileEditor;
    const match = findEditorText(editor.value, query, editor.selectionEnd);
    if (!match) { myStatus(uiText`Could not find ${query}.`); return; }
    editor.focus();
    editor.setSelectionRange(match.start, match.end);
    return;
  }
  const needle = editorSearchBytes(query);
  try {
    if (editorParsedDraft?.revision !== editorRevision) editorParsedDraft = { revision: editorRevision, bytes: editorBytes() };
  } catch (error) { myStatus(error.message); return; }
  const start = editorSearchState?.query === query && editorSearchState.revision === editorRevision ? editorSearchState.next : 0;
  const index = window.EditorBytes.find(editorParsedDraft.bytes, needle, start);
  if (index < 0) {
    myStatus(uiText`Could not find ${query}.`);
    return;
  }
  editorSearchState = { query, revision: editorRevision, next: index + 1 };
  selectEditorBytes(index, needle.length);
  myStatus(uiText`Found ${query} at 0x${index.toString(16)}.`);
}

// Function = Focus Match
async function navigateInEditor(action) {
  if (await runMyOperation(action)) myControls.fileEditor.focus({ preventScroll: true });
}

// Function = Find Across Pages
async function findInPages(query) {
  stageEditorPage();
  const mode = myControls.editorMode.value;
  const editor = myControls.fileEditor;
  let start = editorPageStart;
  if (editorSearchState?.query === query && editorSearchState.revision === editorRevision) start = editorSearchState.next;
  else if (mode === 'text') start += new TextEncoder().encode(editor.value.slice(0, editor.selectionEnd)).length;
  myStatus(uiText('Searching file…'));
  let match;
  if (mode === 'text') match = await pagedEditor.findText(query, start);
  else {
    const needle = editorSearchBytes(query);
    const offset = await pagedEditor.find(needle, start);
    if (offset >= 0) match = { offset, length: needle.length };
  }
  if (!match) { myStatus(uiText`Could not find ${query}.`); return; }
  await showEditorPage(match.offset, mode, match.length);
  const localOffset = match.offset - editorPageStart;
  selectEditorBytes(localOffset, Math.min(match.length, selectedFileBytes.length - localOffset));
  editorScroller.reveal(match.offset);
  editorSearchState = { query, revision: editorRevision, next: match.offset + (mode === 'text' ? match.length : 1) };
  myStatus(uiText`Found ${query} at 0x${match.offset.toString(16)}.`);
  return true;
}

// Function = Jump Offset
function goToEditorOffset() {
  if (!selectedFileBytes) return;
  const value = myControls.editorOffset.value.trim();
  if (!/^[0-9a-f]+$/i.test(value)) {
    myStatus(uiText('Enter a hexadecimal offset, for example 1b8.'));
    return;
  }
  if (pagedEditor) return navigateInEditor(async () => {
    stageEditorPage();
    if (!pagedEditor.size) { myStatus(uiText('The edited file is empty.')); return; }
    const offset = Math.min(parseInt(value, 16), pagedEditor.size - 1);
    await showEditorPage(offset);
    selectEditorBytes(offset - editorPageStart);
    editorScroller.reveal(offset);
    myStatus(uiText`Moved to offset 0x${offset.toString(16)}.`);
    return true;
  });
  let length;
  try { length = window.EditorBytes.count(myControls.fileEditor.value, myControls.editorMode.value); }
  catch (error) { myStatus(error.message); return; }
  if (!length) { myStatus(uiText('The edited file is empty.')); return; }
  const offset = Math.min(parseInt(value, 16), length - 1);
  selectEditorBytes(offset);
  myStatus(uiText`Moved to offset 0x${offset.toString(16)}.`);
}

// Function = Show Draft
function renderEditor(draft, mode, dirty) {
  myControls.fileEditorPanel.hidden = false;
  openSaveDialog(myControls.fileEditorDialog);
  myControls.editorFileName.textContent = selectedWorkspaceFile.path;
  myControls.editorMode.value = mode;
  myControls.fileEditor.value = draft;
  myControls.editorScroll.hidden = !pagedEditor;
  myControls.editorScroll.parentElement.classList.toggle('virtual-scroll', Boolean(pagedEditor));
  myControls.fileEditor.wrap = pagedEditor && mode === 'hex' ? 'off' : 'soft';
  editorPageChanged = false;
  resetEditorDraft();
  editorDirty = dirty;
  myControls.saveFileBtn.textContent = dirty ? uiText('Save changes *') : uiText('Save changes');
  myControls.editorHint.textContent = mode === 'hex'
    ? uiText('Offsets and hex bytes are on the left. The ASCII preview is on the right.')
    : uiText('Edit text directly. Switch to hex mode for byte-level editing.');
  updateEditorByteCount();
  updateMyFileActions();
}

async function openWorkspaceFile(file) {
  if (file.readOnly) { myStatus(uiText('chives.json is read-only.')); return; }
  if (editorDirty && !await confirmSaveAction('Discard unsaved changes to this file?')) return;
  const opener = [...myControls.workspaceFiles.querySelectorAll('tr[data-file-path]')].find(row => row.dataset.filePath === file.path) || document.activeElement;
  await readEditorFile(decryptedWorkspace, file.path, file);
  selectedWorkspacePath = file.path;
  editorOpener = opener;
  myControls.editorStatus.textContent = '';
  renderWorkspace();
}

// Function = Read Editor
async function readEditorFile(root, path, file = selectedWorkspaceFile, offset = 0, mode = 'hex') {
  let model = null, start = 0, bytes;
  if (file.size <= PAGED_EDITOR_THRESHOLD) {
    const result = await window.saveEditor.read({ root, path });
    if (!result.paged) bytes = window.EditorBytes.fromBase64(result.data);
  }
  if (!bytes) {
    model = await window.PagedEditor.open(range => window.saveEditor.readPage({ root, path, ...range }));
    if (mode === 'text') await model.validateText();
    ({ start, bytes } = await model.windowAt(offset, mode));
  }
  const draft = mode === 'text' ? losslessEditorText(bytes) : bytesToHex(bytes, start);
  editorScroller?.reset();
  selectedWorkspaceFile = file;
  pagedEditor = model;
  editorPageStart = start;
  selectedFileBytes = bytes;
  renderEditor(draft, mode, false);
  if (pagedEditor) { editorScroller.sync(); editorScroller.reveal(offset); }
}

// Function = Keep Page Edits
function stageEditorPage(mode = myControls.editorMode.value) {
  if (!editorPageChanged) return;
  const bytes = editorBytes(mode);
  pagedEditor.replace(editorPageStart, selectedFileBytes.length, bytes);
  selectedFileBytes = bytes;
  editorVisibleLength = bytes.length;
  editorPageChanged = false;
}

// Function = Display Page
async function showEditorPage(offset, mode = myControls.editorMode.value, span = 1, canRender) {
  const model = pagedEditor;
  const page = await model.windowAt(offset, mode, span);
  if (pagedEditor !== model || (canRender && !canRender())) return false;
  const draft = mode === 'text' ? losslessEditorText(page.bytes) : bytesToHex(page.bytes, page.start);
  editorPageStart = page.start;
  selectedFileBytes = page.bytes;
  renderEditor(draft, mode, pagedEditor.dirty);
  return true;
}

// Function = Scroll File
async function scrollEditorTo(offset) {
  if (!pagedEditor || saveControlsBlocked()) return false;
  const operation = myOperationSequence, revision = editorRevision;
  stageEditorPage();
  return showEditorPage(offset, myControls.editorMode.value, 1,
    () => operation === myOperationSequence && revision === editorRevision && !saveControlsBlocked());
}

// Function = Editor Closing
function hideEditorWindow() {
  resetEditorDraft();
  editorScroller?.reset();
  closeSaveDialog(myControls.fileEditorDialog);
  closeExportMenu();
  myControls.fileEditorPanel.hidden = true;
  myControls.fileEditor.value = '';
  selectedWorkspaceFile = null;
  selectedFileBytes = null;
  pagedEditor = null;
  editorPageStart = 0;
  editorPageChanged = false;
  editorDirty = false;
  const opener = editorOpener;
  editorOpener = null;
  if (opener?.isConnected && !opener.hidden) opener.focus();
}

async function closeFileEditor() {
  if (editorDirty && !await confirmSaveAction('Discard unsaved changes to this file?')) return;
  hideEditorWindow();
}

myControls.closeFileEditorBtn.addEventListener('click', () => runMyOperation(closeFileEditor));
// Function = Dismiss Editor
function dismissFileEditor(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!myControls.fileMoreOptions.hidden) {
    closeExportMenu();
    myControls.fileMoreBtn.focus();
    return;
  }
  void runMyOperation(closeFileEditor);
}
myControls.fileEditorDialog.addEventListener('cancel', dismissFileEditor);
myControls.fileEditorDialog.addEventListener('keydown', event => {
  if (event.key === 'Escape') dismissFileEditor(event);
});

// Function = Replace File
async function replaceWorkspaceFile(file) {
  const root = decryptedWorkspace;
  const current = workspaceDetails?.files.find(candidate => candidate.path === file.path);
  if (!root || !current || current.readOnly || typeof window.saveEditor.replace !== 'function') return;
  const path = current.path;
  const replacingEditor = selectedWorkspaceFile?.path === path;
  if (replacingEditor && editorDirty
    && !await confirmSaveAction('Discard unsaved changes to this file and replace it?')) return;
  const result = await window.saveEditor.replace({ root, path });
  if (!result || root !== decryptedWorkspace) return;
  workspaceDetails = result;
  workspaceModified = true;
  let editorNotice = '';
  if (replacingEditor) {
    const replacement = result.files.find(candidate => candidate.path === path);
    if (replacement) {
      try {
        await readEditorFile(root, path, replacement);
      } catch (error) {
        hideEditorWindow();
        editorNotice = ' Select the file again to retry opening it.';
        myLog(uiText`Replaced ${path}, but could not open it in the editor: ${error.message}`);
      }
    } else hideEditorWindow();
  } else if (selectedWorkspaceFile) {
    selectedWorkspaceFile = result.files.find(candidate => candidate.path === selectedWorkspaceFile.path) || selectedWorkspaceFile;
  }
  renderWorkspace();
  myStatus(uiText`${path} replaced in the decrypted workspace.${editorNotice}`);
  myLog(uiText`Replaced ${path} in the decrypted workspace.`);
}

// Function = Export File
async function exportWorkspaceFile(file) {
  if (!decryptedWorkspace || !workspaceDetails?.files.some(candidate => candidate.path === file.path)) return;
  const destination = await window.saveEditor.downloadFile({ root: decryptedWorkspace, path: file.path });
  if (destination) myStatus(uiText`File exported to ${destination}`);
}

// Function = Delete File
async function deleteWorkspaceFile(file) {
  const root = decryptedWorkspace;
  const current = workspaceDetails?.files.find(candidate => candidate.path === file.path);
  if (!root || !current || current.protected || current.readOnly) return;
  if (!await confirmSaveAction(`Delete ${current.path} from the decrypted workspace?`)) return;
  const result = await window.saveEditor.delete({ root, path: current.path });
  if (!result || root !== decryptedWorkspace) return;
  workspaceDetails = result;
  workspaceModified = true;
  myLog(uiText`Deleted ${current.path} from the decrypted workspace.`);
  if (selectedWorkspaceFile?.path === current.path) {
    hideEditorWindow();
  }
  renderWorkspace();
}

async function closeMyWorkspace(confirmed = false) {
  if ((editorDirty || workspaceModified) && confirmed !== true
    && !await confirmSaveAction('Discard changes that have not been encrypted and close the decrypted files?')) return;
  const temporaryId = decryptedTemporaryId;
  decryptedTemporaryId = null;
  decryptedWorkspace = null;
  decryptedArchive = null;
  workspaceDetails = null;
  hideEditorWindow();
  closeReRegion();
  selectedWorkspacePath = '';
  myControls.targetTitleId.value = '';
  workspaceTree?.reset();
  accountWorkspace = null;
  workspaceModified = false;
  renderWorkspace();
  myControls.encryptPanel.hidden = true;
  savedAccounts?.setCurrentAccount('');
  myControls.workspaceAccountId.hidden = false;
  myControls.workspaceBatchAccountId.hidden = true;
  goToLibraryStep(selectedLocalSave ? 1 : 0);
  myStatus(uiText('Decrypted files closed. Your original save is still selected.'));
  void releaseSaveTemporary(temporaryId);
}

async function decryptInputs(inputs, { external = false } = {}) {
  if (!inputs.length) return false;
  if (decryptedWorkspace && !await confirmSaveAction(workspaceModified || editorDirty
    ? 'Discard changes that have not been encrypted and decrypt another save?'
    : 'Close the current decrypted files before decrypting another save?')) return false;
  myStatus(uiText('Decrypting your save…'));
  const result = await window.saveEditor.run({
    operation: 'decrypt',
    inputs,
    platform: 'ps5',
    ...saveJobOptions(),
  });
  if (!result) return false;
  const previousTemporaryId = decryptedTemporaryId;
  decryptedTemporaryId = result.temporaryId || null;
  if (external) {
    selectedLocalSave = null;
    myControls.selectedSavePanel.hidden = true;
  }
  decryptedWorkspace = result.workspace;
  decryptedArchive = result.archivePath;
  workspaceDetails = result.info;
  hideEditorWindow();
  closeReRegion();
  selectedWorkspacePath = '';
  myControls.targetTitleId.value = '';
  workspaceModified = false;
  renderWorkspace();
  myStatus(uiText('Your save is decrypted. Select a file to edit, or export the decrypted ZIP.'));
  myLog(uiText('Decrypted files are ready to edit.'));
  if (previousTemporaryId !== decryptedTemporaryId) await releaseSaveTemporary(previousTemporaryId);
  return true;
}

myControls.refreshMySavesBtn.addEventListener('click', () => runMyOperation(async () => {
  await loadLocalProfiles();
  myStatus(mySaves.length ? uiText`Found ${mySaves.length} local save file(s).` : emptyLocalMessage());
}));

myControls.decryptExternalBtn.addEventListener('click', () => runMyOperation(async () => {
  const inputs = await window.saveEditor.chooseInput();
  await decryptInputs(inputs, { external: true });
}));

// Function = Save ZIP Drop
{
  const zone = document.getElementById('decryptExternalDropZone');
  let dragDepth = 0;
  const available = () => !accountClosing && !mySaveOperation && !activeTransfer && !browseSessionActive;
  const fileDrag = event => {
    const transfer = event.dataTransfer;
    return Boolean(transfer && (Array.from(transfer.types || []).includes('Files')
      || transfer.files?.length || Array.from(transfer.items || []).some(item => item.kind === 'file')));
  };
  const clear = () => { dragDepth = 0; zone?.classList.remove('drag-active'); };
  const preview = event => {
    const files = Array.from(event.dataTransfer.files || []);
    if (files.length) return files.length === 1 && /\.zip$/i.test(files[0].name);
    const items = Array.from(event.dataTransfer.items || []).filter(item => item.kind === 'file');
    return items.length <= 1;
  };
  const highlight = event => {
    const ready = available();
    zone.classList.toggle('drag-active', ready && preview(event));
    event.dataTransfer.dropEffect = ready ? 'copy' : 'none';
  };
  zone?.addEventListener('dragenter', event => {
    if (!fileDrag(event)) return;
    event.preventDefault(); event.stopPropagation();
    dragDepth++;
    highlight(event);
  });
  zone?.addEventListener('dragover', event => {
    if (!fileDrag(event)) return;
    event.preventDefault(); event.stopPropagation();
    highlight(event);
  });
  zone?.addEventListener('dragleave', event => {
    if (!fileDrag(event) && !dragDepth) return;
    event.preventDefault(); event.stopPropagation();
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) clear();
  });
  zone?.addEventListener('drop', event => {
    clear();
    if (!fileDrag(event)) return;
    event.preventDefault(); event.stopPropagation();
    if (!available()) {
      myStatus(uiText('Finish the current transfer or save operation first.'));
      return;
    }
    const files = Array.from(event.dataTransfer.files || []);
    if (files.length !== 1) {
      myStatus(uiText('Drop one encrypted save ZIP at a time.'));
      return;
    }
    const file = files[0];
    if (!/\.zip$/i.test(file.name)) {
      myStatus(uiText('Drop an encrypted save ZIP (.zip).'));
      return;
    }
    if (typeof file.path !== 'string' || !file.path.trim()) {
      myStatus(uiText('This ZIP has no local file path. Drop it from your file manager.'));
      return;
    }
    void runMyOperation(() => decryptInputs([file.path], { external: true }));
  });
  document.addEventListener('dragover', event => {
    if (!fileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'none';
    clear();
  });
  document.addEventListener('drop', event => {
    if (!fileDrag(event)) return;
    event.preventDefault();
    clear();
  });
  document.addEventListener('dragend', clear);
  document.addEventListener('transfer-state-changed', () => { if (!available()) clear(); });
  window.addEventListener('blur', clear);
}

myControls.mySaveDecryptBtn.addEventListener('click', () => runMyOperation(async () => {
  if (!selectedLocalSave) return;
  const inputs = await window.saveEditor.localFile(localSaveOptions());
  await decryptInputs(inputs);
}));

async function uploadCurrentSave() {
  if (workspaceSaves().length) {
    myStatus(uiText('Extract the encrypted batch ZIP and add its saves to Local files before uploading.'));
    return;
  }
  if (accountClosing || !selectedLocalSave) return;
  const targetTitle = myControls.targetTitleId.value.trim().toUpperCase();
  const sourceTitle = String(workspaceDetails?.titleId || selectedLocalSave.entry.title || '').toUpperCase();
  if (!controls.useRemoteOracle.checked && targetTitle && targetTitle !== sourceTitle) {
    myStatus(uiText('Export the encrypted PPSA copy and add it under its target PPSA before uploading.'));
    return;
  }
  let selection;
  if (selectedLocalSave.entry.localSource === 'pc') {
    const prepared = await runMyOperation(() => window.saveTransfer.prepareLocalPcUpload({ entryId: selectedLocalSave.entry.id }));
    if (!prepared) return;
    selection = { external: prepared };
  } else {
    selection = { entryIds: [selectedLocalSave.entry.id], userId: selectedLocalSave.entry.owner };
  }
  if (accountClosing) {
    if (selection.external?.stageId) {
      try { await window.saveTransfer.releaseLocalPcUpload(selection.external.stageId); }
      catch (error) { myLog(uiText`Could not remove upload staging: ${error.message}`); }
    }
    return;
  }
  document.querySelector('[data-page="upload"]').click();
  await startUpload(selection);
}

myControls.uploadSaveBtn.addEventListener('click', uploadCurrentSave);
myControls.uploadEncryptedBtn.addEventListener('click', uploadCurrentSave);

function closeExportMenu() {
  for (const [button, options] of [
    ['saveMoreBtn', 'saveMoreOptions'],
    ['workspaceMoreBtn', 'workspaceMoreOptions'],
    ['fileMoreBtn', 'fileMoreOptions'],
  ]) {
    myControls[options].hidden = true;
    myControls[button].setAttribute('aria-expanded', 'false');
  }
}

for (const [button, options] of [
  ['saveMoreBtn', 'saveMoreOptions'],
  ['workspaceMoreBtn', 'workspaceMoreOptions'],
  ['fileMoreBtn', 'fileMoreOptions'],
]) {
  myControls[button].addEventListener('click', (event) => {
    event.stopPropagation();
    const wasOpen = !myControls[options].hidden;
    closeExportMenu();
    myControls[options].hidden = wasOpen;
    myControls[button].setAttribute('aria-expanded', String(!wasOpen));
  });
}
document.addEventListener('click', (event) => {
  if (!event.target.closest('.dropdown')) closeExportMenu();
});

myControls.decryptExportBtn.addEventListener('click', () => runMyOperation(async () => {
  closeExportMenu();
  if (!selectedLocalSave) return;
  const inputs = await window.saveEditor.localFile(localSaveOptions());
  if (!await decryptInputs(inputs)) return;
  if (!decryptedArchive) return;
  const destination = await window.saveEditor.downloadArchive(decryptedArchive);
  if (destination) {
    await closeMyWorkspace();
    myStatus(uiText`Decrypted save exported to ${destination}`);
  }
}));

myControls.mySaveExportBtn.addEventListener('click', () => runMyOperation(async () => {
  closeExportMenu();
  if (!selectedLocalSave) return;
  const result = await window.saveTransfer.exportLocalSave(localSaveOptions());
  if (result) myStatus(uiText`Original save exported to ${result.destination}`);
}));

myControls.mySaveImportBtn.addEventListener('click', () => {
  if (selectedLocalSave) chooseImportReplacement(selectedLocalSave.entry, selectedLocalSave.file);
});

myControls.mySaveResignBtn.addEventListener('click', () => {
  if (!selectedLocalSave) return;
  myControls.resignPanel.hidden = !myControls.resignPanel.hidden;
});

myControls.confirmResignBtn.addEventListener('click', () => runMyOperation(async () => {
  if (!selectedLocalSave) return;
  await savedAccounts?.waitForChanges();
  const targetTitleId = selectedTargetTitleId(selectedLocalSave.entry.title);
  const useCurrent = savedAccounts?.isUsingCurrent();
  if (useCurrent && !targetTitleId) {
    myStatus(uiText('Uncheck Use current ID and choose a target account before resigning.'));
    return;
  }
  if (useCurrent && (!decryptedWorkspace || !workspaceDetails?.accountId)) {
    myStatus(uiText('Decrypt this save first to read its current Account ID, or select a target account.'));
    return;
  }
  const accountId = useCurrent ? workspaceDetails.accountId
    : savedAccounts?.getTargetId(myControls.resignAccountId.value.trim()) || myControls.resignAccountId.value.trim();
  if (!/^[0-9a-f]{16}$/i.test(accountId)) {
    myStatus(uiText('Enter a 16-digit hexadecimal account ID before resigning.'));
    return;
  }
  const output = await window.saveEditor.chooseOutput(`${targetTitleId ? `${targetTitleId}-` : ''}${selectedLocalSave.file.file}-resigned.zip`);
  if (!output) return;
  const inputs = await window.saveEditor.localFile(localSaveOptions());
  myStatus(uiText('Resigning your save…'));
  const result = await window.saveEditor.run({
    operation: 'resign', inputs, accountId, output, platform: 'ps5',
    ...saveJobOptions(),
    ...(targetTitleId ? { targetTitleId } : {}),
  });
  if (result) {
    myControls.resignPanel.hidden = true;
    myStatus(uiText`Resigned save exported to ${result.output}`);
    myLog(uiText`Resigned copy: ${result.output}`);
  }
}));

myControls.exportDecryptedBtn.addEventListener('click', () => runMyOperation(async () => {
  if (!decryptedArchive) return;
  const destination = await window.saveEditor.downloadArchive(decryptedArchive);
  if (destination) myStatus(uiText`Decrypted ZIP exported to ${destination}`);
}));

myControls.addFilesBtn.addEventListener('click', () => runMyOperation(async () => {
  if (!decryptedWorkspace) return;
  const result = await window.saveEditor.add(decryptedWorkspace);
  if (result) {
    workspaceDetails = result;
    workspaceModified = true;
    renderWorkspace();
    myStatus(uiText('Files added to the decrypted workspace.'));
  }
}));

myControls.encryptSaveBtn.addEventListener('click', () => runMyOperation(encryptWorkspace));

async function encryptWorkspace() {
  if (!decryptedWorkspace || workspaceDetails?.batchError) return null;
  await savedAccounts?.waitForChanges();
  const saves = workspaceSaves();
  const batch = saves.length > 1;
  if (batch && controls.useRemoteOracle.checked) {
    myStatus(uiText('Use the local worker to encrypt a batch of decrypted saves.'));
    return null;
  }
  const targetTitleId = selectedTargetTitleId(workspaceDetails?.titleId || selectedLocalSave?.entry.title, saves);
  const useCurrentAccount = Boolean(savedAccounts?.isUsingCurrent());
  const accountId = savedAccounts?.getTargetId(myControls.encryptAccountId.value.trim()) || myControls.encryptAccountId.value.trim();
  if (!(batch && useCurrentAccount) && !/^[0-9a-f]{16}$/i.test(accountId)) {
    myStatus(uiText('Enter a 16-digit hexadecimal account ID before encrypting.'));
    return null;
  }
  myStatus(batch ? uiText`Encrypting ${saves.length} saves…` : uiText('Encrypting your edited save…'));
  let result;
  const replaceOriginal = Boolean(selectedLocalSave && !targetTitleId && !batch);
  if (replaceOriginal) {
    if (!await confirmSaveAction(`Replace ${selectedLocalSave.file.file} with your edited save? A backup will be created first.`)) return null;
    const pc = selectedLocalSave.entry.localSource === 'pc';
    const selection = localSaveOptions();
    let backup = pc ? null : await window.saveEditor.backupLocal(selection);
    result = await window.saveEditor.encryptLocal({
      workspace: decryptedWorkspace, accountId, platform: 'ps5',
      ...saveJobOptions(),
      useCurrentAccount,
    });
    if (!result) return null;
    try {
      const replacement = await window.saveTransfer.importLocalSave({
        ...selection,
        source: result.output,
      });
      if (pc) backup = replacement?.backup;
      await refreshMySaves();
      if (backup) myLog(uiText`Backup: ${backup}`);
    } finally { await releaseSaveTemporary(result.temporaryId); }
  } else {
    const output = await window.saveEditor.chooseOutput(batch
      ? `${targetTitleId ? `${targetTitleId}-` : ''}${saves.length}-saves-encrypted.zip`
      : `${targetTitleId || workspaceDetails.titleId || 'save'}-encrypted.zip`);
    if (!output) return null;
    result = await window.saveEditor.run({
      operation: 'encrypt', workspace: decryptedWorkspace, accountId, output, platform: 'ps5',
      ...saveJobOptions(),
      useCurrentAccount,
      ...(targetTitleId ? { targetTitleId } : {}),
    });
  }
  if (result) {
    workspaceModified = false;
    myControls.encryptPanel.hidden = true;
    myStatus(replaceOriginal
      ? uiText`${selectedLocalSave.file.file} was replaced with your edited save. A backup is available.`
      : batch ? uiText`${saves.length} encrypted saves exported to ${result.output}. Extract the ZIP and add its saves to Local files to upload.`
      : targetTitleId ? uiText`Encrypted save for ${targetTitleId} exported to ${result.output}. Add it under ${targetTitleId} to upload.`
      : uiText`Encrypted save exported to ${result.output}`);
    myLog(replaceOriginal ? uiText`Encrypted save updated: ${selectedLocalSave.file.file}` : uiText`Encrypted copy: ${result.output}`);
  }
  return result;
}

myControls.confirmEncryptBtn.addEventListener('click', () => runMyOperation(encryptWorkspace));

myControls.closeWorkspaceBtn.addEventListener('click', () => runMyOperation(() => closeMyWorkspace()));
myControls.editorMode.addEventListener('change', () => {
  if (!selectedFileBytes) return;
  const mode = myControls.editorMode.value;
  const previousMode = mode === 'hex' ? 'text' : 'hex';
  if (pagedEditor) {
    myControls.editorMode.value = previousMode;
    const offset = editorScroller.offset();
    return runMyOperation(async () => {
      stageEditorPage(previousMode);
      if (mode === 'text') {
        myStatus(uiText('Checking text conversion…'));
        try { await pagedEditor.validateText(); }
        catch (error) {
          myStatus(error.message === 'Cant be converted to text mode' ? uiText('Cant be converted to text mode') : error.message);
          return;
        }
      }
      await showEditorPage(offset, mode);
      editorScroller.sync();
      editorScroller.reveal(offset);
      myControls.editorStatus.textContent = '';
    });
  }
  try {
    const bytes = editorDirty ? editorBytes(previousMode) : selectedFileBytes;
    const draft = mode === 'hex' ? bytesToHex(bytes) : losslessEditorText(bytes);
    renderEditor(draft, mode, editorDirty);
    myControls.editorStatus.textContent = '';
  } catch (error) {
    myControls.editorMode.value = previousMode;
    myStatus(mode === 'text' ? uiText('Cant be converted to text mode') : error.message);
  }
});
myControls.editorFindNext.addEventListener('click', findInEditor);
myControls.editorSearch.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') findInEditor();
});
myControls.editorSearch.addEventListener('input', () => { editorSearchState = null; });
myControls.editorGoOffset.addEventListener('click', goToEditorOffset);
myControls.editorOffset.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') goToEditorOffset();
});
myControls.editorRevert.addEventListener('click', () => runMyOperation(async () => {
  if (selectedWorkspaceFile) await openWorkspaceFile(selectedWorkspaceFile);
}));
myControls.fileEditor.addEventListener('keydown', event => {
  if (pagedEditor && !event.defaultPrevented && !event.altKey && !event.shiftKey
      && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
    myStatus(uiText('Selected the loaded section. Use Export file for the entire file.'));
  }
});
myControls.fileEditor.addEventListener('input', () => {
  resetEditorDraft();
  editorDirty = true;
  editorPageChanged = Boolean(pagedEditor);
  if (pagedEditor) editorScroller.pause();
  myControls.saveFileBtn.textContent = uiText('Save changes *');
  queueEditorByteCount();
});
async function saveCurrentEditorFile(keepOpen = true) {
  if (!selectedWorkspaceFile || selectedWorkspaceFile.readOnly || selectedFileBytes === null) return false;
  if (!editorDirty) return true;
  const root = decryptedWorkspace, path = selectedWorkspaceFile.path;
  const offset = pagedEditor && keepOpen ? editorScroller.offset() : 0;
  if (pagedEditor) {
    stageEditorPage();
    if (pagedEditor.dirty) {
      workspaceDetails = await window.saveEditor.writePages({ root, path, version: pagedEditor.version, edits: pagedEditor.edits() });
    }
  } else {
    const bytes = editorBytes();
    workspaceDetails = await window.saveEditor.write({ root, path, data: window.EditorBytes.toBase64(bytes) });
    selectedFileBytes = bytes;
  }
  selectedWorkspaceFile = workspaceDetails.files.find(file => file.path === path) || selectedWorkspaceFile;
  workspaceModified = true;
  resetEditorDraft();
  editorDirty = false;
  if (keepOpen && (pagedEditor || selectedFileBytes.length > PAGED_EDITOR_THRESHOLD)) {
    try {
      await readEditorFile(root, path, selectedWorkspaceFile, offset, myControls.editorMode.value);
    } catch (error) {
      hideEditorWindow();
      renderWorkspace();
      throw new Error(uiText`Saved ${path}, but could not reopen it: ${error.message}`);
    }
  }
  if (keepOpen) updateEditorByteCount();
  myControls.saveFileBtn.textContent = uiText('Save changes');
  renderWorkspace();
  return true;
}

myControls.saveFileBtn.addEventListener('click', () => runMyOperation(async () => {
  if (!editorDirty) { myStatus(uiText('No changes to save.')); return; }
  if (await saveCurrentEditorFile()) myStatus(uiText`${selectedWorkspaceFile.path} updated in the decrypted workspace.`);
}));
myControls.saveEncryptFileBtn.addEventListener('click', () => runMyOperation(async () => {
  if (workspaceDetails?.batchError) return;
  if (await saveCurrentEditorFile(false)) {
    hideEditorWindow();
    await encryptWorkspace();
  }
}));
myControls.downloadFileBtn.addEventListener('click', () => runMyOperation(async () => {
  if (!selectedWorkspaceFile) return;
  await exportWorkspaceFile(selectedWorkspaceFile);
}));
myControls.replaceFileBtn?.addEventListener('click', () => runMyOperation(async () => {
  if (selectedWorkspaceFile) await replaceWorkspaceFile(selectedWorkspaceFile);
}));
myControls.deleteFileBtn.addEventListener('click', () => runMyOperation(async () => {
  if (selectedWorkspaceFile) await deleteWorkspaceFile(selectedWorkspaceFile);
}));

for (const tab of document.querySelectorAll('.nav-item')) {
  tab.addEventListener('click', () => {
    myControls.mySavesTab.hidden = tab.dataset.page !== 'library';
    if (tab.dataset.page === 'library') {
      goToLibraryStep(decryptedWorkspace ? 2 : selectedLocalSave ? 1 : 0);
      runMyOperation(async () => {
        await loadLocalProfiles();
        myStatus(mySaves.length ? uiText('Select a save to get started.') : emptyLocalMessage());
      });
    }
  });
}

document.addEventListener('local-save-replaced', async () => {
  await refreshMySaves();
  myStatus(localPcMode ? uiText('PC save replaced. A backup is available.') : uiText('Save replaced and its upload metadata refreshed.'));
});

window.saveEditor.onEvent((event) => {
  if (event.type === 'status') myStatus(uiText(event.message));
  if (event.type === 'log') myLog(event.message);
  if (event.type === 'error') myStatus(event.message);
});

// Refresh alternate layout.
document.addEventListener('cmp-layout-changed', renderMySaves);

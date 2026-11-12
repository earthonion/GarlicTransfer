const editorControls = {};
for (const id of [
  'editorChooseFiles', 'editorUseDownloaded', 'editorOpenWorkspace', 'editorLocalPicker',
  'editorLocalSave', 'editorLocalSelect', 'editorInputSummary', 'editorDecrypt',
  'editorResign', 'editorResignAccount', 'editorWorkspacePanel', 'editorWorkspacePath',
  'editorDownloadArchive', 'editorAddFiles', 'editorRefresh', 'editorFiles',
  'editorEncrypt', 'editorEncryptAccount', 'editorFilePanel', 'editorFileName',
  'editorFileInfo', 'editorTextMode', 'editorHexMode', 'editorDownloadFile',
  'editorCloseFile', 'editorFileContent', 'editorSaveFile', 'editorFileDirty',
  'editorStatus', 'editorLog',
]) editorControls[id] = byId(id);

const editorState = {
  inputs: [],
  workspace: null,
  archivePath: null,
  currentFile: null,
  data: null,
  savedData: null,
  mode: 'text',
  dirty: false,
  busy: false,
  localFiles: [],
  info: null,
};

function editorBaseName(filePath) {
  return filePath.split(/[\\/]/).pop();
}

function editorFormatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function editorStatus(message) {
  editorControls.editorStatus.textContent = message;
}

function editorLog(message) {
  editorControls.editorLog.textContent += `${message}\n`;
  editorControls.editorLog.scrollTop = editorControls.editorLog.scrollHeight;
}

function editorBusy(value) {
  editorState.busy = value;
  for (const button of document.querySelectorAll('#saveEditorTab button')) button.disabled = value;
  for (const input of document.querySelectorAll('#saveEditorTab input, #saveEditorTab select')) input.disabled = value;
  editorControls.editorFileContent.readOnly = value;
  if (!value && editorState.info) renderEditorFiles(editorState.info);
}

function setEditorInputs(paths) {
  editorState.inputs = paths;
  if (!paths.length) {
    editorControls.editorInputSummary.textContent = 'No encrypted files selected.';
    return;
  }
  const names = paths.map(editorBaseName);
  editorControls.editorInputSummary.textContent = names.length <= 4
    ? `${names.length} file(s): ${names.join(', ')}`
    : `${names.length} files selected, including ${names.slice(0, 3).join(', ')}.`;
  editorStatus('Ready to decrypt or resign the selected files.');
}

function renderEditorFiles(info) {
  editorControls.editorFiles.replaceChildren();
  if (!info.files.length) {
    editorControls.editorFiles.innerHTML = '<tr><td colspan="3" class="empty">This workspace has no files. Add files to continue.</td></tr>';
    return;
  }
  for (const file of info.files) {
    const row = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = file.path;
    if (file.protected) {
      const marker = document.createElement('span');
      marker.className = 'title-id';
      marker.textContent = 'required metadata';
      name.appendChild(marker);
    }
    const size = document.createElement('td');
    size.textContent = editorFormatBytes(file.size);
    const actions = document.createElement('td');
    for (const [label, mode] of [['Text', 'text'], ['Hex', 'hex']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.disabled = editorState.busy;
      button.addEventListener('click', () => openEditorFile(file.path, mode));
      actions.appendChild(button);
    }
    const download = document.createElement('button');
    download.type = 'button';
    download.textContent = 'Download';
    download.disabled = editorState.busy;
    download.addEventListener('click', async () => {
      try {
        const output = await window.saveEditor.downloadFile({ root: editorState.workspace, path: file.path });
        if (output) editorStatus(`Downloaded ${file.path} to ${output}`);
      } catch (error) {
        editorStatus(`Could not download ${file.path}: ${error.message}`);
      }
    });
    actions.appendChild(download);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Delete';
    remove.disabled = editorState.busy || file.protected;
    remove.title = file.protected ? 'Required to rebuild the save' : 'Delete this file from the decrypted workspace';
    remove.addEventListener('click', async () => {
      if (!window.confirm(`Delete ${file.path} from the decrypted workspace?`)) return;
      try {
        const info = await window.saveEditor.delete({ root: editorState.workspace, path: file.path });
        if (editorState.currentFile?.path === file.path) closeEditorFile(true);
        showEditorWorkspace(info);
        editorStatus(`Deleted ${file.path}.`);
      } catch (error) {
        editorStatus(`Could not delete ${file.path}: ${error.message}`);
      }
    });
    actions.appendChild(remove);
    row.append(name, size, actions);
    editorControls.editorFiles.appendChild(row);
  }
}

function showEditorWorkspace(info) {
  editorState.info = info;
  editorState.workspace = info.root;
  editorControls.editorWorkspacePanel.hidden = false;
  editorControls.editorWorkspacePath.textContent = `${info.root}${info.titleId ? ` — ${info.titleId}` : ''} — ${info.files.length} file(s), ${editorFormatBytes(info.totalBytes)}`;
  if (info.accountId) {
    editorControls.editorEncryptAccount.value = info.accountId;
    if (!editorControls.editorResignAccount.value) editorControls.editorResignAccount.value = info.accountId;
  }
  editorControls.editorDownloadArchive.hidden = !editorState.archivePath;
  renderEditorFiles(info);
}

function editorBytesToBase64(data) {
  let binary = '';
  for (let offset = 0; offset < data.length; offset += 0x8000) {
    binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function editorBase64ToBytes(encoded) {
  const binary = atob(encoded);
  const data = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) data[index] = binary.charCodeAt(index);
  return data;
}

function editorHex(data) {
  const lines = [];
  for (let offset = 0; offset < data.length; offset += 16) {
    lines.push(Array.from(data.subarray(offset, offset + 16), (byte) => byte.toString(16).padStart(2, '0')).join(' '));
  }
  return lines.join('\n');
}

function editorText(data) {
  return new TextDecoder('utf-8', { fatal: true }).decode(data);
}

function captureEditorChanges() {
  if (!editorState.currentFile || !editorState.dirty) return;
  if (editorState.mode === 'hex') {
    const compact = editorControls.editorFileContent.value.replace(/\s+/g, '');
    if (compact.length % 2 || !/^[0-9a-fA-F]*$/.test(compact)) {
      throw new Error('hex mode accepts only complete pairs of hexadecimal digits');
    }
    const data = new Uint8Array(compact.length / 2);
    for (let index = 0; index < data.length; index++) data[index] = parseInt(compact.slice(index * 2, index * 2 + 2), 16);
    editorState.data = data;
  } else {
    editorState.data = new TextEncoder().encode(editorControls.editorFileContent.value);
  }
}

function renderEditorBuffer() {
  editorControls.editorFileContent.value = editorState.mode === 'hex' ? editorHex(editorState.data) : editorText(editorState.data);
  editorControls.editorTextMode.classList.toggle('primary-action', editorState.mode === 'text');
  editorControls.editorHexMode.classList.toggle('primary-action', editorState.mode === 'hex');
  editorControls.editorFileInfo.textContent = `${editorFormatBytes(editorState.data.length)} — ${editorState.mode === 'hex' ? 'editable hexadecimal bytes' : 'UTF-8 text'}`;
}

async function openEditorFile(relative, requestedMode = 'text') {
  if (editorState.dirty && !window.confirm('Discard unsaved changes to the current file?')) return;
  try {
    editorStatus(`Opening ${relative}…`);
    const result = await window.saveEditor.read({ root: editorState.workspace, path: relative });
    editorState.currentFile = result;
    editorState.data = editorBase64ToBytes(result.data);
    editorState.savedData = editorState.data;
    editorState.mode = requestedMode;
    editorState.dirty = false;
    if (requestedMode === 'text') {
      try {
        editorText(editorState.data);
      } catch {
        editorState.mode = 'hex';
        editorStatus(`${relative} is binary; opened in hex mode.`);
      }
    }
    editorControls.editorFileName.textContent = relative;
    editorControls.editorFilePanel.hidden = false;
    editorControls.editorFileDirty.textContent = '';
    renderEditorBuffer();
    editorControls.editorFileContent.focus();
  } catch (error) {
    editorStatus(`Could not open ${relative}: ${error.message}`);
  }
}

function closeEditorFile(force = false) {
  if (!force && editorState.dirty && !window.confirm('Discard unsaved changes to the current file?')) return;
  editorState.currentFile = null;
  editorState.data = null;
  editorState.savedData = null;
  editorState.dirty = false;
  editorControls.editorFilePanel.hidden = true;
  editorControls.editorFileContent.value = '';
}

async function runEditorOperation(operation) {
  let accountId = '';
  let output = null;
  if (operation === 'decrypt' && !editorState.inputs.length) {
    editorStatus('Choose encrypted save files first.');
    return;
  }
  if (operation === 'resign') {
    accountId = editorControls.editorResignAccount.value.trim();
    if (!/^[0-9a-fA-F]{16}$/.test(accountId)) {
      editorStatus('Enter a 16-digit hexadecimal account ID for resigning.');
      return;
    }
    output = await window.saveEditor.chooseOutput(`${editorBaseName(editorState.inputs[0])}_resigned.zip`);
  }
  if (operation === 'encrypt') {
    if (!editorState.workspace) {
      editorStatus('Decrypt a save or open a decrypted folder first.');
      return;
    }
    if (editorState.dirty) {
      editorStatus('Save or discard changes to the open file before encrypting.');
      return;
    }
    accountId = editorControls.editorEncryptAccount.value.trim();
    if (!/^[0-9a-fA-F]{16}$/.test(accountId)) {
      editorStatus('Enter a 16-digit hexadecimal account ID for encryption.');
      return;
    }
    output = await window.saveEditor.chooseOutput(`${editorBaseName(editorState.workspace)}_enc.zip`);
  }
  if (operation !== 'decrypt' && !output) return;
  editorBusy(true);
  try {
    const settings = options();
    const result = await window.saveEditor.run({
      operation,
      inputs: editorState.inputs,
      workspace: editorState.workspace,
      accountId,
      output,
      serverUrl: settings.serverUrl,
      workerKey: settings.workerKey,
    });
    if (operation === 'decrypt') {
      editorState.archivePath = result.archivePath;
      showEditorWorkspace(result.info);
      editorStatus(`Decrypted save is ready to edit. Workspace: ${result.workspace}`);
    } else {
      editorStatus(`${operation === 'resign' ? 'Resigned' : 'Encrypted'} save saved to ${result.output}`);
    }
  } catch (error) {
    editorStatus(`${operation} failed: ${error.message}`);
  } finally {
    editorBusy(false);
  }
}

editorControls.editorChooseFiles.addEventListener('click', async () => {
  const paths = await window.saveEditor.chooseInput();
  if (paths.length) setEditorInputs(paths);
});
editorControls.editorUseDownloaded.addEventListener('click', async () => {
  try {
    const result = await window.saveTransfer.localSaves(options().assets);
    editorState.localFiles = [];
    for (const entry of result.entries || []) {
      for (const file of entry.files || []) {
        editorState.localFiles.push({ entryId: entry.id, filename: file.file, title: entry.name || entry.title, size: file.size });
      }
    }
    if (!editorState.localFiles.length) throw new Error('no downloaded saves were found');
    editorControls.editorLocalSave.replaceChildren();
    editorState.localFiles.forEach((file, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = `${file.title} — ${file.filename} (${editorFormatBytes(file.size)})`;
      editorControls.editorLocalSave.appendChild(option);
    });
    editorControls.editorLocalPicker.hidden = false;
  } catch (error) {
    editorStatus(`Could not list downloaded saves: ${error.message}`);
  }
});
editorControls.editorLocalSelect.addEventListener('click', async () => {
  const file = editorState.localFiles[Number(editorControls.editorLocalSave.value)];
  if (!file) return;
  try {
    const paths = await window.saveEditor.localFile({ assets: options().assets, entryId: file.entryId, filename: file.filename });
    setEditorInputs(paths);
    editorControls.editorLocalPicker.hidden = true;
  } catch (error) {
    editorStatus(`Could not use the downloaded save: ${error.message}`);
  }
});
editorControls.editorOpenWorkspace.addEventListener('click', async () => {
  try {
    const info = await window.saveEditor.chooseWorkspace();
    if (!info) return;
    editorState.archivePath = null;
    showEditorWorkspace(info);
    editorStatus('Decrypted folder opened. You can edit and encrypt its contents.');
  } catch (error) {
    editorStatus(`Could not open the decrypted folder: ${error.message}`);
  }
});
editorControls.editorDecrypt.addEventListener('click', () => runEditorOperation('decrypt'));
editorControls.editorResign.addEventListener('click', () => {
  if (!editorState.inputs.length) {
    editorStatus('Choose encrypted save files first.');
    return;
  }
  runEditorOperation('resign');
});
editorControls.editorEncrypt.addEventListener('click', () => runEditorOperation('encrypt'));
editorControls.editorRefresh.addEventListener('click', async () => {
  if (!editorState.workspace) return;
  showEditorWorkspace(await window.saveEditor.info(editorState.workspace));
});
editorControls.editorAddFiles.addEventListener('click', async () => {
  try {
    const info = await window.saveEditor.add(editorState.workspace);
    if (!info) return;
    showEditorWorkspace(info);
    editorStatus('Files added to the decrypted workspace.');
  } catch (error) {
    editorStatus(`Could not add files: ${error.message}`);
  }
});
editorControls.editorDownloadArchive.addEventListener('click', async () => {
  if (!editorState.archivePath) return;
  const output = await window.saveEditor.downloadArchive(editorState.archivePath);
  if (output) editorStatus(`Decrypted ZIP saved to ${output}`);
});
for (const [button, mode] of [[editorControls.editorTextMode, 'text'], [editorControls.editorHexMode, 'hex']]) {
  button.addEventListener('click', () => {
    if (editorState.mode === mode) return;
    const previousMode = editorState.mode;
    try {
      captureEditorChanges();
      editorState.mode = mode;
      renderEditorBuffer();
    } catch (error) {
      editorState.mode = previousMode;
      renderEditorBuffer();
      editorStatus(error.message);
    }
  });
}
editorControls.editorFileContent.addEventListener('input', () => {
  editorState.dirty = true;
  editorControls.editorFileDirty.textContent = 'Unsaved changes';
});
editorControls.editorSaveFile.addEventListener('click', async () => {
  if (!editorState.currentFile) return;
  try {
    captureEditorChanges();
    const info = await window.saveEditor.write({
      root: editorState.workspace,
      path: editorState.currentFile.path,
      data: editorBytesToBase64(editorState.data),
    });
    editorState.savedData = editorState.data;
    editorState.dirty = false;
    editorControls.editorFileDirty.textContent = 'Saved';
    showEditorWorkspace(info);
    editorStatus(`Saved changes to ${editorState.currentFile.path}.`);
  } catch (error) {
    editorStatus(`Could not save changes: ${error.message}`);
  }
});
editorControls.editorCloseFile.addEventListener('click', () => closeEditorFile());
editorControls.editorDownloadFile.addEventListener('click', async () => {
  if (!editorState.currentFile) return;
  const output = await window.saveEditor.downloadFile({ root: editorState.workspace, path: editorState.currentFile.path });
  if (output) editorStatus(`File saved to ${output}`);
});
window.saveEditor.onEvent((event) => {
  if (event.type === 'status') editorStatus(event.message);
  if (event.type === 'log') editorLog(event.message);
  if (event.type === 'job') editorLog(`${event.operation} job: ${event.jobId}`);
  if (event.type === 'error') editorStatus(event.message);
});
window.addEventListener('beforeunload', (event) => {
  if (editorState.dirty) event.preventDefault();
});

const fs = require('node:fs/promises');
const { constants, createReadStream } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');

// Function = Protect Metadata
function isReadOnlyFile(filename) {
  return /^chives\.json[. ]*$/i.test(path.win32.basename(filename));
}

function requireWritableFile(filename) {
  if (isReadOnlyFile(filename)) throw new Error('chives.json is read-only.');
}

// Function Replacement Path
function insideWorkspace(root, selected) {
  const relative = path.relative(root, selected);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Function = Check Export
async function checkExportDestination(destination, workspace) {
  let target;
  try {
    target = await fs.realpath(destination);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!isReadOnlyFile(destination)) return;
    target = path.join(await fs.realpath(path.dirname(destination)), path.basename(destination));
  }
  if (isReadOnlyFile(target) && (!workspace || insideWorkspace(await fs.realpath(workspace), target))) {
    requireWritableFile(target);
  }
}

// Function Replacement Identity
function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function unchangedFile(current, expected) {
  return current.isFile() && !current.isSymbolicLink() && current.nlink > 0n && current.nlink === expected.nlink && sameFile(current, expected)
    && current.size === expected.size && current.mtimeNs === expected.mtimeNs && current.ctimeNs === expected.ctimeNs;
}

// Function Replacement Selection
async function prepareWorkspaceReplacement(root, relative) {
  if (typeof root !== 'string' || !root || typeof relative !== 'string' || !relative || relative.includes('\0')) {
    throw new Error('select a file in the save workspace');
  }
  const parts = relative.replace(/\\/g, '/').split('/');
  if (path.win32.parse(relative).root || parts.some(part => !part || part === '.' || part === '..' || part.includes(':'))) {
    throw new Error('the selected path is outside the save workspace');
  }
  requireWritableFile(relative);
  const base = path.resolve(root);
  const rootStat = await fs.lstat(base, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('the save workspace is not a regular folder');
  const workspace = await fs.realpath(base);
  const directories = [{ path: base, canonical: workspace, stat: rootStat }];
  let selected = workspace;
  for (const part of parts.slice(0, -1)) {
    const requested = path.join(selected, part);
    const stat = await fs.lstat(requested, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('linked folders cannot be replaced in the save workspace');
    selected = await fs.realpath(requested);
    if (!insideWorkspace(workspace, selected)) throw new Error('the selected path is outside the save workspace');
    directories.push({ path: requested, canonical: selected, stat });
  }
  const requested = path.join(selected, parts.at(-1));
  const stat = await fs.lstat(requested, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('select a regular file in the save workspace');
  }
  selected = await fs.realpath(requested);
  if (!insideWorkspace(workspace, selected)) throw new Error('the selected path is outside the save workspace');
  const target = { root: workspace, selected, requested, stat, directories };
  await checkWorkspaceReplacement(target);
  return target;
}

// Function Replacement Folders
async function checkReplacementFolders(target) {
  for (const directory of target.directories) {
    const stat = await fs.lstat(directory.path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameFile(stat, directory.stat)
        || path.relative(directory.canonical, await fs.realpath(directory.path)) !== '') {
      throw new Error('the save workspace changed; reload it before replacing this file');
    }
  }
}

// Function Replacement Check
async function checkWorkspaceReplacement(target) {
  requireWritableFile(target.selected);
  await checkReplacementFolders(target);
  const stat = await fs.lstat(target.requested, { bigint: true });
  const canonical = await fs.realpath(target.requested);
  if (!unchangedFile(stat, target.stat) || !insideWorkspace(target.root, canonical)
      || path.relative(target.selected, canonical) !== '') {
    throw new Error('the selected file changed; reload it before replacing this file');
  }
}

// Function Replacement Reading
async function openReplacementFile(selected) {
  if (typeof selected !== 'string' || !selected || selected.includes('\0')) throw new Error('choose a replacement file');
  const original = path.resolve(selected);
  const stat = await fs.lstat(original, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('choose a regular replacement file');
  const filename = await fs.realpath(original);
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    if (!unchangedFile(await handle.stat({ bigint: true }), stat)) throw new Error('the replacement file changed; choose it again');
    return { original, filename, stat, handle };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

// Function Replacement Copy
async function copyReplacement(handle, selected, mode) {
  let output;
  let owned = false;
  let failure;
  try {
    output = await fs.open(selected, 'wx', mode);
    owned = true;
    for await (const data of handle.createReadStream({ autoClose: false })) {
      let offset = 0;
      while (offset < data.length) {
        const { bytesWritten } = await output.write(data, offset, data.length - offset);
        if (!bytesWritten) throw new Error('could not finish copying the replacement file');
        offset += bytesWritten;
      }
    }
    await output.sync();
    await output.close();
    output = null;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (output) await output.close().catch(error => { failure ||= error; });
    if (failure && owned) await fs.rm(selected, { force: true }).catch(() => {});
  }
}

// Function Workspace Replacement
async function replaceWorkspaceFile(target, source, complete = () => undefined) {
  const directory = path.dirname(target.selected);
  const identifier = randomUUID();
  const staged = path.join(directory, `.garlic-replace-${identifier}.tmp`);
  const backup = path.join(directory, `.garlic-replace-${identifier}.backup`);
  const owned = new Set();
  let replacement, original;
  let stagedStat, backupStat, publishedStat;
  let published = false;
  let failure;
  try {
    await checkWorkspaceReplacement(target);
    replacement = await openReplacementFile(source);
    if (sameFile(replacement.stat, target.stat)) throw new Error('choose a different file to replace the selected workspace file');
    const mode = Number(target.stat.mode & 0o777n);
    await copyReplacement(replacement.handle, staged, mode);
    owned.add(staged);
    stagedStat = await fs.lstat(staged, { bigint: true });
    if (!unchangedFile(await replacement.handle.stat({ bigint: true }), replacement.stat)
        || !unchangedFile(await fs.lstat(replacement.original, { bigint: true }), replacement.stat)) {
      throw new Error('the replacement file changed; choose it again');
    }
    await replacement.handle.close(); replacement = null;
    await checkWorkspaceReplacement(target);
    original = await openReplacementFile(target.selected);
    if (!unchangedFile(original.stat, target.stat)) throw new Error('the selected file changed; reload it before replacing this file');
    await copyReplacement(original.handle, backup, mode);
    owned.add(backup);
    backupStat = await fs.lstat(backup, { bigint: true });
    if (!unchangedFile(await original.handle.stat({ bigint: true }), target.stat)) {
      throw new Error('the selected file changed; reload it before replacing this file');
    }
    await original.handle.close(); original = null;
    await checkWorkspaceReplacement(target);
    if (!unchangedFile(await fs.lstat(staged, { bigint: true }), stagedStat)
        || !unchangedFile(await fs.lstat(backup, { bigint: true }), backupStat)) {
      throw new Error('the replacement staging files changed; try replacing the file again');
    }
    await fs.rename(staged, target.selected);
    owned.delete(staged);
    published = true;
    const current = await fs.lstat(target.selected, { bigint: true });
    if (!sameFile(current, stagedStat) || current.size !== stagedStat.size || current.mtimeNs !== stagedStat.mtimeNs) {
      throw new Error('the workspace file changed after replacement');
    }
    publishedStat = current;
    const result = await complete(new Set([backup]));
    await fs.rm(backup);
    owned.delete(backup);
    return result;
  } catch (error) {
    failure = error;
    if (published && owned.has(backup)) {
      try {
        await checkReplacementFolders(target);
        if (!publishedStat || !unchangedFile(await fs.lstat(target.selected, { bigint: true }), publishedStat)
            || !unchangedFile(await fs.lstat(backup, { bigint: true }), backupStat)) {
          throw new Error('the workspace file changed after replacement');
        }
        await fs.rename(backup, target.selected); owned.delete(backup);
      }
      catch (rollbackError) {
        owned.delete(backup);
        error.message += ` The original could not be restored: ${rollbackError.message}. Recovery file: ${backup}`;
      }
    }
    throw error;
  } finally {
    if (replacement) await replacement.handle.close().catch(error => { failure ||= error; });
    if (original) await original.handle.close().catch(error => { failure ||= error; });
    for (const selected of owned) {
      try { await fs.rm(selected, { force: true }); }
      catch (error) { if (!failure) throw error; }
    }
  }
}

const activeWrites = new Set();

// Function = Write Edited File
async function writeEditedFile(selectedPath, data, { beforePublish, mode } = {}) {
  const selected = path.resolve(selectedPath);
  requireWritableFile(selected);
  if (activeWrites.has(selected)) throw new Error('a save is already in progress for this file');
  const temporary = path.join(path.dirname(selected), `.garlic-edit-${randomUUID()}.tmp`);
  let handle;
  let owned = false;
  let failure;
  activeWrites.add(selected);
  try {
    handle = await fs.open(temporary, 'wx', mode);
    owned = true;
    if (typeof data === 'function') await data(handle);
    else await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    if (beforePublish) await beforePublish(temporary);
    await fs.rename(temporary, selected);
    owned = false;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    activeWrites.delete(selected);
    if (handle) await handle.close().catch(error => { failure ||= error; });
    if (owned) {
      try { await fs.rm(temporary, { force: true }); }
      catch (error) { if (!failure) throw error; }
    }
  }
}

// Function Workspace Adding
async function addWorkspaceFiles(root, selectedPaths, complete = () => undefined) {
  const workspace = path.resolve(root);
  const nameKey = name => name.normalize('NFC').replace(/[. ]+$/u, '').toLowerCase();
  const existing = new Set((await fs.readdir(workspace)).map(nameKey));
  const selected = new Set();
  const files = selectedPaths.map(source => {
    const name = path.basename(source);
    requireWritableFile(name);
    const key = nameKey(name);
    if (selected.has(key)) {
      throw Object.assign(new Error(`More than one selected file is named "${name}".`), { code: 'EEXIST' });
    }
    if (existing.has(key)) {
      throw Object.assign(new Error(`A workspace item named "${name}" already exists.`), { code: 'EEXIST' });
    }
    selected.add(key);
    return { source: path.resolve(source), destination: path.join(workspace, name) };
  });
  if (!files.length) return complete();

  let staging;
  const owned = [];
  try {
    staging = await fs.mkdtemp(path.join(workspace, '.garlic-add-'));
    for (const [index, file] of files.entries()) {
      file.staged = path.join(staging, String(index));
      await fs.copyFile(file.source, file.staged, constants.COPYFILE_EXCL);
    }
    for (const file of files) {
      const handle = await fs.open(file.destination, 'wx');
      owned.push(file.destination);
      try {
        await pipeline(createReadStream(file.staged), handle.createWriteStream());
      } finally {
        await handle.close().catch(() => {});
      }
    }
    await fs.rm(staging, { recursive: true, force: true });
    staging = null;
    return await complete();
  } catch (error) {
    for (const destination of owned.reverse()) {
      await fs.rm(destination, { force: true }).catch(() => {});
    }
    throw error;
  } finally {
    if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  isReadOnlyFile, requireWritableFile, checkExportDestination,
  writeEditedFile, addWorkspaceFiles, prepareWorkspaceReplacement, checkWorkspaceReplacement, replaceWorkspaceFile,
};

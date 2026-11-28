const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { prepareWorkspaceReplacement, checkWorkspaceReplacement, writeEditedFile } = require('./workspace_io.cjs');

const MAX_PAGE_BYTES = 1024 * 1024;

// Function = File Version
function fileVersion(stat) {
  return [stat.dev, stat.ino, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

function changedFile() {
  return new Error('The file changed on disk. Reopen it before editing.');
}

// Function = Open File
async function checkedTarget(root, relative, version) {
  const target = await prepareWorkspaceReplacement(root, relative);
  if (target.stat.nlink !== 1n || !Number.isSafeInteger(Number(target.stat.size))) {
    throw new Error('choose a regular, unlinked file in the save workspace');
  }
  if (version !== undefined && version !== fileVersion(target.stat)) throw changedFile();
  return target;
}

// Function = Read Range
async function readRange(handle, buffer, position, length) {
  let count = 0;
  while (count < length) {
    const { bytesRead } = await handle.read(buffer, count, length - count, position + count);
    if (!bytesRead) throw changedFile();
    count += bytesRead;
  }
}

// Function = Read Small File
async function readInlineFile(filename, maximum) {
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NONBLOCK || 0));
  try {
    const initial = await handle.stat({ bigint: true });
    if (!initial.isFile()) throw new Error('select a file in the save workspace');
    const size = Number(initial.size);
    if (size > maximum) return { size, paged: true };
    const data = Buffer.allocUnsafe(size);
    await readRange(handle, data, 0, size);
    const current = await handle.stat({ bigint: true });
    if (current.size > maximum) return { size: Number(current.size), paged: true };
    if (fileVersion(current) !== fileVersion(initial)) throw changedFile();
    return { size, data: data.toString('base64') };
  } finally { await handle.close(); }
}

async function openSource(target) {
  const handle = await fs.open(target.selected, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    if (fileVersion(await handle.stat({ bigint: true })) !== fileVersion(target.stat)) throw changedFile();
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

// Function = Read Page
async function readWorkspacePage({ root, path, offset, length, version }) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 0 || length > MAX_PAGE_BYTES) {
    throw new Error('invalid editor page range');
  }
  const target = await checkedTarget(root, path, version);
  const size = Number(target.stat.size);
  if (offset > size) throw new Error('editor offset is past the end of the file');
  const data = Buffer.allocUnsafe(Math.min(length, size - offset));
  const handle = await openSource(target);
  try {
    await readRange(handle, data, offset, data.length);
    await checkWorkspaceReplacement(target);
    return { data: data.toString('base64'), size, version: fileVersion(target.stat) };
  } finally { await handle.close(); }
}

// Function = Check Edits
function checkEdits(edits, size) {
  if (!Array.isArray(edits)) throw new Error('invalid editor changes');
  let position = 0;
  for (const edit of edits) {
    if (!edit || !Number.isSafeInteger(edit.offset) || !Number.isSafeInteger(edit.length) || edit.length < 0
        || edit.offset < position || edit.offset > size || edit.length > size - edit.offset) {
      throw new Error('editor changes overlap or fall outside the file');
    }
    if (typeof edit.data !== 'string' || edit.data.length > 4 * Math.ceil(MAX_PAGE_BYTES / 3)) {
      throw new Error('invalid editor change data');
    }
    position = edit.offset + edit.length;
  }
}

// Function = Copy Range
async function copyRange(source, output, buffer, start, end) {
  for (let position = start; position < end;) {
    const length = Math.min(end - position, buffer.length);
    await readRange(source, buffer, position, length);
    await output.writeFile(buffer.subarray(0, length));
    position += length;
  }
}

// Function = Save Pages
async function applyWorkspacePages({ root, path, version, edits }) {
  if (typeof version !== 'string' || !version) throw changedFile();
  const target = await checkedTarget(root, path, version);
  const size = Number(target.stat.size);
  checkEdits(edits, size);
  if (!edits.length) return version;

  let writtenStat, stagedStat;
  await writeEditedFile(target.selected, async output => {
    const source = await openSource(target);
    try {
      const buffer = Buffer.allocUnsafe(Math.min(MAX_PAGE_BYTES, size));
      let position = 0;
      for (const edit of edits) {
        await copyRange(source, output, buffer, position, edit.offset);
        const data = Buffer.from(edit.data, 'base64');
        if (data.length > MAX_PAGE_BYTES || data.toString('base64') !== edit.data) {
          throw new Error('the edited page is not valid base64 data');
        }
        await output.writeFile(data);
        position = edit.offset + edit.length;
      }
      await copyRange(source, output, buffer, position, size);
      writtenStat = await output.stat({ bigint: true });
    } finally { await source.close(); }
  }, {
    mode: Number(target.stat.mode & 0o777n),
    async beforePublish(temporary) {
      stagedStat = await fs.lstat(temporary, { bigint: true });
      if (!stagedStat.isFile() || stagedStat.nlink !== 1n || stagedStat.dev !== writtenStat.dev
          || stagedStat.ino !== writtenStat.ino || stagedStat.size !== writtenStat.size) {
        throw new Error('The staged edit changed on disk. Retry saving.');
      }
      await checkWorkspaceReplacement(target);
    },
  });

  const published = await fs.lstat(target.selected, { bigint: true });
  if (published.dev !== stagedStat.dev || published.ino !== stagedStat.ino || published.size !== stagedStat.size
      || published.mtimeNs !== stagedStat.mtimeNs) throw changedFile();
  return fileVersion(published);
}

module.exports = { readInlineFile, readWorkspacePage, applyWorkspacePages };

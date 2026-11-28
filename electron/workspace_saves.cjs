const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');

const MAX_IMAGE = 64 * 1024 * 1024 * 1024;
const METADATA_NAMES = new Set(['chives.json', 'ps5image', 'ps5key', 'ps5param', 'ps5param_size']);

// Function = Check Paths
function contains(root, filename) {
  const relative = path.relative(root, filename);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function validLeaf(value) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) < 256
    && value !== '.' && value !== '..' && !/[\\/<>:"|?*\x00-\x1f]/.test(value) && !/[. ]$/.test(value);
}

// Function = Read Metadata
async function readBounded(filename, maximum) {
  const before = await fs.lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) {
    throw new Error(`invalid save metadata: ${filename}`);
  }
  const file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const details = await file.stat();
    if (!details.isFile() || details.nlink !== 1 || details.ino !== before.ino || details.size !== before.size) {
      throw new Error(`save metadata changed: ${filename}`);
    }
    const bytes = Buffer.alloc(details.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== details.size || (await file.stat()).size !== details.size) throw new Error(`save metadata changed: ${filename}`);
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

// Function = Read SFO
function readSfo(bytes) {
  const invalid = () => { throw new Error('invalid param.sfo'); };
  if (bytes.length < 20 || bytes.length > 0x8000 || !bytes.subarray(0, 4).equals(Buffer.from('\0PSF'))
      || bytes.readUInt32LE(4) !== 0x101) invalid();
  const keys = bytes.readUInt32LE(8), data = bytes.readUInt32LE(12), count = bytes.readUInt32LE(16);
  if (!count || count > (bytes.length - 20) / 16 || keys < 20 + count * 16 || keys >= data || data > bytes.length) invalid();
  const fields = new Map(), ranges = [];
  for (let index = 0; index < count; index++) {
    const entry = 20 + index * 16;
    const keyStart = keys + bytes.readUInt16LE(entry), length = bytes.readUInt32LE(entry + 4);
    const capacity = bytes.readUInt32LE(entry + 8), start = data + bytes.readUInt32LE(entry + 12);
    if (keyStart >= data || length > capacity || start > bytes.length || capacity > bytes.length - start) invalid();
    const keyEnd = bytes.indexOf(0, keyStart);
    if (keyEnd < keyStart || keyEnd >= data) invalid();
    const name = bytes.toString('latin1', keyStart, keyEnd);
    if (!name || fields.has(name) || ranges.some(([from, to]) => start < to && from < start + capacity)) invalid();
    fields.set(name, { value: bytes.subarray(start, start + length), format: bytes.readUInt16LE(entry + 2) });
    if (capacity) ranges.push([start, start + capacity]);
  }
  const account = fields.get('ACCOUNT_ID');
  if (!account || account.value.length !== 8) throw new Error('param.sfo has no valid ACCOUNT_ID');
  const title = fields.get('TITLE_ID');
  let titleId = '';
  if (title) {
    if (title.format !== 0x0204 || ![9, 10].includes(title.value.length)
        || (title.value.length === 10 && title.value[9] !== 0)) invalid();
    titleId = title.value.subarray(0, 9).toString('latin1');
    if (!/^(?:PPSA|CUSA)\d{5}$/.test(titleId)) invalid();
  }
  return { accountId: account.value.toString('hex'), titleId };
}

// Function = Read Metadata
function readChives(bytes) {
  const text = bytes.toString('utf8'), scopes = [];
  for (const token of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\],:]|[^{}\[\],:\s]+/g)) {
    const value = token[0], current = scopes.at(-1);
    if (value === '{' || value === '[') scopes.push({ keys: value === '{' ? new Set() : null, key: true });
    else if (value === '}' || value === ']') scopes.pop();
    else if (value === ',') { if (current) current.key = true; }
    else if (value === ':') { if (current) current.key = false; }
    else if (current?.keys && current.key && value.startsWith('"')) {
      const key = JSON.parse(value);
      if (current.keys.has(key)) throw new Error('duplicate chives.json field');
      current.keys.add(key);
    }
    if (scopes.length > 16) throw new Error('chives.json is too deeply nested');
  }
  const metadata = JSON.parse(text);
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('chives.json must contain a metadata object');
  if (hasPs5Geometry(metadata)) checkChives(metadata);
  return metadata;
}

// Function = Check Schema
function hasPs5Geometry(metadata) {
  return metadata.schema_version === 1 && metadata.platform === 'PS5';
}

// Function = Check Geometry
function checkChives(metadata) {
  const pfs = metadata.pfs;
  const integer = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
  if (!pfs || pfs.version !== 2
      || ![32768, 65536].includes(pfs.block_size_bytes)
      || !integer(pfs.block_count, 2, MAX_IMAGE / pfs.block_size_bytes)
      || !integer(metadata.original_image_size_bytes, 0x40, MAX_IMAGE)
      || (pfs.mode_raw !== undefined && !integer(pfs.mode_raw, 0, 0xffff))
      || (pfs.backup_header_count !== undefined && !integer(pfs.backup_header_count, 0, 0xffffffff))
      || (pfs.fs_ext !== undefined && (!integer(pfs.fs_ext, 0, pfs.block_count - 1)
        || (pfs.fs_ext !== 0 && pfs.block_size_bytes !== 65536)))) {
    throw new Error('invalid PS5 chives.json geometry');
  }
  if (metadata.ownership !== undefined) {
    const owned = new Set();
    if (!Array.isArray(metadata.ownership) || metadata.ownership.length > 256) throw new Error('invalid chives.json ownership');
    for (const entry of metadata.ownership) {
      const parts = typeof entry?.path === 'string' ? entry.path.split('/') : [];
      if (!parts.length || parts.some(part => !validLeaf(part)) || Buffer.byteLength(entry.path) >= 255 || owned.has(entry.path)
          || !integer(entry.uid, 0, 0xffffffff) || !integer(entry.gid, 0, 0xffffffff) || !integer(entry.mode, 0, 0o7777)) {
        throw new Error('invalid chives.json ownership');
      }
      owned.add(entry.path);
    }
  }
  if (metadata.encrypted_name !== undefined && typeof metadata.encrypted_name !== 'string') {
    throw new Error('invalid encrypted save filename');
  }
}

// Function = Read Chives
async function readChivesFile(scan, filename) {
  if (!scan.chivesInfo.has(filename)) {
    scan.chivesInfo.set(filename, readBounded(filename, 262144).then(readChives));
  }
  return scan.chivesInfo.get(filename);
}

// Function = Scan Workspace
async function scanWorkspace(root, ignoredPaths = new Set(), fileSystem = fs) {
  if (typeof root !== 'string' || !root || root.includes('\0')) throw new Error('select a decrypted save workspace');
  const workspace = path.resolve(root);
  const scan = { root: workspace, files: [], sfoCandidates: [], candidates: [], sfoInfo: new Map(), chivesInfo: new Map(), error: null };
  async function visit(directory, details) {
    if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`workspace links or special files are not supported: ${directory}`);
    for (const entry of await fileSystem.readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (ignoredPaths.has(filename)) continue;
      const details = await fileSystem.lstat(filename);
      if (details.isSymbolicLink() || (!details.isFile() && !details.isDirectory()) || (details.isFile() && details.nlink !== 1)) {
        scan.error ||= new Error(`workspace links or special files are not supported: ${filename}`);
        if (!details.isFile() || details.isSymbolicLink()) continue;
      }
      if (details.isDirectory()) await visit(filename, details);
      else {
        scan.files.push({ filename, size: details.size });
        if (entry.name.toLowerCase() === 'param.sfo') {
          scan.sfoCandidates.push(filename);
          if (path.basename(directory).toLowerCase() === 'sce_sys') scan.candidates.push({ root: path.dirname(directory), sfo: filename });
        }
      }
    }
  }
  await visit(workspace, await fileSystem.lstat(workspace));
  return scan;
}

// Function = Read Save SFO
async function readSfoFile(filename, cache = new Map()) {
  if (!cache.has(filename)) cache.set(filename, readBounded(filename, 0x8000).then(readSfo));
  return cache.get(filename);
}

// Function = Plan Saves
async function planWorkspaceSaves(root, scan = null) {
  const workspace = path.resolve(root);
  scan ||= await scanWorkspace(root);
  if (scan.root !== workspace) throw new Error('the workspace scan belongs to another folder');
  if (scan.error) throw scan.error;
  const files = scan.files.map(file => file.filename);
  const candidates = [...scan.candidates].sort((left, right) => left.root < right.root ? -1 : left.root > right.root ? 1 : 0);
  if (candidates.length < 2 || candidates.some(candidate => candidate.root === workspace)) return [];
  for (let index = 0; index < candidates.length; index++) {
    for (const other of candidates.slice(index + 1)) {
      if (contains(candidates[index].root, other.root) || contains(other.root, candidates[index].root)) {
        throw new Error('batch save folders overlap; keep each save in its own folder');
      }
    }
  }
  for (const filename of files) {
    if (METADATA_NAMES.has(path.basename(filename).toLowerCase())
        && !candidates.some(candidate => path.dirname(filename) === candidate.root)) {
      throw new Error(`batch saves require separate metadata in each save folder: ${filename}`);
    }
    if (!candidates.some(candidate => contains(candidate.root, filename))) {
      throw new Error(`move this file into its save folder before batch encryption: ${path.relative(workspace, filename)}`);
    }
    if (path.basename(filename).toLowerCase() === 'param.sfo' && !candidates.some(candidate => candidate.sfo === filename)) {
      throw new Error(`batch save folder contains multiple param.sfo files: ${filename}`);
    }
  }
  const planned = [], outputs = new Set();
  for (const candidate of candidates) {
    const label = path.relative(workspace, candidate.root).split(path.sep).join('/');
    try {
      if (path.basename(path.dirname(candidate.sfo)) !== 'sce_sys' || path.basename(candidate.sfo) !== 'param.sfo') {
        throw new Error('use sce_sys/param.sfo with its original filename');
      }
      const metadata = await readChivesFile(scan, path.join(candidate.root, 'chives.json'));
      if (!hasPs5Geometry(metadata)) throw new Error('invalid PS5 chives.json geometry');
      const sfo = await readSfoFile(candidate.sfo, scan.sfoInfo);
      const titleId = metadata.title_id || sfo.titleId;
      const encryptedName = metadata.encrypted_name || path.basename(candidate.root);
      if (typeof titleId !== 'string' || !/^PPSA\d{5}$/.test(titleId)) throw new Error('missing or invalid PPSA title ID');
      if (!sfo.titleId || titleId !== sfo.titleId) throw new Error('chives.json title ID does not match param.sfo');
      if (!validLeaf(encryptedName)) throw new Error('invalid encrypted save filename');
      const output = `${titleId}/${encryptedName}`.toLowerCase();
      if (outputs.has(output)) throw new Error('duplicate encrypted save filename');
      outputs.add(output);
      planned.push({ root: candidate.root, label, titleId, accountId: sfo.accountId, encryptedName });
    } catch (error) {
      throw new Error(`cannot prepare batch save ${label}: ${error.message}`, { cause: error });
    }
  }
  return planned;
}

module.exports = { planWorkspaceSaves, scanWorkspace, readSfoFile, readChivesFile };

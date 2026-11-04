const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const HEADER_SIZE = 1304;
const HEADER_MAGIC = 0x35504647;

function decodeHeader(value, label, entryId, final) {
  if (typeof value !== 'string' || value.length !== HEADER_SIZE * 2 || !/^[0-9a-f]+$/i.test(value)) {
    throw new Error(`${label} is not a complete GFP5 header`);
  }
  const header = Buffer.from(value, 'hex');
  if (header.readUInt32LE(0) !== HEADER_MAGIC || header.readUInt32LE(4) !== entryId || Boolean(header[274]) !== final) {
    throw new Error(`${label} does not match the selected save`);
  }
  return header;
}

function savePathParts(value, filename) {
  if (typeof value !== 'string' || !value.startsWith('/')) throw new Error('save path is missing');
  const parts = value.split('/');
  if (parts.length !== 7 || parts[0] !== '' || parts[1] !== 'user' || parts[2] !== 'home' ||
      !/^[0-9a-f]{8}$/i.test(parts[3]) || !['savedata', 'savedata_prospero'].includes(parts[4]) ||
      !/^[a-z0-9]{9}$/i.test(parts[5]) || parts[6] !== filename) {
    throw new Error('save path is not a downloaded PS4/PS5 save');
  }
  return { owner: parts[3].toLowerCase(), marker: parts[4], title: parts[5].toUpperCase() };
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function inspectLocalSave(folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('Choose a save folder');
  const saveDir = path.resolve(folder);
  if (!fs.existsSync(saveDir) || !fs.statSync(saveDir).isDirectory()) throw new Error('Choose a save folder');
  const manifestPath = path.join(saveDir, 'manifest.json');
  if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
    throw new Error('Choose a folder containing manifest.json');
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new Error('The save manifest is unreadable');
  }
  const entryId = Number(manifest?.entry_id);
  if (!Number.isInteger(entryId) || entryId < 1 || entryId > 0xffffffff) {
    throw new Error('The save manifest has no valid entry ID');
  }
  const entry = manifest[String(entryId)];
  if (!entry || !Array.isArray(entry.files) || !entry.files.length) {
    throw new Error('The save manifest has no downloaded files');
  }
  decodeHeader(entry.final_header, 'Final', entryId, true);
  let identity;
  let sizeBytes = 0;
  const seen = new Set();
  for (const item of entry.files) {
    const name = item?.file;
    if (typeof name !== 'string' || !name || name === '.' || name === '..' ||
        name.includes('/') || name.includes('\\') || seen.has(name)) {
      throw new Error('The save manifest has an invalid or duplicate filename');
    }
    seen.add(name);
    const parts = savePathParts(item.path, name);
    if (identity && (parts.owner !== identity.owner || parts.marker !== identity.marker || parts.title !== identity.title)) {
      throw new Error('The save folder mixes different games or owners');
    }
    identity = parts;
    const header = decodeHeader(item.header, name, entryId, false);
    const headerPath = header.subarray(276, 1300).toString('utf8').split('\0', 1)[0];
    if (headerPath !== item.path) throw new Error(`${name} has a mismatched GFP5 path`);
    const size = Number(item.size);
    if (!Number.isSafeInteger(size) || size <= 0 || BigInt(size) !== header.readBigUInt64LE(240)) {
      throw new Error(`${name} has a mismatched GFP5 size`);
    }
    if (typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(item.sha256)) {
      throw new Error(`${name} is missing its download checksum`);
    }
    const file = path.join(saveDir, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size !== size) throw new Error(`${name} is missing or has changed size`);
    if (await hashFile(file) !== item.sha256.toLowerCase()) throw new Error(`${name} does not match its download checksum`);
    sizeBytes += size;
    if (!Number.isSafeInteger(sizeBytes)) throw new Error('The save folder is too large to verify');
  }
  const sourceMetadata = path.join(path.dirname(saveDir), 'metadata.db');
  return {
    saveDir,
    entryId,
    title: identity.title,
    owner: identity.owner,
    kind: identity.marker === 'savedata' ? 'PS4' : 'PS5',
    sizeBytes,
    sourceMetadata: fs.existsSync(sourceMetadata) ? sourceMetadata : null,
  };
}

module.exports = { inspectLocalSave };

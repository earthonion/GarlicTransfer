// Function = Build Test SFO
function makeSfo(accountId, titleId = 'PPSA24003', padding = 0) {
  const fields = [['TITLE_ID', Buffer.from(`${titleId}\0`), 0x0204]];
  if (padding) fields.push(['PADDING', Buffer.alloc(padding), 0x0004]);
  fields.push(['ACCOUNT_ID', Buffer.from(accountId, 'hex'), 0x0004]);
  const keys = Buffer.from(fields.map(([key]) => `${key}\0`).join(''));
  const keyOffset = 20 + fields.length * 16;
  const dataOffset = (keyOffset + keys.length + 3) & ~3;
  const capacities = fields.map(([, value]) => (value.length + 3) & ~3);
  const bytes = Buffer.alloc(dataOffset + capacities.reduce((sum, size) => sum + size, 0));
  bytes.write('\0PSF', 0, 'binary');
  bytes.writeUInt32LE(0x101, 4); bytes.writeUInt32LE(keyOffset, 8);
  bytes.writeUInt32LE(dataOffset, 12); bytes.writeUInt32LE(fields.length, 16);
  keys.copy(bytes, keyOffset);
  let keyStart = 0, valueStart = 0;
  for (const [index, [key, value, format]] of fields.entries()) {
    const entry = 20 + index * 16;
    bytes.writeUInt16LE(keyStart, entry); bytes.writeUInt16LE(format, entry + 2);
    bytes.writeUInt32LE(value.length, entry + 4); bytes.writeUInt32LE(capacities[index], entry + 8);
    bytes.writeUInt32LE(valueStart, entry + 12); value.copy(bytes, dataOffset + valueStart);
    keyStart += key.length + 1; valueStart += capacities[index];
  }
  return bytes;
}
module.exports = { makeSfo };

const fs = require('node:fs');
const path = require('node:path');

function pairingPrefixPath(userData, { hostId, systemVersion }) {
  if (typeof hostId !== 'string' || !/^[0-9a-f]{12}$/i.test(hostId)) {
    throw new Error('Discover a console with a valid host ID before pairing');
  }
  if (typeof systemVersion !== 'string' || !/^[0-9a-f]{8}$/i.test(systemVersion)) {
    throw new Error('Discover the console firmware before pairing');
  }
  return path.join(userData, 'pairings', `${hostId.toUpperCase()}-${systemVersion.toUpperCase()}`, 'pairing-prefix.bin');
}

function existingPairingPrefix(userData, identity) {
  const file = pairingPrefixPath(userData, identity);
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && stat.size === 32 ? file : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

module.exports = { pairingPrefixPath, existingPairingPrefix };

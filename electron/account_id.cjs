const fs = require('node:fs');
const path = require('node:path');

const ACCOUNT_FOLDER = /^[0-9a-f]{16}$/i;

function accountIdFromBackupDirectory(selected) {
  const folder = path.resolve(selected);
  if (path.basename(path.dirname(folder)).toUpperCase() === 'SAVEDATA' &&
      ACCOUNT_FOLDER.test(path.basename(folder))) {
    return BigInt(`0x${path.basename(folder)}`).toString(10);
  }

  const candidates = [folder, path.join(folder, 'SAVEDATA'), path.join(folder, 'PS4', 'SAVEDATA')];
  const saveData = candidates.find((candidate) =>
    path.basename(candidate).toUpperCase() === 'SAVEDATA' && fs.existsSync(candidate) &&
    fs.statSync(candidate).isDirectory());
  if (!saveData) throw new Error('Select a PS4 USB backup folder, its SAVEDATA folder, or one account folder inside SAVEDATA.');

  const accounts = fs.readdirSync(saveData, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && ACCOUNT_FOLDER.test(entry.name));
  if (accounts.length !== 1) {
    throw new Error('Select one account folder inside PS4/SAVEDATA; none or multiple were found.');
  }
  return BigInt(`0x${accounts[0].name}`).toString(10);
}

module.exports = { accountIdFromBackupDirectory };

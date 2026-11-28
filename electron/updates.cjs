const RELEASE_API = 'https://api.github.com/repos/earthonion/GarlicTransfer/releases/latest';
const RELEASE_URL = /^https:\/\/github\.com\/earthonion\/GarlicTransfer\/releases\/tag\/.+/;

function parseVersion(value) {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) throw new Error(`Invalid application version: ${value}`);
  return { parts: match.slice(1, 4).map(Number), pre: match[4] || '' };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index++) {
    if (a.parts[index] !== b.parts[index]) return a.parts[index] < b.parts[index] ? -1 : 1;
  }
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre < b.pre ? -1 : a.pre > b.pre ? 1 : 0;
}

async function checkForUpdates(currentVersion, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(RELEASE_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'GarlicTransfer-Update-Check' },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
  const release = await response.json();
  if (release.draft || release.prerelease) throw new Error('The latest release is not stable');
  if (typeof release.tag_name !== 'string' || !RELEASE_URL.test(release.html_url || '')) {
    throw new Error('GitHub returned an invalid release');
  }
  const latestVersion = release.tag_name.replace(/^v/, '');
  return {
    currentVersion: String(currentVersion).replace(/^v/, ''),
    latestVersion,
    updateAvailable: compareVersions(currentVersion, latestVersion) < 0,
    downloadUrl: release.html_url,
  };
}

module.exports = { checkForUpdates, compareVersions };

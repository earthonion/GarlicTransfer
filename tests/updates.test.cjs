const test = require('node:test');
const assert = require('node:assert/strict');

const { checkForUpdates, compareVersions } = require('../electron/updates.cjs');

function release(tag = 'v0.4.8') {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      tag_name: tag,
      html_url: `https://github.com/earthonion/GarlicTransfer/releases/tag/${tag}`,
      draft: false,
      prerelease: false,
    }),
  };
}

test('version comparison handles stable and prerelease versions', () => {
  assert.equal(compareVersions('0.4.7', '0.4.7'), 0);
  assert.equal(compareVersions('0.4.7', '0.4.8'), -1);
  assert.equal(compareVersions('0.5.0', '0.4.8'), 1);
  assert.equal(compareVersions('0.4.8-beta.1', '0.4.8'), -1);
  assert.equal(compareVersions('0.4.8', '0.4.8-beta.1'), 1);
});

test('update check reports a newer stable release', async () => {
  const result = await checkForUpdates('0.4.7', { fetchImpl: async () => release() });
  assert.equal(result.updateAvailable, true);
  assert.equal(result.latestVersion, '0.4.8');
  assert.equal(result.downloadUrl, 'https://github.com/earthonion/GarlicTransfer/releases/tag/v0.4.8');
});

test('update check reports when the app is current', async () => {
  const result = await checkForUpdates('v0.4.8', { fetchImpl: async () => release() });
  assert.equal(result.updateAvailable, false);
});

test('update check rejects HTTP and release payload errors', async () => {
  await assert.rejects(checkForUpdates('0.4.7', { fetchImpl: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
  await assert.rejects(checkForUpdates('0.4.7', {
    fetchImpl: async () => ({ ...release(), json: async () => ({ tag_name: 'bad' }) }),
  }), /invalid release/);
  await assert.rejects(checkForUpdates('not-a-version', { fetchImpl: async () => release() }), /Invalid application version/);
});

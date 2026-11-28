const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const root = path.join(__dirname, '..');
const plain = value => JSON.parse(JSON.stringify(value));
const consoles = [
  { host: '192.168.0.42', hostId: 'HELPER', firmware: '13600000', name: 'JB PS5', type: 'PS5' },
  { host: '192.168.0.43', hostId: 'TARGET', firmware: '14220000', name: 'Transfer PS5', type: 'PS5' },
  { host: '192.168.0.44', hostId: 'OLDER', firmware: '12020000', name: 'Older PS5', type: 'PS5' },
  { host: '192.168.0.45', hostId: 'UNKNOWN', firmware: '', name: 'Unknown firmware PS5', type: 'PS5' },
  { host: '192.168.0.46', hostId: 'PS4', firmware: '11000000', name: 'PS4', type: 'PS4' },
];

// Function Test Waiting
async function until(condition, message) {
  const deadline = Date.now() + 4000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

// Function Test Locator
async function app(t, settings = {}, bridge = {}) {
  const errors = [], calls = { discover: [], pairing: [], closeFlush: null, closeResume: null };
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  let discover = async () => plain(consoles);
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'electron/index.html'), 'utf8'), {
    url: `file://${path.join(root, 'electron/index.html')}`, runScripts: 'dangerously', resources: 'usable', virtualConsole,
    beforeParse(window) {
      window.eval(fs.readFileSync(path.join(__dirname, 'fixtures/cmp_bridge.js'), 'utf8'));
      const loader = require('../electron/skins.cjs'), bundled = path.join(root, 'electron/skins');
      window.saveTransfer.getSkins = async () => loader.loadSkins(bundled, '/nonexistent');
      window.saveTransfer.getSkinMascot = async id => loader.getSkinMascot(bundled, '/nonexistent', id);
      window.saveTransfer.openSkinsFolder = async () => '/Skins';
      const getSettings = window.saveTransfer.getSettings;
      window.saveTransfer.getSettings = async () => ({ ...await getSettings(), oracleHost: '', jbFirmwareLimit: '13.60', ...settings });
      window.saveTransfer.discover = async value => { calls.discover.push(plain(value)); return discover(value); };
      window.saveTransfer.pairingStatus = async identity => { calls.pairing.push(plain(identity)); return true; };
      Object.assign(window.saveTransfer, bridge);
      window.saveAccounts = {
        getState: async () => ({ accounts: [], selectedId: '', useCurrent: true, displayMode: 'name' }),
        onBeforeClose: (flush, resume) => { calls.closeFlush = flush; calls.closeResume = resume; },
      };
    },
  });
  t.after(() => dom.window.close());
  await new Promise(resolve => dom.window.addEventListener('load', resolve, { once: true }));
  const document = dom.window.document;
  await until(() => document.getElementById('appVersion').textContent, 'The locator app did not load settings');
  const f = { dom, window: dom.window, document, errors, calls, setDiscover: callback => { discover = callback; } };
  f.find = async () => {
    const count = calls.discover.length;
    document.getElementById('discoverBtn').click();
    await until(() => calls.discover.length === count + 1 && !document.getElementById('discoverBtn').disabled,
      'Console discovery did not finish');
  };
  return f;
}

// Function Test Role
function radio(f, role, host) {
  return f.document.querySelector(`#consoleLocatorRows input[data-role="${role}"][data-host="${host}"]`);
}

// Function Test Limit
function setLimit(f, value) {
  const input = f.document.getElementById('jbFirmwareLimit');
  input.value = value; input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
}

test('Windows network controls stay beside the selected console on Locate PS5 in both layouts', async t => {
  const checks = [], changes = [];
  let completeEnable;
  const adapter = { interfaceAlias: 'Ethernet', interfaceIndex: 12, profile: 'Public', ipv6Enabled: false, linkLocalAddress: '' };
  const ready = { ...adapter, ipv6Enabled: true, linkLocalAddress: 'fe80::123%12' };
  const f = await app(t, { interface: 'wlp4s0' }, {
    firewallAvailable: true,
    getNetworkStatus: async host => { checks.push(host); return changes.length ? ready : adapter; },
    enableIpv6: (host, index) => { changes.push([host, index]); return new Promise(resolve => { completeEnable = resolve; }); },
  });
  const el = id => f.document.getElementById(id);
  assert.ok(el('consoleTargetGroup').contains(el('consoleNetwork')));
  assert.equal(el('firewallHelperBtn').disabled, false);
  assert.equal(el('networkRefresh').disabled, true);
  await f.find();
  radio(f, 'jb', consoles[0].host).click();
  assert.deepEqual(checks, []);
  radio(f, 'ofw', consoles[1].host).click();
  await until(() => !el('networkEnable').hidden, 'Enable did not appear for the disabled adapter');
  assert.deepEqual(checks, [consoles[1].host]);
  assert.match(el('networkStatus').textContent, /Ethernet · Public · IPv6 off/);
  assert.equal(f.window.options().interface, '12');
  el('settingsSave').click();
  await until(() => f.window.cmpFixture.calls.settings.length > 0, 'Settings were not saved');
  assert.equal(f.window.cmpFixture.calls.settings.at(-1).interface, 'wlp4s0');
  el('interface').value = '33';
  assert.equal(f.window.options().interface, '33');
  el('networkEnable').click();
  for (const id of ['discoverBtn', 'manualConnectBtn', 'downloadBtn', 'uploadBtn', 'pairBtn']) assert.equal(el(id).disabled, true, id);
  assert.equal(radio(f, 'ofw', consoles[0].host).disabled, true);
  completeEnable(ready);
  await until(() => el('networkStatus').textContent.includes('IPv6 ready'), 'Updated IPv6 status was not shown');
  assert.deepEqual(changes, [[consoles[1].host, 12]]);
  assert.equal(el('networkEnable').hidden, true);
  for (const id of ['discoverBtn', 'manualConnectBtn', 'downloadBtn', 'uploadBtn', 'pairBtn']) assert.equal(el(id).disabled, false, id);
  assert.equal(el('networkStatus').title, ready.linkLocalAddress);
  assert.equal(f.document.body.dataset.layout, 'cmp');
  for (const page of ['download', 'upload', 'library', 'settings']) {
    f.document.querySelector(`[data-page="${page}"]`).click();
    assert.equal(el('consolePage').hidden, true, page);
    for (const id of ['networkRefresh', 'networkEnable', 'firewallHelperBtn']) {
      assert.ok(el('consoleTargetGroup').contains(el(id)), `${id} left Locate PS5 on ${page}`);
      assert.equal(el('cmpConnection').contains(el(id)), false);
    }
  }
  el('uiLayout').value = 'classic';
  el('uiLayout').dispatchEvent(new f.window.Event('change'));
  await until(() => f.document.body.dataset.layout === 'classic', 'Classic layout did not load');
  f.document.querySelector('[data-page="console"]').click();
  assert.equal(el('consolePage').hidden, false);
  assert.equal(el('transferConsoleHost').value, consoles[1].host);
  el('networkRefresh').click();
  await until(() => checks.length === 2 && el('networkStatus').textContent.includes('IPv6 ready'), 'Network refresh failed after navigation');
  el('firewallHelperBtn').click();
  await until(() => el('firewallStatus').textContent.includes('Local network access is allowed'), 'Firewall action failed after navigation');
  assert.deepEqual(f.errors, []);
});

test('pending network checks cannot change the new selection, and browsing locks IPv6 changes', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const adapter = { interfaceAlias: 'Wi-Fi', interfaceIndex: 3, profile: 'Private', ipv6Enabled: false, linkLocalAddress: '' };
  const f = await app(t, {}, { firewallAvailable: true, getNetworkStatus: host => host === consoles[0].host ? pending : adapter });
  const el = id => f.document.getElementById(id);
  await f.find();
  radio(f, 'ofw', consoles[0].host).click();
  el('manualHost').value = consoles[1].host;
  el('manualConnectBtn').click();
  await until(() => !el('networkEnable').disabled, 'Manual target selection did not check the adapter');
  release({ ...adapter, interfaceAlias: 'Old adapter' });
  await pending;
  assert.match(el('networkStatus').textContent, /^Wi-Fi · Private/);
  f.window.cmpFixture.emit({ type: 'ready', users: [], message: 'Ready to download' });
  assert.equal(el('networkEnable').disabled, true);
  f.window.saveTransfer.getNetworkStatus = async () => { throw new Error('route unavailable'); };
  el('networkRefresh').click();
  await until(() => el('networkStatus').textContent.includes('route unavailable'), 'Network query error was hidden');
  assert.equal(el('networkEnable').hidden, true);
  assert.deepEqual(f.errors, []);
});

test('console network detection stays hidden off Windows', async t => {
  const f = await app(t, {}, { getNetworkStatus: () => assert.fail('Unexpected Windows network lookup') });
  await f.find();
  radio(f, 'ofw', consoles[1].host).click();
  assert.equal(f.document.getElementById('consoleNetwork').hidden, true);
});

for (const remote of [false, true]) {
  test(`JB and OFW choices keep separate identities and preserve ${remote ? 'remote' : 'local'} worker mode`, async t => {
    const f = await app(t, { useRemoteOracle: remote });
    const { document, window } = f;
    await f.find();
    assert.equal(document.querySelectorAll('#consoleLocatorRows tr[data-host]').length, 5);
    assert.equal(document.querySelectorAll('#consoleLocatorRows input:checked').length, 0);
    assert.equal(document.getElementById('consoleSelect').value, '');
    assert.equal(document.getElementById('transferConsoleHost').value, '');
    assert.equal(radio(f, 'jb', consoles[0].host).disabled, false);
    assert.equal(radio(f, 'jb', consoles[2].host).disabled, false);
    assert.equal(radio(f, 'jb', consoles[1].host).disabled, true);
    assert.equal(radio(f, 'jb', consoles[3].host).disabled, true);
    assert.equal(radio(f, 'ofw', consoles[4].host).disabled, true);
    radio(f, 'ofw', consoles[1].host).click();
    const output = document.getElementById('output').value;
    assert.match(output, /TARGET$/);
    document.getElementById('metadata').value = '/profiles/TARGET/custom-metadata.db';
    const filter = document.getElementById('cmpUserSelect'), user = document.createElement('option');
    user.value = 'remembered-user'; user.textContent = 'Remembered user'; filter.appendChild(user); filter.value = user.value;
    radio(f, 'jb', consoles[0].host).click();
    assert.equal(document.getElementById('oracleHost').value, consoles[0].host);
    assert.equal(document.getElementById('cmpOracleHost').value, consoles[0].host);
    assert.equal(document.getElementById('consoleSelect').value, consoles[1].host);
    assert.equal(document.getElementById('transferConsoleHost').value, consoles[1].host);
    assert.equal(document.getElementById('transferConsoleHost').readOnly, true);
    assert.equal(document.getElementById('output').value, output);
    assert.equal(document.getElementById('metadata').value, '/profiles/TARGET/custom-metadata.db');
    assert.equal(filter.value, 'remembered-user');
    assert.equal(document.getElementById('useRemoteOracle').checked, remote);
    assert.equal(document.getElementById('cmpWorker').checked, remote);
    document.getElementById('downloadBtn').click();
    await until(() => window.cmpFixture.calls.downloads.length === 1, 'The selected source did not reach browsing');
    const job = window.cmpFixture.calls.downloads[0];
    assert.equal(job.clientHost, consoles[1].host);
    assert.equal(job.hostId, 'TARGET');
    assert.equal(job.systemVersion, '14220000');
    assert.equal(job.oracleHost, consoles[0].host);
    assert.equal(job.useRemoteOracle, remote);
    assert.deepEqual(f.errors, []);
  });
}

test('transfer labels follow direction without changing the selected console', async t => {
  const f = await app(t); await f.find();
  radio(f, 'ofw', consoles[1].host).click();
  for (const [page, label] of [['download', 'Source PS5'], ['upload', 'Receiving PS5'], ['settings', 'Source/Receiving PS5']]) {
    f.document.querySelector(`[data-page="${page}"]`).click();
    assert.equal(f.document.getElementById('transferConsoleLabel').textContent, label);
    assert.equal(f.document.getElementById('cmpTargetLabel').textContent, label);
    assert.equal(f.document.getElementById('transferConsoleHost').value, consoles[1].host);
    assert.equal(f.document.getElementById('consoleSelect').value, consoles[1].host);
  }
  assert.deepEqual(f.errors, []);
});

test('maximum JB firmware is inclusive, validates before saving, and persists for reload', async t => {
  const f = await app(t); await f.find();
  const { document, window } = f;
  for (const invalid of ['', '13.6', '13600000', 'abc']) {
    setLimit(f, invalid);
    assert.equal(radio(f, 'jb', consoles[0].host).disabled, true);
    document.getElementById('settingsSave').click();
    assert.match(document.getElementById('settingsStatus').textContent, /maximum JB firmware/);
    assert.equal(window.cmpFixture.calls.settings.length, 0);
    assert.equal(document.getElementById('jbFirmwareLimit').value, invalid);
  }
  setLimit(f, '14.22');
  assert.equal(radio(f, 'jb', consoles[1].host).disabled, false);
  radio(f, 'jb', consoles[1].host).click();
  document.getElementById('settingsSave').click();
  await until(() => window.cmpFixture.calls.settings.length === 1, 'The firmware maximum was not saved');
  assert.equal(window.cmpFixture.calls.settings[0].jbFirmwareLimit, '14.22');
  const reloaded = await app(t, plain(window.cmpFixture.settings));
  await reloaded.find();
  assert.equal(reloaded.document.getElementById('jbFirmwareLimit').value, '14.22');
  assert.equal(radio(reloaded, 'jb', consoles[1].host).disabled, false);
  assert.equal(reloaded.document.getElementById('oracleHost').value, consoles[1].host);
  setLimit(f, '13.60');
  assert.equal(document.getElementById('oracleHost').value, '');
  assert.equal(document.getElementById('cmpOracleHost').value, '');
  assert.equal(radio(f, 'jb', consoles[1].host).checked, false);
  document.getElementById('oracleHost').value = '192.168.0.99';
  document.getElementById('oracleHost').dispatchEvent(new window.Event('input', { bubbles: true }));
  setLimit(f, '12.00');
  assert.equal(document.getElementById('oracleHost').value, '192.168.0.99', 'A manual helper IP must not be erased by the locator');
  assert.deepEqual(f.errors, []); assert.deepEqual(reloaded.errors, []);
});

test('a settings write error is shown without losing the firmware maximum', async t => {
  const f = await app(t);
  f.window.saveTransfer.saveSettings = async () => { throw new Error('Test settings write failed'); };
  setLimit(f, '14.22'); f.document.getElementById('settingsSave').click();
  await until(() => f.document.getElementById('settingsStatus').textContent.includes('Test settings write failed'), 'Settings error was not displayed');
  assert.equal(f.document.getElementById('jbFirmwareLimit').value, '14.22');
  assert.deepEqual(f.errors, []);
});

test('rescanning preserves a chosen target profile and detects a changed console identity', async t => {
  const f = await app(t); await f.find();
  const { document, window } = f;
  radio(f, 'ofw', consoles[1].host).click();
  document.getElementById('downloadBtn').click();
  await until(() => window.cmpFixture.calls.downloads.length === 1, 'The original target did not open its browse session');
  window.cmpFixture.emit({ type: 'done', message: 'Original console browse closed' });
  window.cmpFixture.calls.downloads.length = 0;
  document.getElementById('metadata').value = '/profiles/TARGET/keep.db';
  document.getElementById('assets').value = '/profiles/TARGET/custom-saves';
  const output = document.getElementById('output').value;
  await f.find();
  assert.equal(document.getElementById('metadata').value, '/profiles/TARGET/keep.db');
  assert.equal(document.getElementById('assets').value, '/profiles/TARGET/custom-saves');
  assert.equal(document.getElementById('output').value, output);
  f.setDiscover(async () => [{ ...consoles[1], hostId: 'CHANGED' }]); await f.find();
  assert.equal(document.getElementById('consoleSelect').selectedOptions[0].dataset.hostId, 'TARGET');
  assert.equal(document.getElementById('output').value, output);
  assert.equal(document.getElementById('metadata').value, '/profiles/TARGET/keep.db');
  assert.equal(radio(f, 'ofw', consoles[1].host).checked, false);
  assert.match(document.getElementById('consoleLocatorStatus').textContent, /different console/);
  const started = { pairing: 0, inventory: 0 };
  window.saveTransfer.pair = async () => { started.pairing++; };
  window.saveTransfer.inventory = async () => { started.inventory++; return { entries: [], users: [] }; };
  for (const id of ['downloadBtn', 'uploadBtn', 'confirmUploadBtn', 'pairBtn']) {
    assert.equal(document.getElementById(id).disabled, true, `${id} allowed a console identity mismatch`);
    document.getElementById(id).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  }
  assert.deepEqual(started, { pairing: 0, inventory: 0 });
  assert.equal(window.cmpFixture.calls.downloads.length, 0);
  assert.equal(window.cmpFixture.calls.uploads.length, 0);
  radio(f, 'ofw', consoles[1].host).click();
  assert.match(document.getElementById('output').value, /CHANGED$/);
  assert.equal(document.getElementById('metadata').value, '');
  document.getElementById('downloadBtn').click();
  await until(() => window.cmpFixture.calls.downloads.length === 1, 'The explicitly changed target was not used');
  assert.equal(window.cmpFixture.calls.downloads[0].hostId, 'CHANGED');
  assert.equal(window.cmpFixture.calls.downloads[0].skipLaunch, false);
  assert.deepEqual(f.errors, []);
});

test('pairing labels use the legacy bool fallback and handle lookup errors independently', async t => {
  const f = await app(t); await f.find();
  await until(() => f.document.querySelector('#consoleLocatorRows tr[data-host="192.168.0.42"] [data-pairing="paired"]'),
    'Legacy paired status was not displayed');
  f.window.saveTransfer.pairingInfo = async identity => {
    if (identity.hostId === 'HELPER') throw new Error('Test pairing status unavailable');
    return { status: identity.hostId === 'TARGET' ? 'unpaired' : 'previous' };
  };
  await f.find();
  await until(() => f.document.querySelector('#consoleLocatorRows tr[data-host="192.168.0.42"] [data-pairing="unknown"]')
    && f.document.querySelector('#consoleLocatorRows tr[data-host="192.168.0.43"] [data-pairing="unpaired"]'),
  'One pairing status error prevented other row results');
  assert.equal(radio(f, 'ofw', consoles[0].host).disabled, false);
  assert.deepEqual(f.errors, []);
});

test('missing scan replies preserve role IPs, while upgraded selected helpers are cleared', async t => {
  const f = await app(t); await f.find();
  const { document } = f;
  radio(f, 'ofw', consoles[1].host).click(); radio(f, 'jb', consoles[0].host).click();
  const output = document.getElementById('output').value;
  f.setDiscover(async () => []); await f.find();
  assert.equal(document.getElementById('consoleSelect').value, consoles[1].host);
  assert.equal(document.getElementById('oracleHost').value, consoles[0].host);
  assert.equal(document.getElementById('output').value, output);
  assert.equal(document.querySelectorAll('#consoleLocatorRows input:checked').length, 0);
  f.setDiscover(async () => [{ ...consoles[0], firmware: '14220000' }, consoles[1]]); await f.find();
  assert.equal(document.getElementById('oracleHost').value, '');
  assert.equal(document.getElementById('cmpOracleHost').value, '');
  assert.equal(radio(f, 'jb', consoles[0].host).disabled, true);
  assert.equal(radio(f, 'ofw', consoles[1].host).checked, true);
  assert.equal(document.getElementById('output').value, output);
  assert.deepEqual(f.errors, []);
});

test('a later manual scan selects its OFW target and ignores the older broadcast reply', async t => {
  const f = await app(t);
  const { document } = f;
  let release;
  f.setDiscover(value => value.targetHost ? Promise.resolve([consoles[1]]) : new Promise(resolve => { release = resolve; }));
  document.getElementById('discoverBtn').click();
  await until(() => typeof release === 'function', 'Broadcast discovery did not start');
  document.getElementById('manualHost').value = consoles[1].host;
  document.getElementById('manualConnectBtn').click();
  await until(() => !document.getElementById('manualConnectBtn').disabled && document.getElementById('consoleSelect').value === consoles[1].host,
    'Manual discovery did not select the responding target');
  release([consoles[0]]);
  await until(() => !document.getElementById('discoverBtn').disabled, 'The stale scan did not settle');
  assert.equal(document.getElementById('consoleSelect').value, consoles[1].host);
  assert.equal(radio(f, 'ofw', consoles[1].host).checked, true);
  assert.equal(radio(f, 'ofw', consoles[0].host), null);
  assert.equal(document.getElementById('oracleHost').value, '');
  assert.equal(f.calls.discover[1].targetHost, consoles[1].host);
  assert.deepEqual(f.errors, []);
});

test('invalid and unsupported manual addresses do not select a target', async t => {
  const f = await app(t);
  const { document } = f;
  document.getElementById('manualHost').value = '192.168.0.999'; document.getElementById('manualConnectBtn').click();
  assert.equal(f.calls.discover.length, 0);
  assert.match(document.getElementById('consoleLocatorStatus').textContent, /valid PS5 IPv4/);
  f.setDiscover(async () => [consoles[4]]);
  document.getElementById('manualHost').value = consoles[4].host; document.getElementById('manualConnectBtn').click();
  await until(() => f.calls.discover.length === 1 && !document.getElementById('manualConnectBtn').disabled, 'Unsupported manual discovery did not settle');
  assert.equal(document.getElementById('consoleSelect').value, '');
  assert.match(document.getElementById('consoleLocatorStatus').textContent, /No PS5 responded/);
  assert.deepEqual(f.errors, []);
});

test('scan errors retain selected roles and recover on retry', async t => {
  const f = await app(t); await f.find();
  const { document } = f;
  radio(f, 'ofw', consoles[1].host).click(); radio(f, 'jb', consoles[0].host).click();
  f.setDiscover(async () => { throw new Error('Test discovery failed'); }); await f.find();
  assert.match(document.getElementById('consoleLocatorStatus').textContent, /Test discovery failed/);
  assert.equal(radio(f, 'ofw', consoles[1].host).checked, true);
  assert.equal(radio(f, 'jb', consoles[0].host).checked, true);
  f.setDiscover(async () => plain(consoles)); await f.find();
  assert.equal(radio(f, 'ofw', consoles[1].host).checked, true);
  assert.equal(document.getElementById('discoverBtn').disabled, false);
  assert.deepEqual(f.errors, []);
});

test('transfer, browse and close locks reject forced role and discovery events', async t => {
  const f = await app(t); await f.find();
  const { document, window } = f;
  radio(f, 'ofw', consoles[1].host).click();
  let release;
  window.saveTransfer.download = value => {
    window.cmpFixture.calls.downloads.push(plain(value));
    return new Promise(resolve => { release = resolve; });
  };
  document.getElementById('downloadBtn').click();
  await until(() => typeof release === 'function', 'The transfer did not begin');
  async function assertLocked() {
    const count = f.calls.discover.length;
    for (const role of ['jb', 'ofw']) {
      const input = radio(f, role, consoles[0].host);
      assert.equal(input.disabled, true); input.checked = true;
      input.dispatchEvent(new window.Event('change', { bubbles: true }));
    }
    document.getElementById('discoverBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    document.getElementById('manualHost').value = consoles[0].host;
    document.getElementById('manualConnectBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.equal(f.calls.discover.length, count);
    assert.equal(document.getElementById('consoleSelect').value, consoles[1].host);
    assert.equal(document.getElementById('oracleHost').value, '');
  }
  await assertLocked();
  window.cmpFixture.emit({ type: 'ready', message: 'Browse open', users: window.cmpFixture.users });
  await assertLocked();
  release(); window.cmpFixture.emit({ type: 'done', message: 'Browse closed' });
  assert.equal(radio(f, 'ofw', consoles[0].host).disabled, false);
  await f.calls.closeFlush(); await assertLocked();
  f.calls.closeResume();
  assert.equal(radio(f, 'jb', consoles[0].host).disabled, false);
  radio(f, 'jb', consoles[0].host).click();
  assert.equal(document.getElementById('oracleHost').value, consoles[0].host);
  assert.deepEqual(f.errors, []);
});

test('a discovery response superseded by a transfer cannot replace the locator list', async t => {
  const f = await app(t); await f.find();
  const { document, window } = f;
  radio(f, 'ofw', consoles[1].host).click();
  let release;
  f.setDiscover(() => new Promise(resolve => { release = resolve; }));
  document.getElementById('discoverBtn').click();
  await until(() => typeof release === 'function', 'The delayed scan did not start');
  document.getElementById('downloadBtn').click();
  window.cmpFixture.emit({ type: 'done', message: 'Transfer completed before scan response' });
  release([{ ...consoles[1], hostId: 'STALE' }]);
  await until(() => !document.getElementById('discoverBtn').disabled, 'The discarded discovery did not settle');
  assert.equal(document.getElementById('consoleSelect').selectedOptions[0].dataset.hostId, 'TARGET');
  assert.match(document.getElementById('output').value, /TARGET$/);
  assert.equal(document.querySelectorAll('#consoleLocatorRows tr[data-host]').length, consoles.length);
  assert.deepEqual(f.errors, []);
});

test('per-console pairing details ignore stale results and refresh after pairing', async t => {
  const f = await app(t);
  const { document, window } = f;
  const requests = [], responses = [];
  window.saveTransfer.pairingInfo = identity => {
    requests.push(plain(identity));
    return new Promise(resolve => { responses.push(resolve); });
  };
  f.setDiscover(async () => [consoles[0]]); await f.find();
  await until(() => responses.length === 1, 'The first console pairing status was not requested');
  f.setDiscover(async () => [{ ...consoles[0], firmware: '14220000' }]); await f.find();
  await until(() => responses.length === 2, 'The changed firmware pairing status was not requested');
  assert.deepEqual(requests, [{ hostId: 'HELPER', systemVersion: '13600000' }, { hostId: 'HELPER', systemVersion: '14220000' }]);
  responses[1]({ status: 'previous' });
  await until(() => document.querySelector('#consoleLocatorRows tr[data-host]').textContent.includes('Pair again'), 'Previous-version pairing was not displayed');
  responses[0]({ status: 'paired' });
  await until(() => !document.getElementById('discoverBtn').disabled, 'Discovery remained disabled');
  assert.match(document.querySelector('#consoleLocatorRows tr[data-host]').textContent, /Pair again/);
  radio(f, 'ofw', consoles[0].host).click();
  window.cmpFixture.emit({ type: 'paired', message: 'Paired successfully' });
  await until(() => responses.length === 3, 'A pairing event did not refresh the row status');
  responses[2]({ status: 'paired' });
  await until(() => document.querySelector('#consoleLocatorRows tr[data-host]').textContent.includes('Paired'), 'The paired status did not refresh');
  assert.deepEqual(f.errors, []);
});

test('a cold lowercase discovery preserves its profile and armed session through an uppercase rescan', async t => {
  const f = await app(t);
  const { document, window } = f;
  document.getElementById('preferIpv6').checked = false;
  f.setDiscover(async () => [{ ...consoles[0], type: ' ps5 ' }, { ...consoles[1], hostId: 'aabbccddeeff' }]);
  await f.find(); radio(f, 'ofw', consoles[1].host).click(); radio(f, 'jb', consoles[0].host).click();
  const selected = document.getElementById('consoleSelect').selectedOptions[0];
  const output = document.getElementById('output').value;
  assert.match(output, /aabbccddeeff$/);
  assert.equal(selected.dataset.hostId, 'AABBCCDDEEFF');
  assert.equal(selected.dataset.profileId, 'aabbccddeeff');
  document.getElementById('downloadBtn').click();
  await until(() => window.cmpFixture.calls.downloads.length === 1, 'The legacy profile did not open its session');
  window.cmpFixture.emit({ type: 'done', message: 'Original browse finished' });
  document.getElementById('metadata').value = '/profiles/aabbccddeeff/keep.db';
  document.getElementById('assets').value = '/profiles/aabbccddeeff/custom-saves';
  f.setDiscover(async () => [{ ...consoles[0], type: ' PS5 ' }, { ...consoles[1], hostId: ' AABBCCDDEEFF ' }]);
  await f.find();
  assert.equal(document.getElementById('oracleHost').value, consoles[0].host);
  assert.equal(document.getElementById('cmpOracleHost').value, consoles[0].host);
  assert.equal(radio(f, 'jb', consoles[0].host).checked, true);
  assert.equal(radio(f, 'ofw', consoles[1].host).checked, true);
  assert.equal(document.getElementById('output').value, output);
  assert.equal(document.getElementById('metadata').value, '/profiles/aabbccddeeff/keep.db');
  assert.equal(document.getElementById('assets').value, '/profiles/aabbccddeeff/custom-saves');
  assert.equal(document.getElementById('consoleSelect').selectedOptions[0].dataset.hostId, 'AABBCCDDEEFF');
  assert.equal(document.getElementById('consoleSelect').selectedOptions[0].dataset.profileId, 'aabbccddeeff');
  assert.equal(document.getElementById('downloadBtn').disabled, false);
  document.getElementById('downloadBtn').click();
  await until(() => window.cmpFixture.calls.downloads.length === 2, 'The case-only rescan blocked the existing target');
  assert.equal(window.cmpFixture.calls.downloads[1].skipLaunch, true);
  assert.equal(window.cmpFixture.calls.downloads[1].skipPower, true);
  assert.equal(window.cmpFixture.calls.downloads[1].output, output);
  assert.equal(window.cmpFixture.calls.downloads[1].hostId, 'AABBCCDDEEFF');
  assert.equal(window.cmpFixture.calls.downloads[1].profileId, 'aabbccddeeff');
  assert.deepEqual(f.errors, []);
});

test('broadcast and manual discovery share canonical addresses and discard duplicate records', async t => {
  const f = await app(t);
  const { document } = f;
  f.setDiscover(async () => [
    { ...consoles[1], host: '192.168.000.043', hostId: ' target ', type: ' ps5 ' },
    { ...consoles[1], hostId: 'DUPLICATE' },
    { ...consoles[0], host: '192.168.0.999' },
  ]);
  await f.find();
  assert.equal(document.querySelectorAll('#consoleLocatorRows tr[data-host]').length, 1);
  assert.equal(document.getElementById('consoleSelect').options.length, 2);
  assert.equal(radio(f, 'ofw', consoles[1].host).disabled, false);
  document.getElementById('manualHost').value = '192.168.000.043';
  document.getElementById('manualConnectBtn').click();
  await until(() => !document.getElementById('manualConnectBtn').disabled && document.getElementById('consoleSelect').value,
    'Manual discovery did not use the same canonical record');
  assert.equal(document.getElementById('consoleSelect').value, consoles[1].host);
  assert.equal(document.getElementById('consoleSelect').selectedOptions[0].dataset.hostId, 'TARGET');
  assert.equal(document.getElementById('transferConsoleHost').value, consoles[1].host);
  assert.deepEqual(f.errors, []);
});

test('pairing uses one ordered batch and changes only badges while preserving role focus', async t => {
  const f = await app(t);
  const { document, window } = f;
  const batches = [], responses = [];
  window.saveTransfer.pairingInfos = identities => {
    batches.push(plain(identities));
    return new Promise(resolve => { responses.push(resolve); });
  };
  let singles = 0;
  window.saveTransfer.pairingInfo = async () => { singles++; return { status: 'unknown' }; };
  await f.find();
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0], [
    { hostId: 'HELPER', systemVersion: '13600000' },
    { hostId: 'TARGET', systemVersion: '14220000' },
    { hostId: 'OLDER', systemVersion: '12020000' },
  ]);
  const chosen = radio(f, 'ofw', consoles[1].host);
  chosen.click(); chosen.focus();
  const row = chosen.closest('tr'), mutations = [];
  const observer = new window.MutationObserver(records => mutations.push(...records));
  observer.observe(document.getElementById('consoleLocatorRows'), { subtree: true, childList: true, characterData: true, attributes: true });
  responses[0]([{ status: 'paired' }, { status: 'previous' }, { status: 'unpaired' }]);
  await until(() => row.querySelector('[data-pairing="previous"]')
    && document.getElementById('pairingState').textContent.includes('another firmware'),
  'The ordered batch result did not update the row and selected pairing panel');
  mutations.push(...observer.takeRecords()); observer.disconnect();
  assert.ok(mutations.length, 'The pairing response made no badge updates');
  assert.ok(mutations.every(record => {
    const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
    return Boolean(element?.closest('.console-locator-pairing'));
  }), 'A pairing-only response mutated names, radios or row order');
  assert.equal(radio(f, 'ofw', consoles[1].host), chosen);
  assert.equal(chosen.closest('tr'), row);
  assert.equal(chosen.checked, true);
  assert.equal(document.activeElement, chosen);
  assert.equal(singles, 0);
  assert.equal(f.calls.pairing.length, 0, 'Selecting a known row must reuse its pairing result');
  assert.deepEqual(f.errors, []);
});

test('stale pairing batches cannot restore a green selected identity after its IP changes consoles', async t => {
  const f = await app(t);
  const { document, window } = f;
  const responses = [];
  window.saveTransfer.pairingInfos = () => new Promise(resolve => { responses.push(resolve); });
  f.setDiscover(async () => [consoles[1]]); await f.find();
  radio(f, 'ofw', consoles[1].host).click();
  assert.equal(document.getElementById('sidebarConsole').classList.contains('connected'), true);
  f.setDiscover(async () => [{ ...consoles[1], hostId: 'NEW-TARGET' }]); await f.find();
  assert.equal(responses.length, 2);
  assert.equal(document.getElementById('sidebarConsole').classList.contains('connected'), false);
  assert.match(document.getElementById('sidebarConsoleName').textContent, /Choose OFW/);
  assert.equal(document.getElementById('pairingState').classList.contains('paired'), false);
  assert.match(document.getElementById('pairingState').textContent, /Choose the OFW/);
  responses[0]([{ status: 'paired' }]);
  responses[1]([{ status: 'paired' }]);
  await until(() => document.querySelector('#consoleLocatorRows [data-pairing="paired"]'), 'The new console badge did not receive its own result');
  assert.equal(document.getElementById('sidebarConsole').classList.contains('connected'), false);
  assert.equal(document.getElementById('pairingState').classList.contains('paired'), false);
  assert.match(document.getElementById('pairingState').textContent, /Choose the OFW/);
  radio(f, 'ofw', consoles[1].host).click();
  assert.equal(document.getElementById('sidebarConsole').classList.contains('connected'), true);
  assert.equal(document.getElementById('pairingState').classList.contains('paired'), true);
  assert.equal(responses.length, 2, 'The explicitly selected row should reuse its checked pairing result');
  assert.deepEqual(f.errors, []);
});

test('a late legacy pairing check cannot mark an unconfirmed replacement console as paired', async t => {
  const f = await app(t);
  const { document, window } = f;
  let finish, checked = false;
  window.saveTransfer.pairingStatus = () => new Promise(resolve => { finish = resolve; }).then(result => { checked = true; return result; });
  const option = document.createElement('option');
  option.value = consoles[1].host; option.dataset.hostId = 'TARGET'; option.dataset.firmware = '14220000';
  option.textContent = 'Original target'; document.getElementById('consoleSelect').appendChild(option);
  document.getElementById('consoleSelect').value = option.value;
  document.getElementById('consoleSelect').dispatchEvent(new window.Event('change'));
  await until(() => typeof finish === 'function', 'The legacy target did not request pairing status');
  window.saveTransfer.pairingInfos = async () => [{ status: 'paired' }];
  f.setDiscover(async () => [{ ...consoles[1], hostId: 'NEW-TARGET' }]); await f.find();
  finish(true); await until(() => checked, 'The old pairing check did not settle');
  assert.equal(document.getElementById('pairingState').classList.contains('paired'), false);
  assert.match(document.getElementById('pairingState').textContent, /Choose the OFW/);
  assert.equal(document.getElementById('sidebarConsole').classList.contains('connected'), false);
  assert.deepEqual(f.errors, []);
});

// Function Armed Console
async function armConsole(f, console) {
  const { document, window } = f;
  f.setDiscover(async () => [plain(console)]); await f.find();
  radio(f, 'ofw', console.host).click();
  document.getElementById('downloadBtn').click();
  await until(() => window.cmpFixture.calls.downloads.length === 1, 'The console did not open its browse session');
  window.cmpFixture.emit({ type: 'done', message: 'Browse session finished' });
  document.getElementById('assets').value = '/custom/existing-saves';
  document.getElementById('metadata').value = '/custom/existing-metadata.db';
  return document.getElementById('output').value;
}

for (const [firmware, description] of [['14220000', 'major/minor firmware upgrade'], ['13600001', 'raw firmware patch revision']]) {
  test(`a ${description} clears armed transfer flags while preserving the selected profile`, async t => {
    const f = await app(t);
    const { document, window } = f;
    const target = consoles[0];
    const output = await armConsole(f, target);
    f.setDiscover(async () => [{ ...target, firmware }]); await f.find();
    assert.equal(document.getElementById('output').value, output);
    assert.equal(document.getElementById('assets').value, '/custom/existing-saves');
    assert.equal(document.getElementById('metadata').value, '/custom/existing-metadata.db');
    assert.equal(document.getElementById('consoleSelect').selectedOptions[0].dataset.firmware, firmware);
    assert.equal(radio(f, 'ofw', target.host).checked, true);
    document.getElementById('downloadBtn').click();
    await until(() => window.cmpFixture.calls.downloads.length === 2, 'The updated console could not start its next transfer');
    const job = window.cmpFixture.calls.downloads[1];
    assert.equal(job.clientHost, target.host);
    assert.equal(job.hostId, target.hostId);
    assert.equal(job.systemVersion, firmware);
    assert.equal(job.output, output);
    assert.equal(job.assets, '/custom/existing-saves');
    assert.equal(job.metadata, '/custom/existing-metadata.db');
    assert.equal(job.skipLaunch, false);
    assert.equal(job.skipPower, false);
    assert.deepEqual(f.errors, []);
  });
}

test('manual refresh of the same target firmware clears its armed flags without resetting profile paths', async t => {
  const f = await app(t);
  const { document, window } = f;
  const target = consoles[0], firmware = '14220000';
  const output = await armConsole(f, target);
  f.setDiscover(async () => [{ ...target, firmware }]);
  const count = f.calls.discover.length;
  document.getElementById('manualHost').value = target.host;
  document.getElementById('manualConnectBtn').click();
  await until(() => f.calls.discover.length === count + 1 && !document.getElementById('manualConnectBtn').disabled,
    'Manual refresh of the selected target did not finish');
  assert.equal(f.calls.discover.at(-1).targetHost, target.host);
  assert.equal(document.getElementById('output').value, output);
  assert.equal(document.getElementById('assets').value, '/custom/existing-saves');
  assert.equal(document.getElementById('metadata').value, '/custom/existing-metadata.db');
  assert.equal(radio(f, 'ofw', target.host).checked, true);
  document.getElementById('downloadBtn').click();
  await until(() => window.cmpFixture.calls.downloads.length === 2, 'The manually refreshed console could not browse');
  const job = window.cmpFixture.calls.downloads[1];
  assert.equal(job.systemVersion, firmware);
  assert.equal(job.skipLaunch, false);
  assert.equal(job.skipPower, false);
  assert.deepEqual(f.errors, []);
});

test('a prepared upload refreshes firmware and armed flags without losing its pending selections', async t => {
  const f = await app(t);
  const { document, window } = f;
  const target = consoles[0], firmware = '14220000';
  const output = await armConsole(f, target);
  const uploads = [];
  window.saveTransfer.upload = async value => { uploads.push(plain(value)); };
  document.querySelector('[data-page="upload"]').click();
  document.getElementById('uploadBtn').click();
  await until(() => !document.getElementById('confirmUploadBtn').hidden,
    'Preparing the upload did not expose its selections');
  const saveSelect = document.getElementById('uploadSaveSelect');
  const userSelect = document.getElementById('userSelect');
  assert.ok(saveSelect.options[0]); saveSelect.options[0].selected = true;
  const selectedSave = saveSelect.options[0].value, selectedUser = userSelect.value;
  document.querySelector('[data-page="console"]').click();
  f.setDiscover(async () => [{ ...target, firmware }]); await f.find();
  assert.equal(document.getElementById('confirmUploadBtn').hidden, false);
  assert.equal(saveSelect.selectedOptions[0].value, selectedSave);
  assert.equal(userSelect.value, selectedUser);
  assert.equal(document.getElementById('metadata').value, '/custom/existing-metadata.db');
  document.querySelector('[data-page="upload"]').click();
  document.getElementById('confirmUploadBtn').click();
  await until(() => uploads.length === 1, 'The prepared upload did not start after the firmware rescan');
  assert.equal(uploads[0].clientHost, target.host);
  assert.equal(uploads[0].hostId, target.hostId);
  assert.equal(uploads[0].systemVersion, firmware);
  assert.equal(uploads[0].skipLaunch, false);
  assert.equal(uploads[0].skipPower, false);
  assert.equal(uploads[0].metadata, '/custom/existing-metadata.db');
  assert.equal(uploads[0].output, output);
  assert.equal(uploads[0].userId, selectedUser);
  assert.deepEqual(uploads[0].entryIds, [Number(selectedSave)]);
  assert.deepEqual(f.errors, []);
});

test('an inventory fallback uses refreshed firmware while preserving desired upload selections', async t => {
  const f = await app(t);
  const { document, window } = f;
  const target = consoles[0], firmware = '14220000';
  const output = await armConsole(f, target);
  const downloads = [], uploads = [];
  let rejectInventory;
  window.saveTransfer.inventory = () => new Promise((_resolve, reject) => { rejectInventory = reject; });
  window.saveTransfer.download = async value => { downloads.push(plain(value)); };
  window.saveTransfer.upload = async value => { uploads.push(plain(value)); };
  document.getElementById('metadata').value = '';
  document.querySelector('[data-page="upload"]').click();
  const preparation = window.startUpload({ entryIds: [123], userId: '22aabbcc' });
  await until(() => typeof rejectInventory === 'function', 'Upload preparation did not wait for inventory');
  f.setDiscover(async () => [{ ...target, firmware }]); await f.find();
  rejectInventory(new Error('Test previous metadata missing'));
  await until(() => downloads.length === 1, 'Missing inventory did not fall back to a metadata download');
  await preparation;
  assert.equal(downloads[0].metadataOnly, true);
  assert.equal(downloads[0].clientHost, target.host);
  assert.equal(downloads[0].hostId, target.hostId);
  assert.equal(downloads[0].systemVersion, firmware);
  assert.equal(downloads[0].skipLaunch, false);
  assert.equal(downloads[0].skipPower, false);
  assert.equal(downloads[0].output, output);
  assert.equal(downloads[0].assets, '/custom/existing-saves');
  window.cmpFixture.emit({ type: 'entries', entries: window.cmpFixture.entries, users: window.cmpFixture.users });
  window.cmpFixture.emit({ type: 'done', metadataOnly: true, message: 'Fresh metadata ready', users: window.cmpFixture.users });
  assert.equal(document.getElementById('confirmUploadBtn').hidden, false);
  assert.equal(document.getElementById('userSelect').value, '22aabbcc');
  assert.deepEqual([...document.getElementById('uploadSaveSelect').selectedOptions].map(option => option.value), ['123']);
  assert.equal(document.getElementById('output').value, output);
  assert.equal(radio(f, 'ofw', target.host).checked, true);
  const metadata = document.getElementById('metadata').value;
  document.getElementById('confirmUploadBtn').click();
  await until(() => uploads.length === 1, 'The selected upload did not continue after fresh metadata');
  assert.equal(uploads[0].systemVersion, firmware);
  assert.equal(uploads[0].skipLaunch, false);
  assert.equal(uploads[0].skipPower, false);
  assert.equal(uploads[0].output, output);
  assert.equal(uploads[0].metadata, metadata);
  assert.equal(uploads[0].userId, '22aabbcc');
  assert.deepEqual(uploads[0].entryIds, [123]);
  assert.deepEqual(f.errors, []);
});

// Function Pending Settings
function holdSettings(f) {
  const requests = [];
  f.window.saveTransfer.saveSettings = value => {
    let resolve, reject;
    const promise = new Promise((saved, failed) => { resolve = saved; reject = failed; });
    requests.push({ value: plain(value), promise, resolve, reject });
    return promise;
  };
  return requests;
}

// Function Settle Settings
async function settleSettings(request, error = '') {
  if (error) request.reject(new Error(error));
  else request.resolve();
  await request.promise.catch(() => {});
}

test('finishing a settings save preserves a newer firmware edit and reports that it remains unsaved', async t => {
  const f = await app(t);
  const { document } = f;
  const requests = holdSettings(f);
  setLimit(f, '14.22'); document.getElementById('settingsSave').click();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].value.jbFirmwareLimit, '14.22');
  setLimit(f, '15.00');
  await settleSettings(requests[0]);
  assert.equal(document.getElementById('jbFirmwareLimit').value, '15.00');
  assert.match(document.getElementById('settingsStatus').textContent, /unsaved|not saved/i);
  document.getElementById('settingsSave').click();
  assert.equal(requests[1].value.jbFirmwareLimit, '15.00');
  await settleSettings(requests[1]);
  assert.equal(document.getElementById('jbFirmwareLimit').value, '15.00');
  assert.match(document.getElementById('settingsStatus').textContent, /saved/i);
  assert.doesNotMatch(document.getElementById('settingsStatus').textContent, /unsaved|not saved/i);
  assert.deepEqual(f.errors, []);
});

for (const earlierResult of ['success', 'error']) {
  test(`an earlier settings ${earlierResult} arriving last cannot overwrite the newest save`, async t => {
    const f = await app(t);
    const { document } = f;
    const requests = holdSettings(f);
    setLimit(f, '14.22'); document.getElementById('settingsSave').click();
    setLimit(f, '15.00'); document.getElementById('settingsSave').click();
    assert.equal(requests.length, 2);
    await settleSettings(requests[1]);
    const latestStatus = document.getElementById('settingsStatus').textContent;
    assert.match(latestStatus, /saved/i);
    assert.doesNotMatch(latestStatus, /unsaved|not saved/i);
    await settleSettings(requests[0], earlierResult === 'error' ? 'Earlier settings write failed' : '');
    assert.equal(document.getElementById('jbFirmwareLimit').value, '15.00');
    assert.equal(document.getElementById('settingsStatus').textContent, latestStatus);
    assert.deepEqual(f.errors, []);
  });
}

test('an older settings error cannot replace the status of a newer pending request', async t => {
  const f = await app(t);
  const { document } = f;
  const requests = holdSettings(f);
  setLimit(f, '14.22'); document.getElementById('settingsSave').click();
  setLimit(f, '15.00'); document.getElementById('settingsSave').click();
  const latestStatus = document.getElementById('settingsStatus').textContent;
  await settleSettings(requests[0], 'Earlier settings write failed');
  assert.equal(document.getElementById('jbFirmwareLimit').value, '15.00');
  assert.equal(document.getElementById('settingsStatus').textContent, latestStatus);
  await settleSettings(requests[1]);
  assert.match(document.getElementById('settingsStatus').textContent, /saved/i);
  assert.doesNotMatch(document.getElementById('settingsStatus').textContent, /failed|unsaved|not saved/i);
  assert.deepEqual(f.errors, []);
});

test('an older settings success cannot hide the latest settings failure', async t => {
  const f = await app(t);
  const { document } = f;
  const requests = holdSettings(f);
  setLimit(f, '14.22'); document.getElementById('settingsSave').click();
  setLimit(f, '15.00'); document.getElementById('settingsSave').click();
  await settleSettings(requests[1], 'Latest settings write failed');
  const latestStatus = document.getElementById('settingsStatus').textContent;
  assert.match(latestStatus, /Latest settings write failed/);
  await settleSettings(requests[0]);
  assert.equal(document.getElementById('jbFirmwareLimit').value, '15.00');
  assert.equal(document.getElementById('settingsStatus').textContent, latestStatus);
  assert.deepEqual(f.errors, []);
});

test('an invalid newer Save supersedes an earlier pending valid settings request', async t => {
  const f = await app(t);
  const { document } = f;
  const requests = holdSettings(f);
  setLimit(f, '14.22'); document.getElementById('settingsSave').click();
  setLimit(f, '13.6'); document.getElementById('settingsSave').click();
  const validationStatus = document.getElementById('settingsStatus').textContent;
  assert.equal(requests.length, 1, 'An invalid firmware maximum must not reach settings persistence');
  assert.match(validationStatus, /maximum JB firmware/);
  await settleSettings(requests[0]);
  assert.equal(document.getElementById('jbFirmwareLimit').value, '13.6');
  assert.equal(document.getElementById('settingsStatus').textContent, validationStatus);
  assert.deepEqual(f.errors, []);
});

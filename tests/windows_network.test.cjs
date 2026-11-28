const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { getNetworkStatus, enableIpv6 } = require('../electron/windows_network.cjs');

const host = '192.168.0.220';
const adapter = {
  interfaceIndex: 12, interfaceAlias: 'Réseau sans fil', profile: 'Public', ipv6Enabled: false, linkLocalAddress: '',
};
const guid = '897a5788-8aad-46ca-871a-9023ac28dd62';
const result = status => JSON.stringify({ ...status, interfaceGuid: guid });
const decode = text => Buffer.from(text, 'base64').toString('utf16le');

function windows(t, ...replies) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  const systemRoot = process.env.SystemRoot;
  process.env.SystemRoot = 'C:\\Windows';
  t.after(() => {
    Object.defineProperty(process, 'platform', platform);
    if (systemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = systemRoot;
  });
  const commands = [];
  t.mock.method(childProcess, 'execFile', (file, args, options, done) => {
    assert.equal(file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.equal(options.windowsHide, true);
    assert.deepEqual(args.slice(0, -1), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
    commands.push(decode(args.at(-1)));
    assert.ok(replies.length, 'unexpected command');
    const reply = replies.shift();
    if (typeof reply === 'number') done({ code: reply }, '', '');
    else done(null, reply, '');
  });
  return commands;
}

test('reads the selected adapter without elevation and preserves localized names', async t => {
  const commands = windows(t, result(adapter));
  assert.deepEqual(await getNetworkStatus(host), adapter);
  assert.equal(commands.length, 1);
  assert.match(commands[0], /-ConsoleAddress '192\.168\.0\.220'$/);
  assert.doesNotMatch(commands[0], /Start-Process/);
});

test('rejects invalid hosts and indices before starting PowerShell', async t => {
  const commands = windows(t);
  for (const input of [null, "127.0.0.1'; exit", '192.168.1.100/24', 'ps5.example', 'fe80::5']) {
    await assert.rejects(getNetworkStatus(input), /valid IPv4/);
  }
  for (const idx of ['12', 0, -1, 3.14, 0x100000000]) {
    await assert.rejects(enableIpv6(host, idx), /Refresh/);
  }
  assert.deepEqual(commands, []);
});

test('a stale index or an already enabled binding never opens UAC', async t => {
  const enabled = { ...adapter, ipv6Enabled: true };
  const commands = windows(t, result(adapter), result(enabled));
  await assert.rejects(enableIpv6(host, 99), /adapter.*changed/);
  assert.deepEqual(await enableIpv6(host, adapter.interfaceIndex), enabled);
  assert.equal(commands.length, 2);
  assert.ok(commands.every(command => !command.includes('Start-Process')));
});

test('elevates for the verified adapter and returns its refreshed IPv6 address', async t => {
  const enabled = { ...adapter, ipv6Enabled: true, linkLocalAddress: 'fe80::1234' };
  const commands = windows(t, result(adapter), '', result(enabled));
  assert.deepEqual(await enableIpv6(host, 12), enabled);
  const encodedAction = /'-EncodedCommand','([A-Za-z0-9+/=]+)'/.exec(commands[1])[1];
  assert.match(decode(encodedAction), new RegExp("-Enable -ExpectedIndex 12 -ExpectedGuid '" + guid + "'$"));
  assert.equal(commands.length, 3);
});

test('distinguishes cancelled UAC and a route change during UAC', async t => {
  const commands = windows(t, result(adapter), 21, result(adapter), 20);
  await assert.rejects(enableIpv6(host, 12), /approval was cancelled/);
  await assert.rejects(enableIpv6(host, 12), /adapter.*changed/);
  assert.equal(commands.length, 4);
});

test('PowerShell checks the routed adapter and stops elevation if its identity changes', t => {
  const script = fs.readFileSync(path.join(__dirname, '../electron/windows_network.ps1'), 'utf8');
  const executable = process.platform === 'win32'
    ? path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') : 'pwsh';
  const mockNetwork = `
    function Find-NetRoute { [PSCustomObject]@{InterfaceIndex=12} }
    function Get-NetAdapter { [PSCustomObject]@{ifIndex=12;Name='Test';InterfaceGuid='${guid}'} }
    function Get-NetAdapterBinding { [PSCustomObject]@{Name='Test';Enabled=$bindingOn;ComponentID='ms_tcpip6'} }
    function Get-NetConnectionProfile { [PSCustomObject]@{NetworkCategory='Private'} }
    function Get-NetIPAddress { [PSCustomObject]@{IPAddress='fe80::abcd'} }
    function Enable-NetAdapterBinding {
      param($InputObject, [switch]$Confirm)
      if ($InputObject.Name -ne 'Test' -or $InputObject.ComponentID -ne 'ms_tcpip6' -or $Confirm) { throw 'Wrong binding' }
      [Console]::WriteLine('enabled')
    }
  `;
  function run(extra, bindingOn = true) {
    const command = `$bindingOn = $${bindingOn}\n${mockNetwork}\n& {\n${script}\n} -ConsoleAddress '${host}' ${extra}`;
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive',
      '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')];
    return childProcess.spawnSync(executable,
      args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  }
  const read = run('');
  if (read.error?.code === 'ENOENT' && process.platform !== 'win32') return t.skip('PowerShell is unavailable');
  assert.equal(read.status, 0, read.stderr);
  const status = JSON.parse(read.stdout);
  assert.deepEqual(status, { ...adapter, interfaceAlias: 'Test', interfaceGuid: guid, profile: 'Private',
    ipv6Enabled: true, linkLocalAddress: 'fe80::abcd' });
  const enable = run(`-Enable -ExpectedIndex 12 -ExpectedGuid '${guid}'`, false);
  assert.equal(enable.status, 0, enable.stderr);
  assert.equal(enable.stdout.trim(), 'enabled');
  assert.equal(run(`-Enable -ExpectedIndex 12 -ExpectedGuid '00000000-0000-0000-0000-000000000001'`).status, 20);
});

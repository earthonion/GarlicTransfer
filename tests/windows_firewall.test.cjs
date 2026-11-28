const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const { allowFirewallAccess } = require('../electron/windows_firewall.cjs');

function fakeWindows(t) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const systemRoot = process.env.SystemRoot;
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  process.env.SystemRoot = 'C:\\Windows';
  t.after(() => {
    Object.defineProperty(process, 'platform', platform);
    if (systemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = systemRoot;
  });
  const children = [];
  t.mock.method(childProcess, 'spawn', (file, args, options) => {
    assert.equal(file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.equal(options.windowsHide, true);
    assert.deepEqual(args.slice(0, -1), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
    const command = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.ok(command.startsWith('$appProcessId = ' + process.pid + '\n'));
    assert.doesNotMatch(command, /Garlic-Firewall-Helper\.bat/i);
    const child = new EventEmitter();
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), unref() {} });
    children.push(child);
    return child;
  });
  return children;
}

test('firewall requests wait for rule readiness and share the same live worker', async t => {
  const children = fakeWindows(t);
  const pending = allowFirewallAccess();
  assert.equal(allowFirewallAccess(), pending);
  assert.equal(children.length, 1);
  let ready = false;
  pending.then(() => { ready = true; });
  children[0].stdout.write('REA');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ready, false);
  children[0].stdout.write('DY\r\n');
  await pending;
  assert.equal(allowFirewallAccess(), pending);
  children[0].emit('close', 0);
  const next = allowFirewallAccess();
  assert.equal(children.length, 2);
  children[1].emit('error', new Error('PowerShell unavailable'));
  await assert.rejects(next, /PowerShell unavailable/);
});

test('declined elevation is reported and a later request can retry', async t => {
  const children = fakeWindows(t);
  const pending = allowFirewallAccess();
  children[0].stderr.write('Windows administrator approval was cancelled.');
  children[0].emit('close', 1);
  await assert.rejects(pending, /approval was cancelled/);
  const retry = allowFirewallAccess();
  assert.equal(children.length, 2);
  children[1].emit('close', 1);
  await assert.rejects(retry, /could not enable/);
});

test('Windows PowerShell can parse the packaged firewall worker', { skip: process.platform !== 'win32' }, () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/windows_firewall.ps1'), 'utf8');
  const check = '$errors = $null; [void][Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$null, [ref]$errors); if ($errors) { throw ($errors -join "\n") }';
  childProcess.execFileSync(path.win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', check], { input: source });
});

const childProcess = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const routeChanged = 'The adapter for this PS5 changed. Refresh the network status and try again.';
const guidFormat = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

function encoded(command) {
  return Buffer.from(command, 'utf16le').toString('base64');
}

// Function = Run Windows network command
function runPowerShell(command, timeout) {
  const executable = path.win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    childProcess.execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(command)],
      { windowsHide: true, timeout, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (!error) return resolve(stdout.trim());
        let message = (stderr || '').trim();
        if (error.code === 20) message = routeChanged;
        if (error.code === 21) message = 'Administrator approval was cancelled. IPv6 was not changed.';
        if (error.code === 22) message = 'Windows could not enable IPv6 on this adapter. Check administrator access and Windows networking policy.';
        if (error.killed) message = 'Windows timed out checking the network adapter.';
        reject(new Error(message || 'Windows PowerShell could not complete the network check.'));
      });
  });
}

function adapterCommand(host) {
  if (process.platform !== 'win32') throw new Error('Adapter settings are available on Windows.');
  if (typeof host !== 'string' || !net.isIPv4(host)) throw new Error('Select a PS5 with a valid IPv4 address.');
  const script = fs.readFileSync(path.join(__dirname, 'windows_network.ps1'), 'utf8');
  return `& {\n${script}\n} -ConsoleAddress '${host}'`;
}

async function readAdapter(command) {
  const result = JSON.parse(await runPowerShell(command, 15000));
  if (!guidFormat.test(result.interfaceGuid) || !Number.isInteger(result.interfaceIndex) ||
      result.interfaceIndex <= 0 || typeof result.ipv6Enabled !== 'boolean') {
    throw new Error('Windows returned incomplete network adapter information.');
  }
  return result;
}

function publicStatus({ interfaceGuid, ...status }) {
  return status;
}

// Function = Check PS5 adapter
async function getNetworkStatus(host) {
  return publicStatus(await readAdapter(adapterCommand(host)));
}

// Function = Enable adapter IPv6
async function enableIpv6(host, expectedInterfaceIndex) {
  if (!Number.isInteger(expectedInterfaceIndex) || expectedInterfaceIndex <= 0 || expectedInterfaceIndex > 0xffffffff) {
    throw new Error('Refresh the network status before enabling IPv6.');
  }
  const command = adapterCommand(host);
  const before = await readAdapter(command);
  if (before.interfaceIndex !== expectedInterfaceIndex) throw new Error(routeChanged);
  if (before.ipv6Enabled) return publicStatus(before);

  const action = encoded(`${command} -Enable -ExpectedIndex ${expectedInterfaceIndex} -ExpectedGuid '${before.interfaceGuid}'`);
  await runPowerShell(`
    try {
      $process = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop -ArgumentList '-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand','${action}'
      if ($process.ExitCode -eq 20) { exit 20 }
      if ($process.ExitCode -ne 0) { exit 22 }
    } catch {
      $cause = $_.Exception
      while ($cause) {
        if ($cause.NativeErrorCode -eq 1223 -or ($cause.HResult -band 0xffff) -eq 1223) { exit 21 }
        $cause = $cause.InnerException
      }
      exit 22
    }`, 0);

  // The adapter may briefly disappear while Windows applies the binding.
  const deadline = Date.now() + 10000;
  for (;;) {
    let after;
    try {
      after = await readAdapter(command);
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    if (after && after.interfaceGuid === before.interfaceGuid && after.interfaceIndex === expectedInterfaceIndex) {
      if (after.ipv6Enabled && (after.linkLocalAddress || Date.now() >= deadline)) return publicStatus(after);
      if (Date.now() >= deadline) throw new Error('IPv6 is still disabled. Check Windows networking policy.');
    } else if (Date.now() >= deadline) {
      throw new Error(routeChanged);
    }
    await delay(750);
  }
}

module.exports = { getNetworkStatus, enableIpv6 };

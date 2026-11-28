const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

let session;

// Function = Allow temporary transfer ports
function allowFirewallAccess() {
  if (process.platform !== 'win32') throw new Error('Firewall access is available on Windows.');
  if (session) return session;

  const executable = path.win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const source = fs.readFileSync(path.join(__dirname, 'windows_firewall.ps1'), 'utf8');
  const script = '$appProcessId = ' + process.pid + '\n' + source;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = childProcess.spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const request = new Promise((resolve, reject) => {
    let detail = '';
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', line => {
      if (line === 'READY') {
        child.unref();
        child.stdout.unref?.();
        child.stderr.unref?.();
        resolve();
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', text => { detail = (detail + text).slice(-2048); });
    function finish(error) {
      if (session === request) session = null;
      lines.close();
      reject(error);
    }
    child.once('error', finish);
    child.once('close', () => finish(new Error(detail.trim() || 'Windows could not enable temporary firewall access.')));
  });
  session = request;
  return request;
}

module.exports = { allowFirewallAccess };

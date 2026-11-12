const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'electron', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'electron', 'renderer.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8');

test('local save browser exposes export and confirmed import', () => {
  assert.match(html, /id="browseLocalBtn"[^>]*>Browse local saves/);
  assert.match(html, /id="localEntries"/);
  assert.match(html, /This will replace an existing save\. Make sure you have backed it up\. Are you sure you want to do this\?/);
  assert.match(renderer, /refreshLocalSaves/);
  assert.match(renderer, /exportLocalSave/);
  assert.match(renderer, /importLocalSave/);
  assert.match(renderer, /confirmImportBtn\.addEventListener\('click'/);
  assert.match(renderer, /Discover your console first\./);
});

test('local save IPC uses the backend inventory, export, and import operations', () => {
  assert.match(main, /local:inventory/);
  assert.match(main, /local:export/);
  assert.match(main, /local:import/);
  assert.match(main, /poc\.dt_local_saves/);
  assert.match(main, /name: titleName\(entry\.title\)/);
  assert.match(renderer, /entry\.name \|\|/);
  assert.match(preload, /localSaves:/);
  assert.match(preload, /exportLocalSave:/);
  assert.match(preload, /importLocalSave:/);
});

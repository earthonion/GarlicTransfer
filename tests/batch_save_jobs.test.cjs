const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

const execute = promisify(execFile);
const python = process.platform === 'win32' ? 'python' : 'python3';
const resourceRoot = path.resolve(__dirname, '..');
const editorPath = path.join(resourceRoot, 'electron/save_editor.cjs');
const actualRequire = createRequire(editorPath);

// Function SFO Fixture
function saveSfo(accountId, titleId, includeAccount = true) {
  const fields = [
    ['TITLE_ID', Buffer.from(`${titleId}\0`), 0x0204],
    ...(includeAccount ? [['ACCOUNT_ID', Buffer.from(accountId, 'hex'), 0x0004]] : []),
  ];
  const keys = Buffer.from(fields.map(([key]) => `${key}\0`).join(''));
  const keyOffset = 20 + fields.length * 16;
  const dataOffset = (keyOffset + keys.length + 3) & ~3;
  const result = Buffer.alloc(dataOffset + fields.reduce((total, [, value]) => total + value.length, 0));
  result.write('\0PSF', 0, 'binary');
  result.writeUInt32LE(0x101, 4);
  result.writeUInt32LE(keyOffset, 8);
  result.writeUInt32LE(dataOffset, 12);
  result.writeUInt32LE(fields.length, 16);
  keys.copy(result, keyOffset);
  let key = 0;
  let data = 0;
  for (const [index, [name, value, format]] of fields.entries()) {
    const position = 20 + index * 16;
    result.writeUInt16LE(key, position);
    result.writeUInt16LE(format, position + 2);
    result.writeUInt32LE(value.length, position + 4);
    result.writeUInt32LE(value.length, position + 8);
    result.writeUInt32LE(data, position + 12);
    value.copy(result, dataOffset + data);
    key += name.length + 1;
    data += value.length;
  }
  return result;
}

// Function Workspace Snapshot
async function snapshot(directory) {
  const found = {};
  async function visit(current) {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else found[path.relative(directory, filename)] = (await fsp.readFile(filename)).toString('hex');
    }
  }
  await visit(directory);
  return found;
}

// Function Batch Fixture
async function fixture(t, { failAt = 0, cancelAt = 0, collect } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'garlic-batch-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'decrypted');
  const saves = [];
  for (let number = 1; number <= 5; number++) {
    const encryptedName = `sdimg_SLOT${number}`;
    const saveRoot = path.join(workspace, encryptedName);
    const accountId = `0833114e9585c53${number}`;
    const titleId = `PPSA1234${number}`;
    await fsp.mkdir(path.join(saveRoot, 'sce_sys'), { recursive: true });
    await fsp.writeFile(path.join(saveRoot, 'sce_sys/param.sfo'), saveSfo(accountId, titleId));
    await fsp.writeFile(path.join(saveRoot, 'game.dat'), `game payload ${number}`);
    await fsp.writeFile(path.join(saveRoot, 'PS5KEY'), `key ${number}`);
    await fsp.writeFile(path.join(saveRoot, 'chives.json'), JSON.stringify({
      schema_version: 1, platform: 'PS5', title_id: titleId, encrypted_name: encryptedName,
      original_image_size_bytes: 8 * 65536,
      pfs: { version: 2, block_size_bytes: 65536, block_count: 8, mode_raw: 13, fs_ext: 1, backup_header_count: 1 },
    }));
    saves.push({ root: saveRoot, encryptedName, accountId, titleId });
  }
  const calls = { worker: [], helper: [], events: [], maximumActive: 0 };
  const controller = new AbortController();
  let active = 0;
  const context = vm.createContext({
    module: { exports: {} },
    require(name) {
      if (name === 'node:child_process' && collect) return {
        spawn(command, args, options) {
          return args[2] === 'bundle-results' ? collect(args[4], controller) : spawn(command, args, options);
        },
      };
      if (name !== './local_worker.cjs') return actualRequire(name);
      return {
        async runLocalWorkerJob(options) {
          active++;
          calls.maximumActive = Math.max(calls.maximumActive, active);
          const number = calls.worker.length + 1;
          const call = { params: JSON.parse(JSON.stringify(options.params)), operation: options.operation };
          calls.worker.push(call);
          try {
            const inspected = await execute(python, ['-c', [
              'import json,sys,zipfile',
              'with zipfile.ZipFile(sys.argv[1]) as z:',
              ' print(json.dumps({"names":z.namelist(),"payload":z.read("game.dat").decode(),"metadata":json.loads(z.read("chives.json"))}))',
            ].join('\n'), options.inputArchive]);
            call.input = JSON.parse(inspected.stdout);
            if (number === cancelAt) {
              controller.abort();
              throw Object.assign(new Error('Save operation canceled.'), { name: 'AbortError', code: 'ABORT_ERR' });
            }
            if (number === failAt) throw new Error('Test helper encryption failed');
            await execute(python, ['-c', [
              'import sys,zipfile',
              'with zipfile.ZipFile(sys.argv[1],"w") as z:',
              ' z.writestr(sys.argv[2],("encrypted "+sys.argv[2]).encode())',
            ].join('\n'), options.resultPath, options.params.savename]);
            options.onLog(`Encrypted ${options.params.savename}`);
            options.onStatus('done');
            return { jobId: `batch-job-${number}`, output: options.resultPath };
          } finally { active--; }
        },
      };
    },
    process, Buffer, URL, console, setTimeout, clearTimeout, AbortController,
    fetch: async () => { throw new Error('Batch jobs must not contact a hosted worker'); },
  });
  vm.runInContext(fs.readFileSync(editorPath, 'utf8'), context, { filename: editorPath });
  const options = {
    operation: 'encrypt', workspace, accountId: saves[0].accountId,
    targetTitleId: ' ppsa54321 ', useCurrentAccount: true,
    output: path.join(root, 'encrypted-saves.zip'), useRemoteOracle: false,
    oracleHost: '192.168.0.42', python, resourceRoot, workDir: resourceRoot,
    userDataRoot: path.join(root, 'settings'), signal: controller.signal,
    ensureLocalWorker: async host => { calls.helper.push(host); },
    sender: { isDestroyed: () => false, send: (_channel, event) => calls.events.push(event) },
  };
  return { root, workspace, saves, calls, options, api: context.module.exports };
}

async function assertClean(f) {
  assert.deepEqual(await fsp.readdir(path.join(f.options.userDataRoot, 'save-editor')), []);
  assert.deepEqual((await fsp.readdir(f.root)).filter(name => name.startsWith('.garlic-batch-')), []);
}

test('five saves encrypt sequentially with their current owners and one selected PPSA', async t => {
  const f = await fixture(t);
  const before = await snapshot(f.workspace);
  const result = await f.api.runSaveJob(f.options);
  assert.equal(result.saveCount, 5);
  assert.equal(result.output, f.options.output);
  assert.deepEqual(Array.from(result.jobIds), [1, 2, 3, 4, 5].map(number => `batch-job-${number}`));
  assert.equal(f.calls.worker.length, 5);
  assert.equal(f.calls.maximumActive, 1);
  for (const [index, job] of f.calls.worker.entries()) {
    assert.equal(job.operation, 'encrypt');
    assert.equal(job.params.account_id, f.saves[index].accountId);
    assert.equal(job.params.target_title_id, 'PPSA54321');
    assert.equal(job.params.savename, f.saves[index].encryptedName);
    assert.equal(job.input.payload, `game payload ${index + 1}`);
    assert.equal(job.input.metadata.title_id, f.saves[index].titleId);
    assert.ok(job.input.names.includes('sce_sys/param.sfo'));
    assert.ok(job.input.names.every(name => !name.startsWith('sdimg_')));
  }
  const inspected = await execute(python, ['-c', [
    'import json,sys,zipfile',
    'with zipfile.ZipFile(sys.argv[1]) as z:',
    ' print(json.dumps({name:z.read(name).decode() for name in z.namelist()}))',
  ].join('\n'), f.options.output]);
  assert.deepEqual(JSON.parse(inspected.stdout), Object.fromEntries(f.saves.map(save => [
    `PPSA54321/${save.encryptedName}`, `encrypted ${save.encryptedName}`,
  ])));
  assert.ok(f.calls.events.some(event => event.type === 'status' && /Save 5 of 5/.test(event.message)));
  assert.deepEqual(await snapshot(f.workspace), before);
  await assertClean(f);
});

test('an explicit target account applies to each separate save job', async t => {
  const f = await fixture(t);
  await f.api.runSaveJob({ ...f.options, useCurrentAccount: false, accountId: '1122334455667788' });
  assert.equal(f.calls.worker.length, 5);
  assert.ok(f.calls.worker.every(job => job.params.account_id === '1122334455667788'));
  await assertClean(f);
});

test('a blank target retains each save title in the exported folders', async t => {
  const f = await fixture(t);
  await f.api.runSaveJob({ ...f.options, targetTitleId: '' });
  assert.ok(f.calls.worker.every(job => !Object.hasOwn(job.params, 'target_title_id')));
  const inspected = await execute(python, ['-c', 'import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))', f.options.output]);
  assert.deepEqual(JSON.parse(inspected.stdout), f.saves.map(save => `${save.titleId}/${save.encryptedName}`));
  await assertClean(f);
});

test('batch outputs inside the workspace are rejected before contacting the PS5', async t => {
  const f = await fixture(t);
  await assert.rejects(f.api.runSaveJob({ ...f.options, output: path.join(f.workspace, 'new/export.zip') }), /outside the decrypted workspace/);
  assert.deepEqual(f.calls.worker, []);
  assert.deepEqual(f.calls.helper, []);
  await assert.rejects(fsp.access(path.join(f.workspace, 'new')), { code: 'ENOENT' });
  await assertClean(f);
});

for (const mode of ['failure', 'cancellation']) {
  test(`batch ${mode} on save three preserves sources and the previous export`, async t => {
    const f = await fixture(t, mode === 'failure' ? { failAt: 3 } : { cancelAt: 3 });
    const before = await snapshot(f.workspace);
    await fsp.writeFile(f.options.output, 'previous successful export');
    await assert.rejects(f.api.runSaveJob(f.options), mode === 'failure' ? /encryption failed/ : /canceled/);
    const errors = f.calls.events.filter(event => event.type === 'error');
    assert.equal(errors.length, 1, 'A failed batch should report one error.');
    if (mode === 'failure') assert.match(errors[0].message, /^Save 3 of 5: sdimg_SLOT3.*encryption failed/);
    assert.equal(f.calls.worker.length, 3);
    assert.equal(f.calls.maximumActive, 1);
    assert.equal(await fsp.readFile(f.options.output, 'utf8'), 'previous successful export');
    assert.deepEqual(await snapshot(f.workspace), before);
    await assertClean(f);
  });
}

test('canceling while collecting the final ZIP preserves the previous export and removes partial output', async t => {
  let partial;
  const f = await fixture(t, {
    collect(bundle, controller) {
      partial = bundle + '.partial';
      const child = spawn(process.execPath, ['-e', [
        'require("node:fs").writeFileSync(process.argv[1], "partial");',
        'process.stdout.write("collecting");',
        'setInterval(() => {}, 1000);',
      ].join('\n'), partial]);
      child.stdout.once('data', () => controller.abort());
      return child;
    },
  });
  await fsp.writeFile(f.options.output, 'previous export');
  await assert.rejects(f.api.runSaveJob(f.options), /canceled/);
  assert.equal(path.dirname(path.dirname(partial)), await fsp.realpath(path.dirname(f.options.output)));
  assert.equal(await fsp.readFile(f.options.output, 'utf8'), 'previous export');
  await assertClean(f);
});

test('a batch output folder redirected into the workspace before collection is rejected', async t => {
  const f = await fixture(t);
  const folder = path.join(f.root, 'exports');
  await fsp.mkdir(folder);
  f.options.output = path.join(folder, 'result.zip');
  const before = await snapshot(f.workspace);
  const send = f.options.sender.send;
  f.options.sender.send = (channel, event) => {
    send(channel, event);
    if (event.type === 'status' && event.message.startsWith('Collecting ')) {
      fs.rmdirSync(folder);
      fs.symlinkSync(f.workspace, folder, 'junction');
    }
  };
  await assert.rejects(f.api.runSaveJob(f.options), /outside the decrypted workspace/);
  assert.deepEqual(await snapshot(f.workspace), before);
  await assertClean(f);
});

test('ambiguous metadata, target filename collisions and missing owners block every job', async t => {
  for (const kind of ['shared metadata', 'missing metadata', 'target collision', 'missing account']) {
    await t.test(kind, async t => {
      const f = await fixture(t);
      if (kind === 'shared metadata') {
        await fsp.copyFile(path.join(f.saves[0].root, 'chives.json'), path.join(f.workspace, 'chives.json'));
      } else if (kind === 'missing metadata') {
        await fsp.unlink(path.join(f.saves[4].root, 'chives.json'));
      } else if (kind === 'target collision') {
        const filename = path.join(f.saves[4].root, 'chives.json');
        const metadata = JSON.parse(await fsp.readFile(filename, 'utf8'));
        metadata.encrypted_name = f.saves[0].encryptedName.toUpperCase();
        await fsp.writeFile(filename, JSON.stringify(metadata));
      } else {
        const save = f.saves[4];
        await fsp.writeFile(path.join(save.root, 'sce_sys/param.sfo'), saveSfo(save.accountId, save.titleId, false));
      }
      const before = await snapshot(f.workspace);
      await assert.rejects(f.api.runSaveJob(f.options), /metadata|ENOENT|duplicate|ACCOUNT_ID/i);
      assert.equal(f.calls.worker.length, 0);
      assert.deepEqual(f.calls.helper, []);
      await assert.rejects(fsp.access(f.options.output), { code: 'ENOENT' });
      assert.deepEqual(await snapshot(f.workspace), before);
      await assertClean(f);
    });
  }
});

test('hosted mode and in-place replacement reject a multi-save workspace before jobs', async t => {
  const f = await fixture(t);
  await assert.rejects(f.api.runSaveJob({
    ...f.options, useRemoteOracle: true, workerKey: 'test-key', targetTitleId: '',
  }), /multiple saves requires the local PS5 worker/i);
  await assert.rejects(f.api.runSaveJob({ ...f.options, singleSaveOnly: true }), /new ZIP/);
  assert.deepEqual(f.calls.worker, []);
  assert.deepEqual(f.calls.helper, []);
  await assert.rejects(fsp.access(f.options.output), { code: 'ENOENT' });
  await assertClean(f);
});

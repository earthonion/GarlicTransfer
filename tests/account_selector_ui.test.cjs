const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { create } = require('../electron/accounts_ui.js');

const CURRENT = '0011223344556677';
const TARGET = '8899aabbccddeeff';
const OTHER = '1122334455667788';
const copy = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));

// Function Account Fixture
function fixture(t, initial = {}, overrides = {}) {
  const dom = new JSDOM(`<span id="workspaceAccountId"></span>
    <input id="useCurrentAccountId" type="checkbox" checked>
    <select id="targetAccountSelect"></select><button id="addCurrentAccountBtn"></button>
    <details id="accountListDetails"><select id="savedAccountDisplay"><option value="name">Display name</option><option value="id">Account ID</option></select>
    <table><tbody id="savedAccountRows"></tbody></table><p id="savedAccountEmpty"></p><p id="savedAccountStatus"></p></details>
    <dialog id="accountNameDialog"><form id="accountNameForm"><h2 id="accountNameHeading"></h2>
    <span id="accountNameId"></span><input id="accountNameInput" maxlength="64"><p id="accountNameError"></p>
    <button id="accountNameSaveBtn" type="submit">Save</button><button id="accountNameCancelBtn" type="button">Cancel</button></form></dialog>`);
  t.after(() => dom.window.close());
  let state = { accounts: [], selectedId: '', displayMode: 'name', useCurrent: true, ...copy(initial) };
  const calls = [], targets = [], errors = [];
  const respond = () => copy(state);
  const bridge = {
    async getState() { calls.push(['getState']); return respond(); },
    async add(id, name = '') { calls.push(['add', id, name]); if (!state.accounts.some(account => account.id === id)) state.accounts.push({ id, name }); return respond(); },
    async rename(id, name) { calls.push(['rename', id, name]); state.accounts.find(account => account.id === id).name = name.trim(); return respond(); },
    async remove(id) { calls.push(['remove', id]); state.accounts = state.accounts.filter(account => account.id !== id); if (state.selectedId === id) { state.selectedId = ''; state.useCurrent = true; } return respond(); },
    async select(id) { calls.push(['select', id]); state.selectedId = id; if (id) state.useCurrent = false; return respond(); },
    async setDisplayMode(mode) { calls.push(['display', mode]); state.displayMode = mode; return respond(); },
    async setUseCurrent(enabled) { calls.push(['current', enabled]); state.useCurrent = enabled; return respond(); },
    ...overrides,
  };
  const ui = create(dom.window.document, bridge, { onTargetChange: id => targets.push(id), onStatus: message => errors.push(message) });
  const byId = id => dom.window.document.getElementById(id);
  const change = async (id, value) => {
    const element = byId(id);
    if (element.type === 'checkbox') element.checked = value; else element.value = value;
    element.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await tick();
  };
  const saveName = async value => {
    byId('accountNameInput').value = value;
    byId('accountNameForm').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await tick();
  };
  return { ui, bridge, calls, targets, errors, byId, change, saveName, window: dom.window, getState: respond };
}

test('saved targets load by name while preserving the current save ID', async t => {
  const f = fixture(t, { accounts: [{ id: TARGET, name: 'My console' }], selectedId: TARGET, useCurrent: false });
  assert.equal(await f.ui.ready, true);
  f.ui.setCurrentAccount(CURRENT.toUpperCase());
  assert.equal(f.byId('workspaceAccountId').textContent, CURRENT);
  assert.equal(f.byId('targetAccountSelect').value, TARGET);
  assert.equal(f.byId('targetAccountSelect').selectedOptions[0].textContent, 'My console');
  assert.equal(f.byId('targetAccountSelect').disabled, false);
  assert.equal(f.ui.getSelectedId(), TARGET);
  assert.equal(f.ui.getTargetId(CURRENT), TARGET);
  assert.equal(f.ui.resolveTarget, undefined);
  assert.equal(f.byId('accountListDetails').open, false);
  assert.deepEqual(f.targets, [TARGET]);
});

test('adding the current ID preserves an existing target and prevents duplicates', async t => {
  const f = fixture(t, { accounts: [{ id: TARGET, name: 'Target' }], selectedId: TARGET, useCurrent: false });
  await f.ui.ready;
  f.ui.setCurrentAccount(CURRENT.toUpperCase());
  assert.equal(f.byId('addCurrentAccountBtn').hidden, false);
  f.byId('addCurrentAccountBtn').click();
  assert.equal(f.byId('accountNameDialog').open, true);
  assert.equal(f.window.document.activeElement, f.byId('accountNameInput'));
  assert.equal(f.calls.some(call => call[0] === 'add'), false);
  await f.saveName('My PC account');
  assert.deepEqual(f.calls.find(call => call[0] === 'add'), ['add', CURRENT, 'My PC account']);
  assert.equal(f.byId('accountNameDialog').open, false);
  assert.equal(f.ui.getSelectedId(), TARGET);
  assert.equal(f.ui.getTargetId(CURRENT), TARGET);
  assert.equal(f.byId('addCurrentAccountBtn').disabled, true);
  assert.equal(f.byId('addCurrentAccountBtn').hidden, true);
  assert.equal(f.window.document.activeElement, f.byId('useCurrentAccountId'));
  f.byId('addCurrentAccountBtn').click();
  assert.equal(f.calls.filter(call => call[0] === 'add').length, 1);
  f.ui.setCurrentAccount('invalid');
  assert.equal(f.byId('workspaceAccountId').textContent, 'Not available');
  assert.equal(f.byId('addCurrentAccountBtn').disabled, true);
  assert.equal(f.byId('addCurrentAccountBtn').hidden, true);
});

test('Add Account visibility follows unknown, saved and removed current accounts', async t => {
  const f = fixture(t);
  await f.ui.ready;
  const add = f.byId('addCurrentAccountBtn');
  assert.equal(add.hidden, true);
  f.ui.setCurrentAccount(CURRENT);
  assert.equal(add.hidden, false);
  assert.equal(add.disabled, false);
  f.ui.setBusy(true);
  assert.equal(add.hidden, false, 'An unknown account remains visible while busy');
  assert.equal(add.disabled, true);
  f.ui.setBusy(false);
  add.focus(); add.click();
  await f.saveName('Current console');
  assert.equal(add.hidden, true);
  const name = f.byId('savedAccountRows').querySelector('input');
  name.value = '';
  name.dispatchEvent(new f.window.Event('change', { bubbles: true }));
  await tick();
  assert.equal(add.hidden, true, 'A saved ID remains known without a display name');
  assert.equal(f.byId('workspaceAccountId').textContent, CURRENT);
  assert.equal(f.window.document.activeElement, f.byId('useCurrentAccountId'));
  f.byId('savedAccountRows').querySelector('[data-action="remove"]').click();
  await tick();
  assert.equal(add.hidden, false);
  assert.equal(add.disabled, false);
  f.ui.setCurrentAccount('');
  assert.equal(add.hidden, true, 'Mixed or unavailable current IDs have nothing to add');
});

test('Add Account stays hidden until account loading succeeds', async t => {
  let complete;
  const f = fixture(t, {}, { getState: () => new Promise(resolve => { complete = resolve; }) });
  f.ui.setCurrentAccount(CURRENT);
  assert.equal(f.byId('addCurrentAccountBtn').hidden, true);
  await tick();
  complete({ accounts: [], selectedId: '', displayMode: 'name', useCurrent: true });
  await f.ui.ready;
  assert.equal(f.byId('addCurrentAccountBtn').hidden, false);
  const failed = fixture(t, {}, { getState: async () => { throw new Error('Account loading failed'); } });
  failed.ui.setCurrentAccount(CURRENT);
  assert.equal(await failed.ui.ready, false);
  assert.equal(failed.byId('addCurrentAccountBtn').hidden, true);
  const missing = fixture(t, {}, { getState: undefined });
  missing.ui.setCurrentAccount(CURRENT);
  assert.equal(await missing.ui.ready, false);
  assert.equal(missing.byId('addCurrentAccountBtn').hidden, true);
});

test('Settings names and display mode persist and names are rendered as text', async t => {
  const f = fixture(t, { accounts: [{ id: TARGET, name: 'Target' }], selectedId: TARGET, useCurrent: false });
  await f.ui.ready;
  const name = f.byId('savedAccountRows').querySelector('input');
  assert.equal(name.maxLength, 64);
  name.value = '<img src=x onerror=alert(1)>';
  name.dispatchEvent(new f.window.Event('change', { bubbles: true }));
  await tick();
  assert.equal(f.byId('targetAccountSelect').selectedOptions[0].textContent, name.value);
  assert.equal(f.byId('savedAccountRows').querySelector('img'), null);
  await f.change('savedAccountDisplay', 'id');
  assert.equal(f.byId('targetAccountSelect').selectedOptions[0].textContent, TARGET);
  const restored = fixture(t, f.getState());
  await restored.ui.ready;
  assert.equal(restored.byId('savedAccountDisplay').value, 'id');
  assert.equal(restored.byId('savedAccountRows').querySelector('input').value, name.value);
  assert.equal(restored.ui.getSelectedId(), TARGET);
  assert.deepEqual(f.targets, [TARGET]);
});

test('current-ID mode follows each workspace and retains the saved target for reuse', async t => {
  const f = fixture(t, { accounts: [{ id: TARGET, name: 'Target' }], selectedId: TARGET, useCurrent: false });
  await f.ui.ready;
  f.ui.setCurrentAccount(CURRENT);
  await f.change('useCurrentAccountId', true);
  assert.equal(f.ui.isUsingCurrent(), true);
  assert.equal(f.ui.getSelectedId(), TARGET);
  assert.equal(f.ui.getTargetId(TARGET), CURRENT);
  assert.equal(f.byId('targetAccountSelect').disabled, true);
  f.ui.setCurrentAccount(OTHER);
  assert.equal(f.ui.getTargetId(TARGET), OTHER);
  await f.change('useCurrentAccountId', false);
  assert.equal(f.ui.getTargetId(CURRENT), TARGET);
  assert.equal(f.byId('targetAccountSelect').disabled, false);
  assert.deepEqual(f.targets, [TARGET, CURRENT, OTHER, TARGET]);
});

test('removing the selected account falls back to the current account', async t => {
  const f = fixture(t, { accounts: [{ id: TARGET, name: 'Target' }], selectedId: TARGET, useCurrent: false });
  await f.ui.ready;
  f.ui.setCurrentAccount(CURRENT);
  f.byId('savedAccountRows').querySelector('[data-action="remove"]').click();
  await tick();
  assert.equal(f.ui.getSelectedId(), '');
  assert.equal(f.ui.isUsingCurrent(), true);
  assert.equal(f.ui.getTargetId(TARGET), CURRENT);
  assert.equal(f.byId('savedAccountRows').children.length, 0);
  assert.equal(f.byId('savedAccountEmpty').hidden, false);
  assert.equal(f.byId('useCurrentAccountId').checked, true);
});

test('manual target remains available when current mode is off and no saved account is selected', async t => {
  const f = fixture(t, { accounts: [{ id: TARGET, name: '' }], useCurrent: false });
  await f.ui.ready;
  f.ui.setCurrentAccount(CURRENT);
  assert.equal(f.ui.getTargetId(' ' + OTHER + ' '), OTHER);
  await f.change('targetAccountSelect', TARGET);
  assert.equal(f.ui.getTargetId(OTHER), TARGET);
  assert.equal(f.byId('targetAccountSelect').selectedOptions[0].textContent, TARGET);
});

test('failed changes restore selections while retaining the editable name draft', async t => {
  const failure = new Error('account file is locked');
  const f = fixture(t, { accounts: [{ id: TARGET, name: 'Original' }, { id: OTHER, name: 'Other' }], selectedId: TARGET, useCurrent: false }, {
    select: async () => { throw failure; }, rename: async () => { throw failure; }, setDisplayMode: async () => { throw failure; },
  });
  await f.ui.ready;
  await f.change('targetAccountSelect', OTHER);
  assert.equal(f.byId('targetAccountSelect').value, TARGET);
  assert.equal(f.ui.getSelectedId(), TARGET);
  await f.change('savedAccountDisplay', 'id');
  assert.equal(f.byId('savedAccountDisplay').value, 'name');
  const name = f.byId('savedAccountRows').querySelector('input');
  name.value = 'Unsaved'; name.dispatchEvent(new f.window.Event('change', { bubbles: true }));
  await tick();
  assert.equal(f.byId('savedAccountRows').querySelector('input').value, 'Unsaved');
  assert.equal(f.byId('savedAccountStatus').textContent, failure.message);
  assert.equal(f.byId('targetAccountSelect').disabled, false);
  assert.equal(f.errors.length, 3);
});

test('account writes keep names editable while active save work disables editing', async t => {
  let finish;
  const f = fixture(t, { accounts: [{ id: TARGET, name: 'Target' }], useCurrent: false });
  await f.ui.ready;
  f.ui.setCurrentAccount(CURRENT);
  f.bridge.select = () => new Promise(resolve => { finish = resolve; });
  const pending = f.change('targetAccountSelect', TARGET);
  assert.equal(f.byId('targetAccountSelect').disabled, true);
  assert.equal(f.byId('addCurrentAccountBtn').disabled, true);
  assert.equal(f.byId('savedAccountRows').querySelector('input').disabled, false);
  f.ui.setBusy(true);
  assert.equal(f.byId('savedAccountRows').querySelector('input').disabled, true);
  finish({ ...f.getState(), selectedId: TARGET, useCurrent: false });
  await pending;
  assert.equal(f.byId('targetAccountSelect').disabled, true);
  f.ui.setBusy(false);
  assert.equal(f.byId('targetAccountSelect').disabled, false);
  assert.equal(f.byId('addCurrentAccountBtn').disabled, false);
});

test('missing bridges and failed initial loads do not reject ready or permit account changes', async t => {
  const f = fixture(t, {}, { getState: async () => { throw new Error('account list cannot be read'); } });
  assert.equal(await f.ui.ready, false);
  assert.equal(f.byId('targetAccountSelect').disabled, true);
  assert.equal(f.byId('savedAccountStatus').textContent, 'account list cannot be read');
  const empty = create(f.window.document, null);
  assert.equal(await empty.ready, false);
  empty.setCurrentAccount(CURRENT);
  assert.equal(empty.getTargetId(OTHER), OTHER);
});

test('save actions wait for a pending account selection before reading the target ID', async t => {
  let finish;
  const f = fixture(t, { accounts: [{ id: TARGET, name: 'First' }, { id: OTHER, name: 'Second' }], selectedId: TARGET, useCurrent: false });
  await f.ui.ready;
  f.bridge.select = () => new Promise(resolve => { finish = resolve; });
  await f.change('targetAccountSelect', OTHER);
  assert.equal(f.byId('targetAccountSelect').value, OTHER);
  assert.equal(f.ui.getTargetId(CURRENT), TARGET);
  let settled = false;
  const waiting = f.ui.waitForChanges().then(() => { settled = true; return f.ui.getTargetId(CURRENT); });
  f.ui.setBusy(true);
  await tick();
  assert.equal(settled, false);
  finish({ ...f.getState(), selectedId: OTHER, useCurrent: false });
  assert.equal(await waiting, OTHER);
  assert.equal(f.targets.at(-1), OTHER);
  assert.equal(f.byId('targetAccountSelect').disabled, true);
});

test('save actions reject a failed pending account selection instead of using the old target', async t => {
  let fail;
  const failure = new Error('target could not be saved');
  const f = fixture(t, { accounts: [{ id: TARGET, name: 'First' }, { id: OTHER, name: 'Second' }], selectedId: TARGET, useCurrent: false });
  await f.ui.ready;
  f.bridge.select = () => new Promise((_resolve, reject) => { fail = reject; });
  await f.change('targetAccountSelect', OTHER);
  const waiting = assert.rejects(f.ui.waitForChanges(), error => error === failure);
  f.ui.setBusy(true);
  fail(failure);
  await waiting;
  assert.equal(f.ui.getTargetId(CURRENT), TARGET);
  assert.equal(f.byId('targetAccountSelect').value, TARGET);
  assert.equal(f.byId('savedAccountStatus').textContent, failure.message);
  assert.equal(f.byId('targetAccountSelect').disabled, true);
  await f.ui.waitForChanges();
});

test('waiting includes initial account loading and propagates a load failure', async t => {
  let finish;
  const f = fixture(t, {}, { getState: () => new Promise(resolve => { finish = resolve; }) });
  let settled = false;
  const waiting = f.ui.waitForChanges().then(() => { settled = true; });
  await tick();
  assert.equal(settled, false);
  finish({ accounts: [{ id: TARGET, name: 'Target' }], selectedId: TARGET, useCurrent: false, displayMode: 'name' });
  await waiting;
  assert.equal(f.ui.getTargetId(CURRENT), TARGET);
  const failure = new Error('account list could not load');
  const broken = fixture(t, {}, { getState: async () => { throw failure; } });
  assert.equal(await broken.ui.ready, false);
  await assert.rejects(broken.ui.waitForChanges(), error => error === failure);
  const legacy = create(f.window.document, null);
  await legacy.waitForChanges();
});

test('Add current ID captures the account and accepts Enter without changing the selected target', async t => {
  const f = fixture(t, { accounts: [{ id: TARGET, name: 'Target' }], selectedId: TARGET, useCurrent: false });
  await f.ui.ready;
  f.ui.setCurrentAccount(CURRENT);
  f.byId('addCurrentAccountBtn').click();
  assert.equal(f.byId('accountNameId').textContent, CURRENT);
  f.ui.setCurrentAccount(OTHER);
  f.byId('accountNameInput').value = 'Captured account';
  f.byId('accountNameInput').dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await f.ui.waitForChanges();
  await tick();
  assert.deepEqual(f.calls.find(call => call[0] === 'add'), ['add', CURRENT, 'Captured account']);
  assert.equal(f.ui.getSelectedId(), TARGET);
  assert.equal(f.byId('accountNameDialog').open, false);
});

test('cancel and Escape leave a new account unsaved and restore Add focus', async t => {
  const f = fixture(t);
  await f.ui.ready;
  f.ui.setCurrentAccount(CURRENT);
  const opener = f.byId('addCurrentAccountBtn');
  opener.focus(); opener.click();
  f.byId('accountNameInput').value = 'Discarded name';
  f.byId('accountNameCancelBtn').click();
  assert.equal(f.byId('accountNameDialog').open, false);
  assert.equal(f.window.document.activeElement, opener);
  opener.click();
  f.byId('accountNameInput').dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(f.byId('accountNameDialog').open, false);
  assert.equal(f.window.document.activeElement, opener);
  assert.equal(f.calls.some(call => call[0] === 'add'), false);
});

test('an empty new name keeps the account ID as its display label', async t => {
  const f = fixture(t);
  await f.ui.ready;
  f.ui.setCurrentAccount(CURRENT);
  f.byId('addCurrentAccountBtn').click();
  await f.saveName('');
  assert.deepEqual(f.calls.find(call => call[0] === 'add'), ['add', CURRENT, '']);
  assert.equal(f.byId('targetAccountSelect').options[1].textContent, CURRENT);
});

test('Settings retains a failed inline name draft and Enter retries it', async t => {
  const f = fixture(t, { accounts: [{ id: TARGET, name: 'Original' }], selectedId: TARGET, useCurrent: false });
  await f.ui.ready;
  const input = f.byId('savedAccountRows').querySelector('input');
  input.focus();
  const rename = f.bridge.rename;
  f.bridge.rename = async () => { throw new Error('name could not be written'); };
  input.value = 'Keep my draft';
  input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  input.dispatchEvent(new f.window.Event('change', { bubbles: true }));
  await tick();
  assert.equal(f.byId('savedAccountRows').querySelector('input'), input);
  assert.equal(input.value, 'Keep my draft');
  assert.equal(input.disabled, false);
  assert.equal(f.byId('savedAccountStatus').textContent, 'name could not be written');
  assert.equal(f.getState().accounts[0].name, 'Original');
  assert.equal(f.byId('savedAccountRows').querySelector('[data-action="edit"]'), null);
  f.bridge.rename = rename;
  input.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await f.ui.waitForChanges();
  assert.equal(f.getState().accounts[0].name, 'Keep my draft');
  assert.equal(f.ui.getSelectedId(), TARGET);
  assert.equal(f.byId('savedAccountRows').querySelector('input'), input);
  assert.equal(f.window.document.activeElement, input);
});

test('Settings inline names remain editable and Enter commits only once', async t => {
  const f = fixture(t, { accounts: [{ id: TARGET, name: 'Original' }], selectedId: TARGET, useCurrent: false });
  await f.ui.ready;
  const input = f.byId('savedAccountRows').querySelector('input');
  assert.equal(input.disabled, false);
  assert.equal(input.readOnly, false);
  input.focus(); input.value = 'Changed inline';
  input.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  input.dispatchEvent(new f.window.Event('change', { bubbles: true }));
  await f.ui.waitForChanges();
  assert.deepEqual(f.calls.filter(call => call[0] === 'rename'), [['rename', TARGET, 'Changed inline']]);
  assert.equal(f.byId('savedAccountRows').querySelector('input').value, 'Changed inline');
  assert.equal(f.byId('targetAccountSelect').selectedOptions[0].textContent, 'Changed inline');
});

test('a failed Add keeps the naming dialog and wait-for-save rejection intact', async t => {
  let fail;
  const f = fixture(t, {}, { add: () => new Promise((_resolve, reject) => { fail = reject; }) });
  await f.ui.ready;
  f.ui.setCurrentAccount(CURRENT);
  f.byId('addCurrentAccountBtn').click();
  const saving = f.saveName('My name');
  const waiting = assert.rejects(f.ui.waitForChanges(), /write failed/);
  assert.equal(f.byId('accountNameInput').disabled, true);
  f.byId('accountNameDialog').dispatchEvent(new f.window.Event('cancel', { cancelable: true }));
  assert.equal(f.byId('accountNameDialog').open, true);
  fail(new Error('write failed'));
  await waiting; await saving;
  assert.equal(f.byId('accountNameDialog').open, true);
  assert.equal(f.byId('accountNameInput').value, 'My name');
  assert.equal(f.byId('accountNameInput').disabled, false);
  assert.deepEqual(f.getState().accounts, []);
});

test('known current accounts show their saved name with the ID in a tooltip', async t => {
  const f = fixture(t, { accounts: [{ id: CURRENT, name: 'Main console' }, { id: TARGET, name: 'Target' }], selectedId: TARGET, useCurrent: false });
  f.ui.setCurrentAccount(CURRENT);
  assert.equal(f.byId('workspaceAccountId').textContent, CURRENT);
  await f.ui.ready;
  assert.equal(f.byId('workspaceAccountId').textContent, 'Main console');
  assert.equal(f.byId('workspaceAccountId').title, CURRENT);
  assert.ok(f.byId('workspaceAccountId').getAttribute('aria-label').includes(CURRENT));
  assert.equal(f.ui.getSelectedId(), TARGET);
  assert.equal(f.ui.getTargetId(CURRENT), TARGET);
  await f.change('savedAccountDisplay', 'id');
  assert.equal(f.byId('targetAccountSelect').selectedOptions[0].textContent, TARGET);
  assert.equal(f.byId('workspaceAccountId').textContent, 'Main console');
  await f.change('useCurrentAccountId', true);
  assert.equal(f.ui.getTargetId(TARGET), CURRENT);
  assert.equal(f.ui.getSelectedId(), TARGET);
});

test('adding, renaming and removing a current account updates its label without changing the target', async t => {
  const f = fixture(t, { accounts: [{ id: TARGET, name: 'Target' }], selectedId: TARGET, useCurrent: false });
  await f.ui.ready;
  f.ui.setCurrentAccount(CURRENT);
  f.byId('addCurrentAccountBtn').click();
  await f.saveName('Current profile');
  assert.equal(f.byId('workspaceAccountId').textContent, 'Current profile');
  assert.equal(f.byId('workspaceAccountId').title, CURRENT);
  const input = f.byId('savedAccountRows').querySelector(`input[data-account-id="${CURRENT}"]`);
  input.value = '<img src=x> & New name';
  input.dispatchEvent(new f.window.Event('change', { bubbles: true }));
  await f.ui.waitForChanges();
  assert.equal(f.byId('workspaceAccountId').textContent, '<img src=x> & New name');
  assert.equal(f.byId('workspaceAccountId').title, CURRENT);
  assert.equal(f.byId('workspaceAccountId').querySelector('img'), null);
  f.byId('savedAccountRows').querySelector(`button[aria-label="Remove ${CURRENT}"]`).click();
  await tick();
  assert.equal(f.byId('workspaceAccountId').textContent, CURRENT);
  assert.equal(f.byId('workspaceAccountId').title, CURRENT);
  assert.equal(f.ui.getSelectedId(), TARGET);
  assert.equal(f.ui.getTargetId(CURRENT), TARGET);
  assert.equal(f.ui.isUsingCurrent(), false);
});

test('blank, unknown and missing current account names retain clear ID labels', async t => {
  const f = fixture(t, { accounts: [{ id: CURRENT, name: '' }] });
  await f.ui.ready;
  f.ui.setCurrentAccount(CURRENT);
  assert.equal(f.byId('workspaceAccountId').textContent, CURRENT);
  f.ui.setCurrentAccount(OTHER);
  assert.equal(f.byId('workspaceAccountId').textContent, OTHER);
  assert.equal(f.byId('workspaceAccountId').title, OTHER);
  f.ui.setCurrentAccount('');
  assert.equal(f.byId('workspaceAccountId').textContent, 'Not available');
  assert.equal(f.byId('workspaceAccountId').title, '');
});

test('unrelated state refresh and completed saves preserve input identity, focus and caret', async t => {
  const f = fixture(t, { accounts: [{ id: TARGET, name: 'Original' }], selectedId: TARGET, useCurrent: false });
  await f.ui.ready;
  const input = f.byId('savedAccountRows').querySelector('input');
  input.focus(); input.value = 'A draft name'; input.setSelectionRange(3, 6);
  input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  await f.change('savedAccountDisplay', 'id');
  assert.equal(f.byId('savedAccountRows').querySelector('input'), input);
  assert.equal(input.value, 'A draft name');
  assert.equal(f.window.document.activeElement, input);
  assert.equal(input.selectionStart, 3);
  assert.equal(input.selectionEnd, 6);
  await f.ui.waitForChanges();
  assert.equal(f.getState().accounts[0].name, 'A draft name');
  assert.equal(f.byId('savedAccountRows').querySelector('input'), input);
  assert.equal(f.window.document.activeElement, input);
  assert.equal(input.selectionStart, 3);
  assert.equal(input.selectionEnd, 6);
});

test('typing debounces name saves and writes only the latest draft', async t => {
  const f = fixture(t, { accounts: [{ id: TARGET, name: 'Original' }] });
  await f.ui.ready;
  const input = f.byId('savedAccountRows').querySelector('input');
  input.focus(); input.value = 'First draft';
  input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  input.value = 'Latest draft';
  input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(f.calls.filter(call => call[0] === 'rename').length, 0);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.deepEqual(f.calls.filter(call => call[0] === 'rename'), [['rename', TARGET, 'Latest draft']]);
  assert.equal(input.disabled, false);
});

test('older rename replies preserve newer typing and follow-up writes are serial', async t => {
  const f = fixture(t, { accounts: [{ id: TARGET, name: 'Original' }], selectedId: TARGET, useCurrent: false });
  await f.ui.ready;
  const input = f.byId('savedAccountRows').querySelector('input');
  const rename = f.bridge.rename;
  const requests = [], complete = [];
  let active = 0, maxActive = 0;
  f.bridge.rename = (id, name) => {
    requests.push([id, name]); active++; maxActive = Math.max(maxActive, active);
    return new Promise(resolve => { complete.push(async () => { const value = await rename(id, name); active--; resolve(value); }); });
  };
  input.focus(); input.value = 'First save';
  input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  input.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await tick();
  input.value = 'Newer typing'; input.setSelectionRange(4, 4);
  input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  const waiting = f.ui.waitForChanges();
  await complete[0](); await tick();
  assert.equal(f.byId('savedAccountRows').querySelector('input'), input);
  assert.equal(input.value, 'Newer typing');
  assert.equal(f.window.document.activeElement, input);
  assert.equal(input.selectionStart, 4);
  assert.deepEqual(requests, [[TARGET, 'First save'], [TARGET, 'Newer typing']]);
  assert.equal(maxActive, 1);
  await complete[1](); await waiting;
  assert.equal(f.getState().accounts[0].name, 'Newer typing');
  assert.equal(f.ui.getSelectedId(), TARGET);
  assert.equal(f.window.document.activeElement, input);
});

test('rejected older renames save the newer draft serially and pending waits include it', async t => {
  const f = fixture(t, { accounts: [{ id: TARGET, name: 'Original' }] });
  await f.ui.ready;
  const input = f.byId('savedAccountRows').querySelector('input');
  const rename = f.bridge.rename;
  const requests = [];
  let fail, complete;
  f.bridge.rename = (id, name) => {
    requests.push([id, name]);
    if (requests.length === 1) return new Promise((_resolve, reject) => { fail = reject; });
    return new Promise(resolve => { complete = async () => resolve(await rename(id, name)); });
  };
  input.focus(); input.value = 'First save';
  input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  input.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await tick();
  input.value = 'Keep newer draft'; input.setSelectionRange(5, 5);
  input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  let finished = false;
  const waiting = f.ui.waitForChanges().then(() => { finished = true; });
  fail(new Error('Name already in use.')); await tick();
  assert.deepEqual(requests, [[TARGET, 'First save'], [TARGET, 'Keep newer draft']]);
  assert.equal(finished, false);
  assert.equal(f.byId('savedAccountRows').querySelector('input'), input);
  assert.equal(input.value, 'Keep newer draft');
  assert.equal(input.disabled, false);
  assert.equal(input.selectionStart, 5);
  assert.equal(f.window.document.activeElement, input);
  assert.equal(input.hasAttribute('aria-invalid'), false);
  assert.deepEqual(f.errors, []);
  await complete(); await waiting;
  assert.equal(f.getState().accounts[0].name, 'Keep newer draft');
  assert.equal(f.window.document.activeElement, input);
  assert.equal(input.selectionStart, 5);
});

test('rejecting an older name allows closing after reverting to the saved name', async t => {
  const f = fixture(t, { accounts: [{ id: TARGET, name: 'Original' }], selectedId: TARGET, useCurrent: false });
  await f.ui.ready;
  const input = f.byId('savedAccountRows').querySelector('input');
  const requests = [];
  let fail;
  f.bridge.rename = (id, name) => {
    requests.push([id, name]);
    return new Promise((_resolve, reject) => { fail = reject; });
  };
  input.focus(); input.value = 'Duplicate';
  input.dispatchEvent(new f.window.Event('change', { bubbles: true })); await tick();
  input.value = 'Original'; input.setSelectionRange(3, 3);
  input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  const closing = f.ui.prepareClose();
  fail(new Error('Name already in use.')); await closing;
  await f.ui.waitForChanges();
  assert.deepEqual(requests, [[TARGET, 'Duplicate']]);
  assert.equal(f.getState().accounts[0].name, 'Original');
  assert.equal(input.value, 'Original');
  assert.equal(input.hasAttribute('aria-invalid'), false);
  assert.equal(f.byId('savedAccountRows').querySelector('[data-account-error]').hidden, true);
  assert.equal(f.window.document.activeElement, input);
  assert.equal(input.selectionStart, 3);
  assert.equal(f.ui.getTargetId(), TARGET);
  assert.deepEqual(f.errors, []);
});

test('an unchanged rejected name retains its exact error until deliberately retried', async t => {
  const f = fixture(t, { accounts: [{ id: TARGET, name: 'Original' }] });
  await f.ui.ready;
  const input = f.byId('savedAccountRows').querySelector('input');
  const rename = f.bridge.rename;
  const failure = new Error('Name already in use.');
  let fail, attempts = 0;
  f.bridge.rename = () => {
    attempts++;
    return new Promise((_resolve, reject) => { fail = reject; });
  };
  input.value = 'Duplicate';
  input.dispatchEvent(new f.window.Event('change', { bubbles: true })); await tick();
  const waiting = assert.rejects(f.ui.waitForChanges(), error => error === failure);
  fail(failure); await waiting;
  await assert.rejects(f.ui.prepareClose(), error => error === failure);
  assert.equal(attempts, 1);
  assert.equal(input.value, 'Duplicate');
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.equal(f.byId('savedAccountRows').querySelector('[data-account-error]').textContent, failure.message);
  f.bridge.rename = rename;
  input.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await f.ui.waitForChanges();
  assert.equal(f.getState().accounts[0].name, 'Duplicate');
  assert.equal(input.hasAttribute('aria-invalid'), false);
});

test('an old rejection leaves a newer IME draft pending until composition finishes', async t => {
  const f = fixture(t, { accounts: [{ id: TARGET, name: 'Original' }] });
  await f.ui.ready;
  const input = f.byId('savedAccountRows').querySelector('input');
  const rename = f.bridge.rename;
  const requests = [];
  let fail;
  f.bridge.rename = (id, name) => {
    requests.push([id, name]);
    if (requests.length === 1) return new Promise((_resolve, reject) => { fail = reject; });
    return rename(id, name);
  };
  input.focus(); input.value = 'Duplicate';
  input.dispatchEvent(new f.window.Event('change', { bubbles: true })); await tick();
  input.dispatchEvent(new f.window.CompositionEvent('compositionstart', { bubbles: true }));
  input.value = '編集中'; input.setSelectionRange(2, 2);
  input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  const waiting = assert.rejects(f.ui.waitForChanges(), /Finish editing the account name/);
  fail(new Error('Name already in use.')); await waiting;
  assert.deepEqual(requests, [[TARGET, 'Duplicate']]);
  assert.equal(input.hasAttribute('aria-invalid'), false);
  assert.equal(input.value, '編集中');
  assert.equal(f.window.document.activeElement, input);
  assert.equal(input.selectionStart, 2);
  assert.deepEqual(f.errors, []);
  input.value = '完成';
  input.dispatchEvent(new f.window.CompositionEvent('compositionend', { bubbles: true }));
  await f.ui.waitForChanges();
  assert.deepEqual(requests, [[TARGET, 'Duplicate'], [TARGET, '完成']]);
  assert.equal(f.getState().accounts[0].name, '完成');
});

test('moving between name rows preserves the focused draft while earlier saves finish', async t => {
  const f = fixture(t, { accounts: [{ id: TARGET, name: 'First' }, { id: OTHER, name: 'Second' }] });
  await f.ui.ready;
  const first = f.byId('savedAccountRows').querySelector(`input[data-account-id="${TARGET}"]`);
  const second = f.byId('savedAccountRows').querySelector(`input[data-account-id="${OTHER}"]`);
  const rename = f.bridge.rename;
  const requests = [], complete = [];
  let active = 0, maxActive = 0;
  f.bridge.rename = (id, name) => {
    requests.push([id, name]); active++; maxActive = Math.max(maxActive, active);
    return new Promise(resolve => { complete.push(async () => { const value = await rename(id, name); active--; resolve(value); }); });
  };
  first.focus(); first.value = 'First changed';
  first.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  second.focus();
  await tick();
  assert.deepEqual(requests, [[TARGET, 'First changed']]);
  assert.equal(second.disabled, false);
  second.value = 'Second draft'; second.setSelectionRange(2, 2);
  second.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  const waiting = f.ui.waitForChanges();
  await complete[0](); await tick();
  assert.equal(f.byId('savedAccountRows').querySelector(`input[data-account-id="${OTHER}"]`), second);
  assert.equal(second.value, 'Second draft');
  assert.equal(f.window.document.activeElement, second);
  assert.equal(second.selectionStart, 2);
  assert.deepEqual(requests, [[TARGET, 'First changed'], [OTHER, 'Second draft']]);
  assert.equal(maxActive, 1);
  await complete[1](); await waiting;
  assert.deepEqual(f.getState().accounts.map(account => account.name), ['First changed', 'Second draft']);
  assert.equal(f.window.document.activeElement, second);
});

test('IME composition does not save an incomplete inline name or consume its Enter key', async t => {
  const f = fixture(t, { accounts: [{ id: TARGET, name: 'Original' }] });
  await f.ui.ready;
  const input = f.byId('savedAccountRows').querySelector('input');
  input.focus(); input.dispatchEvent(new f.window.CompositionEvent('compositionstart', { bubbles: true }));
  input.value = '編集中'; input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  input.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(f.calls.some(call => call[0] === 'rename'), false);
  assert.equal(f.window.document.activeElement, input);
  await assert.rejects(f.ui.prepareClose(), /Finish editing the account name/);
  input.value = '完成'; input.dispatchEvent(new f.window.CompositionEvent('compositionend', { bubbles: true }));
  await f.ui.waitForChanges();
  assert.deepEqual(f.calls.filter(call => call[0] === 'rename'), [['rename', TARGET, '完成']]);
});

test('IME confirmation Enter does not submit the Add account dialog', async t => {
  const f = fixture(t);
  await f.ui.ready;
  f.ui.setCurrentAccount(CURRENT);
  f.byId('addCurrentAccountBtn').click();
  const input = f.byId('accountNameInput');
  input.value = '名前';
  input.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
  await tick();
  assert.equal(f.byId('accountNameDialog').open, true);
  assert.equal(f.calls.some(call => call[0] === 'add'), false);
  input.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await f.ui.waitForChanges(); await tick();
  assert.deepEqual(f.calls.filter(call => call[0] === 'add'), [['add', CURRENT, '名前']]);
});

test('a failed row stays visible while another name saves without retrying it', async t => {
  const failure = new Error('Name already in use.');
  const f = fixture(t, { accounts: [{ id: TARGET, name: 'First' }, { id: OTHER, name: 'Second' }], selectedId: OTHER, useCurrent: false });
  await f.ui.ready;
  const first = f.byId('savedAccountRows').querySelector(`input[data-account-id="${TARGET}"]`);
  const second = f.byId('savedAccountRows').querySelector(`input[data-account-id="${OTHER}"]`);
  const rename = f.bridge.rename, requests = [];
  f.bridge.rename = async (id, name) => {
    requests.push([id, name]);
    if (id === TARGET && name === 'Bad name') throw failure;
    return rename(id, name);
  };
  first.value = 'Bad name';
  first.dispatchEvent(new f.window.Event('change', { bubbles: true }));
  await tick();
  const rowError = f.byId('savedAccountRows').querySelector(`[data-account-error="${TARGET}"]`);
  assert.equal(rowError.hidden, false);
  assert.equal(rowError.textContent, failure.message);
  second.value = 'Valid name';
  second.dispatchEvent(new f.window.Event('change', { bubbles: true }));
  await tick();
  assert.deepEqual(requests, [[TARGET, 'Bad name'], [OTHER, 'Valid name']]);
  assert.deepEqual(f.getState().accounts.map(account => account.name), ['First', 'Valid name']);
  assert.equal(first.value, 'Bad name');
  await assert.rejects(f.ui.waitForChanges(), error => error === failure);
  await assert.rejects(f.ui.prepareClose(), error => error === failure);
  assert.equal(requests.length, 2);
  assert.equal(f.ui.getSelectedId(), OTHER);
  first.value = 'Corrected name';
  first.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await f.ui.prepareClose();
  assert.deepEqual(f.getState().accounts.map(account => account.name), ['Corrected name', 'Valid name']);
  assert.equal(first.hasAttribute('aria-invalid'), false);
  assert.equal(rowError.hidden, true);
});

test('one name acknowledgement rebuilds the dropdown once and preserves its input', async t => {
  const f = fixture(t, { accounts: [{ id: TARGET, name: 'Original' }] });
  await f.ui.ready;
  const input = f.byId('savedAccountRows').querySelector('input');
  const select = f.byId('targetAccountSelect');
  const replace = select.replaceChildren.bind(select);
  let renders = 0;
  select.replaceChildren = (...args) => { renders++; return replace(...args); };
  input.focus(); input.value = 'Changed'; input.setSelectionRange(2, 4);
  input.dispatchEvent(new f.window.Event('change', { bubbles: true }));
  await f.ui.waitForChanges();
  assert.equal(renders, 1);
  assert.equal(f.byId('savedAccountRows').querySelector('input'), input);
  assert.equal(f.window.document.activeElement, input);
  assert.equal(input.selectionStart, 2);
  assert.equal(input.selectionEnd, 4);
});

test('closing flushes a pending name and preserves an unfinished Add draft', async t => {
  const f = fixture(t, { accounts: [{ id: TARGET, name: 'Original' }] });
  await f.ui.ready;
  const input = f.byId('savedAccountRows').querySelector('input');
  input.value = 'Save before exit';
  input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  assert.equal(f.calls.some(call => call[0] === 'rename'), false);
  await f.ui.prepareClose();
  assert.equal(f.getState().accounts[0].name, 'Save before exit');
  f.ui.setCurrentAccount(CURRENT);
  f.byId('addCurrentAccountBtn').click();
  f.byId('accountNameInput').value = 'Unfinished new account';
  await assert.rejects(f.ui.prepareClose(), /Finish adding the account/);
  assert.equal(f.byId('accountNameInput').value, 'Unfinished new account');
  assert.equal(f.calls.some(call => call[0] === 'add'), false);
  f.byId('accountNameCancelBtn').click();
  await f.ui.prepareClose();
});

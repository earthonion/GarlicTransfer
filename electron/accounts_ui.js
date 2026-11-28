(function expose(root, build) {
  const api = build();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SavedAccounts = api;
})(typeof window === 'object' ? window : globalThis, function build() {
  const { t: uiText } = typeof module === 'object' && module.exports ? require('./i18n.js') : globalThis.GarlicI18n;
  // Function Account Controls
  function create(document, bridge, { onTargetChange = () => {}, isBusy = () => false, onStatus = () => {} } = {}) {
    const byId = id => document.getElementById(id);
    const current = byId('workspaceAccountId');
    const target = byId('targetAccountSelect');
    const useCurrent = byId('useCurrentAccountId');
    const add = byId('addCurrentAccountBtn');
    const rows = byId('savedAccountRows');
    const display = byId('savedAccountDisplay');
    const status = byId('savedAccountStatus');
    const empty = byId('savedAccountEmpty');
    const nameDialog = byId('accountNameDialog');
    const nameForm = byId('accountNameForm');
    const nameInput = byId('accountNameInput');
    const nameId = byId('accountNameId');
    const nameError = byId('accountNameError');
    const nameSave = byId('accountNameSaveBtn');
    const nameCancel = byId('accountNameCancelBtn');
    let state = { accounts: [], selectedId: '', displayMode: 'name', useCurrent: true };
    let currentId = '', loaded = false, pending = false, busy = false;
    let pendingChange = null, loadError = null;
    let naming = null;
    const accountRows = new Map();
    let nameTimer = null, nameRun = null;
    const timers = document.defaultView || globalThis;
    const available = Boolean(bridge && ['getState', 'add', 'rename', 'remove', 'select', 'setDisplayMode', 'setUseCurrent']
      .every(method => typeof bridge[method] === 'function'));
    if (!available) state.useCurrent = false;
    const accountId = value => /^[0-9a-f]{16}$/i.test(String(value || '').trim()) ? String(value).trim().toLowerCase() : '';
    const activeId = () => state.useCurrent ? currentId : state.selectedId;

    // Function Account Label
    function currentLabel() {
      if (!currentId) return uiText('Not available');
      const name = state.accounts.find(account => account.id === currentId)?.name.trim();
      return name || currentId;
    }

    // Function Current Account
    function renderCurrentAccount() {
      if (!current) return;
      const label = currentLabel();
      current.textContent = label;
      current.title = currentId;
      current.setAttribute('aria-label', currentId ? uiText`${label}, Account ID ${currentId}` : label);
    }

    // Function Account Status
    function report(message, failed = false) {
      if (status) status.textContent = message;
      if (failed) onStatus(message);
    }

    // Function Account Busy
    function blocked() { return !loaded || pending || busy || isBusy(); }
    function updateBusy() {
      const disabled = blocked();
      if (target) target.disabled = disabled || state.useCurrent;
      if (useCurrent) useCurrent.disabled = disabled;
      if (display) display.disabled = disabled;
      if (add) {
        const duplicate = state.accounts.some(account => account.id === currentId);
        add.hidden = !loaded || Boolean(loadError) || !currentId || duplicate;
        add.disabled = disabled || !currentId || duplicate;
        add.title = duplicate ? uiText('This account is already saved.') : uiText('Add the current save account to the list.');
      }
      if (rows) for (const control of rows.querySelectorAll('input, button')) {
        control.disabled = control.tagName === 'INPUT' ? !loaded || busy || isBusy() : disabled;
      }
      if (nameInput) nameInput.disabled = disabled;
      if (nameSave) nameSave.disabled = disabled;
      if (nameCancel) nameCancel.disabled = pending;
    }

    // Function Account Naming
    function openNameDialog(id, opener) {
      if (blocked()) return;
      const account = state.accounts.find(item => item.id === id);
      if (!accountId(id) || account) return;
      if (!nameDialog || !nameForm || !nameInput) {
        report(uiText('Account naming is unavailable. Restart GarlicTransfer and try again.'), true);
        return;
      }
      naming = { id, opener };
      if (nameId) nameId.textContent = id;
      if (nameError) nameError.textContent = '';
      nameInput.value = '';
      updateBusy();
      if (!nameDialog.open) {
        if (typeof nameDialog.showModal === 'function') nameDialog.showModal();
        else nameDialog.setAttribute('open', '');
      }
      nameInput.focus();
      nameInput.select();
    }

    // Function Name Dialog Closing
    function closeNameDialog() {
      if (!naming || pending) return;
      const previous = naming;
      naming = null;
      if (nameDialog?.open) {
        if (typeof nameDialog.close === 'function') nameDialog.close();
        else nameDialog.removeAttribute('open');
      }
      let opener = previous.opener;
      if (!opener?.isConnected || opener.disabled || opener.hidden) opener = add;
      if (!opener || opener.disabled || opener.hidden) opener = [useCurrent, target, display].find(control => control && !control.disabled && !control.hidden);
      opener?.focus();
    }

    // Function Name Saving
    function flushNames() {
      timers.clearTimeout(nameTimer); nameTimer = null;
      if (nameRun) return nameRun;
      if (!loaded || ![...accountRows.values()].some(item => item.dirty && !item.composing && !item.failure)) return;
      const saving = mutate(async () => {
        let failure;
        for (;;) {
          const item = [...accountRows.values()].find(row => row.dirty && !row.composing && !row.failure);
          if (!item) return failure ? { warning: failure.message || 'Could not save an account name.' } : state;
          const value = item.input.value;
          item.saving = true;
          try {
            const result = await bridge.rename(item.id, value);
            item.dirty = item.input.value !== value;
            setNameFailure(item, null);
            item.saving = false;
            apply(result);
          } catch (error) {
            item.saving = false;
            if (item.input.value !== value) {
              item.dirty = item.input.value.trim() !== item.savedName;
              setNameFailure(item, null);
              continue;
            }
            item.dirty = true;
            const errorValue = error || new Error('Could not save the account name.');
            setNameFailure(item, errorValue);
            failure ||= errorValue;
            report(errorValue.message || uiText('Could not save the account name.'), true);
          }
        }
      }, 'Account name saved.', true, false);
      nameRun = saving;
      const clear = () => { if (nameRun === saving) nameRun = null; };
      saving.then(clear, clear);
      return saving;
    }

    // Function Name Error
    function setNameFailure(item, error) {
      item.failure = error;
      item.error.hidden = !error;
      item.error.textContent = error ? uiText(error.message || 'Could not save the account name.') : '';
      if (error) item.input.setAttribute('aria-invalid', 'true');
      else item.input.removeAttribute('aria-invalid');
    }

    // Function Name Changes
    function editName(item, immediate = false) {
      item.dirty = item.saving || item.input.value.trim() !== item.savedName;
      setNameFailure(item, null);
      if (!item.dirty || item.composing) return;
      timers.clearTimeout(nameTimer);
      if (immediate) flushNames();
      else nameTimer = timers.setTimeout(flushNames, 300);
    }

    // Function Account Row
    function createRow(account) {
      const row = document.createElement('tr');
      const idCell = document.createElement('td');
      const id = document.createElement('code'); id.textContent = account.id; idCell.appendChild(id);
      const nameCell = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'text'; input.maxLength = 64; input.value = account.name;
      input.placeholder = 'Display name'; input.dataset.accountId = account.id;
      input.autocomplete = 'off'; input.spellcheck = false;
      input.setAttribute('aria-label', uiText`Name for ${account.id}`);
      const error = document.createElement('small');
      error.id = `account-name-error-${account.id}`; error.dataset.accountError = account.id;
      error.className = 'hint account-name-error'; error.hidden = true;
      error.setAttribute('role', 'status'); input.setAttribute('aria-describedby', error.id);
      const item = { id: account.id, row, input, error, savedName: account.name, dirty: false,
        saving: false, composing: false, failure: null };
      input.addEventListener('input', () => editName(item));
      input.addEventListener('change', () => editName(item, true));
      input.addEventListener('blur', () => editName(item, true));
      input.addEventListener('compositionstart', () => { item.composing = true; });
      input.addEventListener('compositionend', () => { item.composing = false; editName(item); });
      input.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || event.isComposing || item.composing) return;
        event.preventDefault(); editName(item, true);
      });
      nameCell.append(input, error);
      const removeCell = document.createElement('td');
      const remove = document.createElement('button');
      remove.type = 'button'; remove.textContent = uiText('Remove'); remove.dataset.accountId = account.id;
      remove.dataset.action = 'remove';
      remove.setAttribute('aria-label', uiText`Remove ${account.id}`);
      remove.addEventListener('click', () => mutate(() => bridge.remove(account.id), 'Account removed.'));
      removeCell.appendChild(remove);
      row.append(idCell, nameCell, removeCell);
      return item;
    }

    // Function Account List
    function render() {
      renderCurrentAccount();
      if (target) {
        target.replaceChildren();
        const original = document.createElement('option');
        original.value = ''; original.textContent = uiText('Choose account…');
        target.appendChild(original);
        for (const account of state.accounts) {
          const option = document.createElement('option');
          option.value = account.id;
          option.textContent = state.displayMode === 'id' ? account.id : account.name || account.id;
          option.title = account.name ? `${account.name} · ${account.id}` : account.id;
          target.appendChild(option);
        }
        target.value = state.selectedId;
      }
      if (display) display.value = state.displayMode;
      if (useCurrent) useCurrent.checked = state.useCurrent;
      if (empty) empty.hidden = state.accounts.length > 0;
      if (rows) {
        for (const [id, item] of accountRows) {
          if (!state.accounts.some(account => account.id === id)) { item.row.remove(); accountRows.delete(id); }
        }
        for (const [index, account] of state.accounts.entries()) {
          let item = accountRows.get(account.id);
          if (!item) { item = createRow(account); accountRows.set(account.id, item); }
          item.savedName = account.name;
          if (!item.dirty && document.activeElement !== item.input && item.input.value !== account.name) item.input.value = account.name;
          if (rows.children[index] !== item.row) rows.insertBefore(item.row, rows.children[index] || null);
        }
      }
      updateBusy();
    }

    // Function Account State
    function apply(value, notify = false) {
      const previous = activeId();
      const seen = new Set();
      const accounts = [];
      for (const item of Array.isArray(value?.accounts) ? value.accounts : []) {
        const id = accountId(item?.id);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        accounts.push({ id, name: typeof item.name === 'string' ? item.name : '' });
      }
      const selected = accountId(value?.selectedId);
      state = { accounts, selectedId: seen.has(selected) ? selected : '', displayMode: value?.displayMode === 'id' ? 'id' : 'name', useCurrent: value?.useCurrent !== false };
      render();
      if (notify || previous !== activeId()) onTargetChange(activeId());
      if (value?.warning) report(String(value.warning), true);
    }

    // Function Account Saving
    function mutate(action, message, queued = false, applyResult = true) {
      if (!queued && blocked()) { render(); return; }
      const previous = pendingChange;
      pending = true; updateBusy();
      let resolveChange, rejectChange;
      const change = new Promise((resolve, reject) => { resolveChange = resolve; rejectChange = reject; });
      pendingChange = change;
      change.catch(() => {});
      (async () => {
        try {
          if (previous) await previous;
          const result = await action();
          if (applyResult) apply(result);
          if (!result?.warning) report(message);
        } catch (error) {
          render();
          report(error?.message || uiText('Could not save the account list.'), true);
          throw error;
        } finally {
          if (pendingChange === change) { pendingChange = null; pending = false; }
          updateBusy();
        }
      })().then(resolveChange, rejectChange);
      return change;
    }

    // Function Account Name Saving
    async function saveDialogName(event) {
      event.preventDefault();
      if (blocked() || !naming) return;
      const { id } = naming;
      const value = nameInput.value;
      if (nameError) nameError.textContent = '';
      try {
        await mutate(() => bridge.add(id, value), 'Account name saved.');
        closeNameDialog();
      } catch (error) {
        if (nameError) nameError.textContent = uiText(error?.message || 'Could not save the account name.');
        nameInput.focus();
      }
    }
    nameForm?.addEventListener('submit', saveDialogName);
    nameCancel?.addEventListener('click', closeNameDialog);
    nameInput?.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing) saveDialogName(event);
    });
    nameDialog?.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); closeNameDialog(); }
    });
    nameDialog?.addEventListener('cancel', event => { event.preventDefault(); closeNameDialog(); });

    target?.addEventListener('change', () => {
      if (state.useCurrent) { render(); return; }
      const selected = target.value;
      mutate(() => bridge.select(selected), selected ? 'Target account selected.' : 'Enter the target account ID in the save action.');
    });
    useCurrent?.addEventListener('change', () => {
      const enabled = useCurrent.checked;
      mutate(() => bridge.setUseCurrent(enabled), enabled ? 'Using each save’s current account.' : 'Choose the target account.');
    });
    // Function Add Account
    function addCurrentAccount(opener = add) {
      if (currentId && !state.accounts.some(account => account.id === currentId)) {
        openNameDialog(currentId, opener);
      }
    }
    add?.addEventListener('click', () => addCurrentAccount());
    display?.addEventListener('change', () => {
      const mode = display.value;
      mutate(() => bridge.setDisplayMode(mode), 'Account display updated.');
    });
    render();
    const ready = available ? Promise.resolve().then(() => bridge.getState()).then(value => {
      loaded = true; apply(value, true); return true;
    }).catch(error => {
      loadError = error;
      report(error?.message || uiText('Could not load saved accounts.'), true);
      updateBusy(); return false;
    }) : Promise.resolve(false);

    // Function Account Waiting
    async function waitForChanges() {
      const captured = pendingChange;
      await ready;
      if (loadError) throw loadError;
      let change = captured || flushNames() || pendingChange;
      while (change) {
        await change;
        const next = flushNames() || pendingChange;
        if (!next || next === change) break;
        change = next;
      }
      const failed = [...accountRows.values()].find(item => item.dirty && item.failure);
      if (failed) throw failed.failure;
      if ([...accountRows.values()].some(item => item.dirty && item.composing)) {
        throw new Error('Finish editing the account name before continuing.');
      }
    }

    // Function Account Exit
    async function prepareClose() {
      await waitForChanges();
      if (naming && nameInput.value.trim() && !state.accounts.some(account => account.id === naming.id)) {
        throw new Error('Finish adding the account or cancel its name dialog before closing.');
      }
    }

    return {
      ready,
      addCurrentAccount,
      waitForChanges,
      prepareClose,
      setCurrentAccount(value) {
        const previous = activeId();
        currentId = accountId(value);
        renderCurrentAccount();
        updateBusy();
        if (loaded && previous !== activeId()) onTargetChange(activeId());
      },
      getSelectedId: () => state.selectedId,
      getTargetId: (fallback = '') => state.useCurrent ? currentId : state.selectedId || String(fallback || '').trim(),
      isUsingCurrent: () => state.useCurrent,
      setBusy(value) { busy = Boolean(value); updateBusy(); },
    };
  }
  return { create };
});

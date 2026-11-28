(function expose(root, build) {
  const api = build();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WorkspaceTree = api;
})(typeof window === 'object' ? window : globalThis, function build() {
  // Function Workspace Tree
  function create(document, container, {
    onSelect = () => {}, onOpen = () => {}, onAction = () => {},
    getWorkspaceActions = () => [], isBusy = () => false,
  } = {}) {
    const window = document.defaultView;
    const uiText = window.GarlicI18n?.t || ((source, ...values) =>
      typeof source === 'string' ? source : String.raw({ raw: source }, ...values));
    const scroll = container.closest('.workspace-files') || container.parentElement;
    const rows = new Map(), expanded = new Set();
    const nameOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    let nodes = [], visibleNodes = [], workspace = null, focusKey = '', selected = '', busy = false, menuFile = null, menuRow = null;
    const blocked = () => busy || isBusy();
    container.setAttribute('role', 'rowgroup');
    container.closest('table')?.setAttribute('role', 'treegrid');
    container.closest('table')?.setAttribute('aria-label', uiText('Decrypted save files'));
    const menu = document.createElement('div');
    menu.id = 'workspaceFileContextMenu'; menu.className = 'save-context-menu workspace-file-menu';
    menu.hidden = true; menu.tabIndex = -1; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', uiText('File actions'));
    const actions = [['edit', 'Edit file'], ['replace', 'Replace file…'], ['export', 'Export file'], ['delete', 'Delete file']];
    const fileActions = new Set(actions.map(([action]) => action));

    // Function Menu Items
    function appendAction(action, label, disabled = false, title = '') {
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.action = action; button.textContent = uiText(label);
      button.setAttribute('role', 'menuitem');
      button.disabled = Boolean(disabled); button.title = title ? uiText(title) : '';
      if (action === 'delete') button.className = 'danger';
      menu.appendChild(button);
    }
    document.body.appendChild(menu);

    // Function = Find Tree Row
    function eventNode(target) {
      const row = target.closest('tr[data-node-key]');
      const item = row && rows.get(row.dataset.nodeKey);
      return item && item.row === row ? nodes[item.index] : null;
    }

    // Function Tree Focus
    function focus(node) {
      if (!node) return;
      if (focusKey !== node.key) {
        const previous = rows.get(focusKey);
        if (previous) previous.row.tabIndex = -1;
        node.row.tabIndex = 0;
        focusKey = node.key;
      }
      node.row.focus({ preventScroll: true });
    }

    // Function Menu Closing
    function closeMenu(restore = false) {
      menu.hidden = true; menuFile = null;
      if (restore && menuRow?.isConnected) menuRow.focus({ preventScroll: true });
      menuRow = null;
    }

    // Function = Check File Action
    function blockedReason(action, file) {
      if (file.readOnly && action !== 'export') return 'chives.json is read-only.';
      if (file.protected && action === 'delete') return 'Metadata and sce_sys files are protected from deletion.';
      return '';
    }

    // Function File Action
    function act(action, file) {
      if (blocked()) return;
      if (!fileActions.has(action)) {
        const entry = getWorkspaceActions().find(item => item.action === action);
        if (entry && !entry.disabled) return onAction(action, file || null);
        return;
      }
      if (!file || blockedReason(action, file)) return;
      return action === 'edit' ? onOpen(file) : onAction(action, file);
    }

    // Function File Menu
    function showMenu(node, x, y) {
      closeMenu();
      if (blocked()) return false;
      const globals = getWorkspaceActions(), file = node && !node.folder ? node.file : null;
      if (!file && !globals.length) return false;
      menu.replaceChildren();
      if (file) for (const [action, label] of actions) {
        const reason = blockedReason(action, file);
        appendAction(action, label, Boolean(reason), reason);
      }
      for (const item of globals) appendAction(item.action, item.label, item.disabled, item.title);
      if (node) focus(node);
      menuFile = file; menuRow = node?.row || container.querySelector('tr[tabindex="0"]');
      menu.hidden = false;
      const width = menu.offsetWidth || 208, height = menu.offsetHeight || Math.max(168, menu.children.length * 36 + 8);
      menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`;
      (menu.querySelector('button:not(:disabled)') || menu).focus();
      return true;
    }

    // Function Folder Visibility
    function refresh() {
      visibleNodes = [];
      for (const node of nodes) {
        node.row.hidden = node.parents.some(path => !expanded.has(path));
        node.visibleIndex = -1;
        if (!node.row.hidden) {
          node.visibleIndex = visibleNodes.length;
          visibleNodes.push(node);
        }
        if (node.folder) {
          node.row.setAttribute('aria-expanded', String(expanded.has(node.path)));
          node.icon.textContent = expanded.has(node.path) ? '▾' : '▸';
        } else node.row.setAttribute('aria-selected', String(node.path === selected));
        node.row.classList.toggle('selected', !node.folder && node.path === selected);
        node.row.setAttribute('aria-disabled', String(blocked()));
      }
      const current = visibleNodes.find(node => node.key === focusKey)
        || visibleNodes.find(node => !node.folder && node.path === selected) || visibleNodes[0];
      focusKey = current?.key || '';
      for (const node of nodes) node.row.tabIndex = node === current ? 0 : -1;
    }

    // Function Tree Row
    function makeRow(node) {
      const row = document.createElement('tr'); row.setAttribute('role', 'row'); row.dataset.nodeKey = node.key;
      row.tabIndex = -1;
      const name = document.createElement('td'); name.className = 'workspace-tree-name'; name.setAttribute('role', 'gridcell');
      const icon = document.createElement('span'); icon.className = 'workspace-tree-icon'; icon.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span'); label.className = 'workspace-tree-label';
      name.append(icon, label);
      const size = document.createElement('td'); size.className = 'workspace-tree-size'; size.setAttribute('role', 'gridcell');
      row.append(name, size);
      return { row, icon, label, size };
    }

    // Function Tree Rendering
    function render(files = [], selectedPath = '', workspaceKey = '') {
      const changedWorkspace = workspace !== workspaceKey;
      const activeKey = container.contains(document.activeElement) ? document.activeElement.closest('tr')?.dataset.nodeKey : null;
      const scrollTop = changedWorkspace ? 0 : scroll?.scrollTop || 0;
      closeMenu();
      if (changedWorkspace) { expanded.clear(); focusKey = ''; workspace = workspaceKey; }
      selected = selectedPath || '';
      const branches = new Map(), roots = [], used = new Set();
      for (const file of files) {
        if (!file || typeof file.path !== 'string' || !file.path || used.has(file.path)) continue;
        used.add(file.path);
        const parts = file.path.split('/').filter(Boolean);
        if (!parts.length) continue;
        let children = roots, parents = [];
        for (let index = 0; index < parts.length - 1; index++) {
          const path = parts.slice(0, index + 1).join('/');
          let branch = branches.get(path);
          if (!branch) {
            branch = { key: `folder:${path}`, path, name: parts[index], folder: true, children: [], parents: [...parents] };
            branches.set(path, branch); children.push(branch);
            if (changedWorkspace || !rows.has(branch.key)) expanded.add(path);
          }
          children = branch.children; parents = [...parents, path];
        }
        children.push({ key: `file:${file.path}`, path: file.path, name: parts[parts.length - 1], folder: false, file, parents });
      }
      const ordered = [];
      function visit(children) {
        children.sort((a, b) => Number(b.folder) - Number(a.folder) || nameOrder.compare(a.name, b.name));
        for (const node of children) { ordered.push(node); if (node.folder) visit(node.children); }
      }
      visit(roots);
      const keys = new Set(ordered.map(node => node.key));
      for (const [key, item] of rows) if (!keys.has(key)) { item.row.remove(); rows.delete(key); }
      for (const [index, node] of ordered.entries()) {
        let item = rows.get(node.key);
        if (!item) { item = makeRow(node); rows.set(node.key, item); }
        item.index = index;
        Object.assign(node, item);
        node.row.classList.toggle('workspace-tree-folder', node.folder);
        node.row.classList.toggle('workspace-tree-file', !node.folder);
        node.row.setAttribute('aria-level', String(node.parents.length + 1));
        node.row.setAttribute('aria-label', node.folder ? uiText`${node.name}, folder` : uiText`${node.name}, ${node.file.size || 0} bytes`);
        node.row.title = node.file?.readOnly ? node.path + '\n' + uiText('chives.json is read-only.') : node.path;
        node.row.dataset[node.folder ? 'folderPath' : 'filePath'] = node.path;
        node.row.style.setProperty('--tree-depth', node.parents.length);
        node.label.textContent = node.name;
        if (!node.folder) node.icon.textContent = '▪';
        node.size.textContent = node.folder ? '' : node.file.size < 1024 ? `${node.file.size} B` : `${(node.file.size / 1024).toFixed(1)} KiB`;
        if (container.children[index] !== node.row) container.insertBefore(node.row, container.children[index] || null);
      }
      nodes = ordered;
      if (activeKey) focusKey = activeKey;
      refresh();
      if (activeKey) focus(visibleNodes.find(node => node.key === focusKey));
      if (scroll) scroll.scrollTop = scrollTop;
    }

    // Function Tree Selection
    function select(node) {
      if (selected !== node.path) {
        const previous = rows.get(`file:${selected}`);
        if (previous) {
          previous.row.classList.remove('selected');
          previous.row.setAttribute('aria-selected', 'false');
        }
        selected = node.path;
        node.row.classList.add('selected');
        node.row.setAttribute('aria-selected', 'true');
      }
      onSelect(node.file);
    }
    container.addEventListener('click', event => {
      const node = eventNode(event.target);
      if (!node || blocked()) return;
      focus(node);
      if (node.folder) { if (expanded.has(node.path)) expanded.delete(node.path); else expanded.add(node.path); refresh(); }
      else select(node);
    });
    container.addEventListener('dblclick', event => {
      const node = eventNode(event.target);
      if (!node || node.folder || blocked()) return;
      act('edit', node.file);
    });
    scroll.addEventListener('contextmenu', event => {
      const node = eventNode(event.target);
      if (showMenu(node, event.clientX, event.clientY)) { event.preventDefault(); event.stopPropagation(); }
    });
    scroll.addEventListener('keydown', event => {
      const node = eventNode(event.target);
      if (blocked()) return;
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        const rect = (node?.row || scroll).getBoundingClientRect();
        if (showMenu(node, rect.left + 20, rect.bottom)) event.preventDefault();
        return;
      }
      if (!node) return;
      const items = visibleNodes, index = node.visibleIndex;
      let next;
      if (event.key === 'ArrowDown') next = items[index + 1];
      else if (event.key === 'ArrowUp') next = items[index - 1];
      else if (event.key === 'Home') next = items[0];
      else if (event.key === 'End') next = items[items.length - 1];
      else if (event.key === 'ArrowRight') {
        if (node.folder && !expanded.has(node.path)) { expanded.add(node.path); refresh(); }
        else if (node.folder) next = items[index + 1];
      } else if (event.key === 'ArrowLeft') {
        if (node.folder && expanded.has(node.path)) { expanded.delete(node.path); refresh(); }
        else next = items.find(item => item.folder && item.path === node.parents[node.parents.length - 1]);
      } else if (event.key === 'Enter' || event.key === ' ') {
        if (node.folder) { if (expanded.has(node.path)) expanded.delete(node.path); else expanded.add(node.path); refresh(); }
        else if (event.key === ' ') select(node);
        else act('edit', node.file);
      } else return;
      event.preventDefault();
      if (next) { focus(next); next.row.scrollIntoView?.({ block: 'nearest' }); }
    });

    // Function Menu Actions
    menu.addEventListener('click', event => {
      const button = event.target.closest('button[data-action]');
      if (!button || button.disabled || menu.hidden) return;
      const file = menuFile; closeMenu(true); act(button.dataset.action, file);
    });
    menu.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); return; }
      if (event.key === 'Tab') { closeMenu(); return; }
      const buttons = [...menu.querySelectorAll('button:not(:disabled)')];
      const index = buttons.indexOf(document.activeElement);
      let next;
      if (event.key === 'ArrowDown') next = buttons[(index + 1) % buttons.length];
      else if (event.key === 'ArrowUp') next = buttons[(index - 1 + buttons.length) % buttons.length];
      else if (event.key === 'Home') next = buttons[0];
      else if (event.key === 'End') next = buttons[buttons.length - 1];
      if (next) { event.preventDefault(); next.focus(); }
    });
    document.addEventListener('click', event => { if (!menu.contains(event.target)) closeMenu(); });
    document.addEventListener('scroll', () => closeMenu(), true);
    window.addEventListener('resize', () => closeMenu());
    return {
      render,
      setBusy(value) { busy = Boolean(value); if (busy) closeMenu(); refresh(); },
      reset() { closeMenu(); container.replaceChildren(); rows.clear(); expanded.clear(); nodes = []; visibleNodes = []; workspace = null; focusKey = ''; selected = ''; if (scroll) scroll.scrollTop = 0; },
    };
  }
  return { create };
});

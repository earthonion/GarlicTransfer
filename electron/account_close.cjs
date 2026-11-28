const { randomUUID } = require('node:crypto');
const { t } = require('./i18n.js');

// Function Account Close
function registerAccountClose({ app, window, ipcMain, dialog, timeoutMs = 15000, onError = () => {}, beforeClose }) {
  const contents = window.webContents;
  let ready = false, approved = false, quitting = false, disposed = false;
  let reloadPending = false, navigating = false, epoch = 0;
  let request = null, dialogRun = null;

  // Function Close Status
  function report(error) { try { onError(error); } catch {} }
  function alive() { return !disposed && !window.isDestroyed() && !contents.isDestroyed(); }
  function sender(event) {
    if (event?.sender !== contents || !alive()) return false;
    try { return event.senderFrame === undefined || !contents.mainFrame || event.senderFrame === contents.mainFrame; }
    catch { return false; }
  }
  function active(current, version) { return request === current && current.epoch === version && epoch === version && alive(); }
  function send(channel, token) {
    if (!alive()) return;
    try { contents.send(channel, token); } catch (error) { report(error); }
  }

  // Function Close Approval
  function finishClose(current) {
    if (request !== current || disposed || window.isDestroyed()) return;
    approved = true;
    request = null;
    try { if (quitting) app.quit(); else window.close(); }
    catch (error) {
      approved = false; quitting = false;
      report(error);
      send('accounts:close-cancelled', current.token);
    }
  }

  // Function Close Services
  function prepareClose(current) {
    if (request !== current || current.phase === 'cleanup') return;
    clearTimeout(current.timer);
    current.phase = 'cleanup';
    if (!beforeClose) { finishClose(current); return; }
    Promise.resolve().then(() => beforeClose()).catch(report).then(() => finishClose(current));
  }

  // Function Close Approval
  function approve(current, version) {
    if (!active(current, version)) return;
    prepareClose(current);
  }

  // Function Close Decision
  async function decide(current, result) {
    const version = current.epoch;
    if (!active(current, version)) return;
    if (result.ok) { approve(current, version); return; }
    if (dialogRun) await dialogRun;
    if (!active(current, version) || current.phase !== 'decision') return;
    let finishDialog;
    const running = new Promise(resolve => { finishDialog = resolve; });
    dialogRun = running;
    let discard = false;
    try {
      const choice = await dialog.showMessageBox(window, {
        type: 'error', title: 'GarlicTransfer', message: t('Could not save account names.'),
        detail: t(result.error || 'Keep editing to correct the names or retry saving.'),
        buttons: [t('Keep editing'), t('Discard unsaved names and close')],
        defaultId: 0, cancelId: 0, noLink: true,
      });
      discard = choice.response === 1;
    } catch (error) { report(error); }
    finally {
      if (dialogRun === running) dialogRun = null;
      finishDialog();
    }
    if (!active(current, version) || current.phase !== 'decision') return;
    if (discard) { approve(current, version); return; }
    request = null; quitting = false;
    send('accounts:close-cancelled', current.token);
  }

  // Function Close Result
  function settle(current, result) {
    if (request !== current || !['ready', 'flush'].includes(current.phase) || disposed) return;
    clearTimeout(current.timer);
    current.phase = 'decision';
    void decide(current, result);
  }

  // Function Close Deadline
  function arm(current) {
    clearTimeout(current.timer);
    current.timer = setTimeout(() => settle(current, {
      ok: false, error: 'Timed out saving account names. The app is still open.',
    }), Math.max(0, current.deadline - Date.now()));
  }

  // Function Close Flush
  function flush(current) {
    if (request !== current || current.phase !== 'ready' || !ready) return;
    if (Date.now() >= current.deadline) {
      settle(current, { ok: false, error: 'Timed out saving account names. The app is still open.' });
      return;
    }
    current.phase = 'flush';
    current.epoch = epoch;
    current.token = randomUUID();
    try { contents.send('accounts:flush', current.token); }
    catch (error) {
      report(error);
      settle(current, { ok: false, error: error.message || 'Could not request account-name saving.' });
    }
  }

  // Function Close Request
  function close(event) {
    if (approved || disposed || window.isDestroyed()) return;
    if (!alive() || (!ready && !request && !reloadPending)) {
      if (!beforeClose) return;
      event.preventDefault();
      if (!request) {
        request = { token: null, phase: 'approved', epoch, timer: null };
        prepareClose(request);
      }
      return;
    }
    event.preventDefault();
    if (request) return;
    const current = { token: null, phase: 'ready', epoch, deadline: Date.now() + timeoutMs, timer: null };
    request = current;
    arm(current);
    if (ready) flush(current);
  }

  // Function Close Messages
  function registered(event) {
    if (navigating || !sender(event)) return;
    ready = true; reloadPending = false;
    if (request && request.phase !== 'cleanup') flush(request);
  }
  function flushed(event, token, result) {
    if (!sender(event) || !request || request.phase !== 'flush' || request.epoch !== epoch
        || request.token !== token || typeof result?.ok !== 'boolean') return;
    settle(request, { ok: result.ok,
      error: typeof result.error === 'string' ? result.error.slice(0, 4096) : '' });
  }
  function beforeQuit() { quitting = true; }
  function processGone() {
    ready = false; reloadPending = false; navigating = false;
    if (request) settle(request, { ok: false, error: 'The app page stopped before account names could be saved.' });
  }

  // Function Close Navigation
  function navigation(event, _url, isInPlace, isMainFrame) {
    const main = typeof event?.isMainFrame === 'boolean' ? event.isMainFrame : isMainFrame;
    const same = typeof event?.isSameDocument === 'boolean' ? event.isSameDocument : isInPlace;
    if (main !== true || same === true || request?.phase === 'cleanup') return;
    epoch++;
    reloadPending = ready || reloadPending || Boolean(request);
    ready = false; navigating = true;
    if (!request) return;
    const deciding = request.phase === 'decision';
    request.epoch = epoch;
    request.token = null;
    request.phase = 'ready';
    if (deciding) arm(request);
  }
  function committed() { navigating = false; }

  // Function Close Cleanup
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (request) clearTimeout(request.timer);
    request = null;
    window.removeListener('close', close);
    window.removeListener('closed', dispose);
    app.removeListener('before-quit', beforeQuit);
    contents.removeListener('render-process-gone', processGone);
    contents.removeListener('did-start-navigation', navigation);
    contents.removeListener('did-navigate', committed);
    ipcMain.removeListener('accounts:ready', registered);
    ipcMain.removeListener('accounts:flushed', flushed);
  }

  window.on('close', close);
  window.once('closed', dispose);
  app.on('before-quit', beforeQuit);
  contents.on('render-process-gone', processGone);
  contents.on('did-start-navigation', navigation);
  contents.on('did-navigate', committed);
  ipcMain.on('accounts:ready', registered);
  ipcMain.on('accounts:flushed', flushed);
  return { dispose };
}

module.exports = { registerAccountClose };

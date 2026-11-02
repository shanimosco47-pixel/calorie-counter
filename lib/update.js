// Self-update: compares the running build with version.json on the server and, when a newer
// build exists, installs its service worker and reloads, but only once the new version is
// really installed, and never while the user is in the middle of something.
// Dependencies are injected so the logic is unit-tested without a browser.

export const RETRY_AFTER_MS = 5 * 60 * 1000;
const KEY = 'kalorit-update';

export function createUpdater({
  build,                        // { version, builtAt } of the running code
  fetchLatest,                  // () => Promise<{ version, builtAt } | null>  (null: offline/unknown)
  serviceWorker = null,         // navigator.serviceWorker or null
  cacheExists = async () => false,   // (version) => has the new worker already cached that build?
  isBusy = () => false,         // a dialog is open, a save is in flight...
  keepAlive = () => false,      // work that must survive even in the background (camera open, paid request running)
  reload,                       // () => void
  notify = () => {},            // (event, info) for toasts: 'updated' | 'current' | 'offline' | 'failed' | 'updating'
  storage = null,               // localStorage-like (survives the reload)
  now = () => Date.now(),
  waits = { found: 10000, activate: 60000 },
}) {
  let running = false;
  let pendingReload = false;

  const read = () => { try { return JSON.parse(storage?.getItem(KEY) || 'null'); } catch { return null; } };
  const write = (v) => { try { v ? storage?.setItem(KEY, JSON.stringify(v)) : storage?.removeItem(KEY); } catch { /* storage blocked */ } };

  // After a reload: report success only if the running build is the one we updated to.
  function announce() {
    const attempt = read();
    if (!attempt?.reloaded) return;
    if (attempt.version === build.version) {
      write(null);
      notify('updated', build);
    } else {
      write({ ...attempt, reloaded: false });   // the reload did not bring the new build: retry later
    }
  }

  function waitForState(worker, ms) {
    return new Promise((resolve) => {
      if (worker.state === 'activated' || worker.state === 'redundant') return resolve(worker.state);
      const timer = setTimeout(() => resolve(worker.state), ms);
      worker.addEventListener('statechange', () => {
        if (worker.state === 'activated' || worker.state === 'redundant') { clearTimeout(timer); resolve(worker.state); }
      });
    });
  }

  // true when the new build's worker is installed and active, so a reload will run it
  async function installWorker(version) {
    if (!serviceWorker) return true;                       // no worker: a reload reads the network
    const reg = await serviceWorker.getRegistration();
    if (!reg) return true;
    if (await cacheExists(version)) return true;           // installed during an earlier attempt
    try { await reg.update(); } catch { /* offline or server error */ }
    let worker = reg.installing || reg.waiting;
    if (!worker) {
      worker = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), waits.found);
        reg.addEventListener('updatefound', () => { clearTimeout(timer); resolve(reg.installing); }, { once: true });
      });
    }
    if (!worker) return false;                             // server still serves the old sw.js
    const state = await waitForState(worker, waits.activate);
    return state === 'activated';
  }

  function doReload() {
    pendingReload = false;
    const attempt = read();
    if (attempt) write({ ...attempt, reloaded: true });
    reload();
  }

  async function check({ manual = false } = {}) {
    if (running) return 'busy';
    running = true;
    try {
      const latest = await fetchLatest();
      if (!latest?.version) { if (manual) notify('offline'); return 'offline'; }
      if (latest.version === build.version) {
        write(null);
        if (manual) notify('current', build);
        return 'current';
      }
      const attempt = read();
      if (!manual && attempt?.version === latest.version && now() - attempt.ts < RETRY_AFTER_MS) return 'cooldown';
      write({ version: latest.version, ts: now(), reloaded: false });
      if (manual) notify('updating');
      if (!(await installWorker(latest.version))) {
        if (manual) notify('failed');
        return 'not-ready';
      }
      if (isBusy() || keepAlive()) { pendingReload = true; return 'deferred'; }
      doReload();
      return 'reloading';
    } finally {
      running = false;
    }
  }

  // The app went to the background: apply a deferred update now, the user won't see it, unless the
  // page is still needed (camera open, request running) or holds unsaved work (an open form, a field
  // being typed in). Then it waits; at the latest the next fresh start runs the new version anyway.
  function onHidden() {
    if (pendingReload && !keepAlive() && !isBusy()) doReload();
  }

  return { check, announce, onHidden, hasPending: () => pendingReload };
}

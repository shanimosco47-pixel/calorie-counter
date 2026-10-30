import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdater, RETRY_AFTER_MS } from '../../lib/update.js';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

// A registration whose update() installs a worker that activates (or not).
function fakeServiceWorker({ newWorker = true, activates = true } = {}) {
  const listeners = {};
  const reg = {
    installing: null,
    waiting: null,
    addEventListener: (ev, fn) => { listeners[ev] = fn; },
    async update() {
      if (!newWorker) return;
      const wl = {};
      const worker = { state: 'installing', addEventListener: (ev, fn) => { wl[ev] = fn; } };
      reg.installing = worker;
      listeners.updatefound?.();
      setTimeout(() => { worker.state = activates ? 'activated' : 'redundant'; wl.statechange?.(); }, 5);
    },
  };
  return { getRegistration: async () => reg };
}

function setup(opts = {}) {
  const events = [];
  let reloads = 0;
  let clock = 1_000_000;
  const storage = opts.storage || memoryStorage();
  const u = createUpdater({
    build: opts.build || { version: 'A', builtAt: '2026-10-30T08:00:00Z' },
    fetchLatest: async () => (opts.latest === undefined ? { version: 'B', builtAt: '2026-10-30T20:00:00Z' } : opts.latest),
    serviceWorker: opts.sw === undefined ? fakeServiceWorker() : opts.sw,
    isBusy: opts.isBusy || (() => false),
    reload: () => { reloads++; },
    notify: (e) => events.push(e),
    storage,
    now: () => clock,
    waits: { found: 30, activate: 200 },
  });
  return { u, events, storage, reloads: () => reloads, advance: (ms) => { clock += ms; } };
}

test('newer build: installs the worker, then reloads', async () => {
  const t = setup();
  assert.equal(await t.u.check(), 'reloading');
  assert.equal(t.reloads(), 1);
});

test('same build: nothing happens', async () => {
  const t = setup({ latest: { version: 'A' } });
  assert.equal(await t.u.check(), 'current');
  assert.equal(t.reloads(), 0);
  assert.equal(await t.u.check({ manual: true }), 'current');
  assert.deepEqual(t.events, ['current']);
});

test('offline: no reload; manual check says so', async () => {
  const t = setup({ latest: null });
  assert.equal(await t.u.check(), 'offline');
  assert.equal(await t.u.check({ manual: true }), 'offline');
  assert.equal(t.reloads(), 0);
  assert.deepEqual(t.events, ['offline']);
});

test('server still serves the old worker: no reload, retry only after the cooldown', async () => {
  const t = setup({ sw: fakeServiceWorker({ newWorker: false }) });
  assert.equal(await t.u.check(), 'not-ready');
  assert.equal(t.reloads(), 0);
  assert.equal(await t.u.check(), 'cooldown');
  t.advance(RETRY_AFTER_MS + 1);
  assert.equal(await t.u.check(), 'not-ready');           // tried again
  assert.equal(await t.u.check({ manual: true }), 'not-ready');   // manual ignores the cooldown
  assert.deepEqual(t.events, ['updating', 'failed']);
});

test('worker fails to activate: no reload', async () => {
  const t = setup({ sw: fakeServiceWorker({ activates: false }) });
  assert.equal(await t.u.check(), 'not-ready');
  assert.equal(t.reloads(), 0);
});

test('busy (dialog open, save in flight): deferred until the app is hidden', async () => {
  let busy = true;
  const t = setup({ isBusy: () => busy });
  assert.equal(await t.u.check(), 'deferred');
  assert.equal(t.reloads(), 0);
  assert.equal(t.u.hasPending(), true);
  t.u.onHidden();
  assert.equal(t.reloads(), 1);
  busy = false;
});

test('success is announced only when the new build is really running', async () => {
  // the reload did not bring the new build: no false "updated", and it will retry later
  const s1 = memoryStorage();
  await setup({ storage: s1 }).u.check();                  // reloads toward B
  const stillOld = setup({ storage: s1 });                 // after the reload: still build A
  stillOld.u.announce();
  assert.deepEqual(stillOld.events, []);
  stillOld.advance(RETRY_AFTER_MS + 1);
  assert.equal(await stillOld.u.check(), 'reloading');     // retried after the cooldown

  // the reload brought build B: announced once
  const s2 = memoryStorage();
  await setup({ storage: s2 }).u.check();
  const nowNew = setup({ storage: s2, build: { version: 'B', builtAt: '2026-10-30T20:00:00Z' } });
  nowNew.u.announce();
  nowNew.u.announce();
  assert.deepEqual(nowNew.events, ['updated']);
});

test('no service worker support: reload reads the network directly', async () => {
  const t = setup({ sw: null });
  assert.equal(await t.u.check(), 'reloading');
});

test('concurrent checks do not double-reload', async () => {
  const t = setup();
  const [a, b] = await Promise.all([t.u.check(), t.u.check()]);
  assert.deepEqual([a, b].sort(), ['busy', 'reloading']);
  assert.equal(t.reloads(), 1);
});

import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import Dexie from 'dexie';
import { createStore, newId } from '../../lib/store.js';
import { createSync, generateCode, normalizeCode } from '../../lib/sync.js';

// In-memory twin of the sync_push / sync_pull SQL functions (same last-write-wins rule).
function fakeRemote() {
  const rows = new Map();
  let clock = 0;
  const stamp = () => new Date(Date.UTC(2026, 0, 1) + ++clock * 1000).toISOString();
  const remote = {
    online: true,
    calls: 0,
    async push(code, batch) {
      remote.calls++;
      if (!remote.online) throw new Error('offline');
      for (const r of batch) {
        const key = `${code}|${r.kind}|${r.id}`;
        const cur = rows.get(key);
        if (!cur || r.ts >= cur.ts) rows.set(key, { ...structuredClone(r), code, updated_at: stamp() });
      }
      return batch.length;
    },
    async pull(code, since) {
      remote.calls++;
      if (!remote.online) throw new Error('offline');
      return [...rows.values()]
        .filter((r) => r.code === code && (!since || r.updated_at > since))
        .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
        .map(({ kind, id, data, ts, updated_at }) => structuredClone({ kind, id, data, ts, updated_at }));
    },
    rows,
  };
  return remote;
}

let n = 0;
const devices = [];
function device(remote) {
  const store = createStore(`dev-${++n}-${Date.now()}`, Dexie);
  const sync = createSync(store, remote, { debounceMs: 60000 });
  devices.push({ store, sync });
  return { store, sync, db: store.db };
}
test.after(() => { for (const d of devices) { d.sync.stop(); d.store.db.close(); } });

const entry = (over = {}) => ({ id: newId(), date: '2026-10-25', meal: 'lunch', foodId: 't1', name: 'פיתה', grams: 90, kcal: 248, p: 8, c: 50, f: 1, ts: Date.now(), ...over });
const tick = () => new Promise((r) => setTimeout(r, 3));

test('sync codes: 120 bits, readable, normalized', () => {
  const code = generateCode();
  assert.match(code, /^([2-9A-HJ-NP-Z]{4}-){5}[2-9A-HJ-NP-Z]{4}$/);
  assert.notEqual(generateCode(), code);
  assert.equal(normalizeCode(code.toLowerCase().replace(/-/g, ' ')), code);
  assert.equal(normalizeCode('ABCD'), null);
  assert.equal(normalizeCode('0000-0000-0000-0000-0000-0000'), null);
});

test('second device receives everything after connecting with the code', async () => {
  const remote = fakeRemote();
  const a = device(remote);
  await a.store.put('entries', entry());
  await a.store.put('myFoods', { id: 'b729', n: 'במבה', kcal: 534, p: 15, c: 39, f: 35, m: [] });
  await a.store.put('favorites', { foodId: 'b729' });
  await a.store.put('weights', { date: '2026-10-25', kg: 70.5 });
  await a.store.setSetting('manualTarget', 1800);
  await a.store.setSetting('apiKey', 'sk-secret');                // must never leave the device

  const code = generateCode();
  const r = await a.sync.connect(code);
  assert.equal(r.pushed, 5);
  assert.equal(await a.db.outbox.count(), 0);
  assert.ok(![...remote.rows.values()].some((x) => JSON.stringify(x).includes('sk-secret')));

  const b = device(remote);
  await b.sync.connect(code);
  assert.equal(await b.db.log.count(), 1);
  assert.equal((await b.db.myFoods.get('b729')).n, 'במבה');
  assert.ok(await b.db.favorites.get('b729'));
  assert.equal((await b.db.weights.get('2026-10-25')).kg, 70.5);
  assert.equal(await b.store.getSetting('manualTarget'), 1800);
  assert.equal(await b.store.getSetting('apiKey'), null);
});

test('edits and deletes flow both ways', async () => {
  const remote = fakeRemote();
  const a = device(remote);
  const b = device(remote);
  const code = generateCode();
  await a.sync.connect(code);
  await b.sync.connect(code);

  const e = await a.store.put('entries', entry());
  await a.sync.syncNow();
  await b.sync.syncNow();
  assert.equal((await b.db.log.get(e.id)).kcal, 248);

  await tick();
  await b.store.put('entries', { ...(await b.db.log.get(e.id)), kcal: 300 });
  await b.sync.syncNow();
  await a.sync.syncNow();
  assert.equal((await a.db.log.get(e.id)).kcal, 300);

  await tick();
  await a.store.remove('entries', e.id);
  await a.sync.syncNow();
  const res = await b.sync.syncNow();
  assert.equal(res.changed, 1);
  assert.equal(await b.db.log.get(e.id), undefined);
});

test('concurrent edits: the later edit wins on both devices', async () => {
  const remote = fakeRemote();
  const a = device(remote);
  const b = device(remote);
  const code = generateCode();
  await a.sync.connect(code);
  const e = await a.store.put('entries', entry());
  await a.sync.syncNow();
  await b.sync.connect(code);

  await b.store.put('entries', { ...e, kcal: 111 });
  await tick();
  await a.store.put('entries', { ...e, kcal: 222 });   // later
  await b.sync.syncNow();
  await a.sync.syncNow();
  await b.sync.syncNow();
  assert.equal((await a.db.log.get(e.id)).kcal, 222);
  assert.equal((await b.db.log.get(e.id)).kcal, 222);
});

test('offline changes wait in the outbox and are sent later', async () => {
  const remote = fakeRemote();
  const a = device(remote);
  const code = generateCode();
  await a.sync.connect(code);
  remote.online = false;
  await a.store.put('weights', { date: '2026-10-26', kg: 70.1 });
  const r = await a.sync.syncNow();
  assert.ok(r.error);
  assert.equal(await a.db.outbox.count(), 1);
  assert.equal((await a.sync.status()).lastError, 'offline');

  remote.online = true;
  await a.sync.syncNow();
  assert.equal(await a.db.outbox.count(), 0);
  assert.equal((await a.sync.status()).lastError, null);
  const b = device(remote);
  await b.sync.connect(code);
  assert.equal((await b.db.weights.get('2026-10-26')).kg, 70.1);
});

test('nothing is sent without a code; disconnect keeps local data', async () => {
  const remote = fakeRemote();
  const a = device(remote);
  await a.store.put('entries', entry());
  assert.deepEqual(await a.sync.syncNow(), { skipped: true });
  assert.equal(remote.calls, 0);
  await a.sync.connect(generateCode());
  await a.sync.disconnect();
  assert.equal((await a.sync.status()).code, null);
  assert.equal(await a.db.log.count(), 1);
});

test('restoreAll replaces data and syncs the deletions too', async () => {
  const remote = fakeRemote();
  const a = device(remote);
  const code = generateCode();
  await a.sync.connect(code);
  const keep = await a.store.put('entries', entry({ name: 'נשאר' }));
  await a.store.put('entries', entry({ name: 'נמחק' }));
  await a.sync.syncNow();

  // a v1 backup has numeric entry ids
  await a.store.restoreAll({ entries: [{ ...keep }, { id: 7, date: '2026-10-20', meal: 'dinner', foodId: 't2', name: 'ישן', kcal: 100, ts: 5 }], myFoods: [], favorites: [], weights: [], settings: [] });
  assert.deepEqual((await a.db.log.toArray()).map((e) => e.name).sort(), ['ישן', 'נשאר']);
  await a.sync.syncNow();

  const b = device(remote);
  await b.sync.connect(code);
  assert.deepEqual((await b.db.log.toArray()).map((e) => e.name).sort(), ['ישן', 'נשאר']);
});

test('upgrade from v1 keeps existing diary entries', async () => {
  const name = `legacy-${Date.now()}`;
  const old = new Dexie(name);
  old.version(1).stores({ entries: '++id, date, meal, foodId, ts', myFoods: 'id, barcode, n', favorites: 'foodId', weights: 'date', settings: 'key' });
  await old.entries.bulkAdd([entry({ id: undefined, name: 'א', ts: 1 }), entry({ id: undefined, name: 'ב', ts: 2 })].map(({ id, ...e }) => e));
  old.close();

  const store = createStore(name, Dexie);
  devices.push({ store, sync: { stop() {} } });
  const rows = await store.db.log.orderBy('ts').toArray();
  assert.deepEqual(rows.map((r) => r.name), ['א', 'ב']);
  assert.ok(rows.every((r) => typeof r.id === 'string'));
  assert.equal(store.db.tables.some((t) => t.name === 'entries'), false);
});

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
      const rejected = [];
      for (const r of batch) {
        const key = `${code}|${r.kind}|${r.id}`;
        const cur = rows.get(key);
        if (!r.id || String(r.id).length > 200) { rejected.push({ kind: r.kind, id: r.id, reason: 'invalid' }); continue; }
        if (!cur || r.ts >= cur.ts) rows.set(key, { ...structuredClone(r), code, updated_at: remote.fixedTime || stamp() });
        else rejected.push({ kind: r.kind, id: r.id, reason: 'stale' });
      }
      return { applied: batch.length - rejected.length, rejected };
    },
    // keyset paging like sync_pull2: first page overlaps (here: everything since), later pages after the cursor
    async pull(code, cursor) {
      remote.calls++;
      if (!remote.online) throw new Error('offline');
      const key = (r) => `${r.updated_at}|${r.kind}|${r.id}`;
      const after = cursor?.kind ? `${cursor.since}|${cursor.kind}|${cursor.id}` : null;
      return [...rows.values()]
        .filter((r) => r.code === code && (after ? key(r) > after : (!cursor?.since || r.updated_at >= cursor.since)))
        .sort((a, b) => key(a).localeCompare(key(b)))
        .slice(0, remote.page || 1000)
        .map(({ kind, id, data, ts, updated_at }) => structuredClone({ kind, id, data, ts, updated_at }));
    },
    rows,
  };
  return remote;
}

let n = 0;
const devices = [];
function device(remote, opts = {}) {
  const store = createStore(`dev-${++n}-${Date.now()}`, Dexie);
  const sync = createSync(store, remote, { debounceMs: 60000, ...opts });
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

test('audit: thousands of rows with the same timestamp are paged through, never stuck', async () => {
  const remote = fakeRemote();
  remote.fixedTime = '2026-01-01T00:00:00.000Z';   // all written in "the same moment"
  remote.page = 50;
  const a = device(remote, { pullPage: 50 });
  for (let i = 0; i < 180; i++) await a.store.put('entries', entry({ id: `e${String(i).padStart(4, '0')}` }));
  const code = generateCode();
  await a.sync.connect(code);
  const b = device(remote, { pullPage: 50 });
  await b.sync.connect(code);
  assert.equal(await b.db.log.count(), 180);
  remote.fixedTime = null;
  await a.store.put('entries', entry({ id: 'later' }));
  await a.sync.syncNow();
  await b.sync.syncNow();
  assert.ok(await b.db.log.get('later'), 'a later change still arrives');
});

test('audit: an edit wins over a version stamped by a phone whose clock is ahead', async () => {
  const remote = fakeRemote();
  const a = device(remote);
  const b = device(remote);
  const code = generateCode();
  const id = newId();
  // A's clock is 5 minutes ahead
  const ahead = Date.now() + 300000;
  await a.store.db.log.put(entry({ id, name: 'old', mt: ahead }));
  await a.store.db.outbox.put({ key: `entries|${id}`, kind: 'entries', id, data: await a.db.log.get(id), ts: ahead });
  await a.sync.connect(code);
  await b.sync.connect(code);
  const got = await b.db.log.get(id);
  await b.store.put('entries', { ...got, name: 'new' });
  await b.sync.syncNow();
  await a.sync.syncNow();
  assert.equal((await a.db.log.get(id)).name, 'new');
  await b.store.remove('entries', id);
  await b.sync.syncNow();
  await a.sync.syncNow();
  assert.equal(await a.db.log.get(id), undefined);
});

test('audit: pulled rows that do not fit, and local-only settings, are never stored', async () => {
  const remote = fakeRemote();
  const a = device(remote);
  const code = generateCode();
  await a.store.setSetting('apiKey', 'sk-mine');
  await a.sync.connect(code);
  const future = Date.now() + 1e7;
  await remote.push(code, [
    { kind: 'settings', id: 'apiKey', data: { key: 'apiKey', value: 'sk-attacker' }, ts: future },
    { kind: 'entries', id: 'x"><img src=x onerror=alert(1)>', data: { id: 'x"><img src=x onerror=alert(1)>', date: '2026-10-25"><img>', foodId: 't1', name: 'x' }, ts: future },
    { kind: 'weights', id: '2026-10-25', data: { date: '2026-10-25', kg: '<img onerror=1>' }, ts: future },
    { kind: 'myFoods', id: 'u1', data: { id: 'u1', n: 'ok', kcal: 100, p: '<img>', c: 1, f: 1, m: [] }, ts: future },
    { kind: 'entries', id: 'good', data: entry({ id: 'good' }), ts: future },
  ]);
  await a.sync.syncNow();
  assert.equal(await a.store.getSetting('apiKey'), 'sk-mine');
  assert.equal(await a.db.weights.count(), 0);
  assert.equal(await a.db.myFoods.count(), 0);
  assert.deepEqual((await a.db.log.toArray()).map((e) => e.id), ['good']);
});

test('audit: a row the server refuses does not block the rest of the uploads', async () => {
  const remote = fakeRemote();
  const a = device(remote);
  const code = generateCode();
  await a.store.db.outbox.put({ key: 'myFoods|bad', kind: 'myFoods', id: 'x'.repeat(201), data: { id: 'x'.repeat(201) }, ts: 1 });
  await a.store.put('entries', entry({ id: 'after' }));
  await a.sync.connect(code);
  const st = await a.sync.status();
  assert.equal(st.pending, 0);
  assert.equal(st.skipped, 1);
  assert.ok([...remote.rows.keys()].some((k) => k.endsWith('|entries|after')));
});

test('audit: restoring an old backup on a new phone does not undo newer edits or deletes', async () => {
  const remote = fakeRemote();
  const a = device(remote);
  const code = generateCode();
  await a.sync.connect(code);
  await a.store.put('entries', entry({ id: 'X', name: 'X' }));
  await a.store.put('entries', entry({ id: 'Y', name: 'Y-old' }));
  await a.sync.syncNow();
  const backup = await a.store.dumpAll();
  await tick();
  await a.store.remove('entries', 'X');
  await a.store.put('entries', { ...(await a.db.log.get('Y')), name: 'Y-new' });
  await a.sync.syncNow();
  const b = device(remote);
  await b.store.restoreAll(backup);
  await b.sync.connect(code);
  await a.sync.syncNow();
  assert.deepEqual((await a.db.log.toArray()).map((e) => `${e.id}:${e.name}`).sort(), ['Y:Y-new']);
  assert.deepEqual((await b.db.log.toArray()).map((e) => `${e.id}:${e.name}`).sort(), ['Y:Y-new']);
});

test('audit: a backup with one bad row is rejected before anything changes', async () => {
  const a = device(fakeRemote());
  await a.store.put('entries', entry({ id: 'keep' }));
  await a.store.put('weights', { date: '2026-10-20', kg: 70 });
  await assert.rejects(a.store.restoreAll({ entries: [entry({ id: 'n1' })], weights: [{ kg: 71 }] }));
  assert.ok(await a.db.log.get('keep'));
  assert.equal(await a.db.weights.count(), 1);
  assert.equal(await a.db.outbox.filter((o) => o.data === null).count(), 0);
});

test('audit: disconnecting keeps unsent deletes, so they reach the cloud after reconnecting', async () => {
  const remote = fakeRemote();
  const a = device(remote);
  const code = generateCode();
  await a.sync.connect(code);
  await a.store.put('entries', entry({ id: 'D' }));
  await a.sync.syncNow();
  remote.online = false;
  await a.store.remove('entries', 'D');
  await a.sync.disconnect();
  remote.online = true;
  await a.sync.connect(code);
  assert.equal(remote.rows.get(`${code}|entries|D`).data, null);
});

test('restoring an old backup on a syncing device: the cloud\'s newer edits and deletes win (Codex P1)', async () => {
  const remote = fakeRemote();
  const a = device(remote);
  const b = device(remote);
  const code = generateCode();
  await a.sync.connect(code);
  const kept = await a.store.put('entries', entry({ name: 'נערך', kcal: 248 }));
  const gone = await a.store.put('entries', entry({ name: 'נמחק' }));
  await a.sync.syncNow();
  const backup = await a.store.dumpAll();                 // old backup, taken now

  await b.sync.connect(code);
  await tick();
  await b.store.put('entries', { ...(await b.db.log.get(kept.id)), kcal: 300 });   // edited elsewhere later
  await b.store.remove('entries', gone.id);                                         // deleted elsewhere later
  await b.sync.syncNow();
  await a.sync.syncNow();
  for (let i = 0; i < 3; i++) {                          // move the pull cursor well past those changes
    await b.store.put('weights', { date: `2026-10-2${i}`, kg: 70 + i });
    await b.sync.syncNow();
    await a.sync.syncNow();
  }
  assert.equal((await a.db.log.get(kept.id)).kcal, 300);

  await a.store.restoreAll(backup);                       // brings back the old versions locally
  assert.equal((await a.db.log.get(kept.id)).kcal, 248);
  await a.sync.syncNow();                                 // the server rejects them as stale
  await a.sync.syncNow();
  assert.equal((await a.db.log.get(kept.id)).kcal, 300, 'newer cloud edit came back');
  assert.equal(await a.db.log.get(gone.id), undefined, 'cloud delete came back');
  assert.equal(await a.db.outbox.count(), 0);
});

test('undo after a synced delete survives, even when the row came from a phone whose clock is ahead (Codex P2)', async () => {
  const remote = fakeRemote();
  const a = device(remote);
  const code = generateCode();
  await a.sync.connect(code);
  // a row written by a phone whose clock is 1000 s ahead
  const future = Date.now() + 1_000_000;
  const row = { ...entry({ name: 'מהטלפון השני' }), mt: future };
  await remote.push(code, [{ kind: 'entries', id: row.id, data: row, ts: future }]);
  await a.sync.syncNow();
  const local = await a.db.log.get(row.id);
  assert.equal(local.mt, future);

  await a.store.remove('entries', row.id);               // delete...
  await a.sync.syncNow();                                // ...the tombstone syncs and leaves the outbox
  assert.equal(await a.db.outbox.count(), 0);
  await a.store.put('entries', local);                   // ...then "undo"
  await a.sync.syncNow();
  await a.sync.syncNow();
  assert.ok(await a.db.log.get(row.id), 'undo is not deleted again by the next pull');
  const cloud = remote.rows.get(`${code}|entries|${row.id}`);
  assert.ok(cloud.data, 'the cloud has the restored row, not the tombstone');

  const b = device(remote);                              // and another phone sees it too
  await b.sync.connect(code);
  assert.ok(await b.db.log.get(row.id));
});

test('deletes kept from a disconnect are not replayed into a different sync code (Codex P2)', async () => {
  const remote = fakeRemote();
  const codeA = generateCode();
  const codeB = generateCode();
  // vault B has a weight for a date
  const other = device(remote);
  await other.sync.connect(codeB);
  await other.store.put('weights', { date: '2026-10-20', kg: 80 });
  await other.sync.syncNow();

  const a = device(remote);
  await a.sync.connect(codeA);
  await a.store.put('weights', { date: '2026-10-20', kg: 70 });
  await a.sync.syncNow();
  remote.online = false;
  await a.store.remove('weights', '2026-10-20');          // deleted offline: the tombstone stays in the outbox
  await a.sync.disconnect();
  remote.online = true;
  await a.sync.connect(codeB);                             // joins a different vault
  const inB = remote.rows.get(`${codeB}|weights|2026-10-20`);
  assert.equal(inB.data?.kg, 80, 'vault B keeps its weight');

  // reconnecting to the same code still sends the kept delete
  const c = device(remote);
  await c.sync.connect(codeA);
  await c.store.put('weights', { date: '2026-10-21', kg: 71 });
  await c.sync.syncNow();
  remote.online = false;
  await c.store.remove('weights', '2026-10-21');
  await c.sync.disconnect();
  remote.online = true;
  await c.sync.connect(codeA);
  assert.equal(remote.rows.get(`${codeA}|weights|2026-10-21`).data, null, 'same vault: the delete is sent');
});

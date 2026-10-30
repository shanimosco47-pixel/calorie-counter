// Local storage on the phone (IndexedDB through Dexie, loaded from vendor/dexie.min.js).
// Every user write goes through put()/remove(), which also records the change in an outbox
// so lib/sync.js can push it to the cloud. Rows carry `mt` (modified time, ms) for last-write-wins.

/* global Dexie */

// kind (as used in backups and in the cloud) -> local table and primary key
export const KINDS = {
  entries: { table: 'log', pk: 'id' },
  myFoods: { table: 'myFoods', pk: 'id' },
  favorites: { table: 'favorites', pk: 'foodId' },
  weights: { table: 'weights', pk: 'date' },
  settings: { table: 'settings', pk: 'key' },
};

// settings that stay on this device only
export const LOCAL_ONLY_SETTINGS = new Set(['apiKey']);

export function newId() {
  const rand = globalThis.crypto?.randomUUID
    ? crypto.randomUUID().replace(/-/g, '')
    : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return 'e' + Date.now().toString(36) + rand.slice(0, 12);
}

const isSynced = (kind, row) => !(kind === 'settings' && LOCAL_ONLY_SETTINGS.has(row?.key));
const outboxKey = (kind, id) => `${kind}|${id}`;

export function createStore(name = 'kalorit', DexieImpl = globalThis.Dexie) {
  const db = new DexieImpl(name);

  db.version(1).stores({
    entries: '++id, date, meal, foodId, ts',
    myFoods: 'id, barcode, n',
    favorites: 'foodId',
    weights: 'date',
    settings: 'key',
  });
  // v2: diary entries move to `log` with globally unique string ids (needed for multi-device sync)
  db.version(2).stores({
    log: 'id, date, meal, foodId, ts',
    outbox: 'key',
    meta: 'key',
  }).upgrade(async (tx) => {
    const old = await tx.table('entries').toArray();
    await tx.table('log').bulkPut(old.map(({ id, ...e }) => ({ ...e, id: `e${id}x${e.ts || 0}`, mt: e.ts || 0 })));
  });
  db.version(3).stores({ entries: null });

  const listeners = new Set();
  let writing = 0;   // in-flight writes; an update must not reload over them
  const notify = (kind) => { for (const fn of listeners) fn(kind); };

  async function put(kind, row) {
    const { table, pk } = KINDS[kind];
    const data = { ...row, mt: Date.now() };
    writing++;
    try {
      await db.transaction('rw', db[table], db.outbox, async () => {
        await db[table].put(data);
        if (isSynced(kind, data)) {
          await db.outbox.put({ key: outboxKey(kind, data[pk]), kind, id: String(data[pk]), data, ts: data.mt });
        }
      });
    } finally {
      writing--;
    }
    notify(kind);
    return data;
  }

  async function remove(kind, id) {
    const { table } = KINDS[kind];
    writing++;
    try { await removeRow(kind, table, id); } finally { writing--; }
    notify(kind);
  }

  async function removeRow(kind, table, id) {
    await db.transaction('rw', db[table], db.outbox, async () => {
      const existing = await db[table].get(id);
      await db[table].delete(id);
      if (isSynced(kind, existing || { key: id })) {
        await db.outbox.put({ key: outboxKey(kind, id), kind, id: String(id), data: null, ts: Date.now() });
      }
    });
  }

  async function getSetting(key, fallback = null) {
    const row = await db.settings.get(key);
    return row ? row.value : fallback;
  }

  const setSetting = (key, value) => put('settings', { key, value });

  async function dumpAll() {
    const out = {};
    for (const [kind, { table }] of Object.entries(KINDS)) out[kind] = await db[table].toArray();
    out.settings = out.settings.filter((s) => !LOCAL_ONLY_SETTINGS.has(s.key));
    return out;
  }

  // Replaces all data with a parsed backup; changes are synced like any other edit.
  async function restoreAll(data) {
    for (const [kind, { table, pk }] of Object.entries(KINDS)) {
      const rows = (data[kind] || []).map((r) => (kind === 'entries' && typeof r.id !== 'string' ? { ...r, id: `e${r.id}x${r.ts || 0}` } : r));
      const keep = new Set(rows.map((r) => String(r[pk])));
      for (const existing of await db[table].toArray()) {
        if (!keep.has(String(existing[pk])) && isSynced(kind, existing)) await remove(kind, existing[pk]);
      }
      for (const r of rows) if (isSynced(kind, r)) await put(kind, r);
    }
  }

  // Most recent distinct foods, newest first, with the amount last used.
  async function recentFoods(limit = 12) {
    const rows = await db.log.orderBy('ts').reverse().limit(300).toArray();
    const seen = new Map();
    for (const e of rows) {
      if (!seen.has(e.foodId)) seen.set(e.foodId, e);
      if (seen.size >= limit) break;
    }
    return [...seen.values()];
  }

  return {
    db, put, remove, getSetting, setSetting, dumpAll, restoreAll, recentFoods,
    isWriting: () => writing > 0,
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

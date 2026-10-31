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

// Shape check for rows that come from outside this device (sync, backup files). Anything that would
// break rendering or the database is refused: ids are short strings, dates are YYYY-MM-DD, numbers
// are finite, names are strings.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isId = (v) => (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) && String(v).length >= 1 && String(v).length <= 200;
const isNum = (v) => v === undefined || v === null || (typeof v === 'number' && Number.isFinite(v));
const isStr = (v, max = 300) => v === undefined || (typeof v === 'string' && v.length <= max);
const units = (m) => m === undefined || (Array.isArray(m) && m.length <= 60 && m.every((u) => Array.isArray(u)
  && isId(u[0]) && typeof u[1] === 'number' && Number.isFinite(u[1]) && u[1] >= 0 && isStr(u[2], 60)));
const VALIDATORS = {
  entries: (r) => isId(r.id) && DATE_RE.test(r.date) && isStr(r.meal, 20) && isId(r.foodId) && isStr(r.name)
    && (r.unit === undefined || r.unit === null || isId(r.unit)) && ['amount', 'grams', 'kcal', 'p', 'c', 'f', 'ts'].every((k) => isNum(r[k])),
  myFoods: (r) => isId(r.id) && isStr(r.n) && ['kcal', 'p', 'c', 'f'].every((k) => isNum(r[k])) && units(r.m)
    && isStr(r.barcode, 20) && isStr(r.src, 20),
  favorites: (r) => isId(r.foodId),
  weights: (r) => DATE_RE.test(r.date) && typeof r.kg === 'number' && Number.isFinite(r.kg),
  settings: (r) => typeof r.key === 'string' && r.key.length >= 1 && r.key.length <= 60,
};
export function validRow(kind, row, id) {
  const check = VALIDATORS[kind];
  if (!check || !row || typeof row !== 'object' || Array.isArray(row)) return false;
  if (!check(row)) return false;
  return id === undefined || String(row[KINDS[kind].pk]) === String(id);
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

  // A change always gets a newer stamp than the version it replaces, even when this phone's clock is
  // behind the phone that wrote that version; otherwise the edit would lose to it everywhere.
  // Deletions leave a high-water mark in meta ("hw|kind|id"), so re-adding a deleted row (undo)
  // is also newer than its tombstone, even after the tombstone was synced and left the outbox.
  const hwKey = (kind, id) => `hw|${kind}|${id}`;
  const deletedAt = async (kind, id) => (await db.meta.get(hwKey(kind, id)))?.value || 0;
  const stamp = (existing, floor = 0) => Math.max(Date.now(), (existing?.mt || 0) + 1, floor + 1);

  // must run inside a transaction that includes db.meta
  async function noteDeleted(kind, id, ts) {
    if (ts > (await deletedAt(kind, id))) await db.meta.put({ key: hwKey(kind, id), value: ts });
  }

  async function put(kind, row) {
    const { table, pk } = KINDS[kind];
    const id = row?.[pk];
    if (id === undefined || id === null || String(id).length < 1 || String(id).length > 200) throw new Error(`invalid id for ${kind}`);
    let data;
    writing++;
    try {
      await db.transaction('rw', db[table], db.outbox, db.meta, async () => {
        data = { ...row, mt: stamp(await db[table].get(id), await deletedAt(kind, id)) };
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
    await db.transaction('rw', db[table], db.outbox, db.meta, async () => {
      const existing = await db[table].get(id);
      const ts = stamp(existing, await deletedAt(kind, id));
      await db[table].delete(id);
      await noteDeleted(kind, id, ts);
      if (isSynced(kind, existing || { key: id })) {
        await db.outbox.put({ key: outboxKey(kind, id), kind, id: String(id), data: null, ts });
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

  // Replaces all data with a parsed backup, all or nothing. Every row is checked first; one bad row
  // rejects the file before anything changes. Restored rows keep the time they were last edited, so
  // an old backup restored on a new phone cannot override newer edits or deletes made since.
  async function restoreAll(data) {
    const plan = [];
    for (const [kind, { table, pk }] of Object.entries(KINDS)) {
      const rows = (data[kind] || []).map((r) => (kind === 'entries' && r && typeof r.id === 'number' ? { ...r, id: `e${r.id}x${r.ts || 0}` } : r));
      const bad = rows.findIndex((r) => !validRow(kind, r));
      if (bad >= 0) throw new Error(`invalid ${kind} row #${bad + 1} in backup`);
      plan.push({ kind, table, pk, rows: rows.filter((r) => isSynced(kind, r)) });
    }
    writing++;
    try {
      await db.transaction('rw', [db.outbox, db.meta, ...plan.map((p) => db[p.table])], async () => {
        const now = Date.now();
        for (const { kind, table, pk, rows } of plan) {
          const keep = new Set(rows.map((r) => String(r[pk])));
          for (const existing of await db[table].toArray()) {
            if (keep.has(String(existing[pk])) || !isSynced(kind, existing)) continue;
            const ts = Math.max(now, (existing.mt || 0) + 1);
            await db[table].delete(existing[pk]);
            await noteDeleted(kind, existing[pk], ts);
            await db.outbox.put({ key: outboxKey(kind, existing[pk]), kind, id: String(existing[pk]), data: null, ts });
          }
          for (const r of rows) {
            const row = { ...r, mt: Number.isFinite(r.mt) && r.mt > 0 ? r.mt : (r.ts || 1) };
            await db[table].put(row);
            await db.outbox.put({ key: outboxKey(kind, row[pk]), kind, id: String(row[pk]), data: row, ts: row.mt });
          }
        }
      });
    } finally {
      writing--;
    }
    for (const { kind } of plan) notify(kind);
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
    noteDeleted,
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

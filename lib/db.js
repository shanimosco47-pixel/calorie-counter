// Local storage on the phone (IndexedDB through Dexie, loaded from vendor/dexie.min.js).

/* global Dexie */
export const db = new Dexie('kalorit');

db.version(1).stores({
  entries: '++id, date, meal, foodId, ts',
  myFoods: 'id, barcode, n',
  favorites: 'foodId',
  weights: 'date',
  settings: 'key',
});

export async function getSetting(key, fallback = null) {
  const row = await db.settings.get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  return db.settings.put({ key, value });
}

export async function dumpAll() {
  const out = {};
  for (const t of ['entries', 'myFoods', 'weights', 'settings', 'favorites']) out[t] = await db[t].toArray();
  return out;
}

// Replaces all data with a parsed backup in one transaction.
export function restoreAll(data) {
  const tables = ['entries', 'myFoods', 'weights', 'settings', 'favorites'];
  return db.transaction('rw', tables.map((t) => db[t]), async () => {
    for (const t of tables) {
      await db[t].clear();
      if (data[t].length) await db[t].bulkPut(data[t]);
    }
  });
}

// Most recent distinct foods, newest first, with the amount last used.
export async function recentFoods(limit = 12) {
  const rows = await db.entries.orderBy('ts').reverse().limit(300).toArray();
  const seen = new Map();
  for (const e of rows) {
    if (!seen.has(e.foodId)) seen.set(e.foodId, e);
    if (seen.size >= limit) break;
  }
  return [...seen.values()];
}

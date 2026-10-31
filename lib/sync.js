// Cloud sync: pushes the local outbox, pulls changes from other devices, last write wins by `mt`.
// The remote is injected (lib/remote.js in the app, an in-memory fake in tests).

import { KINDS, LOCAL_ONLY_SETTINGS, validRow } from './store.js';

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';   // no 0/O/1/I, easy to read aloud
const PUSH_BATCH = 400;
export const PULL_PAGE = 1000;   // must match the LIMIT in sync_pull2

// 24 random characters x 5 bits = 120 bits, shown as XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
export function generateCode() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return formatCode([...bytes].map((b) => ALPHABET[b % 32]).join(''));
}

export function normalizeCode(input) {
  const raw = String(input || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (raw.length !== 24 || [...raw].some((c) => !ALPHABET.includes(c))) return null;
  return formatCode(raw);
}

function formatCode(s) {
  return s.match(/.{4}/g).join('-');
}

export function createSync(store, remote, { debounceMs = 1500, onStatus = () => {}, onApplied = () => {}, pullPage = PULL_PAGE } = {}) {
  const { db } = store;
  let running = null;
  let again = false;
  let timer = null;

  const meta = {
    get: async (key, fallback = null) => (await db.meta.get(key))?.value ?? fallback,
    set: (key, value) => db.meta.put({ key, value }),
    del: (key) => db.meta.delete(key),
  };

  async function status() {
    return {
      code: await meta.get('syncCode'),
      lastSync: await meta.get('lastSync'),
      lastError: await meta.get('lastError'),
      pending: await db.outbox.count(),
      skipped: await meta.get('skipped', 0),
    };
  }

  // Queue every local row so a newly connected device uploads what it has.
  async function enqueueAll() {
    await db.transaction('rw', [db.outbox, ...Object.values(KINDS).map((k) => db[k.table])], async () => {
      for (const [kind, { table, pk }] of Object.entries(KINDS)) {
        for (const row of await db[table].toArray()) {
          if (kind === 'settings' && LOCAL_ONLY_SETTINGS.has(row.key)) continue;
          const key = `${kind}|${row[pk]}`;
          if (!(await db.outbox.get(key))) await db.outbox.put({ key, kind, id: String(row[pk]), data: row, ts: row.mt || 0 });
        }
      }
    });
  }

  async function connect(code) {
    const norm = normalizeCode(code);
    if (!norm) throw new Error('קוד סנכרון לא תקין');
    // deletes kept from a disconnect belong to that code's data: never replay them into another one
    const keptFor = await meta.get('outboxCode');
    if (keptFor && keptFor !== norm) await db.outbox.filter((o) => o.data == null).delete();
    await meta.del('outboxCode');
    await meta.set('syncCode', norm);
    await meta.del('lastPull');
    await meta.del('lastError');
    await enqueueAll();
    return syncNow();
  }

  async function disconnect() {
    const code = await meta.get('syncCode');
    if (code) await meta.set('outboxCode', code);   // the kept deletes below belong to this code
    await meta.del('syncCode');
    await meta.del('lastPull');
    await meta.del('lastSync');
    await meta.del('lastError');
    // keep unsent deletes: on reconnect enqueueAll re-adds every row, but nothing else remembers a delete
    await db.outbox.filter((o) => o.data != null).delete();
    onStatus(await status());
  }

  async function push(code) {
    let pushed = 0;
    for (;;) {
      const batch = await db.outbox.limit(PUSH_BATCH).toArray();
      if (!batch.length) return pushed;
      const res = await remote.push(code, batch.map(({ kind, id, data, ts }) => ({ kind, id, data, ts })));
      // invalid rows can never be stored (the server says so instead of failing the whole batch);
      // stale ones lost to a newer edit elsewhere, which the pull brings back. Either way they are done.
      const rejected = Array.isArray(res?.rejected) ? res.rejected.filter((r) => r.reason === 'invalid').length : 0;
      if (rejected) await meta.set('skipped', ((await meta.get('skipped', 0)) || 0) + rejected);
      // a stale row lost to a version that may be older than the incremental pull window (e.g. after
      // restoring an old backup): pull everything once so the winning versions really come back
      if (Array.isArray(res?.rejected) && res.rejected.some((r) => r.reason === 'stale')) await meta.del('lastPull');
      // drop only what was sent; a row edited meanwhile keeps its newer outbox entry
      await db.transaction('rw', db.outbox, async () => {
        for (const sent of batch) {
          const cur = await db.outbox.get(sent.key);
          if (cur && cur.ts === sent.ts) await db.outbox.delete(sent.key);
        }
      });
      pushed += batch.length;
      if (batch.length < PUSH_BATCH) return pushed;
    }
  }

  async function pull(code) {
    let changed = 0;
    const since = await meta.get('lastPull');
    let cursor = since ? { since } : null;
    for (;;) {
      const rows = await remote.pull(code, cursor);
      if (!rows.length) return changed;
      const tables = Object.values(KINDS).map((k) => db[k.table]);
      await db.transaction('rw', [db.outbox, db.meta, ...tables], async () => {
        for (const r of rows) {
          const kindInfo = KINDS[r.kind];
          if (!kindInfo) continue;
          // settings that live on one device only are never taken from the cloud (e.g. the API key)
          if (r.kind === 'settings' && LOCAL_ONLY_SETTINGS.has(r.id)) continue;
          // a row from another device or app version that does not fit is skipped, never stored
          if (r.data != null && !validRow(r.kind, r.data, r.id)) continue;
          const table = db[kindInfo.table];
          const pending = await db.outbox.get(`${r.kind}|${r.id}`);
          if (pending && pending.ts > r.ts) continue;              // our unsent edit is newer
          const local = await table.get(r.id);
          if (local && (local.mt || 0) > r.ts) continue;           // local copy is newer
          if (r.data == null) {
            await store.noteDeleted(r.kind, r.id, r.ts);         // a later undo/re-add must be newer
            if (local) { await table.delete(r.id); changed++; }
          } else if (!local || (local.mt || 0) !== r.ts) {
            await table.put(r.data);
            changed++;
          }
          if (pending && pending.ts <= r.ts) await db.outbox.delete(pending.key);
        }
      });
      // rows come ordered by (updated_at, kind, id): the last one is where the next page starts
      const last = rows[rows.length - 1];
      cursor = { since: last.updated_at, kind: last.kind, id: last.id };
      await meta.set('lastPull', last.updated_at);
      if (rows.length < pullPage) return changed;
    }
  }

  async function run() {
    const code = await meta.get('syncCode');
    if (!code) return { skipped: true };
    try {
      const pushed = await push(code);
      const changed = await pull(code);
      await meta.set('lastSync', Date.now());
      await meta.del('lastError');
      if (changed) await onApplied(changed);
      return { pushed, changed };
    } catch (err) {
      await meta.set('lastError', String(err.message || err));
      return { error: err };
    } finally {
      onStatus(await status());
    }
  }

  // Runs one sync at a time; a request during a run triggers exactly one more run afterwards.
  async function syncNow() {
    if (running) { again = true; return running; }
    running = (async () => {
      let result;
      do { again = false; result = await run(); } while (again);
      return result;
    })();
    try { return await running; } finally { running = null; }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => { syncNow(); }, debounceMs);
  }

  const unsubscribe = store.onChange(schedule);

  function stop() {
    clearTimeout(timer);
    unsubscribe();
  }

  return { connect, disconnect, syncNow, schedule, status, stop, generateCode };
}

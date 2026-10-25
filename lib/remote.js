// Supabase adapter for lib/sync.js. Calls the sync_push / sync_pull database functions over REST;
// the sync code is the only credential and never leaves the device except inside these calls.

export const SUPABASE_URL = 'https://ihvbbrfwawzhksyifemd.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_pNpSEDHUtPaqdBf0LHxPpw_l5tkVSFL';   // public by design

export function supabaseRemote(url = SUPABASE_URL, key = SUPABASE_KEY, { timeoutMs = 15000 } = {}) {
  async function rpc(fn, body) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('אין חיבור לאינטרנט');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { apikey: key, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        let msg = `${res.status}`;
        try { msg = (await res.json()).message || msg; } catch { /* not json */ }
        throw new Error(`שגיאת שרת: ${msg}`);
      }
      return res.json();
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('השרת לא הגיב בזמן');
      if (err instanceof TypeError) throw new Error('אין חיבור לשרת');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    push: (code, rows) => rpc('sync_push', { p_code: code, p_rows: rows }),
    pull: (code, since) => rpc('sync_pull', { p_code: code, p_since: since || null }),
  };
}

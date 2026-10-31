// Meal photo recognition with the Claude API, called straight from the phone with the user's own key.
// The key never leaves the device except in this request to api.anthropic.com (it is a local-only
// setting and is never synced). Pure helpers are exported for node tests; the request takes an
// injectable fetch.

// Haiku: recognizing food is a perception task, and at ~0.07 cents a photo the cost is negligible
import { normalize } from './match.js';

export const VISION_MODEL = 'claude-haiku-5-5';
const API_URL = 'https://api.anthropic.com/v1/messages';

const SYSTEM = `You identify food in a meal photo for an Israeli calorie-tracking app.
List every distinct food or drink you can see, as separate items (a plate of schnitzel with rice and salad is three items).
For each item:
- name: a short Hebrew name for the user, e.g. "שניצל עוף", "אורז לבן מבושל", "סלט ירקות".
- query: a short Hebrew search term the way the Israeli Ministry of Health food database (Tzameret) names the food, generic, singular, without brands: the main food first, then how it was prepared, e.g. "שניצל חזה עוף מטוגן", "אורז לבן מבושל", "מלפפון".
- alt_queries: 1-3 other Hebrew search terms for the same food, simpler or closer to how a database would list it, e.g. for scrambled eggs ["חביתה", "ביצה או חביתה מטוגנת"], for a pita ["פיתה"].
- grams: your best estimate of the edible weight on the plate, in grams (drinks: ml as grams). Use plate, cutlery and hands for scale.
- unit_name, unit_count, unit_grams: when the food is naturally counted, how people would count it: the Hebrew unit in singular, how many of them, and the weight of one, e.g. scrambled eggs from 3 eggs: "ביצה", 3, 50; two slices of bread: "פרוסה", 2, 30; a glass of juice: "כוס", 1, 240. When it is not counted (rice, salad, sauce), unit_name "" and 0 for both numbers.
- kcal_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g: typical values for that food as prepared in the photo.
Include oil, sauces and spreads you can see as their own items when they are a meaningful amount.
If the photo shows no food, return an empty items list.`;

const NUM = { type: 'number' };
export const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          query: { type: 'string' },
          alt_queries: { type: 'array', items: { type: 'string' } },
          grams: NUM,
          unit_name: { type: 'string' },
          unit_count: NUM,
          unit_grams: NUM,
          kcal_per_100g: NUM,
          protein_per_100g: NUM,
          carbs_per_100g: NUM,
          fat_per_100g: NUM,
        },
        required: ['name', 'query', 'alt_queries', 'grams', 'unit_name', 'unit_count', 'unit_grams',
          'kcal_per_100g', 'protein_per_100g', 'carbs_per_100g', 'fat_per_100g'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

export class VisionError extends Error {
  constructor(code, message, detail = '') { super(message); this.code = code; this.detail = detail; }
}

// Errors where trying the same photo again cannot help: hide the retry button.
export const NO_RETRY = new Set(['no_key', 'auth', 'credit', 'bad_image', 'api']);

export function buildRequest(imageBase64, mediaType = 'image/jpeg') {
  return {
    model: VISION_MODEL,
    max_tokens: 8000,
    system: SYSTEM,
    // a food photo is a quick perception task: low effort keeps it fast and cheap
    output_config: { effort: 'low', format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
    // no `fallbacks`: Haiku has no server-side fallback (a refusal shows the "photograph again" message)
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
        { type: 'text', text: 'What food is in this photo, and how much of each?' },
      ],
    }],
  };
}

// Turns an API response body into clean items; throws VisionError on refusals and malformed output.
export function parseResponse(body) {
  if (body?.stop_reason === 'refusal') throw new VisionError('refusal', 'refusal');
  const text = (body?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let data;
  try { data = JSON.parse(text); } catch { throw new VisionError('bad_output', 'unreadable response'); }
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
  return (Array.isArray(data?.items) ? data.items : [])
    .map((it) => {
      const unitName = String(it.unit_name || '').trim().slice(0, 30);
      const count = Math.min(num(it.unit_count), 100);
      const unitGrams = num(it.unit_grams);
      // Claude's total weight is the truth (shakshuka "2 eggs" weighs far more than 2 eggs); the
      // count only says how to count it. Without a total, the count times one unit stands in.
      let grams = num(it.grams);
      if (!grams && count > 0) grams = count * unitGrams;
      grams = Math.min(Math.round(grams), 5000);
      const unit = unitName && count > 0 && grams > 0 ? { name: unitName, count } : null;
      const query = String(it.query || it.name || '').trim();
      const alts = (Array.isArray(it.alt_queries) ? it.alt_queries : []).map((q) => String(q || '').trim()).filter(Boolean);
      return {
        name: String(it.name || '').trim(),
        query,
        queries: [...new Set([query, ...alts])].filter(Boolean).slice(0, 4),
        grams,
        unit,
        kcal: num(it.kcal_per_100g),
        p: num(it.protein_per_100g),
        c: num(it.carbs_per_100g),
        f: num(it.fat_per_100g),
      };
    })
    .filter((it) => it.name && it.grams > 0);
}

const norm = (s) => String(s || '').replace(/^≈\s*/, '').replace(/[׳״'"]/g, '').trim();
const GENERIC_PIECE = /^b?10[0-5]$/;   // Tzameret's "יחידה" sizes: the piece of a food counted by itself

/**
 * How the recognized amount opens in the confirm sheet. A counted item ("3 eggs") opens in that unit
 * when the chosen food has a unit of that name, or, for a food counted by itself (an egg, a pita),
 * a "יחידה" size; among several sizes, the one whose total is closest to Claude's weight, and only
 * when that total is within half to double of it. Otherwise grams. labelOf(food, code) names a unit.
 */
export function amountFor(item, food, labelOf) {
  const grams = { amount: item.grams, unit: 'g' };
  if (!item.unit || !item.grams) return grams;
  const want = norm(item.unit.name);
  const units = food.m || [];
  let fits = units.filter(([code]) => {
    const label = norm(labelOf(food, code));
    return label === want || label.startsWith(want + ' ');
  });
  if (!fits.length && norm(food.n).startsWith(want)) fits = units.filter(([code]) => GENERIC_PIECE.test(String(code)));
  let best = null;
  for (const [code, g] of fits) {
    const ratio = (item.unit.count * g) / item.grams;
    const off = Math.abs(Math.log(ratio));
    if (ratio >= 0.5 && ratio <= 2 && (!best || off < best.off)) best = { code: String(code), off };
  }
  return best ? { amount: item.unit.count, unit: best.code } : grams;
}

/**
 * Chooses the database food for one recognized item: the best-ranked search candidate whose
 * calories are close to Claude's estimate (so "cheese" does not land on cheese powder).
 * When no candidate is plausible, returns a food built from Claude's own per-100g estimate.
 */
// alternatives arrive tagged with the term that found them; the tag never leaves pickFood
function stripAlt(food) {
  if (!('altQuery' in food)) return food;
  const { altQuery, ...rest } = food;
  return rest;
}

export function pickFood(item, candidates, { makeId = () => 'a' + Date.now().toString(36), alternatives = [] } = {}) {
  const close = (tolerance) => (food) => {
    const diff = Math.abs(food.kcal - item.kcal);
    return diff <= 40 * (tolerance / 0.4) || (item.kcal > 0 && diff / item.kcal <= tolerance);
  };
  // earlier photo estimates are not database data: never reuse one as a "match"
  const real = (list) => list.filter((f) => f.src !== 'ai');
  // An alternative term is broader ("גלידה" for "עוגת גלידה"), so its hit must also share a word with
  // what Claude saw beyond the alternative itself (compared by 3-letter stems: ביצים ~ ביצה).
  const stems = (text) => normalize(text).split(' ').filter((w) => w.length >= 2).map((w) => w.slice(0, 3));
  const seen = new Set(stems(`${item.name} ${item.query}`));
  const related = (food) => {
    const own = new Set(stems(food.altQuery || ''));
    const extra = [...seen].filter((s) => !own.has(s));
    const words = new Set(stems(food.n));
    return extra.length === 0 || extra.some((s) => words.has(s));
  };
  // the primary search term first; the broader alternative terms only with a tighter calorie check
  const match = real(candidates).slice(0, 8).find(close(0.4))
    || real(alternatives).find((f) => close(0.25)(f) && related(f));
  if (match) return { food: stripAlt(match), estimated: false };
  // not in the database: Claude's estimate, counted in its unit (so "3 eggs" stays editable as eggs);
  // a unit too small to weigh (under 0.1 g) is left out rather than stored as 0 g
  const perUnit = item.unit ? Math.round((item.grams / item.unit.count) * 100) / 100 : 0;
  const m = perUnit >= 0.1 ? [['u1', perUnit, item.unit.name]] : [];
  return {
    food: { id: makeId(), n: item.name, kcal: Math.round(item.kcal), p: item.p, c: item.c, f: item.f, m, src: 'ai' },
    estimated: true,
  };
}

export async function analyzePhoto({ apiKey, imageBase64, mediaType, fetchImpl = fetch, timeoutMs = 90000, signal } = {}) {
  if (!apiKey) throw new VisionError('no_key', 'no API key');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
  let res;
  try {
    res = await fetchImpl(API_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        // the key belongs to the phone's owner and stays on the phone; there is no server of ours
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(buildRequest(imageBase64, mediaType)),
    });
  } catch (e) {
    if (signal?.aborted) throw new VisionError('cancelled', 'cancelled');
    throw new VisionError(ctrl.signal.aborted ? 'timeout' : 'network', String(e?.message || e));
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch { /* not json */ }
    const code = res.status === 401 || res.status === 403 ? 'auth'
      : /credit balance|billing/i.test(detail) ? 'credit'
        : res.status === 429 ? 'rate_limit'
          : res.status === 529 || res.status >= 500 ? 'overloaded'
            : res.status === 413 ? 'too_large' : 'api';
    throw new VisionError(code, `HTTP ${res.status} ${detail}`.trim(), detail);
  }
  return parseResponse(await res.json());
}

export const ERROR_TEXT = {
  no_key: 'כדי לזהות מנות מתמונה צריך מפתח Claude API. אפשר להוסיף אותו בהגדרות, תחת "זיהוי מנות מתמונה".',
  auth: 'המפתח לא התקבל. בדקו בהגדרות שהוא הועתק במלואו.',
  rate_limit: 'יותר מדי בקשות כרגע. נסו שוב בעוד דקה.',
  overloaded: 'שירות הזיהוי עמוס כרגע. נסו שוב בעוד רגע.',
  too_large: 'התמונה גדולה מדי. נסו תמונה אחרת.',
  credit: 'אין יתרה בחשבון Anthropic של המפתח. אפשר להטעין ב-console.anthropic.com, תחת Billing.',
  bad_image: 'לא הצלחתי לפתוח את התמונה (ייתכן שהפורמט לא נתמך, למשל HEIC). צלמו מחדש או בחרו תמונת JPEG.',
  timeout: 'הזיהוי לקח יותר מדי זמן. נסו שוב.',
  network: 'אין חיבור לאינטרנט. זיהוי מתמונה עובד רק עם חיבור.',
  refusal: 'לא הצלחתי לזהות את התמונה הזו. נסו לצלם שוב, קרוב יותר למנה.',
  bad_output: 'התשובה מהזיהוי לא הייתה תקינה. נסו שוב.',
  api: 'השירות דחה את הבקשה. הפרטים מופיעים למטה; אם זה חוזר, שלחו אותם למפתחת.',
  empty: 'לא זוהה אוכל בתמונה. נסו לצלם שוב, קרוב יותר למנה.',
};

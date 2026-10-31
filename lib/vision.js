// Meal photo recognition with the Claude API, called straight from the phone with the user's own key.
// The key never leaves the device except in this request to api.anthropic.com (it is a local-only
// setting and is never synced). Pure helpers are exported for node tests; the request takes an
// injectable fetch.

export const VISION_MODEL = 'claude-opus-5-5';
const API_URL = 'https://api.anthropic.com/v1/messages';

const SYSTEM = `You identify food in a meal photo for an Israeli calorie-tracking app.
List every distinct food or drink you can see, as separate items (a plate of schnitzel with rice and salad is three items).
For each item:
- name: a short Hebrew name for the user, e.g. "שניצל עוף", "אורז לבן מבושל", "סלט ירקות".
- query: a short Hebrew search term the way the Israeli Ministry of Health food database (Tzameret) names the food, generic, without brands: the main food first, then how it was prepared, e.g. "שניצל חזה עוף מטוגן", "אורז לבן מבושל", "מלפפון".
- grams: your best estimate of the edible weight on the plate, in grams (drinks: ml as grams). Use plate, cutlery and hands for scale.
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
          grams: NUM,
          kcal_per_100g: NUM,
          protein_per_100g: NUM,
          carbs_per_100g: NUM,
          fat_per_100g: NUM,
        },
        required: ['name', 'query', 'grams', 'kcal_per_100g', 'protein_per_100g', 'carbs_per_100g', 'fat_per_100g'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

export class VisionError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function buildRequest(imageBase64, mediaType = 'image/jpeg') {
  return {
    model: VISION_MODEL,
    max_tokens: 8000,
    system: SYSTEM,
    // a food photo is a quick perception task: low effort keeps it fast and cheap
    output_config: { effort: 'low', format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
    // if a safety classifier declines, the API retries on its recommended model in the same call
    fallbacks: 'default',
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
    .map((it) => ({
      name: String(it.name || '').trim(),
      query: String(it.query || it.name || '').trim(),
      grams: Math.round(num(it.grams)),
      kcal: num(it.kcal_per_100g),
      p: num(it.protein_per_100g),
      c: num(it.carbs_per_100g),
      f: num(it.fat_per_100g),
    }))
    .filter((it) => it.name && it.grams > 0);
}

/**
 * Chooses the database food for one recognized item: the best-ranked search candidate whose
 * calories are close to Claude's estimate (so "cheese" does not land on cheese powder).
 * When no candidate is plausible, returns a food built from Claude's own per-100g estimate.
 */
export function pickFood(item, candidates, { makeId = () => 'a' + Date.now().toString(36) } = {}) {
  const close = (food) => {
    if (!item.kcal) return true;   // no estimate to compare against
    const diff = Math.abs(food.kcal - item.kcal);
    return diff <= 40 || diff / item.kcal <= 0.4;
  };
  const match = candidates.slice(0, 8).find(close);
  if (match) return { food: match, estimated: false };
  return {
    food: { id: makeId(), n: item.name, kcal: Math.round(item.kcal), p: item.p, c: item.c, f: item.f, m: [], src: 'ai' },
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
        'anthropic-beta': 'server-side-fallback-2026-07-01',
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
    const code = res.status === 401 || res.status === 403 ? 'auth'
      : res.status === 429 ? 'rate_limit'
        : res.status === 529 || res.status >= 500 ? 'overloaded'
          : res.status === 413 ? 'too_large' : 'api';
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch { /* not json */ }
    throw new VisionError(code, `HTTP ${res.status} ${detail}`.trim());
  }
  return parseResponse(await res.json());
}

export const ERROR_TEXT = {
  no_key: 'כדי לזהות מנות מתמונה צריך מפתח Claude API. אפשר להוסיף אותו בהגדרות, תחת "זיהוי מנות מתמונה".',
  auth: 'המפתח לא התקבל. בדקו בהגדרות שהוא הועתק במלואו.',
  rate_limit: 'יותר מדי בקשות כרגע. נסו שוב בעוד דקה.',
  overloaded: 'שירות הזיהוי עמוס כרגע. נסו שוב בעוד רגע.',
  too_large: 'התמונה גדולה מדי. נסו תמונה אחרת.',
  timeout: 'הזיהוי לקח יותר מדי זמן. נסו שוב.',
  network: 'אין חיבור לאינטרנט. זיהוי מתמונה עובד רק עם חיבור.',
  refusal: 'לא הצלחתי לזהות את התמונה הזו. נסו לצלם שוב, קרוב יותר למנה.',
  bad_output: 'התשובה מהזיהוי לא הייתה תקינה. נסו שוב.',
  api: 'הזיהוי נכשל. נסו שוב.',
  empty: 'לא זוהה אוכל בתמונה. נסו לצלם שוב, קרוב יותר למנה.',
};

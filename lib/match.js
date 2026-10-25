// Hebrew food search: normalizes text, expands common spelling variants and ranks matches.
// Pure functions, no DOM, so they run in the browser and in node tests alike.

const FINAL_LETTERS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };

// Spellings people type vs. spellings in Tzameret (both directions are searched).
const SYNONYMS = [
  ['לבנה', 'לאבנה'],
  ['קוטג', 'קוטג׳'],
  ['ציפס', 'צ׳יפס'],
  ['שוקו', 'משקה חלב בטעם שוקולד'],
  ['קפה', 'קפה שחור'],
  ['פסטה', 'מקרוני'],
  ['עוף', 'חזה עוף'],
  ['במבה', 'חטיף בוטנים במבה'],
];

export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[֑-ׇ]/g, '')            // niqqud and cantillation
    .replace(/['"`׳״]/g, '')                      // geresh / gershayim / quotes
    .replace(/[ךםןףץ]/g, (ch) => FINAL_LETTERS[ch])
    .replace(/[^\p{L}\p{N}%.]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function variants(query) {
  const q = normalize(query);
  const out = new Set([q]);
  for (const group of SYNONYMS) {
    const norm = group.map(normalize);
    for (const word of norm) {
      if (q === word || q.startsWith(word + ' ')) {
        for (const alt of norm) out.add(alt + q.slice(word.length));
      }
    }
  }
  return [...out];
}

// Precomputes normalized names once; call again only when the food list changes.
export function buildIndex(foods) {
  return foods.map((food) => {
    const key = normalize(food.n);
    return { food, key, words: key.split(' ') };
  });
}

function scoreOne(entry, q) {
  const { key, words } = entry;
  const qWords = q.split(' ');
  if (!qWords.every((w) => key.includes(w))) return 0;

  let score = 0;
  if (key === q) score += 1000;
  if (key.startsWith(q + ' ') || key.startsWith(q + '.')) score += 500;
  else if (key.startsWith(q)) score += 300;
  if (words[0] === qWords[0]) score += 200;
  // whole-word hits beat substring hits ("לבנה" the cheese vs. "שעועית לבנה")
  score += qWords.filter((w) => words.includes(w)).length * 100;
  const firstPos = key.indexOf(qWords[0]);
  score += Math.max(0, 60 - firstPos);
  score += Math.max(0, 40 - key.length / 2);   // shorter, more generic names first
  return score;
}

// Returns up to `limit` foods ranked by relevance. `extra` foods (the user's own) get a boost.
export function matchFood(query, index, { limit = 30, boostIds = new Set() } = {}) {
  const qs = variants(query).filter(Boolean);
  if (!qs.length) return [];
  const scored = [];
  for (const entry of index) {
    let best = 0;
    for (const q of qs) best = Math.max(best, scoreOne(entry, q));
    if (best > 0) {
      if (boostIds.has(entry.food.id)) best += 400;
      scored.push([best, entry.food]);
    }
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, limit).map((s) => s[1]);
}

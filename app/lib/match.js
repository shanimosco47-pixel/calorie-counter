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
  ['קפה הפוך', 'קפה מוכן קפוצינו'],
  ['הפוך', 'קפה מוכן קפוצינו'],
  ['קפוצינו', 'קפה מוכן קפוצינו'],
  ['אגוזים', 'אגוזי מלך'],
  ['פרוסת לחם', 'לחם'],
  ['ביצים מקושקשות', 'חביתה'],
  ['ביצה מקושקשת', 'חביתה'],
];

// Forms people rarely mean when typing a plain food name (dried egg, milk powder, frozen yolk...).
const RARE_FORMS = /(מיובש|מיובשת|מיובשים|אבקה|אבקת|קפוא|מפוסטר|לתינוקות)/;
// Uncooked grains and pasta: people log what they ate, so cooked versions come first.
const UNCOOKED = /(^|[ ,])(יבש|יבשה|יבשים)([ ,]|$)|לא מבושל/;

// Everyday staples: the version people usually mean when they type a plain name ("milk" is
// regular 3% milk, not camel milk). Tzameret has no popularity data, so this is curated.
// Boosted only when the query is exactly that plain name, so "בשר" or "סלט" stay generic.
export const STAPLES = {
  'ביצה': ['ביצה שלמה בלי קליפה'],
  'ביצה קשה': ['ביצה קשה שלמה, ללא קליפה, עם מלח'],
  'חלב': ['חלב 3% שומן, תנובה, טרה, הרדוף, יטבתה', 'חלב 1% שומן, תנובה, טרה, הרדוף, יטבתה'],
  'לחם': ['לחם אחיד, כהה, פרוס', "לחם לבן, ברמן, אנג'ל, דוידוביץ, אילת"],
  'אורז': ['אורז לבן, מבושל, ללא תוספת שומן בבישול', 'אורז מלא, מבושל,רגיל/אינסטנט,ללא תוספת שומן בבישול'],
  'עוף': ['בשר עוף, חזה, ללא עצם, לפנ לשיטת הבישול, נאכל ללא עור'],
  'חזה עוף': ['בשר עוף, חזה, ללא עצם, לפנ לשיטת הבישול, נאכל ללא עור'],
  'תפוח': ['תפוח עץ, עם קליפה (ללא ליבה)'],
  'בננה': ['בננה, טריה, בלי קליפה'],
  'עגבניה': ['עגבניה, טריה'],
  'מלפפון': ['מלפפון, טרי, עם קליפה'],
  'גזר': ['גזר, טרי, בלי קליפה וקצוות'],
  'אבוקדו': ['אבוקדו'],
  'שמן זית': ['שמן זית'],
  'סוכר': ['סוכר, לבן, רגיל או קוביות'],
  'קפה': ['קפה, מוכן מקפה טחון, רגיל, כולל קפה פילטר'],
  'גבינה לבנה': ['גבינה לבנה 5% שומן, תנובה'],
  'יוגורט': ['יוגורט ביו 3% שומן, תנובה'],
  'גבינה צהובה': ['גבינה צהובה 28% שומן, עמק, כולל אצבעות, תנובה'],
  'תפוחי אדמה': ['תפוחי אדמה, מבושלים, ללא קליפה, עם מלח, ללא תוספת שומן'],
  'תפוח אדמה': ['תפוחי אדמה, מבושלים, ללא קליפה, עם מלח, ללא תוספת שומן'],
  'טונה': ['דג טונה, מבושל במים או מאודה, עם מלח'],
  'חומוס': ['סלט חומוס, ביתי'],
  'קוסקוס': ['קוסקוס ביתי עם שמן סויה'],
  'אגוזים': ['אגוזי מלך, בלי קליפה, לא קלויים, ללא מלח'],
  'אגוזי מלך': ['אגוזי מלך, בלי קליפה, לא קלויים, ללא מלח'],
  'ענבים': ['ענבים, לפנ לסוג, טרי'],
};
const STAPLE_BY_QUERY = new Map();   // normalized query -> set of staple names (filled lazily)
function staplesFor(q) {
  if (!STAPLE_BY_QUERY.size) for (const [k, v] of Object.entries(STAPLES)) STAPLE_BY_QUERY.set(normalize(k), new Set(v));
  return STAPLE_BY_QUERY.get(q);
}

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

function scoreOne(entry, q, staples) {
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
  if (RARE_FORMS.test(entry.food.n) && !RARE_FORMS.test(q)) score -= 250;
  if (staples && staples.has(entry.food.n)) score += 1000;   // the query is exactly this staple's plain name
  if (UNCOOKED.test(entry.food.n) && !/(יבש|לא מבושל)/.test(q)) score -= 120;
  return Math.max(score, 1);
}

// Returns up to `limit` foods ranked by relevance. `extra` foods (the user's own) get a boost.
export function matchFood(query, index, { limit = 30, boostIds = new Set() } = {}) {
  const qs = variants(query).filter(Boolean);
  if (!qs.length) return [];
  const staples = staplesFor(normalize(query));
  const scored = [];
  for (const entry of index) {
    let best = 0;
    for (const q of qs) best = Math.max(best, scoreOne(entry, q, staples));
    if (best > 0) {
      if (boostIds.has(entry.food.id)) best += 400;
      scored.push([best, entry.food]);
    }
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, limit).map((s) => s[1]);
}

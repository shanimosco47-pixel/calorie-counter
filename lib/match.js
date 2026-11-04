// Hebrew food search: normalizes text, expands common spelling variants and ranks matches.
// Pure functions, no DOM, so they run in the browser and in node tests alike.

const FINAL_LETTERS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };

// Spellings people type vs. spellings in Tzameret (both directions are searched).
const SYNONYMS = [
  ['לבנה', 'לאבנה'],
  ['קפה', 'קפה שחור'],
  ['פסטה', 'אטריות/פסטה'],
  ['קפה עם חלב', 'קפה מוכן קפוצינו'],
  ['לאטה', 'קפה מוכן קפוצינו'],
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
  'ביצים': ['ביצה שלמה בלי קליפה'],
  'פסטה': ['אטריות/פסטה, חיטה, מבושלות, עם מלח, ללא תוספת שמן בבישול'],
  'צ׳יפס': ["תפוחי אדמה, מטוגנים, צ'יפס בשמן סויה", "תפוחי אדמה, מטוגנים, צ'יפס בשמן קנולה"],
  'יין': ['משקה אלכוהולי, יין, כל הסוגים', 'משקה אלכוהולי, יין אדום, כל הסוגים', 'משקה אלכוהולי, יין לבן, כל הסוגים'],
  'שניצל': ['שניצל חזה עוף מטוגן בשמן סויה', 'שניצל חזה עוף מטוגן בשמן קנולה'],
  'שניצל עוף': ['שניצל חזה עוף מטוגן בשמן סויה', 'שניצל חזה עוף מטוגן בשמן קנולה'],
  'לחמניה': ['לחמניה קלה, ודש, דגנית עין בר'],
  'הודו': ['בשר הודו, חזה, לבן, מבושל'],
  'שוקו': ['משקה חלב, שוקו 2% שומן, תנובה'],
};
// Manufacturers and chains in Tzameret's names (the part after the last comma). Used for "homemade":
// a factory product is never homemade. Plain queries rank brands as before (a brand is often what
// people mean: cottage cheese, butter, cornflakes).
export const BRANDS = new Set([
  'אסם', 'תנובה', 'שטראוס', 'עלית', 'גד', 'תלמה', 'מקדונלדס', 'קנור', 'עוף טוב', 'מטרנה', "אנג'ל", 'נסטלה',
  'טרה', 'טבעול', 'סנפרוסט', 'פלדמן', 'פילסברי', 'מאמא עוף', 'צבר', 'פריגת', 'צוריאל', 'מיקי', 'שמיר', 'tusso',
  'טיבון ויל', 'יטבתה', 'b&d', 'יחיעם', 'זוגלובק', 'אלפרו', 'כרמית', 'מגאפארם', 'מגהפארם', 'טירת צבי', 'יונה',
  'ספרינג', 'אבוט', 'דוידוביץ', 'איזיליין', 'פריניב', 'מולר', 'שומרון', 'הגביע', 'תופינית', 'פיראוס', 'המחלבה',
  'עוף העמק', 'מן', 'חברת ירושלים לשומשום', 'ברמן', 'ורד הגליל', 'הדסה', "בן & ג'ריס", 'פרמהבסט', 'כפיר',
  'מעדני מזרע', 'גת', 'אילת', 'דגנית עין בר', 'לחם הארץ', 'בייגל בייגל', 'הלמנס', 'סטארקיסט', 'סימילאק',
  'מימונס', 'הרדוף', 'השף הלבן', 'שופרסל', 'שקדיה', "בונז'ור", 'תפוגן', 'אוליביה', 'בית השיטה', 'בני דרום',
  'ודש', 'אדום אדום', 'דלידג', 'אילתית', 'עמק', "סוי ג'וי", 'שלושת האופים',
]);
const BRAND_KEYS = new Set();   // normalized brand names (filled lazily)

// The brand of a database food, normalized ('' for a generic food).
export function brandOf(name) {
  if (!BRAND_KEYS.size) for (const b of BRANDS) BRAND_KEYS.add(normalize(b));
  const parts = String(name || '').split(',');
  if (parts.length < 2) return '';
  for (const part of parts[parts.length - 1].split('/')) {
    const b = normalize(part);
    if (BRAND_KEYS.has(b)) return b;
  }
  return '';
}

// "homemade" in a query: not a factory product. The word itself need not appear in the food's name
// ("שניצל ביתי" is a fried schnitzel), and a branded product never counts as homemade even when its
// name says so ("בציפוי ביתי, מאמא עוף").
const HOMEMADE = /(^| )(ביתי|ביתית|ביתימ|ביתיות|תוצרת בית|של אמא|כמו בבית|בהכנה ביתית)(?= |$)/g;
export function splitHomemade(q) {
  const plain = q.replace(HOMEMADE, ' ').replace(/\s+/g, ' ').trim();
  return { plain, homemade: plain !== q };
}

// A non-branded homemade version of the food: "ביתי" in its name, every word of the query, and the
// food itself among the first two words ("סלט חומוס, ביתי" for חומוס, not a soup with rice for אורז).
function homeVersionOf(entry, q) {
  if (!/ביתי/.test(entry.key) || entry.brand) return false;
  const qWords = q.split(' ');
  return qWords.every((w) => entry.key.includes(w)) && entry.words.slice(0, 2).some((w) => w.startsWith(qWords[0]));
}

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
    .replace(/יי/g, 'י').replace(/וו/g, 'ו')      // spelled with or without doubled letters: עגבנייה = עגבניה
    .replace(/[^\p{L}\p{N}%.]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// Singular and plural are written differently (ביצה/ביצים, פיתה/פיתות, קשה/קשות): each word also
// tries the other form. Matching is by substring, so a stem ("ביצ") finds both.
function wordForms(w) {
  const forms = new Set([w]);
  if (w.length >= 4) {
    if (w.endsWith('ות')) forms.add(w.slice(0, -2) + 'ה');
    if (w.endsWith('ימ') && w.length >= 5) forms.add(w.slice(0, -2));
    if (w.endsWith('ה')) forms.add(w.slice(0, -1) + 'ות');
  }
  return [...forms].filter((f) => f.length >= 3);
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

// Singular/plural forms of the query, word by word (at most 8). Used only when what was typed finds
// (almost) nothing, and they count a little less, so "פירה" stays mashed potato, not "פירות".
function formVariants(q) {
  // only the first 4 words get forms; the rest stay as typed, so qualifiers like "9%" stay required
  const words = q.split(' ');
  const rest = words.slice(4).join(' ');
  let combos = [''];
  for (const w of words.slice(0, 4)) {
    combos = combos.flatMap((c) => wordForms(w).map((f) => (c ? `${c} ${f}` : f))).slice(0, 8);
  }
  return combos.map((c) => (rest ? `${c} ${rest}` : c)).filter((c) => c !== q);
}

// Precomputes normalized names once; call again only when the food list changes.
export function buildIndex(foods) {
  return foods.map((food) => {
    const key = normalize(food.n);
    return { food, key, words: key.split(' '), brand: brandOf(food.n) };
  });
}

function scoreOne(entry, q, staples, homemade = false) {
  const { key, words } = entry;
  if (homemade && entry.brand) return 0;
  const qWords = q.split(' ');
  // a staple is what the plain query means even when spelled differently ("ביצים" -> "ביצה שלמה")
  if (staples && staples.has(entry.food.n)) return 2000 - [...staples].indexOf(entry.food.n);   // listed order
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
  if (UNCOOKED.test(entry.food.n) && !/(יבש|לא מבושל)/.test(q)) score -= 120;
  if (homemade && homeVersionOf(entry, q)) score += 1000;   // asked for homemade: its homemade versions first
  return Math.max(score, 1);
}

// Returns up to `limit` foods ranked by relevance. `extra` foods (the user's own) get a boost.
export function matchFood(query, index, { limit = 30, boostIds = new Set() } = {}) {
  const { plain, homemade } = splitHomemade(normalize(query));
  // "ביתי" alone is not a food: search it as typed
  const base = plain || normalize(query);
  const home = homemade && !!plain;
  const qs = variants(base).filter(Boolean);
  if (!qs.length) return [];
  // "לחם ביתי" means homemade bread, not the everyday sliced loaf the plain "לחם" stands for: when the
  // database has a non-branded homemade version, the staple steps aside
  const homeVersion = home && index.some((e) => homeVersionOf(e, base));
  const staples = homeVersion ? null : staplesFor(base);
  const typedHits = index.reduce((n, entry) => n + (qs.some((q) => scoreOne(entry, q, staples, home) > 0) ? 1 : 0), 0);
  const forms = typedHits < 5 ? [...new Set(qs.flatMap(formVariants))].filter((f) => !qs.includes(f)) : [];
  const scored = [];
  for (const entry of index) {
    let best = 0;
    for (const q of qs) best = Math.max(best, scoreOne(entry, q, staples, home));
    for (const q of forms) { const s = scoreOne(entry, q, staples, home); if (s > 0) best = Math.max(best, s - 150); }
    if (best > 0) {
      if (boostIds.has(entry.food.id)) best += 1200;   // the user's own foods and favourites beat staples too
      scored.push([best, entry.food]);
    }
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, limit).map((s) => s[1]);
}

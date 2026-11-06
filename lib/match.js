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
// tested on normalized text (the food's key and the query), so final letters are regular and quotes gone
// Each form on its own: asking for one ("תמל") does not lift the others ("אבקה").
const RARE_PARTS = [/מיובש/, /אבקה|אבקת/, /קפוא/, /מפוסטר/, /תינוק/, /(^| )תמל( |$)/, /חלב אמ( |$)/];
// Uncooked grains and pasta: people log what they ate, so cooked versions come first.
const COOKED = /(^| )(מבושל\S*|מוכנ\S*|אפוי\S*|מטוגנ\S*)/;
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
  'אורז לבן': ['אורז לבן, מבושל, ללא תוספת שומן בבישול'],
  'אורז לבן מבושל': ['אורז לבן, מבושל, ללא תוספת שומן בבישול'],
  'אורז מבושל': ['אורז לבן, מבושל, ללא תוספת שומן בבישול'],
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
  'חמאה': ['חמאה, תנובה, טרה'],
  'קולה': ['משקה קל, קולה, כולל פפסי קולה, RC קולה, קוקה קולה'],
  'קוקה קולה': ['משקה קל, קולה, כולל פפסי קולה, RC קולה, קוקה קולה'],
  'פפסי': ['משקה קל, קולה, כולל פפסי קולה, RC קולה, קוקה קולה'],
  'קולה זירו': ['משקה קל, קולה, ללא סוכר, דיאט'],
  'קולה דיאט': ['משקה קל, קולה, ללא סוכר, דיאט'],
  'דיאט קולה': ['משקה קל, קולה, ללא סוכר, דיאט'],
  'נקניקיות': ['נקניקיות עוף, יחיעם'],
  'נקניקיה': ['נקניקיות עוף, יחיעם'],
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
  'אורנים', 'דגש', 'ד"ר מרק', 'טבע דלי', 'פיצוחית', 'השומרון', 'לחמי', 'טמרה', 'בלאדי', 'שף הים',
]);
const BRAND_KEYS = new Set();   // normalized brand names (filled lazily)
// brands that also appear followed by a description of the product ("B&D מועשרת"); only names that
// are not food words themselves ("שמיר" is dill, "מן הצומח" is plant-based)
const PREFIX_BRANDS = ['B&D', 'ברמן', 'פיראוס', 'נסטלה'].map(normalize);

// The brand of a database food, normalized ('' for a generic food).
export function brandOf(name) {
  if (!BRAND_KEYS.size) for (const b of BRANDS) BRAND_KEYS.add(normalize(b));
  const parts = String(name || '').split(',');
  if (parts.length < 2) return '';
  const slashParts = parts[parts.length - 1].split('/');
  for (const part of slashParts) if (BRAND_KEYS.has(normalize(part))) return normalize(part);
  for (const part of slashParts) {
    const b = normalize(part);
    // the brand followed by a description of the product ("B&D מועשרת")
    for (const key of PREFIX_BRANDS) if (b.startsWith(key + ' ')) return key;
    // an imported product's maker, written in Latin capitals ("KELLOGGS", "NATURAL BAKERY")
    if (/^[A-Z][A-Z0-9 &.'-]+$/.test(part.trim())) return b;
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

const STAPLE_NAMES = new Set(Object.values(STAPLES).flat());
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
        // never drop a word that was typed: "חזה עוף בגריל" must not become "עוף בגריל"
        const typed = word.split(' ');
        for (const alt of norm) {
          const altWords = alt.split(' ');
          if (altWords.length < typed.length && altWords.every((w) => typed.includes(w))) continue;
          out.add(alt + q.slice(word.length));
        }
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
// the database foods stay the same objects between rebuilds (only the user's own foods change), so
// each one is prepared once
const ENTRIES = new WeakMap();
export function buildIndex(foods) {
  return foods.map((food) => {
    const cached = ENTRIES.get(food);
    if (cached && cached.n === food.n) return cached.entry;
    const entry = indexEntry(food);
    ENTRIES.set(food, { n: food.n, entry });
    return entry;
  });
}
function indexEntry(food) {
  const key = normalize(food.n);
  const pct = [...key.matchAll(/(\d+(?:\.\d+)?) ?% ?שומנ/g)].map((m) => Number(m[1]));
  return { food, key, words: key.split(' '), brand: brandOf(food.n), fatPct: pct.length ? Math.min(...pct) : null, ...splitWords(splitNegated(food.n)) };
}

// "ללא שמן" / "בלי סוכר": what the food is without. In a query, those words are not searched for;
// a food that has them ("אורז מבושל עם שמן סויה") is left out, and one that says it is without them
// ("אורז לבן, מבושל, ללא תוספת שומן") ranks higher. Oil, fat, butter and margarine count as one.
// Words are compared whole (with a one-letter prefix: בשמנ, ושמנ), so "עור" is not "מעורב".
const FATS = ['שמנ', 'שומנ', 'חמאה', 'מרגרינה'];
const OIL_TYPES = new Set(['זית', 'קנולה', 'סויה', 'תירס', 'חמניות', 'צמחי']);
const expandNeg = (w) => (FATS.includes(w) ? FATS : [w]);
// what people say a food is without; only these continue a "ללא" list with ו ("ללא סוכר וניל" is vanilla)
const NEGATABLE = new Set([...FATS, 'שמנת', 'סוכר', 'מלח', 'חלב', 'גלוטנ', 'לקטוז', 'ביצה', 'ביצימ', 'בשר', 'עור', 'קליפה',
  'רוטב', 'מיונז', 'גבינה', 'קפאינ', 'שומשומ', 'אגוזימ', 'בוטנימ', 'בצק', 'לחמ', 'פירורי']);
const NEG_WORD = /(^| )(ללא|בלי)( |$)/;

// text: a string, or its words already split (the index keeps them split)
function hasWord(text, w) {
  return (Array.isArray(text) ? text : text.split(' ')).some((x) => x === w || (x.length === w.length + 1 && 'בוהמלש'.includes(x[0]) && x.slice(1) === w));
}

// A food's name, split into what it has (pos) and what it is without (neg). "X% שומן", "דל שומן" and
// "מופחת שומן" describe how much fat, not added fat: they are not in pos, and "0% שומן" counts as without.
export function splitNegated(name) {
  const pos = [];
  const neg = [];
  for (const seg of String(name || '').split(',')) {
    let n = normalize(seg)
      .replace(/(\d+(?:\.\d+)?) ?% ?שומנ/g, (m, num) => { if (Number(num) === 0) neg.push('ללא שומנ'); return ' '; })
      .replace(/(דל|דלת|מופחת|מופחתת|דלי) שומנ/g, ' ')
      // "דל לקטוז", "נטול קפאין": low in or free of it, so it fits "ללא לקטוז" and is not a food that has it
      .replace(/(^| )(דל|דלת|דלי|מופחת|מופחתת|נטול|נטולת) ([^ ]+)/g, (m, a, b, w) => { neg.push(`ללא ${w}`); return ' '; });
    const at = n.search(NEG_WORD);
    if (at < 0) { pos.push(n); continue; }
    // the without-part ends at the next "עם": "ללא בשר עם שמן קנולה" has oil
    let rest = n.slice(at);
    const back = rest.search(/ עמ /);
    if (back >= 0) { pos.push(rest.slice(back)); rest = rest.slice(0, back); }
    pos.push(n.slice(0, at));
    neg.push(rest);
  }
  return { pos: pos.join(' ').replace(/\s+/g, ' ').trim(), neg: neg.join(' ') };
}

// "אורז בלי שמן זית" -> plain "אורז", without the fats; "בלי חלב ושמנת" -> without חלב and שמנת.
export function queryNegations(q) {
  const words = q.split(' ');
  const keep = [];
  const terms = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i] !== 'ללא' && words[i] !== 'בלי') { keep.push(words[i]); continue; }
    let j = i + 1;
    if (words[j] === 'תוספת') j++;
    if (!words[j]) break;
    const take = (w) => {
      terms.push(...expandNeg(w));
      if (FATS.includes(w) && OIL_TYPES.has(words[j + 1])) j++;   // "שמן זית" is one thing
    };
    take(words[j]);
    while (words[j + 1]?.startsWith('ו') && NEGATABLE.has(words[j + 1].slice(1))) { j++; take(words[j].slice(1)); }
    i = j;
  }
  return { plain: keep.join(' ').trim(), without: [...new Set(terms)] };
}

// For the chat and photos: Claude names generic foods. How well a database food fits what was said:
// 0 a generic food (or the staple the plain name means), 1 generic but "eaten with the skin" or plant-
// based when that was not said, 2 a branded product whose brand was not said, 3 never (baby food).
export function foodPreference(food, said) {
  const text = normalize(said);
  if (STAPLE_NAMES.has(food.n)) return 0;
  // baby food and formula are never what an adult's "דייסה" means
  if (/תינוק|מטרנה|סימילאק|נוטרילונ|אנפמיל|נוטרמיגנ|פרגסטימיל|שלב \d|(^| )תמל( |$)/.test(normalize(food.n)) && !/תינוק/.test(text)) return 3;
  const brand = brandOf(food.n);
  if (brand) return ` ${text} `.includes(` ${brand} `) ? 0 : 2;
  const name = normalize(food.n);
  if (/נאכל עמ עור/.test(name) && !hasWord(text, 'עור')) return 1;
  // a plant-based version ("המבורגר מן הצומח") only when said
  const PLANT = /מנ הצומח|צמחי|טבעוני|טבעונית/;
  if (PLANT.test(name) && !PLANT.test(text)) return 1;
  return 0;
}

const splitWords = ({ pos, neg }) => ({ pos: pos.split(' '), neg: neg.split(' ') });

// ctx: { staples, home (asked for homemade), without (words the food must not have) }
function scoreOne(entry, q, ctx = {}) {
  const { key, words } = entry;
  const { staples, home: homemade, without = [], dry } = ctx;
  if (homemade && entry.brand) return 0;
  if (without.some((w) => hasWord(entry.pos, w))) return 0;
  const qWords = q.split(' ');
  // a staple is what the plain query means even when spelled differently ("ביצים" -> "ביצה שלמה")
  // with "ללא ..." the staple is only a hint: "לחם ללא גלוטן" is not the everyday loaf
  const staple = staples && staples.has(entry.food.n);
  if (staple && !without.length) return 2000 - [...staples].indexOf(entry.food.n);   // listed order
  // a staple spelled differently from the query ("ביצים" -> "ביצה שלמה") still counts, just not first
  if (staple && !qWords.every((w) => key.includes(w))) return 1150 - [...staples].indexOf(entry.food.n);
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
  if (RARE_PARTS.some((r) => r.test(key) && !r.test(q))) score -= 250;
  // a cooked food is cooked even when its name also says "יבש" ("פול יבש, מבושל")
  if (dry) score += COOKED.test(key.replace(/לא מבושל\S*/g, '')) ? -200 : UNCOOKED.test(entry.food.n) ? 300 : 0;
  else if (UNCOOKED.test(entry.food.n) && !/(יבש|לא מבושל)/.test(q)) score -= 120;
  // chicken or turkey "eaten with the skin" only when the skin was mentioned
  if (/נאכל עמ עור/.test(key) && !hasWord(q, 'עור')) score -= 100;
  // (asked for dry: being uncooked matters more than saying "without oil")
  if (without.some((w) => hasWord(entry.neg, w))) score += dry ? 100 : 400;
  // "ללא שומן" among foods sold by fat percentage: the leanest first (1% milk before 3%)
  else if (entry.fatPct !== null && without.includes('שומנ')) score += Math.max(0, 200 - entry.fatPct * 50);
  if (staple) score += 150;
  if (homemade && homeVersionOf(entry, q)) score += 1000;   // asked for homemade: its homemade versions first
  return Math.max(score, 1);
}

// Returns up to `limit` foods ranked by relevance. `extra` foods (the user's own) get a boost.
// "משימורים", "שימורים", "מקופסה": the database writes canned food as "משומר"
const CANNED = /(^| )(משימורימ|שימורימ|מהשימורימ|מקופסה|מהקופסה|מקופסת שימורימ|בקופסה|מקופסא|מהקופסא)(?= |$)/g;

export function matchFood(query, index, { limit = 30, boostIds = new Set(), asTyped = false } = {}) {
  query = normalize(query);
  if (!asTyped) {
    const canned = query.replace(CANNED, ' משומר').replace(/\s+/g, ' ').trim();
    // a food named with the word itself ("חמין שימורים") first, then the database's canned foods
    if (canned !== query) {
      // (only a name with the word itself, whole: "משימורי טונה" inside a tuna salad is not it)
      const typedHits = matchFood(query, index, { limit, boostIds, asTyped: true });
      const own = typedHits.filter((f) => normalize(f.n).replace(CANNED, ' משומר') !== normalize(f.n));
      const seen = new Set(own.map((f) => f.id));
      const rest = [...matchFood(canned, index, { limit, boostIds, asTyped: true }), ...typedHits].filter((f) => !seen.has(f.id) && seen.add(f.id));
      return [...own, ...rest].slice(0, limit);
    }
  }
  const { plain: positive, without } = queryNegations(query);
  // "שיבולת שועל יבשה" / "לא מבושלת": the dry food, before cooking ("לא מבושל" in the database)
  // ("פירות יבשים", "יין יבש" are dried fruit and dry wine: those search as "מיובש", or without the word)
  // "ביתי" first, so it does not hide the dry request ("שיבולת שועל יבשה ביתי")
  const home0 = splitHomemade(positive || normalize(query));
  const typed = home0.plain || positive || normalize(query);
  // what the person said beyond the dried food itself, for the searches below
  const extra = without.map((w) => ` ללא ${w}`).join('') + (home0.homemade && home0.plain ? ' ביתי' : '');
  const UNCOOKED_Q = /(^| )(לא מבושל|לא מבושלת|לא מבושלימ|לא מבושלות|לפני בישול)(?= |$)/g;
  const DRIED_Q = /(^| )(יבש|יבשה|יבשימ|יבשות)(?= |$)/g;
  let dry = false;
  let dryQ = typed.replace(UNCOOKED_Q, ' ').replace(/\s+/g, ' ').trim();
  if (dryQ && dryQ !== typed) dry = true;
  const noDried = dryQ.replace(DRIED_Q, ' ').replace(/\s+/g, ' ').trim();
  // a food whose name has the word itself ("חומוס יבש", "עוגיות יבשות", "אצות, יבשות") is what was meant
  // (whole words, the food first: "אטריות אורז, יבשות" is not "אורז יבש")
  const [firstWord, ...otherWords] = dryQ.split(' ');
  const literal = noDried !== dryQ && index.some((e) => e.words[0].startsWith(firstWord)
    && otherWords.every((w) => e.words.some((x) => x.startsWith(w))));
  if (noDried && noDried !== dryQ && !literal) {
    const words = noDried.split(' ');
    // "יבש" means uncooked only for a food the database has uncooked (oats, pasta, rice)
    // (whole words: "יין לבן" is not "כוסמין ... לבן")
    // (not meat or fish: "בשר יבש" is not raw meat)
    // (only foods that are not cooked: "שעועית לבנה, יבשה, מבושלת" says nothing about tomatoes)
    const sameWord = (x, w) => x === w || wordForms(w).includes(x) || wordForms(x).includes(w);
    if (index.some((e) => UNCOOKED.test(e.food.n) && !COOKED.test(e.key.replace(/לא מבושל\S*/g, ''))
      && !/(^| )(בשר|דג|עופ|הודו)( |$)|מיובש/.test(e.key)   // nor dried fruit ("שזיף, מיובש, לא מבושל")
      && words.every((w) => e.words.some((x) => sameWord(x, w))))) { dry = true; dryQ = noDried; }
    else {
      // otherwise "יבש" is dried: the food's dried versions first, then the rest as usual
      // (singular too: "שזיפים יבשים" is "שזיף, מיובש")
      const [head, ...rest] = noDried.split(' ');
      const seen = new Set();
      const dried = wordForms(head).flatMap((w) => matchFood([w, ...rest, 'מיובש'].join(' ') + extra, index, { limit: Math.max(limit, 30), boostIds }))
        .filter((f) => /מיובש/.test(f.n) && !seen.has(f.id) && seen.add(f.id))
        // the food itself first ("שזיף, מיובש", not a yogurt with dried plum), and the plain dried food
        // before the ones cooked from it ("... מבושל, עם סוכר")
        .map((f, i) => {
          const n = normalize(f.n);
          const own = wordForms(head).some((w) => n.split(' ')[0].startsWith(w)) ? 0 : 1;
          return [own, COOKED.test(n.replace(/לא מבושל\S*/g, '')) ? 1 : 0, i, f];
        })
        .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]).map((x) => x[3]);
      const all = matchFood(noDried + extra, index, { limit, boostIds }).filter((f) => !seen.has(f.id));
      return [...dried, ...all].slice(0, limit);
    }
  }
  const plain = dryQ || typed;
  // ("ביתי" alone is not a homemade request: it is searched as typed, as before)
  const homemade = home0.homemade && !!home0.plain;
  // "ביתי" alone is not a food: search it as typed
  const base = plain || normalize(query);
  const home = homemade && !!plain;
  const qs = variants(base).filter(Boolean);
  if (!qs.length) return [];
  // "לחם ביתי" means homemade bread, not the everyday sliced loaf the plain "לחם" stands for: when the
  // database has a non-branded homemade version, the staple steps aside
  const homeVersion = home && index.some((e) => homeVersionOf(e, base));
  const staples = homeVersion ? null : staplesFor(base);
  const ctx = { staples: dry ? null : staples, home, without, dry };
  const typedHits = index.reduce((n, entry) => n + (qs.some((q) => scoreOne(entry, q, ctx) > 0) ? 1 : 0), 0);
  const forms = typedHits < 5 ? [...new Set(qs.flatMap(formVariants))].filter((f) => !qs.includes(f)) : [];
  const scored = [];
  for (const entry of index) {
    let best = 0;
    for (const q of qs) best = Math.max(best, scoreOne(entry, q, ctx));
    for (const q of forms) { const s = scoreOne(entry, q, ctx); if (s > 0) best = Math.max(best, s - 150); }
    if (best > 0) {
      if (boostIds.has(entry.food.id)) best += 1200;   // the user's own foods and favourites beat staples too
      scored.push([best, entry.food]);
    }
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, limit).map((s) => s[1]);
}

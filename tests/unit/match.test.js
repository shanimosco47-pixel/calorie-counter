import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalize, buildIndex, matchFood, STAPLES, brandOf, foodPreference, queryNegations, splitNegated } from '../../lib/match.js';

const data = JSON.parse(readFileSync(new URL('../../data/tzameret.json', import.meta.url)));
const index = buildIndex(data.foods);

test('dataset size and shape', () => {
  assert.ok(data.foods.length >= 4000, `only ${data.foods.length} foods`);
  const withMeasures = data.foods.filter((f) => f.m.length > 0).length;
  assert.ok(withMeasures >= 1000, `only ${withMeasures} with household measures`);
  for (const f of data.foods) {
    assert.ok(/[֐-׿]/.test(f.n), `no Hebrew name: ${f.id}`);
    for (const k of ['kcal', 'p', 'c', 'f']) assert.equal(typeof f[k], 'number', `${f.id}.${k}`);
    for (const [code, grams, label] of f.m) assert.ok((data.units[code] || label) && grams > 0, `${f.id} unit ${code}`);
  }
});

test('normalize strips geresh, niqqud and final letters', () => {
  assert.equal(normalize("קוטג'"), 'קוטג');
  assert.equal(normalize('קוטג׳'), 'קוטג');
  assert.equal(normalize('לֶחֶם'), 'לחמ');
  assert.equal(normalize('  פיתה,   קלויה '), 'פיתה קלויה');
});

// query -> what a relevant result must look like
const CASES = {
  'חומוס': /^(סלט )?חומוס/,
  'פיתה': /^פיתה/,
  'שניצל': /^שניצל/,
  'שקשוקה': /^שקשוקה/,
  'במבה': /במבה/,
  "קוטג'": /קוטג/,
  'פלאפל': /פלאפל/,
  'טחינה': /^(סלט )?טחינה/,
  'לבנה': /^לאבנה|^לבנה/,
  'בורקס': /^בורקס/,
  'ביצה': /^ביצה (שלמה|קשה|רכה)/,
  'חביתה': /חביתה/,
};

for (const [q, re] of Object.entries(CASES)) {
  test(`search "${q}" has a relevant top-3 result in <300ms`, () => {
    const t0 = performance.now();
    const top = matchFood(q, index, { limit: 3 });
    const ms = performance.now() - t0;
    assert.ok(ms < 300, `${ms}ms`);
    assert.ok(top.some((f) => re.test(f.n)), `top3: ${top.map((f) => f.n).join(' | ')}`);
  });
}

test('egg dishes have an egg unit; breads and soups do not', () => {
  const egg = (name) => data.foods.find((f) => f.n === name).m.find((m) => m[0] === 'egg');
  assert.deepEqual(egg('ביצה או חביתה מטוגנת בשמן זית'), ['egg', 46, 'ביצה']);
  // frying in oil cannot make the dish lighter per egg than frying without oil
  assert.ok(egg('ביצה או חביתה מטוגנת בשמן זית')[1] > egg('ביצה או חביתה מטוגנת ללא שמן')[1]);
  assert.equal(egg('שקשוקה בשמן זית')[2], 'ביצה (עם הרוטב)');
  assert.equal(data.foods.filter((f) => /^(לחם|חלה|מרק|מוס)/.test(f.n) && f.m.some((m) => m[0] === 'egg')).length, 0);
});

test('plain names find the everyday staple first', () => {
  const first = (q) => matchFood(q, index, { limit: 1 })[0].n;
  assert.equal(first('ביצה'), 'ביצה שלמה בלי קליפה');
  assert.match(first('חלב'), /^חלב (3|1)% שומן, תנובה/);
  assert.equal(first('עגבניה'), 'עגבניה, טריה');
  assert.equal(first('בננה'), 'בננה, טריה, בלי קליפה');
  assert.match(first('אורז'), /^אורז (לבן|מלא), מבושל/);
  assert.match(first('עוף'), /חזה/);
  assert.equal(first('חומוס'), 'סלט חומוס, ביתי');
  assert.match(first('קוסקוס'), /^קוסקוס ביתי/);
  assert.match(first('קוסקוס יבש'), /יבש/);
  assert.match(first('קפה הפוך'), /קפוצ'ינו/);
});

test('every staple exists in the data', () => {
  const all = new Set(data.foods.map((f) => f.n));
  for (const names of Object.values(STAPLES)) for (const n of names) assert.ok(all.has(n), `missing staple: ${n}`);
});

test('staples do not take over generic queries', () => {
  const first = (q) => matchFood(q, index, { limit: 1 })[0].n;
  assert.doesNotMatch(first('בשר'), /^בשר עוף, חזה/);
  assert.doesNotMatch(first('סלט'), /^סלט חומוס, ביתי/);
});

test('rare forms (dried, powder) only when asked for', () => {
  assert.ok(!/מיובש/.test(matchFood('ביצה', index, { limit: 3 }).map((f) => f.n).join()));
  assert.match(matchFood('ביצה מיובשת', index, { limit: 1 })[0].n, /מיובשת/);
});

test('boostIds puts the user\'s foods first', () => {
  const mine = { id: 'u1', n: 'שניצל של אמא', kcal: 250, p: 20, c: 10, f: 14, m: [] };
  const idx = buildIndex([mine, ...data.foods]);
  assert.equal(matchFood('שניצל', idx, { boostIds: new Set(['u1']) })[0].id, 'u1');
});

test('empty and unknown queries', () => {
  assert.deepEqual(matchFood('', index), []);
  assert.deepEqual(matchFood('   ', index), []);
  assert.deepEqual(matchFood('קסדכגכשד', index), []);
});

test('audit: common spellings and plurals find the right food', () => {
  const top = (q) => matchFood(q, index, { limit: 1 })[0]?.n || '';
  assert.match(top('עגבנייה'), /^עגבניה/);
  assert.match(top('נקניקייה'), /^נקניקיות/);
  assert.match(top('ביצים קשות'), /^ביצה קשה/);
  assert.match(top('פיתות'), /^פיתה/);
  assert.match(top('לחמנייה'), /^לחמניה/);
  assert.match(top('ביצים'), /^ביצה שלמה/);
  assert.match(top('צ׳יפס'), /^תפוחי אדמה, מטוגנים/);
  assert.match(top('פסטה'), /^אטריות\/פסטה, חיטה, מבושלות/);
  assert.match(top('יין'), /^משקה אלכוהולי, יין/);
  assert.match(top('קפה עם חלב'), /קפוצ'ינו/);
  assert.match(top('הודו'), /^בשר הודו/);
});

test('audit 2: plural forms never beat what was typed', () => {
  const top = (q) => matchFood(q, index, { limit: 1 })[0]?.n || '';
  assert.match(top('פירה'), /פירה/);
  assert.match(top('לחמנייה'), /^לחמניה קלה/);
});

test('long queries keep their trailing qualifiers (Codex P2)', () => {
  const top = matchFood('גבינה לבנה עם זיתים 9%', index, { limit: 10 });
  assert.ok(top.length === 0 || top.every((f) => /9%/.test(f.n)), top.map((f) => f.n).join(' | '));
});

test('brands are recognized; plain queries keep their branded everyday results', () => {
  assert.equal(brandOf('שניצל עוף ותירס, מאמא עוף'), normalize('מאמא עוף'));
  assert.equal(brandOf('שניצל חזה עוף מטוגן בשמן סויה'), '');
  const first = (q) => matchFood(q, index, { limit: 1 })[0].n;
  assert.match(first('קוטג׳'), /^גבינת קוטג/);
  assert.match(first('חמאה'), /^חמאה, /);
  assert.match(first('קורנפלקס'), /קורנפלקס/);
  assert.match(first('שניצל עוף'), /^שניצל חזה עוף/);   // the staple, not a branded product
  assert.ok(matchFood('שניצל מאמא עוף', index, { limit: 3 }).every((f) => /מאמא עוף/.test(f.n)));
});

test('"homemade" never lands on a factory product, and the word itself is not required', () => {
  for (const q of ['שניצל ביתי', 'שניצל עוף ביתי', 'שניצל עוף תוצרת בית']) {
    const top = matchFood(q, index, { limit: 8 }).map((f) => f.n);
    assert.ok(top.length && top.every((n) => !brandOf(n)), `${q}: ${top.join(' | ')}`);
    assert.match(top[0], /^שניצל (חזה )?עוף/);
  }
  assert.equal(matchFood('חומוס ביתי', index, { limit: 1 })[0].n, 'סלט חומוס, ביתי');
  assert.match(matchFood('לחם ביתי', index, { limit: 1 })[0].n, /^לחם ביתי/);   // not the sliced-loaf staple
  assert.ok(matchFood('ביתי', index, { limit: 3 }).length > 0);   // the word alone is searched as typed
});

test('"ללא שמן" / "בלי שמן": foods cooked with oil are left out; the no-fat version comes first', () => {
  for (const q of ['אורז לבן מבושל ללא שמן', 'אורז בלי שמן', 'אורז לבן ללא שמן']) {
    const top = matchFood(q, index, { limit: 5 }).map((f) => f.n);
    assert.ok(top.length, q);
    assert.match(top[0], /ללא תוספת שומן/, `${q}: ${top.join(' | ')}`);
    assert.ok(top.every((n) => !/עם שמן/.test(n)), `${q}: ${top.join(' | ')}`);
  }
  assert.match(matchFood('סלט ירקות ללא שמן', index, { limit: 1 })[0].n, /ללא תוספת שמן/);
  assert.match(matchFood('אורז לבן מבושל', index, { limit: 1 })[0].n, /ללא תוספת שומן/);   // plain cooked rice
});

test('chicken eaten with the skin only when the skin is mentioned', () => {
  assert.match(matchFood('חזה עוף צלוי', index, { limit: 1 })[0].n, /נאכל ללא עור/);
});

test('a synonym never drops a typed word: grilled breast is breast, not thigh', () => {
  const top = matchFood('חזה עוף בגריל', index, { limit: 8 }).map((f) => f.n);
  assert.ok(top.every((n) => /חזה/.test(n)), top.join(' | '));
});

test('foodPreference: generic or staple 0, unrequested skin 1, unnamed brand 2', () => {
  const f = (n) => ({ n });
  assert.equal(foodPreference(f('בשר עוף, חזה, ללא עצם, צלוי, נאכל ללא עור'), 'חזה עוף בגריל'), 0);
  assert.equal(foodPreference(f('בשר עוף, חזה, ללא עצם, בגריל, נאכל עם עור'), 'חזה עוף בגריל'), 1);
  assert.equal(foodPreference(f('בשר עוף, חזה, ללא עצם, בגריל, נאכל עם עור'), 'חזה עוף עם עור'), 0);
  assert.equal(foodPreference(f('בשר עוף, חזה במרינדה, בגריל, מאמא עוף'), 'חזה עוף בגריל'), 2);
  assert.equal(foodPreference(f('בשר עוף, חזה במרינדה, בגריל, מאמא עוף'), 'חזה עוף של מאמא עוף'), 0);
  assert.equal(foodPreference(f('חמאה, תנובה, טרה'), 'חמאה'), 0);   // the staple
  assert.equal(foodPreference(f('סלט, מעורב'), 'סלט מעורב בלי עור'), 0);   // "עור" is not "מעורב"
});

test('negations: whole words, multi-word oils, ו-joined words, fat percentages', () => {
  assert.deepEqual(queryNegations(normalize('סלט בלי שמן זית')), { plain: 'סלט', without: ['שמנ', 'שומנ', 'חמאה', 'מרגרינה'] });
  assert.deepEqual(queryNegations(normalize('פסטה בלי חלב ושמנת')).without, ['חלב', 'שמנת']);
  assert.deepEqual(queryNegations(normalize('פסטה בלי שמנת')).without, ['שמנת']);   // cream is not oil
  // "X% שומן" is how much fat, not added fat; 0% counts as without
  assert.ok(!hasFat(splitNegated('יוגורט 0% שומן, יופלה, טבעי, תנובה').pos));
  assert.match(splitNegated('יוגורט 0% שומן, יופלה').neg, /ללא שומנ/);
  // the without-part ends at the next "עם"
  assert.match(splitNegated('מקלובה עם ירקות ללא בשר עם שמן קנולה').pos, /שמנ קנולה/);
});
const hasFat = (t) => /(^| )שומנ( |$)/.test(t);

test('"ללא" with a staple: the staple steps back ("לחם ללא גלוטן" is not the everyday loaf)', () => {
  const first = (q) => matchFood(q, index, { limit: 1 })[0].n;
  assert.match(first('לחם ללא גלוטן'), /ללא גלוטן/);
  assert.match(first('חלב ללא שומן'), /^חלב 1% שומן/);   // the leanest milk, never breast milk
  assert.match(first('גבינה לבנה ללא שומן'), /0\.5% שומן/);
  assert.match(first('קוטג ללא שומן'), /0\.5% שומן/);
  assert.match(first('אורז ללא שמן'), /ללא תוספת שומן/);
  assert.ok(!/חלב אמ|חלב אם/.test(matchFood('חלב', index, { limit: 2 }).map((f) => f.n).join()));
});

test('review round 3: Latin-capital makers are brands; plant-based only when said; ו-words; "דל X"; staples with ללא', () => {
  assert.ok(brandOf('דגני בוקר, קורנפלקס UK ,KELLOGGS'));
  assert.ok(brandOf('המבורגר, בורגר מן הצומח, טבע דלי'));
  assert.equal(foodPreference({ n: 'המבורגר מן הצומח' }, 'המבורגר'), 1);
  assert.equal(foodPreference({ n: 'המבורגר מן הצומח' }, 'המבורגר מן הצומח'), 0);
  assert.deepEqual(queryNegations(normalize('גלידה ללא סוכר וניל')), { plain: 'גלידה וניל', without: ['סוכר'] });
  assert.match(splitNegated('חלב 2% שומן, כולל דל לקטוז, תנובה').neg, /ללא לקטוז/);
  assert.match(matchFood('חלב ללא לקטוז', index, { limit: 1 })[0].n, /לקטוז/);
  assert.match(matchFood('ביצים בלי קליפה', index, { limit: 1 })[0].n, /^ביצה שלמה/);
});

test('the index reuses prepared database foods between rebuilds', () => {
  const a = buildIndex(data.foods.slice(0, 50));
  const b = buildIndex(data.foods.slice(0, 50));
  assert.equal(a[0], b[0]);
});

test('dry ingredients: "יבשה" / "לא מבושלת" find the uncooked food; baby food is never an adult pick', () => {
  const first = (q) => matchFood(q, index, { limit: 1 })[0].n;
  assert.match(first('שיבולת שועל יבשה'), /^שיבולת שועל.*לא מבושל/);
  assert.match(first('שיבולת שועל לא מבושלת'), /^שיבולת שועל.*לא מבושל/);
  assert.match(first('שיבולת שועל'), /מבושל/);   // without "dry", cooked first as before
  assert.ok(!/לא מבושל/.test(first('שיבולת שועל')));
  assert.equal(brandOf('דייסת תינוקות, שיבולת שועל/דגנים מעורבים, אבקה, B&D מועשרת'), normalize('B&D'));
  assert.equal(foodPreference({ n: 'דייסת תינוקות, שיבולת שועל, B&D מועשרת' }, 'דייסת שיבולת שועל'), 3);
  assert.equal(foodPreference({ n: 'דייסת תינוקות, שיבולת שועל, B&D מועשרת' }, 'דייסה לתינוק'), 2);
});

test('"יבש" means uncooked only for foods the database has uncooked; otherwise dried (fruit) or dry (wine)', () => {
  const first = (q) => matchFood(q, index, { limit: 1 })[0].n;
  assert.match(first('תאנים יבשות'), /^תאנה, מיובשת/);
  assert.match(first('שזיפים יבשים'), /^שזיף, מיובש/);
  assert.match(first('משמש יבש'), /^משמש, מיובש/);
  assert.match(first('יין לבן יבש'), /יין לבן/);
  assert.match(first('יין יבש'), /יין/);
  assert.match(first('אורז יבש'), /לא מבושל/);
  assert.match(first('פסטה יבשה'), /לא מבושל/);
});

test('the brand-plus-description rule is only for brands that are not food words (dill is not a brand)', () => {
  assert.equal(brandOf('סלט מלפפונים עם בצל, שמיר ושמן סויה'), '');
  assert.equal(brandOf('מרק, מוכן מאבקת מרק עוף עם גזר, שמיר ופטרוזיליה'), '');
  assert.ok(brandOf('דייסת תינוקות, שיבולת שועל/דגנים מעורבים, אבקה, B&D מועשרת'));
  assert.match(matchFood('סלט מלפפונים ביתי', index, { limit: 8 }).map((f) => f.n).join('|'), /שמיר/);
  assert.equal(foodPreference({ n: 'תמ"ל, נוטרילון, שלב 1, מוכן לשתייה' }, 'חלב'), 3);
});

test('review round 2: dried keeps "ללא"; milk powder; tomatoes; "ביתי" does not hide "יבש"', () => {
  const top = (q, n = 3) => matchFood(q, index, { limit: n }).map((f) => f.n);
  assert.ok(!top('תאנים יבשות ללא סוכר').some((n) => /עם סוכר/.test(n)), top('תאנים יבשות ללא סוכר').join(' | '));
  assert.match(top('חלב יבש')[0], /חלב מיובש/);
  assert.match(top('עגבניות יבשות')[0], /עגבניות.*מיובשות/);
  assert.match(top('שיבולת שועל יבשה ביתי')[0], /לא מבושל/);
  assert.match(top('שזיפים יבשים')[0], /^שזיף, מיובש/);
});

test('rare forms are judged one by one; plain dried fruit before cooked dried fruit', () => {
  const top = (q, n = 3) => matchFood(q, index, { limit: n }).map((f) => f.n);
  assert.ok(!/אבקה/.test(top('תמל', 1)[0]), top('תמל').join(' | '));   // ready-to-drink before powder, as before
  assert.ok(!/מבושל/.test(top('שזיפים יבשים', 1)[0]), top('שזיפים יבשים').join(' | '));
  assert.ok(!top('שזיפים יבשים ללא סוכר').some((n) => /עם תוספת סוכר/.test(n)), top('שזיפים יבשים ללא סוכר').join(' | '));
});

test('a query that is only a homemade word is searched as typed', () => {
  assert.ok(matchFood('של אמא', index, { limit: 3 }).length > 0);
  assert.ok(matchFood('ביתי', index, { limit: 3 }).map((f) => f.n).includes('סלט חומוס, ביתי'));
});

test('canned food: "משימורים" / "שימורים" / "מקופסה" are searched as the database\'s "משומר"', () => {
  const first = (q) => matchFood(q, index, { limit: 1 })[0]?.n || '';
  assert.match(first('עלי גפן משימורים'), /עלי גפן ממולאים באורז, משומרים/);
  assert.match(first('עלי גפן שימורים'), /משומרים/);
  assert.match(first('טונה מקופסה'), /טונה, משומר/);
  assert.match(first('חומוס משימורים'), /משומרים/);
});

test('the canned rewrite keeps foods named with the word itself first ("חמין שימורים")', () => {
  assert.match(matchFood('חמין שימורים', index, { limit: 1 })[0].n, /^חמין שימורים/);
  assert.match(matchFood('עלי גפן משימורים', index, { limit: 1 })[0].n, /משומרים/);
});

test('cola means regular cola; zero or diet means the sugar-free one', () => {
  const first = (q) => matchFood(q, index, { limit: 1 })[0].n;
  assert.match(first('קולה'), /^משקה קל, קולה, כולל/);
  assert.match(first('קוקה קולה'), /^משקה קל, קולה, כולל/);
  assert.match(first('קולה זירו'), /ללא סוכר, דיאט/);
});

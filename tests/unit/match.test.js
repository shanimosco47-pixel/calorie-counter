import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalize, buildIndex, matchFood, STAPLES, brandOf } from '../../lib/match.js';

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

test('a plain query prefers the generic food over a branded product; naming the brand finds it', () => {
  const top = (q) => matchFood(q, index, { limit: 3 }).map((f) => f.n);
  assert.ok(top('שניצל עוף').every((n) => !brandOf(n)), top('שניצל עוף').join(' | '));
  assert.ok(top('שניצל מאמא עוף').every((n) => /מאמא עוף/.test(n)), top('שניצל מאמא עוף').join(' | '));
  assert.equal(brandOf('שניצל עוף ותירס, מאמא עוף'), normalize('מאמא עוף'));
  assert.equal(brandOf('שניצל חזה עוף מטוגן בשמן סויה'), '');
});

test('"homemade" never lands on a factory product, and the word itself is not required', () => {
  for (const q of ['שניצל ביתי', 'שניצל עוף ביתי', 'שניצל עוף תוצרת בית']) {
    const top = matchFood(q, index, { limit: 8 }).map((f) => f.n);
    assert.ok(top.length && top.every((n) => !brandOf(n)), `${q}: ${top.join(' | ')}`);
    assert.match(top[0], /^שניצל חזה עוף/);
  }
  assert.equal(matchFood('חומוס ביתי', index, { limit: 1 })[0].n, 'סלט חומוס, ביתי');
  assert.ok(matchFood('ביתי', index, { limit: 3 }).length > 0);   // the word alone is searched as typed
});

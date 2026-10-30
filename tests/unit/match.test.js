import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalize, buildIndex, matchFood } from '../../lib/match.js';

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
  assert.deepEqual(egg('ביצה או חביתה מטוגנת בשמן זית'), ['egg', 37, 'ביצה']);
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

test('every staple exists in the data', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../../lib/match.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('const STAPLES'), src.indexOf(']);', src.indexOf('const STAPLES')));
  const names = [...block.matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] || m[2]);
  const all = new Set(data.foods.map((f) => f.n));
  assert.ok(names.length >= 20);
  for (const n of names) assert.ok(all.has(n), `missing staple: ${n}`);
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

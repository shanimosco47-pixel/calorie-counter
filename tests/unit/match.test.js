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
    for (const [code, grams] of f.m) assert.ok(data.units[code] && grams > 0, `${f.id} unit ${code}`);
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

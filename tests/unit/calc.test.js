import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultAmount, gramsFor, nutrientsFor, sumEntries, totalsByMeal, bmr, dailyTarget, MIN_TARGET,
  mealForHour, addDays, makeBackup, parseBackup,
} from '../../lib/calc.js';

const pita = { id: 't1', n: 'פיתה', kcal: 275, p: 9.1, c: 55.7, f: 1.2, m: [['1226', 90], ['u1', 45, 'חצי פיתה']] };

test('gramsFor: grams pass through', () => {
  assert.equal(gramsFor(pita, 150, 'g'), 150);
  assert.equal(gramsFor(pita, '80'), 80);
});

test('gramsFor: household measure multiplies by unit weight', () => {
  assert.equal(gramsFor(pita, 1, '1226'), 90);
  assert.equal(gramsFor(pita, 1.5, '1226'), 135);
  assert.equal(gramsFor(pita, 2, 'u1'), 90);
  assert.throws(() => gramsFor(pita, 1, '999'));
});

test('nutrientsFor scales per-100g values', () => {
  assert.deepEqual(nutrientsFor(pita, 100), { kcal: 275, p: 9.1, c: 55.7, f: 1.2 });
  assert.deepEqual(nutrientsFor(pita, 90), { kcal: 248, p: 8.2, c: 50.1, f: 1.1 });
  assert.deepEqual(nutrientsFor(pita, 0), { kcal: 0, p: 0, c: 0, f: 0 });
});

test('sumEntries and totalsByMeal', () => {
  const entries = [
    { meal: 'breakfast', kcal: 248, p: 8.2, c: 50.1, f: 1.1 },
    { meal: 'breakfast', kcal: 100, p: 1, c: 2, f: 3 },
    { meal: 'dinner', kcal: 500.4, p: 30, c: 40, f: 20 },
  ];
  assert.deepEqual(sumEntries(entries), { kcal: 848, p: 39.2, c: 92.1, f: 24.1 });
  const byMeal = totalsByMeal(entries);
  assert.equal(byMeal.breakfast.kcal, 348);
  assert.equal(byMeal.lunch.kcal, 0);
  assert.equal(byMeal.dinner.kcal, 500);
  assert.equal(byMeal.snack.kcal, 0);
});

test('Mifflin-St Jeor BMR', () => {
  // 10*70 + 6.25*175 - 5*30 + 5 = 1648.75
  assert.equal(bmr({ sex: 'male', weight: 70, height: 175, age: 30 }), 1649);
  // 10*60 + 6.25*165 - 5*40 - 161 = 1270.25
  assert.equal(bmr({ sex: 'female', weight: 60, height: 165, age: 40 }), 1270);
});

test('dailyTarget applies activity, goal and floor', () => {
  const p = { sex: 'male', weight: 70, height: 175, age: 30, activity: 1.55, goal: -500 };
  assert.equal(dailyTarget(p), Math.round((1649 * 1.55 - 500) / 10) * 10);
  const tiny = { sex: 'female', weight: 40, height: 145, age: 80, activity: 1.2, goal: -500 };
  assert.equal(dailyTarget(tiny), MIN_TARGET);
});

test('mealForHour and addDays', () => {
  assert.equal(mealForHour(7), 'breakfast');
  assert.equal(mealForHour(13), 'lunch');
  assert.equal(mealForHour(19), 'dinner');
  assert.equal(mealForHour(23), 'snack');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('backup round-trip', () => {
  const tables = {
    entries: [{ id: 1, date: '2026-10-25', meal: 'lunch', foodId: 't1', kcal: 248 }],
    myFoods: [{ id: 'b729', n: 'במבה', kcal: 535, m: [] }],
    weights: [{ date: '2026-10-25', kg: 70.2 }],
    settings: [{ key: 'targetMode', value: 'manual' }],
    favorites: [{ foodId: 't1' }],
  };
  const json = JSON.stringify(makeBackup(tables));
  assert.deepEqual(parseBackup(json), tables);
});

test('parseBackup rejects foreign or broken files', () => {
  assert.throws(() => parseBackup('{"hello":1}'), /קלורית/);
  assert.throws(() => parseBackup({ app: 'kalorit', version: 99 }));
  assert.throws(() => parseBackup({ app: 'kalorit', version: 1, entries: 'x' }));
  assert.throws(() => parseBackup('not json'));
});

test('defaultAmount picks the natural household measure', () => {
  const f = (m, kcal = 100) => ({ id: 'x', n: 'x', kcal, m });
  assert.deepEqual(defaultAmount(f([])), { amount: 100, unit: 'g' });
  // medium unit beats cup, spoon and package
  assert.deepEqual(defaultAmount(f([['200', 240], ['300', 15], ['103', 120], ['900', 750]])), { amount: 1, unit: '103' });
  // slice for bread, not the whole loaf
  assert.deepEqual(defaultAmount(f([['502', 30], ['900', 750]], 250)), { amount: 1, unit: '502' });
  // bottle and cup containers count as one serving
  assert.deepEqual(defaultAmount(f([['1100', 100]])), { amount: 1, unit: '1100' });
  // a 250 g tub of cottage is not one serving: tablespoon wins
  assert.deepEqual(defaultAmount(f([['300', 40], ['600', 250]])), { amount: 1, unit: '300' });
  // a cup of olive oil (1,900 kcal) is not a serving
  assert.deepEqual(defaultAmount(f([['200', 216], ['300', 10]], 884)), { amount: 1, unit: '300' });
  // one grape is too small; a cup of grapes is natural
  assert.deepEqual(defaultAmount(f([['103', 7], ['200', 142]], 69)), { amount: 1, unit: '200' });
  // egg dishes default to two eggs; borrowed units work like their originals
  assert.deepEqual(defaultAmount(f([['egg', 37, 'ביצה'], ['801', 48]])), { amount: 2, unit: 'egg' });
  assert.deepEqual(defaultAmount(f([['b502', 23, '≈ פרוסה'], ['b900', 600]])), { amount: 1, unit: 'b502' });
  // nothing sensible: fall back to grams (a 30 g handful for calorie-dense food)
  assert.deepEqual(defaultAmount(f([['900', 750]])), { amount: 100, unit: 'g' });
  assert.deepEqual(defaultAmount(f([['100', 5.5], ['200', 120]], 654)), { amount: 30, unit: 'g' });   // walnuts
  assert.deepEqual(defaultAmount(f([['500', 2.5]], 107)), { amount: 100, unit: 'g' });                 // 2.5 g ham slice
});

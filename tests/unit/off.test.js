import test from 'node:test';
import assert from 'node:assert/strict';
import { offToFood } from '../../lib/off.js';

test('offToFood maps a product with Hebrew name and serving', () => {
  const food = offToFood({
    product_name: 'Bamba', product_name_he: 'במבה', brands: 'אסם,Osem',
    nutriments: { 'energy-kcal_100g': 534, proteins_100g: 15, carbohydrates_100g: 39, fat_100g: 35 },
    serving_quantity: 25,
  }, '7290000066318');
  assert.deepEqual(food, {
    id: 'b7290000066318', barcode: '7290000066318', n: 'במבה, אסם', kcal: 534, p: 15, c: 39, f: 35,
    m: [['serving', 25]], src: 'off',
  });
});

test('offToFood converts kJ and rejects products without data', () => {
  assert.equal(offToFood({ product_name: 'x', nutriments: { energy_100g: 418.4 } }, '1').kcal, 100);
  assert.equal(offToFood({ product_name: 'x', nutriments: {} }, '1'), null);
  assert.equal(offToFood({ nutriments: { 'energy-kcal_100g': 5 } }, '1'), null);
});

test('audit: empty calorie field falls back to kJ; impossible values are refused; macros rounded', async () => {
  const { offToFood } = await import('../../lib/off.js');
  const base = { product_name: 'Bar', nutriments: { 'energy-kcal_100g': '', energy_100g: 1500, proteins_100g: 0.7999999821186066 } };
  const f = offToFood(base, '123');
  assert.equal(f.kcal, Math.round(1500 / 4.184));
  assert.equal(f.p, 0.8);
  assert.equal(offToFood({ product_name: 'x', nutriments: { 'energy-kcal_100g': 2100 } }, '1'), null);
  assert.equal(offToFood({ product_name: 'x', nutriments: { 'energy-kcal_100g': -50 } }, '1'), null);
  assert.equal(offToFood({ product_name: 'x', nutriments: { 'energy-kcal_100g': 300, fat_100g: 250 } }, '1'), null);
  assert.deepEqual(offToFood({ product_name: 'x', serving_quantity: 5000, nutriments: { 'energy-kcal_100g': 60 } }, '1').m, []);
});

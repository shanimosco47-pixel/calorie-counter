import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, parseResponse, pickFood, analyzePhoto, VisionError, RESPONSE_SCHEMA } from '../../lib/vision.js';

const reply = (items, extra = {}) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ items }) }], ...extra });
const item = { name: 'אורז לבן', query: 'אורז לבן מבושל', grams: 150, kcal_per_100g: 130, protein_per_100g: 2.7, carbs_per_100g: 28, fat_per_100g: 0.3 };

test('request: image first, structured output, no sampling params', () => {
  const r = buildRequest('QUJD', 'image/jpeg');
  assert.equal(r.messages[0].content[0].type, 'image');
  assert.equal(r.messages[0].content[0].source.data, 'QUJD');
  assert.deepEqual(r.output_config.format, { type: 'json_schema', schema: RESPONSE_SCHEMA });
  assert.equal(r.fallbacks, 'default');
  assert.equal(r.temperature, undefined);
  assert.equal(r.thinking, undefined);
});

test('parse: maps fields, drops empty and zero-gram items, clamps bad numbers', () => {
  const items = parseResponse(reply([item, { ...item, name: '', grams: 10 }, { ...item, name: 'מים', grams: 0 }, { ...item, name: 'x', kcal_per_100g: -5, grams: 12.6 }]));
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { name: 'אורז לבן', query: 'אורז לבן מבושל', grams: 150, kcal: 130, p: 2.7, c: 28, f: 0.3 });
  assert.equal(items[1].kcal, 0);
  assert.equal(items[1].grams, 13);
});

test('parse: refusal and malformed output raise VisionError', () => {
  assert.throws(() => parseResponse({ stop_reason: 'refusal', content: [] }), (e) => e instanceof VisionError && e.code === 'refusal');
  assert.throws(() => parseResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] }), (e) => e.code === 'bad_output');
  assert.deepEqual(parseResponse(reply([])), []);
});

test('pickFood: skips implausible candidates, falls back to the estimate', () => {
  const it = parseResponse(reply([item]))[0];
  const powder = { id: 't1', n: 'אורז, אבקה', kcal: 380 };
  const cooked = { id: 't2', n: 'אורז לבן, מבושל', kcal: 125 };
  assert.equal(pickFood(it, [powder, cooked]).food.id, 't2');
  const est = pickFood(it, [powder], { makeId: () => 'aX' });
  assert.equal(est.estimated, true);
  assert.deepEqual(est.food, { id: 'aX', n: 'אורז לבן', kcal: 130, p: 2.7, c: 28, f: 0.3, m: [], src: 'ai' });
  // 0 kcal (diet cola, water) is an estimate too: regular cola is not a match
  const water = { ...it, name: 'מים', kcal: 0, p: 0, c: 0, f: 0 };
  assert.equal(pickFood(water, [{ id: 't3', n: 'משקה קולה', kcal: 42 }]).estimated, true);
  assert.equal(pickFood(water, [{ id: 't4', n: 'מים', kcal: 0 }]).food.id, 't4');
  // an earlier photo estimate is never reused as a database match
  assert.equal(pickFood(it, [{ id: 'a1', n: 'אורז לבן', kcal: 130, src: 'ai' }], { makeId: () => 'aY' }).food.id, 'aY');
});

test('analyzePhoto: headers, key handling and HTTP errors', async () => {
  let seen;
  const ok = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify(reply([item])), { status: 200 }); };
  const items = await analyzePhoto({ apiKey: 'sk-ant-test', imageBase64: 'QUJD', mediaType: 'image/jpeg', fetchImpl: ok });
  assert.equal(items.length, 1);
  assert.equal(seen.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen.init.headers['x-api-key'], 'sk-ant-test');
  assert.equal(seen.init.headers['anthropic-dangerous-direct-browser-access'], 'true');

  await assert.rejects(analyzePhoto({ apiKey: '', imageBase64: 'x' }), (e) => e.code === 'no_key');
  const status = (s) => async () => new Response(JSON.stringify({ error: { message: 'nope' } }), { status: s });
  for (const [s, code] of [[401, 'auth'], [429, 'rate_limit'], [529, 'overloaded'], [400, 'api']]) {
    await assert.rejects(analyzePhoto({ apiKey: 'k', imageBase64: 'x', fetchImpl: status(s) }), (e) => e.code === code);
  }
  const noCredit = async () => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error',
    message: 'Your credit balance is too low to access the Anthropic API.' } }), { status: 400 });
  await assert.rejects(analyzePhoto({ apiKey: 'k', imageBase64: 'x', fetchImpl: noCredit }),
    (e) => e.code === 'credit' && e.detail.includes('credit balance'));
  await assert.rejects(analyzePhoto({ apiKey: 'k', imageBase64: 'x', fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), (e) => e.code === 'network');
});

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
  assert.equal(r.model, 'claude-haiku-5-5');
  assert.equal(r.fallbacks, undefined);   // not supported on Haiku
  assert.equal(r.temperature, undefined);
  assert.equal(r.thinking, undefined);
});

test('parse: maps fields, drops empty and zero-gram items, clamps bad numbers', () => {
  const items = parseResponse(reply([item, { ...item, name: '', grams: 10 }, { ...item, name: 'מים', grams: 0 }, { ...item, name: 'x', kcal_per_100g: -5, grams: 12.6 }]));
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { name: 'אורז לבן', query: 'אורז לבן מבושל', queries: ['אורז לבן מבושל'], grams: 150, unit: null, kcal: 130, p: 2.7, c: 28, f: 0.3 });
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

test('counted foods: unit kept, Claude\'s total weight kept, alternative search terms', async () => {
  const { amountFor } = await import('../../lib/vision.js');
  const eggs = parseResponse(reply([{ ...item, name: 'ביצים מקושקשות', query: 'ביצים מקושקשות', alt_queries: ['חביתה', 'חביתה', ''],
    grams: 150, unit_name: 'ביצה', unit_count: 3, unit_grams: 50, kcal_per_100g: 160 }]))[0];
  assert.deepEqual(eggs.unit, { name: 'ביצה', count: 3 });
  assert.equal(eggs.grams, 150);
  assert.deepEqual(eggs.queries, ['ביצים מקושקשות', 'חביתה']);
  // no unit: empty name or zero count means "not counted"
  assert.equal(parseResponse(reply([{ ...item, unit_name: 'כוס', unit_count: 0, unit_grams: 240 }]))[0].unit, null);
  // shakshuka "2 eggs" keeps its real total, not 2 x 50 g
  assert.equal(parseResponse(reply([{ ...item, grams: 350, unit_name: 'ביצה', unit_count: 2, unit_grams: 50 }]))[0].grams, 350);
  // tiny units are not rounded away: 60 raisins of 0.5 g, 50 sweetener drops of 0.1 g
  assert.equal(parseResponse(reply([{ ...item, grams: 0, unit_name: 'צימוק', unit_count: 60, unit_grams: 0.5 }]))[0].grams, 30);
  assert.equal(parseResponse(reply([{ ...item, grams: 5, unit_name: 'טיפה', unit_count: 50, unit_grams: 0.1 }]))[0].grams, 5);
  // absurd numbers are capped
  const huge = parseResponse(reply([{ ...item, grams: 1e9, unit_name: 'x', unit_count: 1e6, unit_grams: 1 }]))[0];
  assert.equal(huge.grams, 5000);
  assert.equal(huge.unit.count, 100);

  // not in the database: the estimate gets the unit (total / count), and opens as 3 eggs
  const est = pickFood(eggs, [], { makeId: () => 'aE' });
  assert.deepEqual(est.food.m, [['u1', 50, 'ביצה']]);
  const label = (f, code) => (f.m.find(([c]) => c === code) || [])[2] || '';
  assert.deepEqual(amountFor(eggs, est.food, label), { amount: 3, unit: 'u1' });
  // a database food with an egg unit opens in eggs too; one without opens in grams
  const omelette = { id: 't9', n: 'ביצה או חביתה מטוגנת ללא שמן', kcal: 162, m: [['egg', 43.7, 'ביצה'], ['800', 50]] };
  assert.deepEqual(amountFor(eggs, omelette, label), { amount: 3, unit: 'egg' });
  assert.deepEqual(amountFor(eggs, { id: 't8', n: 'x', kcal: 160, m: [] }, label), { amount: 150, unit: 'g' });
});

test('amountFor on real Tzameret data: closest size wins, implausible sizes fall back to grams', async () => {
  const { readFileSync } = await import('node:fs');
  const { amountFor } = await import('../../lib/vision.js');
  const data = JSON.parse(readFileSync(new URL('../../data/tzameret.json', import.meta.url)));
  const foods = Array.isArray(data) ? data : data.foods;
  const units = data.units || {};
  const labelOf = (f, code) => { const m = f.m.find(([c]) => String(c) === String(code)); return (m && m[2]) || units[String(code).replace(/^b/, '')] || ''; };
  const find = (re) => foods.find((f) => re.test(f.n));
  const counted = (name, count, grams) => ({ unit: { name, count }, grams });

  // a toasted baguette's "פרוסה" is 5.5 g: two 30 g slices must not open as 11 g
  const baguette = find(/^לחם בגט, קלוי/);
  assert.ok(baguette, 'baguette in data');
  assert.equal(amountFor(counted('פרוסה', 2, 60), baguette, labelOf).unit, 'g');
  // boiled eggs have only "יחידה" sizes: 2 eggs (~100 g) pick the closest one
  const boiled = find(/^ביצה קשה שלמה/);
  const r = amountFor(counted('ביצה', 2, 100), boiled, labelOf);
  assert.equal(r.amount, 2);
  assert.match(r.unit, /^b?10[0-5]$/);
  const g = boiled.m.find(([c]) => String(c) === r.unit)[1];
  for (const [c, other] of boiled.m) if (/^b?10[0-5]$/.test(String(c))) assert.ok(Math.abs(2 * g - 100) <= Math.abs(2 * other - 100));
});


test('alternative terms: a hit must relate to what was seen; tiny units are not stored as 0 g', () => {
  const cake = parseResponse(reply([{ ...item, name: 'עוגת גלידה', query: 'עוגת גלידה', alt_queries: ['גלידה'], grams: 120, kcal_per_100g: 230 }]))[0];
  const sandwich = { id: 't1', n: 'גלידה, שלגון, מיני סנדוויץ, לייט', kcal: 181, altQuery: 'גלידה' };
  assert.equal(pickFood(cake, [], { alternatives: [sandwich], makeId: () => 'aC' }).estimated, true);
  const iceCake = { id: 't2', n: 'עוגה גלידה וניל', kcal: 220, altQuery: 'גלידה' };
  const hit = pickFood(cake, [], { alternatives: [iceCake] });
  assert.equal(hit.food.id, 't2');
  assert.equal('altQuery' in hit.food, false);          // the search tag is not saved with the food
  // plural vs singular still relates (ביצים ~ ביצה)
  const eggs = parseResponse(reply([{ ...item, name: 'ביצים מקושקשות', query: 'ביצים מקושקשות', alt_queries: ['חביתה'], grams: 150, kcal_per_100g: 160 }]))[0];
  assert.equal(pickFood(eggs, [], { alternatives: [{ id: 't3', n: 'ביצה או חביתה מטוגנת', kcal: 162, altQuery: 'חביתה' }] }).food.id, 't3');

  const tablets = parseResponse(reply([{ ...item, name: 'ממתיק', query: 'ממתיק', grams: 1, unit_name: 'טבליה', unit_count: 50, unit_grams: 0.02 }]))[0];
  assert.deepEqual(pickFood(tablets, [], { makeId: () => 'aT' }).food.m, []);
  const seeds = parseResponse(reply([{ ...item, grams: 30, unit_name: 'צימוק', unit_count: 60, unit_grams: 0.5 }]))[0];
  assert.deepEqual(pickFood(seeds, [], { makeId: () => 'aS' }).food.m, [['u1', 0.5, 'צימוק']]);
});

// ---------- chat ----------
import { buildTextRequest, parseTextResponse, analyzeText, TEXT_RESPONSE_SCHEMA, historyText } from '../../lib/vision.js';

const textReply = (items, reply = '') => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ items, reply }) }] });

test('text request: the message and local time in one user turn, structured output with meal and day', () => {
  const r = buildTextRequest('הבוקר אכלתי פיתה עם גבינה לבנה', { now: new Date(2026, 10, 3, 9, 30) });
  assert.equal(r.model, 'claude-haiku-5-5');
  assert.equal(typeof r.messages[0].content, 'string');
  assert.match(r.messages[0].content, /הבוקר אכלתי פיתה עם גבינה לבנה$/);
  assert.match(r.messages[0].content, /09:30/);
  assert.deepEqual(r.output_config.format, { type: 'json_schema', schema: TEXT_RESPONSE_SCHEMA });
  const it = TEXT_RESPONSE_SCHEMA.properties.items.items;
  assert.ok(it.required.includes('meal') && it.required.includes('day_offset'));
  assert.equal(it.additionalProperties, false);
  assert.equal(r.temperature, undefined);
  // the photo schema is unchanged
  assert.equal(RESPONSE_SCHEMA.properties.items.items.properties.meal, undefined);
});

test('text parse: meal and day offset are validated; reply is kept', () => {
  const { items, reply } = parseTextResponse(textReply([
    { ...item, name: 'פיתה', meal: 'breakfast', day_offset: 0 },
    { ...item, name: 'שניצל', meal: 'brunch', day_offset: -1 },
    { ...item, name: 'עוגה', meal: '', day_offset: 3 },
    { ...item, name: 'ישן', meal: 'dinner', day_offset: -40 },
    { ...item, name: 'ריק', grams: 0, meal: 'lunch', day_offset: 0 },
  ], 'בתיאבון'));
  assert.equal(reply, 'בתיאבון');
  assert.deepEqual(items.map((i) => [i.name, i.meal, i.dayOffset]), [
    ['פיתה', 'breakfast', 0], ['שניצל', null, -1], ['עוגה', null, 0], ['ישן', 'dinner', -7],
  ]);
  assert.equal(items[0].grams, 150);
});

test('text parse: not about food gives no items and the reply; refusal and junk raise', () => {
  assert.deepEqual(parseTextResponse(textReply([], 'מה אכלת?')), { items: [], reply: 'מה אכלת?', replacesPrevious: false });
  assert.throws(() => parseTextResponse({ stop_reason: 'refusal', content: [] }), (e) => e.code === 'refusal');
  assert.throws(() => parseTextResponse({ content: [{ type: 'text', text: '{' }] }), (e) => e.code === 'bad_output');
});

test('analyzeText: sends the key, maps HTTP errors like photos', async () => {
  let sent;
  const ok = async (url, init) => { sent = init; return { ok: true, json: async () => textReply([{ ...item, meal: 'lunch', day_offset: 0 }]) }; };
  const res = await analyzeText({ apiKey: 'sk-ant-x', text: 'אורז', fetchImpl: ok });
  assert.equal(sent.headers['x-api-key'], 'sk-ant-x');
  assert.equal(res.items[0].meal, 'lunch');
  await assert.rejects(analyzeText({ apiKey: '', text: 'x' }), (e) => e.code === 'no_key');
  const bad = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'invalid x-api-key' } }) });
  await assert.rejects(analyzeText({ apiKey: 'k', text: 'x', fetchImpl: bad }), (e) => e.code === 'auth');
});

test('text request: earlier messages and what they logged come before the new one; corrections are parsed', () => {
  const history = [
    { text: 'שניצל 150 גרם בערב', status: 'logged', correctable: true, logged: [{ name: 'שניצל עוף ותירס, מאמא עוף', grams: 150, where: 'ערב' }] },
    { text: 'מה נשמע', status: 'none', logged: null },
    { text: 'קפה', status: 'undone', logged: null },
  ];
  const r = buildTextRequest('לא מאמא עוף, שניצל ביתי', { now: new Date(2026, 10, 4, 20, 0), history });
  const c = r.messages[0].content;
  assert.match(c, /1\. "שניצל 150 גרם בערב" — נרשם \(אפשר לתקן\): שניצל עוף ותירס, מאמא עוף 150 גרם \(ערב\)/);
  assert.match(c, /2\. "מה נשמע" — לא נרשם דבר/);
  assert.match(c, /3\. "קפה" — בוטל/);
  assert.match(c, /ההודעה החדשה:\nלא מאמא עוף, שניצל ביתי$/);
  assert.ok(TEXT_RESPONSE_SCHEMA.required.includes('replaces_previous'));
  assert.equal(historyText([]), '');
  assert.equal(historyText(Array.from({ length: 9 }, (_, i) => ({ text: `m${i}` }))).match(/^\d\./gm).length, 4);
  const body = { content: [{ type: 'text', text: JSON.stringify({ items: [{ ...item, meal: 'dinner', day_offset: 0 }], reply: '', replaces_previous: true }) }] };
  assert.equal(parseTextResponse(body).replacesPrevious, true);
});

test('pickFood with rank: a generic food near the top beats the branded one; brand only as a fallback', () => {
  const food = (id, n, kcal, rank) => ({ id, n, kcal, rank });
  const it = { name: 'חזה עוף בגריל', query: 'חזה עוף בגריל', kcal: 165, grams: 150, p: 0, c: 0, f: 0, unit: null };
  const rank = (f) => f.rank;
  const brand = food('b', 'חזה בגריל, מאמא עוף', 130, 2);
  const skin = food('s', 'חזה, בגריל, נאכל עם עור', 195, 1);
  const plain = food('g', 'חזה עוף, בגריל, ללא עור', 160, 0);
  // a generic alternative (rank 0) wins over a branded primary
  assert.equal(pickFood(it, [brand, skin], { rank, alternatives: [{ ...plain, altQuery: 'חזה עוף', altRank: 0 }] }).food.id, 'g');
  // no generic: the skin version before the brand
  assert.equal(pickFood(it, [brand, skin], { rank }).food.id, 's');
  // only branded: still a database food, not an estimate
  assert.equal(pickFood(it, [brand], { rank }).food.id, 'b');
  // without rank, the order is as before
  assert.equal(pickFood(it, [brand, skin]).food.id, 'b');
  // the alternative's tags never reach the diary
  const picked = pickFood(it, [brand], { rank, alternatives: [{ ...plain, altQuery: 'חזה עוף', altRank: 0 }] }).food;
  assert.equal('altRank' in picked || 'altQuery' in picked, false);
});

test('pickFood with rank: passing over the first result needs a closer calorie match', () => {
  const it = { name: 'כנפיים', query: 'כנפי עוף', kcal: 250, grams: 100, p: 0, c: 0, f: 0, unit: null };
  const brand = { id: 'b', n: 'כנפיים בגריל, מאמא עוף', kcal: 172, rank: 2 };
  const fried = { id: 'f', n: 'כנפיים מצופות מטוגנות', kcal: 318, rank: 0 };   // 27% off: not enough to skip the first
  assert.equal(pickFood(it, [brand, fried], { rank: (f) => f.rank }).food.id, 'b');
  const close = { ...fried, id: 'c', kcal: 240 };
  assert.equal(pickFood(it, [brand, close], { rank: (f) => f.rank }).food.id, 'c');
});

test('pickFood: a food ranked "never" (3) is not even a fallback; the chat prompt asks for the dry ingredient', () => {
  const it = { name: 'דייסת שיבולת שועל', query: 'דייסת שיבולת שועל', kcal: 380, grams: 70, p: 13, c: 67, f: 7, unit: null };
  const baby = { id: 'b', n: 'דייסת תינוקות, אבקה', kcal: 380 };
  const r = pickFood(it, [baby], { rank: () => 3 });
  assert.equal(r.estimated, true);
  assert.match(buildTextRequest('x').system, /לא מבושל/);
});

test('both prompts read foods as eaten in Israel: dishes not raw ingredients, named products as sold, a self-check', () => {
  for (const system of [buildRequest('x').system, buildTextRequest('x').system]) {
    assert.match(system, /עלי גפן/);
    assert.match(system, /stuffed/);
    assert.match(system, /estimate that product as sold/);
    assert.match(system, /surprise someone/);
    assert.match(system, /without a prefix letter/);
  }
  assert.match(buildTextRequest('x').system, /say in a few words what you assumed/);
});

import { dbHint, TEXT_RESPONSE_SCHEMA as TRS } from '../../lib/vision.js';

test('dbHint: a chosen food far from the search\'s own first related hit is flagged; brands, powders and the same food are not', () => {
  const it = { name: 'עלי גפן משימורים', query: 'עלי גפן משומרים', kcal: 72 };
  const canned = { id: 'w', n: 'עלי גפן ממולאים באורז, משומרים, וילי פוד', kcal: 169 };
  const fresh = { id: 'f', n: 'עלי גפן, טריים', kcal: 93 };
  assert.deepEqual(dbHint(it, fresh, [canned], [fresh]), { n: canned.n, kcal: 169 });
  assert.deepEqual(dbHint(it, { id: 'a', n: it.name, kcal: 72, src: 'ai' }, [canned]), { n: canned.n, kcal: 169 });
  assert.equal(dbHint(it, canned, [canned]), null);                         // the chosen food itself
  assert.equal(dbHint(it, fresh, [canned], [], () => 2), null);              // a branded product
  assert.equal(dbHint({ name: 'קפה קר', query: 'קפה קר', kcal: 80 }, { id: 'c', n: 'קפה קר מוכן', kcal: 80 },
    [{ id: 'p', n: 'קפה, אבקה להכנת משקה קר', kcal: 357 }]), null);          // a powder is another state
  assert.equal(dbHint({ name: 'שוקו', query: 'שוקו בלי סוכר', kcal: 40 }, { id: 's', n: 'שוקו ממכונה', kcal: 32 },
    [{ id: 'x', n: 'שוקולד חלב ללא סוכר', kcal: 472 }]), null);              // שוקולד is not שוקו
  assert.equal(dbHint({ name: 'עלי גפן', query: 'עלי גפן', kcal: 150 }, { id: 'g', n: 'עלי גפן ממולאים', kcal: 135 }, [canned]), null);   // close enough
});

test('pickFood with a named product: another food replaces Claude\'s estimate of it only at almost the same calories', () => {
  const it = { name: 'עלי גפן ממולאים (השקדיה)', query: 'עלי גפן ממולאים אורז', kcal: 170, grams: 125, p: 0, c: 0, f: 0, unit: null, product: 'השקדיה' };
  const homemade = { id: 'h', n: 'עלי גפן ממולאים אורז עם שמן סויה', kcal: 135 };
  assert.equal(pickFood(it, [homemade]).estimated, true);                    // 20% off: the product's own estimate
  assert.equal(pickFood(it, [{ ...homemade, kcal: 165 }]).food.id, 'h');      // 3% off: the database food
  assert.equal(pickFood({ ...it, product: '' }, [homemade]).food.id, 'h');   // nothing named: as before
  assert.ok(TRS.properties.items.items.required.includes('product'));
  const body = { content: [{ type: 'text', text: JSON.stringify({ items: [{ ...item, meal: '', day_offset: 0, product: ' השקדיה ' }], reply: '', replaces_previous: false }) }] };
  assert.equal(parseTextResponse(body).items[0].product, 'השקדיה');
});

test('dbHint round 2: never against a correctly chosen dry food; only the same food (first word, second near it)', () => {
  const dry = { id: 'd', n: 'שיבולת שועל, קוואקר, רגיל ואינסטנט, לא מבושל', kcal: 379 };
  const cooked = { id: 'c', n: 'שיבולת שועל, מבושל, אינסטנט, ללא תוספת שומן בבישול', kcal: 87 };
  assert.equal(dbHint({ name: 'שיבולת שועל', query: 'שיבולת שועל', kcal: 380 }, dry, [cooked, dry]), null);
  assert.equal(dbHint({ name: 'חלב סויה', query: 'חלב סויה', kcal: 40 }, { id: 'a', n: 'חלב סויה', kcal: 40, src: 'ai' },
    [{ id: 'o', n: 'ביצה או חביתה עם חלב בשמן סויה', kcal: 218 }]), null);
  assert.equal(dbHint({ name: 'תפוח אדמה אפוי', query: 'תפוח אדמה אפוי', kcal: 119 }, { id: 'p', n: 'תפוח אדמה אפוי', kcal: 119 },
    [{ id: 's', n: 'סמבוסק במילוי תפוחי אדמה ופטריות, אפוי', kcal: 240 }]), null);
});

test('a named product matches its database name without the article ("השקדיה" is "שקדיה")', () => {
  const it = { name: 'שקדים מעושנים', query: 'שקדים מעושנים', kcal: 650, grams: 30, p: 0, c: 0, f: 0, unit: null, product: 'השקדיה' };
  assert.equal(pickFood(it, [{ id: 's', n: 'שקדים מעושנים, גת, שקדיה', kcal: 586 }]).food.id, 's');
  assert.match(buildTextRequest('x').system, /without the article \("שקדיה"/);
});

test('a low-calorie food is not matched to one many times its calories (black coffee is not sweet Turkish coffee)', () => {
  const it = { name: 'קפה שחור', query: 'קפה שחור', kcal: 2, grams: 240, p: 0, c: 0, f: 0, unit: null };
  const sweet = { id: 's', n: 'קפה, מוכן טורקי/שחור ממותק', kcal: 38 };
  const plain = { id: 'p', n: 'קפה, מוכן אספרסו, לא ממותק', kcal: 9 };
  assert.equal(pickFood(it, [sweet, plain]).food.id, 'p');
  assert.equal(pickFood(it, [sweet]).estimated, true);
});

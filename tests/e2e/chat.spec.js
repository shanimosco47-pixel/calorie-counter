import { test, expect, open } from './helpers.js';

const item = (o) => ({
  alt_queries: [], unit_name: '', unit_count: 0, unit_grams: 0, protein_per_100g: 5, carbs_per_100g: 20, fat_per_100g: 3, meal: '', day_offset: 0, ...o,
});
const answer = (items, reply = '') => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ items, reply }) }] });

const breakfast = answer([
  item({ name: 'פיתה', query: 'פיתה', grams: 100, unit_name: 'פיתה', unit_count: 1, unit_grams: 100, kcal_per_100g: 250, meal: 'breakfast' }),
  item({ name: 'גבינה לבנה 5%', query: 'גבינה לבנה 5% שומן', grams: 40, kcal_per_100g: 120, meal: 'breakfast' }),
]);

async function withKey(page, key = 'sk-ant-test') {
  await open(page);
  if (key) await page.evaluate(async (k) => { const { setSetting } = await import('./lib/db.js'); await setSetting('apiKey', k); }, key);
  await page.getByTestId('nav-chat').click();
  await expect(page.getByTestId('view-chat')).toBeVisible();
}

const entries = (page) => page.evaluate(async () => {
  const { db } = await import('./lib/db.js');
  return (await db.log.toArray()).map((e) => ({ name: e.name, meal: e.meal, date: e.date, kcal: e.kcal, grams: e.grams }));
});

test('chat: a typed sentence is logged straight to the diary, with undo', async ({ page }) => {
  let body;
  await page.route('https://api.anthropic.com/**', (route) => { body = route.request().postDataJSON(); return route.fulfill({ json: breakfast }); });
  await withKey(page);
  await page.getByTestId('chat-input').fill('הבוקר אכלתי פיתה עם גבינה לבנה');
  await page.getByTestId('chat-send').click();

  await expect(page.getByTestId('chat-item')).toHaveCount(2);
  expect(body.messages[0].content).toContain('הבוקר אכלתי פיתה עם גבינה לבנה');
  await expect(page.getByTestId('confirm-sheet')).toBeHidden();   // no confirmation step
  await expect(page.getByTestId('chat-me')).toHaveText('הבוקר אכלתי פיתה עם גבינה לבנה');
  await expect(page.getByTestId('chat-input')).toHaveValue('');

  const saved = await entries(page);
  expect(saved.map((e) => e.meal)).toEqual(['breakfast', 'breakfast']);
  expect(saved[0].name).toMatch(/^פיתה/);
  expect(saved[1].name).toMatch(/^גבינה לבנה/);

  await page.getByTestId('nav-today').click();
  await expect(page.getByTestId('meal-breakfast').getByTestId('entry')).toHaveCount(2);

  await page.getByTestId('nav-chat').click();
  await page.getByTestId('chat-undo').click();
  await expect(page.getByTestId('chat-reply').last()).toContainText('בוטל');
  expect(await entries(page)).toEqual([]);
  // the toast's undo brings them back
  await page.locator('#toast-undo').click();
  await expect(page.getByTestId('chat-item')).toHaveCount(2);
  expect(await entries(page)).toHaveLength(2);
});

test('chat: "yesterday evening" lands on yesterday\'s dinner; edit keeps the day', async ({ page }) => {
  await page.route('https://api.anthropic.com/**', (route) => route.fulfill({ json: answer([
    item({ name: 'אורז לבן', query: 'אורז לבן מבושל', grams: 150, kcal_per_100g: 130, meal: 'dinner', day_offset: -1 }),
  ]) }));
  await withKey(page);
  await page.getByTestId('chat-input').fill('אתמול בערב אכלתי אורז');
  await page.getByTestId('chat-input').press('Enter');
  await expect(page.getByTestId('chat-item')).toHaveCount(1);
  await expect(page.getByTestId('chat-item')).toContainText('אתמול');

  const yesterday = await page.evaluate(async () => { const { isoDate, addDays } = await import('./lib/calc.js'); return addDays(isoDate(), -1); });
  const [e] = await entries(page);
  expect([e.meal, e.date]).toEqual(['dinner', yesterday]);

  await page.getByTestId('chat-edit').click();
  await expect(page.getByTestId('confirm-sheet')).toBeVisible();
  await page.getByTestId('amount').fill('300');
  await page.getByTestId('confirm-save').click();
  await expect(page.getByTestId('confirm-sheet')).toBeHidden();
  // the sheet closes first and the edit is saved right after: wait for it
  await expect.poll(async () => (await entries(page)).map((x) => [x.date, x.grams])).toEqual([[yesterday, 300]]);
  await expect(page.getByTestId('chat-item')).toContainText('300');
});

test('chat: not about food gets Claude\'s reply and logs nothing', async ({ page }) => {
  await page.route('https://api.anthropic.com/**', (route) => route.fulfill({ json: answer([], 'מה אכלת היום?') }));
  await withKey(page);
  await page.getByTestId('chat-input').fill('שלום');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-reply')).toHaveText('מה אכלת היום?');
  expect(await entries(page)).toEqual([]);
});

test('chat: without a key, explains and links to settings', async ({ page }) => {
  await withKey(page, '');
  await page.getByTestId('chat-input').fill('פיתה');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-error')).toContainText('מפתח Claude API');
  await page.getByTestId('chat-settings').click();
  await expect(page.getByTestId('view-settings')).toBeVisible();
});

test('chat: no speech recognition in the browser hides the mic', async ({ page }) => {
  await page.addInitScript(() => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; });
  await withKey(page);
  await expect(page.getByTestId('chat-mic')).toBeHidden();
});

test('chat: speaking fills the box and sends when the speech ends', async ({ page }) => {
  await page.addInitScript(() => {
    class FakeSpeech {
      start() {
        window.__speech = this;
        setTimeout(() => {
          const result = (t, isFinal) => Object.assign([{ transcript: t }], { isFinal });
          this.onresult?.({ results: [result('הבוקר אכלתי פיתה', false)] });
          setTimeout(() => this.onresult?.({ results: [result('הבוקר אכלתי פיתה עם גבינה לבנה', true)] }), 200);
        }, 50);
      }
      abort() {} stop() {}
    }
    window.SpeechRecognition = FakeSpeech;
  });
  let body;
  await page.route('https://api.anthropic.com/**', (route) => { body = route.request().postDataJSON(); return route.fulfill({ json: breakfast }); });
  await withKey(page);
  await expect(page.getByTestId('chat-mic')).toBeVisible();
  await page.getByTestId('chat-mic').click();
  await expect(page.getByTestId('chat-mic')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.__speech.lang)).toBe('he-IL');
  await expect(page.getByTestId('chat-item')).toHaveCount(2);
  expect(body.messages[0].content).toContain('הבוקר אכלתי פיתה עם גבינה לבנה');
  await expect(page.getByTestId('chat-mic')).toHaveAttribute('aria-pressed', 'false');
});

test('chat: a second message sent while the first is logging waits its turn; both are logged', async ({ page }) => {
  const order = [];
  await page.route('https://api.anthropic.com/**', async (route) => {
    const text = route.request().postDataJSON().messages[0].content.split('ההודעה החדשה:').pop();
    const first = text.includes('פיתה');
    order.push(first ? 'first' : 'second');
    if (first) await new Promise((r) => setTimeout(r, 800));   // the first answer is slow
    return route.fulfill({ json: answer([first
      ? item({ name: 'פיתה', query: 'פיתה', grams: 100, kcal_per_100g: 250, meal: 'breakfast' })
      : item({ name: 'אורז לבן', query: 'אורז לבן מבושל', grams: 150, kcal_per_100g: 130, meal: 'lunch' })]) });
  });
  await withKey(page);
  await page.getByTestId('chat-input').fill('פיתה');
  await page.getByTestId('chat-send').click();
  await page.getByTestId('chat-input').fill('וגם אורז');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-reply')).toHaveCount(2);
  expect(order).toEqual(['first', 'second']);   // one at a time, in order
  expect((await entries(page)).map((e) => e.meal)).toEqual(['breakfast', 'lunch']);
  await expect(page.getByTestId('chat-pending')).toHaveCount(0);
});

test('chat: no meal said uses the meal for now; a food not in the database is marked estimated; 0 g is skipped', async ({ page }) => {
  await page.route('https://api.anthropic.com/**', (route) => route.fulfill({ json: answer([
    item({ name: 'מאפה פלאפלוני', query: 'מאפה פלאפלוני', grams: 80, kcal_per_100g: 333 }),
    item({ name: 'מים', query: 'מים', grams: 0, kcal_per_100g: 0 }),
  ]) }));
  await withKey(page);
  await page.getByTestId('chat-input').fill('אכלתי מאפה פלאפלוני ושתיתי מים');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-item')).toHaveCount(1);
  await expect(page.getByTestId('chat-item')).toContainText('ערכים משוערים');
  const meal = await page.evaluate(async () => { const { mealForHour } = await import('./lib/calc.js'); return mealForHour(new Date().getHours()); });
  expect((await entries(page)).map((e) => [e.meal, e.kcal])).toEqual([[meal, 266]]);
});

test('chat: the newest reply\'s undo stays above the composer after several messages', async ({ page }) => {
  await page.route('https://api.anthropic.com/**', (route) => route.fulfill({ json: breakfast }));
  await withKey(page);
  for (let i = 0; i < 4; i++) {
    await page.getByTestId('chat-input').fill(`פיתה ${i}`);
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-reply')).toHaveCount(i + 1);
  }
  const hit = await page.getByTestId('chat-undo').last().evaluate((b) => {
    const r = b.getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === b;
  });
  expect(hit).toBe(true);
});

test('chat: speech that ends without a final result still sends what was heard', async ({ page }) => {
  await page.addInitScript(() => {
    window.SpeechRecognition = class {
      start() {
        setTimeout(() => {
          this.onresult?.({ results: [Object.assign([{ transcript: 'הבוקר אכלתי פיתה' }], { isFinal: false })] });
          setTimeout(() => this.onend?.(), 100);
        }, 50);
      }
      abort() {} stop() {}
    };
  });
  let body;
  await page.route('https://api.anthropic.com/**', (route) => { body = route.request().postDataJSON(); return route.fulfill({ json: breakfast }); });
  await withKey(page);
  await page.getByTestId('chat-mic').click();
  await expect(page.getByTestId('chat-item')).toHaveCount(2);
  expect(body.messages[0].content).toContain('הבוקר אכלתי פיתה');
});

test('chat: a correction replaces what the last message logged; undo brings it back', async ({ page }) => {
  const bodies = [];
  const replies = [
    answer([item({ name: 'שניצל', query: 'שניצל עוף', grams: 150, kcal_per_100g: 260, meal: 'dinner' })]),
    { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({
      items: [item({ name: 'שניצל ביתי', query: 'שניצל עוף ביתי', grams: 150, kcal_per_100g: 260, meal: 'dinner' })],
      reply: '', replaces_previous: true,
    }) }] },
  ];
  await page.route('https://api.anthropic.com/**', (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ json: replies[bodies.length - 1] });
  });
  await withKey(page);
  await page.getByTestId('chat-input').fill('שניצל 150 גרם בערב');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-item')).toHaveCount(1);

  await page.getByTestId('chat-input').fill('לא, שניצל ביתי');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-reply').last()).toContainText('עודכן ביומן');
  // Claude saw the first message and what it logged
  expect(bodies[1].messages[0].content).toMatch(/1\. "שניצל 150 גרם בערב" — נרשם: שניצל/);
  await expect(page.getByTestId('chat-reply').first()).toContainText('הוחלף');
  await expect(page.getByTestId('chat-item')).toHaveCount(1);
  let saved = await entries(page);
  expect(saved).toHaveLength(1);
  expect(saved[0].name).toMatch(/^שניצל חזה עוף/);   // the generic food, not a branded product

  // undoing the correction restores the original entry
  await page.getByTestId('chat-undo').click();
  await expect(page.getByTestId('chat-reply').last()).toContainText('בוטל');
  await expect(page.getByTestId('chat-item')).toHaveCount(1);
  saved = await entries(page);
  expect(saved).toHaveLength(1);
  // and the toast's undo puts the correction back
  await page.locator('#toast-undo').click();
  await expect(page.getByTestId('chat-reply').first()).toContainText('הוחלף');
  await expect.poll(async () => (await entries(page)).length).toBe(1);
});

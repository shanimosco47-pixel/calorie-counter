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
  let [e] = await entries(page);
  expect([e.meal, e.date]).toEqual(['dinner', yesterday]);

  await page.getByTestId('chat-edit').click();
  await expect(page.getByTestId('confirm-sheet')).toBeVisible();
  await page.getByTestId('amount').fill('300');
  await page.getByTestId('confirm-save').click();
  await expect(page.getByTestId('confirm-sheet')).toBeHidden();
  [e] = await entries(page);
  expect([e.date, e.grams]).toEqual([yesterday, 300]);
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

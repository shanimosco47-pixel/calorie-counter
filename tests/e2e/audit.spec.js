import { test, expect, open, addBySearch } from './helpers.js';

test('midnight while the app stays open: new entries go to the new day', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-02T20:00:00') });
  await open(page);
  await page.clock.setSystemTime(new Date('2026-11-03T08:00:00'));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByTestId('date-label')).not.toContainText('אתמול');
  await page.getByTestId('nav-add').click();
  await expect(page.getByTestId('pick-breakfast')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('search').fill('בננה');
  await page.getByTestId('result').first().click();
  await page.getByTestId('confirm-save').click();
  const saved = await page.evaluate(async () => { const { db } = await import('./lib/db.js'); return (await db.log.toArray()).map((e) => [e.date, e.meal]); });
  expect(saved).toEqual([['2026-11-03', 'breakfast']]);
});

test('Enter in the amount field saves; back returns to today instead of closing', async ({ page }) => {
  await open(page);
  await addBySearch(page, 'פיתה');
  await page.getByTestId('amount').fill('2');
  await page.getByTestId('amount').press('Enter');
  await expect(page.getByTestId('confirm-sheet')).toBeHidden();
  await expect(page.getByTestId('entry')).toHaveCount(1);
  await page.getByTestId('nav-history').click();
  await page.goBack();
  await expect(page.getByTestId('view-today')).toBeVisible();
});

test('a backup carrying markup in ids and numbers does not run it', async ({ page }) => {
  await open(page);
  const evil = 'x"><img src=x onerror="window.__pwned=1">';
  const today = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  const backup = { app: 'kalorit', version: 1, exportedAt: new Date().toISOString(),
    entries: [{ id: evil, date: today, meal: 'lunch', foodId: 't1', name: 'x', grams: 1, kcal: 1, p: 0, c: 0, f: 0, ts: 1 }],
    myFoods: [], favorites: [], weights: [], settings: [] };
  await page.getByTestId('nav-settings').click();
  page.once('dialog', (d) => d.accept());
  await page.getByTestId('import-input').setInputFiles({ name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await page.getByTestId('nav-today').click();
  await expect(page.getByTestId('entry')).toHaveCount(1);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
});

test('saved foods can be deleted, with undo', async ({ page }) => {
  await open(page);
  await page.getByTestId('nav-add').click();
  await page.getByTestId('open-new-food').click();
  await page.getByTestId('ff-name').fill('עוגה של סבתא');
  await page.getByTestId('ff-kcal').fill('300');
  await page.getByTestId('ff-save').click();
  await page.locator('#confirm-close').click();
  await page.getByRole('tab', { name: 'המזונות שלי' }).click();
  await expect(page.getByTestId('result')).toHaveCount(1);
  await page.getByTestId('del-food').click();
  await expect(page.getByTestId('result')).toHaveCount(0);
  await page.locator('#toast-undo').click();
  await expect(page.getByTestId('result')).toHaveCount(1);
});

import { readFileSync } from 'node:fs';
import { test, expect, open, addBySearch, num } from './helpers.js';

test('today screen: Hebrew RTL, target vs consumed, 4 meals, macro bars', async ({ page }) => {
  await open(page);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'he');
  await expect(page.getByTestId('target')).toHaveText('2,000');
  await expect(page.getByTestId('eaten')).toHaveText('0');
  for (const m of ['breakfast', 'lunch', 'dinner', 'snack']) await expect(page.getByTestId(`meal-${m}`)).toBeVisible();
  for (const k of ['p', 'c', 'f']) await expect(page.getByTestId(`macro-${k}`)).toBeVisible();
  // no horizontal scroll at S22 width
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});

test('add food: search -> amount -> confirmItems -> saved, totals update, persists after reload', async ({ page }) => {
  await open(page);
  await addBySearch(page, 'פיתה');
  await page.getByTestId('pick-lunch').isVisible();
  await page.getByTestId('unit').selectOption('g');
  await page.getByTestId('amount').fill('200');
  await page.getByTestId('confirm-meal').selectOption('lunch');
  const kcal = await num(page.getByTestId('confirm-total'));
  expect(kcal).toBeGreaterThan(300);
  await page.getByTestId('confirm-save').click();

  await expect(page.getByTestId('view-today')).toBeVisible();
  await expect(page.getByTestId('eaten')).toHaveText(kcal.toLocaleString('en-US'));
  await expect(page.getByTestId('meal-kcal-lunch')).toContainText(kcal.toLocaleString('en-US'));
  await expect(page.getByTestId('entry')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ready', '1');
  await expect(page.getByTestId('eaten')).toHaveText(kcal.toLocaleString('en-US'));
  await expect(page.getByTestId('entry')).toHaveCount(1);
});

test('household measure changes grams and calories', async ({ page }) => {
  await open(page);
  await addBySearch(page, 'פיתה');
  const unit = page.getByTestId('unit');
  const options = await unit.locator('option').allTextContents();
  expect(options.length).toBeGreaterThan(1);
  await unit.selectOption({ index: 1 });
  await page.getByTestId('amount').fill('2');
  await expect(page.getByTestId('item-kcal')).toContainText('גרם');
  const two = await num(page.getByTestId('confirm-total'));
  await page.getByTestId('amount').fill('1');
  const one = await num(page.getByTestId('confirm-total'));
  expect(Math.abs(two - 2 * one)).toBeLessThanOrEqual(1);
});

test('delete with undo', async ({ page }) => {
  await open(page);
  await addBySearch(page, 'שקשוקה');
  await page.getByTestId('confirm-save').click();
  await expect(page.getByTestId('entry')).toHaveCount(1);
  await page.locator('[data-del]').click();
  await expect(page.getByTestId('entry')).toHaveCount(0);
  await page.getByRole('button', { name: 'ביטול' }).click();
  await expect(page.getByTestId('entry')).toHaveCount(1);
});

test('barcode found in Open Food Facts goes through confirmItems', async ({ page }) => {
  await open(page);
  await page.getByTestId('nav-add').click();
  await page.getByTestId('open-scan').click();
  await page.getByTestId('barcode-input').fill('7290000066318');
  await page.getByTestId('barcode-go').click();
  await expect(page.getByTestId('confirm-sheet')).toBeVisible();
  await expect(page.getByTestId('confirm-sheet')).toContainText('במבה');
  await expect(page.getByTestId('unit')).toHaveValue('serving');
  await expect(page.getByTestId('confirm-total')).toHaveText('134');
  await page.getByTestId('confirm-save').click();
  await expect(page.getByTestId('eaten')).toHaveText('134');
});

test('unknown barcode opens "create product", saved to My Foods', async ({ page }) => {
  await open(page);
  await page.getByTestId('nav-add').click();
  await page.getByTestId('open-scan').click();
  await page.getByTestId('barcode-input').fill('7290099999999');
  await page.getByTestId('barcode-go').click();
  await expect(page.getByTestId('food-sheet')).toBeVisible();
  await expect(page.getByTestId('ff-barcode')).toHaveValue('7290099999999');
  await page.getByTestId('ff-name').fill('חטיף אנרגיה של השכונה');
  await page.getByTestId('ff-kcal').fill('400');
  await page.getByTestId('ff-p').fill('10');
  await page.getByTestId('ff-unit').fill('חטיף');
  await page.getByTestId('ff-unit-g').fill('30');
  await page.getByTestId('ff-save').click();
  await expect(page.getByTestId('confirm-sheet')).toBeVisible();
  await page.getByTestId('unit').selectOption('u1');
  await expect(page.getByTestId('confirm-total')).toHaveText('120');
  await page.getByTestId('confirm-save').click();
  await expect(page.getByTestId('eaten')).toHaveText('120');

  // saved to My Foods, and found again by barcode without the network
  await page.getByTestId('nav-add').click();
  await page.getByRole('tab', { name: 'המזונות שלי' }).click();
  await expect(page.getByTestId('results')).toContainText('חטיף אנרגיה של השכונה');
  await page.getByTestId('search').fill('חטיף אנרגיה');
  await expect(page.getByTestId('result').first()).toContainText('חטיף אנרגיה של השכונה');
});

test('re-log a recent food in 3 taps or fewer', async ({ page }) => {
  await open(page);
  await addBySearch(page, 'טחינה');
  await page.getByTestId('confirm-save').click();
  await expect(page.getByTestId('entry')).toHaveCount(1);
  const first = await num(page.getByTestId('eaten'));
  expect(first).toBeGreaterThan(0);

  // tap 1: the quick-add chip on the Today screen
  await page.getByTestId('quick-chip').first().click();
  await expect(page.getByTestId('entry')).toHaveCount(2);
  expect(await num(page.getByTestId('eaten'))).toBe(first * 2);
});

test('favorites list', async ({ page }) => {
  await open(page);
  await addBySearch(page, 'במבה');
  await page.getByTestId('star').click();
  await expect(page.getByTestId('star')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#confirm-sheet .icon-btn').click();
  await page.getByTestId('search').fill('');
  await page.getByRole('tab', { name: 'מועדפים' }).click();
  await expect(page.getByTestId('result')).toHaveCount(1);
  await expect(page.getByTestId('result')).toContainText('במבה');
  // tap the favorite, tap save: 2 taps from the Add screen
  await page.getByTestId('result').click();
  await page.getByTestId('confirm-save').click();
  await expect(page.getByTestId('entry')).toHaveCount(1);
});

test('history: 7 and 30 day chart, weight saved and charted', async ({ page }) => {
  await open(page);
  await addBySearch(page, 'בורקס');
  await page.getByTestId('confirm-save').click();
  await page.getByTestId('nav-history').click();
  await expect(page.getByTestId('kcal-chart')).toBeVisible();
  const bars = () => page.evaluate(() => Chart.getChart('kcal-chart')?.data.labels.length);
  await expect.poll(bars).toBe(7);
  await page.getByTestId('range-30').click();
  await expect(page.getByTestId('range-30')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(bars).toBe(30);
  expect(await page.evaluate(() => Chart.getChart('kcal-chart').data.datasets[0].data.at(-1))).toBeGreaterThan(0);

  await page.getByTestId('weight-input').fill('71.4');
  await page.getByTestId('weight-save').click();
  await expect(page.getByTestId('weight-row')).toContainText('71.4');
  await expect.poll(() => page.evaluate(() => Chart.getChart('weight-chart')?.data.datasets[0].data)).toEqual([71.4]);
  await page.reload();
  await page.getByTestId('nav-history').click();
  await expect(page.getByTestId('weight-row')).toContainText('71.4');
  await expect(page.getByTestId('day-list')).toContainText('קק״ל');
});

test('settings: computed target and manual target', async ({ page }) => {
  await open(page);
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('p-sex').selectOption('male');
  await page.getByTestId('p-age').fill('30');
  await page.getByTestId('p-height').fill('175');
  await page.getByTestId('p-weight').fill('70');
  await page.getByTestId('p-activity').selectOption('1.55');
  await page.getByTestId('p-goal').selectOption('-500');
  const expected = Math.round((1649 * 1.55 - 500) / 10) * 10;   // 2060
  await expect(page.getByTestId('calc-result')).toContainText(expected.toLocaleString('en-US'));
  await page.getByTestId('target-save').click();
  await page.getByTestId('nav-today').click();
  await expect(page.getByTestId('target')).toHaveText(expected.toLocaleString('en-US'));

  await page.getByTestId('nav-settings').click();
  await page.getByTestId('mode-manual').click();
  await page.getByTestId('manual-target').fill('1800');
  await page.getByTestId('target-save').click();
  await expect(page.locator('#toast-text')).toContainText('1,800');
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ready', '1');
  await expect(page.getByTestId('target')).toHaveText('1,800');
});

test('settings: export a backup and import it back', async ({ page }, info) => {
  await open(page);
  await addBySearch(page, 'פלאפל');
  await page.getByTestId('confirm-save').click();
  await expect(page.getByTestId('entry')).toHaveCount(1);
  const eaten = await page.getByTestId('eaten').textContent();

  await page.getByTestId('nav-settings').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-btn').click()]);
  expect(download.suggestedFilename()).toMatch(/^kalorit-backup-\d{4}-\d{2}-\d{2}\.json$/);
  const file = info.outputPath('backup.json');
  await download.saveAs(file);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  expect(data.app).toBe('kalorit');
  expect(data.entries).toHaveLength(1);

  // wipe, then restore
  await page.evaluate(async () => { const { db } = await import('./lib/db.js'); await db.log.clear(); });
  await page.getByTestId('nav-today').click();
  await expect(page.getByTestId('eaten')).toHaveText('0');
  await page.getByTestId('nav-settings').click();
  page.once('dialog', (d) => d.accept());
  await page.getByTestId('import-input').setInputFiles(file);
  await expect(page.locator('#toast-text')).toHaveText('הגיבוי שוחזר ✓');
  await page.getByTestId('nav-today').click();
  await expect(page.getByTestId('eaten')).toHaveText(eaten);
});

test('round-2 ready: hidden API key field, confirmItems is exposed', async ({ page }) => {
  await open(page);
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('api-key')).toBeHidden();
  await page.locator('#experimental summary').click();
  await expect(page.getByTestId('api-key')).toBeVisible();
  await expect(page.getByTestId('api-key')).toHaveAttribute('type', 'password');
  expect(await page.evaluate(() => typeof window.confirmItems)).toBe('function');
});

test('past days: navigate back and log to yesterday', async ({ page }) => {
  await open(page);
  await page.locator('#day-prev').click();
  await expect(page.getByTestId('date-label')).toContainText('אתמול');
  await page.getByTestId('add-dinner').click();
  await page.getByTestId('search').fill('שניצל');
  await page.getByTestId('result').first().click();
  await expect(page.getByTestId('confirm-meal')).toHaveValue('dinner');
  await page.getByTestId('confirm-save').click();
  await expect(page.getByTestId('entry')).toHaveCount(1);
  await page.getByTestId('date-label').click();   // back to today
  await expect(page.getByTestId('entry')).toHaveCount(0);
});

test('install button appears when Chrome allows installing and starts the install', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('install-card')).toBeHidden();
  await page.evaluate(() => {
    const e = new Event('beforeinstallprompt', { cancelable: true });
    e.prompt = async () => { window.__prompted = true; };
    e.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(e);
  });
  await expect(page.getByTestId('install-card')).toBeVisible();
  await page.getByTestId('install-btn').click();
  expect(await page.evaluate(() => window.__prompted)).toBe(true);
  await expect(page.getByTestId('install-card')).toBeHidden();
});

test('egg dishes are measured in eggs', async ({ page }) => {
  await open(page);
  await page.getByTestId('nav-add').click();
  await page.getByTestId('search').fill('חביתה בשמן זית');
  await page.getByTestId('result').first().click();
  await expect(page.getByTestId('confirm-sheet')).toContainText('חביתה מטוגנת בשמן זית');
  await expect(page.getByTestId('unit')).toHaveValue('egg');
  await expect(page.getByTestId('unit').locator('option:checked')).toContainText('ביצה');
  await expect(page.getByTestId('amount')).toHaveValue('2');
  await expect(page.getByTestId('confirm-total')).toHaveText('178');      // 2 x 46 g x 194 kcal/100 g
  await page.getByTestId('amount').fill('3');
  await expect(page.getByTestId('confirm-total')).toHaveText('268');
  await page.getByTestId('confirm-save').click();
  await expect(page.getByTestId('entry')).toContainText('3 × ביצה');
});

test('editing an entry whose unit this device does not know keeps its grams', async ({ page }) => {
  await open(page);
  // an entry synced from a newer version, in a unit missing from this food's data
  await page.evaluate(async () => {
    const { put } = await import('./lib/db.js');
    const { isoDate } = await import('./lib/calc.js');
    await put('entries', { id: 'efuture', date: isoDate(), meal: 'lunch', foodId: 't1561', name: 'ביצה שלמה בלי קליפה',
      amount: 3, unit: 'futureunit', grams: 111, kcal: 159, p: 14, c: 1, f: 11, ts: Date.now() });
  });
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ready', '1');
  await page.locator('[data-edit="efuture"]').click();
  await expect(page.getByTestId('unit')).toHaveValue('g');
  await expect(page.getByTestId('amount')).toHaveValue('111');
  await page.getByTestId('confirm-save').click();
  await expect(page.getByTestId('eaten')).toHaveText('159');
});

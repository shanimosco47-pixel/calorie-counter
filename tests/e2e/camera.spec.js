import { test, expect, open } from './helpers.js';

// Chromium's fake camera stands in for the phone's: a moving test pattern, permission granted.
test.use({
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
  permissions: ['camera'],
});

const reply = { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ items: [
  { name: 'אורז לבן', query: 'אורז לבן מבושל', grams: 150, kcal_per_100g: 130, protein_per_100g: 2.7, carbs_per_100g: 28, fat_per_100g: 0.3 },
] }) }] };

async function withKey(page) {
  await open(page);
  await page.evaluate(async () => { const { setSetting } = await import('./lib/db.js'); await setSetting('apiKey', 'sk-ant-test'); });
  await page.getByTestId('nav-add').click();
}

test('in-app camera: shoot, recognize, confirm; nothing is stored', async ({ page }) => {
  let body;
  await page.route('https://api.anthropic.com/**', (route) => { body = route.request().postDataJSON(); return route.fulfill({ json: reply }); });
  await withKey(page);
  await page.getByTestId('open-camera').click();
  await expect(page.getByTestId('camera')).toBeVisible();
  await expect.poll(() => page.locator('#camera').evaluate((v) => v.videoWidth)).toBeGreaterThan(0);
  await page.getByTestId('shutter').click();

  await expect(page.getByTestId('confirm-sheet')).toBeVisible();
  expect(body.messages[0].content[0].source.data.length).toBeGreaterThan(1000);
  await expect(page.locator('#confirm-items .confirm-item')).toHaveCount(1);
  // the camera is off and the photo is gone from the page
  expect(await page.evaluate(() => document.querySelector('#camera').srcObject)).toBeNull();
  await expect(page.locator('#photo-preview')).not.toHaveAttribute('src', /./);
  // and nothing photo-like was written to the database
  const stored = await page.evaluate(async () => {
    const { dumpAll } = await import('./lib/db.js');
    return JSON.stringify(await dumpAll());
  });
  expect(stored).not.toContain('data:image');
  expect(stored).not.toContain(body.messages[0].content[0].source.data.slice(0, 200));
});

test('in-app camera: closing the sheet turns the camera off', async ({ page }) => {
  await withKey(page);
  await page.getByTestId('open-camera').click();
  await expect.poll(() => page.locator('#camera').evaluate((v) => v.videoWidth)).toBeGreaterThan(0);
  await page.locator('#photo-close').click();
  await expect(page.getByTestId('photo-sheet')).toBeHidden();
  expect(await page.evaluate(() => document.querySelector('#camera').srcObject)).toBeNull();
});

test('no camera access: offers the phone camera app instead', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
  });
  await withKey(page);
  await page.getByTestId('open-camera').click();
  await expect(page.getByTestId('photo-status')).toContainText('אין גישה למצלמה');
  await expect(page.getByTestId('camera-app')).toBeVisible();
  await expect(page.getByTestId('camera-input')).toHaveAttribute('capture', 'environment');
});

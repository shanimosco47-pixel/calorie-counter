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

// Records every camera stream the page gets, and makes the camera slow to start like a cold phone camera.
function slowCamera(page, delayMs = 800) {
  return page.addInitScript((delay) => {
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.__streams = [];
    navigator.mediaDevices.getUserMedia = async (c) => {
      const s = await real(c);
      window.__streams.push(s);
      await new Promise((r) => setTimeout(r, delay));
      return s;
    };
  }, delayMs);
}
const liveTracks = (page) => page.evaluate(() => window.__streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length);

test('camera closed while still starting, reopened, closed: no camera left running', async ({ page }) => {
  await slowCamera(page);
  await withKey(page);
  await page.getByTestId('open-camera').click();
  await page.locator('#photo-close').click();           // close while the camera is starting
  await page.getByTestId('open-camera').click();
  await expect(page.getByTestId('shutter')).toBeVisible();
  await page.locator('#photo-close').click();
  await page.waitForTimeout(1200);                       // let any late start resolve
  expect(await liveTracks(page)).toBe(0);
  await expect(page.getByTestId('photo-sheet')).toBeHidden();
});

test('gallery pick while the camera is starting: the late camera never shows up', async ({ page }) => {
  await page.route('https://api.anthropic.com/**', async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.fulfill({ json: reply }); });
  await slowCamera(page);
  await withKey(page);
  await page.getByTestId('open-camera').click();
  await page.locator('#photo-close').click();
  await page.getByTestId('photo-input').setInputFiles({ name: 'meal.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') });
  await page.waitForTimeout(1000);
  await expect(page.getByTestId('shutter')).toBeHidden();
  await expect(page.getByTestId('photo-status')).toContainText('מזהה');
  await expect(page.getByTestId('confirm-sheet')).toBeVisible();
  expect(await liveTracks(page)).toBe(0);
});

test('sheet closed without a cancel event (Android back gesture): camera off', async ({ page }) => {
  await slowCamera(page, 0);
  await withKey(page);
  await page.getByTestId('open-camera').click();
  await expect(page.getByTestId('shutter')).toBeVisible();
  await page.evaluate(() => document.querySelector('#photo-sheet').close());
  await expect.poll(() => liveTracks(page)).toBe(0);
});

test('camera stopped by the system: the shutter never sends a frozen frame', async ({ page }) => {
  let requests = 0;
  await page.route('https://api.anthropic.com/**', (route) => { requests++; return route.fulfill({ json: reply }); });
  await slowCamera(page, 0);
  await withKey(page);
  await page.getByTestId('open-camera').click();
  await expect(page.getByTestId('shutter')).toBeVisible();
  // a track that ends on its own: stop() does not fire "ended", so simulate the system ending it
  await page.evaluate(() => {
    const t = document.querySelector('#camera').srcObject.getVideoTracks()[0];
    t.stop(); t.dispatchEvent(new Event('ended'));
  });
  await expect(page.getByTestId('shutter')).toBeVisible();   // restarted with a fresh camera
  await page.getByTestId('shutter').click();
  await expect(page.getByTestId('confirm-sheet')).toBeVisible();
  expect(requests).toBe(1);
  expect(await liveTracks(page)).toBe(0);
});

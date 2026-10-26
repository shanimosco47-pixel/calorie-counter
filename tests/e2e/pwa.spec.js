import { test as base, expect } from '@playwright/test';

const test = base.extend({});
test.use({ serviceWorkers: 'allow' });

test('manifest is valid for installation', async ({ request }) => {
  const res = await request.get('/manifest.webmanifest');
  expect(res.ok()).toBe(true);
  const m = await res.json();
  expect(m.name).toBeTruthy();
  expect(m.short_name).toBe('קלורית');
  expect(m.dir).toBe('rtl');
  expect(m.lang).toBe('he');
  expect(m.display).toBe('standalone');
  expect(m.id).toBe('/calorie-counter/');
  expect(m.start_url).toBe('/calorie-counter/');
  expect(m.scope).toBe('/calorie-counter/');
  const sizes = m.icons.map((i) => i.sizes);
  expect(sizes).toContain('192x192');
  expect(sizes).toContain('512x512');
  for (const icon of m.icons) {
    const r = await request.get('/' + icon.src);
    expect(r.ok(), icon.src).toBe(true);
    expect(r.headers()['content-type']).toContain('image/png');
  }
});

test('service worker registers and the app works offline', async ({ page, context }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-ready', '1');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  // wait until the shell is fully cached
  await expect.poll(() => page.evaluate(async () => {
    const keys = await caches.keys();
    if (!keys.length) return 0;
    return (await (await caches.open(keys[0])).keys()).length;
  })).toBeGreaterThanOrEqual(15);

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ready', '1');
  await page.getByTestId('nav-add').click();
  await page.getByTestId('search').fill('חומוס');
  await expect(page.getByTestId('result').first()).toBeVisible();
  await page.getByTestId('result').first().click();
  await page.getByTestId('confirm-save').click();
  await expect(page.getByTestId('entry')).toHaveCount(1);
  expect(errors).toEqual([]);
});

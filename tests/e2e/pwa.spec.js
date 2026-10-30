import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const test = base.extend({});
test.use({ serviceWorkers: 'allow' });

test('manifest is valid for installation', async ({ request }) => {
  const res = await request.get('/kalorit.webmanifest');
  expect(res.ok()).toBe(true);
  const m = await res.json();
  expect(m.name).toBeTruthy();
  expect(m.short_name).toBe('קלורית');
  expect(m.dir).toBe('rtl');
  expect(m.lang).toBe('he');
  expect(m.display).toBe('standalone');
  expect(m.id).toBe('./');
  expect(m.start_url).toBe('./?source=pwa');
  expect(m.scope).toBe('./');
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

test('an updated page and manifest reach the phone on the next open', async ({ page }, info) => {
  // serve a private copy of the site so the test can change files on disk, like a real deploy
  const root = info.outputPath('site');
  fs.mkdirSync(root, { recursive: true });
  for (const f of ['index.html', 'app.js', 'styles.css', 'sw.js', 'kalorit.webmanifest', 'build-info.js', 'version.json', 'lib', 'vendor', 'data', 'icons']) {
    fs.cpSync(f, path.join(root, f), { recursive: true });
  }
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
  const server = http.createServer((req, res) => {
    const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
    if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }).end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}/`;
  try {
    await page.goto(base);
    await expect(page.locator('body')).toHaveAttribute('data-ready', '1');
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);

    const html = path.join(root, 'index.html');
    fs.writeFileSync(html, fs.readFileSync(html, 'utf8').replace('<title>קלורית</title>', '<title>קלורית v2</title>'));
    const man = path.join(root, 'kalorit.webmanifest');
    fs.writeFileSync(man, fs.readFileSync(man, 'utf8').replace('"short_name": "קלורית"', '"short_name": "קלורית v2"'));

    await page.reload();
    await expect(page).toHaveTitle('קלורית v2');
    expect((await page.evaluate(() => fetch('kalorit.webmanifest').then((r) => r.json()))).short_name).toBe('קלורית v2');
  } finally {
    server.close();
  }
});

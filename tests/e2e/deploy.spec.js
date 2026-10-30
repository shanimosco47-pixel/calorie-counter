// Simulates GitHub Pages: the site is served under /calorie-counter/, built by scripts/build_site.sh.
// Covers the upgrade from the old layout (app at the folder root) to the new one (app/ + redirect).
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };

function pagesServer() {
  let root = null;
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (!p.startsWith('/calorie-counter/')) { res.writeHead(404).end(); return; }
    p = p.slice('/calorie-counter'.length);
    let file = path.join(root, p);
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      if (!p.endsWith('/')) { res.writeHead(301, { Location: req.url.split('?')[0] + '/' }).end(); return; }
      file = path.join(file, 'index.html');
    }
    if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(fs.readFileSync(file));
  });
  return {
    serve(dir) { root = dir; },
    async start() { await new Promise((r) => server.listen(0, r)); return `http://localhost:${server.address().port}/calorie-counter/`; },
    stop() { server.close(); },
  };
}

test.use({ serviceWorkers: 'allow', viewport: { width: 360, height: 780 } });

test('upgrade from the old layout keeps data, retires the old worker, and the link still works', async ({ page }, info) => {
  // old layout = what is live before this change (app files at the folder root)
  const oldDir = info.outputPath('old');
  fs.mkdirSync(oldDir, { recursive: true });
  execFileSync('bash', ['-c', `git archive 9e10732 index.html app.js styles.css sw.js kalorit.webmanifest lib vendor data icons | tar -x -C "${oldDir}"`]);
  const newDir = info.outputPath('new');
  execFileSync('scripts/build_site.sh', [newDir]);

  const srv = pagesServer();
  const base = await srv.start();
  try {
    // 1. old version: log a food, another app on the origin has its own cache
    srv.serve(oldDir);
    await page.goto(base);
    await expect(page.locator('body')).toHaveAttribute('data-ready', '1');
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.evaluate(() => caches.open('workbox-precache-hey-usa').then((c) => c.put('/hey-usa/x', new Response('keep'))));
    await page.getByTestId('nav-add').click();
    await page.getByTestId('search').fill('פיתה');
    await page.getByTestId('result').first().click();
    await page.getByTestId('confirm-save').click();
    await expect(page.getByTestId('entry')).toHaveCount(1);

    // 2. deploy the new layout; the user opens the same link
    srv.serve(newDir);
    await page.goto(base);
    await expect(page).toHaveURL(base + 'app/');
    await expect(page.locator('body')).toHaveAttribute('data-ready', '1');
    await expect(page.getByTestId('entry')).toHaveCount(1);            // same origin, same data

    // 3. the old root worker is gone; the app's worker owns only app/
    await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope).sort()))
      .toEqual([base + 'app/']);
    expect(await page.evaluate(() => caches.has('workbox-precache-hey-usa'))).toBe(true);

    // 4. manifest: install identity is the new folder
    const href = await page.locator('link[rel=manifest]').getAttribute('href');
    const manifestUrl = new URL(href, page.url()).href;
    const m = await (await page.request.get(manifestUrl)).json();
    for (const k of ['id', 'start_url', 'scope']) expect(new URL(m[k], manifestUrl).pathname, k).toMatch(/^\/calorie-counter\/app\//);
    for (const icon of m.icons) expect((await page.request.get(new URL(icon.src, manifestUrl).href)).ok(), icon.src).toBe(true);

    // 5. the redirect page itself is not installable as a separate app
    const root = await page.request.get(base);
    expect(await root.text()).not.toContain('rel="manifest"');
  } finally {
    srv.stop();
  }
});

test('opening the app after a deploy updates it automatically and shows the update time', async ({ page }, info) => {
  const build = (name, commit, time) => {
    const dir = info.outputPath(name);
    execFileSync('scripts/build_site.sh', [dir], { env: { ...process.env, BUILD_COMMIT: commit, BUILD_TIME: time } });
    return dir;
  };
  const a = build('a', 'aaa1111', '2026-10-30T08:00:00Z');
  const b = build('b', 'bbb2222', '2026-10-30T20:15:00Z');
  const shown = (iso) => page.evaluate((t) => {
    const d = new Date(t);
    return d.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: 'numeric' })
      + ' ' + d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  }, iso);

  const srv = pagesServer();
  const base = await srv.start();
  try {
    // version A is installed and has data
    srv.serve(a);
    await page.goto(base + 'app/');
    await expect(page.locator('body')).toHaveAttribute('data-ready', '1');
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.getByTestId('nav-add').click();
    await page.getByTestId('search').fill('פיתה');
    await page.getByTestId('result').first().click();
    await page.getByTestId('confirm-save').click();
    await page.getByTestId('nav-settings').click();
    await expect(page.getByTestId('app-built')).toHaveText(await shown('2026-10-30T08:00:00Z'));
    await page.getByTestId('check-update').click();
    await expect(page.locator('#toast-text')).toContainText('מעודכנת');

    // version B is deployed; the user opens the app again
    srv.serve(b);
    await page.goto(base + 'app/');
    await expect(page.locator('#toast-text')).toContainText('עודכנה', { timeout: 15000 });
    expect(await page.evaluate(async () => (await import('./build-info.js')).BUILD.commit)).toBe('bbb2222');
    await page.getByTestId('nav-settings').click();
    await expect(page.getByTestId('app-built')).toHaveText(await shown('2026-10-30T20:15:00Z'));
    await page.getByTestId('nav-today').click();
    await expect(page.getByTestId('entry')).toHaveCount(1);                 // data kept

    // opening again: already current, no further reload
    let reloads = 0;
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) reloads++; });
    await page.goto(base + 'app/');
    await expect(page.locator('body')).toHaveAttribute('data-ready', '1');
    await page.waitForTimeout(1500);
    expect(reloads).toBe(1);
  } finally {
    srv.stop();
  }
});

test('offline: the app opens and does not try to update', async ({ page, context }, info) => {
  const dir = info.outputPath('site');
  execFileSync('scripts/build_site.sh', [dir], { env: { ...process.env, BUILD_COMMIT: 'ccc3333', BUILD_TIME: '2026-10-30T09:00:00Z' } });
  const srv = pagesServer();
  const base = await srv.start();
  try {
    srv.serve(dir);
    await page.goto(base + 'app/');
    await expect(page.locator('body')).toHaveAttribute('data-ready', '1');
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await expect.poll(() => page.evaluate(async () => (await caches.keys()).includes('kalorit-app-ccc3333'))).toBe(true);
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('body')).toHaveAttribute('data-ready', '1');
    await page.getByTestId('nav-settings').click();
    await page.getByTestId('check-update').click();
    await expect(page.locator('#toast-text')).toContainText('אין חיבור');
  } finally {
    srv.stop();
  }
});

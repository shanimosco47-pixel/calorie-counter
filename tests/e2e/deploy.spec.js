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
  const overrides = new Map();   // path under /calorie-counter/ -> directory serving that one file
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (!p.startsWith('/calorie-counter/')) { res.writeHead(404).end(); return; }
    p = p.slice('/calorie-counter'.length);
    let file = path.join(overrides.get(p) || root, p);
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      if (!p.endsWith('/')) { res.writeHead(301, { Location: req.url.split('?')[0] + '/' }).end(); return; }
      file = path.join(file, 'index.html');
    }
    if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'max-age=600',          // what GitHub Pages sends
    }).end(fs.readFileSync(file));
  });
  return {
    serve(dir) { root = dir; overrides.clear(); },
    override(p, dir) { overrides.set(p, dir); },
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

const build = (info, name, version, time) => {
  const dir = info.outputPath(name);
  execFileSync('scripts/build_site.sh', [dir], { env: { ...process.env, BUILD_VERSION: version, BUILD_TIME: time } });
  return dir;
};
const runningVersion = (page) => page.evaluate(async () => (await import('./build-info.js')).BUILD.version);
async function openApp(page, url) {
  await page.goto(url);
  await expect(page.locator('body')).toHaveAttribute('data-ready', '1');
}
async function logPita(page) {
  await page.getByTestId('nav-add').click();
  await page.getByTestId('search').fill('פיתה');
  await page.getByTestId('result').first().click();
  await page.getByTestId('confirm-save').click();
  await expect(page.getByTestId('view-today')).toBeVisible();
}
function setVisibility(page, v) {
  return page.evaluate((vis) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => vis });
    document.dispatchEvent(new Event('visibilitychange'));
  }, v);
}
function countReloads(page) {
  let n = 0;
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) n++; });
  return () => n;
}

test('opening the app after a deploy updates it automatically and shows the update time', async ({ page }, info) => {
  const a = build(info, 'a', 'aaaa1111', '2026-10-30T08:00:00Z');
  const b = build(info, 'b', 'bbbb2222', '2026-10-30T20:15:00Z');
  const shown = (iso) => page.evaluate((t) => {
    const d = new Date(t);
    return d.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: 'numeric' })
      + ' ' + d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  }, iso);
  const srv = pagesServer();
  const base = await srv.start();
  try {
    srv.serve(a);
    await openApp(page, base + 'app/');
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await logPita(page);
    await page.getByTestId('nav-settings').click();
    await expect(page.getByTestId('app-built')).toHaveText(await shown('2026-10-30T08:00:00Z'));
    await page.getByTestId('check-update').click();
    await expect(page.locator('#toast-text')).toContainText('מעודכנת');

    srv.serve(b);
    await page.goto(base + 'app/');
    await expect.poll(() => runningVersion(page), { timeout: 20000 }).toBe('bbbb2222');
    await expect(page.locator('#toast-text')).toContainText('עודכנה');
    await page.getByTestId('nav-settings').click();
    await expect(page.getByTestId('app-built')).toHaveText(await shown('2026-10-30T20:15:00Z'));
    await page.getByTestId('nav-today').click();
    await expect(page.getByTestId('entry')).toHaveCount(1);                 // data kept

    const reloads = countReloads(page);                                      // already current: no loop
    await openApp(page, base + 'app/');
    await page.waitForTimeout(1500);
    expect(reloads()).toBe(1);
  } finally {
    srv.stop();
  }
});

test('partial deploy (new version.json, old app files): no false "updated", retries and succeeds later', async ({ page }, info) => {
  const a = build(info, 'a', 'aaaa1111', '2026-10-30T08:00:00Z');
  const b = build(info, 'b', 'bbbb2222', '2026-10-30T20:15:00Z');
  const srv = pagesServer();
  const base = await srv.start();
  try {
    srv.serve(a);
    await openApp(page, base + 'app/');
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);

    srv.override('/app/version.json', b);                  // CDN already has the new version.json only
    const reloads = countReloads(page);
    await openApp(page, base + 'app/');
    await page.waitForTimeout(12000);                      // the updater gives up waiting for a new worker
    expect(await runningVersion(page)).toBe('aaaa1111');
    expect(reloads()).toBe(1);                             // just our own navigation: no reload
    await expect(page.locator('#toast-text')).not.toContainText('עודכנה');

    srv.serve(b);                                          // the rest of the deploy arrives
    await page.getByTestId('nav-settings').click();
    await page.getByTestId('check-update').click();        // manual check ignores the retry cooldown
    await expect.poll(() => runningVersion(page), { timeout: 20000 }).toBe('bbbb2222');
    await expect(page.locator('#toast-text')).toContainText('עודכנה');
  } finally {
    srv.stop();
  }
});

test('an update never reloads over an open "add food" window; it waits until the app is in the background', async ({ page }, info) => {
  const a = build(info, 'a', 'aaaa1111', '2026-10-30T08:00:00Z');
  const b = build(info, 'b', 'bbbb2222', '2026-10-30T20:15:00Z');
  const srv = pagesServer();
  const base = await srv.start();
  try {
    srv.serve(a);
    await openApp(page, base + 'app/');
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.getByTestId('nav-add').click();
    await page.getByTestId('search').fill('פיתה');
    await page.getByTestId('result').first().click();
    await page.getByTestId('unit').selectOption('g');
    await page.getByTestId('amount').fill('137');

    srv.serve(b);                                          // deploy while the user is choosing an amount
    await setVisibility(page, 'hidden');                   // switches away to read the label...
    await setVisibility(page, 'visible');                  // ...and comes back: the update check runs
    await page.waitForTimeout(4000);
    await expect(page.getByTestId('confirm-sheet')).toBeVisible();
    await expect(page.getByTestId('amount')).toHaveValue('137');
    expect(await runningVersion(page)).toBe('aaaa1111');

    await page.getByTestId('confirm-save').click();        // the save completes on the old version
    await expect(page.getByTestId('entry')).toHaveCount(1);
    await setVisibility(page, 'hidden');                   // background: the deferred update applies now
    await expect.poll(() => runningVersion(page).catch(() => null), { timeout: 20000 }).toBe('bbbb2222');
    await expect(page.getByTestId('entry')).toHaveCount(1);
  } finally {
    srv.stop();
  }
});

test('offline: the app opens normally and does not reload', async ({ page, context }, info) => {
  const dir = build(info, 'site', 'cccc3333', '2026-10-30T09:00:00Z');
  const srv = pagesServer();
  const base = await srv.start();
  try {
    srv.serve(dir);
    await openApp(page, base + 'app/');
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await expect.poll(() => page.evaluate(async () => (await caches.keys()).includes('kalorit-app-cccc3333'))).toBe(true);
    await context.setOffline(true);
    const reloads = countReloads(page);
    await page.reload();
    await expect(page.locator('body')).toHaveAttribute('data-ready', '1');
    await page.waitForTimeout(1500);
    expect(reloads()).toBe(1);
    await page.getByTestId('nav-settings').click();
    await page.getByTestId('check-update').click();
    await expect(page.locator('#toast-text')).toContainText('אין חיבור');
  } finally {
    srv.stop();
  }
});

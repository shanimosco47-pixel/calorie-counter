import { test, expect } from '@playwright/test';

// A tiny stand-in for the Supabase sync_push / sync_pull functions (same last-write-wins rule).
function fakeServer() {
  const rows = new Map();
  let clock = 0;
  return {
    down: false,
    async attach(context) {
      await context.route('https://*.supabase.co/rest/v1/rpc/*', async (route) => {
        if (this.down) return route.fulfill({ status: 503, json: { message: 'Service Unavailable' } });
        const fn = route.request().url().split('/').pop();
        const body = route.request().postDataJSON();
        expect(route.request().headers().apikey).toMatch(/^sb_publishable_/);
        if (body.p_code.length < 24) return route.fulfill({ status: 400, json: { message: 'invalid sync code' } });
        if (fn === 'sync_push') {
          for (const r of body.p_rows) {
            const key = `${body.p_code}|${r.kind}|${r.id}`;
            const cur = rows.get(key);
            if (!cur || r.ts >= cur.ts) rows.set(key, { ...r, code: body.p_code, updated_at: new Date(Date.UTC(2026, 0, 1) + ++clock * 1000).toISOString() });
          }
          return route.fulfill({ json: body.p_rows.length });
        }
        const out = [...rows.values()]
          .filter((r) => r.code === body.p_code && (!body.p_since || r.updated_at > body.p_since))
          .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
          .map(({ kind, id, data, ts, updated_at }) => ({ kind, id, data, ts, updated_at }));
        return route.fulfill({ json: out });
      });
    },
  };
}

async function openApp(browser, server) {
  const context = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  await server.attach(context);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('503')) errors.push(m.text()); });
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-ready', '1');
  return { page, context, errors };
}

async function logFood(page, query) {
  await page.getByTestId('nav-add').click();
  await page.getByTestId('search').fill(query);
  await page.getByTestId('result').first().click();
  await page.getByTestId('confirm-save').click();
  await expect(page.getByTestId('view-today')).toBeVisible();
}

test('two phones share data through a sync code', async ({ browser }) => {
  const server = fakeServer();
  const a = await openApp(browser, server);
  const b = await openApp(browser, server);

  // phone A: log food, set a target, turn on sync
  await logFood(a.page, 'פיתה');
  await a.page.getByTestId('nav-settings').click();
  await a.page.getByTestId('mode-manual').click();
  await a.page.getByTestId('manual-target').fill('1750');
  await a.page.getByTestId('target-save').click();
  await a.page.getByTestId('sync-create').click();
  await expect(a.page.getByTestId('sync-status')).toContainText('מסונכרן');
  const code = (await a.page.getByTestId('sync-code').textContent()).trim();
  expect(code).toMatch(/^([2-9A-HJ-NP-Z]{4}-){5}[2-9A-HJ-NP-Z]{4}$/);

  // phone B: has its own entry, joins with the code (typed loosely)
  await logFood(b.page, 'שקשוקה');
  await b.page.getByTestId('nav-settings').click();
  await b.page.getByTestId('sync-join-open').click();
  await b.page.getByTestId('sync-join-code').fill(code.toLowerCase().replace(/-/g, ' '));
  await b.page.getByTestId('sync-join').click();
  await expect(b.page.getByTestId('sync-status')).toContainText('מסונכרן');
  await b.page.getByTestId('nav-today').click();
  await expect(b.page.getByTestId('entry')).toHaveCount(2);
  await expect(b.page.getByTestId('target')).toHaveText('1,750');

  // A pulls B's entry
  await a.page.getByTestId('sync-now').click();
  await a.page.getByTestId('nav-today').click();
  await expect(a.page.getByTestId('entry')).toHaveCount(2);

  // delete on B -> gone on A (B syncs by itself after the change)
  await b.page.locator('[data-del]').first().click();
  await expect(b.page.getByTestId('entry')).toHaveCount(1);
  await expect.poll(async () => (await b.page.evaluate(() => window.kaloritSync.status())).pending, { timeout: 8000 }).toBe(0);
  await a.page.getByTestId('nav-settings').click();
  await a.page.getByTestId('sync-now').click();
  await a.page.getByTestId('nav-today').click();
  await expect(a.page.getByTestId('entry')).toHaveCount(1);

  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
  await a.context.close();
  await b.context.close();
});

test('server down: changes wait and go out when it is back', async ({ browser }) => {
  const server = fakeServer();
  const a = await openApp(browser, server);
  await a.page.getByTestId('nav-settings').click();
  await a.page.getByTestId('sync-create').click();
  await expect(a.page.getByTestId('sync-status')).toContainText('מסונכרן');
  const code = (await a.page.getByTestId('sync-code').textContent()).trim();

  server.down = true;
  await logFood(a.page, 'במבה');
  await a.page.getByTestId('nav-settings').click();
  await a.page.getByTestId('sync-now').click();
  await expect(a.page.getByTestId('sync-status')).toContainText('לא סונכרן');

  server.down = false;
  await a.page.getByTestId('sync-now').click();
  await expect(a.page.getByTestId('sync-status')).toContainText('מסונכרן');

  const b = await openApp(browser, server);
  await b.page.getByTestId('nav-settings').click();
  await b.page.getByTestId('sync-join-open').click();
  await b.page.getByTestId('sync-join-code').fill(code);
  await b.page.getByTestId('sync-join').click();
  await b.page.getByTestId('nav-today').click();
  await expect(b.page.getByTestId('entry')).toHaveCount(1);
  await expect(b.page.getByTestId('entry')).toContainText('במבה');

  // disconnect keeps local data
  await b.page.getByTestId('nav-settings').click();
  b.page.once('dialog', (d) => d.accept());
  await b.page.getByTestId('sync-disconnect').click();
  await expect(b.page.getByTestId('sync-create')).toBeVisible();
  await b.page.getByTestId('nav-today').click();
  await expect(b.page.getByTestId('entry')).toHaveCount(1);
  await a.context.close();
  await b.context.close();
});

test('invalid code is rejected in the UI', async ({ browser }) => {
  const server = fakeServer();
  const a = await openApp(browser, server);
  await a.page.getByTestId('nav-settings').click();
  await a.page.getByTestId('sync-join-open').click();
  await a.page.getByTestId('sync-join-code').fill('1234');
  await a.page.getByTestId('sync-join').click();
  await expect(a.page.locator('#toast-text')).toHaveText('קוד סנכרון לא תקין');
  await expect(a.page.getByTestId('sync-create')).toBeVisible();
  await a.context.close();
});

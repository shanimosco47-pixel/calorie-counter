import { test as base, expect } from '@playwright/test';

// Fails the test on any console error or uncaught exception (criterion: no console errors).
export const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on('console', (m) => {
      // a 404 from Open Food Facts is the normal "unknown product" answer, and a 401 from the
      // Claude API a wrong key the app explains: browser network logs, not app errors
      const url = m.location().url;
      if (m.type() === 'error' && !url.includes('openfoodfacts.org') && !url.includes('api.anthropic.com')) errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(e.message));
    // Open Food Facts is not reachable from CI; answer with fixtures. Real lookups run on the phone.
    await page.route('https://world.openfoodfacts.org/**', (route) => {
      const url = route.request().url();
      if (url.includes('/7290000066318.json')) {
        return route.fulfill({ json: { status: 1, product: {
          product_name_he: 'במבה', brands: 'אסם', serving_quantity: 25,
          nutriments: { 'energy-kcal_100g': 534, proteins_100g: 15, carbohydrates_100g: 39, fat_100g: 35 },
        } } });
      }
      return route.fulfill({ status: 404, json: { status: 0 } });
    });
    await use(page);
    expect(errors, 'console errors').toEqual([]);
  },
});
export { expect };

export async function open(page) {
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-ready', '1');
}

export async function addBySearch(page, query, { pick = 0 } = {}) {
  await page.getByTestId('nav-add').click();
  await page.getByTestId('search').fill(query);
  await page.getByTestId('result').nth(pick).click();
  await expect(page.getByTestId('confirm-sheet')).toBeVisible();
}

export const num = async (loc) => Number((await loc.textContent()).replace(/[^\d.-]/g, ''));

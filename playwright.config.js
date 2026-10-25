import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30000,
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4174',
    viewport: { width: 360, height: 780 },   // Samsung Galaxy S22 CSS viewport
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    locale: 'he-IL',
    acceptDownloads: true,
    serviceWorkers: 'block',
  },
  webServer: {
    command: 'python3 -m http.server 4174',
    url: 'http://localhost:4174/index.html',
    reuseExistingServer: true,
  },
});

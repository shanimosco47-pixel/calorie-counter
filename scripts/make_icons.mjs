// Renders the app icons with the preinstalled Chromium. Usage: node scripts/make_icons.mjs
import { chromium } from '@playwright/test';

const svg = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${pad ? 0 : 112}" fill="#0f766e"/>
  <g transform="translate(256 262) scale(${pad ? 0.72 : 0.92})">
    <circle r="150" fill="none" stroke="#d6efeb" stroke-width="34" opacity=".35"/>
    <path d="M0 -150 A150 150 0 1 1 -129.9 75" fill="none" stroke="#ffffff" stroke-width="34" stroke-linecap="round"/>
    <path d="M-40 -70 v60 a40 40 0 0 0 80 0 v-60 M0 -70 v170" fill="none" stroke="#ffffff" stroke-width="22" stroke-linecap="round"/>
  </g>
</svg>`;

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [file, size, pad] of [['icon-192.png', 192, false], ['icon-512.png', 512, false], ['icon-maskable-512.png', 512, true]]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg(pad).replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: `icons/${file}`, omitBackground: true });
}
await browser.close();
console.log('icons written');

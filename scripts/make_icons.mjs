// Renders the app icons with the preinstalled Chromium. Usage: node scripts/make_icons.mjs
// A plate with an apple, fork and knife: reads as "food / calories" at home-screen size.
import { chromium } from '@playwright/test';

const art = `
  <!-- fork -->
  <g fill="#ffffff">
    <rect x="-196" y="-150" width="14" height="80" rx="7"/>
    <rect x="-171" y="-150" width="14" height="80" rx="7"/>
    <rect x="-146" y="-150" width="14" height="80" rx="7"/>
    <path d="M-196 -88 h64 v18 a32 32 0 0 1 -22 30 v176 a10 10 0 0 1 -20 0 v-176 a32 32 0 0 1 -22 -30 z"/>
  </g>
  <!-- knife -->
  <path fill="#ffffff" d="M146 -150 c34 18 48 70 48 128 v28 h-24 v150 a10 10 0 0 1 -20 0 z"/>
  <!-- plate -->
  <circle r="112" fill="#ffffff"/>
  <circle r="84" fill="none" stroke="#cfe9e4" stroke-width="8"/>
  <!-- apple -->
  <g transform="translate(0 8)">
    <path fill="#ef4444" d="M0 -38 c-14 -12 -54 -16 -64 18 c-10 34 12 76 36 82 c12 3 20 -4 28 -4 s16 7 28 4 c24 -6 46 -48 36 -82 c-10 -34 -50 -30 -64 -18 z"/>
    <path fill="none" stroke="#7c2d12" stroke-width="7" stroke-linecap="round" d="M0 -36 c0 -12 4 -22 10 -28"/>
    <path fill="#22c55e" d="M8 -54 c10 -22 34 -26 46 -20 c-6 18 -26 30 -46 20 z"/>
    <ellipse cx="-30" cy="-6" rx="9" ry="16" fill="#ffffff" opacity=".35" transform="rotate(20 -30 -6)"/>
  </g>`;

const svg = (maskable) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#14b8a6"/><stop offset="1" stop-color="#0f766e"/></linearGradient></defs>
  <rect width="512" height="512" rx="${maskable ? 0 : 112}" fill="url(#bg)"/>
  <g transform="translate(256 262) scale(${maskable ? 0.78 : 1})">${art}</g>
</svg>`;

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [file, size, maskable] of [['food-192.png', 192, false], ['food-512.png', 512, false], ['food-maskable-512.png', 512, true]]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg(maskable).replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: `icons/${file}`, omitBackground: true });
}
await browser.close();
console.log('icons written');

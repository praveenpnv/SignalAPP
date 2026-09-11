/**
 * Headless smoke test: boots the page, records console errors and page
 * errors, waits for the globe canvas, and writes a screenshot.
 * Network calls to the live feeds are expected to fail in CI/sandbox —
 * the test asserts the app survives that, which is the point.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json',
};

const server = createServer(async (req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = join(process.cwd(), normalize(p).replace(/^(\.\.[/\\])+/, ''));
  try {
    await stat(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(4173, r));

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROME,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
const consoleErrors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

await page.goto('http://localhost:4173/', { waitUntil: 'load' });
await page.waitForTimeout(6000);

const probe = await page.evaluate(() => ({
  canvas: !!document.querySelector('#globe canvas'),
  canvasSize: (() => { const c = document.querySelector('#globe canvas'); return c ? [c.width, c.height] : null; })(),
  bootGone: !document.querySelector('#boot') || document.querySelector('#boot').classList.contains('gone'),
  bootLines: [...document.querySelectorAll('#boot-log li')].map((l) => l.textContent),
  chips: [...document.querySelectorAll('.chip')].map((c) => c.textContent),
  sensors: [...document.querySelectorAll('#sensors button')].map((b) => b.textContent.trim()),
  satGroups: document.querySelectorAll('#sat-groups input').length,
  places: document.querySelectorAll('#place-jump option').length,
  hash: location.hash,
  clock: document.querySelector('#clock')?.textContent,
  rosterText: document.querySelector('#roster')?.textContent.trim().slice(0, 80),
}));

await page.screenshot({ path: 'scripts/_smoke-desktop.png' });

// exercise the UI: sensor switch, tab switch, place jump, panel collapse
await page.click('#sensors button[data-sensor="NVG"]');
await page.click('.tab[data-tab="detail"]');
await page.selectOption('#place-jump', '0');
await page.waitForTimeout(2500);
await page.screenshot({ path: 'scripts/_smoke-nvg.png' });

await page.setViewportSize({ width: 400, height: 780 });
await page.waitForTimeout(1200);
const mobile = await page.evaluate(() => ({
  overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
  scrollW: document.documentElement.scrollWidth,
  innerW: window.innerWidth,
}));
await page.screenshot({ path: 'scripts/_smoke-mobile.png' });

console.log(JSON.stringify({ probe, mobile, errors, consoleErrors: consoleErrors.slice(0, 12) }, null, 1));

await browser.close();
server.close();

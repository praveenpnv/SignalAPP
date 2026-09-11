/** Captures the README hero image using the stand-in feeds. */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { tleFixture, adsbFixture, quakeFixture, radioFixture, launchFixture } from './fixtures.mjs';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = join(process.cwd(), normalize(p).replace(/^(\.\.[/\\])+/, ''));
  try { await stat(f); res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' }); res.end(await readFile(f)); }
  catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(4175, r));

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME, args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1.5 });

await page.route('**/*', async (route) => {
  const url = route.request().url();
  if (url.startsWith('http://localhost:4175')) return route.continue();
  const json = (b) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(b) });
  if (/adsb|airplanes\.live/.test(url)) {
    const m = url.match(/lat\/(-?[\d.]+)\/lon\/(-?[\d.]+)/) || url.match(/point\/(-?[\d.]+)\/(-?[\d.]+)/);
    return json(adsbFixture(m ? +m[1] : 12.97, m ? +m[2] : 77.59, 70));
  }
  if (/celestrak/.test(url)) { const g = new URL(url).searchParams.get('GROUP'); return route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: tleFixture(g === 'stations' ? 4 : 14, g.toUpperCase()) }); }
  if (/earthquake\.usgs/.test(url)) return json(quakeFixture());
  if (/radio-browser/.test(url)) return json(radioFixture());
  if (/thespacedevs/.test(url)) return json(launchFixture());
  return route.abort();
});

await page.goto('http://localhost:4175/#12.97,77.59,0.62,fse,OPTICAL', { waitUntil: 'load' });
await page.waitForFunction(() => window.SIGNALS?.flights?.contacts?.size > 0, null, { timeout: 20000 });
await page.evaluate(() => {
  window.SIGNALS.globe.setAutoRotate(false);
  window.SIGNALS.globe.flyTo(12.97, 77.59, 0.62, 0);
});
await page.waitForTimeout(2500);
await page.evaluate(() => {
  const f = window.SIGNALS.flights.roster(10).find((c) => !c.onGround);
  if (f) window.SIGNALS.select(f);
});
await page.waitForTimeout(2200);
await mkdir('docs', { recursive: true });
await page.screenshot({ path: 'docs/preview.png' });
console.log('wrote docs/preview.png');
await browser.close();
server.close();

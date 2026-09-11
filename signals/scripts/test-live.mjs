/**
 * Full render-path test with stand-in feeds.
 *
 * Every outbound request is intercepted and answered with a realistic
 * payload, so this exercises parsing, propagation, glyph orientation,
 * the roster, selection and the detail panel without touching a network.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { tleFixture, adsbFixture, quakeFixture, radioFixture, launchFixture, oneAircraft } from './fixtures.mjs';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = join(process.cwd(), normalize(p).replace(/^(\.\.[/\\])+/, ''));
  try {
    await stat(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch { res.writeHead(404).end('nope'); }
});
await new Promise((r) => server.listen(4174, r));

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROME,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
let expectFailures = false;   // set true for the deliberate outage case
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  if (/ERR_TUNNEL|favicon/.test(m.text())) return;
  if (expectFailures && /ERR_FAILED|Failed to load resource/.test(m.text())) return;
  errors.push('console: ' + m.text());
});

let adsbHits = 0;
let hexHits = 0;
const seenPaths = [];
await page.route('**/*', async (route) => {
  let url = route.request().url();

  // Stand in for the Netlify/Vercel function: /api/adsb?u=<upstream>
  // unwraps to the upstream URL and is answered exactly as it would be.
  if (url.startsWith('http://localhost:4174/api/adsb')) {
    url = new URL(url).searchParams.get('u') || '';
  } else if (url.startsWith('http://localhost:4174')) {
    return route.continue();
  }
  const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });

  if (/adsb|airplanes\.live/.test(url)) {
    seenPaths.push(url.replace(/^https?:\/\//, ''));

    // lookup endpoints — only AIC503 / its hex / its reg exist
    const cs = url.match(/\/callsign\/([^/?]+)/);
    if (cs) return json(decodeURIComponent(cs[1]) === 'AIC503' ? oneAircraft() : { ac: [] });
    const hx = url.match(/\/(?:hex|icao)\/([^/?]+)/);
    if (hx) {
      if (decodeURIComponent(hx[1]).toLowerCase() !== '800abc') return json({ ac: [] });
      hexHits++;
      return json(oneAircraft({ tick: hexHits }));
    }
    const rg = url.match(/\/(?:reg|registration)\/([^/?]+)/);
    if (rg) return json(decodeURIComponent(rg[1]) === 'VT-EXU' ? oneAircraft() : { ac: [] });

    adsbHits++;
    const m = url.match(/lat\/(-?[\d.]+)\/lon\/(-?[\d.]+)/) || url.match(/point\/(-?[\d.]+)\/(-?[\d.]+)/);
    return json(adsbFixture(m ? +m[1] : 12.97, m ? +m[2] : 77.59));
  }
  if (/celestrak/.test(url)) {
    const g = new URL(url).searchParams.get('GROUP');
    return route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: tleFixture(g === 'stations' ? 4 : 12, g.toUpperCase()) });
  }
  if (/earthquake\.usgs/.test(url)) return json(quakeFixture());
  if (/radio-browser/.test(url)) return json(radioFixture());
  if (/thespacedevs/.test(url)) return json(launchFixture());
  return route.abort();
});

await page.goto('http://localhost:4174/', { waitUntil: 'load' });
await page.waitForFunction(() => window.SIGNALS?.flights?.contacts?.size > 0, null, { timeout: 20000 });
await page.waitForTimeout(3000);

const afterLoad = await page.evaluate(() => {
  const S = window.SIGNALS;
  const scene = S.globe.globe.scene();
  let meshes = 0;
  scene.traverse((o) => { if (o.isMesh) meshes++; });
  return {
    flights: S.flights.contacts.size,
    flightSource: S.flights.source,
    flightStatus: S.flights.status,
    sats: S.sats.active().length,
    satSample: S.sats.active().slice(0, 2).map((s) => ({ name: s.name, lat: +s.lat.toFixed(2), lng: +s.lng.toFixed(2), alt: Math.round(s.altKm), v: +s.speedKms.toFixed(2) })),
    quakes: S.quakes.quakes.length,
    meshes,
    objectsData: S.globe.globe.objectsData().length,
    pointsData: S.globe.globe.pointsData().length,
    ringsData: S.globe.globe.ringsData().length,
    rosterRows: document.querySelectorAll('#roster li[data-id]').length,
    chips: [...document.querySelectorAll('.chip')].map((c) => c.textContent),
    counts: { f: document.querySelector('#ct-flights').textContent, s: document.querySelector('#ct-sats').textContent, q: document.querySelector('#ct-quakes').textContent },
    launches: document.querySelectorAll('#launch-list li').length,
  };
});

// dead reckoning must actually move a contact between polls
const drift = await page.evaluate(async () => {
  const S = window.SIGNALS;
  const a = S.flights.positions().find((f) => !f.onGround && f.gs > 200);
  const before = { lat: a.lat, lng: a.lng, id: a.id };
  await new Promise((r) => setTimeout(r, 2500));
  const after = S.flights.positions().find((f) => f.id === before.id);
  return { moved: Math.abs(after.lat - before.lat) + Math.abs(after.lng - before.lng) > 1e-5 };
});

// heading orientation: recover each glyph's world-space forward axis and
// check it against the track angle the feed reported
const heading = await page.evaluate(() => {
  const g = window.SIGNALS.globe.globe;
  const contacts = window.SIGNALS.flights.positions();
  const groups = [];
  g.scene().traverse((o) => {
    if (o.__globeObjType === 'object' && o.children[0]?.geometry?.type === 'ShapeGeometry') groups.push(o);
  });

  const V = (x, y, z) => ({ x, y, z });
  const sub = (a, b) => V(a.x - b.x, a.y - b.y, a.z - b.z);
  const mul = (a, k) => V(a.x * k, a.y * k, a.z * k);
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const cross = (a, b) => V(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
  const norm = (a) => { const m = Math.hypot(a.x, a.y, a.z) || 1; return mul(a, 1 / m); };

  const samples = [];
  for (const grp of groups.slice(0, 12)) {
    const child = grp.children[0];
    child.updateWorldMatrix(true, false);
    const e = child.matrixWorld.elements;
    const fwd = norm(V(e[4], e[5], e[6]));          // local +Y in world space
    const up = norm(V(grp.position.x, grp.position.y, grp.position.z));
    const gy = V(0, 1, 0);
    const north = norm(sub(gy, mul(up, dot(up, gy))));
    const east = cross(north, up);
    let recovered = (Math.atan2(dot(fwd, east), dot(fwd, north)) * 180) / Math.PI;
    recovered = (recovered + 360) % 360;

    const geo = g.toGeoCoords(grp.position);
    let best = null, bestD = Infinity;
    for (const c of contacts) {
      const d = Math.abs(c.lat - geo.lat) + Math.abs(c.lng - geo.lng);
      if (d < bestD) { bestD = d; best = c; }
    }
    if (!best || bestD > 0.05) continue;
    let err = Math.abs(recovered - best.track);
    err = Math.min(err, 360 - err);
    samples.push({ track: Math.round(best.track), recovered: Math.round(recovered), err: Math.round(err) });
  }
  return { checked: samples.length, worstErr: samples.length ? Math.max(...samples.map((s) => s.err)) : null, samples: samples.slice(0, 4) };
});

// click the first roster row and confirm the detail pane fills in
await page.click('#roster li[data-id]:first-child');
await page.waitForTimeout(600);
const detail = await page.evaluate(() => ({
  heading: document.querySelector('#detail h3')?.textContent,
  keys: [...document.querySelectorAll('#detail .kv dt')].map((d) => d.textContent),
  paths: window.SIGNALS.globe.globe.pathsData().length,
  tab: document.querySelector('.tab.on')?.dataset.tab,
}));
await page.screenshot({ path: 'scripts/_live-flight.png' });

// select a satellite and confirm ground track + detail
const satSel = await page.evaluate(() => {
  const S = window.SIGNALS;
  const iss = S.sats.active().find((s) => /ISS/.test(s.name)) || S.sats.active()[0];
  S.select(iss);
  return iss.name;
});
await page.waitForTimeout(900);
const satDetail = await page.evaluate(() => ({
  heading: document.querySelector('#detail h3')?.textContent,
  keys: [...document.querySelectorAll('#detail .kv dt')].map((d) => d.textContent),
  trackPoints: window.SIGNALS.state.groundTrack?.length ?? 0,
  paths: window.SIGNALS.globe.globe.pathsData().length,
}));

// turn on radio and confirm markers land on the globe
await page.click('#ly-radio');
await page.waitForTimeout(1800);
const radioState = await page.evaluate(() => ({
  stations: window.SIGNALS.radio.stations.length,
  points: window.SIGNALS.globe.globe.pointsData().length,
}));

await page.screenshot({ path: 'scripts/_live-sat.png' });

// mobile sheet behaviour: only one panel open at a time
await page.setViewportSize({ width: 400, height: 780 });
await page.waitForTimeout(900);
const m1 = await page.evaluate(() => [...document.querySelectorAll('.panel')].map((p) => p.classList.contains('collapsed')));
await page.click('#panel-left .panel-toggle');
await page.waitForTimeout(300);
const m2 = await page.evaluate(() => [...document.querySelectorAll('.panel')].map((p) => p.classList.contains('collapsed')));
await page.click('#panel-right .panel-toggle');
await page.waitForTimeout(300);
const m3 = await page.evaluate(() => ({
  collapsed: [...document.querySelectorAll('.panel')].map((p) => p.classList.contains('collapsed')),
  overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
}));
await page.screenshot({ path: 'scripts/_live-mobile.png' });

// ── flight search by IATA number, and follow mode ──────────────────
await page.setViewportSize({ width: 1440, height: 900 });
await page.evaluate(() => [...document.querySelectorAll('.panel')].forEach((p) => p.classList.remove('collapsed')));
await page.waitForTimeout(500);

await page.fill('#q', 'AI503');
await page.click('#btn-find');
await page.waitForTimeout(5200);   // let the lock-on zoom land

const search = await page.evaluate(() => {
  const S = window.SIGNALS;
  return {
    selected: S.state.selected?.callsign,
    followId: S.flights.followId,
    followCallsign: S.flights.followMeta?.callsign,
    bannerVisible: !document.querySelector('#following').hidden,
    bannerText: document.querySelector('#fl-name')?.textContent,
    detailHeading: document.querySelector('#detail h3')?.textContent,
    autoRotate: S.globe.globe.controls().autoRotate,
    pov: (() => { const p = S.globe.pov(); return { lat: +p.lat.toFixed(2), lng: +p.lng.toFixed(2), alt: +p.altitude.toFixed(2) }; })(),
    target: (() => { const c = S.flights.followed(); return c ? { lat: +c.lat.toFixed(2), lng: +c.lng.toFixed(2) } : null; })(),
    toastTop: getComputedStyle(document.querySelector('#toast')).top,
    bannerTop: getComputedStyle(document.querySelector('#following')).top,
  };
});
await page.screenshot({ path: 'scripts/_live-search.png' });

// the follow poller should keep re-querying by hex and the contact should move
const before = await page.evaluate(() => {
  const c = window.SIGNALS.flights.followed();
  return { lat: c.lat, lng: c.lng };
});
await page.waitForTimeout(14000);
const followTick = await page.evaluate((b) => {
  const c = window.SIGNALS.flights.followed();
  return {
    stillFollowing: !!c,
    movedSinceFix: Math.abs(c.lat - b.lat) + Math.abs(c.lng - b.lng) > 1e-4,
    lost: window.SIGNALS.flights.followMeta?.lost,
  };
}, before);

// a query with no match must explain itself rather than fail silently
await page.fill('#q', 'ZZ9999');
await page.click('#btn-find');
await page.waitForTimeout(2500);
const noMatch = await page.evaluate(() => ({
  dropVisible: !document.querySelector('#search-drop').hidden,
  text: document.querySelector('#search-drop')?.textContent.trim().slice(0, 90),
}));

// release, and confirm the banner and poller stop
await page.click('#fl-stop');
await page.waitForTimeout(600);
const released = await page.evaluate(() => ({
  followId: window.SIGNALS.flights.followId,
  banner: document.querySelector('#following').hidden,
}));

// recent searches should have been remembered
await page.fill('#q', '');
await page.click('#q');
await page.waitForTimeout(400);
const recent = await page.evaluate(() =>
  [...document.querySelectorAll('#search-drop [data-recent]')].map((b) => b.textContent)
);

// registration and hex paths
await page.fill('#q', 'VT-EXU');
await page.click('#btn-find');
await page.waitForTimeout(2200);
const byReg = await page.evaluate(() => window.SIGNALS.flights.followMeta?.callsign);

// ── transport failure must not be reported as "flight not found" ──
// Simulate exactly what CORS does to us: the request never completes.
expectFailures = true;
await page.route(
  (url) => /\/api\/adsb|opendata\.adsb\.fi|api\.adsb\.lol|api\.airplanes\.live/.test(url.toString()),
  (route) => route.abort('failed')
);

await page.fill('#q', 'AIC503');
await page.click('#btn-find');
await page.waitForTimeout(6000);
const blocked = await page.evaluate(() => ({
  text: document.querySelector('#search-drop')?.textContent.trim().slice(0, 70),
  isBlockedStyle: !!document.querySelector('.sd-blocked'),
  layerBlocked: window.SIGNALS.flights.blocked,
}));

// ── the in-app proxy box: saving a URL must re-route the feeds ──
// Direct calls stay dead (as they are in a real browser); only the
// proxied ones answer. Matching on origin, not substring — the proxy URL
// carries the upstream host inside its ?u= parameter.
await page.unroute(
  (url) => /\/api\/adsb|opendata\.adsb\.fi|api\.adsb\.lol|api\.airplanes\.live/.test(url.toString())
);
await page.route(/my-worker\.example\.dev/, (route) => {
  const u = new URL(route.request().url()).searchParams.get('u') || '';
  if (/callsign/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(oneAircraft()) });
  return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(adsbFixture(12.97, 77.59, 12)) });
});
// direct (unproxied) aircraft calls stay dead, as they are in a real browser
await page.route(
  (url) => /^https:\/\/(opendata\.adsb\.fi|api\.adsb\.lol|api\.airplanes\.live)\//.test(url.toString()),
  (route) => route.abort('failed')
);

await page.evaluate(() => [...document.querySelectorAll('.panel')].forEach((p) => p.classList.remove('collapsed')));
await page.fill('#proxy-url', 'https://my-worker.example.dev');
await page.click('#btn-proxy-save');
await page.waitForTimeout(4000);
const proxied = await page.evaluate(() => ({
  state: document.querySelector('#proxy-state')?.textContent.trim().slice(0, 60),
  stateClass: document.querySelector('#proxy-state')?.className,
  status: window.SIGNALS.flights.status,
  contacts: window.SIGNALS.flights.contacts.size,
  hintCleared: !document.querySelector('#hint-flights').classList.contains('warn'),
}));

// bad input is rejected rather than silently stored
await page.fill('#proxy-url', 'not-a-url');
await page.click('#btn-proxy-save');
await page.waitForTimeout(500);
const badInput = await page.evaluate(() => document.querySelector('#proxy-state')?.textContent.trim());

console.log(JSON.stringify({ afterLoad, drift, heading, detail, satSel, satDetail, radioState, mobile: { atLoad: m1, afterLeft: m2, afterRight: m3 }, search, followTick, noMatch, released, recent, byReg, blocked, proxied, badInput, adsbHits, hexHits, pointPaths: [...new Set(seenPaths.filter((p) => /lat\/|point\//.test(p)))].slice(0, 3), errors }, null, 1));

await browser.close();
server.close();

/**
 * SIGNALS — entry point.
 *
 * Wires four independent data layers to one globe and one set of panels.
 * Every layer fails on its own: if a feed is unreachable the rest of the
 * app keeps running and the HUD says which one went dark.
 */

import { GlobeView } from './globe.js';
import { FlightLayer } from './layers/flights.js';
import { SatelliteLayer } from './layers/satellites.js';
import { QuakeLayer } from './layers/quakes.js';
import { RadioLayer } from './layers/radio.js';
import {
  PLACES, SENSORS, LAUNCH_URL, LAUNCH_CACHE_MIN, SAT_STEP_MS,
} from './config.js';
import { proxyBase, setProxy } from './config.js';
import { $, $$, fetchJSON, cache, fmt, haversineKm, debounce } from './util.js';
import * as ui from './ui.js';

const RENDER_MS = 50;          // object layer refresh — smooth without thrashing
const flights = new FlightLayer();
const sats = new SatelliteLayer();
const quakes = new QuakeLayer();
const radio = new RadioLayer();

const RECENT_KEY = 'recent-searches';

const state = {
  selected: null,
  searching: false,
  observer: null,
  observerName: null,
  sensor: 'OPTICAL',
  tour: null,
  tourIdx: 0,
};

let globe;

// ─────────────────────────────────────────────────────────── boot

async function boot() {
  ui.bootLog('initialising renderer…');

  globe = new GlobeView($('#globe'), {
    onSelect: (d) => select(d),
    onCameraSettle: (pov) => onCameraSettle(pov),
  });

  ui.renderPlaces();
  ui.renderSensors(state.sensor, setSensor);
  ui.renderSatGroups(sats.groupsOn, onSatGroup);
  wireControls();

  const start = readHash() || { lat: 20, lng: 78, altitude: 2.4 };
  globe.flyTo(start.lat, start.lng, start.altitude, 0);

  ui.bootLog('renderer ready', 'ok');

  // Layers come up independently so one slow feed never blocks the app.
  ui.bootLog('loading orbital elements…');
  sats
    .load()
    .then((n) => ui.bootLog(n ? `${n} satellites propagating` : 'orbital elements unavailable', n ? 'ok' : 'err'))
    .catch(() => ui.bootLog('orbital elements unavailable', 'err'));

  ui.bootLog('opening seismic feed…');
  quakes.start();

  ui.bootLog('acquiring air picture…');
  flights.setFocus(start.lat, start.lng);
  flights.start();
  warnIfAircraftBlocked();

  loadLaunches();

  setTimeout(() => {
    ui.bootLog('ready — click anything on the globe', 'ok');
    setTimeout(ui.bootDone, 700);
  }, 1200);

  tick();
  setInterval(hudTick, 1000);

  // A deliberate debug handle. Open the console and poke at the live
  // layers: SIGNALS.flights.contacts, SIGNALS.sats.active(), and so on.
  window.SIGNALS = { globe, flights, sats, quakes, radio, state, select };
}

// ────────────────────────────────────────────────────── render loop

let lastRender = 0;
let lastPropagate = 0;

function tick(now = performance.now()) {
  requestAnimationFrame(tick);

  if (now - lastPropagate > SAT_STEP_MS) {
    if (sats.enabled) sats.propagate();
    lastPropagate = now;
  }

  if (now - lastRender < RENDER_MS) return;
  lastRender = now;

  const flightData = flights.enabled ? flights.positions() : [];
  const satData = sats.enabled ? sats.active() : [];
  globe.renderObjects(flightData, satData);

  const quakeData = quakes.enabled ? quakes.quakes : [];
  const radioData = radio.enabled ? radio.stations : [];
  globe.renderPoints(quakeData, radioData);

  globe.renderPaths(buildPaths(flightData));
  globe.renderRings(buildRings(quakeData));
}

/** Trails for the tracked contact, plus the ground track of a tracked satellite. */
function buildPaths(flightData) {
  const paths = [];
  const sel = state.selected;
  if (!sel) return paths;

  if (sel.kind === 'flight') {
    const live = flightData.find((f) => f.id === sel.id);
    if (live?.trail?.length > 1) {
      paths.push({
        points: live.trail.map((p) => ({
          lat: p.lat,
          lng: p.lng,
          alt: ((p.altFt * 0.0003048) / 6371) * 16,
        })),
        color: '#4cc9f0',
        stroke: 0.55,
      });
    }
  }

  if (sel.kind === 'satellite' && state.groundTrack) {
    paths.push({
      points: state.groundTrack.map((p) => ({ lat: p.lat, lng: p.lng, alt: p.altKm / 6371 })),
      color: sel.color,
      stroke: 0.4,
    });
  }
  return paths;
}

function buildRings(quakeData) {
  const rings = [];

  if (state.selected) {
    const s = state.selected;
    rings.push({
      lat: s.lat,
      lng: s.lng,
      alt: 0.002,
      color: () => 'rgba(76,201,240,0.75)',
      maxR: 3.2,
      speed: 2.4,
      period: 900,
    });
  }

  if (flights.enabled && flights.focus) {
    rings.push({
      lat: flights.focus.lat,
      lng: flights.focus.lng,
      alt: 0.001,
      color: () => 'rgba(255,183,3,0.28)',
      maxR: 5,
      speed: 1.6,
      period: 2600,
    });
  }

  for (const q of quakeData.filter((q) => q.mag >= 5 && Date.now() - q.time < 6 * 3600_000)) {
    rings.push({
      lat: q.lat,
      lng: q.lng,
      alt: 0.001,
      color: () => 'rgba(255,59,48,0.55)',
      maxR: Math.min(14, q.mag * 2.2),
      speed: 3,
      period: 1400,
    });
  }
  return rings;
}

// ─────────────────────────────────────────────────────────── HUD

function hudTick() {
  $('#clock').textContent = fmt.clock();

  const pov = globe.pov();
  $('#pov-readout').textContent = fmt.coord(pov.lat, pov.lng);

  ui.setLayerState('flights', { status: flights.enabled ? flights.status : 'off', count: flights.enabled ? flights.contacts.size : null });
  ui.setLayerState('sats', { status: sats.enabled ? sats.status : 'off', count: sats.enabled ? sats.active().length : null });
  ui.setLayerState('quakes', { status: quakes.enabled ? quakes.status : 'off', count: quakes.enabled ? quakes.quakes.length : null });
  ui.setLayerState('radio', { status: radio.enabled ? radio.status : 'off', count: radio.enabled ? radio.stations.length : null });

  ui.renderChips([
    {
      label: flights.source ? `ADS-B ${flights.source}` : 'ADS-B',
      status: flights.enabled ? flights.status : 'off',
      detail: flights.lastUpdate && flights.enabled ? fmt.ago(flights.lastUpdate) : '',
    },
    { label: 'CelesTrak', status: sats.enabled ? sats.status : 'off' },
    { label: 'USGS', status: quakes.enabled ? quakes.status : 'off' },
    { label: 'Radio Browser', status: radio.enabled ? radio.status : 'off' },
  ]);

  const note = $('#scan-note');
  if (flights.focus) {
    note.textContent = `Scanning 250 nm around ${fmt.coord(flights.focus.lat, flights.focus.lng)} — move the globe to scan elsewhere.`;
  }

  if (!state.selected || state.selected.kind === 'flight') {
    ui.renderRoster(flights.enabled ? flights.roster(30) : [], state.selected?.id, pickById);
  }

  if (state.selected?.kind === 'flight') refreshSelected();

  if (flights.followMeta) {
    ui.setFollowing(flights.followMeta);
    rideFollowed();
  } else {
    ui.setFollowing(null);
  }

  writeHash();
}

// ───────────────────────────────────────────────────── interaction

function select(d) {
  if (!d) return;
  state.selected = d;
  globe.setSelected(d.id);
  state.groundTrack = null;

  $$('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === 'detail'));
  $$('.tabpane').forEach((p) => p.classList.toggle('on', p.id === 'pane-detail'));

  if (d.kind === 'satellite') {
    state.groundTrack = sats.groundTrack(d);
    const passes = state.observer ? sats.nextPasses(d, state.observer) : [];
    ui.renderDetail(d, { passes, observer: state.observer, observerName: state.observerName });
  } else if (d.kind === 'radio') {
    ui.renderDetail(d, { playing: radio.playing?.id === d.id });
    $('#btn-listen')?.addEventListener('click', () => toggleRadio(d));
  } else {
    ui.renderDetail(d);
  }

  if (d.kind !== 'flight') {
    globe.flyTo(d.lat, d.lng, Math.max(0.5, globe.pov().altitude));
  }
}

function refreshSelected() {
  const live = flights.positions().find((f) => f.id === state.selected.id);
  if (live) {
    state.selected = live;
    ui.renderDetail(live);
  }
}

function pickById(id) {
  const all = [
    ...flights.positions(),
    ...sats.active(),
    ...quakes.quakes,
    ...radio.stations,
  ];
  const found = all.find((x) => x.id === id);
  if (found) select(found);
}

function toggleRadio(station) {
  if (radio.playing?.id === station.id) {
    radio.stop();
    ui.setNowPlaying(null);
    ui.renderDetail(station, { playing: false });
    $('#btn-listen')?.addEventListener('click', () => toggleRadio(station));
    return;
  }
  ui.toast('connecting to stream…');
  radio
    .play(station)
    .then(() => {
      ui.setNowPlaying(station);
      ui.renderDetail(station, { playing: true });
      $('#btn-listen')?.addEventListener('click', () => toggleRadio(station));
      ui.toast(`now playing ${station.name}`);
    })
    .catch(() => ui.toast('that stream refused the connection'));
}

const scanElsewhere = debounce((lat, lng) => {
  flights.setFocus(lat, lng, { immediate: true });
}, 250);

function onCameraSettle(pov) {
  if (!flights.enabled) return;
  if (flights.followId) return;   // the camera is riding a contact
  if (!flights.focus || haversineKm(flights.focus, pov) > 150) {
    scanElsewhere(pov.lat, pov.lng);
  }
}

// ─────────────────────────────────────────────────────── controls

function wireControls() {
  $('#ly-flights').addEventListener('change', (e) => {
    if (e.target.checked) {
      const pov = globe.pov();
      flights.setFocus(pov.lat, pov.lng);
      flights.start();
    } else flights.stop();
  });

  $('#ly-sats').addEventListener('change', (e) => {
    sats.enabled = e.target.checked;
    if (sats.enabled && !sats.sats.length) sats.load();
  });

  $('#ly-quakes').addEventListener('change', (e) => (e.target.checked ? quakes.start() : quakes.stop()));

  $('#ly-radio').addEventListener('change', async (e) => {
    radio.enabled = e.target.checked;
    if (!radio.enabled) {
      radio.stop();
      ui.setNowPlaying(null);
      return;
    }
    ui.toast('loading transmitters…');
    const n = await radio.load();
    ui.toast(n ? `${n} stations on the globe` : 'radio directory unreachable');
  });

  $$('#quake-feed button').forEach((b) =>
    b.addEventListener('click', () => {
      $$('#quake-feed button').forEach((x) => x.classList.toggle('on', x === b));
      quakes.setFeed(b.dataset.feed);
    })
  );

  $$('#basemap button').forEach((b) =>
    b.addEventListener('click', () => {
      $$('#basemap button').forEach((x) => x.classList.toggle('on', x === b));
      globe.setBasemap(b.dataset.base);
    })
  );

  $('#opt-rotate').addEventListener('change', (e) => globe.setAutoRotate(e.target.checked));

  wireSearch();

  $('#fl-stop').addEventListener('click', () => {
    flights.unfollow();
    ui.setFollowing(null);
    ui.toast('released');
  });

  wireProxyBox();

  $('#btn-locate').addEventListener('click', locate);
  $('#btn-tour').addEventListener('click', toggleTour);
  $('#btn-share').addEventListener('click', share);
  $('#np-stop').addEventListener('click', () => {
    radio.stop();
    ui.setNowPlaying(null);
  });

  $('#place-jump').addEventListener('change', (e) => {
    const p = PLACES[e.target.value];
    if (!p) return;
    globe.flyTo(p.lat, p.lng, 0.65);
    flights.setFocus(p.lat, p.lng, { immediate: true });
    e.target.value = '';
  });

  $$('.tab').forEach((t) =>
    t.addEventListener('click', () => {
      $$('.tab').forEach((x) => x.classList.toggle('on', x === t));
      $$('.tabpane').forEach((p) => p.classList.toggle('on', p.id === `pane-${t.dataset.tab}`));
    })
  );

  // On narrow screens the two panels are bottom sheets: opening one
  // closes the other so they never overlap.
  const isNarrow = () => window.matchMedia('(max-width: 720px)').matches;
  $$('.panel-toggle').forEach((b) =>
    b.addEventListener('click', () => {
      const target = document.getElementById(b.dataset.target);
      const opening = target.classList.contains('collapsed');
      if (isNarrow() && opening) {
        $$('.panel').forEach((p) => p.classList.add('collapsed'));
      }
      target.classList.toggle('collapsed', !opening);
    })
  );
  const applyNarrowDefault = () => {
    if (isNarrow()) $$('.panel').forEach((p) => p.classList.add('collapsed'));
    else $$('.panel').forEach((p) => p.classList.remove('collapsed'));
  };
  applyNarrowDefault();
  window.matchMedia('(max-width: 720px)').addEventListener('change', applyNarrowDefault);

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.target.matches('input, select, textarea')) {
      e.preventDefault();
      $('#q').focus();
      return;
    }
    if (e.target.matches('input, select, textarea')) return;
    const n = Number(e.key);
    if (n >= 1 && n <= SENSORS.length) return setSensor(SENSORS[n - 1].key);
    switch (e.key.toLowerCase()) {
      case 'f': return $('#ly-flights').click();
      case 's': return $('#ly-sats').click();
      case 'e': return $('#ly-quakes').click();
      case 'r': return $('#ly-radio').click();
      case 't': return toggleTour();
      case 'escape':
        state.selected = null;
        globe.setSelected(null);
        ui.renderDetail(null);
        return;
      case ' ':
        e.preventDefault();
        $('#opt-rotate').click();
    }
  });
}

/**
 * The proxy box. Deploying the Worker is the only part that needs doing
 * elsewhere — pointing this build at it does not require a rebuild, so the
 * value lives in localStorage and can also arrive as ?proxy=<url>.
 */
function wireProxyBox() {
  const input = $('#proxy-url');
  const stateEl = $('#proxy-state');

  const fromUrl = new URLSearchParams(location.search).get('proxy');
  if (fromUrl) setProxy(fromUrl);

  const paint = () => {
    const base = proxyBase();
    input.value = base;
    if (!base) {
      stateEl.textContent = 'Not set — aircraft layer is dark.';
      stateEl.className = 'hint';
    } else {
      stateEl.textContent = `Routing aircraft feeds via ${base}`;
      stateEl.className = 'hint ok';
    }
  };
  paint();

  $('#btn-proxy-save').addEventListener('click', async () => {
    const url = input.value.trim();
    if (url && !/^https:\/\/\S+$/.test(url)) {
      stateEl.textContent = 'Needs to be a full https:// URL.';
      stateEl.className = 'hint bad';
      return;
    }
    setProxy(url);
    paint();

    if (!url) {
      ui.toast('proxy cleared');
      return;
    }

    stateEl.textContent = 'Testing…';
    stateEl.className = 'hint';
    await flights.retry();

    if (flights.status === 'live') {
      stateEl.textContent = `Working — feeding from ${flights.source}.`;
      stateEl.className = 'hint ok';
      $('#hint-flights').textContent = 'ADS-B within 250 nm of the view centre.';
      $('#hint-flights').className = 'hint';
      ui.toast('aircraft layer is live');
    } else {
      stateEl.textContent =
        'Still blocked. Check the Worker is deployed and that opening ' +
        'its URL with ?u=<an adsb.fi URL> returns JSON.';
      stateEl.className = 'hint bad';
      ui.toast('proxy did not answer — see the note under the box');
    }
  });

  $('#btn-proxy-clear').addEventListener('click', () => {
    setProxy('');
    input.value = '';
    paint();
  });
}

/**
 * Say it out loud, once, if the aircraft feeds cannot be reached. A
 * silently empty layer reads as "quiet skies", which is a lie.
 */
function warnIfAircraftBlocked() {
  let said = false;
  const check = setInterval(() => {
    if (said || !flights.enabled) return;
    if (flights.blocked) {
      said = true;
      clearInterval(check);
      ui.toast(
        'Aircraft feeds unreachable — the ADS-B networks send no CORS header. ' +
          'Set ADSB_PROXY in config.js (see README). Other layers are unaffected.',
        11000
      );
      $('#hint-flights').innerHTML =
        'Blocked by CORS — the ADS-B hosts send no ' +
        '<code>Access-Control-Allow-Origin</code> header. Deploy ' +
        '<code>worker/adsb-proxy.js</code> and set <code>ADSB_PROXY</code>.';
      $('#hint-flights').classList.add('warn');
      $('#proxy-grp')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, 3000);
  setTimeout(() => clearInterval(check), 120_000);
}

// ───────────────────────────────────────────────────────── search

function recentSearches() {
  return cache.get(RECENT_KEY, 90 * 86400_000) || [];
}

function rememberSearch(q) {
  const list = [q, ...recentSearches().filter((r) => r !== q)].slice(0, 6);
  cache.set(RECENT_KEY, list);
}

function wireSearch() {
  const form = $('#searchbar');
  const input = $('#q');

  const handlers = {
    onPick: (id) => {
      const hit = flights.contacts.get(id);
      if (hit) lockOn(hit);
      ui.renderSearchDrop({ state: 'hidden' }, handlers);
      input.blur();
    },
    onRecent: (q) => {
      input.value = q;
      runSearch(q);
    },
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch(input.value);
  });

  input.addEventListener('focus', () => {
    if (!input.value.trim()) {
      ui.renderSearchDrop({ state: 'recent', recent: recentSearches() }, handlers);
    }
  });

  input.addEventListener('input', () => {
    if (!input.value.trim()) {
      ui.renderSearchDrop({ state: 'recent', recent: recentSearches() }, handlers);
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      ui.renderSearchDrop({ state: 'hidden' }, handlers);
      input.blur();
    }
  });

  document.addEventListener('click', (e) => {
    if (!form.contains(e.target)) ui.renderSearchDrop({ state: 'hidden' }, handlers);
  });

  async function runSearch(raw) {
    const q = String(raw || '').trim();
    if (!q || state.searching) return;

    state.searching = true;
    form.classList.add('busy');
    ui.renderSearchDrop({ state: 'searching', query: q }, handlers);

    try {
      const { results, reached } = await flights.search(q);
      // Give the render loop a tick so renderColor is populated.
      flights.positions();
      const enriched = results
        .map((r) => flights.contacts.get(r.id))
        .filter(Boolean);

      if (!enriched.length) {
        ui.renderSearchDrop({ state: reached ? 'empty' : 'blocked', query: q }, handlers);
      } else {
        rememberSearch(q.toUpperCase());
        if (enriched.length === 1) {
          lockOn(enriched[0]);
          ui.renderSearchDrop({ state: 'hidden' }, handlers);
          input.blur();
        } else {
          ui.renderSearchDrop({ state: 'results', results: enriched, query: q }, handlers);
        }
      }
    } catch {
      ui.renderSearchDrop({ state: 'empty', query: q }, handlers);
    } finally {
      state.searching = false;
      form.classList.remove('busy');
    }
  }
}

/** Select a contact, start following it, and take the camera there. */
function lockOn(contact) {
  select(contact);
  $('#opt-rotate').checked = false;
  globe.setAutoRotate(false);
  if (flights.follow(contact)) {
    ui.setFollowing(flights.followMeta);
    ui.toast(`tracking ${contact.callsign} — network-wide`);
  } else {
    ui.toast(`${contact.callsign} has no Mode-S hex to follow`);
  }
  globe.flyTo(contact.lat, contact.lng, 0.42, 1600);
  state.rideAfter = Date.now() + 2600;
}

/**
 * Keep the camera over a followed aircraft without fighting the user.
 *
 * The guard matters: lockOn starts its own zoom transition, and recentring
 * mid-flight would read the half-finished altitude and cancel the zoom.
 * So riding only begins once that transition has landed, and afterwards it
 * preserves whatever altitude the user has settled on.
 */
let lastRide = 0;
function rideFollowed() {
  const now = Date.now();
  if (now < (state.rideAfter || 0) || now - lastRide < 2000) return;

  const c = flights.followed();
  if (!c) return;
  const live = flights.positions().find((f) => f.id === c.id);
  if (!live) return;

  lastRide = now;
  const pov = globe.pov();
  if (haversineKm(pov, live) > 40) {
    globe.flyTo(live.lat, live.lng, pov.altitude, 1800);
  }
}

function setSensor(key) {
  const s = SENSORS.find((x) => x.key === key) || SENSORS[0];
  state.sensor = s.key;
  $('#globe').style.filter = s.filter;
  $('#scanlines').hidden = s.key !== 'CRT';
  ui.renderSensors(s.key, setSensor);
}

function locate() {
  if (!navigator.geolocation) return ui.toast('this browser has no geolocation');
  ui.toast('requesting your position…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude: lat, longitude: lng } = pos.coords;
      state.observer = { lat, lng };
      state.observerName = 'your position';
      globe.flyTo(lat, lng, 0.55);
      flights.setFocus(lat, lng, { immediate: true });
      ui.toast('scanning your area');
    },
    () => ui.toast('position denied — pick a city instead')
  );
}

function toggleTour() {
  if (state.tour) {
    clearInterval(state.tour);
    state.tour = null;
    globe.setAutoRotate($('#opt-rotate').checked);
    ui.toast('tour stopped');
    return;
  }
  const hop = () => {
    const p = PLACES[state.tourIdx % PLACES.length];
    state.tourIdx++;
    globe.flyTo(p.lat, p.lng, 0.6, 3200);
    flights.setFocus(p.lat, p.lng, { immediate: true });
    ui.toast(`▸ ${p.name}`);
  };
  hop();
  state.tour = setInterval(hop, 9000);
  ui.toast('cinematic tour running — T to stop');
}

// ─────────────────────────────────────────────────── share + hash

function writeHash() {
  const pov = globe.pov();
  const layers =
    (flights.enabled ? 'f' : '') +
    (sats.enabled ? 's' : '') +
    (quakes.enabled ? 'e' : '') +
    (radio.enabled ? 'r' : '');
  const hash = `#${pov.lat.toFixed(3)},${pov.lng.toFixed(3)},${pov.altitude.toFixed(2)},${layers || '-'},${state.sensor}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

function readHash() {
  const raw = location.hash.slice(1);
  if (!raw) return null;
  const [lat, lng, alt, layers, sensor] = raw.split(',');
  if (!Number.isFinite(+lat) || !Number.isFinite(+lng)) return null;

  if (layers && layers !== '-') {
    $('#ly-flights').checked = layers.includes('f');
    $('#ly-sats').checked = layers.includes('s');
    $('#ly-quakes').checked = layers.includes('e');
    $('#ly-radio').checked = layers.includes('r');
  }
  if (sensor) setSensor(sensor);

  return { lat: +lat, lng: +lng, altitude: +alt || 1.5 };
}

async function share() {
  writeHash();
  try {
    await navigator.clipboard.writeText(location.href);
    ui.toast('view link copied to clipboard');
  } catch {
    ui.toast(location.href);
  }
}

// ───────────────────────────────────────────────────────── extras

async function loadLaunches() {
  const cached = cache.get('launches', LAUNCH_CACHE_MIN * 60_000);
  if (cached) return ui.renderLaunches(cached);
  try {
    const data = await fetchJSON(LAUNCH_URL, { timeout: 10_000 });
    cache.set('launches', data.results);
    ui.renderLaunches(data.results);
  } catch {
    ui.renderLaunches(null);
  }
}

function onSatGroup(group, on) {
  sats.setGroup(group, on);
}

// The layers default to on in the markup; mirror that into the objects.
sats.enabled = true;

let booted = false;
function bootOnce() {
  if (booted) return;
  booted = true;
  boot();
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootOnce);
} else {
  bootOnce();
}

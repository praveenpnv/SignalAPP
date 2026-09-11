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
import { $, $$, fetchJSON, cache, fmt, haversineKm, debounce } from './util.js';
import * as ui from './ui.js';

const RENDER_MS = 50;          // object layer refresh — smooth without thrashing
const flights = new FlightLayer();
const sats = new SatelliteLayer();
const quakes = new QuakeLayer();
const radio = new RadioLayer();

const state = {
  selected: null,
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

/**
 * SIGNALS — central configuration.
 *
 * Every source listed here is public and keyless. If you add a source that
 * needs a key, it does not belong in this file: this app is deliberately
 * static and has no server to keep a secret in.
 */

export const GLOBE_RADIUS = 100;

/**
 * ADS-B CORS proxy.
 *
 * The aircraft networks serve public data but send no
 * `Access-Control-Allow-Origin` header, so a browser will not let this
 * page read their responses. Satellites, earthquakes and radio all send
 * the header and work directly; aircraft do not and cannot.
 *
 * Leave this empty and the aircraft layer stays dark, saying so plainly.
 * Set it to your own deployed `worker/adsb-proxy.js` URL (Cloudflare's
 * free tier covers this many times over) and the layer comes alive:
 *
 *   export const ADSB_PROXY = 'https://signals-adsb.yourname.workers.dev';
 */
export const ADSB_PROXY = '';

/** Route a URL through the proxy when one is configured. */
export const via = (url) =>
  ADSB_PROXY ? `${ADSB_PROXY.replace(/\/$/, '')}/?u=${encodeURIComponent(url)}` : url;

/** Earth textures, served from a CORS-friendly CDN. */
export const TEXTURES = {
  globe: 'https://cdn.jsdelivr.net/npm/three-globe@2.31.0/example/img/earth-night.jpg',
  bump: 'https://cdn.jsdelivr.net/npm/three-globe@2.31.0/example/img/earth-topology.png',
  sky: 'https://cdn.jsdelivr.net/npm/three-globe@2.31.0/example/img/night-sky.png',
};

/**
 * Live ADS-B aircraft feeds, tried in order until one answers.
 *
 * These are community receiver networks sharing the same "readsb" JSON
 * shape (an `ac` array), so one parser covers all of them. Note the path
 * differences: adsb.fi moved its radius query to v3 while keeping the
 * lookup endpoints on v2, and the three networks disagree on whether
 * registration lookup is /reg/ or /registration/.
 *
 * Radius is capped at 250 nautical miles upstream. The lookup endpoints
 * have no such limit — they search the whole network, which is what makes
 * "find me this flight" work from any camera position.
 *
 * All three ask for 1 request per second at most. Respect that if you fork
 * this; the polling intervals below are set well inside it.
 */
export const FLIGHT_SOURCES = [
  {
    name: 'adsb.fi',
    point: (lat, lon, nm) =>
      via(`https://opendata.adsb.fi/api/v3/lat/${lat.toFixed(3)}/lon/${lon.toFixed(3)}/dist/${nm}`),
    callsign: (cs) => via(`https://opendata.adsb.fi/api/v2/callsign/${cs}`),
    reg: (r) => via(`https://opendata.adsb.fi/api/v2/registration/${r}`),
    hex: (h) => via(`https://opendata.adsb.fi/api/v2/hex/${h}`),
  },
  {
    name: 'airplanes.live',
    point: (lat, lon, nm) =>
      via(`https://api.airplanes.live/v2/point/${lat.toFixed(3)}/${lon.toFixed(3)}/${nm}`),
    callsign: (cs) => via(`https://api.airplanes.live/v2/callsign/${cs}`),
    reg: (r) => via(`https://api.airplanes.live/v2/reg/${r}`),
    hex: (h) => via(`https://api.airplanes.live/v2/hex/${h}`),
  },
  {
    name: 'adsb.lol',
    point: (lat, lon, nm) =>
      via(`https://api.adsb.lol/v2/lat/${lat.toFixed(3)}/lon/${lon.toFixed(3)}/dist/${nm}`),
    callsign: (cs) => via(`https://api.adsb.lol/v2/callsign/${cs}`),
    reg: (r) => via(`https://api.adsb.lol/v2/reg/${r}`),
    hex: (h) => via(`https://api.adsb.lol/v2/hex/${h}`),
  },
];

export const FLIGHT_RADIUS_NM = 250;
export const FLIGHT_POLL_MS = 20_000;

/** How often a followed aircraft is re-queried by hex, network-wide. */
export const FOLLOW_POLL_MS = 12_000;

/** A followed contact is kept on screen this long after its last fix. */
export const FOLLOW_GRACE_MS = 240_000;

/**
 * Satellite catalogues from CelesTrak, as classic TLE text.
 * Keep this list short — every object is propagated on every frame.
 */
export const SAT_GROUPS = [
  { group: 'stations', label: 'Space stations', color: '#ffffff', cap: 20 },
  { group: 'visual', label: 'Brightest', color: '#ffd166', cap: 90 },
  { group: 'gps-ops', label: 'GPS', color: '#4cc9f0', cap: 32 },
  { group: 'weather', label: 'Weather', color: '#80ed99', cap: 30 },
  { group: 'starlink', label: 'Starlink', color: '#b892ff', cap: 90 },
];

export const CELESTRAK_TLE = (group) =>
  `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`;

export const TLE_CACHE_HOURS = 6;
export const SAT_STEP_MS = 250;

/** USGS seismic feeds. */
export const QUAKE_FEEDS = {
  day: {
    label: 'M2.5+ / 24h',
    url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson',
  },
  week: {
    label: 'M4.5+ / 7d',
    url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson',
  },
};
export const QUAKE_POLL_MS = 300_000;

/**
 * Radio Browser mirrors. The service asks clients to pick a mirror rather
 * than hammer one host, so we shuffle and fall through on failure.
 */
export const RADIO_MIRRORS = [
  'https://de1.api.radio-browser.info',
  'https://at1.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
];
export const RADIO_LIMIT = 600;

/** Upcoming rocket launches (anonymous tier is rate limited, so we cache). */
export const LAUNCH_URL =
  'https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=12&mode=list';
export const LAUNCH_CACHE_MIN = 120;

/** Places the cinematic tour visits, and the quick-jump menu. */
export const PLACES = [
  { name: 'Bengaluru', lat: 12.9716, lng: 77.5946 },
  { name: 'Dubai', lat: 25.2532, lng: 55.3657 },
  { name: 'London', lat: 51.47, lng: -0.4543 },
  { name: 'New York', lat: 40.6413, lng: -73.7781 },
  { name: 'Tokyo', lat: 35.5494, lng: 139.7798 },
  { name: 'Singapore', lat: 1.3644, lng: 103.9915 },
  { name: 'São Paulo', lat: -23.4356, lng: -46.4731 },
  { name: 'Johannesburg', lat: -26.1367, lng: 28.246 },
  { name: 'Sydney', lat: -33.9399, lng: 151.1753 },
  { name: 'Frankfurt', lat: 50.0379, lng: 8.5622 },
];

/** Screen-space sensor looks. Applied as a CSS filter over the canvas. */
export const SENSORS = [
  { key: 'OPTICAL', filter: 'none' },
  { key: 'NVG', filter: 'sepia(1) hue-rotate(65deg) saturate(3.2) brightness(1.05) contrast(1.15)' },
  { key: 'THERMAL', filter: 'grayscale(1) invert(1) sepia(1) hue-rotate(175deg) saturate(4.5) contrast(1.25)' },
  { key: 'IRONBOW', filter: 'grayscale(1) sepia(1) saturate(6) hue-rotate(-25deg) contrast(1.3)' },
  { key: 'NOIR', filter: 'grayscale(1) contrast(1.45) brightness(0.95)' },
  { key: 'CRT', filter: 'saturate(1.7) contrast(1.25) brightness(1.05)' },
];

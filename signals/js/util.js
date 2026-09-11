/** Small shared helpers. No dependencies. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const toRad = (d) => (d * Math.PI) / 180;
export const toDeg = (r) => (r * 180) / Math.PI;

/** Great-circle distance in km. */
export function haversineKm(a, b) {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Initial bearing from a to b, in degrees. */
export function bearing(a, b) {
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Move a point `km` along a bearing. This is what dead reckoning uses to
 * fill the gap between two ADS-B updates.
 */
export function project(lat, lng, bearingDeg, km) {
  const R = 6371;
  const d = km / R;
  const br = toRad(bearingDeg);
  const la1 = toRad(lat);
  const lo1 = toRad(lng);
  const la2 = Math.asin(
    Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br)
  );
  const lo2 =
    lo1 +
    Math.atan2(
      Math.sin(br) * Math.sin(d) * Math.cos(la1),
      Math.cos(d) - Math.sin(la1) * Math.sin(la2)
    );
  return { lat: toDeg(la2), lng: ((toDeg(lo2) + 540) % 360) - 180 };
}

/** fetch with a timeout, so one dead host cannot stall a layer. */
export async function fetchJSON(url, { timeout = 12_000, ...opts } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchText(url, { timeout = 15_000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** localStorage with a TTL, used to stay inside anonymous rate limits. */
export const cache = {
  get(key, maxAgeMs) {
    try {
      const raw = localStorage.getItem(`signals:${key}`);
      if (!raw) return null;
      const { t, v } = JSON.parse(raw);
      if (Date.now() - t > maxAgeMs) return null;
      return v;
    } catch {
      return null;
    }
  },
  set(key, v) {
    try {
      localStorage.setItem(`signals:${key}`, JSON.stringify({ t: Date.now(), v }));
    } catch {
      /* quota or private mode — caching is an optimisation, not a requirement */
    }
  },
};

export const fmt = {
  int: (n) => (n == null ? '—' : Math.round(n).toLocaleString()),
  ft: (n) => (n == null ? '—' : `${Math.round(n).toLocaleString()} ft`),
  kt: (n) => (n == null ? '—' : `${Math.round(n)} kt`),
  km: (n) => (n == null ? '—' : n < 10 ? `${n.toFixed(1)} km` : `${Math.round(n).toLocaleString()} km`),
  deg: (n) => (n == null ? '—' : `${Math.round(n)}°`),
  coord: (lat, lng) =>
    `${Math.abs(lat).toFixed(3)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lng).toFixed(3)}°${lng >= 0 ? 'E' : 'W'}`,
  ago: (ms) => {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  },
  clock: (d = new Date()) => d.toISOString().slice(11, 19) + 'Z',
};

/** Colour ramp helper: pick from stops by a normalised 0..1 value. */
export function ramp(stops, t) {
  const i = clamp(Math.floor(t * (stops.length - 1)), 0, stops.length - 2);
  return stops[t >= 1 ? stops.length - 1 : i];
}

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

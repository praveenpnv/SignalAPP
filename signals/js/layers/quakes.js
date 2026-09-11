/**
 * Seismic layer — USGS GeoJSON feeds, refreshed every few minutes.
 * Colour encodes depth, size encodes magnitude.
 */

import { QUAKE_FEEDS, QUAKE_POLL_MS } from '../config.js';
import { fetchJSON } from '../util.js';

export class QuakeLayer {
  constructor() {
    this.quakes = [];
    this.feed = 'day';
    this.enabled = false;
    this.status = 'idle';
    this.lastUpdate = 0;
    this._timer = null;
  }

  start() {
    this.enabled = true;
    this.poll();
    this._timer = setInterval(() => this.poll(), QUAKE_POLL_MS);
  }

  stop() {
    this.enabled = false;
    clearInterval(this._timer);
    this._timer = null;
    this.quakes = [];
    this.status = 'off';
  }

  async setFeed(feed) {
    this.feed = feed;
    if (this.enabled) await this.poll();
  }

  async poll() {
    this.status = 'scanning';
    try {
      const data = await fetchJSON(QUAKE_FEEDS[this.feed].url);
      this.quakes = (data.features || [])
        .filter((f) => f.geometry?.coordinates)
        .map((f) => {
          const [lng, lat, depthKm] = f.geometry.coordinates;
          return {
            id: `eq-${f.id}`,
            kind: 'quake',
            name: f.properties.place || 'Unknown location',
            mag: f.properties.mag,
            depthKm,
            time: f.properties.time,
            tsunami: !!f.properties.tsunami,
            url: f.properties.url,
            felt: f.properties.felt,
            lat,
            lng,
          };
        })
        .sort((a, b) => b.time - a.time);
      this.lastUpdate = Date.now();
      this.status = 'live';
    } catch {
      this.status = 'unreachable';
    }
  }

  /** Anything big and recent deserves an expanding ring. */
  rings() {
    const cutoff = Date.now() - 6 * 3600_000;
    return this.quakes.filter((q) => q.mag >= 5 && q.time > cutoff);
  }
}

/** Shallow quakes are the damaging ones — warm colours bring them forward. */
export function quakeColor(q) {
  const d = q.depthKm ?? 0;
  if (d < 33) return '#ff3b30';
  if (d < 70) return '#ff9f0a';
  if (d < 150) return '#ffd60a';
  if (d < 300) return '#30d158';
  return '#0a84ff';
}

export function quakeRadius(q) {
  const m = Math.max(1, q.mag ?? 1);
  return 0.1 + Math.pow(m / 10, 2.2) * 3.0;
}

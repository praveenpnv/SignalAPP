/**
 * Orbital layer.
 *
 * TLEs come from CelesTrak and are propagated in the browser with SGP4
 * (satellite.js). Nothing about a satellite's position is fetched live —
 * it is computed, which is why the layer keeps working offline once the
 * elements are cached and why orbit rings stay locked to their object
 * instead of drifting.
 */

import * as satellite from 'satellite.js';
import { SAT_GROUPS, CELESTRAK_TLE, TLE_CACHE_HOURS } from '../config.js';
import { fetchText, cache, toDeg } from '../util.js';

export class SatelliteLayer {
  constructor() {
    this.sats = [];
    this.enabled = false;
    this.status = 'idle';
    this.groupsOn = new Set(['stations', 'visual']);
    this.lastPropagate = 0;
    this._loaded = new Set();
  }

  async load() {
    this.status = 'loading';
    const wanted = SAT_GROUPS.filter((g) => this.groupsOn.has(g.group));
    await Promise.all(wanted.map((g) => this._loadGroup(g)));
    this.status = this.sats.length ? 'live' : 'unreachable';
    return this.sats.length;
  }

  async _loadGroup(g) {
    if (this._loaded.has(g.group)) return;
    const key = `tle:${g.group}`;
    let text = cache.get(key, TLE_CACHE_HOURS * 3600_000);
    if (!text) {
      try {
        text = await fetchText(CELESTRAK_TLE(g.group));
        cache.set(key, text);
      } catch {
        return;
      }
    }
    const parsed = parseTLE(text).slice(0, g.cap);
    for (const rec of parsed) {
      try {
        const satrec = satellite.twoline2satrec(rec.l1, rec.l2);
        if (!satrec || satrec.error) continue;
        this.sats.push({
          id: `sat-${rec.norad}`,
          kind: 'satellite',
          name: rec.name,
          norad: rec.norad,
          group: g.group,
          groupLabel: g.label,
          color: g.color,
          satrec,
          lat: 0,
          lng: 0,
          altKm: 0,
          speedKms: 0,
        });
      } catch {
        /* a malformed element set is not worth failing the layer over */
      }
    }
    this._loaded.add(g.group);
  }

  async setGroup(group, on) {
    if (on) {
      this.groupsOn.add(group);
      const g = SAT_GROUPS.find((x) => x.group === group);
      if (g) await this._loadGroup(g);
    } else {
      this.groupsOn.delete(group);
      this.sats = this.sats.filter((s) => s.group !== group);
      this._loaded.delete(group);
    }
  }

  /** Advance every satellite to `date`. Cheap enough to run a few times a second. */
  propagate(date = new Date()) {
    const gmst = satellite.gstime(date);
    for (const s of this.sats) {
      if (!this.groupsOn.has(s.group)) continue;
      try {
        const pv = satellite.propagate(s.satrec, date);
        if (!pv || !pv.position) {
          s.decayed = true;
          continue;
        }
        const gd = satellite.eciToGeodetic(pv.position, gmst);
        s.lat = toDeg(gd.latitude);
        s.lng = ((toDeg(gd.longitude) + 540) % 360) - 180;
        s.altKm = gd.height;
        const v = pv.velocity;
        s.speedKms = Math.hypot(v.x, v.y, v.z);
        s.decayed = false;
      } catch {
        // A decayed or otherwise unpropagatable object drops out of the
        // scene rather than taking the whole layer down with it.
        s.decayed = true;
      }
    }
    this.lastPropagate = date.getTime();
  }

  active() {
    return this.sats.filter((s) => this.groupsOn.has(s.group) && !s.decayed);
  }

  find(id) {
    return this.sats.find((s) => s.id === id);
  }

  /** One full revolution as a ground track, for the orbit ring. */
  groundTrack(sat, points = 160) {
    const periodMin = (2 * Math.PI) / sat.satrec.no; // minutes per rev
    const stepMs = (periodMin * 60_000) / points;
    const t0 = Date.now();
    const track = [];
    for (let i = 0; i <= points; i++) {
      const d = new Date(t0 + i * stepMs);
      let pv;
      try {
        pv = satellite.propagate(sat.satrec, d);
      } catch {
        continue;
      }
      if (!pv || !pv.position) continue;
      const gd = satellite.eciToGeodetic(pv.position, satellite.gstime(d));
      track.push({
        lat: toDeg(gd.latitude),
        lng: ((toDeg(gd.longitude) + 540) % 360) - 180,
        altKm: gd.height,
      });
    }
    return track;
  }

  /**
   * Next visible passes over an observer, found by stepping the propagator
   * and watching for elevation to rise above the horizon mask.
   */
  nextPasses(sat, observer, { hours = 24, minElev = 10, max = 3 } = {}) {
    const obsGd = {
      longitude: (observer.lng * Math.PI) / 180,
      latitude: (observer.lat * Math.PI) / 180,
      height: 0.05,
    };
    const stepS = 30;
    const passes = [];
    let current = null;

    for (let t = 0; t < hours * 3600 && passes.length < max; t += stepS) {
      const date = new Date(Date.now() + t * 1000);
      let pv;
      try {
        pv = satellite.propagate(sat.satrec, date);
      } catch {
        break;
      }
      if (!pv || !pv.position) break;
      const ecf = satellite.eciToEcf(pv.position, satellite.gstime(date));
      const look = satellite.ecfToLookAngles(obsGd, ecf);
      const elev = toDeg(look.elevation);

      if (elev >= minElev) {
        if (!current) current = { start: date, peak: elev, peakAt: date };
        else if (elev > current.peak) {
          current.peak = elev;
          current.peakAt = date;
        }
      } else if (current) {
        current.end = date;
        current.durationMin = (current.end - current.start) / 60000;
        passes.push(current);
        current = null;
      }
    }
    return passes;
  }
}

/** Classic 3-line TLE text into records. */
export function parseTLE(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd());
  const out = [];
  for (let i = 0; i + 2 < lines.length; i++) {
    if (!lines[i] || lines[i].startsWith('1 ') || lines[i].startsWith('2 ')) continue;
    const l1 = lines[i + 1];
    const l2 = lines[i + 2];
    if (!l1?.startsWith('1 ') || !l2?.startsWith('2 ')) continue;
    out.push({
      name: lines[i].trim(),
      norad: l1.slice(2, 7).trim(),
      l1,
      l2,
    });
    i += 2;
  }
  return out;
}

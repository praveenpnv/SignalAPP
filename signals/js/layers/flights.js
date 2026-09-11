/**
 * Live aircraft layer.
 *
 * Community ADS-B networks publish a point-and-radius endpoint capped at
 * 250 nm, so this layer always has a focus point: whatever the camera is
 * looking at. Move the globe, and the scan follows.
 *
 * Two details worth knowing:
 *
 *  1. Feeds refresh every 15-30 s but aircraft move continuously. Between
 *     updates we dead-reckon each contact forward from its last known fix
 *     using ground speed and track, so the scene moves smoothly instead of
 *     teleporting once every 20 s.
 *  2. Sources are tried in order and the first one that answers wins. The
 *     HUD reports which network is actually feeding you.
 */

import {
  FLIGHT_SOURCES, FLIGHT_RADIUS_NM, FLIGHT_POLL_MS, FOLLOW_POLL_MS, FOLLOW_GRACE_MS,
} from '../config.js';
import { parseQuery } from '../airlines.js';
import { fetchJSON, haversineKm, project } from '../util.js';

const TRAIL_MAX = 60;

export class FlightLayer {
  constructor() {
    this.contacts = new Map(); // hex -> contact
    // Stable render records. globe.gl keys its meshes by object identity,
    // so handing it a fresh object every frame would rebuild the whole
    // scene 20 times a second. We mutate these in place instead.
    this._render = new Map();
    this.focus = null;
    this.source = null;
    this.lastUpdate = 0;
    this.status = 'idle';
    this.enabled = false;
    this._timer = null;
    this._inflight = false;

    // Follow mode: one aircraft polled by hex network-wide, independent
    // of where the camera happens to be pointing.
    this.followId = null;
    this.followMeta = null;   // { hex, callsign, lastFix, lost }
    this._followTimer = null;
  }

  setFocus(lat, lng, { immediate = false } = {}) {
    const moved =
      !this.focus || haversineKm(this.focus, { lat, lng }) > 120;
    this.focus = { lat, lng };
    if (moved && this.enabled && immediate) this.poll();
  }

  start() {
    this.enabled = true;
    this.poll();
    this._timer = setInterval(() => this.poll(), FLIGHT_POLL_MS);
  }

  stop() {
    this.enabled = false;
    clearInterval(this._timer);
    this._timer = null;
    this.contacts.clear();
    this.status = 'off';
  }

  /**
   * Force a poll now, even if one is already in flight.
   *
   * The ordinary guard makes a second poll a no-op, which is right for the
   * timer but wrong for a user pressing retry after changing the proxy —
   * they would get the stale result and conclude their fix had failed.
   */
  async retry() {
    this._inflight = false;
    this.blocked = false;
    await this.poll();
    return this.status;
  }

  async poll() {
    if (!this.focus || this._inflight || !this.enabled) return;
    this._inflight = true;
    this.status = 'scanning';

    const { lat, lng } = this.focus;
    // Try the source that worked last time first — no point re-probing a
    // network that is already answering.
    const ordered = this.source
      ? [
          ...FLIGHT_SOURCES.filter((s) => s.name === this.source),
          ...FLIGHT_SOURCES.filter((s) => s.name !== this.source),
        ]
      : FLIGHT_SOURCES;

    for (const src of ordered) {
      try {
        const data = await fetchJSON(src.point(lat, lng, FLIGHT_RADIUS_NM), {
          timeout: 9000,
        });
        const raw = data.ac || data.aircraft || [];
        this._ingest(raw);
        this.source = src.name;
        this.lastUpdate = Date.now();
        this.status = 'live';
        this.blocked = false;
        this._inflight = false;
        return;
      } catch (err) {
        // fall through to the next network
      }
    }

    // Every network refused or timed out. Almost always this is CORS:
    // the ADS-B hosts serve public data but send no
    // Access-Control-Allow-Origin header, so the browser blocks the read.
    // See ADSB_PROXY in config.js.
    this.status = 'unreachable';
    this.blocked = true;
    this._inflight = false;
  }

  _ingest(raw) {
    const now = Date.now();
    const seen = new Set();

    for (const a of raw) {
      if (typeof a.lat !== 'number' || typeof a.lon !== 'number') continue;
      const id = a.hex || a.r || `${a.lat},${a.lon}`;
      seen.add(id);

      const onGround = a.alt_baro === 'ground';
      const altFt = onGround ? 0 : Number(a.alt_baro ?? a.alt_geom ?? 0) || 0;

      const prev = this.contacts.get(id);
      const contact = {
        id,
        kind: 'flight',
        hex: a.hex,
        callsign: (a.flight || '').trim() || a.r || a.hex?.toUpperCase() || '—',
        reg: a.r || null,
        type: a.t || null,
        desc: a.desc || null,
        lat: a.lat,
        lng: a.lon,
        altFt,
        onGround,
        gs: typeof a.gs === 'number' ? a.gs : null,
        track: typeof a.track === 'number' ? a.track : (a.true_heading ?? null),
        vert: typeof a.baro_rate === 'number' ? a.baro_rate : (a.geom_rate ?? null),
        squawk: a.squawk || null,
        category: a.category || null,
        military: isMilitary(a),
        emergency: a.emergency && a.emergency !== 'none' ? a.emergency : null,
        fixAt: now,
        trail: prev ? prev.trail : [],
      };

      // Only record a trail point when the aircraft has actually moved.
      const last = contact.trail[contact.trail.length - 1];
      if (!last || haversineKm(last, contact) > 0.6) {
        contact.trail = [...contact.trail, { lat: contact.lat, lng: contact.lng, altFt }].slice(
          -TRAIL_MAX
        );
      }

      this.contacts.set(id, contact);
    }

    // Drop contacts that have left the scan volume and gone stale. A
    // followed aircraft is exempt — it is usually outside the scan area,
    // which is the whole point of following it.
    for (const [id, c] of this.contacts) {
      if (id === this.followId) continue;
      if (!seen.has(id) && now - c.fixAt > 90_000) this.contacts.delete(id);
    }
  }

  /**
   * Positions interpolated to `now`. We deliberately render one poll
   * interval behind the newest fix so that there is always a real fix
   * ahead to move toward, rather than extrapolating into the unknown.
   */
  positions(now = Date.now()) {
    const out = [];
    for (const c of this.contacts.values()) {
      const dt = (now - c.fixAt) / 1000;
      let lat = c.lat;
      let lng = c.lng;
      if (c.gs && c.track != null && dt > 0 && dt < 120 && !c.onGround) {
        const km = (c.gs * 1.852 * dt) / 3600; // knots -> km
        const p = project(c.lat, c.lng, c.track, km);
        lat = p.lat;
        lng = p.lng;
      }
      let rec = this._render.get(c.id);
      if (!rec) {
        rec = { id: c.id, kind: 'flight' };
        this._render.set(c.id, rec);
      }
      Object.assign(rec, c, { lat, lng });
      out.push(rec);
    }
    for (const id of this._render.keys()) {
      if (!this.contacts.has(id)) this._render.delete(id);
    }
    return out;
  }

  // ------------------------------------------------------------ search

  /**
   * Find an aircraft anywhere on the network by flight number, callsign,
   * registration or Mode-S hex.
   *
   * The lookup endpoints are not bounded by the 250 nm scan radius, so a
   * flight over the Pacific is findable from a camera over Bengaluru. It
   * still has to be airborne and inside some volunteer receiver's
   * coverage — an empty result means "not currently being heard", not
   * "no such flight".
   */
  async search(input) {
    const { query, candidates } = parseQuery(input);
    if (!candidates.length) return { query, results: [], tried: [] };

    const ordered = this.source
      ? [
          ...FLIGHT_SOURCES.filter((s) => s.name === this.source),
          ...FLIGHT_SOURCES.filter((s) => s.name !== this.source),
        ]
      : FLIGHT_SOURCES;

    const found = new Map();
    const tried = [];
    // Did any network actually answer? "No aircraft matched" and "nobody
    // would talk to us" are completely different answers and the UI must
    // not present the second as the first.
    let reached = false;

    for (const cand of candidates) {
      for (const src of ordered) {
        const build = src[cand.kind];
        if (!build) continue;
        tried.push(`${src.name}/${cand.kind}`);
        try {
          const data = await fetchJSON(build(encodeURIComponent(cand.value)), { timeout: 8000 });
          reached = true;
          const raw = data.ac || data.aircraft || [];
          if (!raw.length) break;          // this network answered, just no match
          this._ingest(raw);
          for (const a of raw) {
            const id = a.hex || a.r;
            const c = id && this.contacts.get(id);
            if (c) found.set(c.id, c);
          }
          this.source = src.name;
          this.blocked = false;
          break;                            // got an answer, next candidate
        } catch {
          // try the next network for this same candidate
        }
      }
      if (found.size) break;                // first candidate that hits wins
    }

    if (!reached) this.blocked = true;
    return { query, results: [...found.values()], tried, reached };
  }

  // ------------------------------------------------------------ follow

  /** Lock onto one aircraft and keep it fed regardless of the camera. */
  follow(contact) {
    this.unfollow();
    if (!contact?.hex) return false;
    this.followId = contact.id;
    this.followMeta = {
      hex: contact.hex,
      callsign: contact.callsign,
      lastFix: contact.fixAt,
      lost: false,
    };
    this._followTimer = setInterval(() => this._pollFollow(), FOLLOW_POLL_MS);
    return true;
  }

  unfollow() {
    clearInterval(this._followTimer);
    this._followTimer = null;
    this.followId = null;
    this.followMeta = null;
  }

  async _pollFollow() {
    if (!this.followMeta) return;
    const { hex } = this.followMeta;

    for (const src of FLIGHT_SOURCES) {
      if (!src.hex) continue;
      try {
        const data = await fetchJSON(src.hex(encodeURIComponent(hex)), { timeout: 8000 });
        const raw = (data.ac || data.aircraft || []).filter(
          (a) => typeof a.lat === 'number' && typeof a.lon === 'number'
        );
        if (raw.length) {
          this._ingest(raw);
          this.followMeta.lastFix = Date.now();
          this.followMeta.lost = false;
          return;
        }
      } catch {
        // next network
      }
    }

    // Nobody is hearing it right now. Keep the last known position on
    // screen for a while — coverage gaps are common over water — then
    // give up rather than leave a ghost flying on dead reckoning.
    this.followMeta.lost = true;
    if (Date.now() - this.followMeta.lastFix > FOLLOW_GRACE_MS) {
      const id = this.followId;
      this.unfollow();
      this.contacts.delete(id);
      this._render.delete(id);
    }
  }

  followed() {
    return this.followId ? this.contacts.get(this.followId) : null;
  }

  /** Nearby contacts, closest first — the roster shown in the side panel. */
  roster(limit = 40) {
    if (!this.focus) return [];
    return this.positions()
      .map((c) => ({ ...c, distKm: haversineKm(this.focus, c) }))
      .sort((a, b) => a.distKm - b.distKm)
      .slice(0, limit);
  }
}

/**
 * Military-ish detection from the ICAO hex block. This is the same coarse
 * heuristic the community feeds use for their own "military" filter — it
 * catches allocated military ranges, and it will miss plenty. Treated as a
 * hint for colouring, never as a claim.
 */
function isMilitary(a) {
  if (a.dbFlags & 1) return true;
  const hex = (a.hex || '').toLowerCase();
  if (!hex) return false;
  const n = parseInt(hex, 16);
  const ranges = [
    [0xadf7c8, 0xafffff], // US military
    [0x010070, 0x01008f],
    [0x33ff00, 0x33ffff],
    [0x3aa000, 0x3affff],
    [0x3b7000, 0x3bffff],
    [0x3ea000, 0x3ebfff],
    [0x3f4000, 0x3fbfff],
    [0x43c000, 0x43cfff], // UK military
    [0x448000, 0x4487ff],
    [0x4b7000, 0x4b7fff],
    [0x7cf800, 0x7cfaff], // Australia
    [0xc20000, 0xc3ffff], // Canada
    [0xe40000, 0xe41fff],
  ];
  return ranges.some(([lo, hi]) => n >= lo && n <= hi);
}

/** Altitude colour ramp, low (warm) to high (cool). */
export function flightColor(c) {
  if (c.emergency) return '#ff2d55';
  if (c.military) return '#ffb703';
  if (c.onGround) return '#7a8899';
  const t = Math.min(1, (c.altFt || 0) / 42000);
  const stops = ['#ff6b35', '#ffc857', '#6ee7b7', '#4cc9f0', '#8ab4ff'];
  const i = Math.min(stops.length - 1, Math.floor(t * stops.length));
  return stops[i];
}

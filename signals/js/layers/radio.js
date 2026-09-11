/**
 * World radio layer.
 *
 * Every marker is a real transmitter with real coordinates, and clicking
 * one plays its actual stream. Only https streams are kept: this page is
 * served over https, so a plain-http stream would be blocked as mixed
 * content and fail silently, which is worse than not offering it.
 */

import { RADIO_MIRRORS, RADIO_LIMIT } from '../config.js';
import { fetchJSON, haversineKm } from '../util.js';

export class RadioLayer {
  constructor() {
    this.stations = [];
    this.enabled = false;
    this.status = 'idle';
    this.playing = null;
    this.audio = null;
    this._loaded = false;
  }

  async load() {
    if (this._loaded) return this.stations.length;
    this.status = 'loading';
    const mirrors = [...RADIO_MIRRORS].sort(() => Math.random() - 0.5);

    for (const base of mirrors) {
      try {
        const url =
          `${base}/json/stations/search?limit=${RADIO_LIMIT}` +
          `&hidebroken=true&has_geo_info=true&order=votes&reverse=true`;
        const data = await fetchJSON(url, { timeout: 14_000 });
        this.stations = data
          .filter(
            (s) =>
              s.geo_lat != null &&
              s.geo_long != null &&
              typeof s.url_resolved === 'string' &&
              s.url_resolved.startsWith('https://')
          )
          .map((s) => ({
            id: `radio-${s.stationuuid}`,
            kind: 'radio',
            name: s.name?.trim() || 'Unnamed station',
            country: s.country || '',
            tags: (s.tags || '').split(',').filter(Boolean).slice(0, 4),
            bitrate: s.bitrate,
            codec: s.codec,
            votes: s.votes,
            stream: s.url_resolved,
            homepage: s.homepage,
            lat: Number(s.geo_lat),
            lng: Number(s.geo_long),
          }))
          .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
        this._loaded = true;
        this.status = this.stations.length ? 'live' : 'empty';
        return this.stations.length;
      } catch {
        /* try the next mirror */
      }
    }
    this.status = 'unreachable';
    return 0;
  }

  nearest(point, limit = 12) {
    return this.stations
      .map((s) => ({ ...s, distKm: haversineKm(point, s) }))
      .sort((a, b) => a.distKm - b.distKm)
      .slice(0, limit);
  }

  play(station) {
    this.stop();
    const audio = new Audio(station.stream);
    audio.crossOrigin = 'anonymous';
    audio.volume = 0.75;
    this.audio = audio;
    this.playing = station;
    return audio.play().catch((err) => {
      this.playing = null;
      this.audio = null;
      throw err;
    });
  }

  stop() {
    if (this.audio) {
      this.audio.pause();
      this.audio.src = '';
      this.audio = null;
    }
    this.playing = null;
  }
}

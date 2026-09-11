/**
 * The globe: one three.js scene driven by globe.gl, fed by the layers.
 *
 * Everything visible is one of four globe.gl layers:
 *   objects — aircraft glyphs and satellites (3D, depth-sorted)
 *   points  — earthquakes and radio transmitters (surface columns)
 *   paths   — flight trails and satellite ground tracks
 *   rings   — selection halo, seismic pulses, the scan centre
 */

import Globe from 'globe.gl';
import * as THREE from 'three';
import { GLOBE_RADIUS } from './config.js';
import { flightColor } from './layers/flights.js';
import { quakeColor, quakeRadius } from './layers/quakes.js';

const EARTH_KM = 6371;

/**
 * Aircraft fly a few thousandths of an earth radius above the ground, which
 * is invisible at globe scale. We lift them by a fixed factor so altitude
 * reads at a glance, and the HUD says so rather than pretending otherwise.
 */
export const ALT_EXAGGERATION = 16;

export class GlobeView {
  constructor(container, { onSelect, onCameraSettle }) {
    this.container = container;
    this.onSelect = onSelect;
    this.onCameraSettle = onCameraSettle;
    this.selectedId = null;
    this._geomCache = new Map();
    this._matCache = new Map();
    this._meshes = new Map();   // datum id -> mesh, for zoom-aware sizing
    this._glyphScale = 0.5;

    this.globe = new Globe(container, { animateIn: true })
      .backgroundColor('#05070d')
      .showAtmosphere(true)
      .atmosphereColor('#4c7fd4')
      .atmosphereAltitude(0.17)
      .showGraticules(false)
      .objectsData([])
      .objectLat('lat')
      .objectLng('lng')
      .objectAltitude('renderAlt')
      .objectFacesSurface(true)
      .objectRotation((d) => ({ x: 0, y: 0, z: -(d.heading ?? 0) }))
      .objectThreeObject((d) => this._objectFor(d))
      .objectLabel((d) => this._tooltip(d))
      .onObjectClick((d) => this.onSelect?.(d))
      .pointsData([])
      .pointLat('lat')
      .pointLng('lng')
      .pointAltitude('renderAlt')
      .pointRadius('renderRadius')
      .pointColor('renderColor')
      .pointsMerge(false)
      .pointResolution(8)
      .pointLabel((d) => this._tooltip(d))
      .onPointClick((d) => this.onSelect?.(d))
      .pathsData([])
      .pathPoints('points')
      .pathPointLat('lat')
      .pathPointLng('lng')
      .pathPointAlt('alt')
      .pathColor('color')
      .pathStroke('stroke')
      .pathTransitionDuration(0)
      .ringsData([])
      .ringLat('lat')
      .ringLng('lng')
      .ringAltitude('alt')
      .ringColor('color')
      .ringMaxRadius('maxR')
      .ringPropagationSpeed('speed')
      .ringRepeatPeriod('period')
      .showPointerCursor(true);

    this.setBasemap('night');

    const controls = this.globe.controls();
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.18;
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.minDistance = GLOBE_RADIUS * 1.04;
    controls.maxDistance = GLOBE_RADIUS * 6;

    // Camera "settle" — fires once the user stops moving, so the flight
    // scan follows the view without firing a request per frame.
    let settleTimer = null;
    this.globe.onZoom((pov) => {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => this.onCameraSettle?.(pov), 700);
    });

    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    this.globe.width(this.container.clientWidth).height(this.container.clientHeight);
  }

  setBasemap(kind) {
    const base = 'assets/';
    if (kind === 'day') {
      this.globe.globeImageUrl(`${base}earth-blue-marble.jpg`).bumpImageUrl(`${base}earth-topology.png`);
    } else {
      this.globe.globeImageUrl(`${base}earth-night.jpg`).bumpImageUrl(`${base}earth-topology.png`);
    }
    this.globe.backgroundImageUrl(`${base}night-sky.png`);
  }

  setAutoRotate(on) {
    this.globe.controls().autoRotate = on;
  }

  pov() {
    return this.globe.pointOfView();
  }

  flyTo(lat, lng, altitude = 1.4, ms = 1400) {
    this.globe.pointOfView({ lat, lng, altitude }, ms);
  }

  // ---------------------------------------------------------------- meshes

  _material(color) {
    if (!this._matCache.has(color)) {
      this._matCache.set(
        color,
        new THREE.MeshBasicMaterial({
          color,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.96,
        })
      );
    }
    return this._matCache.get(color);
  }

  _geometry(key, build) {
    if (!this._geomCache.has(key)) this._geomCache.set(key, build());
    return this._geomCache.get(key);
  }

  /**
   * Aircraft are a flat plan-view dart lying in the local tangent plane.
   * objectFacesSurface gives us a frame where +X is east, +Y is north and
   * +Z is up, so the glyph is authored nose-along-+Y and then spun about
   * the local vertical by -heading. That is why a contact points the right
   * way from every camera angle instead of pinwheeling as you orbit.
   */
  _aircraftGeometry() {
    return this._geometry('aircraft', () => {
      const s = new THREE.Shape();
      s.moveTo(0, 1.55);
      s.lineTo(-1.05, -1.15);
      s.lineTo(0, -0.5);
      s.lineTo(1.05, -1.15);
      s.closePath();
      return new THREE.ShapeGeometry(s);
    });
  }

  _objectFor(d) {
    let mesh;
    if (d.kind === 'flight') {
      mesh = new THREE.Mesh(this._aircraftGeometry(), this._material(d.renderColor));
    } else {
      const geo = this._geometry('sat', () => new THREE.OctahedronGeometry(0.9, 0));
      mesh = new THREE.Mesh(geo, this._material(d.renderColor));
    }
    mesh.userData.kind = d.kind;
    mesh.userData.needsScale = true;
    this._meshes.set(d.id, mesh);
    this._applyScale(mesh, d);
    return mesh;
  }

  /**
   * Glyphs are sized against camera distance so they stay roughly constant
   * on screen. Without this an aircraft is a sub-pixel speck from orbit and
   * covers a whole city from close in.
   *
   * The camera sits `altitude * R` above the surface and globe.gl uses a
   * 50° vertical field of view, so the visible world height near the
   * surface is about 0.93 * altitude * R. Targeting ~1.2% of the viewport
   * for a glyph roughly 2.7 units tall gives the factor below.
   */
  _scaleFor(kind, selected) {
    const base = kind === 'flight' ? 1 : 0.8;
    return this._glyphScale * base * (selected ? 1.9 : 1);
  }

  _applyScale(mesh, d) {
    const s = this._scaleFor(mesh.userData.kind, d && d.id === this.selectedId);
    mesh.scale.set(s, s, s);
  }

  _updateScales(data) {
    const alt = this.globe.pointOfView().altitude ?? 2;
    const next = Math.min(1.8, Math.max(0.16, 0.42 * alt));
    const changed =
      Math.abs(next / (this._glyphScale || 1) - 1) > 0.04 || this._lastSel !== this.selectedId;
    this._glyphScale = next;
    this._lastSel = this.selectedId;

    for (const d of data) {
      const mesh = this._meshes.get(d.id);
      if (!mesh) continue;
      if (changed || mesh.userData.needsScale) {
        this._applyScale(mesh, d);
        mesh.userData.needsScale = false;
      }
    }
    if (this._meshes.size > data.length * 2) {
      const live = new Set(data.map((d) => d.id));
      for (const id of this._meshes.keys()) if (!live.has(id)) this._meshes.delete(id);
    }
  }

  _tooltip(d) {
    if (d.kind === 'flight') {
      return `<div class="tip"><b>${esc(d.callsign)}</b>
        <span>${esc(d.type || d.reg || '')}</span>
        <span>${d.onGround ? 'on ground' : Math.round(d.altFt).toLocaleString() + ' ft'}</span></div>`;
    }
    if (d.kind === 'satellite') {
      return `<div class="tip"><b>${esc(d.name)}</b><span>${esc(d.groupLabel)}</span>
        <span>${Math.round(d.altKm).toLocaleString()} km</span></div>`;
    }
    if (d.kind === 'quake') {
      return `<div class="tip"><b>M ${d.mag?.toFixed(1)}</b><span>${esc(d.name)}</span>
        <span>${Math.round(d.depthKm)} km deep</span></div>`;
    }
    if (d.kind === 'radio') {
      return `<div class="tip"><b>${esc(d.name)}</b><span>${esc(d.country)}</span>
        <span>click to listen</span></div>`;
    }
    return '';
  }

  // ----------------------------------------------------------------- feeds

  /** `objects` carries both aircraft and satellites in one depth-sorted pass. */
  renderObjects(flights, satellites) {
    const data = [];
    for (const f of flights) {
      f.kind = 'flight';
      f.renderAlt = ((f.altFt * 0.0003048) / EARTH_KM) * ALT_EXAGGERATION;
      f.heading = f.track ?? 0;
      f.renderColor = flightColor(f);
      f.selected = f.id === this.selectedId;
      data.push(f);
    }
    for (const s of satellites) {
      s.renderAlt = s.altKm / EARTH_KM;
      s.renderColor = s.color;
      s.selected = s.id === this.selectedId;
      data.push(s);
    }
    this.globe.objectsData(data);
    this._updateScales(data);
  }

  renderPoints(quakes, radios) {
    const data = [];
    for (const q of quakes) {
      q.renderAlt = 0.006;
      q.renderRadius = quakeRadius(q);
      q.renderColor = quakeColor(q);
      data.push(q);
    }
    for (const r of radios) {
      r.renderAlt = 0.004;
      r.renderRadius = r.id === this.selectedId ? 0.55 : 0.28;
      r.renderColor = r.playing ? '#39ff88' : '#00d4ff';
      data.push(r);
    }
    this.globe.pointsData(data);
  }

  renderPaths(paths) {
    this.globe.pathsData(paths);
  }

  renderRings(rings) {
    this.globe.ringsData(rings);
  }

  setSelected(id) {
    this.selectedId = id;
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

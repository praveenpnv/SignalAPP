/** DOM rendering. Nothing here touches the network or the globe. */

import { $, fmt } from './util.js';
import { SAT_GROUPS, SENSORS, PLACES } from './config.js';

export function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
}

export function bootLog(msg, cls = '') {
  const li = document.createElement('li');
  li.textContent = msg;
  if (cls) li.className = cls;
  $('#boot-log').appendChild(li);
}

export function bootDone() {
  $('#boot').classList.add('gone');
  setTimeout(() => $('#boot').remove(), 800);
}

const STATUS_CLASS = {
  live: 'live',
  scanning: 'scan',
  loading: 'scan',
  unreachable: 'dead',
  empty: 'warn',
};

export function renderChips(feeds) {
  $('#feedchips').innerHTML = feeds
    .map((f) => {
      const cls =
        f.status === 'live' ? 'live' : f.status === 'unreachable' ? 'dead' : f.status === 'off' ? '' : 'warn';
      return `<span class="chip ${cls}">${f.label}${f.detail ? ' · ' + f.detail : ''}</span>`;
    })
    .join('');
}

export function setLayerState(key, { status, count }) {
  const dot = $(`#dot-${key}`);
  if (dot) dot.className = 'dot ' + (STATUS_CLASS[status] || '');
  const ct = $(`#ct-${key}`);
  if (ct) ct.textContent = count == null ? '—' : fmt.int(count);
}

export function renderSatGroups(active, onToggle) {
  const wrap = $('#sat-groups');
  wrap.innerHTML = SAT_GROUPS.map(
    (g) => `<label style="color:${g.color}">
      <input type="checkbox" data-group="${g.group}" ${active.has(g.group) ? 'checked' : ''}>
      <span>${g.label}</span></label>`
  ).join('');
  wrap.querySelectorAll('input').forEach((i) =>
    i.addEventListener('change', () => onToggle(i.dataset.group, i.checked))
  );
}

export function renderSensors(current, onPick) {
  $('#sensors').innerHTML = SENSORS.map(
    (s, i) => `<button data-sensor="${s.key}" class="${s.key === current ? 'on' : ''}">${i + 1} ${s.key}</button>`
  ).join('');
  $('#sensors')
    .querySelectorAll('button')
    .forEach((b) => b.addEventListener('click', () => onPick(b.dataset.sensor)));
}

export function renderPlaces() {
  const sel = $('#place-jump');
  sel.innerHTML =
    '<option value="">Jump to…</option>' +
    PLACES.map((p, i) => `<option value="${i}">${p.name}</option>`).join('');
}

export function renderRoster(items, selectedId, onPick) {
  const ul = $('#roster');
  if (!items.length) {
    ul.innerHTML = '<li class="muted" style="border:0;cursor:default">No contacts in range yet.</li>';
    return;
  }
  ul.innerHTML = items
    .map((c) => {
      const color = c.renderColor || '#8d9cb0';
      const right = c.kind === 'flight' ? (c.onGround ? 'GND' : fmt.ft(c.altFt)) : fmt.km(c.distKm);
      const meta =
        c.kind === 'flight'
          ? `${c.type || c.reg || c.hex || ''} · ${fmt.km(c.distKm)} · ${c.onGround ? 'taxiing' : fmt.kt(c.gs)}`
          : c.country || '';
      return `<li data-id="${c.id}" class="${c.id === selectedId ? 'sel' : ''}" style="border-left-color:${color}">
        <span class="cs">${escapeHtml(c.callsign || c.name)}</span>
        <span class="rt">${right}</span>
        <span class="meta">${escapeHtml(meta)}</span>
      </li>`;
    })
    .join('');
  ul.querySelectorAll('li[data-id]').forEach((li) =>
    li.addEventListener('click', () => onPick(li.dataset.id))
  );
}

export function renderDetail(entity, ctx = {}) {
  const el = $('#detail');
  if (!entity) {
    el.innerHTML =
      '<p class="muted">Click anything on the globe — an aircraft, a satellite, a quake, a radio station.</p>';
    return;
  }

  if (entity.kind === 'flight') {
    el.innerHTML = `
      <h3>${escapeHtml(entity.callsign)}</h3>
      <p class="sub">${escapeHtml(entity.desc || entity.type || 'Unknown type')}${
        entity.military ? ' · <span style="color:var(--accent-warm)">military block</span>' : ''
      }</p>
      <dl class="kv">
        <dt>Altitude</dt><dd>${entity.onGround ? 'on ground' : fmt.ft(entity.altFt)}</dd>
        <dt>Ground speed</dt><dd>${fmt.kt(entity.gs)}</dd>
        <dt>Track</dt><dd>${fmt.deg(entity.track)}</dd>
        <dt>Vertical</dt><dd>${entity.vert == null ? '—' : fmt.int(entity.vert) + ' ft/min'}</dd>
        <dt>Position</dt><dd>${fmt.coord(entity.lat, entity.lng)}</dd>
        <dt>Registration</dt><dd>${escapeHtml(entity.reg || '—')}</dd>
        <dt>ICAO hex</dt><dd>${escapeHtml(entity.hex || '—')}</dd>
        <dt>Squawk</dt><dd>${escapeHtml(entity.squawk || '—')}</dd>
        <dt>Last fix</dt><dd>${fmt.ago(entity.fixAt)}</dd>
      </dl>
      <p class="muted" style="margin-top:10px">Position between fixes is dead-reckoned from ground speed and track.</p>`;
    return;
  }

  if (entity.kind === 'satellite') {
    const passes = ctx.passes || [];
    el.innerHTML = `
      <h3>${escapeHtml(entity.name)}</h3>
      <p class="sub">${escapeHtml(entity.groupLabel)} · NORAD ${escapeHtml(entity.norad)}</p>
      <dl class="kv">
        <dt>Altitude</dt><dd>${fmt.km(entity.altKm)}</dd>
        <dt>Speed</dt><dd>${entity.speedKms.toFixed(2)} km/s</dd>
        <dt>Sub-point</dt><dd>${fmt.coord(entity.lat, entity.lng)}</dd>
        <dt>Period</dt><dd>${(((2 * Math.PI) / entity.satrec.no) | 0)} min</dd>
        <dt>Inclination</dt><dd>${((entity.satrec.inclo * 180) / Math.PI).toFixed(2)}°</dd>
      </dl>
      ${
        ctx.observer
          ? `<p class="sub" style="margin:12px 0 0">Next passes over ${escapeHtml(ctx.observerName || 'you')} (10°+)</p>
             <ul class="passes">${
               passes.length
                 ? passes
                     .map(
                       (p) =>
                         `<li>${new Date(p.start).toLocaleTimeString([], {
                           hour: '2-digit',
                           minute: '2-digit',
                         })} · ${p.durationMin.toFixed(0)} min · peak ${p.peak.toFixed(0)}°</li>`
                     )
                     .join('')
                 : '<li>No pass above 10° in the next 24 h.</li>'
             }</ul>`
          : '<p class="muted" style="margin-top:10px">Set your position to get pass predictions.</p>'
      }
      <p class="muted" style="margin-top:10px">Propagated with SGP4 from CelesTrak elements — computed here, not fetched.</p>`;
    return;
  }

  if (entity.kind === 'quake') {
    el.innerHTML = `
      <h3>M ${entity.mag?.toFixed(1) ?? '—'}</h3>
      <p class="sub">${escapeHtml(entity.name)}</p>
      <dl class="kv">
        <dt>Depth</dt><dd>${fmt.km(entity.depthKm)}</dd>
        <dt>When</dt><dd>${fmt.ago(entity.time)}</dd>
        <dt>Position</dt><dd>${fmt.coord(entity.lat, entity.lng)}</dd>
        <dt>Felt reports</dt><dd>${entity.felt ? fmt.int(entity.felt) : '—'}</dd>
        <dt>Tsunami flag</dt><dd>${entity.tsunami ? 'yes' : 'no'}</dd>
      </dl>
      <div class="detail-actions">
        <a class="btn" href="${entity.url}" target="_blank" rel="noopener">USGS EVENT PAGE</a>
      </div>`;
    return;
  }

  if (entity.kind === 'radio') {
    el.innerHTML = `
      <h3>${escapeHtml(entity.name)}</h3>
      <p class="sub">${escapeHtml(entity.country)}${entity.tags.length ? ' · ' + escapeHtml(entity.tags.join(', ')) : ''}</p>
      <dl class="kv">
        <dt>Bitrate</dt><dd>${entity.bitrate ? entity.bitrate + ' kbps' : '—'}</dd>
        <dt>Codec</dt><dd>${escapeHtml(entity.codec || '—')}</dd>
        <dt>Position</dt><dd>${fmt.coord(entity.lat, entity.lng)}</dd>
      </dl>
      <div class="detail-actions">
        <button class="btn" id="btn-listen">${ctx.playing ? 'STOP' : 'LISTEN'}</button>
        ${entity.homepage ? `<a class="btn ghost" href="${escapeAttr(entity.homepage)}" target="_blank" rel="noopener">HOMEPAGE</a>` : ''}
      </div>`;
    return;
  }
}

export function renderLaunches(list) {
  const ul = $('#launch-list');
  if (!list?.length) {
    ul.innerHTML = '<li class="muted">Feed unavailable right now.</li>';
    return;
  }
  ul.innerHTML = list
    .slice(0, 6)
    .map((l) => {
      const d = new Date(l.net);
      return `<li><span class="lname2">${escapeHtml(l.name)}</span>
        <span class="lwhen">${d.toUTCString().slice(5, 22)}Z</span></li>`;
    })
    .join('');
}

// ─────────────────────────────────────────────────────── search

export function renderSearchDrop({ state, results = [], query = '', recent = [] }, handlers) {
  const el = $('#search-drop');

  if (state === 'hidden') {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;

  if (state === 'recent') {
    if (!recent.length) {
      el.hidden = true;
      return;
    }
    el.innerHTML =
      '<div class="sd-head">Recent</div><div class="sd-recent">' +
      recent.map((r) => `<button type="button" data-recent="${escapeHtml(r)}">${escapeHtml(r)}</button>`).join('') +
      '</div>';
    el.querySelectorAll('[data-recent]').forEach((b) =>
      b.addEventListener('click', () => handlers.onRecent(b.dataset.recent))
    );
    return;
  }

  if (state === 'searching') {
    el.innerHTML = `<div class="sd-empty">Asking the networks about <b>${escapeHtml(query)}</b>…</div>`;
    return;
  }

  if (state === 'blocked') {
    el.innerHTML = `<div class="sd-empty sd-blocked">
      <b>Couldn't reach any ADS-B network.</b><br>
      This is not the same as "no such flight" — the request never completed.
      The public aircraft feeds send no <code>Access-Control-Allow-Origin</code>
      header, so a browser refuses to let this page read them. Satellites,
      earthquakes and radio do send it and are unaffected.<br>
      The fix is a small proxy you own: deploy <code>worker/adsb-proxy.js</code>
      and set <code>ADSB_PROXY</code> in <code>js/config.js</code>. See the README.
    </div>`;
    return;
  }

  if (state === 'empty') {
    el.innerHTML = `<div class="sd-empty">
      Nothing on the network matching <b>${escapeHtml(query)}</b>.<br>
      ADS-B only shows aircraft that are airborne right now and within range of a
      volunteer receiver — so a flight that hasn't departed, has already landed, or
      is over open ocean simply isn't being heard. Try the ICAO callsign
      (AIC503 rather than AI503) or the registration.
    </div>`;
    return;
  }

  el.innerHTML =
    `<div class="sd-head">${results.length} match${results.length === 1 ? '' : 'es'}</div>` +
    results
      .map(
        (c) => `<button type="button" class="sd-item" data-id="${escapeHtml(c.id)}"
          style="border-left-color:${c.renderColor || '#4cc9f0'}">
          <span class="sd-cs">${escapeHtml(c.callsign)}</span>
          <span class="sd-alt">${c.onGround ? 'ON GROUND' : fmt.ft(c.altFt)}</span>
          <span class="sd-meta">${escapeHtml(
            [c.type || c.reg, c.desc, fmt.coord(c.lat, c.lng)].filter(Boolean).join(' · ')
          )}</span>
        </button>`
      )
      .join('');

  el.querySelectorAll('.sd-item').forEach((b) =>
    b.addEventListener('click', () => handlers.onPick(b.dataset.id))
  );
}

export function setFollowing(meta) {
  const el = $('#following');
  if (!meta) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.classList.toggle('lost', !!meta.lost);
  $('#fl-name').textContent = meta.callsign;
  $('#fl-state').textContent = meta.lost
    ? `signal lost · ${fmt.ago(meta.lastFix)}`
    : 'tracking';
}

export function setNowPlaying(station) {
  const el = $('#nowplaying');
  if (!station) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  $('#np-name').textContent = `${station.name} — ${station.country}`;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}
const escapeAttr = escapeHtml;

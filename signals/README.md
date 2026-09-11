# 🌐 SIGNALS

**A live 3D globe of public signals — aircraft, satellites, earthquakes and world radio — with no API keys, no server and no build pipeline to run.**

Open the page and you are looking at real telemetry: ADS-B transponders from community receiver networks, orbital elements propagated in your browser with SGP4, USGS seismic feeds, and geolocated radio transmitters you can actually listen to. Everything is fetched directly by the browser from open endpoints. There is no backend, because there is no secret to keep.

![SIGNALS](docs/preview.png)

*Screenshot captured against the test fixtures, so the callsigns are synthetic. Everything else — the globe, the orbital positions, the layout — is the real thing.*

---

## What's on the globe

| Layer | What you get | Source | Key |
|---|---|---|---|
| ✈️ **Aircraft** | Live ADS-B within 250 nm of wherever the camera is pointed: altitude-coloured glyphs oriented along their true heading, dead-reckoned between fixes, click-to-track with a trail and a full telemetry card. Plus **search and follow** — see below. ⚠️ **Needs a proxy — see below** | adsb.fi → airplanes.live → adsb.lol | none |
| 🛰️ **Satellites** | Space stations, brightest objects, GPS, weather and a Starlink slice — positions computed live with SGP4, one-revolution ground tracks, and pass predictions for your own location | CelesTrak | none |
| 🌍 **Seismic** | Global earthquakes for the last 24 hours or the last week, sized by magnitude and coloured by depth, with expanding pulses on anything M5+ | USGS | none |
| 📻 **World radio** | Hundreds of transmitters at their real coordinates. Click one and it plays | Radio Browser | none |
| 🚀 **Launches** | The next rockets off the pad | Launch Library 2 | none |

Six sensor looks (optical, NVG, thermal, ironbow, noir, CRT), a night or daylight basemap, a cinematic tour, and a share link that encodes the camera, the active layers and the sensor you were using.

## Finding a specific flight

Type into the search bar and the globe goes and gets it. Four kinds of identifier work:

| You type | What happens |
|---|---|
| `AI503` | IATA flight number — translated to the ICAO callsign `AIC503` via a bundled table of ~120 carriers |
| `AIC503` | ICAO callsign, used as-is |
| `VT-EXU` | Registration |
| `800abc` | Mode-S hex |

Ambiguous input is not guessed at: `ABC123` is a plausible callsign *and* a plausible hex, so both are queried and whichever answers wins.

Unlike the 250 nm scan, the lookup endpoints search the **whole network** — a flight over the Pacific is findable from a camera sitting over Bengaluru. On a hit the camera flies to the aircraft and **follows** it: that one Mode-S address is re-queried worldwide every 12 seconds and the camera rides along, so you can leave the tab open and watch it cross a continent. The banner reports `tracking`, or `signal lost` with the age of the last fix when it drops into a coverage gap; after four minutes with nothing heard it gives up rather than leave a ghost flying on dead reckoning alone. Recent searches are remembered locally.

`/` focuses the search box. **RELEASE** in the banner ends the follow and hands the camera back.

## ⚠️ The aircraft layer needs a proxy

Three of the four layers work from a static page. The aircraft layer does not, and the reason is worth stating plainly because it is invisible until you try it.

The public ADS-B networks — adsb.fi, airplanes.live, adsb.lol — serve public JSON over https and send **no `Access-Control-Allow-Origin` header**. Load one of their URLs in a browser tab and you get the data. Ask for the same URL with `fetch()` from a page on another origin and the browser refuses to hand you the response. The request succeeds; the browser just will not let the page read it.

Verified rather than assumed. From one page, one moment:

| Request | Result |
|---|---|
| USGS earthquakes | 200 ✓ |
| CelesTrak elements | 200 ✓ |
| Radio Browser | 200 ✓ |
| adsb.fi, airplanes.live, adsb.lol | `TypeError: Failed to fetch` |
| adsb.fi loaded directly in a tab | 200, full JSON |
| response headers from that tab | no `access-control-allow-origin` |

OpenSky Network and adsb.one behave the same way, and the public CORS relays were either gone or rejected the request. There is no keyless live-position feed that a browser can read cross-origin.

**The fix is a proxy you own.** `worker/adsb-proxy.js` is a ~40-line Cloudflare Worker that forwards the request and adds the header. It is not an open proxy: only those three hosts, GET only, 10-second edge cache so it stays inside their 1-request-per-second etiquette. Cloudflare's free tier is 100,000 requests a day, which is far more than this will ever use.

```bash
npm create cloudflare@latest signals-adsb -- --type=hello-world
# replace src/index.js with worker/adsb-proxy.js
npx wrangler deploy
```

Then set the URL it prints in `js/config.js` and rebuild:

```js
export const ADSB_PROXY = 'https://signals-adsb.yourname.workers.dev';
```

Leave `ADSB_PROXY` empty and nothing breaks — the aircraft layer reports that it is blocked and why, and the other three layers carry on. What it will never do is show an empty sky and let you assume it is quiet.

## Run it

```bash
git clone <this repo>
cd signals
npm install
npm run assets     # copies the globe textures out of three-globe
npm run build      # bundles js/ into dist/app.js
npm run serve      # http://localhost:4173
```

`dist/app.js` and `assets/` are committed, so the published site needs none of the above — any static host will serve this directory as-is. `npm run watch` rebuilds on change while you work.

### Keyboard

`/` search · `1`–`6` sensor look · `F` aircraft · `S` satellites · `E` seismic · `R` radio · `T` tour · `Space` auto-rotate · `Esc` deselect

### Console

The app leaves a handle on `window.SIGNALS`. `SIGNALS.flights.contacts`, `SIGNALS.sats.active()`, `SIGNALS.globe.flyTo(35.68, 139.69, 0.4)` — it is meant to be poked at.

## How it works

```
index.html          markup and chrome
css/style.css       the whole UI
js/
├── main.js         orchestration: boot, render loop, selection, search, sharing
├── config.js       every endpoint and tunable in one file
├── globe.js        globe.gl + three.js scene, glyph geometry and orientation
├── ui.js           DOM rendering — no network, no globe
├── airlines.js     IATA→ICAO carrier table and the search-query parser
├── util.js         geodesy, fetch-with-timeout, TTL cache, formatting
└── layers/
    ├── flights.js  ADS-B ingest, source failover, dead reckoning, trails,
    │                network-wide lookup and follow mode
    ├── satellites.js  TLE parsing, SGP4 propagation, ground tracks, passes
    ├── quakes.js   USGS GeoJSON
    └── radio.js    Radio Browser mirrors and playback
worker/
└── adsb-proxy.js   Cloudflare Worker adding the CORS header ADS-B omits
```

Four things in here were more interesting than they look:

**Headings that survive the camera.** An aircraft glyph has to point along its real-world track from every camera angle — orbit the globe and it must not pinwheel. Each object is placed in a local frame where `+X` is east, `+Y` is north and `+Z` is up, the glyph is authored nose-along-`+Y`, and it is then rotated about the local vertical by `-track`. The test suite recovers each glyph's forward axis from its world matrix and checks it against the reported track; the error is zero across every contact it samples.

**Smooth motion from choppy data.** ADS-B feeds land every 15–30 seconds. Rather than teleport aircraft on each poll, every contact is projected forward from its last known fix along its track at its ground speed, so the scene moves continuously. The detail panel says so rather than implying the position is observed.

**Nothing blocks anything, and nothing lies.** Each layer owns its polling, its failures and its status. If the radio directory is down, the aircraft keep flying; if every ADS-B mirror refuses, the globe still spins and the chip at the top turns red. Sources are tried in order and the one that answered last time is tried first.

More subtly: a search distinguishes *"a network answered and nothing matched"* from *"no network answered"*. Those look identical in naive code — both end with an empty array — and reporting the second as the first tells the user their flight does not exist when the truth is that the request never completed. The layer tracks whether anything was actually reached, and the UI says which happened.

**Glyphs sized by camera distance.** The camera sits `altitude × R` above the surface with a 50° field of view, so world-space glyph size is scaled with altitude to hold roughly constant on screen. Otherwise an aircraft is a sub-pixel speck from orbit and covers a city from close in.

## Tests

```bash
npx playwright install chromium   # first time only
npm run build
node scripts/smoke.mjs            # boots the page offline, asserts it survives dead feeds
node scripts/test-live.mjs        # intercepts every feed with fixtures and exercises the render path
```

`test-live.mjs` checks aircraft ingest and source failover, SGP4 output against known ISS values, glyph heading recovery, dead reckoning actually moving contacts, roster and detail rendering, satellite ground tracks, radio markers, the mobile bottom-sheet behaviour, and the whole search path — IATA→ICAO translation, registration lookup, the follow poller re-querying by hex, the camera lock-on landing on target, the honest no-match message, release tearing the follow down, and — by aborting every aircraft request — that a transport failure is reported as "couldn't reach any network" rather than "no such flight". It fails on any page error.

## Honesty about the data

This is an exploratory visualisation of public feeds, not an operational tool.

- **Coverage is uneven.** Community ADS-B depends on volunteer receivers. Oceans and much of the global south are thin or empty. An absence of aircraft is an absence of receivers, not an absence of traffic.
- **A flight you can't find may still be flying.** Search only sees aircraft that are airborne *right now* and within range of some receiver. Not yet departed, already landed, or mid-ocean all look identical to "no match", and the app says so rather than implying the flight doesn't exist.
- **The flight number is not what's transmitted.** ADS-B carries a callsign, which is usually the ICAO form (`AIC503`) rather than the IATA number on your boarding pass (`AI503`). The translation table covers common carriers; anything missing is tried verbatim. Codeshares are filed under the operating carrier, so a ticket bought on one airline may be flying under another's callsign.
- **Altitudes are exaggerated ×16** so they read at globe scale. The HUD says so on screen.
- **"Military" is a hint.** It comes from the ICAO hex allocation block. It catches known ranges and misses plenty, and it is used only to colour a glyph.
- **Positions between fixes are computed, not observed** — see dead reckoning above.
- **Satellite positions are propagated**, and SGP4 accuracy degrades as elements age. TLEs are cached for six hours.
- **Only https radio streams are offered.** A plain-http stream would be blocked as mixed content on an https page and fail silently.

Do not use any of this for navigation, emergency response, or anything where being wrong matters.

## Privacy

There is no analytics, no tracking and no backend. "My position" uses the browser geolocation prompt, is held in memory for the session, and is used only to centre the camera and compute satellite passes. Nothing is transmitted anywhere.

## Built on

[globe.gl](https://github.com/vasturiano/globe.gl) and [three.js](https://threejs.org) for the scene, [satellite.js](https://github.com/shashwatak/satellite-js) for SGP4, [esbuild](https://esbuild.github.io) for the bundle. Textures ship with [three-globe](https://github.com/vasturiano/three-globe) (NASA imagery).

Inspired by [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view) by Bilawal Sidhu — this is a much smaller, static, keyless take on the same idea, built to be readable in an afternoon.

Bundled and live data carries its own terms: [adsb.fi](https://adsb.fi), [airplanes.live](https://airplanes.live), [adsb.lol](https://adsb.lol), [CelesTrak](https://celestrak.org), [USGS](https://earthquake.usgs.gov), [Radio Browser](https://www.radio-browser.info), [Launch Library 2](https://thespacedevs.com). Please be considerate with polling if you fork this.

MIT licensed.

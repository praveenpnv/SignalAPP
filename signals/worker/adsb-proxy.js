/**
 * SIGNALS — ADS-B CORS proxy (Cloudflare Worker).
 *
 * Why this exists: none of the public ADS-B networks send an
 * `Access-Control-Allow-Origin` header, so a browser refuses to hand
 * their responses to a page served from another origin. The data is
 * public and the request succeeds — the browser just won't let the page
 * read it. This forwards the request and adds the missing header.
 *
 * It is NOT an open proxy: only the three ADS-B hosts are allowed, only
 * GET, and responses are cached for 10 s at the edge so a busy page does
 * not hammer networks that ask for one request per second.
 *
 * Deploy (about five minutes, free tier):
 *   npm create cloudflare@latest signals-adsb -- --type=hello-world
 *   # replace src/index.js with this file
 *   npx wrangler deploy
 * Then put the resulting https://<name>.<you>.workers.dev URL into
 * ADSB_PROXY in js/config.js and rebuild.
 */

const ALLOWED = [
  /^https:\/\/opendata\.adsb\.fi\/api\//,
  /^https:\/\/api\.airplanes\.live\/v2\//,
  /^https:\/\/api\.adsb\.lol\/v2\//,
];

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-max-age': '86400',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'GET') {
      return json({ error: 'GET only' }, 405);
    }

    const target = new URL(request.url).searchParams.get('u');
    if (!target) return json({ error: 'missing ?u=' }, 400);
    if (!ALLOWED.some((re) => re.test(target))) {
      return json({ error: 'host not allowed' }, 403);
    }

    try {
      const upstream = await fetch(target, {
        headers: { 'user-agent': 'signals-globe (github.com/praveenpnv/SignalAPP)' },
        cf: { cacheTtl: 10, cacheEverything: true },
      });
      const body = await upstream.text();
      return new Response(body, {
        status: upstream.status,
        headers: {
          ...CORS,
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'public, max-age=10',
        },
      });
    } catch (err) {
      return json({ error: 'upstream unreachable' }, 502);
    }
  },
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
  });
}

/**
 * Vercel serverless function — same-origin ADS-B proxy.
 *
 * Host the site on Vercel and this lives at /api/adsb on the same origin
 * as the page, so there is no cross-origin request at all and CORS never
 * enters into it. Set ADSB_PROXY = '/api/adsb' in js/config.js.
 *
 * Host-allowlisted and GET-only, so it cannot be used as an open proxy.
 */

const ALLOWED = [
  /^https:\/\/opendata\.adsb\.fi\/api\//,
  /^https:\/\/api\.airplanes\.live\/v2\//,
  /^https:\/\/api\.adsb\.lol\/v2\//,
];

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }

  const target = req.query.u;
  if (!target) return res.status(400).json({ error: 'missing ?u=' });
  if (!ALLOWED.some((re) => re.test(target))) {
    return res.status(403).json({ error: 'host not allowed' });
  }

  try {
    const upstream = await fetch(target, {
      headers: { 'user-agent': 'signals-globe' },
    });
    const body = await upstream.text();
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'public, s-maxage=10, stale-while-revalidate=20');
    res.setHeader('access-control-allow-origin', '*');
    return res.status(upstream.status).send(body);
  } catch {
    return res.status(502).json({ error: 'upstream unreachable' });
  }
}

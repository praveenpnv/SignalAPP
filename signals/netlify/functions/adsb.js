/**
 * Netlify function — same-origin ADS-B proxy.
 *
 * Host the site on Netlify and this lives at /.netlify/functions/adsb on
 * the same origin as the page, so no cross-origin request happens and
 * CORS never enters into it. `netlify.toml` also maps it to the tidier
 * /api/adsb, which is what to put in ADSB_PROXY.
 *
 * Host-allowlisted and GET-only, so it cannot be used as an open proxy.
 */

const ALLOWED = [
  /^https:\/\/opendata\.adsb\.fi\/api\//,
  /^https:\/\/api\.airplanes\.live\/v2\//,
  /^https:\/\/api\.adsb\.lol\/v2\//,
];

const json = (obj, status) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export default async (request) => {
  if (request.method !== 'GET') return json({ error: 'GET only' }, 405);

  const target = new URL(request.url).searchParams.get('u');
  if (!target) return json({ error: 'missing ?u=' }, 400);
  if (!ALLOWED.some((re) => re.test(target))) {
    return json({ error: 'host not allowed' }, 403);
  }

  try {
    const upstream = await fetch(target, {
      headers: { 'user-agent': 'signals-globe' },
    });
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, s-maxage=10',
        'access-control-allow-origin': '*',
      },
    });
  } catch {
    return json({ error: 'upstream unreachable' }, 502);
  }
};

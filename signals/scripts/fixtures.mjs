/** Realistic stand-in payloads so the render path can be tested offline. */

const ISS = [
  '1 25544U 98067A   26253.72411234  .00004958  00000+0  97859-4 0  9999',
  '2 25544  51.6302 236.7477 0004997 126.7110 233.4338 15.49071701585012',
];

export function tleFixture(n = 6, prefix = 'TESTSAT') {
  let out = 'ISS (ZARYA)\n' + ISS[0] + '\n' + ISS[1] + '\n';
  for (let i = 1; i < n; i++) {
    const norad = String(40000 + i).padStart(5, '0');
    const incl = (40 + i * 6).toFixed(4).padStart(8);
    const raan = (10 + i * 25).toFixed(4).padStart(8);
    out +=
      `${prefix}-${i}\n` +
      `1 ${norad}U 98067A   26253.72411234  .00004958  00000+0  97859-4 0  999${i % 10}\n` +
      `2 ${norad} ${incl} ${raan} 0004997 126.7110 233.4338 15.4907170158501${i % 10}\n`;
  }
  return out;
}

export function adsbFixture(lat = 12.97, lon = 77.59, n = 45) {
  const ac = [];
  for (let i = 0; i < n; i++) {
    const ground = i % 12 === 0;
    ac.push({
      hex: (i % 7 === 0 ? 0xae1000 + i : 0x800000 + i).toString(16),
      flight: `TEST${100 + i} `,
      r: `VT-AB${i}`,
      t: ['A320', 'B738', 'B77W', 'AT76', 'C172'][i % 5],
      desc: 'Test Airframe',
      lat: lat + (Math.random() - 0.5) * 4,
      lon: lon + (Math.random() - 0.5) * 4,
      alt_baro: ground ? 'ground' : 3000 + i * 850,
      gs: ground ? 12 : 260 + i * 4,
      track: (i * 37) % 360,
      baro_rate: (i % 3 - 1) * 1200,
      squawk: String(1000 + i),
      category: 'A3',
    });
  }
  return { ac, total: ac.length, now: Date.now() };
}

export function quakeFixture() {
  const mk = (id, lat, lng, depth, mag, place, ageH) => ({
    id,
    type: 'Feature',
    properties: { mag, place, time: Date.now() - ageH * 3600e3, url: 'https://example.org/' + id, felt: 12, tsunami: mag > 6.5 ? 1 : 0 },
    geometry: { type: 'Point', coordinates: [lng, lat, depth] },
  });
  return {
    type: 'FeatureCollection',
    metadata: { count: 5 },
    features: [
      mk('eq1', 38.2, 142.1, 28, 6.8, '120 km E of Sendai, Japan', 1),
      mk('eq2', -20.4, -70.9, 55, 5.4, 'Antofagasta, Chile', 3),
      mk('eq3', 36.1, -117.9, 8, 3.2, 'Ridgecrest, CA', 5),
      mk('eq4', 28.3, 84.7, 210, 4.9, 'Gorkha, Nepal', 9),
      mk('eq5', -6.1, 130.4, 420, 5.9, 'Banda Sea', 14),
    ],
  };
}

export function radioFixture() {
  const mk = (uuid, name, country, lat, lng) => ({
    stationuuid: uuid,
    name,
    country,
    tags: 'news,talk',
    bitrate: 128,
    codec: 'MP3',
    votes: 400,
    url_resolved: 'https://stream.example.org/' + uuid,
    homepage: 'https://example.org',
    geo_lat: lat,
    geo_long: lng,
  });
  return [
    mk('r1', 'Radio Indiranagar', 'India', 12.97, 77.62),
    mk('r2', 'Thames FM', 'United Kingdom', 51.5, -0.12),
    mk('r3', 'Shibuya Wave', 'Japan', 35.66, 139.7),
    mk('r4', 'Copacabana Som', 'Brazil', -22.97, -43.18),
  ];
}

export function launchFixture() {
  return {
    results: [
      { name: 'Falcon 9 | Starlink G-12', net: new Date(Date.now() + 86400e3).toISOString() },
      { name: 'PSLV-C61 | EOS-09', net: new Date(Date.now() + 3 * 86400e3).toISOString() },
      { name: 'Ariane 6 | Galileo L14', net: new Date(Date.now() + 6 * 86400e3).toISOString() },
    ],
  };
}

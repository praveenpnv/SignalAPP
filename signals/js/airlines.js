/**
 * IATA → ICAO airline codes.
 *
 * The number on your boarding pass is IATA ("AI 503"). What an aircraft
 * actually transmits over ADS-B is the ICAO callsign ("AIC503"), so a
 * search for a flight number has to be translated before it will match
 * anything. This table covers the carriers people are most likely to
 * type; anything missing simply falls through and is tried verbatim.
 */
export const IATA_TO_ICAO = {
  // India and neighbours
  AI: 'AIC', IX: 'AXB', '6E': 'IGO', SG: 'SEJ', UK: 'VTI', QP: 'AKJ',
  '9I': 'LLR', PK: 'PIA', UL: 'ALK', BG: 'BBC', RA: 'RNA', BS: 'UBG',
  // North America
  AA: 'AAL', DL: 'DAL', UA: 'UAL', WN: 'SWA', B6: 'JBU', AS: 'ASA',
  NK: 'NKS', F9: 'FFT', HA: 'HAL', AC: 'ACA', WS: 'WJA', G4: 'AAY',
  // Europe
  BA: 'BAW', VS: 'VIR', LH: 'DLH', AF: 'AFR', KL: 'KLM', IB: 'IBE',
  AZ: 'ITY', LX: 'SWR', OS: 'AUA', SN: 'BEL', SK: 'SAS', AY: 'FIN',
  TP: 'TAP', EI: 'EIN', FR: 'RYR', U2: 'EZY', W6: 'WZZ', VY: 'VLG',
  DY: 'NAX', LO: 'LOT', OK: 'CSA', A3: 'AEE', TK: 'THY',
  // Middle East and Africa
  EK: 'UAE', EY: 'ETD', QR: 'QTR', SV: 'SVA', GF: 'GFA', WY: 'OMA',
  KU: 'KAC', RJ: 'RJA', MS: 'MSR', LY: 'ELY', FZ: 'FDB', ET: 'ETH',
  KQ: 'KQA', SA: 'SAA', MK: 'MAU', AT: 'RAM',
  // Asia-Pacific
  SQ: 'SIA', MH: 'MAS', TG: 'THA', VN: 'HVN', GA: 'GIA', PR: 'PAL',
  CX: 'CPA', CI: 'CAL', BR: 'EVA', JL: 'JAL', NH: 'ANA', KE: 'KAL',
  OZ: 'AAR', CA: 'CCA', MU: 'CES', CZ: 'CSN', HU: 'CHH', '3U': 'CSC',
  '9C': 'CQH', QF: 'QFA', VA: 'VOZ', NZ: 'ANZ', JQ: 'JST', TR: 'TGW',
  AK: 'AXM', FD: 'AIQ', VJ: 'VJC',
  // Latin America
  LA: 'LAN', AV: 'AVA', CM: 'CMP', AM: 'AMX', AD: 'AZU', G3: 'GLO',
  AR: 'ARG', CC: 'CMP',
  // Cargo
  FX: 'FDX', '5X': 'UPS', CV: 'CLX', '5Y': 'GTI', QY: 'BCS', PO: 'PAC',
};

/**
 * Turn whatever the user typed into the set of identifiers worth asking
 * the networks about. Ambiguous input produces several candidates and we
 * query them all rather than guessing — "ABC123" is a plausible callsign
 * and a plausible Mode-S hex at the same time.
 */
export function parseQuery(input) {
  const q = String(input || '').toUpperCase().replace(/\s+/g, '');
  if (!q) return { query: '', candidates: [] };

  const candidates = [];
  const push = (kind, value) => {
    if (value && !candidates.some((c) => c.kind === kind && c.value === value)) {
      candidates.push({ kind, value });
    }
  };

  // Registration: contains a hyphen, or the US N-number shape.
  if (/^[A-Z0-9]{1,2}-[A-Z0-9]{1,5}$/.test(q) || /^N\d{1,5}[A-Z]{0,2}$/.test(q)) {
    push('reg', q);
    push('reg', q.replace('-', ''));
  }

  // Mode-S hex: exactly six hex digits.
  if (/^[0-9A-F]{6}$/.test(q)) push('hex', q.toLowerCase());

  // ICAO callsign: three letters then a flight number.
  if (/^[A-Z]{3}\d{1,4}[A-Z]?$/.test(q)) push('callsign', q);

  // IATA flight number: two characters (one may be a digit) then digits.
  const iata = q.match(/^([A-Z0-9]{2})(\d{1,4}[A-Z]?)$/);
  if (iata) {
    const icao = IATA_TO_ICAO[iata[1]];
    if (icao) push('callsign', icao + iata[2]);
    // Some operators file the IATA form, and the leading zero varies.
    push('callsign', q);
    if (icao) push('callsign', icao + iata[2].replace(/^0+/, ''));
  }

  // Anything else: try it as a callsign and as a registration.
  if (!candidates.length) {
    push('callsign', q);
    push('reg', q);
  }

  return { query: q, candidates };
}

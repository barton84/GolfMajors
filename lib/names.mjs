// Name normalization so "Ludvig Åberg", "Ludvig Aberg" and "Jackson Koivun (a)" all match.
export function nameKey(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ø/gi, 'o')
    .replace(/æ/gi, 'ae')
    .replace(/ß/g, 'ss')
    .replace(/\((a|am|amateur)\)/gi, '')
    .replace(/\b(jr|sr|ii|iii|iv)\b\.?/gi, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

export function parseToPar(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim().toUpperCase();
  if (s === 'E' || s === 'EVEN') return 0;
  if (/^[+-]?\d+$/.test(s)) return parseInt(s, 10);
  return null;
}

export function fmtToPar(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '-';
  if (n === 0) return 'E';
  return n > 0 ? `+${n}` : `${n}`;
}

export function parseEventId(input) {
  const s = String(input || '').trim();
  const m = s.match(/tournamentId\/(\d+)/i) || s.match(/[?&/]event[=/](\d+)/i) || s.match(/^(\d{6,})$/);
  return m ? m[1] : null;
}

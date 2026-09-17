import { nameKey, parseToPar } from './names.mjs';

// ESPN's golf feeds are public but undocumented. We try the leaderboard feed first
// (richer status data), then the scoreboard feed. The parser is defensive so small
// format changes degrade gracefully instead of breaking the app.
export const ESPN_URLS = (eventId) => [
  `https://site.web.api.espn.com/apis/site/v2/sports/golf/leaderboard?league=pga&event=${eventId}`,
  `https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard?event=${eventId}`,
];

export async function fetchEspn(eventId, fetchImpl = fetch) {
  if (process.env.MOCK_ESPN_FILE) {
    const fs = await import('node:fs/promises');
    return { url: 'mock', json: JSON.parse(await fs.readFile(process.env.MOCK_ESPN_FILE, 'utf8')) };
  }
  let lastErr;
  for (const url of ESPN_URLS(eventId)) {
    try {
      const res = await fetchImpl(url, { headers: { 'user-agent': 'Mozilla/5.0 golf-draft' } });
      if (!res.ok) throw new Error(`ESPN ${res.status} for ${url}`);
      const json = await res.json();
      const parsed = parseEspn(json, eventId);
      if (parsed.golfers.length) return { url, json };
      lastErr = new Error(`No golfers in ${url}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('ESPN fetch failed');
}

function pickEvent(json, eventId) {
  const events = json?.events || (json?.competitions ? [json] : []);
  if (!events.length) return null;
  return events.find((e) => String(e.id) === String(eventId)) || events[0];
}

function statusOf(c, scoreDisplay) {
  const st = c.status || {};
  const text = [st.type?.name, st.type?.description, st.type?.shortDetail, st.displayValue, scoreDisplay]
    .filter(Boolean)
    .join(' ')
    .toUpperCase();
  if (/\bWD\b|WITHDRAW/.test(text)) return 'wd';
  if (/\bDQ\b|DISQUAL/.test(text)) return 'dq';
  if (/\bCUT\b|\bMDF\b/.test(text)) return 'cut';
  return 'active';
}

export function parseEspn(json, eventId) {
  const ev = pickEvent(json, eventId);
  if (!ev) return { event: { state: 'unknown' }, golfers: [] };
  const comp = ev.competitions?.[0] || {};
  const competitors = comp.competitors || ev.competitors || [];
  const state = ev.status?.type?.state || comp.status?.type?.state || 'unknown';
  const eventRound = Number(comp.status?.period || ev.status?.period || 0) || 0;

  const golfers = competitors.map((c, idx) => {
    const a = c.athlete || {};
    const name = a.displayName || a.fullName || c.displayName || c.name || 'Unknown';
    const st = c.status || {};
    const scoreDisplay = typeof c.score === 'object' && c.score !== null ? c.score.displayValue ?? c.score.value : c.score;
    const status = statusOf(c, scoreDisplay);
    const period = Number(st.period || 0) || 0;
    const lines = (c.linescores || []).filter((l) => Number(l.period) >= 1 && Number(l.period) <= 4);
    const rounds = [null, null, null, null];
    const roundToPar = [null, null, null, null];
    let started = false;
    let holesCurrent = 0;
    for (const l of lines) {
      const p = Number(l.period);
      const holes = Array.isArray(l.linescores) ? l.linescores.filter((h) => h.value !== undefined && h.value !== null).length : null;
      const v = Number(l.value);
      if ((holes && holes > 0) || v > 0) started = true;
      const roundDone = holes !== null && holes > 0 ? holes >= 18 : v >= 55 && (p < period || /\bF\b|FINISH|CUT|WD|DQ/i.test(`${st.displayValue} ${st.type?.name}`) || state === 'post' || p < eventRound);
      if (roundDone && v > 0) rounds[p - 1] = v;
      roundToPar[p - 1] = l.displayValue ?? null;
      if (p === period && holes !== null) holesCurrent = holes;
    }
    const thruRaw = st.thru ?? (holesCurrent || null);
    if (Number(thruRaw) > 0) started = true;
    // ESPN's top-level "score" can lag during live play (it showed E for golfers at -1).
    // The scoreToPar statistic is the reliable total; fall back to summing each round's to-par, then score.
    const statToPar = (c.statistics || []).find((x) => x.name === 'scoreToPar');
    const roundSum = roundToPar.some((x) => parseToPar(x) !== null) ? roundToPar.reduce((a, x) => a + (parseToPar(x) ?? 0), 0) : null;
    const toPar = status !== 'active' ? null : parseToPar(statToPar?.displayValue) ?? roundSum ?? parseToPar(scoreDisplay);
    if (toPar !== null && toPar !== 0) started = true;
    const teeTime = st.teeTime || c.teeTime || null;
    let thru = '';
    const dv = String(st.displayValue || '');
    if (/^F\*?$/i.test(dv) || st.type?.name === 'STATUS_FINISH') thru = 'F';
    else if (Number(thruRaw) > 0) thru = String(Number(thruRaw) >= 18 ? 'F' : thruRaw);
    else if (Number(thruRaw) === 0 || /[AP]M/i.test(dv)) thru = '';
    const currentIdx = period ? period - 1 : rounds.findIndex((r) => r === null);
    const today = status === 'active' && currentIdx >= 0 ? roundToPar[currentIdx] : null;
    return {
      espnId: String(a.id ?? c.id ?? ''),
      name,
      key: nameKey(name),
      pos: st.position?.displayName || c.position?.displayName || (status === 'active' ? '' : '-'),
      status,
      scoreDisplay: status === 'active' ? (toPar === null ? '' : toPar === 0 ? 'E' : toPar > 0 ? `+${toPar}` : String(toPar)) : status.toUpperCase(),
      toPar,
      today: today ?? '',
      thru,
      period,
      teeTime,
      rounds,
      roundToPar,
      started,
      sortOrder: Number(c.sortOrder ?? c.order ?? idx + 1),
    };
  });

  // Par: course data if present, otherwise derive from a golfer with 4 complete rounds.
  let par = Number(ev.courses?.[0]?.shotsToPar || ev.courses?.[0]?.par || comp.course?.par || 0) || null;
  if (!par) {
    // Each completed round carries its own to-par value, so strokes minus to-par gives par.
    const votes = {};
    for (const g of golfers) g.rounds.forEach((r, i) => {
      const tp = parseToPar(g.roundToPar[i]);
      if (r && tp !== null) votes[r - tp] = (votes[r - tp] || 0) + 1;
    });
    const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= 3) par = Number(best[0]);
  }
  if (!par) {
    const g = golfers.find((x) => x.status === 'active' && x.rounds.every((r) => r) && x.toPar !== null);
    if (g) par = Math.round((g.rounds.reduce((s, r) => s + r, 0) - g.toPar) / 4);
  }

  return {
    event: {
      id: String(ev.id ?? eventId ?? ''), name: ev.name || ev.shortName || '', state, round: eventRound, par,
      holePars: Array.isArray(ev.courses?.[0]?.holes) ? ev.courses[0].holes.slice(0, 18).map((h) => Number(h.shotsToPar || h.par) || null) : null,
    },
    golfers,
  };
}

// Hole-by-hole scores, kept separate from the main feed because it is much larger.
// Shape: { pars: [[18 pars] per round or shared], players: { espnId: [round1..4] } }
// where each round is an array of 18 entries: [strokes, relativeToPar] or null for unplayed holes.
const REL_BY_NAME = { ALBATROSS: -3, DOUBLE_EAGLE: -3, EAGLE: -2, BIRDIE: -1, PAR: 0, BOGEY: 1, DOUBLE_BOGEY: 2, TRIPLE_BOGEY: 3 };
export function parseHoles(json, eventId) {
  const ev = pickEvent(json, eventId);
  if (!ev) return null;
  const comp = ev.competitions?.[0] || {};
  const competitors = comp.competitors || ev.competitors || [];
  const votes = Array.from({ length: 18 }, () => ({}));
  const players = {};
  let any = false;
  for (const c of competitors) {
    const id = String(c.athlete?.id ?? c.id ?? '');
    if (!id) continue;
    const rounds = [null, null, null, null];
    for (const l of c.linescores || []) {
      const p = Number(l.period);
      if (!(p >= 1 && p <= 4) || !Array.isArray(l.linescores) || !l.linescores.length) continue;
      const card = Array(18).fill(null);
      l.linescores.forEach((h, idx) => {
        const hole = Number(h.period) >= 1 && Number(h.period) <= 18 ? Number(h.period) : idx + 1;
        const strokes = Number(h.value);
        if (!(strokes > 0) || hole > 18) return;
        let rel = parseToPar(h.scoreType?.displayValue);
        if (rel === null && h.scoreType?.name) rel = REL_BY_NAME[String(h.scoreType.name).toUpperCase()] ?? null;
        if (rel === null && Number(h.par) > 0) rel = strokes - Number(h.par);
        card[hole - 1] = [strokes, rel];
        if (rel !== null) { const par = strokes - rel; votes[hole - 1][par] = (votes[hole - 1][par] || 0) + 1; }
        any = true;
      });
      rounds[p - 1] = card;
    }
    players[id] = rounds;
  }
  if (!any) return null;
  // Course pars: from course data when present, otherwise the most common strokes-minus-relative per hole.
  const courseHoles = ev.courses?.[0]?.holes || comp.course?.holes;
  let pars = votes.map((v) => { const best = Object.entries(v).sort((a, b) => b[1] - a[1])[0]; return best ? Number(best[0]) : null; });
  if (Array.isArray(courseHoles) && courseHoles.length >= 18) {
    pars = courseHoles.slice(0, 18).map((h, i) => Number(h.shotsToPar || h.par) || pars[i]);
  }
  // Fill any missing relative values now that pars are known
  for (const rounds of Object.values(players)) for (const card of rounds) if (card) card.forEach((h, i) => { if (h && h[1] === null && pars[i]) h[1] = h[0] - pars[i]; });
  return { pars, players };
}

// Per-player scorecard. The leaderboard feed only has round totals, so hole-by-hole scores come
// from ESPN's player summary (primary) or the core API linescores (backup). Both return rounds
// whose linescores are holes: { period: holeNumber, value: strokes, par, scoreType: { displayValue } }.
export const PLAYER_CARD_URLS = (eventId, playerId, season) => [
  `https://site.web.api.espn.com/apis/site/v2/sports/golf/pga/leaderboard/${eventId}/playersummary?region=us&lang=en${season ? `&season=${season}` : ''}&player=${playerId}`,
  `https://sports.core.api.espn.com/v2/sports/golf/leagues/pga/events/${eventId}/competitions/${eventId}/competitors/${playerId}/linescores`,
];

export function parsePlayerCard(json, fallbackPars = null) {
  const list = Array.isArray(json?.rounds) ? json.rounds : Array.isArray(json?.items) ? json.items : null;
  if (!list) return null;
  const rounds = [null, null, null, null];
  const pars = Array(18).fill(null);
  let any = false;
  for (const r of list) {
    const p = Number(r.period);
    if (!(p >= 1 && p <= 4) || !Array.isArray(r.linescores) || !r.linescores.length) continue;
    const card = Array(18).fill(null);
    for (const h of r.linescores) {
      const hole = Number(h.period);
      const strokes = Number(h.value);
      if (!(hole >= 1 && hole <= 18) || !(strokes > 0)) continue;
      const par = Number(h.par) || fallbackPars?.[hole - 1] || null;
      if (par) pars[hole - 1] = par;
      let rel = parseToPar(h.scoreType?.displayValue);
      if (rel === null && par) rel = strokes - par;
      card[hole - 1] = [strokes, rel];
      any = true;
    }
    rounds[p - 1] = card;
  }
  if (!any) return { rounds, pars: fallbackPars || pars, empty: true };
  return { rounds, pars: pars.map((x, i) => x || fallbackPars?.[i] || null) };
}

export async function fetchPlayerCard(eventId, playerId, season, fetchImpl = fetch) {
  let lastErr;
  for (const url of PLAYER_CARD_URLS(eventId, playerId, season)) {
    try {
      const res = await fetchImpl(url, { headers: { 'user-agent': 'Mozilla/5.0 golf-draft' } });
      if (!res.ok) throw new Error(`ESPN ${res.status}`);
      const json = await res.json();
      if (Array.isArray(json?.rounds) || Array.isArray(json?.items)) return json;
      lastErr = new Error('No scorecard in response');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Scorecard fetch failed');
}

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
    const toPar = status === 'active' ? parseToPar(scoreDisplay) : null;
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
      scoreDisplay: status === 'active' ? scoreDisplay ?? '' : status.toUpperCase(),
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
    event: { id: String(ev.id ?? eventId ?? ''), name: ev.name || ev.shortName || '', state, round: eventRound, par },
    golfers,
  };
}

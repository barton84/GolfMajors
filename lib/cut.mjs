// Projected cut line.
//
// For every golfer we know his score to par and how many of the 36 holes he has played.
// The rest of his holes are simulated: each remaining hole is played at the field's scoring
// rate for this event, with the usual round-to-round randomness. Running that a few thousand
// times gives a distribution of cut lines and each golfer's chance of making the cut.
//
// Golfers are treated as equally skilled from here on, so this is an estimate, not a forecast
// from a player-rating model.

export const SD_PER_HOLE = 0.62; // typical spread of a golfer's score on one hole, in strokes

// Deterministic random so the same scores always give the same projection.
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
export const normal = (rand) => {
  const u = Math.max(rand(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
};

export function holesPlayed(g, eventRound) {
  if (!g.started) return 0;
  const done = [0, 1].filter((i) => g.rounds?.[i]).length; // completed rounds 1 and 2
  const thru = g.thru === 'F' ? 18 : Number(g.thru) || 0;
  const inProgress = done < 2 && (eventRound || 1) <= 2 && g.currentStrokes ? Math.min(thru || 1, 18) : 0;
  return Math.min(36, done * 18 + inProgress);
}

export function projectCut(feed, { top = 65, ties = true, sims = 3000 } = {}) {
  const event = feed?.event || {};
  const round = Number(event.round || 0);
  const golfers = (feed.golfers || []).filter((g) => g.status === 'active' || g.status === 'cut');
  if (!golfers.length || event.state === 'pre') return { available: false, reason: 'The tournament has not started yet.' };

  // Cut already decided: report what actually happened.
  if (round > 2 || golfers.some((g) => g.status === 'cut')) {
    const made = golfers.filter((g) => g.status === 'active');
    const line = made.length ? Math.max(...made.map((g) => g.toPar ?? 0)) : null;
    return { available: true, final: true, line, madeCount: made.length, players: Object.fromEntries(golfers.map((g) => [g.espnId || g.key, g.status === 'active' ? 1 : 0])) };
  }

  const rows = golfers.map((g) => ({ id: g.espnId || g.key, name: g.name, toPar: g.toPar ?? 0, left: 36 - holesPlayed(g, round) }));
  const playedHoles = rows.reduce((s, r) => s + (36 - r.left), 0);
  if (playedHoles < 200) return { available: false, reason: 'Not enough holes played yet. Check back once the morning wave is underway.' };
  const scoreSum = rows.reduce((s, r) => s + r.toPar, 0);
  const perHole = scoreSum / playedHoles; // field scoring rate, relative to par

  const rand = rng(Math.round(scoreSum * 1000 + playedHoles));
  const counts = new Map(); // cut line -> how many sims
  const made = new Array(rows.length).fill(0);
  const finals = new Array(rows.length);
  const idx = new Array(rows.length);
  for (let s = 0; s < sims; s++) {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      finals[i] = r.left ? Math.round(r.toPar + r.left * perHole + normal(rand) * SD_PER_HOLE * Math.sqrt(r.left)) : r.toPar;
      idx[i] = i;
    }
    idx.sort((a, b) => finals[a] - finals[b]);
    const lineScore = finals[idx[Math.min(top, rows.length) - 1]];
    counts.set(lineScore, (counts.get(lineScore) || 0) + 1);
    if (ties) {
      for (let i = 0; i < rows.length; i++) if (finals[i] <= lineScore) made[i]++;
    } else {
      for (let k = 0; k < Math.min(top, rows.length); k++) made[idx[k]]++;
    }
  }

  const lines = [...counts.entries()]
    .map(([score, n]) => ({ score, pct: n / sims }))
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 5);
  const players = {};
  rows.forEach((r, i) => (players[r.id] = made[i] / sims));
  return {
    available: true,
    final: false,
    round,
    rule: { top, ties },
    fieldPerHole: perHole,
    lines,
    projectedLine: lines[0]?.score ?? null,
    players,
    bubble: rows
      .map((r, i) => ({ name: r.name, id: r.id, toPar: r.toPar, left: r.left, pct: made[i] / sims }))
      .filter((r) => r.pct > 0.1 && r.pct < 0.9)
      .sort((a, b) => Math.abs(a.pct - 0.5) - Math.abs(b.pct - 0.5))
      .slice(0, 14)
      .sort((a, b) => b.pct - a.pct),
    sims,
  };
}

// Attach the projection to each manager's golfers.
export function cutByManager(leaderboard, cut) {
  if (!cut?.available) return [];
  const pct = (g) => cut.players[g.espnId || g.key] ?? (g.status === 'cut' ? 0 : g.status === 'active' ? null : 0);
  return leaderboard.teams
    .map((t) => {
      const golfers = t.lineup.map((g) => ({ id: g.espnId || g.key, name: g.name, toPar: g.teamToPar, status: g.status, thru: g.thru, pct: pct(g), sub: !!g.subFor }));
      const known = golfers.filter((g) => g.pct !== null);
      return {
        managerId: t.managerId,
        manager: t.manager,
        expected: known.reduce((s, g) => s + g.pct, 0),
        safe: golfers.filter((g) => g.pct !== null && g.pct >= 0.92).length,
        gone: golfers.filter((g) => g.pct !== null && g.pct <= 0.08).length,
        golfers: golfers.sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0)),
      };
    })
    .sort((a, b) => b.expected - a.expected);
}

// Win chance for each manager.
//
// Plays out the rest of the tournament a few thousand times. Each golfer's remaining holes are
// scored at the field's scoring rate with normal round-to-round randomness (same model as the cut
// projection). Before the cut is made, each run also decides who misses it; those golfers take the
// missed-round penalty for rounds 3 and 4. Each team then counts its best N of its playing golfers,
// exactly like the real scoring, and the lowest total wins that run.
//
// Golfers are treated as equally skilled from here on, so early in the week this is a rough read
// and it sharpens as holes get played.

import { rng, normal, SD_PER_HOLE } from './cut.mjs';

// Holes played across all four rounds.
export function holes72(g) {
  if (!g.started) return 0;
  const done = (g.rounds || []).filter(Boolean).length;
  const thru = g.thru === 'F' ? 18 : Number(g.thru) || 0;
  const current = done < 4 && g.currentStrokes ? Math.min(Math.max(thru, 1), 18) : 0;
  return Math.min(72, done * 18 + current);
}

const OUT = new Set(['cut', 'wd', 'dq']);

export function projectWins(feed, lb, { sims = 3000, paid = 3 } = {}) {
  const event = feed?.event || {};
  if (!feed?.golfers?.length || event.state === 'pre') return { available: false, reason: 'The tournament has not started yet.' };
  const settings = lb.settings || {};
  const counting = settings.counting ?? 6;
  const penalty = settings.penalty ?? 80;
  const { top = 65, ties = true } = settings.cut || {};
  const par = lb.event?.par || event.par || 72;
  const round = Number(event.round || 1);

  const field = feed.golfers.filter((g) => g.status === 'active' || g.status === 'cut');
  const rows = field.map((g) => ({ toPar: g.toPar ?? 0, played: holes72(g), cut: g.status === 'cut' }));
  const playedTotal = rows.reduce((s, r) => s + r.played, 0);
  if (playedTotal < 200) return { available: false, reason: 'Not enough holes played yet.' };
  if (rows.every((r) => r.cut || r.played >= 72)) return { available: false, reason: 'Every round is complete.' };
  const perHole = rows.reduce((s, r) => s + r.toPar, 0) / playedTotal;
  const cutDone = round > 2 || rows.some((r) => r.cut);
  const index = new Map(field.map((g, i) => [g.espnId || g.key, i]));

  // Each team's playing golfers: either a fixed score (already cut, withdrawn, disqualified) or a
  // pointer into the simulated field.
  const teams = lb.teams.map((t) => ({
    id: t.managerId,
    golfers: t.lineup.map((g) => {
      const i = index.get(g.espnId || g.key);
      if (OUT.has(g.status) || i === undefined) return { fixed: g.teamToPar ?? 0 };
      return { i };
    }),
  }));
  const wins = new Array(teams.length).fill(0);
  const money = new Array(teams.length).fill(0);

  const n = rows.length;
  const f36 = new Float64Array(n);
  const fin = new Float64Array(n);
  const order = new Array(n);
  const rand = rng(Math.round(playedTotal * 7919 + perHole * 1e6));
  const cutSlot = Math.min(top, n) - 1;

  for (let s = 0; s < sims; s++) {
    let line = Infinity;
    if (!cutDone) {
      for (let i = 0; i < n; i++) {
        const left = Math.max(0, 36 - rows[i].played);
        f36[i] = left ? Math.round(rows[i].toPar + left * perHole + normal(rand) * SD_PER_HOLE * Math.sqrt(left)) : rows[i].toPar;
        order[i] = i;
      }
      order.sort((a, b) => f36[a] - f36[b]);
      line = f36[order[cutSlot]];
    }
    const madeTop = !cutDone && !ties ? new Set(order.slice(0, cutSlot + 1)) : null;
    for (let i = 0; i < n; i++) {
      const r = rows[i];
      if (cutDone) {
        const left = 72 - r.played;
        fin[i] = r.cut ? 0 : left ? Math.round(r.toPar + left * perHole + normal(rand) * SD_PER_HOLE * Math.sqrt(left)) : r.toPar;
        continue;
      }
      const made = madeTop ? madeTop.has(i) : f36[i] <= line;
      if (made) {
        const left = 72 - Math.max(r.played, 36);
        fin[i] = Math.round(f36[i] + left * perHole + normal(rand) * SD_PER_HOLE * Math.sqrt(left));
      } else {
        // Two real rounds, then the penalty for rounds 3 and 4.
        fin[i] = f36[i] + 2 * penalty - 2 * par;
      }
    }
    const totals = teams.map((t, k) => {
      const scores = t.golfers.map((g) => (g.fixed !== undefined ? g.fixed : fin[g.i])).sort((a, b) => a - b);
      let v = 0;
      for (let j = 0; j < Math.min(counting, scores.length); j++) v += scores[j];
      return { k, v, tie: rand() };
    });
    totals.sort((a, b) => a.v - b.v || a.tie - b.tie);
    // A tie for first splits the win (the real tiebreaker can't be simulated fairly).
    const leaders = totals.filter((x) => x.v === totals[0].v);
    for (const x of leaders) wins[x.k] += 1 / leaders.length;
    for (let j = 0; j < Math.min(paid, totals.length); j++) money[totals[j].k]++;
  }

  return {
    available: true,
    sims,
    paid,
    teams: Object.fromEntries(teams.map((t, k) => [t.id, { win: wins[k] / sims, money: money[k] / sims }])),
  };
}

import { nameKey, fmtToPar } from './names.mjs';

export const DEFAULT_SETTINGS = { rounds: 10, starters: 8, counting: 6, penalty: 80, par: null };

// Snake order: returns manager index (into draft.order) for 0-based pick number.
export function managerForPick(pickIndex, numManagers) {
  const round = Math.floor(pickIndex / numManagers);
  const pos = pickIndex % numManagers;
  return round % 2 === 0 ? pos : numManagers - 1 - pos;
}

export function pickInfo(pickIndex, numManagers) {
  return { round: Math.floor(pickIndex / numManagers) + 1, slot: managerForPick(pickIndex, numManagers) };
}

// Resolve a drafted golfer against the live feed + admin overrides.
export function resolveGolfer(pick, feedByKey, feedById, overrides, eventState) {
  const live = (pick.espnId && feedById.get(pick.espnId)) || feedByKey.get(nameKey(pick.name));
  const base = live
    ? { ...live, rounds: [...live.rounds] }
    : {
        name: pick.name,
        key: nameKey(pick.name),
        pos: '',
        status: 'active',
        scoreDisplay: '',
        toPar: null,
        today: '',
        thru: '',
        teeTime: pick.teeTime || null,
        rounds: [null, null, null, null],
        started: false,
        missing: true,
      };
  // A golfer drafted from the field who disappears once the event starts withdrew before teeing off.
  if (!live && (eventState === 'in' || eventState === 'post') && pick.espnId) {
    base.status = 'wd';
    base.scoreDisplay = 'WD';
    base.pos = '-';
  }
  const o = overrides?.[nameKey(pick.name)];
  if (o) {
    if (o.status) {
      base.status = o.status;
      base.scoreDisplay = o.status === 'active' ? base.scoreDisplay : o.status.toUpperCase();
    }
    if (Array.isArray(o.rounds)) o.rounds.forEach((r, i) => { if (r !== null && r !== '' && r !== undefined) base.rounds[i] = Number(r); });
    if (typeof o.started === 'boolean') base.started = o.started;
    if (o.toPar !== undefined && o.toPar !== null && o.toPar !== '') base.toPar = Number(o.toPar);
    base.overridden = true;
  }
  base.name = pick.name;
  base.pickKey = pick.key;
  return base;
}

// Score one golfer. toPar is the comparable number used for ranking at any point in the event.
export function scoreGolfer(g, par, settings) {
  const penalty = settings.penalty ?? 80;
  const out = { ...g };
  if (g.status === 'cut' || g.status === 'wd' || g.status === 'dq') {
    out.scoredRounds = g.rounds.map((r) => (r && r >= 55 ? r : penalty));
    out.penaltyRounds = g.rounds.map((r) => !(r && r >= 55));
    out.strokes = out.scoredRounds.reduce((s, r) => s + r, 0);
    out.teamToPar = par ? out.strokes - par * 4 : null;
    out.final = true;
  } else {
    out.scoredRounds = [...g.rounds];
    out.penaltyRounds = [false, false, false, false];
    out.strokes = g.rounds.reduce((s, r) => s + (r || 0), 0);
    out.teamToPar = g.toPar ?? 0;
    out.final = g.rounds.every((r) => r);
  }
  return out;
}

export const isWdBeforeStart = (g) => (g.status === 'wd' || g.status === 'dq') && !g.started;

function sumTop(list, n) {
  return list.slice(0, n).reduce((s, g) => s + (g.teamToPar ?? 0), 0);
}

export function computeLeaderboard(draft, feed) {
  const settings = { ...DEFAULT_SETTINGS, ...(draft.settings || {}) };
  const eventState = feed?.event?.state || 'pre';
  const par = Number(settings.par) || feed?.event?.par || 72;
  const golfers = feed?.golfers || [];
  const byKey = new Map(golfers.map((g) => [g.key, g]));
  const byId = new Map(golfers.filter((g) => g.espnId).map((g) => [g.espnId, g]));
  const managers = draft.managers || [];

  const teams = managers.map((m) => {
    const picks = (draft.picks || []).filter((p) => p.managerId === m.id).sort((a, b) => a.round - b.round);
    const scored = picks.map((p) => ({
      pick: p,
      g: scoreGolfer(resolveGolfer(p, byKey, byId, draft.overrides, eventState), par, settings),
    }));
    const starters = scored.filter((x) => x.pick.round <= settings.starters);
    const bench = scored.filter((x) => x.pick.round > settings.starters);
    const usedBench = new Set();
    const lineup = starters.map((s) => {
      if (!isWdBeforeStart(s.g)) return { ...s.g, round: s.pick.round };
      const sub = bench.find((b) => !usedBench.has(b.pick.round) && !isWdBeforeStart(b.g));
      if (!sub) return { ...s.g, round: s.pick.round };
      usedBench.add(sub.pick.round);
      return { ...sub.g, round: sub.pick.round, subFor: s.g.name, subForRound: s.pick.round };
    });
    const replaced = starters.filter((s) => isWdBeforeStart(s.g) && lineup.some((l) => l.subForRound === s.pick.round)).map((s) => ({ ...s.g, round: s.pick.round }));
    const ranked = [...lineup].sort((a, b) => (a.teamToPar ?? 0) - (b.teamToPar ?? 0) || a.strokes - b.strokes);
    ranked.forEach((g, i) => (g.counting = i < settings.counting));
    const counting = ranked.filter((g) => g.counting);
    const toPar = counting.reduce((s, g) => s + (g.teamToPar ?? 0), 0);
    const complete = counting.length === settings.counting && counting.every((g) => g.final);
    return {
      managerId: m.id,
      manager: m.name,
      draftPos: (draft.order || []).indexOf(m.id) + 1,
      toPar,
      toParDisplay: fmtToPar(toPar),
      strokes: counting.reduce((s, g) => s + g.strokes, 0),
      strokesComplete: complete,
      tiebreak: [2, 4, 6, 8].map((n) => sumTop(ranked, n)),
      lineup: ranked,
      replaced,
      bench: bench.map((b) => ({ ...b.g, round: b.pick.round, usedAsSub: usedBench.has(b.pick.round) })),
      count: lineup.length,
    };
  });

  teams.sort((a, b) => a.toPar - b.toPar || cmpVec(a.tiebreak, b.tiebreak) || a.manager.localeCompare(b.manager));
  teams.forEach((t, i) => {
    const prev = teams[i - 1];
    t.rank = prev && prev.toPar === t.toPar && cmpVec(prev.tiebreak, t.tiebreak) === 0 ? prev.rank : i + 1;
    t.tiedOnScore = teams.some((o) => o !== t && o.toPar === t.toPar);
  });

  // Side bet: each manager's best single backup golfer; ties broken by their other backup.
  const sideBet = teams
    .map((t) => {
      const golfers = [...t.bench].sort((a, b) => (a.teamToPar ?? 0) - (b.teamToPar ?? 0));
      return { manager: t.manager, managerId: t.managerId, golfers, vec: golfers.map((g) => g.teamToPar ?? 0) };
    })
    .filter((s) => s.golfers.length)
    .sort((a, b) => cmpVec(a.vec, b.vec) || a.manager.localeCompare(b.manager));
  sideBet.forEach((s, i) => {
    const prev = sideBet[i - 1];
    s.rank = prev && cmpVec(prev.vec, s.vec) === 0 ? prev.rank : i + 1;
  });

  return {
    event: { ...(feed?.event || {}), par },
    settings,
    teams,
    sideBet,
    sideBetTie: sideBet.filter((s) => s.rank === 1).length > 1,
    updatedAt: new Date().toISOString(),
  };
}

function cmpVec(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

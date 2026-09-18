import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseEspn } from '../lib/espn.mjs';
import { computeLeaderboard, managerForPick } from '../lib/scoring.mjs';
import { nameKey, parseEventId } from '../lib/names.mjs';

execFileSync('node', [new URL('./make-mock.mjs', import.meta.url).pathname, 'post']);
const fx = JSON.parse(fs.readFileSync(new URL('./usopen2026.json', import.meta.url)));
const feed = parseEspn(JSON.parse(fs.readFileSync(new URL('./mock-espn-post.json', import.meta.url))), '401811952');

function usOpenDraft() {
  const managers = fx.managers.map((name, i) => ({ id: `m${i}`, name }));
  const picks = [];
  fx.grid.forEach((row, r) => row.forEach((name, c) => picks.push({ managerId: `m${c}`, round: r + 1, name })));
  return { managers, order: managers.map((m) => m.id), picks, settings: {} };
}

test('snake order', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((i) => managerForPick(i, 3)), [0, 1, 2, 2, 1, 0]);
});

test('names normalize', () => {
  assert.equal(nameKey('Jackson Koivun (a)'), nameKey('Jackson Koivun'));
  assert.equal(nameKey('Ludvig Åberg'), nameKey('Ludvig Aberg'));
  assert.equal(nameKey('Nicolai Højgaard'), nameKey('Nicolai Hojgaard'));
  assert.equal(parseEventId('https://www.espn.com/golf/leaderboard/_/tournamentId/401811952'), '401811952');
});

test('parser derives par 70 and statuses', () => {
  assert.equal(feed.event.par, 70);
  const hov = feed.golfers.find((g) => g.name === 'Viktor Hovland');
  assert.equal(hov.status, 'cut');
  assert.deepEqual(hov.rounds, [76, 69, null, null]);
  const day = feed.golfers.find((g) => g.name === 'Jason Day');
  assert.equal(day.status, 'wd');
  assert.equal(day.started, true);
});

test('U.S. Open 2026 final standings match the sheet (shots)', () => {
  const lb = computeLeaderboard(usOpenDraft(), feed);
  const got = Object.fromEntries(lb.teams.map((t) => [t.manager, t.strokes]));
  // The sheet showed Barton 1732, Pete 1750, Erik 1768, Walker 1780. Those were off because the sheet
  // only listed 7 of 8 golfers for some teams and sorted Pete's missed cuts by text instead of strokes.
  assert.deepEqual(got, { Maldy: 1699, Zac: 1703, Chase: 1713, Barton: 1731, Cody: 1747, Pete: 1747, Erik: 1766, Walker: 1775 });
  assert.equal(lb.teams[0].manager, 'Maldy');
  const cody = lb.teams.find((t) => t.manager === 'Cody');
  assert.equal(cody.toParDisplay, '+67'); // sheet showed +53 because CUT counted as +18
});

test('sub: starter WD before tee shot is replaced by round 9', () => {
  const d = usOpenDraft();
  d.overrides = { [nameKey('Scottie Scheffler')]: { status: 'wd', started: false } };
  const cody = computeLeaderboard(d, feed).teams.find((t) => t.manager === 'Cody');
  const sub = cody.lineup.find((g) => g.subFor === 'Scottie Scheffler');
  // Jason Day (R9) withdrew after starting, so he still subs in per the rules (and takes 320).
  assert.equal(sub.name, 'Jason Day');
  assert.equal(sub.strokes, 320);
});

test('sub: skips a bench golfer who also WD before starting', () => {
  const d = usOpenDraft();
  d.overrides = {
    [nameKey('Scottie Scheffler')]: { status: 'wd', started: false },
    [nameKey('Jason Day')]: { status: 'wd', started: false },
  };
  const cody = computeLeaderboard(d, feed).teams.find((t) => t.manager === 'Cody');
  assert.equal(cody.lineup.find((g) => g.subFor).name, 'Andrew Putnam');
});

test('side bet: best single backup, second backup breaks tie (Walker won 2026 U.S. Open)', () => {
  const lb = computeLeaderboard(usOpenDraft(), feed);
  assert.equal(lb.sideBet[0].manager, 'Walker');
  assert.equal(lb.sideBetTie, false);
});

test('hole-by-hole: pars derived, strokes add up to round totals, partial rounds kept', async () => {
  const { parseHoles } = await import('../lib/espn.mjs');
  const raw = JSON.parse(fs.readFileSync(new URL('./mock-espn-post.json', import.meta.url)));
  const h = parseHoles(raw, '401811952');
  assert.equal(h.pars.reduce((a, b) => a + b, 0), 70);
  for (const g of feed.golfers.slice(0, 40)) {
    const cards = h.players[g.espnId];
    g.rounds.forEach((r, i) => { if (r) assert.equal(cards[i].reduce((s, x) => s + x[0], 0), r); });
  }
  const day = feed.golfers.find((g) => g.name === 'Jason Day');
  assert.equal(h.players[day.espnId][0].filter(Boolean).length, 11);
});

test('DQ before the first tee shot takes 80s and does not bring in a sub', () => {
  const d = usOpenDraft();
  d.overrides = { [nameKey('Scottie Scheffler')]: { status: 'dq', started: false } };
  const cody = computeLeaderboard(d, feed).teams.find((t) => t.manager === 'Cody');
  assert.equal(cody.lineup.some((g) => g.subFor), false);
  const s = cody.lineup.find((g) => g.name === 'Scottie Scheffler');
  assert.equal(s.status, 'dq');
  // A DQ keeps completed rounds and takes 80 for any round without a score (none here in the final data)
  assert.equal(s.strokes, 280);
  assert.ok(cody.bench.every((b) => !b.usedAsSub));
});

test('real ESPN live feed (Biltmore R1): totals come from scoreToPar, not the stale score field', () => {
  const raw = JSON.parse(fs.readFileSync(new URL('./espn-live-r1.json', import.meta.url)));
  const live = parseEspn(raw, '401850914');
  assert.equal(live.golfers.length, 132);
  assert.equal(live.event.state, 'in');
  assert.equal(live.event.par, 71);
  const bh = live.golfers.find((g) => g.name === 'Billy Horschel');
  assert.equal(bh.toPar, -1);
  assert.equal(bh.today, '-1');
  assert.equal(bh.thru, '1');
  assert.equal(bh.started, true);
  assert.equal(bh.pos, 'T1');
  // Every golfer's parsed total matches ESPN's scoreToPar statistic
  for (const c of raw.events[0].competitions[0].competitors) {
    const stat = c.statistics.find((x) => x.name === 'scoreToPar');
    const g = live.golfers.find((x) => x.espnId === String(c.athlete.id));
    const expected = stat.displayValue === '-' ? null : stat.displayValue === 'E' ? 0 : Number(stat.displayValue);
    assert.equal(g.toPar, expected, g.name);
  }
  const waiting = live.golfers.find((g) => g.teeTime && !g.started);
  assert.equal(waiting.toPar, null);
  assert.deepEqual(waiting.rounds, [null, null, null, null]);
});

test('real ESPN scorecards: player summary and core linescores parse hole by hole', async () => {
  const { parsePlayerCard } = await import('../lib/espn.mjs');
  const live = parseEspn(JSON.parse(fs.readFileSync(new URL('./espn-live-r1.json', import.meta.url))), '401850914');
  assert.equal(live.event.holePars.reduce((a, b) => a + b, 0), 71);
  const a = parsePlayerCard(JSON.parse(fs.readFileSync(new URL('./espn-playersummary.json', import.meta.url))), live.event.holePars);
  assert.deepEqual(a.rounds[0][9], [3, -1]);
  assert.equal(a.rounds[0].filter(Boolean).length, 1);
  assert.equal(a.rounds[1], null);
  assert.equal(a.pars[1], 3);
  const b = parsePlayerCard(JSON.parse(fs.readFileSync(new URL('./espn-core-linescores.json', import.meta.url))), live.event.holePars);
  assert.deepEqual(b.rounds[0].filter(Boolean), [[3, -1], [4, 1]]);
  assert.equal(b.rounds[0][10][0], 4);
});

test('live strokes: TOT includes the round in progress, ranking still by to-par', () => {
  const raw = JSON.parse(fs.readFileSync(new URL('./espn-live-r1.json', import.meta.url)));
  const live = parseEspn(raw, '401850914');
  const bh = live.golfers.find((g) => g.name === 'Billy Horschel');
  assert.equal(bh.currentStrokes, 3);
  const picks = live.golfers.filter((g) => g.started).slice(0, 8).map((g, i) => ({ managerId: 'a', round: i + 1, name: g.name, espnId: g.espnId, key: g.key }));
  const lb = computeLeaderboard({ managers: [{ id: 'a', name: 'A' }], order: ['a'], picks, settings: {} }, live);
  const t = lb.teams[0];
  const counting = t.lineup.filter((g) => g.counting);
  assert.equal(t.strokes, counting.reduce((s, g) => s + g.currentStrokes, 0));
  assert.ok(t.strokes > 0);
  assert.equal(t.strokesComplete, false);
});

test('cut projection: line and per-golfer odds are sane', async () => {
  const { projectCut, holesPlayed } = await import('../lib/cut.mjs');
  execFileSync('node', [new URL('./make-mock.mjs', import.meta.url).pathname, 'r2']);
  const mid = parseEspn(JSON.parse(fs.readFileSync(new URL('./mock-espn-r2.json', import.meta.url))), '401811952');
  const c = projectCut(mid, { top: 65, ties: true, sims: 1500 });
  assert.equal(c.available, true);
  assert.equal(c.final, false);
  const expectedMade = Object.values(c.players).reduce((a, b) => a + b, 0);
  assert.ok(expectedMade > 64 && expectedMade < 85, `expected ~65-85 through the cut, got ${expectedMade}`);
  assert.ok(c.lines[0].pct > 0.3);
  assert.ok(c.lines.reduce((a, l) => a + l.pct, 0) > 0.9);
  // A golfer far under the projected line is safe; far over is gone
  const sorted = [...mid.golfers].filter((g) => g.started).sort((a, b) => a.toPar - b.toPar);
  assert.ok(c.players[sorted[0].espnId] > 0.95);
  assert.ok(c.players[sorted.at(-1).espnId] < 0.05);
  // Round 1 complete and 9 holes into round 2 = 27 holes played
  assert.equal(holesPlayed(mid.golfers.find((g) => g.thru === '9' && g.rounds[0]), 2), 27);
  assert.equal(holesPlayed(mid.golfers.find((g) => g.rounds[0] && !g.currentStrokes), 2), 18);

  // Once ESPN marks golfers CUT the tab reports the real line instead of a projection
  const post = parseEspn(JSON.parse(fs.readFileSync(new URL('./mock-espn-post.json', import.meta.url))), '401811952');
  const done = projectCut(post, { top: 65, ties: true });
  assert.equal(done.final, true);
  assert.ok(done.madeCount > 0 && done.madeCount < post.golfers.length);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseEspn } from '../lib/espn.mjs';
import { computeLeaderboard } from '../lib/scoring.mjs';
import { projectWins, holes72 } from '../lib/winprob.mjs';

execFileSync('node', [new URL('./make-mock.mjs', import.meta.url).pathname, 'post']);
execFileSync('node', [new URL('./make-mock.mjs', import.meta.url).pathname, 'r2']);
const fx = JSON.parse(fs.readFileSync(new URL('./usopen2026.json', import.meta.url)));
const load = (f) => parseEspn(JSON.parse(fs.readFileSync(new URL(`./${f}.json`, import.meta.url))), '401811952');
function draft(settings = {}) {
  const managers = fx.managers.map((name, i) => ({ id: `m${i}`, name }));
  const picks = [];
  fx.grid.forEach((row, r) => row.forEach((name, c) => picks.push({ managerId: `m${c}`, round: r + 1, name })));
  return { managers, order: managers.map((m) => m.id), picks, settings };
}
const sum = (wp, k) => Object.values(wp.teams).reduce((a, t) => a + t[k], 0);

test('mid round 2: chances add up, trailing teams are long shots, same scores give same answer', () => {
  const feed = load('mock-espn-r2');
  const lb = computeLeaderboard(draft(), feed);
  const wp = projectWins(feed, lb, { sims: 2000 });
  assert.equal(wp.available, true);
  assert.ok(Math.abs(sum(wp, 'win') - 1) < 1e-9);
  assert.ok(Math.abs(sum(wp, 'money') - 3) < 1e-9, 'three paid places per run');
  const last = lb.teams.at(-1);
  assert.ok(wp.teams[last.managerId].win < 0.03, `${last.manager} at ${last.toParDisplay} should be a long shot`);
  const top2 = lb.teams.slice(0, 2).reduce((a, t) => a + wp.teams[t.managerId].win, 0);
  assert.ok(top2 > 0.35);
  assert.deepEqual(projectWins(feed, lb, { sims: 2000 }), wp);
});

test('Sunday afternoon: a two-team race, and a spare live golfer is worth about a stroke', () => {
  const post = load('mock-espn-post');
  const par = post.event.par;
  // Rebuild the feed as it looked 9 holes into round 4.
  const sunday = structuredClone(post);
  sunday.event.state = 'in';
  sunday.event.round = 4;
  for (const g of sunday.golfers) {
    if (g.status !== 'active') continue;
    const r4 = g.rounds[3];
    g.rounds = [g.rounds[0], g.rounds[1], g.rounds[2], null];
    const half = Math.round((r4 - par) / 2);
    g.toPar = g.rounds.slice(0, 3).reduce((a, r) => a + r - par, 0) + half;
    g.currentStrokes = Math.round(r4 / 2);
    g.thru = '9';
  }
  assert.equal(holes72(sunday.golfers.find((g) => g.status === 'active')), 63);
  const lb = computeLeaderboard(draft(), sunday);
  const wp = projectWins(sunday, lb, { sims: 2000 });
  assert.equal(wp.available, true);
  const by = (n) => wp.teams[lb.teams.find((t) => t.manager === n).managerId];
  // 9 holes in: Maldy +19, Zac +20, everyone else 13+ back.
  assert.ok(by('Maldy').win + by('Zac').win > 0.97, 'only two teams can still win');
  assert.ok(by('Chase').win < 0.01);
  // Maldy leads by one, but has exactly 6 live golfers (two missed the cut), so all six must count.
  // Zac has 7 live, so he can drop whichever of his last two plays the back nine worse. The model
  // should see that as close to a coin flip rather than a clear edge for the leader.
  const live = (n) => lb.teams.find((t) => t.manager === n).lineup.filter((g) => g.status === 'active').length;
  assert.equal(live('Maldy'), 6);
  assert.equal(live('Zac'), 7);
  assert.ok(by('Maldy').win > 0.3 && by('Maldy').win < 0.7, `Maldy ${by('Maldy').win}`);
  // Chase trails by 14 with half a round left: not in the money race for 1st, but a lock for 3rd.
  assert.ok(by('Chase').money > 0.95);
  assert.ok(Math.abs(sum(wp, 'win') - 1) < 1e-9);
});

test('hidden before there is enough golf and once every round is finished', () => {
  execFileSync('node', [new URL('./make-mock.mjs', import.meta.url).pathname, 'pre']);
  const pre = load('mock-espn-pre');
  assert.equal(projectWins(pre, computeLeaderboard(draft(), pre)).available, false);
  const post = load('mock-espn-post');
  const done = projectWins(post, computeLeaderboard(draft(), post));
  assert.equal(done.available, false);
  assert.match(done.reason, /complete/);
});

test('respects the tournament settings: best-N count and number of paid places', () => {
  const feed = load('mock-espn-r2');
  const a = projectWins(feed, computeLeaderboard(draft({ counting: 6 }), feed), { sims: 1000 });
  const b = projectWins(feed, computeLeaderboard(draft({ counting: 8 }), feed), { sims: 1000 });
  assert.notDeepEqual(a.teams, b.teams, 'counting all 8 changes the odds');
  const two = projectWins(feed, computeLeaderboard(draft(), feed), { sims: 1000, paid: 2 });
  assert.ok(Math.abs(sum(two, 'money') - 2) < 1e-9);
});

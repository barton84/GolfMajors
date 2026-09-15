// Builds an ESPN-shaped leaderboard JSON from the 2026 U.S. Open sheet export.
// Used for local testing only. Usage: node test/make-mock.mjs [post|pre|r2]
import fs from 'node:fs';
const mode = process.argv[2] || 'post';
const fx = JSON.parse(fs.readFileSync(new URL('./usopen2026.json', import.meta.url)));
const par = 70;
const PARS = [4, 4, 5, 3, 4, 4, 4, 3, 4, 4, 3, 4, 4, 3, 4, 5, 4, 4];
const REL = { '-3': ['ALBATROSS', '-3'], '-2': ['EAGLE', '-2'], '-1': ['BIRDIE', '-1'], '0': ['PAR', 'E'], '1': ['BOGEY', '+1'], '2': ['DOUBLE_BOGEY', '+2'], '3': ['TRIPLE_BOGEY', '+3'] };
// Spread a round total across 18 holes so the card has birdies and bogeys that add up.
function holes(total, seed, count = 18) {
  const diffs = Array(18).fill(0);
  let left = total - par;
  let i = seed % 18;
  // add some noise that nets to zero
  for (let k = 0; k < 3; k++) { diffs[(i + k * 5) % 18] -= 1; diffs[(i + k * 5 + 2) % 18] += 1; }
  while (left !== 0) { const step = left > 0 ? 1 : -1; diffs[i % 18] += step; left -= step; i += 7; }
  return PARS.slice(0, count).map((p, h) => {
    const d = Math.max(-3, Math.min(3, diffs[h]));
    const [name, dv] = REL[String(d)];
    return { period: h + 1, value: p + d, displayValue: String(p + d), scoreType: { name, displayValue: dv } };
  });
}
const competitors = fx.leaderboard.map((r, i) => {
  const status = String(r.score);
  let rounds = r.r.map((v) => (typeof v === 'number' ? v : null));
  if (mode === 'pre') rounds = [null, null, null, null];
  if (mode === 'r2') rounds = [rounds[0], null, null, null];
  const played = rounds.filter(Boolean);
  const special = ['CUT', 'WD', 'DQ'].includes(status) && mode === 'post';
  const toPar = played.reduce((s, v) => s + v - par, 0);
  const typeName = mode === 'pre' ? 'STATUS_SCHEDULED' : special ? `STATUS_${status}` : mode === 'post' ? 'STATUS_FINISH' : 'STATUS_IN_PROGRESS';
  const thru = mode === 'r2' ? (i % 3 === 0 ? 18 : i % 3 === 1 ? 9 : 0) : mode === 'post' ? 18 : 0;
  const lines = rounds.map((v, idx) =>
    v ? { period: idx + 1, value: v, displayValue: v - par === 0 ? 'E' : (v - par > 0 ? `+${v - par}` : `${v - par}`), linescores: holes(v, i + idx * 3) } : null
  ).filter(Boolean);
  if (mode === 'r2' && thru > 0 && thru < 18) lines.push({ period: 2, value: 33, displayValue: '-1', linescores: holes(69, i, thru) });
  if (mode === 'post' && status === 'WD' && !played.length && r.name === 'Jason Day') {
    lines.push({ period: 1, value: 46, displayValue: '+10', linescores: Array.from({ length: 11 }, () => ({ value: 4 })) });
  }
  return {
    id: String(1000 + i),
    sortOrder: i + 1,
    athlete: { id: String(1000 + i), displayName: r.name },
    status: {
      period: mode === 'pre' ? 1 : mode === 'r2' ? 2 : 4,
      type: { name: typeName },
      displayValue: mode === 'pre' ? '7:20 AM' : special ? status : thru >= 18 ? 'F' : thru ? String(thru) : '1:10 PM',
      thru,
      teeTime: `2026-06-18T${String(12 + (i % 8)).padStart(2, '0')}:${String((i * 11) % 60).padStart(2, '0')}:00Z`,
      position: { displayName: mode === 'post' ? String(r.pos) : '' },
    },
    score: { displayValue: special ? status : played.length ? (toPar === 0 ? 'E' : toPar > 0 ? `+${toPar}` : `${toPar}`) : 'E' },
    linescores: lines,
  };
});
// A golfer who withdrew before teeing off disappears from the field: drop one only in pre mode test? keep all.
const json = {
  events: [{ id: '401811952', name: '2026 U.S. Open', status: { type: { state: mode === 'pre' ? 'pre' : mode === 'r2' ? 'in' : 'post' }, period: mode === 'r2' ? 2 : 4 }, competitions: [{ competitors }] }],
};
const out = new URL(`./mock-espn-${mode}.json`, import.meta.url);
fs.writeFileSync(out, JSON.stringify(json));
console.log('wrote', out.pathname, competitors.length);

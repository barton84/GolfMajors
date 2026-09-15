// Builds an ESPN-shaped leaderboard JSON from the 2026 U.S. Open sheet export.
// Used for local testing only. Usage: node test/make-mock.mjs [post|pre|r2]
import fs from 'node:fs';
const mode = process.argv[2] || 'post';
const fx = JSON.parse(fs.readFileSync(new URL('./usopen2026.json', import.meta.url)));
const par = 70;
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
    v ? { period: idx + 1, value: v, displayValue: v - par === 0 ? 'E' : (v - par > 0 ? `+${v - par}` : `${v - par}`), linescores: Array.from({ length: 18 }, (_, h) => ({ value: 4, period: h + 1 })) } : null
  ).filter(Boolean);
  if (mode === 'r2' && thru > 0 && thru < 18) lines.push({ period: 2, value: 33, displayValue: '-1', linescores: Array.from({ length: thru }, () => ({ value: 4 })) });
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

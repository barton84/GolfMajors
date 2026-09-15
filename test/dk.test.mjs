import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDkCsv, matchNames, rebuildField } from '../lib/dk.mjs';
import { nameKey } from '../lib/names.mjs';

const CSV = `Position,Name + ID,Name,ID,Roster Position,Salary,Game Info,TeamAbbrev,AvgPointsPerGame
G,Scottie Scheffler (123),Scottie Scheffler,123,G,13800,Biltmore Championship,,98.2
G,Cameron Young (124),Cameron Young,124,G,9400,Biltmore Championship,,70.1
G,"Matt Fitzpatrick (125)",Matt Fitzpatrick,125,G,8900,Biltmore Championship,,65
G,Alex Fitzpatrick (126),Alex Fitzpatrick,126,G,7000,Biltmore Championship,,50
G,Ludvig Aberg (127),Ludvig Aberg,127,G,"$10,200",Biltmore Championship,,80
G,Si Woo Kim (128),Si Woo Kim,128,G,7600,Biltmore Championship,,55
G,Tom Kim (129),Tom Kim,129,G,7800,Biltmore Championship,,55
G,Jordan Nobody (130),Jordan Nobody,130,G,6000,Biltmore Championship,,20
`;
const espn = (names) => names.map((name, i) => ({ name, key: nameKey(name), espnId: String(900 + i), teeTime: null }));

test('parses DK salaries, sorted high to low, handles quotes and $', () => {
  const rows = parseDkCsv('Some instructions,,\n\n' + CSV);
  assert.equal(rows.length, 8);
  assert.equal(rows[0].name, 'Scottie Scheffler');
  assert.equal(rows.find((r) => r.name === 'Ludvig Aberg').salary, 10200);
});

test('rejects files without Name/Salary', () => {
  assert.throws(() => parseDkCsv('a,b,c\n1,2,3'), /Name and Salary/);
});

test('matches nicknames, accents and first initial, never guesses ambiguous names', () => {
  const rows = parseDkCsv(CSV);
  const field = espn(['Scottie Scheffler', 'Cam Young', 'Matthew Fitzpatrick', 'A. Fitzpatrick', 'Ludvig Åberg', 'Si-Woo Kim', 'Tommy Kim', 'Harris English']);
  const m = matchNames(rows, field);
  const got = Object.fromEntries(rows.map((r, i) => [r.name, m.get(i)?.name || null]));
  assert.equal(got['Cameron Young'], 'Cam Young');
  assert.equal(got['Matt Fitzpatrick'], 'Matthew Fitzpatrick');
  assert.equal(got['Alex Fitzpatrick'], 'A. Fitzpatrick');
  assert.equal(got['Ludvig Aberg'], 'Ludvig Åberg');
  assert.equal(got['Si Woo Kim'], 'Si-Woo Kim');
  assert.equal(got['Tom Kim'], 'Tommy Kim');
  assert.equal(got['Jordan Nobody'], null);
});

test('ambiguous initials are left for the admin', () => {
  const rows = [{ name: 'M. Fitzpatrick', key: nameKey('M. Fitzpatrick'), salary: 1 }];
  const field = espn(['Matt Fitzpatrick', 'Mike Fitzpatrick']);
  assert.equal(matchNames(rows, field).size, 0);
});

test('ESPN + DK: field sorted by salary, unmatched listed with suggestions, alias fixes it', () => {
  const d = { picks: [], espnField: espn(['Harris English', 'Tommy Kim', 'Scottie Scheffler', 'Cam Young', 'Jordy Nobodie']), dk: { rows: parseDkCsv(CSV), ignored: [] } };
  rebuildField(d, {});
  assert.deepEqual(d.field.slice(0, 3).map((f) => f.name), ['Scottie Scheffler', 'Cam Young', 'Tommy Kim']);
  assert.equal(d.field.at(-1).salary, undefined);
  const nobody = d.dkStatus.unmatched.find((u) => u.name === 'Jordan Nobody');
  assert.ok(nobody);
  assert.equal(nobody.suggestions[0].name, 'Jordy Nobodie');
  rebuildField(d, { [nameKey('Jordan Nobody')]: nameKey('Jordy Nobodie') });
  assert.equal(d.field.find((f) => f.name === 'Jordy Nobodie').salary, 6000);
  assert.ok(!d.dkStatus.unmatched.some((u) => u.name === 'Jordan Nobody'));
});

test('DK only draft, then linking to ESPN relinks picks (Cameron Young -> Cam Young)', () => {
  const d = { picks: [], dk: { rows: parseDkCsv(CSV), ignored: [] } };
  rebuildField(d, {});
  assert.equal(d.fieldSource, 'dk');
  const cam = d.field.find((f) => f.name === 'Cameron Young');
  d.picks.push({ n: 1, round: 1, managerId: 'm1', name: cam.name, key: cam.key, espnId: null });
  d.espnField = espn(['Cam Young', 'Scottie Scheffler']);
  rebuildField(d, {});
  assert.equal(d.fieldSource, 'espn');
  assert.equal(d.picks[0].name, 'Cam Young');
  assert.ok(d.picks[0].espnId);
  assert.equal(d.linkIssues.length, 0);
});

test('pick that cannot be linked to ESPN is flagged, not dropped', () => {
  const d = { picks: [{ n: 1, round: 1, managerId: 'm1', name: 'Jordan Nobody', key: nameKey('Jordan Nobody') }], espnField: espn(['Scottie Scheffler']) };
  rebuildField(d, {});
  assert.equal(d.linkIssues[0].name, 'Jordan Nobody');
  assert.ok(d.field.some((f) => f.name === 'Jordan Nobody'));
});

test('older drafts with only `field` keep working', () => {
  const d = { picks: [], field: espn(['Scottie Scheffler', 'Cam Young']) };
  rebuildField(d, {});
  assert.equal(d.fieldSource, 'espn');
  assert.equal(d.field.length, 2);
});

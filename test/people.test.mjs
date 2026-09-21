// PINs that follow a person across tournaments, lockout, and backup/restore round trips.
// Runs against the in-memory store through the real API handler.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.LOCAL_DEV = '1';
process.env.ADMIN_PASSWORD = 'pw';
process.env.MOCK_ESPN_FILE = new URL('./mock-espn-post.json', import.meta.url).pathname;
const { handle } = await import('../lib/api.mjs');
const { getStore } = await import('../lib/store.mjs');
const { createHash } = await import('node:crypto');

let token;
async function call(method, path, body, { admin = false } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (admin) headers.authorization = `Bearer ${token}`;
  const res = await handle(new Request(`http://x/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }));
  return { status: res.status, data: await res.json() };
}
const A = { admin: true };

test('setup: admin login', async () => {
  const r = await call('POST', '/admin/login', { password: 'pw' });
  assert.equal(r.status, 200);
  token = r.data.token;
});

let masters, pga;
test('a PIN set in one tournament works in the next one', async () => {
  masters = (await call('POST', '/admin/drafts', { year: 2027, major: 'The Masters', managers: [{ name: 'Walker', pin: '1111' }, { name: 'Cody', pin: '2222' }] }, A)).data;
  const walker = masters.managers.find((m) => m.name === 'Walker');
  assert.equal(walker.hasPin, true);
  assert.equal((await call('POST', `/draft/${masters.id}/verify-pin`, { managerId: walker.id, pin: '1111' })).data.ok, true);

  // New tournament, no PINs typed: Walker keeps his.
  pga = (await call('POST', '/admin/drafts', { year: 2027, major: 'PGA Championship', managers: [{ name: 'walker' }, { name: 'Cody' }, { name: 'Zac' }] }, A)).data;
  const w2 = pga.managers.find((m) => m.name === 'walker');
  assert.equal(w2.hasPin, true, 'name match is case-insensitive');
  assert.equal((await call('POST', `/draft/${pga.id}/verify-pin`, { managerId: w2.id, pin: '1111' })).data.ok, true);
  assert.equal(pga.managers.find((m) => m.name === 'Zac').hasPin, false);
});

test('a manager changes their own PIN and it applies everywhere', async () => {
  const w2 = pga.managers.find((m) => m.name === 'walker');
  const bad = await call('POST', `/draft/${pga.id}/change-pin`, { managerId: w2.id, pin: '0000', newPin: '4444' });
  assert.equal(bad.status, 403);
  assert.equal((await call('POST', `/draft/${pga.id}/change-pin`, { managerId: w2.id, pin: '1111', newPin: '44' })).status, 400);
  const ok = await call('POST', `/draft/${pga.id}/change-pin`, { managerId: w2.id, pin: '1111', newPin: '4444' });
  assert.equal(ok.status, 200);
  const walkerMasters = masters.managers.find((m) => m.name === 'Walker');
  assert.equal((await call('POST', `/draft/${masters.id}/verify-pin`, { managerId: walkerMasters.id, pin: '4444' })).data.ok, true);
  assert.equal((await call('POST', `/draft/${masters.id}/verify-pin`, { managerId: walkerMasters.id, pin: '1111' })).data.ok, false);
});

test('8 wrong PINs locks the manager; the right PIN still fails until the admin unlocks', async () => {
  const cody = masters.managers.find((m) => m.name === 'Cody');
  // One wrong guess counted above? No, Cody is fresh. Reset to be sure.
  await call('POST', '/admin/people', { name: 'Cody', action: 'unlock' }, A);
  let r;
  for (let i = 1; i <= 8; i++) r = (await call('POST', `/draft/${masters.id}/verify-pin`, { managerId: cody.id, pin: '9999' })).data;
  assert.equal(r.ok, false);
  assert.equal(r.locked, true);
  const right = (await call('POST', `/draft/${masters.id}/verify-pin`, { managerId: cody.id, pin: '2222' })).data;
  assert.equal(right.ok, false);
  assert.equal(right.locked, true);

  const list = (await call('GET', '/admin/people', null, A)).data.people;
  assert.equal(list.find((p) => p.name === 'Cody').locked, true);
  assert.deepEqual(list.find((p) => p.name === 'Cody').tournaments.sort(), ['2027 PGA Championship', '2027 The Masters']);

  await call('POST', '/admin/people', { name: 'Cody', action: 'unlock' }, A);
  assert.equal((await call('POST', `/draft/${masters.id}/verify-pin`, { managerId: cody.id, pin: '2222' })).data.ok, true);
});

test('a correct PIN resets the wrong-guess counter', async () => {
  const cody = masters.managers.find((m) => m.name === 'Cody');
  for (let i = 0; i < 7; i++) await call('POST', `/draft/${masters.id}/verify-pin`, { managerId: cody.id, pin: '9999' });
  assert.equal((await call('POST', `/draft/${masters.id}/verify-pin`, { managerId: cody.id, pin: '2222' })).data.ok, true);
  const r = (await call('POST', `/draft/${masters.id}/verify-pin`, { managerId: cody.id, pin: '9999' })).data;
  assert.equal(r.locked, false);
  assert.equal(r.left, 7);
});

test('admin can set a new PIN for a locked manager, which also unlocks them', async () => {
  const cody = masters.managers.find((m) => m.name === 'Cody');
  for (let i = 0; i < 8; i++) await call('POST', `/draft/${masters.id}/verify-pin`, { managerId: cody.id, pin: '9999' });
  await call('POST', '/admin/people', { name: 'Cody', action: 'set', pin: '5555' }, A);
  assert.equal((await call('POST', `/draft/${masters.id}/verify-pin`, { managerId: cody.id, pin: '5555' })).data.ok, true);
  assert.equal((await call('POST', '/admin/people', { name: 'Cody', action: 'set', pin: '12345' }, A)).status, 400);
});

test('picks check the PIN and respect the lockout', async () => {
  await call('POST', `/admin/draft/${masters.id}/field`, { source: 'paste', names: 'Scottie Scheffler\nRory McIlroy\nJon Rahm\nXander Schauffele' }, A);
  assert.equal((await call('POST', `/admin/draft/${masters.id}/status`, { status: 'drafting' }, A)).status, 200);
  const d = (await call('GET', `/draft/${masters.id}`)).data;
  const clock = d.onClock.managerId;
  const who = d.managers.find((m) => m.id === clock);
  const pin = who.name === 'Walker' ? '4444' : '5555';
  const golfer = d.field[0].key;
  assert.equal((await call('POST', `/draft/${masters.id}/pick`, { managerId: clock, pin: '0000', golferKey: golfer })).status, 403);
  const ok = await call('POST', `/draft/${masters.id}/pick`, { managerId: clock, pin, golferKey: golfer });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.picks.length, 1);

  // Lock whoever is on the clock now: even the right PIN can't pick, but the admin still can
  const d2 = ok.data;
  const who2 = d2.managers.find((m) => m.id === d2.onClock.managerId);
  const pin2 = who2.name === 'Walker' ? '4444' : '5555';
  for (let i = 0; i < 8; i++) await call('POST', `/draft/${masters.id}/verify-pin`, { managerId: who2.id, pin: '0000' });
  const locked = await call('POST', `/draft/${masters.id}/pick`, { managerId: who2.id, pin: pin2, golferKey: d2.field[1].key });
  assert.equal(locked.status, 423);
  assert.match(locked.data.error, /locked/i);
  const byAdmin = await call('POST', `/draft/${masters.id}/pick`, { managerId: who2.id, golferKey: d2.field[1].key }, A);
  assert.equal(byAdmin.status, 200);
  await call('POST', '/admin/people', { name: who2.name, action: 'unlock' }, A);
});

test('legacy per-tournament PINs still work and become the person PIN on first login', async () => {
  // Simulate a tournament created before this update: the PIN lives on the draft's manager record.
  const store = await getStore();
  const id = 'legacy-2026';
  const mgr = { id: 'm1', name: 'Barton', pinHash: createHash('sha256').update(`${id}:m1:7777`).digest('hex') };
  await store.set(`draft/${id}`, { id, name: '2026 Legacy', major: 'Other', year: 2026, managers: [mgr], order: ['m1'], picks: [], field: [], settings: { rounds: 10, starters: 8, counting: 6, penalty: 80 }, status: 'final', createdAt: '2026-01-01T00:00:00Z' });
  assert.equal((await call('GET', `/draft/${id}`)).data.managers[0].hasPin, true);
  assert.equal((await call('POST', `/draft/${id}/verify-pin`, { managerId: 'm1', pin: '7777' })).data.ok, true);
  // Now Barton's PIN follows him into a brand new tournament
  const next = (await call('POST', '/admin/drafts', { year: 2027, major: 'U.S. Open', managers: [{ name: 'Barton' }, { name: 'Erik' }] }, A)).data;
  const b = next.managers.find((m) => m.name === 'Barton');
  assert.equal(b.hasPin, true);
  assert.equal((await call('POST', `/draft/${next.id}/verify-pin`, { managerId: b.id, pin: '7777' })).data.ok, true);
  // Admin clearing the PIN removes it everywhere, legacy copy included
  await call('POST', '/admin/people', { name: 'Barton', action: 'clear' }, A);
  assert.equal((await call('POST', `/draft/${id}/verify-pin`, { managerId: 'm1', pin: '' })).data.noPin, true);
});

test('backup captures everything and restore brings back a deleted tournament', async () => {
  const backup = (await call('GET', '/admin/backup', null, A)).data;
  assert.equal(backup.app, 'golf-draft');
  const ids = backup.drafts.map((d) => d.id);
  assert.ok(ids.includes(masters.id) && ids.includes(pga.id) && ids.includes('legacy-2026'));
  assert.ok(backup.people.walker?.pinHash);
  assert.ok(!JSON.stringify(backup).includes('"espn/'), 'ESPN caches are left out');
  assert.ok((await call('GET', '/admin/backup/status', null, A)).data.lastBackupAt);

  // Delete a tournament, then merge the backup back in.
  await call('DELETE', `/admin/draft/${pga.id}`, null, A);
  assert.equal((await call('GET', `/draft/${pga.id}`)).status, 404);
  const r = (await call('POST', '/admin/restore', { backup, mode: 'merge' }, A)).data;
  assert.deepEqual(r.added, [pga.name]);
  assert.ok(r.skipped.includes(masters.name));
  assert.equal((await call('GET', `/draft/${pga.id}`)).status, 200);
  assert.ok((await call('GET', '/drafts')).data.drafts.some((d) => d.id === pga.id), 'back in the tournament list');
});

test('merge never overwrites live data; replace does, and undo puts it back', async () => {
  const backup = (await call('GET', '/admin/backup', null, A)).data;
  // Change something live after the backup
  await call('POST', `/admin/draft/${masters.id}/settings`, { name: 'Renamed Masters' }, A);
  await call('POST', '/admin/restore', { backup, mode: 'merge' }, A);
  assert.equal((await call('GET', `/draft/${masters.id}`)).data.name, 'Renamed Masters');

  // Add a tournament that is not in the backup, then replace
  const extra = (await call('POST', '/admin/drafts', { year: 2028, major: 'The Open', managers: [{ name: 'A' }, { name: 'B' }] }, A)).data;
  const rep = (await call('POST', '/admin/restore', { backup, mode: 'replace' }, A)).data;
  assert.ok(rep.removed.includes(extra.name));
  assert.equal((await call('GET', `/draft/${masters.id}`)).data.name, backup.drafts.find((d) => d.id === masters.id).name);
  assert.equal((await call('GET', `/draft/${extra.id}`)).status, 404);

  // Undo the replace: the renamed Masters and the extra tournament come back
  await call('POST', '/admin/restore/undo', {}, A);
  assert.equal((await call('GET', `/draft/${masters.id}`)).data.name, 'Renamed Masters');
  assert.equal((await call('GET', `/draft/${extra.id}`)).status, 200);
});

test('restore rejects files that are not backups, and non-admins cannot back up', async () => {
  assert.equal((await call('POST', '/admin/restore', { backup: { hello: 1 }, mode: 'merge' }, A)).status, 400);
  assert.equal((await call('GET', '/admin/backup')).status, 401);
  assert.equal((await call('POST', '/admin/restore', { backup: {}, mode: 'replace' })).status, 401);
});

test('snapshots are capped at 5', async () => {
  const backup = (await call('GET', '/admin/backup', null, A)).data;
  for (let i = 0; i < 7; i++) await call('POST', '/admin/restore', { backup, mode: 'merge' }, A);
  const snaps = (await call('GET', '/admin/backup/status', null, A)).data.snapshots;
  assert.equal(snaps.length, 5);
  const store = await getStore();
  assert.equal((await store.list('snapshots/')).filter((k) => k !== 'snapshots/index').length, 5);
});

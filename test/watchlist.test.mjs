// Draft Room watchlists: private per manager, PIN protected, readable by the admin.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.LOCAL_DEV = '1';
process.env.ADMIN_PASSWORD = 'pw';
const { handle } = await import('../lib/api.mjs');
const { getStore } = await import('../lib/store.mjs');

let token, d;
async function call(method, path, body, admin = false) {
  const headers = { 'content-type': 'application/json' };
  if (admin) headers.authorization = `Bearer ${token}`;
  const res = await handle(new Request(`http://x/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }));
  return { status: res.status, data: await res.json() };
}
const mid = (name) => d.managers.find((m) => m.name === name).id;
const keyOf = (name) => d.field.find((g) => g.name === name).key;

test('setup', async () => {
  token = (await call('POST', '/admin/login', { password: 'pw' })).data.token;
  d = (await call('POST', '/admin/drafts', { year: 2027, major: 'The Masters', managers: [{ name: 'Walker', pin: '1111' }, { name: 'Cody', pin: '2222' }] }, true)).data;
  d = (await call('POST', `/admin/draft/${d.id}/field`, { source: 'paste', names: 'Scottie Scheffler\nRory McIlroy\nJon Rahm\nLudvig Aberg\nXander Schauffele' }, true)).data;
  assert.equal(d.field.length, 5);
});

test('a manager saves and reads back their own ordered list', async () => {
  const keys = [keyOf('Jon Rahm'), keyOf('Scottie Scheffler'), keyOf('Jon Rahm'), 'not-a-golfer'];
  const saved = await call('POST', `/draft/${d.id}/watchlist`, { managerId: mid('Walker'), pin: '1111', keys });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.keys, [keyOf('Jon Rahm'), keyOf('Scottie Scheffler')], 'deduped, order kept, unknown golfers dropped');
  const read = await call('POST', `/draft/${d.id}/watchlist`, { managerId: mid('Walker'), pin: '1111' });
  assert.deepEqual(read.data.keys, saved.data.keys);
});

test("nobody can read or change another manager's list without that manager's PIN", async () => {
  const peek = await call('POST', `/draft/${d.id}/watchlist`, { managerId: mid('Walker'), pin: '2222' });
  assert.equal(peek.status, 403);
  const tamper = await call('POST', `/draft/${d.id}/watchlist`, { managerId: mid('Walker'), pin: '0000', keys: [] });
  assert.equal(tamper.status, 403);
  const still = await call('POST', `/draft/${d.id}/watchlist`, { managerId: mid('Walker'), pin: '1111' });
  assert.equal(still.data.keys.length, 2);
  // Cody's list is separate and starts empty
  assert.deepEqual((await call('POST', `/draft/${d.id}/watchlist`, { managerId: mid('Cody'), pin: '2222' })).data.keys, []);
});

test('lists never appear in the public draft data', async () => {
  const pub = await call('GET', `/draft/${d.id}`);
  assert.ok(!JSON.stringify(pub.data).includes('watch'));
});

test('the admin can read any list (to pick for someone who is away); others cannot use that route', async () => {
  const r = await call('GET', `/admin/draft/${d.id}/watchlist/${mid('Walker')}`, null, true);
  assert.deepEqual(r.data.keys, [keyOf('Jon Rahm'), keyOf('Scottie Scheffler')]);
  assert.equal((await call('GET', `/admin/draft/${d.id}/watchlist/${mid('Walker')}`)).status, 401);
});

test('lists are capped and cleaned up when the tournament is deleted', async () => {
  const many = Array.from({ length: 200 }, () => d.field.map((g) => g.key)).flat();
  const r = await call('POST', `/draft/${d.id}/watchlist`, { managerId: mid('Cody'), pin: '2222', keys: many });
  assert.equal(r.data.keys.length, 5);
  const store = await getStore();
  assert.equal((await store.list(`watch/${d.id}/`)).length, 2);
  await call('DELETE', `/admin/draft/${d.id}`, null, true);
  assert.equal((await store.list(`watch/${d.id}/`)).length, 0);
});

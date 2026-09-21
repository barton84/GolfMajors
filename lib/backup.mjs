// Backup and restore for everything that matters: tournaments, past winners, name aliases, and
// manager PINs. ESPN caches are left out; they rebuild themselves.
//
// Every restore saves a snapshot of the current data first, so a restore can always be undone.

import { getStore, update } from './store.mjs';
import seedWinners from '../data/winners.mjs';

export const BACKUP_META = 'meta/backup';
const SNAP_INDEX = 'snapshots/index';
const KEEP_SNAPSHOTS = 5;
const APP = 'golf-draft';
const VERSION = 1;

const draftKey = (id) => `draft/${id}`;
const err = (status, message) => Object.assign(new Error(message), { status });

export async function exportAll() {
  const store = await getStore();
  const { data: index } = await store.get('index');
  const ids = new Set((index?.drafts || []).map((d) => d.id));
  // Pick up any tournament missing from the index too, so nothing is ever left behind.
  try { for (const k of await store.list('draft/')) ids.add(k.slice('draft/'.length)); } catch {}
  const drafts = [];
  for (const id of ids) {
    const { data } = await store.get(draftKey(id));
    if (data) drafts.push(data);
  }
  const [winners, aliases, people] = await Promise.all(['winners', 'aliases', 'people'].map(async (k) => (await store.get(k)).data));
  return {
    app: APP,
    version: VERSION,
    createdAt: new Date().toISOString(),
    index: index || { currentId: null, drafts: [] },
    drafts,
    winners: winners || seedWinners, // the built-in history counts until the first edit
    aliases: aliases || {},
    people: people || {},
  };
}

export const summarize = (b) => ({
  tournaments: b.drafts?.length || 0,
  winners: Array.isArray(b.winners) ? b.winners.length : null,
  aliases: Object.keys(b.aliases || {}).length,
  people: Object.keys(b.people || {}).length,
});

function validate(b) {
  if (!b || typeof b !== 'object' || b.app !== APP) throw err(400, "That file isn't a Fantasy Golf Draft backup.");
  if (b.version > VERSION) throw err(400, 'That backup was made by a newer version of the app.');
  if (!Array.isArray(b.drafts) || b.drafts.some((d) => !d?.id || !Array.isArray(d.managers))) throw err(400, 'That backup file looks damaged.');
}

const indexEntry = (d) => ({ id: d.id, name: d.name, major: d.major, year: d.year, status: d.status, createdAt: d.createdAt });

async function snapshot(reason) {
  const store = await getStore();
  const data = await exportAll();
  const id = data.createdAt.replace(/[:.]/g, '-');
  await store.set(`snapshots/${id}`, data);
  let dropped = [];
  await update(SNAP_INDEX, (list) => {
    const next = [{ id, at: data.createdAt, reason, counts: summarize(data) }, ...(list || [])];
    dropped = next.slice(KEEP_SNAPSHOTS);
    return next.slice(0, KEEP_SNAPSHOTS);
  });
  for (const s of dropped) await store.del(`snapshots/${s.id}`).catch(() => {});
  return id;
}

export async function listSnapshots() {
  const { data } = await (await getStore()).get(SNAP_INDEX);
  return data || [];
}
export async function getSnapshot(id) {
  const { data } = await (await getStore()).get(`snapshots/${id}`);
  if (!data) throw err(404, 'Snapshot not found.');
  return data;
}

// mode 'merge': add what's missing, never overwrite. mode 'replace': make the store match the file.
export async function restoreAll(backup, mode = 'merge', { reason } = {}) {
  validate(backup);
  if (!['merge', 'replace'].includes(mode)) throw err(400, 'Unknown restore mode.');
  const store = await getStore();
  const snapshotId = await snapshot(reason || `Before ${mode} restore of a backup from ${backup.createdAt?.slice(0, 10) || 'an unknown date'}`);
  const current = await exportAll();
  const have = new Set(current.drafts.map((d) => d.id));
  const result = { mode, snapshotId, added: [], replaced: [], removed: [], skipped: [] };

  if (mode === 'replace') {
    const keep = new Set(backup.drafts.map((d) => d.id));
    for (const d of current.drafts) if (!keep.has(d.id)) { await store.del(draftKey(d.id)); result.removed.push(d.name); }
    for (const d of backup.drafts) {
      await store.set(draftKey(d.id), d);
      (have.has(d.id) ? result.replaced : result.added).push(d.name);
    }
    const drafts = backup.index?.drafts?.length ? backup.index.drafts.filter((x) => keep.has(x.id)) : backup.drafts.map(indexEntry);
    for (const d of backup.drafts) if (!drafts.some((x) => x.id === d.id)) drafts.push(indexEntry(d));
    const currentId = keep.has(backup.index?.currentId) ? backup.index.currentId : drafts[0]?.id || null;
    await store.set('index', { currentId, drafts });
    if (Array.isArray(backup.winners)) await store.set('winners', backup.winners);
    else await store.del('winners');
    await store.set('aliases', backup.aliases || {});
    await store.set('people', backup.people || {});
    return result;
  }

  // Merge
  for (const d of backup.drafts) {
    if (have.has(d.id)) { result.skipped.push(d.name); continue; }
    await store.set(draftKey(d.id), d, { onlyIfNew: true });
    result.added.push(d.name);
  }
  if (result.added.length) {
    const added = new Set(backup.drafts.filter((d) => !have.has(d.id)).map((d) => d.id));
    await update('index', (i) => {
      const idx = i || { currentId: null, drafts: [] };
      const fromFile = backup.drafts.filter((d) => added.has(d.id)).map((d) => backup.index?.drafts?.find((x) => x.id === d.id) || indexEntry(d));
      const drafts = [...idx.drafts, ...fromFile].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      return { currentId: idx.currentId || drafts[0]?.id || null, drafts };
    });
  }
  if (Array.isArray(backup.winners)) {
    await update('winners', (w) => {
      const list = w ? [...w] : null;
      if (!list) return backup.winners; // nothing saved yet, so the file's history is the most complete
      const same = (a, b) => (a.draftId && a.draftId === b.draftId) || (a.year === b.year && a.tournament === b.tournament);
      for (const row of backup.winners) if (!list.some((x) => same(x, row))) list.push(row);
      return list.sort((a, b) => a.year - b.year);
    });
  }
  await update('aliases', (a) => ({ ...(backup.aliases || {}), ...(a || {}) }));
  // Existing PINs always win; people only in the file are added.
  await update('people', (p) => ({ ...(backup.people || {}), ...(p || {}) }));
  return result;
}

export async function undoLastRestore() {
  const [latest] = await listSnapshots();
  if (!latest) throw err(404, 'There is no restore to undo.');
  const data = await getSnapshot(latest.id);
  return restoreAll(data, 'replace', { reason: 'Before undoing a restore' });
}

export async function markBackedUp() {
  await (await getStore()).set(BACKUP_META, { lastBackupAt: new Date().toISOString() });
}
export async function backupStatus() {
  const { data } = await (await getStore()).get(BACKUP_META);
  return { lastBackupAt: data?.lastBackupAt || null, snapshots: await listSnapshots() };
}

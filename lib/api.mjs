import { createHmac, createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { getStore, update } from './store.mjs';
import { fetchEspn, parseEspn, parseHoles, fetchPlayerCard, parsePlayerCard } from './espn.mjs';
import { computeLeaderboard, managerForPick, DEFAULT_SETTINGS } from './scoring.mjs';
import { nameKey, parseEventId } from './names.mjs';
import seedWinners from '../data/winners.mjs';
import { parseDkCsv, rebuildField } from './dk.mjs';

const MAJORS = ['The Masters', 'PGA Championship', 'U.S. Open', 'The Open', 'The Players', 'Other'];
const DEFAULT_PAYOUTS = [
  { place: '1st Place', prize: '$175' },
  { place: '2nd Place', prize: '$95' },
  { place: '3rd Place', prize: 'Money back' },
];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, msg) => { throw new HttpError(status, msg); };
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });

// ---------- auth ----------
function secret() {
  const s = process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD;
  if (!s) fail(500, 'ADMIN_PASSWORD is not set in Netlify environment variables.');
  return s;
}
const sign = (payload) => createHmac('sha256', secret()).update(payload).digest('base64url');
function makeToken() {
  const exp = String(Date.now() + 30 * 24 * 3600 * 1000);
  return `${exp}.${sign(`admin.${exp}`)}`;
}
function isAdmin(req) {
  const h = req.headers.get('authorization') || '';
  const token = h.replace(/^Bearer\s+/i, '');
  const [exp, sig] = token.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  if (!process.env.SESSION_SECRET && !process.env.ADMIN_PASSWORD) return false;
  const expected = Buffer.from(sign(`admin.${exp}`));
  const got = Buffer.from(sig);
  return expected.length === got.length && timingSafeEqual(expected, got);
}
const requireAdmin = (req) => { if (!isAdmin(req)) fail(401, 'Admin login required.'); };
const pinHash = (draftId, managerId, pin) => createHash('sha256').update(`${draftId}:${managerId}:${String(pin).trim()}`).digest('hex');

// ---------- helpers ----------
const draftKey = (id) => `draft/${id}`;
async function loadDraft(id) {
  const store = await getStore();
  const { data } = await store.get(draftKey(id));
  if (!data) fail(404, 'Draft not found.');
  return data;
}
function publicDraft(d) {
  const { managers, dk, espnField, pastedField, dkStatus, linkIssues, ...rest } = d;
  return {
    ...rest,
    managers: managers.map((m) => ({ id: m.id, name: m.name, hasPin: !!m.pinHash })),
    onClock: onClock(d),
    totalPicks: d.managers.length * d.settings.rounds,
  };
}
function adminDraft(d) {
  const { dk, espnField, pastedField, ...rest } = d;
  return {
    ...publicDraft(d),
    dkStatus: d.dkStatus || null,
    linkIssues: d.linkIssues || [],
    sources: { espn: espnField?.length || 0, paste: pastedField?.length || 0, dk: dk?.rows?.length || 0 },
  };
}
function onClock(d) {
  if (d.status !== 'drafting') return null;
  const n = d.picks.length;
  const total = d.managers.length * d.settings.rounds;
  if (n >= total) return null;
  const slot = managerForPick(n, d.order.length);
  return { pick: n + 1, round: Math.floor(n / d.order.length) + 1, managerId: d.order[slot] };
}
async function saveIndexEntry(d) {
  await update('index', (idx) => {
    const i = idx || { currentId: null, drafts: [] };
    const entry = { id: d.id, name: d.name, major: d.major, year: d.year, status: d.status, createdAt: d.createdAt };
    const pos = i.drafts.findIndex((x) => x.id === d.id);
    if (pos >= 0) i.drafts[pos] = entry;
    else i.drafts.unshift(entry);
    if (!i.currentId) i.currentId = d.id;
    return i;
  });
}
async function mutateDraft(id, fn) {
  const next = await update(draftKey(id), async (d) => {
    if (!d) fail(404, 'Draft not found.');
    const r = await fn(d);
    if (r === undefined) return undefined;
    r.updatedAt = new Date().toISOString();
    return r;
  });
  await saveIndexEntry(next);
  return next;
}

async function getFeed(eventId, { force = false } = {}) {
  if (!eventId) return { feed: null, error: null };
  const store = await getStore();
  const key = `espn/${eventId}`;
  const { data: cache } = await store.get(key);
  const age = cache ? Date.now() - cache.at : Infinity;
  const ttl = cache?.feed?.event?.state === 'in' ? 60_000 : 5 * 60_000;
  if (cache && age < ttl && !force) return { feed: cache.feed, fetchedAt: cache.at };
  try {
    const { json: raw, url } = await fetchEspn(eventId);
    const feed = parseEspn(raw, eventId);
    const entry = { at: Date.now(), url, feed };
    await store.set(key, entry);
    try {
      const holes = parseHoles(raw, eventId);
      if (holes) await store.set(`espn-holes/${eventId}`, { at: entry.at, ...holes });
    } catch (e) {
      console.error('hole parse failed', e);
    }
    return { feed, fetchedAt: entry.at };
  } catch (e) {
    if (cache) return { feed: cache.feed, fetchedAt: cache.at, error: `Showing saved scores. ESPN error: ${e.message}` };
    return { feed: null, error: `Could not reach ESPN: ${e.message}` };
  }
}

// Every golfer in the tournament, tagged with the manager who drafted him (if anyone).
export function buildFieldBoard(d, feed, subs = new Map()) {
  const starters = d.settings?.starters ?? DEFAULT_SETTINGS.starters;
  const byId = new Map();
  const byKey = new Map();
  for (const p of d.picks || []) {
    const owner = { managerId: p.managerId, round: p.round, backup: p.round > starters, pickKey: p.key, subFor: subs.get(p.key) || null };
    if (p.espnId) byId.set(p.espnId, owner);
    byKey.set(nameKey(p.name), owner);
  }
  const seen = new Set();
  const state = feed?.event?.state || 'pre';
  const rows = [];
  const src = feed?.golfers?.length ? feed.golfers : (d.field || []).map((f, i) => ({ ...f, status: 'active', pos: '', toPar: null, today: '', thru: '', rounds: [null, null, null, null], sortOrder: i + 1 }));
  for (const g of src) {
    const owner = (g.espnId && byId.get(g.espnId)) || byKey.get(g.key) || null;
    if (owner) seen.add(owner.pickKey);
    const o = d.overrides?.[g.key];
    rows.push({
      key: owner?.pickKey || g.key, name: g.name, espnId: g.espnId || null, pos: g.pos || '', status: o?.status || g.status, toPar: g.toPar ?? null,
      today: g.today || '', thru: g.thru || '', teeTime: g.teeTime || null, rounds: g.rounds || [null, null, null, null], sortOrder: g.sortOrder ?? rows.length + 1, owner,
    });
  }
  // Drafted golfers ESPN no longer lists (withdrew before the event) still appear
  for (const p of d.picks || []) {
    if (seen.has(p.key)) continue;
    rows.push({ key: p.key, name: p.name, espnId: p.espnId || null, pos: '-', status: state === 'pre' ? 'active' : 'wd', toPar: null, today: '', thru: '', teeTime: p.teeTime || null, rounds: [null, null, null, null], sortOrder: 10000 + p.n, owner: { managerId: p.managerId, round: p.round, backup: p.round > starters, pickKey: p.key, subFor: subs.get(p.key) || null } });
  }
  return { event: feed?.event || { state }, golfers: rows };
}

async function getAliases() {
  const { data } = await (await getStore()).get('aliases');
  return data || {};
}

async function getWinners() {
  const store = await getStore();
  const { data } = await store.get('winners');
  return data || seedWinners;
}

function cleanSettings(s = {}) {
  const out = { ...DEFAULT_SETTINGS };
  for (const k of ['rounds', 'starters', 'counting', 'penalty']) if (s[k] !== undefined && s[k] !== '') out[k] = Math.max(1, parseInt(s[k], 10) || DEFAULT_SETTINGS[k]);
  out.par = s.par ? parseInt(s.par, 10) || null : null;
  if (out.starters > out.rounds) out.starters = out.rounds;
  if (out.counting > out.starters) out.counting = out.starters;
  return out;
}

// ---------- routes ----------
export async function handle(req) {
  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/(\.netlify\/functions\/api|api)/, '') || '/';
    const parts = path.split('/').filter(Boolean);
    const method = req.method.toUpperCase();
    const body = method === 'GET' ? {} : await req.json().catch(() => ({}));

    // Public
    if (method === 'GET' && path === '/meta') return json({ majors: MAJORS, defaults: { settings: DEFAULT_SETTINGS, payouts: DEFAULT_PAYOUTS } });
    if (method === 'GET' && path === '/drafts') {
      const { data } = await (await getStore()).get('index');
      return json(data || { currentId: null, drafts: [] });
    }
    if (method === 'GET' && path === '/history') return json({ winners: await getWinners() });

    if (parts[0] === 'draft' && parts[1]) {
      const id = parts[1];
      if (method === 'GET' && parts.length === 2) return json(publicDraft(await loadDraft(id)));

      if (method === 'GET' && parts[2] === 'scores') {
        const d = await loadDraft(id);
        if (d.status === 'final' && d.final?.leaderboard) return json({ ...d.final.leaderboard, final: true, sideBetWinner: d.final.sideBetWinner });
        const force = url.searchParams.get('refresh') === '1' && isAdmin(req);
        const { feed, error, fetchedAt } = await getFeed(d.espnEventId, { force });
        return json({ ...computeLeaderboard(d, feed), error, fetchedAt, final: false });
      }

      if (method === 'GET' && parts[2] === 'field') {
        const d = await loadDraft(id);
        const { feed, error, fetchedAt } = await getFeed(d.espnEventId);
        // Backups currently subbed into a lineup get a SUB tag instead of BU
        const subs = new Map();
        for (const t of computeLeaderboard(d, feed).teams) for (const g of t.lineup) if (g.subFor) subs.set(g.pickKey, g.subFor);
        return json({ ...buildFieldBoard(d, feed, subs), error, fetchedAt });
      }

      if (method === 'GET' && parts[2] === 'scorecard') {
        const d = await loadDraft(id);
        const key = url.searchParams.get('key');
        const pick = d.picks.find((p) => p.key === key || nameKey(p.name) === key) || d.field.find((f) => f.key === key);
        if (!pick) fail(404, 'Golfer not found in this draft.');
        if (!d.espnEventId || !pick.espnId) return json({ name: pick.name, available: false, reason: 'This golfer is not linked to ESPN yet.' });
        const store = await getStore();
        // 1) Per-player scorecard from ESPN, cached for a minute during play
        if (!process.env.MOCK_ESPN_FILE) {
          const cacheKey = `espn-card/${d.espnEventId}/${pick.espnId}`;
          const { data: cached } = await store.get(cacheKey);
          const { data: feedCache } = await store.get(`espn/${d.espnEventId}`);
          const live = feedCache?.feed?.event?.state === 'in';
          const ttl = live ? 60_000 : d.status === 'final' ? 7 * 24 * 3600_000 : 10 * 60_000;
          let card = cached && Date.now() - cached.at < ttl ? cached : null;
          if (!card) {
            try {
              const raw = await fetchPlayerCard(d.espnEventId, pick.espnId, d.year);
              const parsed = parsePlayerCard(raw, feedCache?.feed?.event?.holePars);
              if (parsed) {
                card = { at: Date.now(), ...parsed };
                await store.set(cacheKey, card);
              }
            } catch (e) {
              if (cached) card = cached;
            }
          }
          if (card && !card.empty) return json({ name: pick.name, available: true, pars: card.pars, rounds: card.rounds, updatedAt: card.at });
          if (card?.empty) return json({ name: pick.name, available: false, reason: 'No holes played yet.' });
        }
        // 2) Fallback: hole data included in the leaderboard feed (used by local test data)
        let { data } = await store.get(`espn-holes/${d.espnEventId}`);
        if (!data && d.status !== 'final') { await getFeed(d.espnEventId); ({ data } = await store.get(`espn-holes/${d.espnEventId}`)); }
        const rounds = data?.players?.[pick.espnId] || null;
        if (!rounds || !rounds.some(Boolean)) return json({ name: pick.name, available: false, reason: "Couldn't load this scorecard from ESPN. Try again in a minute." });
        return json({ name: pick.name, available: true, pars: data.pars, rounds, updatedAt: data.at });
      }

      if (method === 'POST' && parts[2] === 'verify-pin') {
        const d = await loadDraft(id);
        const m = d.managers.find((x) => x.id === body.managerId);
        if (!m) fail(404, 'Manager not found.');
        if (!m.pinHash) return json({ ok: true, noPin: true });
        return json({ ok: m.pinHash === pinHash(id, m.id, body.pin) });
      }

      if (method === 'POST' && parts[2] === 'pick') {
        const admin = isAdmin(req);
        const next = await mutateDraft(id, (d) => {
          const clock = onClock(d);
          if (!clock) fail(400, d.status === 'drafting' ? 'The draft is complete.' : 'The draft is not open.');
          if (!admin) {
            if (body.managerId !== clock.managerId) fail(403, "It's not your pick.");
            const m = d.managers.find((x) => x.id === clock.managerId);
            if (m.pinHash && m.pinHash !== pinHash(id, m.id, body.pin)) fail(403, 'Wrong PIN.');
          }
          const g = d.field.find((f) => f.key === body.golferKey);
          if (!g) fail(400, 'That golfer is not in the field.');
          if (d.picks.some((p) => p.key === g.key)) fail(409, `${g.name} was already taken.`);
          d.picks.push({ n: d.picks.length + 1, round: clock.round, managerId: clock.managerId, name: g.name, key: g.key, espnId: g.espnId || null, teeTime: g.teeTime || null, at: new Date().toISOString(), byAdmin: admin && body.managerId !== clock.managerId });
          if (d.picks.length >= d.managers.length * d.settings.rounds) d.status = 'live';
          return d;
        });
        return json(publicDraft(next));
      }
      fail(404, 'Not found.');
    }

    // Admin
    if (method === 'POST' && path === '/admin/login') {
      const pw = process.env.ADMIN_PASSWORD;
      if (!pw) fail(500, 'ADMIN_PASSWORD is not set in Netlify environment variables.');
      const a = Buffer.from(String(body.password || ''));
      const b = Buffer.from(pw);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        await new Promise((r) => setTimeout(r, 600));
        fail(401, 'Wrong password.');
      }
      return json({ token: makeToken() });
    }
    if (parts[0] !== 'admin') fail(404, 'Not found.');
    requireAdmin(req);

    if (method === 'GET' && path === '/admin/check') return json({ ok: true });

    if (method === 'POST' && path === '/admin/drafts') {
      const id = `${body.year || new Date().getFullYear()}-${String(body.major || 'draft').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomUUID().slice(0, 4)}`;
      const d = {
        id,
        name: body.name || `${body.year} ${body.major}`,
        major: body.major || 'Other',
        year: parseInt(body.year, 10) || new Date().getFullYear(),
        eventInput: body.eventInput || '',
        espnEventId: parseEventId(body.eventInput),
        entryFee: body.entryFee ?? '$30',
        payouts: body.payouts || DEFAULT_PAYOUTS,
        sideBet: body.sideBet || { entry: '', payout: '' },
        settings: cleanSettings(body.settings),
        managers: [],
        order: [],
        status: 'setup',
        picks: [],
        field: [],
        overrides: {},
        showSalaries: true,
        createdAt: new Date().toISOString(),
      };
      d.managers = (body.managers || []).filter((m) => m.name?.trim()).map((m) => {
        const mid = randomUUID().slice(0, 8);
        return { id: mid, name: m.name.trim(), pinHash: m.pin ? pinHash(id, mid, m.pin) : null };
      });
      d.order = d.managers.map((m) => m.id);
      const store = await getStore();
      await store.set(draftKey(id), d, { onlyIfNew: true });
      await saveIndexEntry(d);
      if (body.makeCurrent !== false) await update('index', (i) => ({ ...i, currentId: id }));
      return json(publicDraft(d));
    }

    if (method === 'POST' && path === '/admin/current') {
      await update('index', (i) => ({ ...(i || { drafts: [] }), currentId: body.id }));
      return json({ ok: true });
    }

    if (method === 'GET' && path === '/admin/aliases') return json({ aliases: await getAliases() });
    if (method === 'DELETE' && path === '/admin/aliases') {
      await update('aliases', (a) => { const n = { ...(a || {}) }; delete n[nameKey(url.searchParams.get('name'))]; return n; });
      return json({ aliases: await getAliases() });
    }

    if (method === 'PUT' && path === '/admin/winners') {
      if (!Array.isArray(body.winners)) fail(400, 'winners must be a list');
      await (await getStore()).set('winners', body.winners);
      return json({ winners: body.winners });
    }

    if (method === 'GET' && path === '/admin/espn-test') {
      const eventId = parseEventId(url.searchParams.get('event'));
      if (!eventId) fail(400, 'Paste an ESPN tournament link or event ID.');
      const { json: raw, url: src } = await fetchEspn(eventId);
      const feed = parseEspn(raw, eventId);
      return json({ source: src, event: feed.event, golferCount: feed.golfers.length, sample: feed.golfers.slice(0, 5), rawCompetitorSample: (raw.events?.[0]?.competitions?.[0]?.competitors || []).slice(0, 1) });
    }

    if (parts[0] === 'admin' && parts[1] === 'draft' && parts[2]) {
      const id = parts[2];
      const action = parts[3];
      if (method === 'GET' && !action) {
        const d = await loadDraft(id);
        return json(adminDraft(d));
      }
      if (method === 'DELETE' && !action) {
        const store = await getStore();
        await store.del(draftKey(id));
        await update('index', (i) => {
          const drafts = (i?.drafts || []).filter((x) => x.id !== id);
          return { drafts, currentId: i?.currentId === id ? drafts[0]?.id || null : i?.currentId };
        });
        return json({ ok: true });
      }

      const next = await mutateDraft(id, async (d) => {
        switch (action) {
          case 'settings': {
            for (const k of ['name', 'major', 'entryFee', 'payouts', 'sideBet']) if (body[k] !== undefined) d[k] = body[k];
            if (typeof body.showSalaries === 'boolean') d.showSalaries = body.showSalaries;
            if (body.year) d.year = parseInt(body.year, 10);
            if (body.eventInput !== undefined) {
              d.eventInput = body.eventInput;
              d.espnEventId = parseEventId(body.eventInput);
            }
            if (body.settings) {
              if (d.picks.length && (body.settings.rounds != d.settings.rounds)) fail(400, 'Rounds cannot change after picks are made.');
              d.settings = cleanSettings({ ...d.settings, ...body.settings });
            }
            return d;
          }
          case 'managers': {
            // body.managers: [{id?, name, pin?}] ; pin '' keeps existing, null clears
            if (d.picks.length && body.managers.length !== d.managers.length) fail(400, 'Cannot add or remove managers after the draft starts.');
            if (body.managers.length > 12) fail(400, 'Too many managers.');
            const list = body.managers.filter((m) => m.name?.trim()).map((m) => {
              const existing = d.managers.find((x) => x.id === m.id);
              const mid = existing?.id || randomUUID().slice(0, 8);
              let ph = existing?.pinHash || null;
              if (m.pin) ph = pinHash(id, mid, m.pin);
              if (m.clearPin) ph = null;
              return { id: mid, name: m.name.trim(), pinHash: ph };
            });
            d.managers = list;
            const ids = list.map((m) => m.id);
            d.order = [...d.order.filter((x) => ids.includes(x)), ...ids.filter((x) => !d.order.includes(x))];
            return d;
          }
          case 'order': {
            if (d.picks.length) fail(400, 'Draft order is locked once picks are made.');
            if (body.randomize) {
              const o = d.managers.map((m) => m.id);
              for (let i = o.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [o[i], o[j]] = [o[j], o[i]];
              }
              d.order = o;
            } else {
              const ids = d.managers.map((m) => m.id);
              if (body.order?.length !== ids.length || !ids.every((x) => body.order.includes(x))) fail(400, 'Order must include every manager once.');
              d.order = body.order;
            }
            return d;
          }
          case 'field': {
            if (body.source === 'espn') {
              if (!d.espnEventId) fail(400, 'Add the ESPN tournament link first.');
              const { feed, error } = await getFeed(d.espnEventId, { force: true });
              if (!feed?.golfers?.length) fail(502, error || 'ESPN has not posted the field yet.');
              d.espnField = feed.golfers.map((g) => ({ name: g.name, key: g.key, espnId: g.espnId, teeTime: g.teeTime }));
            } else if (body.source === 'paste') {
              const entries = String(body.names || '').split(/\r?\n|,(?=\s*[A-Z])/).map((s) => s.replace(/\t.*$/, '').trim()).filter(Boolean).map((name) => ({ name, key: nameKey(name), espnId: null, teeTime: null }));
              const map = new Map((body.mode === 'append' ? d.pastedField || [] : []).map((f) => [f.key, f]));
              for (const e of entries) map.set(e.key, e);
              d.pastedField = [...map.values()];
            } else if (body.source === 'clear-espn') {
              d.espnField = [];
            } else if (body.source === 'clear-paste') {
              d.pastedField = [];
            }
            d.fieldLoadedAt = new Date().toISOString();
            return rebuildField(d, await getAliases());
          }
          case 'dk': {
            const rows = parseDkCsv(body.csv);
            d.dk = { rows, fileName: String(body.fileName || 'DKSalaries.csv').slice(0, 120), uploadedAt: new Date().toISOString(), ignored: [] };
            return rebuildField(d, await getAliases());
          }
          case 'dk-clear': {
            d.dk = null;
            return rebuildField(d, await getAliases());
          }
          case 'pair': {
            // Pair a DraftKings name (or an unlinked pick) with a field golfer, and remember it for future drafts.
            const from = nameKey(body.fromName);
            if (!from) fail(400, 'Missing name.');
            if (body.ignore) {
              d.dk = d.dk || { rows: [], ignored: [] };
              d.dk.ignored = [...new Set([...(d.dk.ignored || []), from])];
            } else {
              if (!d.field.some((f) => f.key === body.toKey)) fail(400, 'Golfer not in field.');
              await update('aliases', (a) => ({ ...(a || {}), [from]: body.toKey }));
            }
            return rebuildField(d, await getAliases());
          }
          case 'rebuild': {
            return rebuildField(d, await getAliases());
          }
          case 'status': {
            const allowed = ['setup', 'drafting', 'live', 'final'];
            if (!allowed.includes(body.status)) fail(400, 'Bad status.');
            if (body.status === 'drafting') {
              if (d.managers.length < 2) fail(400, 'Add at least 2 managers.');
              if (!d.field.length) fail(400, 'Load the field before starting the draft.');
            }
            if (body.status === 'final' && !d.final) fail(400, 'Use Finalize to close out a tournament.');
            d.status = body.status;
            return d;
          }
          case 'undo': {
            if (!d.picks.length) fail(400, 'No picks to undo.');
            d.picks.pop();
            if (d.status === 'live') d.status = 'drafting';
            return d;
          }
          case 'replace-pick': {
            // Replace a drafted golfer for the whole tournament, or swap two drafted golfers between teams.
            const p = d.picks.find((x) => x.n === Number(body.n));
            if (!p) fail(404, 'Pick not found.');
            const g = d.field.find((f) => f.key === body.golferKey);
            if (!g) fail(400, 'Golfer not in field.');
            if (g.key === p.key) fail(400, `${g.name} is already in that spot.`);
            const nameOf = (id) => d.managers.find((m) => m.id === id)?.name || '?';
            const ord = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
            const other = d.picks.find((x) => x.key === g.key && x.n !== p.n);
            const oldGolfer = { name: p.name, key: p.key, espnId: p.espnId || null, teeTime: p.teeTime || null };
            const at = new Date().toISOString();
            d.pickLog = d.pickLog || [];
            if (other) {
              if (!body.swap) fail(409, `${g.name} is already on ${nameOf(other.managerId)}'s team.`);
              Object.assign(other, oldGolfer);
              Object.assign(p, { name: g.name, key: g.key, espnId: g.espnId || null, teeTime: g.teeTime || null });
              d.pickLog.unshift({ at, text: `Swapped ${g.name} (now ${nameOf(p.managerId)}'s ${ord(p.round)} pick) and ${oldGolfer.name} (now ${nameOf(other.managerId)}'s ${ord(other.round)} pick)` });
            } else {
              Object.assign(p, { name: g.name, key: g.key, espnId: g.espnId || null, teeTime: g.teeTime || null });
              d.pickLog.unshift({ at, text: `Replaced ${oldGolfer.name} with ${g.name} as ${nameOf(p.managerId)}'s ${ord(p.round)} pick` });
            }
            d.pickLog = d.pickLog.slice(0, 100);
            return d;
          }
          case 'override': {
            const key = nameKey(body.name);
            d.overrides = d.overrides || {};
            if (body.clear) delete d.overrides[key];
            else d.overrides[key] = { status: body.status || undefined, rounds: body.rounds, started: body.started, toPar: body.toPar, note: body.note || '' };
            return d;
          }
          case 'finalize': {
            const { feed } = await getFeed(d.espnEventId, { force: true });
            const lb = computeLeaderboard(d, feed);
            const sideBetWinner = body.sideBetWinner || (!lb.sideBetTie && lb.sideBet[0]?.manager) || null;
            d.final = { leaderboard: lb, sideBetWinner, finalizedAt: new Date().toISOString() };
            d.status = 'final';
            if (body.recordWinner !== false) {
              const first = lb.teams.filter((t) => t.rank === 1);
              const second = lb.teams.filter((t) => t.rank === (first.length > 1 ? 1 + first.length : 2));
              const row = {
                year: d.year,
                tournament: d.major === 'Other' ? d.name : d.major,
                winner: first.map((t) => t.manager).join('/'),
                winnerDraftPos: first.map((t) => t.draftPos).join('/'),
                runnerUp: first.length > 1 ? null : second.map((t) => t.manager).join('/') || null,
                runnerUpDraftPos: first.length > 1 ? null : second.map((t) => t.draftPos).join('/') || null,
                sideBet: sideBetWinner,
                draftId: d.id,
              };
              await update('winners', (w) => {
                const list = w || structuredClone(seedWinners);
                const idx = list.findIndex((x) => x.draftId === d.id || (x.year === row.year && x.tournament === row.tournament));
                if (idx >= 0) list[idx] = row;
                else list.push(row);
                return list;
              });
            }
            return d;
          }
          default:
            fail(404, 'Unknown action.');
        }
      });
      return json(adminDraft(next));
    }
    fail(404, 'Not found.');
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    return json({ error: e.message || 'Server error' }, status);
  }
}

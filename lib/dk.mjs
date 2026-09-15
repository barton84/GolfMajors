// DraftKings salary file import and name matching between sources (DraftKings, ESPN, draft picks).
import { nameKey } from './names.mjs';

// ---------- CSV ----------
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

// Accepts DKSalaries.csv (Position, Name + ID, Name, ID, Roster Position, Salary, ...).
// Finds the header row wherever it is, so files with instruction rows above still work.
export function parseDkCsv(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
  for (let h = 0; h < Math.min(lines.length, 60); h++) {
    const cols = parseCsvLine(lines[h]);
    const lower = cols.map((c) => c.toLowerCase());
    const salaryCol = lower.indexOf('salary');
    let nameCol = lower.indexOf('name');
    if (nameCol < 0) nameCol = lower.findIndex((c) => c === 'player' || c === 'player name');
    if (salaryCol < 0 || nameCol < 0) continue;
    const idCol = lower.indexOf('id');
    const rows = [];
    const seen = new Set();
    for (const line of lines.slice(h + 1)) {
      if (!line.trim()) continue;
      const c = parseCsvLine(line);
      // Some exports put the salary table to the right of other data, so offset by the header's start
      const name = c[nameCol];
      const salary = parseInt(String(c[salaryCol] || '').replace(/[$,]/g, ''), 10);
      if (!name || !Number.isFinite(salary)) continue;
      const key = nameKey(name);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ name, key, salary, dkId: idCol >= 0 ? c[idCol] || null : null });
    }
    if (rows.length) return rows.sort((a, b) => b.salary - a.salary);
  }
  throw Object.assign(new Error("Couldn't find Name and Salary columns. Export the salary CSV from the DraftKings contest page."), { status: 400 });
}

// ---------- name matching ----------
const NICK = {
  cam: 'cameron', matt: 'matthew', matty: 'matthew', nick: 'nicholas', nicky: 'nicholas', nico: 'nicolas',
  tom: 'thomas', tommy: 'thomas', chris: 'christopher', alex: 'alexander', mike: 'michael', mikey: 'michael',
  dan: 'daniel', danny: 'daniel', ben: 'benjamin', benny: 'benjamin', will: 'william', willy: 'william',
  bill: 'william', billy: 'william', rob: 'robert', robbie: 'robert', bob: 'robert', bobby: 'robert',
  jim: 'james', jimmy: 'james', jamie: 'james', joe: 'joseph', joey: 'joseph', sam: 'samuel', sammy: 'samuel',
  steve: 'stephen', steven: 'stephen', zach: 'zachary', zack: 'zachary', zac: 'zachary', andy: 'andrew',
  drew: 'andrew', tony: 'anthony', ed: 'edward', eddie: 'edward', greg: 'gregory', jon: 'jonathan',
  johnny: 'john', jack: 'john', kev: 'kevin', pat: 'patrick', rick: 'richard', rickie: 'richard',
  ricky: 'richard', dick: 'richard', charlie: 'charles', chuck: 'charles', freddie: 'frederick', fred: 'frederick',
  harry: 'henry', hank: 'henry', max: 'maximilian', sebi: 'sebastian', seb: 'sebastian', ted: 'theodore',
  vince: 'vincent', davey: 'david', dave: 'david', doug: 'douglas', jeff: 'jeffrey', ken: 'kenneth',
  kenny: 'kenneth', larry: 'lawrence', lou: 'louis', russ: 'russell', stu: 'stuart', tim: 'timothy',
  timmy: 'timothy', ty: 'tyler', wes: 'wesley', josh: 'joshua', nate: 'nathan', gabe: 'gabriel',
  abe: 'abraham', ollie: 'oliver', thorbjorn: 'thorbjorn',
};

function tokens(name) {
  return String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ø/gi, 'o').replace(/æ/gi, 'ae').replace(/ß/g, 'ss')
    .replace(/\((a|am|amateur)\)/gi, ' ')
    .replace(/\./g, '')
    .replace(/[-_]/g, ' ')
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .map((t) => t.replace(/'/g, ''))
    .filter((t) => t && !/^(jr|sr|ii|iii|iv)$/.test(t));
}

export function nickKey(name) {
  const t = tokens(name);
  if (t.length < 2) return t.join('');
  return [NICK[t[0]] || t[0], ...t.slice(1)].join('');
}
export function initialKey(name) {
  const t = tokens(name);
  if (t.length < 2) return t.join('');
  return `${t[0][0]}|${t[t.length - 1]}`;
}
const lastName = (name) => { const t = tokens(name); return t[t.length - 1] || ''; };

function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

// Match a list of names (DK rows or picks) to target entries (the field).
// aliases: { nameKey(sourceName): targetKey } saved by the admin.
// Returns Map(sourceIndex -> target) for matches; unmatched indexes are left out.
export function matchNames(sources, targets, aliases = {}) {
  const result = new Map();
  const used = new Set();
  const byKey = new Map(targets.map((t) => [t.key, t]));
  const pass = (fn) => {
    sources.forEach((s, i) => {
      if (result.has(i)) return;
      const t = fn(s);
      if (t && !used.has(t.key)) { result.set(i, t); used.add(t.key); }
    });
  };
  const uniqueBy = (keyFn) => {
    const groups = new Map();
    for (const t of targets) {
      const k = keyFn(t.name);
      groups.set(k, [...(groups.get(k) || []), t]);
    }
    return (s) => {
      const g = (groups.get(keyFn(s.name)) || []).filter((t) => !used.has(t.key));
      return g.length === 1 ? g[0] : null;
    };
  };
  pass((s) => (s.espnId ? targets.find((t) => t.espnId && t.espnId === s.espnId) : null));
  pass((s) => byKey.get(aliases[nameKey(s.name)]) || null);
  pass((s) => byKey.get(nameKey(s.name)) || null);
  pass(uniqueBy(nickKey));
  pass(uniqueBy(initialKey));
  return result;
}

export function suggestFor(name, candidates, limit = 6) {
  const ln = lastName(name);
  const nk = nickKey(name);
  const ik = initialKey(name);
  return candidates
    .map((c) => {
      let score = lev(nk, nickKey(c.name));
      if (lastName(c.name) === ln) score -= 6;
      if (initialKey(c.name) === ik) score -= 3;
      return { key: c.key, name: c.name, score };
    })
    .filter((c) => c.score <= Math.max(3, Math.round(nk.length * 0.35)))
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map(({ key, name }) => ({ key, name }));
}

// ---------- field assembly ----------
// A draft can have up to three name sources. The field is built from the best one
// (ESPN > pasted names > DraftKings), then DK salaries are attached and used for sort order.
export function rebuildField(d, aliases = {}) {
  // Older drafts only stored `field`; split it into its source on first rebuild.
  if (!d.espnField && !d.pastedField) {
    const hasEspn = (d.field || []).some((f) => f.espnId);
    if (hasEspn) d.espnField = (d.field || []).filter((f) => f.espnId).map(({ name, key, espnId, teeTime }) => ({ name, key, espnId, teeTime }));
    else if (!d.dk?.rows?.length) d.pastedField = (d.field || []).map(({ name, key }) => ({ name, key, espnId: null, teeTime: null }));
  }
  const dkRows = d.dk?.rows || [];
  const ignored = new Set(d.dk?.ignored || []);
  let source = 'none';
  let base = [];
  if (d.espnField?.length) { source = 'espn'; base = d.espnField.map((f) => ({ ...f })); }
  else if (d.pastedField?.length) { source = 'paste'; base = d.pastedField.map((f) => ({ ...f })); }
  else if (dkRows.length) { source = 'dk'; base = dkRows.map((r) => ({ name: r.name, key: r.key, espnId: null, teeTime: null })); }
  base.forEach((f, i) => (f.order = i));

  // Attach salaries
  const unmatchedDk = [];
  if (dkRows.length) {
    const m = matchNames(dkRows, base, aliases);
    dkRows.forEach((r, i) => {
      const t = m.get(i);
      if (t) { t.salary = r.salary; if (nameKey(r.name) !== t.key) t.dkName = r.name; }
      else if (!ignored.has(r.key)) unmatchedDk.push(r);
    });
  }

  // Keep every pick attached to a field entry; relink picks when the source changes (e.g. DK names -> ESPN)
  const linkIssues = [];
  const picks = d.picks || [];
  if (picks.length) {
    const pm = matchNames(picks, base, aliases);
    picks.forEach((p, i) => {
      const t = pm.get(i);
      if (t) Object.assign(p, { name: t.name, key: t.key, espnId: t.espnId || null, teeTime: t.teeTime || null });
      else {
        base.push({ name: p.name, key: p.key, espnId: p.espnId || null, teeTime: p.teeTime || null, order: 1e6 });
        if (source === 'espn') linkIssues.push({ name: p.name, n: p.n });
      }
    });
  }

  base.sort((a, b) => (b.salary ?? -1) - (a.salary ?? -1) || a.order - b.order);
  d.field = base.map(({ order, ...f }) => f);
  d.fieldSource = source;
  const withSalary = d.field.filter((f) => f.salary);
  const unsalaried = d.field.filter((f) => !f.salary);
  d.dkStatus = dkRows.length
    ? {
        fileName: d.dk.fileName || 'DraftKings file',
        uploadedAt: d.dk.uploadedAt,
        total: dkRows.length,
        matched: withSalary.length,
        unmatched: unmatchedDk.map((r) => ({ name: r.name, key: r.key, salary: r.salary, suggestions: source === 'dk' ? [] : suggestFor(r.name, unsalaried) })),
        ignoredCount: ignored.size,
      }
    : null;
  d.linkIssues = linkIssues.map((x) => ({ ...x, suggestions: suggestFor(x.name, d.field.filter((f) => f.espnId && !picks.some((p) => p.key === f.key))) }));
  return d;
}

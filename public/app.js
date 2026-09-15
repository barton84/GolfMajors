// Fantasy Golf Draft - single page app (no build step)
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const app = $('#app');
 
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const adminToken = () => store.get('adminToken');
const isAdmin = () => !!adminToken();
 
async function api(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (adminToken()) headers.authorization = `Bearer ${adminToken()}`;
  const res = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path.startsWith('/admin') && path !== '/admin/login') {
    store.del('adminToken');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
 
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}
async function guard(fn) {
  try { return await fn(); } catch (e) { toast(e.message, 4000); }
}
function confirmBox(title, text, okLabel = 'Confirm') {
  const m = $('#modal');
  m.innerHTML = `<h3>${esc(title)}</h3><p class="muted">${text}</p><div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn" value="no">Cancel</button><button class="btn primary" value="yes">${esc(okLabel)}</button></div>`;
  m.showModal();
  return new Promise((resolve) => {
    $$('button', m).forEach((b) => (b.onclick = () => { m.close(); resolve(b.value === 'yes'); }));
    m.onclose = () => resolve(false);
  });
}
 
const fmtPar = (n) => (n === null || n === undefined || Number.isNaN(n) ? '-' : n === 0 ? 'E' : n > 0 ? `+${n}` : `${n}`);
const parCls = (n) => (typeof n === 'number' && n < 0 ? 'under' : '');
function fmtTee(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}
const fmtSalary = (n) => `$${Number(n).toLocaleString('en-US')}`;
const statusLabel = { setup: 'Setting up', drafting: 'Drafting', live: 'Live', final: 'Final' };
 
// ---------- theme ----------
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  store.set('theme', t);
  document.querySelector('meta[name=theme-color]').content = t === 'arena' ? '#1b1040' : '#0b5d2e';
}
$('#themeToggle').onclick = () => {
  const cur = document.documentElement.dataset.theme || 'golf';
  applyTheme(cur === 'golf' ? 'arena' : 'golf');
};
try { const t = localStorage.getItem('theme'); applyTheme(t ? JSON.parse(t) : 'golf'); } catch { applyTheme('golf'); }
 
// ---------- routing ----------
let index = { currentId: null, drafts: [] };
let timers = [];
const clearTimers = () => { timers.forEach(clearInterval); timers = []; };
const every = (fn, ms) => timers.push(setInterval(fn, ms));
 
async function loadIndex() {
  index = await api('GET', '/drafts').catch(() => ({ currentId: null, drafts: [] }));
  const p = $('#draftPicker');
  p.innerHTML = index.drafts.length
    ? index.drafts.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}${d.status === 'final' ? '' : ` (${statusLabel[d.status]})`}</option>`).join('')
    : '<option value="">No tournaments yet</option>';
}
$('#draftPicker').onchange = (e) => { if (e.target.value) location.hash = `#/d/${e.target.value}`; };
 
function setTabs(draft, active) {
  const t = $('#tabs');
  const links = [];
  if (draft) {
    const base = `#/d/${draft.id}`;
    links.push(['draft', `${base}/draft`, 'Draft Room']);
    links.push(['leaderboard', `${base}/leaderboard`, 'Leaderboard']);
    links.push(['sidebet', `${base}/sidebet`, 'Side Bet']);
    links.push(['rules', `${base}/rules`, 'Rules']);
  }
  links.push(['history', '#/history', 'Past Winners']);
  links.push(['admin', '#/admin', isAdmin() ? 'Admin' : 'Admin']);
  t.innerHTML = links.map(([k, href, label]) => `<a href="${href}" class="${k === active ? 'active' : ''}">${label}</a>`).join('');
  if (draft) $('#draftPicker').value = draft.id;
}
 
async function route() {
  clearTimers();
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  window.scrollTo({ top: 0, behavior: 'instant' });
  try {
    if (!parts.length) {
      await loadIndex();
      if (!index.currentId) return renderEmpty();
      return go(`#/d/${index.currentId}`, true);
    }
    if (parts[0] === 'history') { setTabs(await currentDraftStub(), 'history'); return renderHistory(); }
    if (parts[0] === 'admin') {
      setTabs(await currentDraftStub(), 'admin');
      if (!isAdmin()) return renderLogin();
      if (parts[1] === 'new') return renderCreate();
      if (parts[1] === 'winners') return renderWinnersEditor();
      if (parts[1]) return renderManage(parts[1]);
      return renderAdminHome();
    }
    if (parts[0] === 'd' && parts[1]) {
      const [draft] = await Promise.all([api('GET', `/draft/${parts[1]}`), loadIndex()]);
      let view = parts[2];
      if (!view) view = draft.status === 'setup' || draft.status === 'drafting' ? 'draft' : 'leaderboard';
      setTabs(draft, view);
      if (view === 'draft') return renderDraftRoom(draft);
      if (view === 'leaderboard') return renderLeaderboard(draft);
      if (view === 'sidebet') return renderSideBet(draft);
      if (view === 'rules') return renderRules(draft);
    }
    app.innerHTML = '<div class="card pad">Page not found. <a href="#/">Go home</a></div>';
  } catch (e) {
    app.innerHTML = `<div class="notice bad">${esc(e.message)}</div><p><a href="#/">Back to home</a></p>`;
  }
}
function go(hash, replace) {
  if (replace) { history.replaceState(null, '', hash); route(); } else location.hash = hash;
}
async function currentDraftStub() {
  if (!index.drafts.length) await loadIndex();
  const sel = $('#draftPicker').value || index.currentId;
  return index.drafts.find((d) => d.id === sel) || null;
}
window.addEventListener('hashchange', route);
 
function renderEmpty() {
  setTabs(null, '');
  app.innerHTML = `<div class="card pad" style="text-align:center;padding:48px 16px">
    <h1>No tournament yet</h1>
    <p class="muted">The admin can create the first draft.</p>
    <a class="btn primary" href="#/admin">Go to Admin</a></div>`;
}
 
// ---------- draft room ----------
function me(draft) {
  const s = store.get(`me:${draft.id}`);
  return s && draft.managers.some((m) => m.id === s.managerId) ? s : null;
}
const mgrName = (draft, id) => draft.managers.find((m) => m.id === id)?.name || '?';
 
function renderDraftRoom(draft) {
  let state = draft;
  let search = '';
  let show = 'players';
  app.innerHTML = `
    <div class="hero">
      <div><h1>${esc(draft.name)}</h1><div class="meta" id="dMeta"></div></div>
      <div class="row" id="whoami"></div>
    </div>
    <div id="clock"></div>
    <div class="mobile-tabs"><button class="btn" data-show="players">Players</button><button class="btn" data-show="board">Draft Board</button></div>
    <div class="draft-layout" data-show="players">
      <section class="card players">
        <div class="pad" style="padding-bottom:10px">
          <input id="search" type="search" placeholder="Search golfers" style="width:100%" autocomplete="off" />
          <div class="row between tiny muted" style="margin-top:8px"><span id="availCount"></span><label><input type="checkbox" id="hideTaken" checked /> Hide drafted</label></div>
        </div>
        <div class="list" id="plist"></div>
      </section>
      <section class="card board-pane"><div class="table-wrap" id="board"></div></section>
    </div>`;
 
  $$('.mobile-tabs .btn').forEach((b) => (b.onclick = () => { show = b.dataset.show; $('.draft-layout').dataset.show = show; }));
  $('#search').oninput = (e) => { search = e.target.value.toLowerCase(); drawPlayers(); };
  $('#hideTaken').onchange = drawPlayers;
 
  function drawWho() {
    const m = me(state);
    $('#whoami').innerHTML = m
      ? `<span class="pill good">You are ${esc(mgrName(state, m.managerId))}</span><button class="btn sm" id="notMe">Switch</button>`
      : `<button class="btn primary" id="iAm">I'm a manager</button>`;
    if ($('#notMe')) $('#notMe').onclick = () => { store.del(`me:${state.id}`); drawAll(); };
    if ($('#iAm')) $('#iAm').onclick = () => identify(state).then(drawAll);
  }
  function drawClock() {
    const c = state.onClock;
    const m = me(state);
    const meta = [`<span class="pill ${state.status === 'drafting' ? 'live' : ''}">${statusLabel[state.status]}</span>`, `<span class="pill">${state.picks.length} of ${state.totalPicks} picks</span>`];
    $('#dMeta').innerHTML = meta.join('');
    const el = $('#clock');
    if (state.status === 'setup') {
      el.innerHTML = `<div class="clock"><div><div class="big">Draft hasn't started</div><div class="small">The admin will open the draft when everyone is ready. This page updates on its own.</div></div></div>`;
    } else if (c) {
      const mine = m && m.managerId === c.managerId;
      el.innerHTML = `<div class="clock ${mine ? 'me' : ''}"><div><div class="small">Round ${c.round}, pick ${c.pick}${c.round > state.settings.starters ? ' (substitute round)' : ''}</div><div class="big">${mine ? "You're on the clock" : `On the clock: ${esc(mgrName(state, c.managerId))}`}</div></div>
        ${isAdmin() ? `<button class="btn sm" id="undo" style="background:rgba(255,255,255,.15);color:inherit;border-color:rgba(255,255,255,.4)">Undo last pick</button>` : ''}</div>`;
      if ($('#undo')) $('#undo').onclick = () => guard(async () => { if (await confirmBox('Undo last pick?', 'This removes the most recent pick.', 'Undo')) { state = await api('POST', `/admin/draft/${state.id}/undo`); drawAll(); } });
    } else {
      el.innerHTML = `<div class="clock"><div><div class="big">The draft is complete</div><div class="small">Good luck, everyone.</div></div><a class="btn accent" href="#/d/${state.id}/leaderboard">View leaderboard</a></div>`;
    }
  }
  function drawPlayers() {
    const taken = new Map(state.picks.map((p) => [p.key, p]));
    const hide = $('#hideTaken').checked;
    const c = state.onClock;
    const m = me(state);
    const canPick = c && (isAdmin() || (m && m.managerId === c.managerId));
    const list = state.field.filter((g) => (!hide || !taken.has(g.key)) && (!search || g.name.toLowerCase().includes(search)));
    $('#availCount').textContent = `${state.field.length - taken.size} available`;
    $('#plist').innerHTML = list.length
      ? list.map((g, i) => {
          const t = taken.get(g.key);
          return `<div class="player">
            <span class="nm">${esc(g.name)}${g.teeTime ? `<div class="tiny muted">${esc(fmtTee(g.teeTime))}</div>` : ''}</span>
            ${state.showSalaries !== false && g.salary ? `<span class="sal">${fmtSalary(g.salary)}</span>` : ''}
            ${t ? `<span class="tiny muted">${esc(mgrName(state, t.managerId))} R${t.round}</span>` : `<button class="btn sm ${canPick ? 'primary' : ''}" data-pick="${esc(g.key)}" ${canPick ? '' : 'disabled'}>Draft</button>`}
          </div>`;
        }).join('')
      : `<div class="pad muted">${state.field.length ? 'No golfers match.' : 'The field has not been loaded yet.'}</div>`;
    $$('[data-pick]').forEach((b) => (b.onclick = () => pick(b.dataset.pick)));
  }
  function drawBoard() {
    const n = state.order.length;
    const rounds = state.settings.rounds;
    const byCell = new Map(state.picks.map((p) => [`${p.round}:${p.managerId}`, p]));
    const m = me(state);
    const c = state.onClock;
    let html = `<table class="board"><thead><tr><th>Rd</th>${state.order.map((id, i) => `<th class="${m && m.managerId === id ? 'me' : ''}">${i + 1}. ${esc(mgrName(state, id))}</th>`).join('')}</tr></thead><tbody>`;
    for (let r = 1; r <= rounds; r++) {
      html += `<tr class="${r > state.settings.starters ? 'subround' : ''}"><td class="rd">${r}${r > state.settings.starters ? '<div class="tiny">SUB</div>' : ''}</td>`;
      state.order.forEach((id, slot) => {
        const p = byCell.get(`${r}:${id}`);
        const pickNo = (r - 1) * n + (r % 2 === 1 ? slot : n - 1 - slot) + 1;
        const now = c && c.round === r && c.managerId === id;
        html += `<td class="${now ? 'now' : ''}">${p ? `${esc(p.name)}` : now ? '<b>On the clock</b>' : ''}<span class="pk">#${pickNo}</span></td>`;
      });
      html += '</tr>';
    }
    $('#board').innerHTML = html + '</tbody></table>';
  }
  function drawAll() { drawWho(); drawClock(); drawPlayers(); drawBoard(); }
 
  async function pick(key) {
    const g = state.field.find((x) => x.key === key);
    const c = state.onClock;
    const m = me(state);
    const asAdmin = isAdmin() && (!m || m.managerId !== c.managerId);
    const ok = await confirmBox(`Draft ${g.name}?`, `${asAdmin ? `Admin pick for <b>${esc(mgrName(state, c.managerId))}</b>. ` : ''}Round ${c.round}, pick ${c.pick}.`, 'Draft');
    if (!ok) return;
    await guard(async () => {
      state = await api('POST', `/draft/${state.id}/pick`, { managerId: m?.managerId || c.managerId, pin: m?.pin, golferKey: key });
      toast(`${g.name} drafted`);
      drawAll();
    });
  }
 
  drawAll();
  let lastSig = '';
  every(async () => {
    try {
      const d = await api('GET', `/draft/${state.id}`);
      const sig = `${d.updatedAt}|${d.picks.length}|${d.status}`;
      if (sig !== lastSig) { lastSig = sig; state = d; drawAll(); }
    } catch {}
  }, 2500);
}
 
async function identify(draft) {
  const m = $('#modal');
  m.innerHTML = `<h3>Who are you?</h3>
    <form method="dialog" class="stack">
      <label class="field">Manager<select name="mid">${draft.managers.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select></label>
      <label class="field">PIN<input name="pin" inputmode="numeric" autocomplete="off" maxlength="8" placeholder="4-digit PIN" /></label>
      <div class="notice bad" id="pinErr" hidden>That PIN doesn't match.</div>
      <div class="row" style="justify-content:flex-end"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">Continue</button></div>
    </form>`;
  m.showModal();
  return new Promise((resolve) => {
    const form = $('form', m);
    form.onsubmit = async (e) => {
      if (e.submitter?.value !== 'ok') { m.close(); return resolve(false); }
      e.preventDefault();
      const managerId = form.mid.value;
      const pin = form.pin.value.trim();
      const r = await api('POST', `/draft/${draft.id}/verify-pin`, { managerId, pin }).catch(() => ({ ok: false }));
      if (!r.ok) { $('#pinErr').hidden = false; return; }
      store.set(`me:${draft.id}`, { managerId, pin });
      m.close();
      resolve(true);
    };
  });
}
 
// ---------- leaderboard ----------
function roundCell(g, i) {
  const v = g.scoredRounds?.[i];
  if (!v) return '<td class="c hide-sm">-</td>';
  return `<td class="c hide-sm ${g.penaltyRounds?.[i] ? 'pen' : ''}">${v}</td>`;
}
function golferRow(g, extraCls = '') {
  const thru = g.status !== 'active' ? '' : g.thru ? g.thru : g.teeTime ? fmtTee(g.teeTime).replace(/^\w+ /, '') : '-';
  const score = g.status === 'active' ? fmtPar(g.teamToPar) : `<span class="badge out">${esc(g.status.toUpperCase())}</span>`;
  const sub = g.subFor ? ` <span class="badge" title="Subbed in for ${esc(g.subFor)}">SUB</span>` : '';
  return `<tr class="${extraCls}">
    <td class="tiny muted hide-sm">${esc(g.pos || '')}</td>
    <td class="g">${esc(g.name)}${sub}${g.overridden ? ' <span class="tiny muted" title="Adjusted by admin">*</span>' : ''}</td>
    <td class="c ${parCls(g.teamToPar)}">${score}</td>
    <td class="c hide-sm ${parCls(Number(g.today))}">${esc(g.status === 'active' ? g.today || '-' : '-')}</td>
    <td class="c">${esc(thru)}</td>
    ${[0, 1, 2, 3].map((i) => roundCell(g, i)).join('')}
    <td class="num"><b>${g.strokes || '-'}</b></td></tr>`;
}
 
function renderLeaderboard(draft) {
  app.innerHTML = `<div class="hero"><div><h1>${esc(draft.name)}</h1><div class="meta" id="lbMeta"></div></div>
    <div class="row">${isAdmin() && draft.status !== 'final' ? '<button class="btn sm" id="refresh">Refresh from ESPN</button>' : ''}</div></div>
    <div id="lbErr"></div><div id="lb" class="loading">Loading scores...</div>`;
  const draw = async (force) => {
    const lb = await api('GET', `/draft/${draft.id}/scores${force ? '?refresh=1' : ''}`);
    const state = lb.event?.state;
    const stateTxt = lb.final ? 'Final' : state === 'in' ? 'Live' : state === 'post' ? 'Round complete' : draft.picks.length ? 'Starts soon' : 'Not started';
    $('#lbMeta').innerHTML = `<span class="pill ${state === 'in' && !lb.final ? 'live' : ''}">${stateTxt}</span>
      ${lb.event?.par ? `<span class="pill">Par ${lb.event.par}</span>` : ''}
      <span class="pill">Best ${lb.settings.counting} of ${lb.settings.starters} count</span>
      ${lb.fetchedAt ? `<span class="tiny muted">Updated ${new Date(lb.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>` : ''}`;
    $('#lbErr').innerHTML = lb.error ? `<div class="notice bad" style="margin-bottom:12px">${esc(lb.error)}</div>` : '';
    if (!draft.picks.length) { $('#lb').outerHTML = '<div id="lb" class="card pad muted">No picks yet. Scores show up here after the draft.</div>'; return; }
    const started = lb.final || (state && state !== 'pre');
    const standings = `<div class="card"><div class="table-wrap"><table class="standings">
      <thead><tr><th>Pos</th><th>Manager</th><th class="num">To par</th><th class="num">Strokes</th><th class="num hide-sm">Pick</th></tr></thead><tbody>
      ${lb.teams.map((t) => `<tr class="${t.rank === 1 ? 'first' : ''}"><td class="rank">${t.rank}</td><td class="mgr"><a href="#" class="jump" data-team="${esc(t.managerId)}">${esc(t.manager)}</a>${t.tiedOnScore && started ? ` <button type="button" class="tb-chip" data-tb="${esc(t.managerId)}">Tiebreaker</button>` : ''}</td>
        <td class="num score ${parCls(t.toPar)}">${esc(t.toParDisplay)}</td><td class="num">${t.strokesComplete ? t.strokes : '-'}</td><td class="num hide-sm muted">${t.draftPos}</td></tr>`).join('')}
      </tbody></table></div></div>
`;
    const cards = lb.teams.map((t) => `<article class="card team" id="team-${esc(t.managerId)}">
      <div class="team-head"><div class="row" style="gap:10px"><span class="rk">${t.rank}</span><div><h3 style="margin:0">${esc(t.manager)}</h3><div class="tiny muted">${t.strokesComplete ? `${t.strokes} strokes` : `${t.lineup.filter((g) => g.status === 'active').length} of ${t.lineup.length} still playing`}${t.replaced.length ? ` · ${t.replaced.map((r) => `${esc(r.name)} WD before start`).join(', ')}` : ''}</div></div></div>
      <div class="tot ${parCls(t.toPar)}">${esc(t.toParDisplay)}</div></div>
      <div class="table-wrap"><table><thead><tr><th class="hide-sm">Pos</th><th>Golfer</th><th class="c">Score</th><th class="c hide-sm">Today</th><th class="c">Thru</th><th class="c hide-sm">R1</th><th class="c hide-sm">R2</th><th class="c hide-sm">R3</th><th class="c hide-sm">R4</th><th class="num">Tot</th></tr></thead>
      <tbody>${t.lineup.map((g) => golferRow(g, g.counting ? '' : 'dim')).join('')}
      ${t.bench.filter((b) => !b.usedAsSub).map((g) => golferRow({ ...g, pos: `R${g.round}` }, 'bench-row')).join('')}</tbody></table></div>
    </article>`).join('');
    $('#lb').outerHTML = `<div id="lb">${standings}<p class="tiny muted" style="margin:10px 2px 0">Faded rows don't count toward the team score. Gray rows are unused backups. <span class="pen">80</span> = missed round penalty.</p><div class="teams">${cards}</div></div>`;
    $$('#lb .tb-chip').forEach((b) => (b.onclick = () => showTiebreak(lb, b.dataset.tb)));
    $$('#lb .jump').forEach((a) => (a.onclick = (e) => {
      e.preventDefault();
      const card = document.getElementById(`team-${a.dataset.team}`);
      if (!card) return;
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      card.classList.remove('flash');
      void card.offsetWidth;
      card.classList.add('flash');
    }));
  };
  guard(draw);
  if ($('#refresh')) $('#refresh').onclick = () => guard(async () => { await draw(true); toast('Scores refreshed'); });
  if (draft.status !== 'final') every(() => draw().catch(() => {}), 60_000);
}
 
function showTiebreak(lb, managerId) {
  const me = lb.teams.find((t) => t.managerId === managerId);
  if (!me) return;
  const group = lb.teams.filter((t) => t.toPar === me.toPar);
  const labels = ['Best 2', 'Best 4', 'Best 6', 'All 8'];
  // First column where the tied teams differ decides it
  const decider = labels.findIndex((_, i) => new Set(group.map((t) => t.tiebreak[i])).size > 1);
  const best = decider >= 0 ? Math.min(...group.map((t) => t.tiebreak[decider])) : null;
  const m = $('#modal');
  m.innerHTML = `<h3>Tiebreaker at ${esc(fmtPar(me.toPar))}</h3>
    <p class="small muted">Tied teams are compared by their best 2 golfers first, then best 4, 6, and all 8. The first column that's different decides it.</p>
    <div class="table-wrap"><table class="tb-table"><thead><tr><th>Manager</th>${labels.map((l, i) => `<th class="c ${i === decider ? 'decider' : ''}">${l}</th>`).join('')}</tr></thead>
    <tbody>${group.map((t) => `<tr class="${t.managerId === managerId ? 'hi' : ''}"><td><b>${esc(t.manager)}</b> <span class="tiny muted">${ordinal(t.rank)}</span></td>${t.tiebreak.map((v, i) => `<td class="c ${i === decider ? 'decider' : ''} ${i === decider && v === best ? 'win' : ''}">${esc(fmtPar(v))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    <p class="small" style="margin-top:12px">${decider >= 0 ? `Decided by the <b>${labels[decider].toLowerCase()}</b> golfers.` : 'Still tied on every tiebreaker. Per the rules, tied teams split the payout.'}${lb.final ? '' : ' <span class="muted">This can change as scores come in.</span>'}</p>
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn primary" value="close">Close</button></div>`;
  m.showModal();
  $('button', m).onclick = () => m.close();
  m.onclick = (e) => { if (e.target === m) m.close(); };
}
const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
 
function renderSideBet(draft) {
  app.innerHTML = `<div class="hero"><div><h1>Side Bet</h1><div class="meta">
    <span class="pill">Best single backup golfer wins</span>
    ${draft.sideBet?.entry ? `<span class="pill">Entry ${esc(draft.sideBet.entry)}</span>` : ''}
    ${draft.sideBet?.payout ? `<span class="pill good">Payout ${esc(draft.sideBet.payout)}</span>` : ''}</div></div></div>
    <div id="sb" class="loading">Loading...</div>`;
  const draw = async () => {
    const lb = await api('GET', `/draft/${draft.id}/scores`);
    if (!lb.sideBet.length) { $('#sb').outerHTML = '<div id="sb" class="card pad muted">No backup picks yet.</div>'; return; }
    const winner = lb.final && lb.sideBetWinner;
    $('#sb').outerHTML = `<div id="sb" class="stack">
      ${winner ? `<div class="notice">Side bet winner: <b>${esc(winner)}</b></div>` : lb.sideBetTie ? '<div class="notice">Tied at the top. The admin picks the winner when the tournament is finalized.</div>' : ''}
      <div class="card"><div class="table-wrap"><table class="standings"><thead><tr><th>Pos</th><th>Manager</th><th>Best backup</th><th class="num">Score</th><th>Other backup</th><th class="num">Score</th></tr></thead><tbody>
      ${lb.sideBet.map((s) => `<tr class="${s.rank === 1 ? 'first' : ''}"><td class="rank">${s.rank}</td><td class="mgr">${esc(s.manager)}</td>
        <td>${esc(s.golfers[0]?.name)}${s.golfers[0]?.status !== 'active' ? ` <span class="badge out">${esc(s.golfers[0]?.status.toUpperCase())}</span>` : ''}</td><td class="num score ${parCls(s.golfers[0]?.teamToPar)}">${fmtPar(s.golfers[0]?.teamToPar)}</td>
        <td>${esc(s.golfers[1]?.name || '')}${s.golfers[1] && s.golfers[1].status !== 'active' ? ` <span class="badge out">${esc(s.golfers[1].status.toUpperCase())}</span>` : ''}</td><td class="num ${parCls(s.golfers[1]?.teamToPar)}">${s.golfers[1] ? fmtPar(s.golfers[1].teamToPar) : ''}</td></tr>`).join('')}
      </tbody></table></div></div><p class="tiny muted">Ties go to the manager with the better second backup.</p></div>`;
  };
  guard(draw);
  if (draft.status !== 'final') every(() => draw().catch(() => {}), 60_000);
}
 
function renderRules(draft) {
  const s = draft.settings;
  const pay = (draft.payouts || []).filter((p) => p.place || p.prize);
  app.innerHTML = `<div class="rules card pad stack" style="padding:28px">
    <div style="text-align:center"><h1>Fantasy Golf Draft Rules</h1><p class="muted">${esc(draft.name)}</p>${draft.entryFee ? `<span class="fee">ENTRY FEE: ${esc(draft.entryFee)}</span>` : ''}</div>
    <section><h2>Draft</h2><ul>
      <li>Draft order is randomly generated before the draft begins.</li>
      <li>The draft is a snake format (1 to ${draft.managers.length}, then ${draft.managers.length} to 1, and so on).</li>
      <li>Each golfer can only be drafted once. No duplicates across teams.</li>
      <li>Everyone drafts ${s.rounds} golfers. Rounds ${s.starters + 1}${s.rounds > s.starters + 1 ? ` and ${s.rounds}` : ''} are for substitutions only.</li>
      <li>Your round ${s.starters + 1} pick is only used if one of your golfers from rounds 1 to ${s.starters} withdraws before their first tee shot. ${s.rounds > s.starters + 1 ? `Your round ${s.starters + 2} pick covers a second withdrawal.` : ''}</li>
      <li>Once your golfer records their first swing in the tournament, no substitutes can be activated.</li>
      <li>If your golfer withdraws before their first swing but your round ${s.starters + 1} golfer has already started, your round ${s.starters + 1} golfer is still used.</li>
    </ul></section>
    <section><h2>Scoring</h2><ul>
      <li>Only ${s.starters} golfers are eligible to score for your team.</li>
      <li>Of those, the ${s.counting} lowest total scores count toward your team total.</li>
      <li>Any golfer who misses the cut, withdraws, or is disqualified receives an automatic score of ${s.penalty} for each round missed.</li>
      <li>The team with the lowest combined score after 72 holes wins.</li>
    </ul></section>
    <section><h2>Tiebreaker</h2><p>If two or more teams are tied for 1st, 2nd, or 3rd after the final round:</p><ol>
      <li>Compare the total strokes of the top 2 golfers on each tied team.</li><li>If still tied, compare the top 4 golfers.</li><li>If still tied, compare the top 6 golfers.</li><li>If still tied, compare the top 8 golfers.</li></ol>
      <p>If a tie remains, tied teams split the 1st or 2nd place payout evenly. For a tie in 3rd, each tied manager pays half the entry and no prize is awarded.</p></section>
    ${pay.length ? `<section><h2>Payout Structure</h2><div class="table-wrap"><table><thead><tr><th>Place</th><th>Prize</th></tr></thead><tbody>${pay.map((p) => `<tr><td>${esc(p.place)}</td><td>${esc(p.prize)}</td></tr>`).join('')}</tbody></table></div><p class="tiny muted">Payout structure is subject to change each tournament.</p></section>` : ''}
    ${draft.sideBet?.entry || draft.sideBet?.payout ? `<section><h2>Side Bet</h2><ul><li>Entry: ${esc(draft.sideBet.entry || '-')}. Payout: ${esc(draft.sideBet.payout || '-')}.</li><li>The manager whose single best backup golfer (rounds ${s.starters + 1} to ${s.rounds}) has the lowest score wins.</li><li>Ties go to the better second backup.</li></ul></section>` : ''}
  </div>`;
}
 
// ---------- history ----------
async function renderHistory() {
  const [{ winners }] = await Promise.all([api('GET', '/history'), loadIndex()]);
  const counts = {};
  winners.forEach((w) => String(w.winner || '').split('/').filter(Boolean).forEach((n) => (counts[n.replace('*', '')] = (counts[n.replace('*', '')] || 0) + 1)));
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const rows = [...winners].reverse();
  const archived = index.drafts.filter((d) => d.status === 'final');
  app.innerHTML = `<div class="hero"><div><h1>Past Winners</h1><div class="meta"><span class="pill">${winners.length} tournaments</span></div></div>${isAdmin() ? '<a class="btn sm" href="#/admin/winners">Edit</a>' : ''}</div>
    <div class="wins" style="margin-bottom:18px">${ranked.map(([n, c]) => `<div class="card w"><b>${c}</b>${esc(n)}</div>`).join('')}</div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>Year</th><th>Tournament</th><th>Winner</th><th class="c">Draft pos</th><th>Runner-up</th><th class="c">Draft pos</th><th>Side bet</th></tr></thead><tbody>
    ${rows.map((w) => `<tr><td>${esc(w.year)}</td><td>${w.draftId ? `<a href="#/d/${esc(w.draftId)}/leaderboard">${esc(w.tournament)}</a>` : esc(w.tournament)}</td><td><b>${esc(w.winner || '')}</b></td><td class="c">${esc(w.winnerDraftPos ?? '-')}</td><td>${esc(w.runnerUp || '-')}</td><td class="c">${esc(w.runnerUpDraftPos ?? '-')}</td><td>${esc(w.sideBet || '-')}</td></tr>`).join('')}
    </tbody></table></div></div>
    ${archived.length ? `<h2 style="margin-top:24px">Tournaments in the app</h2><div class="card"><div class="table-wrap"><table><tbody>${archived.map((d) => `<tr><td><a href="#/d/${esc(d.id)}/leaderboard">${esc(d.name)}</a></td><td class="num"><a class="btn sm" href="#/d/${esc(d.id)}/draft">Draft board</a></td></tr>`).join('')}</tbody></table></div></div>` : ''}`;
}
 
// ---------- admin ----------
function renderLogin() {
  app.innerHTML = `<div class="card pad" style="max-width:380px;margin:40px auto">
    <h2>Admin login</h2>
    <form id="login" class="stack"><label class="field">Password<input type="password" name="pw" autocomplete="current-password" required /></label><button class="btn primary">Log in</button></form></div>`;
  $('#login').onsubmit = (e) => {
    e.preventDefault();
    guard(async () => {
      const { token } = await api('POST', '/admin/login', { password: e.target.pw.value });
      store.set('adminToken', token);
      route();
    });
  };
}
 
async function renderAdminHome() {
  await loadIndex();
  app.innerHTML = `<div class="hero"><div><h1>Admin</h1></div><div class="row"><a class="btn" href="#/admin/winners">Edit past winners</a><a class="btn primary" href="#/admin/new">Create a new draft</a><button class="btn sm" id="logout">Log out</button></div></div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>Tournament</th><th>Status</th><th></th><th></th></tr></thead><tbody>
    ${index.drafts.map((d) => `<tr><td><b>${esc(d.name)}</b>${d.id === index.currentId ? ' <span class="pill good">Home page</span>' : ''}</td><td>${statusLabel[d.status]}</td>
      <td class="num">${d.id === index.currentId ? '' : `<button class="btn sm" data-current="${esc(d.id)}">Show on home page</button>`}</td>
      <td class="num"><a class="btn sm primary" href="#/admin/${esc(d.id)}">Manage</a></td></tr>`).join('') || '<tr><td class="muted">No drafts yet.</td></tr>'}
    </tbody></table></div></div>`;
  $('#logout').onclick = () => { store.del('adminToken'); route(); };
  $$('[data-current]').forEach((b) => (b.onclick = () => guard(async () => { await api('POST', '/admin/current', { id: b.dataset.current }); renderAdminHome(); })));
}
 
function managerRows(list) {
  return list.map((m, i) => `<div class="mgr-row" data-i="${i}">
    <input name="mname" placeholder="Manager ${i + 1}" value="${esc(m.name || '')}" />
    <input name="mpin" placeholder="${m.hasPin ? 'PIN set' : 'PIN'}" inputmode="numeric" maxlength="8" value="" />
    <button type="button" class="btn sm danger" data-rm="${i}" title="Remove">&times;</button></div>`).join('');
}
 
async function renderCreate() {
  const meta = await api('GET', '/meta');
  const year = new Date().getFullYear();
  let managers = Array.from({ length: 8 }, () => ({ name: '' }));
  const lastDraft = index.drafts[0] ? await api('GET', `/draft/${index.drafts[0].id}`).catch(() => null) : null;
  if (lastDraft) managers = lastDraft.managers.map((m) => ({ name: m.name }));
  app.innerHTML = `<div class="hero"><div><h1>Create a new draft</h1><p class="muted">${lastDraft ? `Managers are copied from ${esc(lastDraft.name)}. Set new PINs or leave them blank.` : ''}</p></div></div>
  <form id="create" class="admin-grid">
    <section class="card pad stack"><h2>Tournament</h2>
      <div class="grid-form">
        <label class="field">Year<input name="year" type="number" value="${year}" /></label>
        <label class="field">Tournament<select name="major">${meta.majors.map((m) => `<option>${esc(m)}</option>`).join('')}</select></label>
      </div>
      <label class="field">Display name (optional)<input name="name" placeholder="e.g. ${year} The Masters" /></label>
      <label class="field">ESPN leaderboard link<input name="eventInput" placeholder="https://www.espn.com/golf/leaderboard/_/tournamentId/..." /></label>
      <div class="row"><button type="button" class="btn sm" id="testLink">Test link</button><span class="small muted" id="testOut"></span></div>
      <p class="tiny muted">Open the tournament on espn.com/golf/leaderboard, then copy the address from your browser. You can add this later.</p>
    </section>
    <section class="card pad stack"><h2>Money</h2>
      <label class="field">Entry fee<input name="entryFee" value="$30" /></label>
      ${meta.defaults.payouts.map((p, i) => `<div class="grid-form"><label class="field">Place<input name="place${i}" value="${esc(p.place)}" /></label><label class="field">Prize<input name="prize${i}" value="${esc(p.prize)}" /></label></div>`).join('')}
      <div class="grid-form"><label class="field">Side bet entry<input name="sbEntry" placeholder="$10" /></label><label class="field">Side bet payout<input name="sbPayout" placeholder="$80" /></label></div>
    </section>
    <section class="card pad stack"><h2>Managers</h2>
      <p class="tiny muted">Each manager uses their PIN to make picks. 6 to 9 is typical.</p>
      <div id="mgrs" class="stack"></div>
      <button type="button" class="btn sm" id="addMgr">Add manager</button>
    </section>
    <section class="card pad stack"><h2>Format</h2>
      <div class="grid-form">
        <label class="field">Rounds drafted<input name="rounds" type="number" min="2" max="15" value="10" /></label>
        <label class="field">Golfers who play<input name="starters" type="number" min="1" value="8" /></label>
        <label class="field">Scores that count<input name="counting" type="number" min="1" value="6" /></label>
        <label class="field">Missed round score<input name="penalty" type="number" value="80" /></label>
        <label class="field">Course par (auto if blank)<input name="par" type="number" placeholder="auto" /></label>
      </div>
      <button class="btn primary" style="justify-content:center">Create draft</button>
    </section>
  </form>`;
  const drawM = () => {
    $('#mgrs').innerHTML = managerRows(managers);
    $$('[data-rm]').forEach((b) => (b.onclick = () => { syncM(); managers.splice(Number(b.dataset.rm), 1); drawM(); }));
  };
  const syncM = () => { managers = $$('.mgr-row').map((r) => ({ name: $('[name=mname]', r).value, pin: $('[name=mpin]', r).value })); };
  drawM();
  $('#addMgr').onclick = () => { syncM(); managers.push({ name: '' }); drawM(); };
  $('#testLink').onclick = () => guard(async () => {
    $('#testOut').textContent = 'Checking...';
    const r = await api('GET', `/admin/espn-test?event=${encodeURIComponent($('[name=eventInput]').value)}`).catch((e) => ({ error: e.message }));
    $('#testOut').textContent = r.error ? r.error : `Found "${r.event.name}" with ${r.golferCount} golfers (${r.event.state === 'pre' ? 'not started' : r.event.state === 'in' ? 'in progress' : 'finished'}).`;
  });
  $('#create').onsubmit = (e) => {
    e.preventDefault();
    syncM();
    const f = e.target;
    guard(async () => {
      const d = await api('POST', '/admin/drafts', {
        year: f.year.value, major: f.major.value, name: f.name.value || `${f.year.value} ${f.major.value}`, eventInput: f.eventInput.value,
        entryFee: f.entryFee.value, payouts: [0, 1, 2].map((i) => ({ place: f[`place${i}`].value, prize: f[`prize${i}`].value })),
        sideBet: { entry: f.sbEntry.value, payout: f.sbPayout.value },
        settings: { rounds: f.rounds.value, starters: f.starters.value, counting: f.counting.value, penalty: f.penalty.value, par: f.par.value },
        managers: managers.filter((m) => m.name.trim()),
      });
      toast('Draft created');
      await loadIndex();
      go(`#/admin/${d.id}`);
    });
  };
}
 
async function renderManage(id) {
  let d = await api('GET', `/admin/draft/${id}`);
  const refresh = async () => { d = await api('GET', `/admin/draft/${id}`); draw(); };
  const act = (path, body, msg) => guard(async () => { d = await api('POST', `/admin/draft/${id}/${path}`, body); if (msg) toast(msg); draw(); });
 
  function draw() {
    const locked = d.picks.length > 0;
    const pickedNames = [...new Set(d.picks.map((p) => p.name))].sort();
    const ov = d.overrides || {};
    const noSalary = d.field.filter((f) => !f.salary);
    const pairSelect = (item, pool) => {
      const sugg = item.suggestions || [];
      const rest = pool.filter((f) => !sugg.some((x) => x.key === f.key)).sort((x, y) => x.name.localeCompare(y.name));
      return `<select class="pairSel"><option value="">Choose golfer...</option>${sugg.length ? `<optgroup label="Closest matches">${sugg.map((x) => `<option value="${esc(x.key)}">${esc(x.name)}</option>`).join('')}</optgroup>` : ''}<optgroup label="Everyone else">${rest.map((x) => `<option value="${esc(x.key)}">${esc(x.name)}</option>`).join('')}</optgroup></select>`;
    };
    const unmatched = d.dkStatus?.unmatched || [];
    const unmatchedHtml = unmatched.length && d.fieldSource !== 'dk'
      ? `<div class="pair-box"><div class="small"><b>${unmatched.length} DraftKings name${unmatched.length === 1 ? '' : 's'} didn't match.</b> Pick the golfer for each, or mark as not in the field. Pairings are remembered for future tournaments.</div>
        ${unmatched.map((u) => `<div class="pair-row" data-from="${esc(u.name)}"><div><b>${esc(u.name)}</b> <span class="muted tiny">${fmtSalary(u.salary)}</span></div>${pairSelect(u, noSalary)}<div class="row" style="gap:6px"><button class="btn sm primary" data-act="pair">Pair</button><button class="btn sm" data-act="ignore">Not in field</button></div></div>`).join('')}</div>`
      : '';
    const autos = d.field.filter((f) => f.dkName);
    const autoHtml = autos.length
      ? `<details><summary class="small">${autos.length} name${autos.length === 1 ? ' was' : 's were'} matched automatically. Check ${autos.length === 1 ? 'it' : 'them'}</summary><div class="table-wrap"><table class="small"><thead><tr><th>DraftKings</th><th>ESPN</th><th class="num">Salary</th></tr></thead><tbody>${autos.map((f) => `<tr><td>${esc(f.dkName)}</td><td>${esc(f.name)}</td><td class="num">${fmtSalary(f.salary)}</td></tr>`).join('')}</tbody></table></div></details>`
      : '';
    const issues = d.linkIssues || [];
    const espnPool = d.field.filter((f) => f.espnId && !d.picks.some((p) => p.key === f.key));
    const linkHtml = issues.length
      ? `<div class="pair-box bad"><div class="small"><b>${issues.length} drafted golfer${issues.length === 1 ? '' : 's'} not found on ESPN.</b> They won't score until paired.</div>
        ${issues.map((u) => `<div class="pair-row" data-from="${esc(u.name)}"><div><b>${esc(u.name)}</b> <span class="muted tiny">pick #${u.n}</span></div>${pairSelect(u, espnPool)}<div class="row" style="gap:6px"><button class="btn sm primary" data-act="pair">Pair</button></div></div>`).join('')}</div>`
      : '';
    const fieldWarning = (d.status === 'drafting' || d.status === 'live') && d.fieldSource !== 'espn'
      ? `<div class="notice bad">Scores come from ESPN, and this draft isn't linked yet. Add the ESPN link and click <b>Link to ESPN</b> before the first tee time.</div>`
      : '';
    app.innerHTML = `<div class="hero"><div><h1>${esc(d.name)}</h1><div class="meta"><span class="pill ${d.status === 'drafting' ? 'live' : ''}">${statusLabel[d.status]}</span><span class="pill">${d.picks.length}/${d.totalPicks} picks</span><span class="pill">${d.field.length} golfers in field</span></div></div>
      <div class="row"><a class="btn" href="#/d/${esc(id)}/draft">Draft room</a><a class="btn" href="#/d/${esc(id)}/leaderboard">Leaderboard</a><a class="btn sm" href="#/admin">All drafts</a></div></div>
 
    <div class="admin-grid">
      <section class="card pad stack"><h2>1. Steps</h2>
        <ol class="small" style="padding-left:1.2em;margin:0">
          <li>Managers and PINs look right</li><li>Set the draft order</li><li>Load the field once ESPN posts it (usually early tournament week)</li><li>Start the draft</li><li>After Sunday, finalize the tournament</li></ol>
        <div class="row">
          ${d.status === 'setup' ? `<button class="btn primary" id="start">Start draft</button>` : ''}
          ${d.status === 'drafting' ? `<button class="btn" id="pause">Pause (back to setup)</button><button class="btn" id="undo" ${d.picks.length ? '' : 'disabled'}>Undo last pick</button>` : ''}
          ${d.status === 'live' ? `<button class="btn" id="reopen">Reopen draft</button>` : ''}
          ${d.status === 'final' ? `<button class="btn" id="unfinal">Reopen tournament</button>` : ''}
        </div>
        ${d.status === 'live' || d.status === 'final' ? `<div class="stack"><h3>Finalize</h3><p class="small muted">Freezes the final scores and records the winner, runner-up, and side bet on Past Winners. Do this after the final round is official.</p>
          <label class="field">Side bet winner<select id="sbw"><option value="">Automatic (use the leader)</option>${d.managers.map((m) => `<option ${d.final?.sideBetWinner === m.name ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
          <button class="btn accent" id="finalize">${d.status === 'final' ? 'Re-finalize with latest scores' : 'Finalize tournament'}</button></div>` : ''}
        <button class="btn sm danger" id="del">Delete this draft</button>
      </section>
 
      <section class="card pad stack"><h2>2. Managers and PINs</h2>
        <p class="tiny muted">Leave PIN blank to keep the current one.${locked ? ' Managers cannot be added or removed after picks are made.' : ''}</p>
        <div id="mgrs" class="stack">${managerRows(d.managers)}</div>
        <div class="row">${locked ? '' : '<button class="btn sm" id="addMgr">Add manager</button>'}<button class="btn sm primary" id="saveMgrs">Save managers</button></div>
      </section>
 
      <section class="card pad stack"><h2>3. Draft order</h2>
        <ul class="order-list">${d.order.map((mid, i) => `<li><span class="n">${i + 1}</span><span class="grow">${esc(mgrName(d, mid))}</span>${locked ? '' : `<button class="btn sm" data-up="${i}" ${i ? '' : 'disabled'}>&uarr;</button><button class="btn sm" data-down="${i}" ${i < d.order.length - 1 ? '' : 'disabled'}>&darr;</button>`}</li>`).join('')}</ul>
        ${locked ? '<p class="tiny muted">Locked because picks have been made.</p>' : '<button class="btn primary" id="rand">Randomize order</button>'}
      </section>
 
      <section class="card pad stack field-card"><h2>4. Field</h2>
        ${fieldWarning}
        <div class="src-grid">
          <div class="src ${d.sources?.espn ? 'on' : ''}"><b>ESPN</b><span>${d.sources?.espn ? `${d.sources.espn} golfers` : 'Not loaded'}</span></div>
          <div class="src ${d.dkStatus ? 'on' : ''}"><b>DraftKings</b><span>${d.dkStatus ? `${d.dkStatus.matched} of ${d.dkStatus.total} matched${d.dkStatus.ignoredCount ? `, ${d.dkStatus.ignoredCount} not in field` : ''}` : 'No file'}</span></div>
          <div class="src ${d.sources?.paste ? 'on' : ''}"><b>Pasted</b><span>${d.sources?.paste ? `${d.sources.paste} names` : 'None'}</span></div>
        </div>
        <p class="tiny muted">Draft list: ${d.field.length} golfers from ${({ espn: 'ESPN', dk: 'DraftKings', paste: 'pasted names', none: 'nothing yet' })[d.fieldSource || (d.field.length ? 'espn' : 'none')]}${d.dkStatus ? ', sorted by DraftKings salary' : ''}. Scores always come from ESPN.</p>
 
        <h3>ESPN (field, tee times, scoring)</h3>
        <label class="field">ESPN leaderboard link or tournament ID<input id="eventInput" value="${esc(d.eventInput || '')}" placeholder="https://www.espn.com/golf/leaderboard/_/tournamentId/..." /></label>
        <div class="row"><button class="btn sm" id="saveLink">Save link</button><button class="btn primary sm" id="loadEspn">${d.fieldSource === 'dk' || d.fieldSource === 'paste' ? 'Link to ESPN' : d.sources?.espn ? 'Refresh from ESPN' : 'Load field from ESPN'}</button></div>
 
        <h3>DraftKings salaries (sort order)</h3>
        ${d.dkStatus ? `<div class="row small"><span class="grow">${esc(d.dkStatus.fileName)} <span class="muted">uploaded ${new Date(d.dkStatus.uploadedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span></span><button class="btn sm danger" id="dkClear">Remove</button></div>` : ''}
        <label class="btn sm ${d.dkStatus ? '' : 'primary'} file-btn">${d.dkStatus ? 'Upload a new file' : 'Upload DraftKings salary CSV'}<input type="file" id="dkFile" accept=".csv,text/csv" hidden /></label>
        <label class="row small" style="gap:8px"><input type="checkbox" id="showSal" ${d.showSalaries !== false ? 'checked' : ''} /> Show salaries in the Draft Room</label>
        <p class="tiny muted">On DraftKings, open a golf contest for this tournament and choose Export to CSV (DKSalaries.csv).</p>
        ${unmatchedHtml}
        ${autoHtml}
        ${linkHtml}
 
        <details><summary class="small">Paste names instead (one per line)</summary>
          <textarea id="names" rows="6" style="width:100%;margin-top:8px" placeholder="Scottie Scheffler&#10;Rory McIlroy"></textarea>
          <div class="row"><button class="btn sm" id="pasteReplace">Replace pasted list</button><button class="btn sm" id="pasteAppend">Add to pasted list</button>${d.sources?.paste ? '<button class="btn sm danger" id="pasteClear">Clear pasted list</button>' : ''}</div>
          <p class="tiny muted">A pasted list is only used when there's no ESPN field.</p></details>
        <details id="aliasBox"><summary class="small">Saved name pairings</summary><div id="aliasList" class="small muted" style="margin-top:8px">Loading...</div></details>
        <p class="tiny muted">${d.fieldLoadedAt ? `Last changed ${new Date(d.fieldLoadedAt).toLocaleString()}.` : ''} Drafted golfers are always kept.</p>
      </section>
 
      <section class="card pad stack"><h2>Fix a golfer's score</h2>
        <p class="tiny muted">Only needed if ESPN is wrong or late. Example: a withdrawal before the first tee shot that ESPN hasn't posted yet.</p>
        <form id="ovForm" class="stack">
          <label class="field">Golfer<select name="name">${pickedNames.map((n) => `<option>${esc(n)}</option>`).join('')}</select></label>
          <div class="grid-form"><label class="field">Status<select name="status"><option value="">Use ESPN</option><option value="active">Active</option><option value="cut">CUT</option><option value="wd">WD</option><option value="dq">DQ</option></select></label>
          <label class="field">Teed off?<select name="started"><option value="">Use ESPN</option><option value="false">No (subs allowed)</option><option value="true">Yes</option></select></label></div>
          <div class="grid-form">${[1, 2, 3, 4].map((r) => `<label class="field">R${r}<input name="r${r}" type="number" placeholder="ESPN" /></label>`).join('')}</div>
          <div class="row"><button class="btn primary sm">Save fix</button></div>
        </form>
        ${Object.keys(ov).length ? `<div class="table-wrap"><table><tbody>${Object.entries(ov).map(([k, o]) => { const nm = d.picks.find((p) => p.key === k)?.name || k; return `<tr><td>${esc(nm)}</td><td class="small">${[o.status && o.status.toUpperCase(), o.started === false ? 'not started' : o.started ? 'started' : '', (o.rounds || []).some((x) => x) ? `rounds ${(o.rounds || []).map((x) => x || '-').join('/')}` : ''].filter(Boolean).join(', ')}</td><td class="num"><button class="btn sm" data-clear="${esc(nm)}">Clear</button></td></tr>`; }).join('')}</tbody></table></div>` : ''}
      </section>
 
      <section class="card pad stack"><h2>Details</h2>
        <form id="details" class="stack">
          <div class="grid-form"><label class="field">Name<input name="name" value="${esc(d.name)}" /></label><label class="field">Year<input name="year" type="number" value="${esc(d.year)}" /></label><label class="field">Entry fee<input name="entryFee" value="${esc(d.entryFee || '')}" /></label></div>
          ${(d.payouts || []).map((p, i) => `<div class="grid-form"><label class="field">Place<input name="place${i}" value="${esc(p.place)}" /></label><label class="field">Prize<input name="prize${i}" value="${esc(p.prize)}" /></label></div>`).join('')}
          <div class="grid-form"><label class="field">Side bet entry<input name="sbEntry" value="${esc(d.sideBet?.entry || '')}" /></label><label class="field">Side bet payout<input name="sbPayout" value="${esc(d.sideBet?.payout || '')}" /></label></div>
          <div class="grid-form"><label class="field">Golfers who play<input name="starters" type="number" value="${d.settings.starters}" /></label><label class="field">Scores that count<input name="counting" type="number" value="${d.settings.counting}" /></label><label class="field">Missed round score<input name="penalty" type="number" value="${d.settings.penalty}" /></label><label class="field">Par<input name="par" type="number" value="${d.settings.par || ''}" placeholder="auto" /></label></div>
          <button class="btn sm primary">Save details</button>
        </form>
      </section>
    </div>`;
    bind();
  }
 
  function bind() {
    const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
    on('#start', () => act('status', { status: 'drafting' }, 'Draft is open'));
    on('#pause', () => act('status', { status: 'setup' }, 'Draft paused'));
    on('#reopen', () => act('status', { status: 'drafting' }, 'Draft reopened'));
    on('#unfinal', () => act('status', { status: 'live' }, 'Tournament reopened'));
    on('#undo', async () => { if (await confirmBox('Undo last pick?', 'The most recent pick will be removed.', 'Undo')) act('undo', {}, 'Pick removed'); });
    on('#finalize', async () => { if (await confirmBox('Finalize tournament?', 'This freezes the scores and updates Past Winners.', 'Finalize')) act('finalize', { sideBetWinner: $('#sbw').value || null }, 'Tournament finalized'); });
    on('#del', async () => {
      if (!(await confirmBox('Delete this draft?', 'This cannot be undone.', 'Delete'))) return;
      guard(async () => { await api('DELETE', `/admin/draft/${id}`); await loadIndex(); go('#/admin'); });
    });
    on('#rand', () => act('order', { randomize: true }, 'Order randomized'));
    $$('[data-up],[data-down]').forEach((b) => (b.onclick = () => {
      const i = Number(b.dataset.up ?? b.dataset.down);
      const j = b.dataset.up !== undefined ? i - 1 : i + 1;
      const o = [...d.order];
      [o[i], o[j]] = [o[j], o[i]];
      act('order', { order: o });
    }));
    const collect = () => $$('.mgr-row').map((r, i) => ({ id: d.managers[i]?.id, name: $('[name=mname]', r).value, pin: $('[name=mpin]', r).value }));
    on('#addMgr', () => {
      const n = $$('.mgr-row').length;
      $('#mgrs').insertAdjacentHTML('beforeend', managerRows([{ name: '' }]).replace('data-i="0"', `data-i="${n}"`).replace('Manager 1', `Manager ${n + 1}`).replace(/data-rm="0"[^>]*>&times;/, 'disabled>&times;'));
      $$('.mgr-row input[name=mname]').pop().focus();
    });
    $$('[data-rm]').forEach((b) => (b.onclick = () => { const cur = collect(); cur.splice(Number(b.dataset.rm), 1); act('managers', { managers: cur }, 'Manager removed'); }));
    on('#saveMgrs', () => act('managers', { managers: collect() }, 'Managers saved'));
    on('#saveLink', () => act('settings', { eventInput: $('#eventInput').value }, 'Link saved'));
    on('#loadEspn', () => guard(async () => {
      await api('POST', `/admin/draft/${id}/settings`, { eventInput: $('#eventInput').value });
      d = await api('POST', `/admin/draft/${id}/field`, { source: 'espn' });
      toast(`ESPN field loaded: ${d.sources?.espn || d.field.length} golfers`);
      draw();
    }));
    on('#pasteReplace', () => act('field', { source: 'paste', names: $('#names').value, mode: 'replace' }, 'Pasted list saved'));
    on('#pasteAppend', () => act('field', { source: 'paste', names: $('#names').value, mode: 'append' }, 'Golfers added'));
    on('#pasteClear', () => act('field', { source: 'clear-paste' }, 'Pasted list cleared'));
    on('#dkClear', async () => { if (await confirmBox('Remove DraftKings file?', 'Salaries and salary sorting will be removed from this draft. Saved name pairings are kept.', 'Remove')) act('dk-clear', {}, 'DraftKings file removed'); });
    const dkFile = $('#dkFile');
    if (dkFile) dkFile.onchange = () => guard(async () => {
      const file = dkFile.files[0];
      if (!file) return;
      if (file.size > 2_000_000) throw new Error('That file is too large to be a DraftKings salary export.');
      const csv = await file.text();
      d = await api('POST', `/admin/draft/${id}/dk`, { csv, fileName: file.name });
      const u = d.dkStatus?.unmatched?.length || 0;
      toast(`${d.dkStatus.matched} golfers matched${u && d.fieldSource !== 'dk' ? `, ${u} need a look` : ''}`, 4000);
      draw();
    });
    const showSal = $('#showSal');
    if (showSal) showSal.onchange = () => act('settings', { showSalaries: showSal.checked }, showSal.checked ? 'Salaries shown' : 'Salaries hidden');
    $$('.pair-row').forEach((row) => $$('button[data-act]', row).forEach((b) => (b.onclick = () => {
      const fromName = row.dataset.from;
      if (b.dataset.act === 'ignore') return act('pair', { fromName, ignore: true }, `${fromName} marked not in field`);
      const toKey = $('.pairSel', row).value;
      if (!toKey) return toast('Choose a golfer first');
      act('pair', { fromName, toKey }, 'Paired and saved');
    })));
    const aliasBox = $('#aliasBox');
    if (aliasBox) aliasBox.ontoggle = () => { if (aliasBox.open) loadAliases(); };
    async function loadAliases() {
      const { aliases } = await api('GET', '/admin/aliases').catch(() => ({ aliases: {} }));
      const entries = Object.entries(aliases);
      const nameFor = (k) => d.field.find((f) => f.key === k)?.name || k;
      $('#aliasList').innerHTML = entries.length
        ? entries.map(([from, to]) => `<div class="row between" style="padding:4px 0;border-bottom:1px solid var(--line)"><span>${esc(from)} &rarr; ${esc(nameFor(to))}</span><button class="btn sm danger" data-alias="${esc(from)}">Forget</button></div>`).join('')
        : 'No saved pairings yet.';
      $$('[data-alias]').forEach((b) => (b.onclick = () => guard(async () => {
        await api('DELETE', `/admin/aliases?name=${encodeURIComponent(b.dataset.alias)}`);
        d = await api('POST', `/admin/draft/${id}/rebuild`);
        draw();
        $('#aliasBox').open = true;
        loadAliases();
      })));
    }
    $('#ovForm').onsubmit = (e) => {
      e.preventDefault();
      const f = e.target;
      act('override', { name: f.name.value, status: f.status.value || null, started: f.started.value === '' ? undefined : f.started.value === 'true', rounds: [1, 2, 3, 4].map((r) => f[`r${r}`].value || null) }, 'Fix saved');
    };
    $$('[data-clear]').forEach((b) => (b.onclick = () => act('override', { name: b.dataset.clear, clear: true }, 'Fix cleared')));
    $('#details').onsubmit = (e) => {
      e.preventDefault();
      const f = e.target;
      act('settings', {
        name: f.name.value, year: f.year.value, entryFee: f.entryFee.value,
        payouts: (d.payouts || []).map((_, i) => ({ place: f[`place${i}`].value, prize: f[`prize${i}`].value })),
        sideBet: { entry: f.sbEntry.value, payout: f.sbPayout.value },
        settings: { rounds: d.settings.rounds, starters: f.starters.value, counting: f.counting.value, penalty: f.penalty.value, par: f.par.value },
      }, 'Details saved');
    };
  }
  draw();
  loadIndex();
}
 
async function renderWinnersEditor() {
  let { winners } = await api('GET', '/history');
  const cols = [['year', 'Year', 70], ['tournament', 'Tournament', 160], ['winner', 'Winner', 110], ['winnerDraftPos', 'Pos', 60], ['runnerUp', 'Runner-up', 110], ['runnerUpDraftPos', 'Pos', 60], ['sideBet', 'Side bet', 110]];
  const draw = () => {
    app.innerHTML = `<div class="hero"><div><h1>Edit past winners</h1></div><div class="row"><button class="btn" id="add">Add row</button><button class="btn primary" id="save">Save</button></div></div>
      <div class="card"><div class="table-wrap"><table><thead><tr>${cols.map((c) => `<th>${c[1]}</th>`).join('')}<th></th></tr></thead><tbody>
      ${winners.map((w, i) => `<tr data-i="${i}">${cols.map(([k, , wd]) => `<td><input data-k="${k}" value="${esc(w[k] ?? '')}" style="width:${wd}px" /></td>`).join('')}<td><button class="btn sm danger" data-del="${i}">&times;</button></td></tr>`).join('')}
      </tbody></table></div></div>`;
    const sync = () => { winners = $$('tbody tr').map((tr, i) => { const o = { ...winners[i] }; $$('input', tr).forEach((inp) => { const v = inp.value.trim(); o[inp.dataset.k] = v === '' ? null : inp.dataset.k === 'year' ? Number(v) : v; }); return o; }); };
    $('#add').onclick = () => { sync(); winners.push({ year: new Date().getFullYear() }); draw(); };
    $$('[data-del]').forEach((b) => (b.onclick = () => { sync(); winners.splice(Number(b.dataset.del), 1); draw(); }));
    $('#save').onclick = () => guard(async () => { sync(); await api('PUT', '/admin/winners', { winners }); toast('Saved'); });
  };
  draw();
}
 
route();

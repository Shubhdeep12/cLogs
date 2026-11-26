'use strict';
/* global bridge */

// ---------- helpers ----------
const $ = (s) => document.querySelector(s);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const fmtMs = (n) => (n == null ? '' : n < 1000 ? `${Math.round(n)} ms` : n < 60000 ? `${(n / 1000).toFixed(n < 10000 ? 2 : 1)} s` : `${Math.floor(n / 60000)}m ${Math.round((n % 60000) / 1000)}s`);
const fmtTok = (n) => (n == null ? '' : n < 1000 ? String(n) : n < 1e6 ? `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k` : `${(n / 1e6).toFixed(2)}M`);
const fmtBytes = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const fmtClock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '');
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString() : '');
function ago(iso) {
  const d = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(d)) return '';
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}
const basename = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || p;
const KIND_LABEL = { api: 'Anthropic API', web: 'Web', mcp: 'MCP', shell: 'Shell HTTP', server: 'Server tool', other: 'Other' };

async function copy(text) {
  try { await navigator.clipboard.writeText(text); return; } catch { /* fall back */ }
  const ta = h('textarea'); ta.value = text; document.body.append(ta); ta.select();
  document.execCommand('copy'); ta.remove();
}
function flash(btn, label = 'Copied') {
  const old = btn.textContent; btn.textContent = label; setTimeout(() => { btn.textContent = old; }, 1100);
}
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};

// ---------- state ----------
const S = {
  rec: { recording: false, windows: [], roots: [], sessions: [], imports: [] },
  sessionQuery: '',
  account: null,
  key: null,
  info: null,
  calls: [],
  sel: null,
  detail: null,
  tab: store.get('tab', 'headers'),
  payloadView: 'tree',
  kinds: new Set(),
  source: 'all',
  q: '',
  errorsOnly: false,
  follow: true,
  openToken: 0,
};

// ---------- sidebar ----------
function renderRecStatus() {
  const r = S.rec;
  const btn = $('#btn-rec');
  btn.classList.toggle('on', r.recording);
  btn.querySelector('.rec-label').textContent = r.recording ? 'Stop' : 'Record';
  const total = r.sessions.reduce((a, s) => a + s.count, 0);
  const parts = [
    r.recording ? h('span', { class: 'rec-live' }, '● Recording') : h('span', null, r.windows.length ? 'Stopped' : 'Not recording'),
    h('span', null, `${total} request${total === 1 ? '' : 's'} · ${r.sessions.length} session${r.sessions.length === 1 ? '' : 's'}`),
  ];
  $('#rec-status').replaceChildren(...parts);
  $('#btn-export').disabled = total === 0;
}

const accountLabel = (root) => basename(root || '');

function sessItem(s, live) {
  return h('button', { class: `sess${S.key === s.key ? ' sel' : ''}`, title: `${s.title}${s.cwd ? `\n${s.cwd}` : ''}`, onclick: () => openView(s.key) },
    live ? h('span', { class: 'live', title: 'Active in the last minute' }) : null,
    h('div', { class: 'sess-title' }, s.title),
    h('div', { class: 'sess-meta' },
      s.root && S.rec.roots.length > 1 ? h('span', { class: 'badge acct', title: s.root }, accountLabel(s.root)) : null,
      s.cwd ? h('span', null, basename(s.cwd)) : null,
      h('span', null, `${s.count} request${s.count === 1 ? '' : 's'}`),
      s.errors ? h('span', { class: 'st-error' }, `${s.errors} error${s.errors === 1 ? '' : 's'}`) : null,
      s.lastMs ? h('span', null, ago(new Date(s.lastMs).toISOString())) : null));
}

function renderSessions() {
  renderRecStatus();
  const q = S.sessionQuery.toLowerCase();
  const match = (s) => !q || `${s.title} ${s.cwd || ''} ${s.sessionId || ''}`.toLowerCase().includes(q);
  const frag = document.createDocumentFragment();
  const roots = S.rec.roots || [];
  if (S.account && !roots.includes(S.account)) S.account = null;
  const af = $('#account-filter');
  af.replaceChildren();
  if (roots.length > 1) {
    const count = (r) => S.rec.sessions.filter((s) => !r || s.root === r).length;
    af.append(h('button', { class: `chip${!S.account ? ' on' : ''}`, onclick: () => { S.account = null; renderSessions(); } }, 'All accounts', h('span', { class: 'n' }, count(null))));
    for (const r of roots) {
      af.append(h('button', { class: `chip${S.account === r ? ' on' : ''}`, title: r, onclick: () => { S.account = r; renderSessions(); } }, accountLabel(r), h('span', { class: 'n' }, count(r))));
    }
  }
  const rec = S.rec.sessions.filter((s) => match(s) && (!S.account || s.root === S.account));
  frag.append(h('div', { class: 'side-sec' }, 'Recorded'));
  if (!rec.length) {
    frag.append(h('div', { class: 'side-empty' }, S.rec.recording
      ? 'Waiting for Claude Code. Use it in any terminal and each chat appears here when it makes a request.'
      : 'Press Record to capture what Claude Code sends from now on.'));
  }
  for (const s of rec) frag.append(sessItem(s, S.rec.recording && Date.now() - s.lastMs < 60000));
  for (const imp of S.rec.imports) {
    frag.append(h('div', { class: 'side-sec' }, h('span', { title: imp.name }, `Imported · ${imp.name}`),
      h('button', { class: 'x-btn', title: 'Remove this import', onclick: async () => { const st = await bridge.removeImport(imp.id); applyState(st); } }, '×')));
    for (const s of imp.sessions.filter(match)) frag.append(sessItem(s, false));
  }
  $('#session-list').replaceChildren(frag);
  $('#side-foot').textContent = `Watching ${roots.map(accountLabel).join(', ') || 'no config folders'}`;
  renderEmpty();
}

function renderEmpty() {
  if (S.key) return;
  $('#empty').hidden = false;
  $('#session-view').hidden = true;
  const rec = S.rec.recording;
  const any = S.rec.sessions.length > 0 || S.rec.imports.length > 0;
  const [title, line] = any ? ['Select a chat', 'Its requests open here.']
    : rec ? ['Waiting for requests', 'Use Claude Code as usual. Chats appear on the left.']
    : ['Not recording', 'Press Record to start, or import a HAR file.'];
  $('#empty-art').classList.toggle('live', rec);
  $('#empty-title').textContent = title;
  $('#empty-line').textContent = line;
}

function applyState(st) {
  if (!st) return;
  S.rec = st;
  const known = S.key && (st.sessions.some((s) => s.key === S.key) || st.imports.some((i) => i.sessions.some((s) => s.key === S.key)));
  if (S.key && !known) closeView();
  renderSessions();
}

function closeView() {
  S.key = null; S.info = null; S.calls = []; S.sel = null; S.detail = null;
  bridge.closeView();
  hideDetail();
  renderEmpty();
}

// ---------- session ----------
async function openView(key) {
  const token = ++S.openToken;
  S.key = key; S.sel = null; S.detail = null;
  renderSessions();
  $('#empty').hidden = true;
  $('#session-view').hidden = false;
  $('#session-head').replaceChildren(h('div', { class: 'sh-title' }, 'Loading…'));
  $('#calls tbody').replaceChildren();
  hideDetail();
  const r = await bridge.openView(key);
  if (token !== S.openToken) return;
  if (!r) { closeView(); return; }
  S.info = r.info; S.calls = r.calls;
  renderHead(); renderSourceSelect(); renderKindChips(); renderTable(true);
}

function renderHead() {
  const i = S.info;
  const live = !i.imported && S.rec.recording && S.calls.length && Date.now() - S.calls[S.calls.length - 1].startMs < 60000;
  $('#session-head').replaceChildren(
    h('div', { class: 'sh-row' },
      h('div', { class: 'sh-title', title: i.title }, i.title),
      h('button', { class: 'btn', onclick: () => bridge.exportHar(S.key) }, 'Export HAR')),
    h('div', { class: 'sh-meta' },
      live ? h('span', { class: 'live-pill' }, '● live') : null,
      i.imported ? h('span', { class: 'badge' }, `imported from ${i.imported}`) : null,
      i.root ? h('span', { class: 'badge acct', title: i.root }, `account ${accountLabel(i.root)}`) : null,
      i.cwd ? h('span', { title: i.cwd }, i.cwd) : null,
      i.gitBranch ? h('span', null, `⎇ ${i.gitBranch}`) : null,
      i.version ? h('span', null, `Claude Code ${i.version}`) : null,
      i.sessionId ? h('span', { title: i.sessionId }, `session ${String(i.sessionId).slice(0, 8)}`) : null,
      !i.imported ? h('button', { class: 'link-btn', onclick: () => bridge.reveal(S.key) }, 'Show transcript') : null),
  );
}

function renderSourceSelect() {
  const sel = $('#source-select');
  const counts = new Map();
  for (const c of S.calls) counts.set(c.agentKey, (counts.get(c.agentKey) || 0) + 1);
  const agents = new Map((S.info.agents || []).map((a) => [a.key, a]));
  sel.replaceChildren(h('option', { value: 'all' }, `All sources (${S.calls.length})`));
  if (counts.has('main')) sel.append(h('option', { value: 'main' }, `Main thread (${counts.get('main')})`));
  for (const [k, n] of counts) {
    if (k === 'main') continue;
    const a = agents.get(k) || {};
    sel.append(h('option', { value: k }, `${a.type || 'subagent'}${a.description ? `: ${a.description}` : ''} (${n})`));
  }
  if (![...sel.options].some((o) => o.value === S.source)) S.source = 'all';
  sel.value = S.source;
}

function renderKindChips() {
  const el = $('#kind-chips');
  const counts = {};
  for (const c of S.calls) counts[c.kind] = (counts[c.kind] || 0) + 1;
  el.replaceChildren(h('button', { class: `chip${S.kinds.size === 0 ? ' on' : ''}`, onclick: () => { S.kinds.clear(); renderKindChips(); renderTable(); } }, 'All'));
  for (const k of Object.keys(KIND_LABEL)) {
    if (!counts[k]) continue;
    el.append(h('button', {
      class: `chip${S.kinds.has(k) ? ' on' : ''}`,
      onclick: (e) => {
        if (!(e.metaKey || e.ctrlKey)) { const only = S.kinds.size === 1 && S.kinds.has(k); S.kinds.clear(); if (!only) S.kinds.add(k); }
        else if (S.kinds.has(k)) S.kinds.delete(k); else S.kinds.add(k);
        renderKindChips(); renderTable();
      },
    }, KIND_LABEL[k], h('span', { class: 'n' }, counts[k])));
  }
}

function visibleCalls() {
  const q = S.q.toLowerCase();
  return S.calls.filter((c) => (S.kinds.size === 0 || S.kinds.has(c.kind))
    && (S.source === 'all' || c.agentKey === S.source)
    && (!S.errorsOnly || c.statusClass === 'error')
    && (!q || `${c.name} ${c.host} ${c.model || ''} ${c.status} ${c.source} ${c.tool || ''} ${c.requestId || ''} ${c.url || ''}`.toLowerCase().includes(q)));
}

function sourceLabel(c) {
  if (c.agentKey === 'main') return c.querySource && c.querySource !== 'repl_main_thread' ? c.querySource : 'main';
  return c.source;
}

function renderTable(initial = false) {
  const wrap = $('#table-wrap');
  const atBottom = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 24;
  const rows = visibleCalls();
  const tbody = $('#calls tbody');
  $('#no-calls').hidden = rows.length > 0;
  let t0 = Infinity; let t1 = -Infinity;
  for (const c of rows) {
    if (!Number.isFinite(c.startMs)) continue;
    t0 = Math.min(t0, c.startMs);
    t1 = Math.max(t1, c.startMs + (c.durationMs || 0));
  }
  const span = Math.max(1, t1 - t0);
  const frag = document.createDocumentFragment();
  rows.forEach((c, i) => {
    const left = Number.isFinite(c.startMs) ? ((c.startMs - t0) / span) * 100 : 0;
    const width = c.durationMs ? (c.durationMs / span) * 100 : 0.4;
    const bar = h('div', { class: `wf-bar${c.statusClass === 'pending' ? ' pending' : ''}` });
    bar.style.left = `${Math.min(99.6, left)}%`;
    bar.style.width = `${Math.max(0.4, Math.min(100 - left, width))}%`;
    const tok = c.kind === 'api' && c.tokensIn != null ? `${fmtTok(c.tokensIn)} → ${fmtTok(c.tokensOut)}` : c.bytes != null ? fmtBytes(c.bytes) : '';
    const tr = h('tr', { class: `${S.sel === c.id ? 'sel' : ''}${c.statusClass === 'error' ? ' err' : ''}`, 'data-id': c.id, onclick: () => selectCall(c.id) },
      h('td', { class: 'c-n' }, i + 1),
      h('td', { class: 'c-name', title: c.url || c.name }, h('span', { class: 'method' }, c.method), c.name),
      h('td', { class: 'c-host', title: c.host }, c.host),
      h('td', { class: 'c-kind' }, h('span', { class: `kind k-${c.kind}` }, KIND_LABEL[c.kind] || c.kind)),
      h('td', { class: 'c-src', title: c.source }, sourceLabel(c)),
      h('td', { class: 'c-model', title: c.model || '' }, c.model || ''),
      h('td', { class: `c-status st-${c.statusClass}`, title: c.status }, c.status),
      h('td', { class: 'c-tok', title: c.cacheRead != null ? `cache read ${c.cacheRead} · cache write ${c.cacheWrite}` : '' }, tok),
      h('td', { class: 'c-time' }, fmtMs(c.durationMs)),
      h('td', { class: 'c-start', title: fmtDate(c.start) }, fmtClock(c.start)),
      h('td', { class: 'c-wf' }, h('div', { class: 'wf' }, bar)));
    frag.append(tr);
  });
  tbody.replaceChildren(frag);
  renderSummary(rows);
  if ((initial || (S.follow && atBottom)) && S.follow) wrap.scrollTop = wrap.scrollHeight;
}

function renderSummary(rows) {
  const api = rows.filter((c) => c.kind === 'api');
  const sum = (k) => api.reduce((a, c) => a + (c[k] || 0), 0);
  const tin = sum('tokensIn'); const tout = sum('tokensOut'); const cr = sum('cacheRead'); const cw = sum('cacheWrite');
  const errs = rows.filter((c) => c.statusClass === 'error').length;
  $('#summary').replaceChildren(
    h('span', null, h('b', null, rows.length), ' requests'),
    h('span', null, h('b', null, api.length), ' API calls'),
    h('span', null, 'input ', h('b', null, fmtTok(tin))),
    h('span', null, 'output ', h('b', null, fmtTok(tout))),
    h('span', null, 'cache read ', h('b', null, tin ? `${Math.round((cr / tin) * 100)}%` : '–')),
    h('span', null, 'cache write ', h('b', null, fmtTok(cw))),
    errs ? h('span', { class: 'st-error' }, h('b', null, errs), ' errors') : '',
  );
}

// ---------- detail ----------
function hideDetail() {
  $('#detail').hidden = true; $('#divider').hidden = true; $('#split').classList.remove('has-detail');
}

async function selectCall(id) {
  S.sel = id;
  for (const tr of document.querySelectorAll('#calls tbody tr')) tr.classList.toggle('sel', tr.dataset.id === id);
  const key = S.key;
  const d = await bridge.getDetail(key, id);
  if (S.sel !== id || S.key !== key) return;
  S.detail = d;
  renderDetail();
}

function tabsFor(d) {
  if (d.kind === 'api') return [['headers', 'Headers'], ['payload', 'Payload'], ['preview', 'Preview'], ['response', 'Response'], ['usage', 'Usage'], ['timing', 'Timing']];
  return [['headers', 'Headers'], ['payload', 'Payload'], ['preview', 'Preview'], ['response', 'Response'], ['timing', 'Timing']];
}

function renderDetail() {
  const d = S.detail;
  const el = $('#detail');
  el.hidden = false; $('#divider').hidden = false; $('#split').classList.add('has-detail');
  if (!d) { el.replaceChildren(h('div', { class: 'd-body muted' }, 'This request is no longer in the transcript.')); return; }
  const tabs = tabsFor(d);
  if (!tabs.some(([k]) => k === S.tab)) S.tab = 'headers';
  const body = h('div', { class: 'd-body' });
  el.replaceChildren(
    h('div', { class: 'd-head' },
      h('button', { class: 'd-close', title: 'Close (Esc)', onclick: () => { S.sel = null; hideDetail(); renderTable(); } }, '×'),
      h('div', { class: 'tabs' }, tabs.map(([k, label]) => h('button', {
        class: `tab${S.tab === k ? ' on' : ''}`, onclick: () => { S.tab = k; store.set('tab', k); renderDetail(); },
      }, label)))),
    body);
  const render = { headers: tabHeaders, payload: tabPayload, preview: tabPreview, response: tabResponse, usage: tabUsage, timing: tabTiming }[S.tab];
  body.append(...[render(d)].flat());
}

function kvSection(title, obj, note) {
  const entries = Object.entries(obj || {}).filter(([, v]) => v != null && v !== '');
  if (!entries.length) return null;
  return h('div', { class: 'sec' },
    h('div', { class: 'sec-h' }, title, note ? h('span', { class: 'note' }, note) : null),
    h('div', { class: 'kv' }, entries.map(([k, v]) => [h('div', { class: 'k' }, k), h('div', { class: 'v' }, typeof v === 'object' ? JSON.stringify(v) : String(v))])));
}

function tabHeaders(d) {
  const out = [kvSection('General', d.general)];
  if (d.kind === 'api' && !d.legacy && d.requestHeaders) {
    out.push(kvSection('Request headers', d.requestHeaders, 'reconstructed: auth and client headers are never written to the transcript'));
  }
  if (d.kind !== 'api' || d.legacy || !d.requestHeaders) out.push(kvSection('Request headers', d.requestHeaders));
  if (d.responseHeaders && Object.keys(d.responseHeaders).length) out.push(kvSection('Response headers', d.responseHeaders));
  else if (d.general && d.general['Request ID']) out.push(kvSection('Response headers', { 'request-id': d.general['Request ID'] }, 'recorded'));
  if (d.flags) out.push(kvSection('Claude Code', d.flags));
  if (d.error) out.push(kvSection('Error', { status: d.error.status, error: d.error.error }));
  return out.filter(Boolean);
}

function curlFor(d) {
  const hdr = Object.entries(d.requestHeaders || {}).filter(([, v]) => v).map(([k, v]) => `  -H '${k}: ${v}' \\`);
  return [
    `curl '${d.general['Request URL']}' \\`,
    ...hdr,
    '  -H "x-api-key: $ANTHROPIC_API_KEY" \\',
    "  --data-binary @- <<'JSON'",
    JSON.stringify(d.body),
    'JSON',
  ].join('\n');
}

function tabPayload(d) {
  if (d.body == null) {
    const v = d.general && d.general['Claude Code'];
    return h('div', { class: 'banner' }, d.legacy
      ? `This call was made by Claude Code ${v || '(unknown version)'}, which doesn't record request payloads (2.1.300 and later do). Response, usage and timing are still shown. Agent SDK apps often bundle an older Claude Code: upgrade the SDK, or point it at your installed claude with the SDK's cli_path option.`
      : 'No payload was recorded for this request.');
  }
  const out = [];
  if (d.unresolved) out.push(h('div', { class: 'banner' }, `${d.unresolved} message${d.unresolved > 1 ? 's' : ''} could not be matched to a transcript entry and ${d.unresolved > 1 ? 'are' : 'is'} shown as placeholders.`));
  if (d.truncated) out.push(h('div', { class: 'banner' }, 'The start of this conversation is in another transcript (for example, a resumed session), so earlier messages are missing.'));
  if (d.kind === 'api' && d.body && typeof d.body === 'object' && Array.isArray(d.body.messages)) {
    const b = d.body;
    const size = JSON.stringify(b).length;
    out.push(h('div', { class: 'stat-chips' },
      h('span', { class: 'stat' }, 'model ', h('b', null, b.model)),
      Array.isArray(b.system) ? h('span', { class: 'stat' }, 'system ', h('b', null, b.system.length), ' blocks') : null,
      Array.isArray(b.tools) ? h('span', { class: 'stat' }, 'tools ', h('b', null, b.tools.length)) : null,
      h('span', { class: 'stat' }, 'messages ', h('b', null, b.messages.length)),
      h('span', { class: 'stat' }, 'max_tokens ', h('b', null, b.max_tokens)),
      h('span', { class: 'stat' }, 'size ', h('b', null, fmtBytes(size)))));
  }
  const view = h('div');
  const draw = () => {
    view.replaceChildren(S.payloadView === 'raw' ? h('pre', { class: 'raw' }, JSON.stringify(d.body, null, 2)) : jsonTree(d.body, 1));
    seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.v === S.payloadView));
  };
  const seg = h('div', { class: 'seg' },
    h('button', { 'data-v': 'tree', onclick: () => { S.payloadView = 'tree'; draw(); } }, 'Tree'),
    h('button', { 'data-v': 'raw', onclick: () => { S.payloadView = 'raw'; draw(); } }, 'Raw'));
  out.push(h('div', { class: 'd-toolbar' }, seg,
    h('button', { class: 'btn', onclick: (e) => { copy(JSON.stringify(d.body, null, 2)); flash(e.target); } }, 'Copy JSON'),
    d.kind === 'api' ? h('button', { class: 'btn', onclick: (e) => { copy(curlFor(d)); flash(e.target); } }, 'Copy as cURL') : null));
  out.push(view);
  draw();
  return out;
}

function tabResponse(d) {
  if (d.error) {
    return [kvSection('Error', { status: d.error.status, error: d.error.error }), d.error.message ? jsonTree(d.error.message, 2) : null].filter(Boolean);
  }
  if (!d.response) return h('div', { class: 'banner info' }, d.summary && d.summary.statusClass === 'pending' ? 'Waiting for the response…' : 'No response was recorded for this request.');
  return [
    h('div', { class: 'd-toolbar' }, h('button', { class: 'btn', onclick: (e) => { copy(JSON.stringify(d.response, null, 2)); flash(e.target); } }, 'Copy JSON')),
    jsonTree(d.response, 2),
  ];
}

function tabUsage(d) {
  const u = d.usage;
  if (!u) return h('div', { class: 'banner info' }, 'No usage recorded.');
  const flat = {};
  const walk = (o, p) => {
    for (const [k, v] of Object.entries(o)) {
      if (k === 'iterations') continue;
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, `${p}${k}.`);
      else flat[`${p}${k}`] = v;
    }
  };
  walk(u, '');
  const total = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  return [
    h('div', { class: 'stat-chips' },
      h('span', { class: 'stat' }, 'total input ', h('b', null, total.toLocaleString())),
      h('span', { class: 'stat' }, 'output ', h('b', null, (u.output_tokens || 0).toLocaleString())),
      h('span', { class: 'stat' }, 'cache hit ', h('b', null, total ? `${Math.round(((u.cache_read_input_tokens || 0) / total) * 100)}%` : '–'))),
    kvSection('Usage', flat),
    Array.isArray(u.iterations) && u.iterations.length > 1 ? h('div', { class: 'sec' }, h('div', { class: 'sec-h' }, 'Iterations'), jsonTree(u.iterations, 2)) : null,
  ].filter(Boolean);
}

function tabTiming(d) {
  const t = d.timing || {};
  const t0 = Date.parse(t.start);
  const total = t.durationMs || 0;
  const rows = [];
  const line = (label, from, to, val) => {
    const track = h('div', { class: 'track' });
    const bar = h('div', { class: 'bar' });
    const span = Math.max(1, total);
    bar.style.left = `${Math.max(0, (from / span) * 100)}%`;
    bar.style.width = `${Math.max(0.5, ((to - from) / span) * 100)}%`;
    track.append(bar);
    rows.push(h('div', { class: 'lbl' }, label), track, h('div', { class: 'val' }, val));
  };
  if (total) line('Total', 0, total, fmtMs(total));
  let prev = 0;
  for (const b of t.blocks || []) {
    line(b.types.join(', ') || 'block', prev, b.offsetMs, `+${fmtMs(b.offsetMs)}`);
    prev = b.offsetMs;
  }
  const extra = {};
  for (const [i, b] of (t.blocks || []).entries()) {
    if (b.thinkingDurationMs != null) extra[`block ${i + 1} thinking`] = fmtMs(b.thinkingDurationMs);
    if (b.toolInputStreamMs != null) extra[`block ${i + 1} tool input stream`] = fmtMs(b.toolInputStreamMs);
  }
  return [
    kvSection('Timestamps', { Started: fmtDate(t.start), Finished: fmtDate(t.end), Duration: fmtMs(t.durationMs) }),
    rows.length ? h('div', { class: 'sec' }, h('div', { class: 'sec-h' }, 'Timeline', h('span', { class: 'note' }, 'times are when each content block was written, not exact network events')), h('div', { class: 'tl' }, rows)) : null,
    kvSection('Durations reported by Claude Code', extra),
    Number.isFinite(t0) ? null : h('div', { class: 'muted' }, 'No timing recorded.'),
  ].filter(Boolean);
}

// ---------- JSON tree ----------
const STR_LIMIT = 600;
function jsonValue(v) {
  if (v === null) return h('span', { class: 'null' }, 'null');
  if (typeof v === 'string') {
    if (v.length <= STR_LIMIT) return h('span', { class: 'str' }, JSON.stringify(v));
    const span = h('span', { class: 'str' }, JSON.stringify(v.slice(0, STR_LIMIT)).slice(0, -1) + '…"');
    const more = h('span', { class: 'more', onclick: () => { span.textContent = JSON.stringify(v); more.remove(); } }, `show all ${v.length.toLocaleString()} chars`);
    return h('span', null, span, more);
  }
  if (typeof v === 'number') return h('span', { class: 'num' }, String(v));
  if (typeof v === 'boolean') return h('span', { class: 'bool' }, String(v));
  return h('span', null, String(v));
}
function preview(v) {
  if (Array.isArray(v)) return `Array(${v.length})`;
  const keys = Object.keys(v);
  const hint = v.type ? ` ${v.type}` : v.role ? ` ${v.role}` : v.name ? ` ${v.name}` : '';
  return `{${hint}${hint ? ' · ' : ''}${keys.length} keys}`;
}
function jsonTree(value, openDepth = 1) {
  const root = h('div', { class: 'json' });
  const node = (key, v, depth) => {
    const label = key == null ? null : h('span', { class: 'key' }, typeof key === 'number' ? `${key}` : JSON.stringify(key).slice(1, -1));
    if (v && typeof v === 'object') {
      const det = h('details');
      const sum = h('summary', null, label, label ? ': ' : null, h('span', { class: 'meta' }, preview(v)));
      det.append(sum);
      let filled = false;
      const fill = () => {
        if (filled) return; filled = true;
        const entries = Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v);
        const CH = 200;
        const addFrom = (start) => {
          for (const [k, x] of entries.slice(start, start + CH)) det.append(node(k, x, depth + 1));
          if (entries.length > start + CH) {
            const more = h('div', { class: 'row' }, h('span', { class: 'more', onclick: () => { more.remove(); addFrom(start + CH); } }, `show ${Math.min(CH, entries.length - start - CH)} more of ${entries.length - start - CH}`));
            det.append(more);
          }
        };
        addFrom(0);
      };
      det.addEventListener('toggle', () => { if (det.open) fill(); });
      if (depth < openDepth) { det.open = true; fill(); }
      return det;
    }
    return h('div', { class: 'row' }, label, label ? ': ' : null, jsonValue(v));
  };
  root.append(node(null, value, 0));
  return root;
}

// ---------- conversation preview ----------
const TEXT_LIMIT = 4000;
function longText(text, cls = 'blk-text') {
  const s = String(text ?? '');
  if (s.length <= TEXT_LIMIT) return h('div', { class: cls }, s);
  const el = h('div', { class: cls }, s.slice(0, TEXT_LIMIT) + '…');
  const more = h('button', { class: 'link-btn', onclick: () => { el.textContent = s; more.remove(); } }, `show all ${s.length.toLocaleString()} chars`);
  return h('div', null, el, more);
}
function blockView(b) {
  if (typeof b === 'string') return longText(b);
  if (!b || typeof b !== 'object') return longText(String(b));
  switch (b.type) {
    case 'text':
      return longText(b.text);
    case 'thinking':
      return h('details', { class: 'blk thinking' }, h('summary', null, `thinking${b.thinking ? ` · ${b.thinking.length.toLocaleString()} chars` : ' (summary hidden)'}`), b.thinking ? longText(b.thinking, 'blk-c') : h('div', { class: 'blk-c' }, 'Signature only.'));
    case 'redacted_thinking':
      return h('div', { class: 'blk' }, h('div', { class: 'blk-h' }, 'redacted thinking'));
    case 'tool_use':
    case 'server_tool_use':
      return h('details', { class: 'blk' }, h('summary', null, `→ ${b.type === 'server_tool_use' ? 'server tool ' : ''}${b.name}  ${b.id || ''}`), h('div', { class: 'blk-c' }, jsonTree(b.input, 1)));
    case 'tool_result': {
      const c = b.content;
      const inner = Array.isArray(c) ? c.map(blockView) : longText(typeof c === 'string' ? c : JSON.stringify(c, null, 2));
      return h('details', { class: `blk${b.is_error ? ' err' : ''}` }, h('summary', null, `← ${b.is_error ? 'error ' : ''}result  ${b.tool_use_id || ''}`), h('div', { class: 'blk-c' }, inner));
    }
    case 'image': {
      const src = b.source || {};
      if (src.type === 'base64' && src.data) return h('div', { class: 'blk' }, h('div', { class: 'blk-h' }, `image ${src.media_type || ''}`), h('img', { src: `data:${src.media_type};base64,${src.data}`, alt: 'image' }));
      return h('div', { class: 'blk' }, h('div', { class: 'blk-h' }, `image (${src.type || 'unknown source'})`));
    }
    default:
      if (/_tool_result$/.test(b.type || '')) {
        return h('details', { class: 'blk' }, h('summary', null, `← ${b.type}  ${b.tool_use_id || ''}`), h('div', { class: 'blk-c' }, jsonTree(b.content, 1)));
      }
      return h('details', { class: 'blk' }, h('summary', null, b.type || 'block'), h('div', { class: 'blk-c' }, jsonTree(b, 1)));
  }
}
function messageView(m, extraCls = '', label = null) {
  const blocks = Array.isArray(m.content) ? m.content : [m.content];
  return h('div', { class: `msg ${extraCls}` },
    h('div', { class: 'msg-h' }, h('span', { class: `role role-${m.role}` }, label || m.role), h('span', null, `${blocks.length} block${blocks.length === 1 ? '' : 's'}`)),
    h('div', { class: 'msg-b' }, blocks.map(blockView)));
}
const PREVIEW_TAIL = 30;
function tabPreview(d) {
  if (d.kind !== 'api') {
    const out = [h('div', { class: 'sec' }, h('div', { class: 'sec-h' }, 'Input'), jsonTree(d.body, 2))];
    if (d.response && d.response.tool_result) {
      const r = blockView(d.response.tool_result);
      if (r.tagName === 'DETAILS') r.open = true;
      out.push(h('div', { class: 'sec' }, h('div', { class: 'sec-h' }, 'Result'), r));
    }
    const tur = d.response && d.response.toolUseResult;
    if (tur && typeof tur === 'object') out.push(h('div', { class: 'sec' }, h('div', { class: 'sec-h' }, 'Structured result', h('span', { class: 'note' }, 'as recorded by Claude Code')), jsonTree(tur, 1)));
    return out;
  }
  const out = [];
  const b = d.body;
  if (b) {
    if (b.system) {
      const sys = Array.isArray(b.system) ? b.system : [{ type: 'text', text: b.system }];
      const chars = sys.reduce((a, x) => a + (x.text ? x.text.length : 0), 0);
      out.push(h('details', { class: 'blk sec' }, h('summary', null, `system prompt · ${sys.length} blocks · ${chars.toLocaleString()} chars`), h('div', { class: 'blk-c' }, sys.map(blockView))));
    }
    if (Array.isArray(b.tools)) {
      out.push(h('details', { class: 'blk sec' }, h('summary', null, `tools · ${b.tools.length}`),
        h('div', { class: 'blk-c' }, b.tools.map((t) => h('details', { class: 'blk' }, h('summary', null, t.name || t.type), h('div', { class: 'blk-c' }, t.description ? longText(t.description) : null, t.input_schema ? jsonTree(t.input_schema, 1) : null))))));
    }
    const msgs = b.messages || [];
    const container = h('div');
    let shown = Math.min(PREVIEW_TAIL, msgs.length);
    const draw = () => {
      container.replaceChildren();
      if (msgs.length > shown) {
        container.append(h('button', { class: 'btn earlier', onclick: () => { shown = Math.min(msgs.length, shown + 50); draw(); } }, `Show ${Math.min(50, msgs.length - shown)} earlier messages (${msgs.length - shown} hidden)`));
      }
      msgs.slice(msgs.length - shown).forEach((m) => container.append(messageView(m)));
    };
    draw();
    out.push(container);
  } else {
    out.push(h('div', { class: 'banner' }, `No request payload: Claude Code ${(d.general && d.general['Claude Code']) || ''} doesn't record them (2.1.300 and later do). See Payload for how to fix this for Agent SDK apps.`));
  }
  if (d.response) out.push(messageView(d.response, 'response', 'response'));
  else if (d.error) out.push(h('div', { class: 'banner' }, `API error ${d.error.status || ''}: ${d.error.error || ''}`));
  return out;
}

// ---------- divider ----------
function setupDivider() {
  const div = $('#divider');
  const detail = $('#detail');
  const saved = store.get('detailWidth', null);
  if (saved) detail.style.width = `${saved}px`;
  div.addEventListener('mousedown', (e) => {
    e.preventDefault();
    div.classList.add('drag');
    const split = $('#split').getBoundingClientRect();
    const move = (ev) => {
      const w = Math.max(360, Math.min(split.width - 280, split.right - ev.clientX));
      detail.style.width = `${w}px`;
    };
    const up = () => {
      div.classList.remove('drag');
      store.set('detailWidth', parseInt(detail.style.width, 10));
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  });
}

// ---------- roots dialog ----------
async function showRoots() {
  const r = await bridge.listRoots();
  const ul = $('#roots-list');
  ul.replaceChildren(...r.roots.map((p) => {
    const on = r.enabled.includes(p);
    const box = h('input', { type: 'checkbox' });
    box.checked = on;
    box.addEventListener('change', async () => { await bridge.toggleRoot(p, box.checked); showRoots(); });
    return h('li', null,
      h('label', { class: 'root-row', title: on ? 'Recording this account' : 'Not recording this account' }, box, h('span', null, p)),
      r.extraRoots.includes(p) ? h('button', { class: 'btn', onclick: async () => { await bridge.removeRoot(p); showRoots(); } }, 'Remove') : h('span', { class: 'muted' }, 'auto-detected'));
  }));
  if (!r.roots.length) ul.append(h('li', null, 'No Claude config folders found.'));
  $('#roots-dialog').hidden = false;
}

// ---------- wiring ----------
function wire() {
  $('#session-search').addEventListener('input', (e) => { S.sessionQuery = e.target.value; renderSessions(); });
  $('#call-search').addEventListener('input', (e) => { S.q = e.target.value; renderTable(); });
  $('#source-select').addEventListener('change', (e) => { S.source = e.target.value; renderTable(); });
  $('#errors-only').addEventListener('change', (e) => { S.errorsOnly = e.target.checked; renderTable(); });
  $('#follow').addEventListener('change', (e) => { S.follow = e.target.checked; if (S.follow) renderTable(true); });
  $('#btn-roots').addEventListener('click', showRoots);
  $('#roots-close').addEventListener('click', () => { $('#roots-dialog').hidden = true; });
  $('#roots-add').addEventListener('click', async () => { await bridge.addRoot(); showRoots(); });

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.key === 'Escape') { S.sel = null; hideDetail(); renderTable(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = visibleCalls();
    if (!rows.length) return;
    e.preventDefault();
    let i = rows.findIndex((c) => c.id === S.sel);
    i = e.key === 'ArrowDown' ? Math.min(rows.length - 1, i + 1) : Math.max(0, i < 0 ? rows.length - 1 : i - 1);
    selectCall(rows[i].id);
    const tr = document.querySelector(`#calls tbody tr[data-id="${CSS.escape(rows[i].id)}"]`);
    if (tr) tr.scrollIntoView({ block: 'nearest' });
  });

  bridge.onState(applyState);
  bridge.onMenu((m) => {
    if (m === 'import') $('#btn-import').click();
    else if (m === 'export') $('#btn-export').click();
    else if (m === 'clear') $('#btn-clear').click();
  });
  $('#btn-rec').addEventListener('click', async () => applyState(S.rec.recording ? await bridge.stop() : await bridge.start()));
  $('#btn-clear').addEventListener('click', async () => applyState(await bridge.clear()));
  $('#btn-import').addEventListener('click', async () => applyState(await bridge.importHar()));
  $('#btn-export').addEventListener('click', () => bridge.exportHar('recording'));
  bridge.onViewUpdate(async (p) => {
    if (p.key !== S.key) return;
    const sig = (c) => (c ? `${c.status}|${c.durationMs}|${c.tokensOut}` : '');
    const before = sig(S.calls.find((c) => c.id === S.sel));
    S.info = p.info; S.calls = p.calls;
    renderHead(); renderSourceSelect(); renderKindChips(); renderTable();
    if (S.sel && sig(S.calls.find((c) => c.id === S.sel)) !== before) {
      const d = await bridge.getDetail(S.key, S.sel);
      if (S.sel && d) { S.detail = d; renderDetail(); }
    }
  });
  setupDivider();
}

(async function init() {
  wire();
  applyState(await bridge.state());
  setInterval(renderSessions, 30000); // keep "x ago" and live dots fresh
}());

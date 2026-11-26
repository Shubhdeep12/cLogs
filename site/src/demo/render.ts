// Pure HTML-string renderers for the interactive demo. Used on the server for
// the first paint and in the browser after every interaction.
import type { Block, Call, Msg, Session } from './data';
import { BETAS, SYSTEM_PROMPT, TOOLS } from './data';

export type Filter = 'all' | 'api' | 'mcp' | 'web';
export type Tab = 'headers' | 'payload' | 'preview' | 'response' | 'usage';
export type State = {
  sessions: Session[];
  sid: string;
  sel: string | null;
  tab: Tab;
  filter: Filter;
  q: string;
  recording: boolean;
};

const MODEL = 'claude-sonnet-5-5';
const KIND: Record<string, string> = { api: 'Anthropic API', mcp: 'MCP', web: 'Web' };

export function initialState(sessions: Session[]): State {
  return { sessions, sid: sessions[0].id, sel: sessions[0].calls[0].id, tab: 'preview', filter: 'all', q: '', recording: true };
}

// ---------- helpers ----------
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const tok = (n?: number) => (n == null ? '' : n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`);
const secs = (s?: number) => (s == null ? '' : s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(2)} s`);
const kb = (b?: number) => (b == null ? '' : `${Math.round(b / 1024)} KB`);

export function session(st: State) { return st.sessions.find((s) => s.id === st.sid) || st.sessions.find((s) => s.calls.length) || st.sessions[0]; }
export function selected(st: State) { return session(st).calls.find((c) => c.id === st.sel) || null; }
export function visible(st: State) {
  const q = st.q.trim().toLowerCase();
  return session(st).calls.filter((c) => (st.filter === 'all' || c.kind === st.filter)
    && (!q || `${c.method} ${c.name} ${c.host} ${c.status} ${c.source}`.toLowerCase().includes(q)));
}

/** Syntax-highlighted pretty JSON. */
export function json(v: unknown) {
  const src = JSON.stringify(v, null, 2);
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?\b/g;
  let out = '';
  let last = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    out += esc(src.slice(last, m.index));
    if (m[1]) out += m[2] ? `<span class="jk">${esc(m[1])}</span>${m[2]}` : `<span class="js">${esc(m[1])}</span>`;
    else if (m[3]) out += `<span class="jb">${m[0]}</span>`;
    else out += `<span class="jn">${m[0]}</span>`;
    last = m.index + m[0].length;
  }
  return `<pre class="json">${out + esc(src.slice(last))}</pre>`;
}

const wire = (b: Block, i: number) => {
  switch (b.type) {
    case 'text': return { type: 'text', text: b.text };
    case 'thinking': return { type: 'thinking', thinking: b.text, signature: '…' };
    case 'tool_use': return { type: 'tool_use', id: `toolu_demo_${i}`, name: b.name, input: b.input };
    case 'tool_result': return { type: 'tool_result', tool_use_id: `toolu_demo_${i}`, content: b.text, ...(b.error ? { is_error: true } : {}) };
  }
};
const wireMsg = (m: Msg) => ({ role: m.role, content: m.blocks.map(wire) });

export function requestBody(c: Call) {
  return {
    model: MODEL,
    max_tokens: 32000,
    system: SYSTEM_PROMPT.map((text, i) => ({ type: 'text', text, ...(i === SYSTEM_PROMPT.length - 1 ? { cache_control: { type: 'ephemeral', ttl: '1h' } } : {}) })),
    messages: (c.messages || []).map(wireMsg),
    tools: TOOLS.map((name) => ({ name, description: '…', input_schema: { type: 'object' } })),
    thinking: { type: 'adaptive' },
  };
}

export function responseBody(c: Call) {
  if (c.error) { const [type, message] = c.error.split(': '); return { type: 'error', error: { type, message } }; }
  if (!c.response) return null;
  return {
    id: `msg_demo_${c.id}`, type: 'message', role: 'assistant', model: MODEL,
    content: c.response.blocks.map(wire), stop_reason: c.stop, stop_sequence: null,
    usage: usage(c),
  };
}

function usage(c: Call) {
  const read = c.cacheRead || 0;
  return { input_tokens: Math.max(0, (c.tokensIn || 0) - read - 20), cache_read_input_tokens: read, cache_creation_input_tokens: 20, output_tokens: c.tokensOut || 0 };
}

// ---------- regions ----------
export function renderSide(st: State) {
  const shown = st.sessions.filter((s) => s.calls.length);
  const total = shown.reduce((a, s) => a + s.calls.length, 0);
  const cur = session(st);
  return `
    <div class="recbar">
      <button class="rec ${st.recording ? 'on' : ''}" data-act="record"><b></b>${st.recording ? 'Stop' : 'Record'}</button>
      <button class="chip" data-act="clear">Clear</button>
      <button class="chip" data-act="export">Export</button>
    </div>
    <div class="recstate"><b class="${st.recording ? 'on' : ''}">${st.recording ? '● Recording' : 'Stopped'}</b><span>${total} requests · ${shown.length} sessions</span></div>
    <div class="sec">Recorded</div>
    <div class="sessions">
      ${shown.length ? shown.map((s) => `
        <button class="sess ${s.id === cur.id ? 'sel' : ''}" data-act="session" data-id="${s.id}">
          ${s.live && st.recording ? '<i class="live"></i>' : ''}
          <span class="st">${esc(s.title)}</span>
          <span class="sm"><span class="acct">${esc(s.account)}</span>${esc(s.project)} · ${s.calls.length} requests</span>
        </button>`).join('') : '<p class="empty">Cleared. New requests will appear here.</p>'}
    </div>`;
}

export function renderChips(st: State) {
  const calls = session(st).calls;
  const n = (k: Filter) => (k === 'all' ? calls.length : calls.filter((c) => c.kind === k).length);
  const chips: [Filter, string][] = [['all', 'All'], ['api', 'Anthropic API'], ['mcp', 'MCP'], ['web', 'Web']];
  return chips.filter(([k]) => k === 'all' || n(k)).map(([k, l]) =>
    `<button class="pill ${st.filter === k ? 'on' : ''}" data-act="filter" data-id="${k}">${l}${k === 'all' ? '' : ` <span>${n(k)}</span>`}</button>`).join('');
}

export function renderTable(st: State) {
  const rows = visible(st);
  const calls = session(st).calls;
  const span = Math.max(1, ...calls.map((c) => c.at + (c.dur || 0.5)));
  const head = '<div class="tr th"><span>Name</span><span class="c-kind">Type</span><span>Status</span><span class="c-tok">Tokens</span><span class="c-t">Time</span><span class="c-wf"></span></div>';
  if (!rows.length) return `${head}<p class="none">${calls.length ? 'No requests match.' : 'Waiting for Claude Code…'}</p>`;
  return head + rows.map((c) => {
    const left = (c.at / span) * 100;
    const width = Math.max(1.2, ((c.dur || 0.5) / span) * 100);
    const tokens = c.kind === 'api' ? (c.tokensIn ? `${tok(c.tokensIn)} → ${tok(c.tokensOut)}` : '') : kb(c.bytes);
    return `
      <button class="tr ${c.id === st.sel ? 'sel' : ''} ${c.statusClass === 'error' ? 'err' : ''}" data-act="row" data-id="${c.id}">
        <span class="nm"><em>${esc(c.method)}</em>${c.kind === 'mcp' ? `${esc(c.host)} · ` : c.kind === 'web' && c.method === 'GET' ? esc(c.host) : ''}${esc(c.name)}${c.source !== 'main' ? `<i class="tag">${esc(c.source)}</i>` : ''}</span>
        <span class="c-kind kind k-${c.kind}">${KIND[c.kind]}</span>
        <span class="stc s-${c.statusClass}">${esc(c.status)}</span>
        <span class="c-tok">${tokens}</span>
        <span class="c-t">${c.statusClass === 'pending' ? '' : secs(c.dur)}</span>
        <span class="c-wf"><i class="${c.statusClass}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%"></i></span>
      </button>`;
  }).join('');
}

const tabsFor = (c: Call): [Tab, string][] => (c.kind === 'api'
  ? [['headers', 'Headers'], ['payload', 'Payload'], ['preview', 'Preview'], ['response', 'Response'], ['usage', 'Usage']]
  : [['headers', 'Headers'], ['payload', 'Payload'], ['preview', 'Preview'], ['response', 'Response']]);

const kv = (title: string, rows: [string, unknown][], note = '') => `
  <div class="kvs"><div class="kvh">${title}${note ? ` <span>${note}</span>` : ''}</div>
  <dl>${rows.filter(([, v]) => v != null && v !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>`;

function blockHTML(b: Block) {
  switch (b.type) {
    case 'text': return `<p class="bt">${esc(b.text)}</p>`;
    case 'thinking': return `<details class="bk think"><summary>thinking</summary><p>${esc(b.text)}</p></details>`;
    case 'tool_use': return `<div class="bk use"><span>→ ${esc(b.name)}</span><code>${esc(JSON.stringify(b.input))}</code></div>`;
    case 'tool_result': return `<div class="bk res ${b.error ? 'err' : ''}"><span>← result</span><code>${esc(b.text)}</code></div>`;
  }
}
const msgHTML = (m: Msg, cls = '', label = m.role) => `<div class="msg ${cls}"><div class="mh r-${m.role}">${esc(label)}</div>${m.blocks.map(blockHTML).join('')}</div>`;

export function renderDetail(st: State) {
  const c = selected(st);
  if (!c) return '<p class="pick">Select a request to inspect it.</p>';
  const tabs = tabsFor(c);
  const tab = tabs.some(([k]) => k === st.tab) ? st.tab : 'headers';
  const head = `<div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${k === tab}" class="${k === tab ? 'on' : ''}" data-act="tab" data-id="${k}">${l}</button>`).join('')}</div>`;
  let body = '';
  const pending = c.statusClass === 'pending';

  if (c.kind === 'api') {
    const req = requestBody(c);
    const res = responseBody(c);
    if (tab === 'headers') {
      body = kv('General', [['Request URL', 'https://api.anthropic.com/v1/messages'], ['Method', 'POST'], ['Status', c.status], ['Source', c.source === 'main' ? 'main thread' : c.source === 'sdk' ? 'Agent SDK app' : `subagent: ${c.source}`], ['Request ID', c.requestId]])
        + kv('Request headers', [['content-type', 'application/json'], ['anthropic-version', '2023-06-01'], ['anthropic-beta', BETAS]], 'reconstructed')
        + (c.requestId ? kv('Response headers', [['request-id', c.requestId]], 'recorded') : '');
    } else if (tab === 'payload') {
      body = `<div class="stats"><span>messages <b>${req.messages.length}</b></span><span>tools <b>${req.tools.length}</b></span><span>size <b>${Math.round(JSON.stringify(req).length / 10.24) / 100} KB</b></span></div>${json(req)}`;
    } else if (tab === 'preview') {
      body = `<details class="bk sys"><summary>system prompt · ${SYSTEM_PROMPT.length} blocks</summary><p>${esc(SYSTEM_PROMPT.join('\n\n'))}</p></details>`
        + (c.messages || []).map((m) => msgHTML(m)).join('')
        + (c.response ? msgHTML(c.response, 'resp', 'response') : c.error ? `<div class="msg resp err"><div class="mh">error</div><p class="bt">${esc(c.error)}</p></div>` : pending ? '<p class="pick">Waiting for the response…</p>' : '');
    } else if (tab === 'response') {
      body = res ? json(res) : `<p class="pick">${pending ? 'Waiting for the response…' : 'No response recorded.'}</p>`;
    } else {
      body = c.tokensIn ? (() => {
        const u = usage(c);
        const hit = Math.round((u.cache_read_input_tokens / (c.tokensIn || 1)) * 100);
        return `<div class="hit"><span>cache hit</span><b>${hit}%</b><i><s style="width:${hit}%"></s></i></div>` + kv('Usage', Object.entries(u).map(([k, v]) => [k, v.toLocaleString('en-US')]));
      })() : '<p class="pick">No usage recorded.</p>';
    }
  } else {
    const url = c.kind === 'web' && c.method === 'GET' ? `https://${c.host}${c.name}` : c.kind === 'mcp' ? `mcp://${c.host}/${c.name}` : `web search: ${c.name}`;
    if (tab === 'headers') body = kv('General', [['Request URL', url], ['Method', c.method], ['Status', c.status], ['Tool', c.kind === 'mcp' ? `mcp__${c.host}__${c.name}` : c.method === 'GET' ? 'WebFetch' : 'WebSearch'], ['Size', kb(c.bytes)]]);
    else if (tab === 'payload') body = json(c.input || {});
    else if (tab === 'preview') body = `<div class="msg"><div class="mh">input</div><div class="bk use"><code>${esc(JSON.stringify(c.input))}</code></div></div><div class="msg resp"><div class="mh">result</div><p class="bt mono">${esc(c.result)}</p></div>`;
    else body = json({ tool_result: { type: 'tool_result', content: c.result }, ...(c.bytes ? { toolUseResult: { code: 200, bytes: c.bytes, durationMs: Math.round(c.dur * 1000) } } : {}) });
  }
  return head + `<div class="dbody">${body}</div>`;
}

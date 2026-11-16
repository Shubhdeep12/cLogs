'use strict';
/**
 * A chat session = main transcript + its subagent transcripts. Produces a flat,
 * time-ordered list of network calls (Messages API calls, web fetches/searches,
 * MCP tool calls, server-side tools, curl/wget from Bash) and their details.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { TranscriptFile } = require('./transcript');

const DEFAULT_BASE = 'https://api.anthropic.com';
const PENDING_MS = 10 * 60 * 1000;

const ms = (iso) => (iso ? Date.parse(iso) : NaN);
const safeURL = (u) => { try { return new URL(u); } catch { return null; } };

// The HTTP client must appear as a command word (start, or after a separator/space), followed by whitespace.
const HTTP_CMD = /(?:^|[\s;&|(`$])(curl|wget|xh|http|https|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\s/;
const URL_RE = /https?:\/\/[^\s'"`<>)\]]+/;

function classifyTool(block) {
  const name = block.name || '';
  const input = block.input || {};
  if (block.type === 'server_tool_use') {
    const u = input.url && safeURL(input.url);
    return {
      kind: 'server', method: 'SERVER', host: u ? u.host : 'api.anthropic.com',
      name: name + (input.query ? `: ${input.query}` : u ? ` ${u.pathname}` : ''), url: input.url || null,
    };
  }
  if (name === 'WebFetch') {
    const u = safeURL(input.url);
    return { kind: 'web', method: 'GET', host: u ? u.host : '(invalid url)', name: u ? u.pathname + u.search : String(input.url), url: input.url };
  }
  if (name === 'WebSearch') {
    return { kind: 'web', method: 'SEARCH', host: 'web search', name: String(input.query || ''), url: null };
  }
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    return { kind: 'mcp', method: 'MCP', host: parts[1] || 'mcp', name: parts.slice(2).join('__') || name, url: null };
  }
  if (name === 'Bash' && typeof input.command === 'string' && HTTP_CMD.test(input.command)) {
    const m = input.command.match(URL_RE);
    if (!m) return null;
    const u = safeURL(m[0]);
    const x = input.command.match(/(?:-X|--request)\s+([A-Z]+)/);
    return { kind: 'shell', method: x ? x[1] : (/\s(-d|--data|-F|--form)\b/.test(input.command) ? 'POST' : 'GET'), host: u ? u.host : m[0], name: u ? u.pathname + u.search : m[0], url: m[0] };
  }
  return null;
}

function usageTotals(u) {
  if (!u) return { input: null, output: null, cacheRead: null, cacheWrite: null };
  return {
    input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
    output: u.output_tokens ?? null,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,
  };
}

function setPath(node, keys, value) {
  if (!keys.length) return node;
  if (node === null || typeof node !== 'object') return node;
  const [k, ...rest] = keys;
  if (rest.length && !(k in node)) return node;
  const copy = Array.isArray(node) ? node.slice() : { ...node };
  copy[k] = rest.length ? setPath(node[k], rest, value) : value;
  return copy;
}

class Session {
  constructor(file, { baseURL } = {}) {
    this.file = file;
    this.baseURL = baseURL || DEFAULT_BASE;
    this.dir = file.replace(/\.jsonl$/, '');
    this.main = new TranscriptFile(file, { key: 'main', source: 'main' });
    this.agents = new Map();
  }

  async _discoverAgents() {
    const subDir = path.join(this.dir, 'subagents');
    let names;
    try { names = await fsp.readdir(subDir); } catch { return; }
    for (const n of names) {
      if (!n.endsWith('.jsonl') || this.agents.has(n)) continue;
      const id = n.replace(/^agent-/, '').replace(/\.jsonl$/, '');
      let meta = {};
      try { meta = JSON.parse(await fsp.readFile(path.join(subDir, n.replace(/\.jsonl$/, '.meta.json')), 'utf8')); } catch { /* optional */ }
      this.agents.set(n, new TranscriptFile(path.join(subDir, n), {
        key: `agent-${id}`,
        source: meta.agentType || 'subagent',
        agentType: meta.agentType || null,
        agentDescription: meta.description || null,
      }));
    }
  }

  files() { return [this.main, ...this.agents.values()]; }

  async update() {
    await this._discoverAgents();
    const changed = (await Promise.all(this.files().map((f) => f.update()))).some(Boolean);
    if (changed) this._calls = null;
    return changed;
  }

  info() {
    const m = this.main.meta;
    return {
      file: this.file, sessionId: m.sessionId, title: m.title || m.firstPrompt || path.basename(this.file),
      cwd: m.cwd, gitBranch: m.gitBranch, version: m.version, entrypoint: m.entrypoint,
      first: m.first, last: m.last, baseURL: this.baseURL, root: this.root || null,
      agents: [...this.agents.values()].map((a) => ({ key: a.key, type: a.agentType, description: a.agentDescription })),
    };
  }

  // ---------- list ----------

  calls() {
    if (this._calls && Date.now() - this._callsAt < 5000) return this._calls;
    this._calls = this._buildCalls();
    this._callsAt = Date.now();
    return this._calls;
  }

  _buildCalls() {
    const out = [];
    const now = Date.now();
    for (const f of this.files()) {
      const errorsByReq = this._attachErrors(f);
      for (const req of f.reqOrder) {
        const g = f.asstByRef.get(req.id) || [];
        const last = g[g.length - 1];
        const msg = (last && last.message) || {};
        const err = errorsByReq.get(req.id);
        const t0 = ms(req.timestamp);
        const t1 = last ? ms(last.timestamp) : err ? ms(err.timestamp) : NaN;
        let status; let statusClass;
        if (err) { status = String(err.apiErrorStatus || 'error'); statusClass = 'error'; }
        else if (last) { status = msg.stop_reason || 'ok'; statusClass = msg.stop_reason === 'max_tokens' || msg.stop_reason === 'refusal' ? 'warn' : 'ok'; }
        else if (now - t0 < PENDING_MS) { status = 'pending'; statusClass = 'pending'; }
        else { status = 'no response'; statusClass = 'warn'; }
        const u = usageTotals(msg.usage);
        out.push({
          id: `${f.key}|api|${req.id}`, kind: 'api', method: 'POST',
          host: safeURL(this.baseURL)?.host || 'api.anthropic.com', name: '/v1/messages',
          source: f.source, agentKey: f.key, querySource: req.querySource,
          model: msg.model || (req.params && req.params.model) || null,
          status, statusClass, start: req.timestamp, startMs: t0, durationMs: Number.isFinite(t1) ? Math.max(0, t1 - t0) : null,
          tokensIn: u.input, tokensOut: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite,
          messageCount: (req.keep || 0) + (req.tail || []).length, requestId: last && last.requestId,
        });
      }
      // Errors that could not be tied to a recorded request.
      for (const e of f.errors) {
        if (e._attached) continue;
        out.push({
          id: `${f.key}|err|${e.uuid}`, kind: 'api', method: 'POST', host: safeURL(this.baseURL)?.host || 'api.anthropic.com',
          name: '/v1/messages', source: f.source, agentKey: f.key, model: null,
          status: String(e.apiErrorStatus || 'error'), statusClass: 'error', start: e.timestamp, startMs: ms(e.timestamp), durationMs: null,
        });
      }
      // Older transcripts (no api-request entries): one row per API response.
      for (const [k, g] of f.legacy) {
        const first = g[0]; const last = g[g.length - 1]; const msg = last.message || {};
        const u = usageTotals(msg.usage);
        out.push({
          id: `${f.key}|legacy|${k}`, kind: 'api', legacy: true, method: 'POST', host: safeURL(this.baseURL)?.host || 'api.anthropic.com',
          name: '/v1/messages', source: f.source, agentKey: f.key, model: msg.model || null,
          status: msg.stop_reason || 'ok', statusClass: 'ok', start: first.timestamp, startMs: ms(first.timestamp),
          durationMs: Math.max(0, ms(last.timestamp) - ms(first.timestamp)) || null,
          tokensIn: u.input, tokensOut: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, requestId: last.requestId,
        });
      }
      for (const [id, tu] of f.toolUses) {
        const c = classifyTool(tu.block);
        if (!c) continue;
        const res = f.toolResults.get(id);
        const tur = res && res.toolUseResult;
        let durationMs = null;
        if (tur && typeof tur === 'object' && !Array.isArray(tur)) {
          if (typeof tur.durationMs === 'number') durationMs = tur.durationMs;
          else if (typeof tur.durationSeconds === 'number') durationMs = Math.round(tur.durationSeconds * 1000);
        }
        if (durationMs == null && res) durationMs = Math.max(0, ms(res.ts) - ms(tu.ts)) || null;
        let status; let statusClass;
        if (!res) { status = now - ms(tu.ts) < PENDING_MS ? 'pending' : 'no result'; statusClass = status === 'pending' ? 'pending' : 'warn'; }
        else if (res.block.is_error || (res.block.content && res.block.content.type && /error/.test(res.block.content.type))) { status = 'error'; statusClass = 'error'; }
        else if (tur && typeof tur.code === 'number') { status = String(tur.code); statusClass = tur.code >= 400 ? 'error' : tur.code >= 300 ? 'warn' : 'ok'; }
        else { status = 'ok'; statusClass = 'ok'; }
        out.push({
          id: `${f.key}|tool|${id}`, kind: c.kind, method: c.method, host: c.host, name: c.name, url: c.url,
          source: f.source, agentKey: f.key, model: null, status, statusClass,
          start: tu.ts, startMs: ms(tu.ts), durationMs, tool: tu.block.name,
          bytes: tur && typeof tur.bytes === 'number' ? tur.bytes : null,
        });
      }
    }
    out.sort((a, b) => (a.startMs || 0) - (b.startMs || 0));
    return out;
  }

  /** Tie each API error entry to the most recent preceding request without a response. */
  _attachErrors(f) {
    const map = new Map();
    for (const e of f.errors) {
      let target = null;
      for (let i = f.reqOrder.length - 1; i >= 0; i--) {
        const r = f.reqOrder[i];
        if (r._seq > e._seq) continue;
        if (!f.asstByRef.has(r.id) && !map.has(r.id)) target = r;
        break;
      }
      if (target) { map.set(target.id, e); e._attached = true; } else e._attached = false;
    }
    return map;
  }

  // ---------- detail ----------

  _file(key) {
    if (key === 'main') return this.main;
    for (const a of this.agents.values()) if (a.key === key) return a;
    return null;
  }

  detail(callId) {
    const [key, type, ...rest] = callId.split('|');
    const id = rest.join('|');
    const f = this._file(key);
    if (!f) return null;
    const summary = this.calls().find((c) => c.id === callId) || null;
    if (type === 'api') return this._apiDetail(f, id, summary);
    if (type === 'legacy') return this._legacyDetail(f, id, summary);
    if (type === 'err') {
      const e = f.errors.find((x) => x.uuid === id);
      return { summary, kind: 'api', general: this._general(summary, f, { error: e && e.error }), error: e, body: null, response: null };
    }
    if (type === 'tool') return this._toolDetail(f, id, summary);
    return null;
  }

  _general(summary, f, extra = {}) {
    return {
      'Request URL': summary ? (summary.kind === 'api' ? this.baseURL.replace(/\/$/, '') + '/v1/messages' : summary.url || `${summary.host} ${summary.name}`) : null,
      'Request Method': summary && summary.method,
      Status: summary && summary.status,
      Source: f.source === 'main' ? 'main thread' : `subagent: ${f.agentType || 'unknown'}${f.agentDescription ? ` — ${f.agentDescription}` : ''}`,
      ...extra,
    };
  }

  _apiDetail(f, id, summary) {
    const req = f.requests.get(id);
    if (!req) return null;
    const params = { ...(req.params || {}) };
    const betas = params.betas || [];
    delete params.betas;
    const shape = f.shapes.get(req.shapeHash) || {};
    const { messages, unresolved, truncated } = f.messagesFor(id);
    const { model, max_tokens: maxTokens, ...restParams } = params;
    let body = { model, max_tokens: maxTokens };
    if (shape.system !== undefined) body.system = shape.system;
    body.messages = messages;
    if (shape.tools !== undefined) body.tools = shape.tools;
    Object.assign(body, restParams);
    for (const cc of req.cacheControl || []) {
      if (Array.isArray(cc.path)) body = setPath(body, [...cc.path, 'cache_control'], cc.value);
    }

    const g = f.asstByRef.get(id) || [];
    const last = g[g.length - 1];
    let response = null;
    if (last) {
      const m = last.message || {};
      response = { id: m.id, type: 'message', role: 'assistant', model: m.model, content: g.flatMap((e) => (e.message && e.message.content) || []), stop_reason: m.stop_reason, stop_sequence: m.stop_sequence ?? null, usage: m.usage };
      for (const k of ['stop_details', 'container', 'context_management', 'diagnostics']) if (m[k] != null) response[k] = m[k];
    }
    const errorEntry = this._attachErrors(f).get(id) || null;

    const t0 = ms(req.timestamp);
    const blocks = g.map((e) => ({
      at: e.timestamp, offsetMs: ms(e.timestamp) - t0,
      types: ((e.message && e.message.content) || []).map((b) => b.type),
      thinkingDurationMs: e.thinkingDurationMs ?? null, toolInputStreamMs: e.toolInputStreamMs ?? null,
    }));

    return {
      summary, kind: 'api',
      general: this._general(summary, f, {
        'Request ID': last && last.requestId, 'Message ID': response && response.id,
        'Query source': req.querySource, 'Claude Code': req.version, Recorded: req.timestamp,
      }),
      requestHeaders: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': betas.join(','),
      },
      body, unresolved, truncated, response,
      error: errorEntry && { status: errorEntry.apiErrorStatus, error: errorEntry.error, message: errorEntry.message },
      usage: response && response.usage,
      timing: { start: req.timestamp, blocks, end: last ? last.timestamp : null, durationMs: summary && summary.durationMs },
      flags: {
        effort: last && last.effort, requestedModel: last && last.requestedModel, advisorModel: last && last.advisorModel,
        promptCacheRequested: last && last.promptCacheRequested,
      },
    };
  }

  _legacyDetail(f, id, summary) {
    const g = f.legacy.get(id);
    if (!g) return null;
    const last = g[g.length - 1]; const m = last.message || {};
    const response = { id: m.id, type: 'message', role: 'assistant', model: m.model, content: g.flatMap((e) => (e.message && e.message.content) || []), stop_reason: m.stop_reason, stop_sequence: m.stop_sequence ?? null, usage: m.usage };
    return {
      summary, kind: 'api', legacy: true,
      general: this._general(summary, f, { 'Request ID': last.requestId, 'Message ID': m.id, 'Claude Code': last.version, Recorded: g[0].timestamp }),
      body: null, response, usage: m.usage,
      timing: { start: g[0].timestamp, end: last.timestamp, durationMs: summary && summary.durationMs, blocks: [] },
    };
  }

  _toolDetail(f, id, summary) {
    const tu = f.toolUses.get(id);
    if (!tu) return null;
    const res = f.toolResults.get(id) || null;
    return {
      summary, kind: summary ? summary.kind : 'tool',
      general: this._general(summary, f, { Tool: tu.block.name, 'Tool use ID': id, 'Issued by request': tu.requestId || null }),
      body: tu.block.input,
      response: res ? { tool_result: res.block, toolUseResult: res.toolUseResult ?? null } : null,
      timing: { start: tu.ts, end: res ? res.ts : null, durationMs: summary && summary.durationMs, blocks: [] },
    };
  }
}

module.exports = { Session, classifyTool };

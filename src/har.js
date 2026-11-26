'use strict';
/**
 * HAR 1.2 export/import.
 *
 * Export: one HAR page per Claude session, one entry per captured call. Request
 * and response bodies go in the standard fields so the file also opens in
 * Chrome DevTools; app-specific details live under `_clogs` (HAR allows
 * custom fields prefixed with "_"). HARs written before the rename used
 * `_claudeCodeCalls`; import still reads that key.
 *
 * Import: our own HARs are restored with full detail; any other HAR (Chrome,
 * Charles, ...) is shown generically.
 */

const VERSION = require('../package.json').version;
const safeURL = (u) => { try { return new URL(u); } catch { return null; } };
const tryJSON = (t) => { if (typeof t !== 'string') return t ?? null; try { return JSON.parse(t); } catch { return t; } };
const bytes = (s) => (s == null ? 0 : Buffer.byteLength(s, 'utf8'));
/** Our HAR extension block (current key, or the pre-rename one). */
const ext = (o) => o._clogs || o._claudeCodeCalls || null;

function urlFor(call, d) {
  if (call.kind === 'api') return (d.general && d.general['Request URL']) || 'https://api.anthropic.com/v1/messages';
  if (call.url) return call.url;
  if (call.kind === 'mcp') return `mcp://${call.host}/${call.name}`;
  if (call.kind === 'web' && call.method === 'SEARCH') return `websearch://search?q=${encodeURIComponent(call.name)}`;
  return `${call.kind}://${call.host}/${encodeURIComponent(call.name || '')}`;
}

function statusFor(call, d) {
  if (call.statusClass === 'pending') return [0, 'pending'];
  if (call.kind === 'api') {
    if (d.error) return [Number(d.error.status) || 0, String(d.error.error || 'error')];
    return d.response ? [200, 'OK'] : [0, call.status];
  }
  const code = Number(call.status);
  if (Number.isFinite(code) && code > 0) return [code, ''];
  return call.statusClass === 'error' ? [0, 'error'] : [200, 'OK'];
}

function entryFor(pageref, call, d) {
  const url = urlFor(call, d);
  const u = safeURL(url);
  const reqText = d.body != null ? JSON.stringify(d.body) : null;
  const resObj = d.error ? { type: 'error', error: d.error } : d.response;
  const resText = resObj != null ? JSON.stringify(resObj) : '';
  const [status, statusText] = statusFor(call, d);
  const request = {
    method: call.method, url, httpVersion: 'HTTP/1.1', cookies: [],
    headers: Object.entries(d.requestHeaders || {}).filter(([, v]) => v).map(([name, value]) => ({ name, value: String(value) })),
    queryString: u ? [...u.searchParams].map(([name, value]) => ({ name, value })) : [],
    headersSize: -1, bodySize: bytes(reqText),
  };
  if (reqText != null) request.postData = { mimeType: 'application/json', text: reqText };
  const reqId = d.general && d.general['Request ID'];
  return {
    pageref,
    startedDateTime: new Date(call.startMs).toISOString(),
    time: Math.max(0, call.durationMs || 0),
    request,
    response: {
      status, statusText, httpVersion: 'HTTP/1.1', cookies: [],
      headers: reqId ? [{ name: 'request-id', value: reqId }] : [],
      content: { size: bytes(resText), mimeType: 'application/json', text: resText },
      redirectURL: '', headersSize: -1, bodySize: -1,
    },
    cache: {},
    timings: { blocked: -1, dns: -1, ssl: -1, connect: -1, send: 0, wait: Math.max(0, call.durationMs || 0), receive: 0 },
    _clogs: {
      reconstructed: true, summary: call, kind: d.kind, general: d.general, flags: d.flags || null,
      timing: d.timing, unresolved: d.unresolved || 0, truncated: !!d.truncated, legacy: !!d.legacy, error: d.error || null,
    },
  };
}

/** @param {{info: object, calls: object[], detail: (id: string) => object}[]} groups */
function buildHar(groups) {
  const pages = [];
  const entries = [];
  groups.forEach((g, i) => {
    if (!g.calls.length) return;
    const pageId = `page_${i + 1}_${String(g.info.sessionId || '').slice(0, 8)}`;
    pages.push({
      startedDateTime: new Date(Math.min(...g.calls.map((c) => c.startMs))).toISOString(),
      id: pageId,
      title: g.info.cwd ? `${g.info.title} — ${g.info.cwd}` : g.info.title,
      pageTimings: {},
      _clogs: { info: g.info },
    });
    for (const c of g.calls) {
      const d = g.detail(c.id);
      if (d) entries.push(entryFor(pageId, c, d));
    }
  });
  entries.sort((a, b) => Date.parse(a.startedDateTime) - Date.parse(b.startedDateTime));
  return { log: { version: '1.2', creator: { name: 'cLogs', version: VERSION }, pages, entries } };
}

// ---------- import ----------

function kindFromURL(u) {
  if (!u) return 'other';
  if (u.protocol === 'mcp:') return 'mcp';
  if (/(^|\.)anthropic\.com$/.test(u.hostname)) return 'api';
  return 'web';
}

class ImportedSession {
  constructor(key, page, entries, source) {
    this.key = key;
    this.page = page;
    this.entries = entries;
    this.source = source;
    this._calls = entries.map((e, i) => this._summary(e, i));
  }

  info() {
    const n = this.page && (ext(this.page) || {}).info;
    const first = this.entries[0];
    const last = this.entries[this.entries.length - 1];
    return {
      ...(n || {}),
      title: (n && n.title) || (this.page && this.page.title) || this.source,
      cwd: (n && n.cwd) || null,
      imported: this.source,
      first: first && first.startedDateTime,
      last: last && last.startedDateTime,
      agents: (n && n.agents) || [],
    };
  }

  _summary(e, i) {
    const id = `${this.key}|${i}`;
    const n = ext(e);
    if (n && n.summary) return { ...n.summary, id };
    const u = safeURL(e.request.url);
    const body = tryJSON(e.request.postData && e.request.postData.text);
    const res = tryJSON(e.response.content && e.response.content.text);
    const usage = res && typeof res === 'object' ? res.usage : null;
    const st = Number(e.response.status) || 0;
    return {
      id, kind: kindFromURL(u), method: e.request.method, host: u ? u.host : e.request.url,
      name: u ? u.pathname + u.search : e.request.url, url: e.request.url,
      source: 'imported', agentKey: 'main', model: (body && body.model) || (res && res.model) || null,
      status: st ? String(st) : (e.response._error || 'failed'),
      statusClass: !st || st >= 400 ? 'error' : st >= 300 ? 'warn' : 'ok',
      start: e.startedDateTime, startMs: Date.parse(e.startedDateTime), durationMs: e.time >= 0 ? e.time : null,
      tokensIn: usage ? (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) : null,
      tokensOut: usage ? usage.output_tokens ?? null : null,
      cacheRead: usage ? usage.cache_read_input_tokens || 0 : null,
      cacheWrite: usage ? usage.cache_creation_input_tokens || 0 : null,
      bytes: e.response.content && e.response.content.size >= 0 ? e.response.content.size : null,
    };
  }

  calls() { return this._calls; }

  detail(id) {
    const i = Number(id.split('|').pop());
    const e = this.entries[i];
    if (!e) return null;
    const n = ext(e) || {};
    const summary = this._calls[i];
    const toObj = (hs) => Object.fromEntries((hs || []).map((x) => [x.name, x.value]));
    const res = tryJSON(e.response.content && e.response.content.text);
    return {
      summary,
      kind: n.kind || summary.kind,
      legacy: n.legacy,
      general: n.general || {
        'Request URL': e.request.url, 'Request Method': e.request.method,
        Status: `${e.response.status} ${e.response.statusText || ''}`.trim(), 'Remote Address': e.serverIPAddress,
      },
      requestHeaders: toObj(e.request.headers),
      responseHeaders: toObj(e.response.headers),
      body: tryJSON(e.request.postData && e.request.postData.text),
      response: n.error ? null : (res === '' ? null : res),
      error: n.error || null,
      usage: res && typeof res === 'object' ? res.usage : null,
      timing: n.timing || { start: e.startedDateTime, end: new Date(Date.parse(e.startedDateTime) + (e.time || 0)).toISOString(), durationMs: e.time, blocks: [], har: e.timings },
      flags: n.flags || null,
      unresolved: n.unresolved || 0,
      truncated: n.truncated || false,
    };
  }
}

/** Parse a HAR document into one ImportedSession per page. */
function parseHar(json, source, keyPrefix) {
  const log = json && json.log;
  if (!log || !Array.isArray(log.entries)) throw new Error('Not a HAR file (missing log.entries)');
  const pages = new Map((log.pages || []).map((p) => [p.id, p]));
  const groups = new Map();
  for (const e of log.entries) {
    if (!e || !e.request || !e.response) continue;
    const k = e.pageref && pages.has(e.pageref) ? e.pageref : '__none__';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  let n = 0;
  const out = [];
  for (const [k, entries] of groups) {
    entries.sort((a, b) => Date.parse(a.startedDateTime) - Date.parse(b.startedDateTime));
    out.push(new ImportedSession(`${keyPrefix}:${n++}`, pages.get(k) || null, entries, source));
  }
  return out;
}

module.exports = { buildHar, parseHar };

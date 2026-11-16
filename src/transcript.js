'use strict';
/**
 * Incremental parser for one Claude Code transcript file (<session>.jsonl or a
 * subagent's agent-*.jsonl).
 *
 * Claude Code (>= 2.1.300) records every Messages API call it makes:
 *   api-request        { id, timestamp, params, shapeHash, base, keep, tail[], cacheControl[] }
 *   api-request-shape  { shapeHash, shape: { system, tools } }          (stored once)
 *   api-request-blob   { hash, message }                                 (stored once)
 *   assistant          { requestRef -> api-request.id, requestId, message: { content, usage, ... } }
 *
 * A request's messages are delta-encoded:
 *   messages(req) = messages(req.base).slice(0, req.keep) ++ req.tail.map(resolve)
 * where each tail entry is sha256(canonical JSON of the wire message). Messages
 * that already exist as transcript entries are not stored as blobs, so we
 * rebuild candidates (merged assistant blocks per request, merged runs of
 * user entries) and hash them to resolve the rest.
 */
const fsp = require('fs').promises;
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');

const CHUNK = 4 * 1024 * 1024;
const MAX_RUN = 40;

function canonicalJSON(v) {
  if (v === null || typeof v !== 'object') {
    const s = JSON.stringify(v);
    return s === undefined ? 'null' : s;
  }
  if (Array.isArray(v)) {
    return '[' + v.map((x) => (x === undefined ? 'null' : canonicalJSON(x))).join(',') + ']';
  }
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJSON(v[k])).join(',') + '}';
}

function hashMessage(m) {
  return crypto.createHash('sha256').update(canonicalJSON(m)).digest('hex');
}

const asBlocks = (c) => (Array.isArray(c) ? c : [{ type: 'text', text: String(c ?? '') }]);

class TranscriptFile {
  constructor(file, { key, source, agentType, agentDescription } = {}) {
    this.file = file;
    this.key = key || 'main';
    this.source = source || 'main';
    this.agentType = agentType || null;
    this.agentDescription = agentDescription || null;
    this.reset();
  }

  reset() {
    this.offset = 0;
    this.decoder = new StringDecoder('utf8');
    this.partial = '';
    this.seq = 0;
    this.blobs = new Map();
    this.shapes = new Map();
    this.requests = new Map();
    this.reqOrder = [];
    this.asstByRef = new Map();
    this.legacy = new Map();
    this.errors = [];
    this.toolUses = new Map();
    this.toolResults = new Map();
    this.runs = [];
    this.curRun = null;
    this.hashIndex = new Map();
    this.indexedRuns = 0;
    this.dirtyRefs = new Set();
    this.meta = {
      sessionId: null, cwd: null, gitBranch: null, version: null, entrypoint: null,
      title: null, firstPrompt: null, lastPrompt: null, first: null, last: null,
    };
  }

  /** Read whatever was appended since the last call. Returns true if anything changed. */
  async update() {
    let st;
    try { st = await fsp.stat(this.file); } catch { return false; }
    if (st.size < this.offset) this.reset();
    if (st.size === this.offset) return false;
    const fh = await fsp.open(this.file, 'r');
    try {
      const buf = Buffer.allocUnsafe(CHUNK);
      while (this.offset < st.size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, st.size - this.offset), this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        this._feed(this.decoder.write(buf.subarray(0, bytesRead)));
      }
    } finally {
      await fh.close();
    }
    // A final line without a trailing newline is complete once it parses.
    if (this.partial) {
      try { const o = JSON.parse(this.partial); this.partial = ''; this._ingest(o); } catch { /* still being written */ }
    }
    return true;
  }

  _feed(text) {
    const parts = (this.partial + text).split('\n');
    this.partial = parts.pop();
    for (const line of parts) {
      if (!line) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      this._ingest(o);
    }
  }

  _closeRun() {
    if (this.curRun) { this.runs.push(this.curRun); this.curRun = null; }
  }

  _ingest(o) {
    if (!o || typeof o !== 'object') return;
    const seq = this.seq++;
    const m = this.meta;
    if (o.timestamp) {
      if (!m.first || o.timestamp < m.first) m.first = o.timestamp;
      if (!m.last || o.timestamp > m.last) m.last = o.timestamp;
    }
    if (o.sessionId && !m.sessionId) m.sessionId = o.sessionId;
    if (o.cwd) m.cwd = m.cwd || o.cwd;
    if (o.gitBranch) m.gitBranch = o.gitBranch;
    if (o.version) m.version = o.version;
    if (o.entrypoint) m.entrypoint = o.entrypoint;

    switch (o.type) {
      case 'api-request-blob':
        if (o.hash) this.blobs.set(o.hash, o.message);
        break;
      case 'api-request-shape':
        if (o.shapeHash) this.shapes.set(o.shapeHash, o.shape || {});
        break;
      case 'api-request':
        this._closeRun();
        o._seq = seq;
        this.requests.set(o.id, o);
        this.reqOrder.push(o);
        break;
      case 'assistant':
        this._closeRun();
        this._ingestAssistant(o, seq);
        break;
      case 'user':
        this._ingestUser(o, seq);
        break;
      case 'ai-title':
        if (o.aiTitle) m.title = o.aiTitle;
        break;
      case 'last-prompt':
        if (o.lastPrompt) m.lastPrompt = o.lastPrompt;
        break;
      default:
        break;
    }
  }

  _ingestAssistant(o, seq) {
    const msg = o.message || {};
    o._seq = seq;
    if (o.isApiErrorMessage) {
      this.errors.push(o);
    } else if (o.requestRef) {
      let g = this.asstByRef.get(o.requestRef);
      if (!g) { g = []; this.asstByRef.set(o.requestRef, g); }
      g.push(o);
      this.dirtyRefs.add(o.requestRef);
    } else if (msg.model && msg.model !== '<synthetic>') {
      const k = o.requestId || msg.id || o.uuid;
      let g = this.legacy.get(k);
      if (!g) { g = []; this.legacy.set(k, g); }
      g.push(o);
    }
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (!b || typeof b !== 'object') continue;
      if ((b.type === 'tool_use' || b.type === 'server_tool_use') && b.id) {
        this.toolUses.set(b.id, { block: b, ts: o.timestamp, seq, requestRef: o.requestRef || null, requestId: o.requestId || null });
      } else if (b.tool_use_id && /_tool_result$/.test(b.type || '')) {
        // server tool results (web_search_tool_result, web_fetch_tool_result, ...)
        this.toolResults.set(b.tool_use_id, { block: b, ts: o.timestamp });
      }
    }
  }

  _ingestUser(o, seq) {
    const content = o.message ? o.message.content : undefined;
    if (content === undefined) return;
    if (!this.curRun) this.curRun = [];
    this.curRun.push(content);
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b && b.type === 'tool_result' && b.tool_use_id) {
          this.toolResults.set(b.tool_use_id, { block: b, ts: o.timestamp, toolUseResult: o.toolUseResult });
        }
      }
    }
    if (!this.meta.firstPrompt && !o.isMeta && !o.isSidechain) {
      const text = typeof content === 'string' ? content
        : (Array.isArray(content) && content.find((b) => b && b.type === 'text') || {}).text;
      if (text && !/^\s*<(command|local-command|system-reminder)/.test(text)) this.meta.firstPrompt = text.slice(0, 300);
    }
    void seq;
  }

  // ---------- message resolution ----------

  _indexRun(run) {
    for (let a = 0; a < run.length; a++) {
      if (typeof run[a] === 'string') {
        this.hashIndex.set(hashMessage({ role: 'user', content: run[a] }), { role: 'user', content: run[a] });
      }
      let merged = [];
      for (let b = a; b < run.length && b - a < MAX_RUN; b++) {
        merged = merged.concat(asBlocks(run[b]));
        const msg = { role: 'user', content: merged };
        this.hashIndex.set(hashMessage(msg), msg);
      }
    }
  }

  _ensureIndex() {
    for (; this.indexedRuns < this.runs.length; this.indexedRuns++) this._indexRun(this.runs[this.indexedRuns]);
    if (this.curRun) this._indexRun(this.curRun);
    for (const ref of this.dirtyRefs) {
      const g = this.asstByRef.get(ref) || [];
      const msg = { role: 'assistant', content: g.flatMap((e) => (e.message && e.message.content) || []) };
      this.hashIndex.set(hashMessage(msg), msg);
    }
    this.dirtyRefs.clear();
  }

  resolve(hash) {
    if (this.blobs.has(hash)) return this.blobs.get(hash);
    if (!this.hashIndex.has(hash)) this._ensureIndex();
    return this.hashIndex.get(hash) || null;
  }

  /** Rebuild the `messages` array that was sent for request `id`. */
  messagesFor(id) {
    const chain = [];
    const seen = new Set();
    let r = this.requests.get(id);
    let truncated = false;
    while (r && !seen.has(r.id)) {
      seen.add(r.id);
      chain.push(r);
      if (!r.base) break;
      const next = this.requests.get(r.base);
      if (!next) { truncated = true; break; }
      r = next;
    }
    let msgs = [];
    let unresolved = 0;
    for (let i = chain.length - 1; i >= 0; i--) {
      const req = chain[i];
      const kept = msgs.slice(0, req.keep || 0);
      if (kept.length < (req.keep || 0)) truncated = true;
      const tail = (req.tail || []).map((h) => {
        const m = this.resolve(h);
        if (m) return m;
        unresolved++;
        return { role: 'unknown', content: [{ type: 'text', text: `[not recoverable from transcript — sha256 ${h.slice(0, 16)}…]` }], _unresolved: true };
      });
      msgs = kept.concat(tail);
    }
    return { messages: msgs, unresolved, truncated };
  }
}

module.exports = { TranscriptFile, canonicalJSON, hashMessage };

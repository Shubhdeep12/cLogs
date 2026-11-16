'use strict';
/**
 * Live recorder. While recording, any Claude Code session whose transcript
 * changes is tracked; only calls that *start* inside a recording window are
 * captured. Earlier transcript content is still parsed (never shown) because
 * request bodies are delta-encoded against previous requests.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { listMainFiles, baseURLFor, mainFileFor } = require('./discover');
const { Session } = require('./session');

const POLL_MS = 1000;

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k]); }
  }));
}

class Recorder {
  constructor({ getRoots, onChange }) {
    this.getRoots = getRoots;
    this.onChange = onChange;
    this.recording = false;
    this.windows = [];
    this.sessions = new Map();
    this.baseline = new Map();
    this.dirty = new Set();
    this.watchers = [];
    this.timer = null;
    this.busy = null;
  }

  /** @param {{since?: number}} [opts] since: backdate the window start (testing). */
  async start(opts = {}) {
    if (this.recording) return;
    this.windows.push({ start: opts.since || Date.now(), end: null });
    this.recording = true;
    await this._snapshot();
    this._watch();
    this.timer = setInterval(() => this.tick(), POLL_MS);
    this.onChange(new Set());
    this.tick();
  }

  async stop() {
    if (!this.recording) return;
    await this.tick();
    this.recording = false;
    clearInterval(this.timer);
    this.timer = null;
    this._unwatch();
    this.windows[this.windows.length - 1].end = Date.now();
    this.onChange(new Set());
  }

  async clear() {
    if (this.busy) await this.busy;
    this.sessions.clear();
    this.windows = this.recording ? [{ start: Date.now(), end: null }] : [];
    if (this.recording) await this._snapshot();
    this.onChange(new Set());
  }

  async _snapshot() {
    this.baseline.clear();
    const files = await listMainFiles(this.getRoots());
    await pool(files, 32, async ({ file }) => {
      try { const st = await fsp.stat(file); this.baseline.set(file, st.size); } catch { /* gone */ }
    });
  }

  _watch() {
    this._unwatch();
    for (const root of this.getRoots()) {
      const projects = path.join(root, 'projects');
      try {
        // Recursive fs.watch: macOS, Windows, Linux (Node >= 20). Polling covers misses.
        this.watchers.push(fs.watch(projects, { recursive: true }, (_e, rel) => {
          const main = rel && mainFileFor(projects, rel);
          if (main) this.dirty.add(main);
        }));
      } catch { /* polling only */ }
    }
  }

  _unwatch() {
    for (const w of this.watchers.splice(0)) try { w.close(); } catch { /* ignore */ }
  }

  tick() {
    if (!this.recording) return Promise.resolve();
    if (this.busy) return this.busy;
    this.busy = this._tick().catch((e) => console.error('recorder tick', e)).finally(() => { this.busy = null; });
    return this.busy;
  }

  async _tick() {
    const cur = this.windows[this.windows.length - 1];
    const files = await listMainFiles(this.getRoots());
    const dirty = new Set(this.dirty);
    this.dirty.clear();
    await pool(files, 32, async ({ root, file }) => {
      if (this.sessions.has(file)) return;
      let st;
      try { st = await fsp.stat(file); } catch { return; }
      if (dirty.has(file) || this.baseline.get(file) !== st.size || st.mtimeMs >= cur.start) {
        const sess = new Session(file, { baseURL: baseURLFor(root) || undefined });
        sess.root = root;
        this.sessions.set(file, sess);
      }
    });
    const changed = new Set();
    for (const [file, s] of this.sessions) {
      try { if (await s.update()) changed.add(file); } catch (e) { console.error('update', file, e); }
    }
    if (changed.size) this.onChange(changed);
  }

  inWindows(ms) {
    return this.windows.some((w) => ms >= w.start && (w.end == null || ms < w.end));
  }

  captured(session) {
    return session.calls().filter((c) => Number.isFinite(c.startMs) && this.inWindows(c.startMs));
  }

  summaries() {
    const out = [];
    for (const [file, s] of this.sessions) {
      const calls = this.captured(s);
      if (!calls.length) continue;
      const info = s.info();
      out.push({
        key: file, title: info.title, cwd: info.cwd, sessionId: info.sessionId, root: s.root,
        count: calls.length, errors: calls.filter((c) => c.statusClass === 'error').length,
        lastMs: Math.max(...calls.map((c) => c.startMs + (c.durationMs || 0))),
      });
    }
    return out.sort((a, b) => b.lastMs - a.lastMs);
  }
}

module.exports = { Recorder };

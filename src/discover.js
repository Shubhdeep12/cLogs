'use strict';
/** Finds Claude Code config directories and their session transcript files. */
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

function candidateRoots(extra = []) {
  const home = os.homedir();
  const c = [path.join(home, '.claude'), path.join(home, '.config', 'claude')];
  try {
    for (const n of fs.readdirSync(home)) if (/^\.claude[-_.]/.test(n)) c.push(path.join(home, n));
  } catch { /* ignore */ }
  if (process.env.CLAUDE_CONFIG_DIR) c.push(process.env.CLAUDE_CONFIG_DIR);
  c.push(...extra);
  const seen = new Set();
  const out = [];
  for (const p of c) {
    const r = path.resolve(p);
    if (seen.has(r)) continue;
    seen.add(r);
    try { if (fs.statSync(path.join(r, 'projects')).isDirectory()) out.push(r); } catch { /* not a config dir */ }
  }
  return out;
}

/** ANTHROPIC_BASE_URL from the root's settings `env`, if configured there. */
function baseURLFor(root) {
  for (const f of ['settings.json', 'settings.local.json']) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
      if (s && s.env && s.env.ANTHROPIC_BASE_URL) return s.env.ANTHROPIC_BASE_URL;
    } catch { /* ignore */ }
  }
  return process.env.ANTHROPIC_BASE_URL || null;
}

/** Main session transcripts: <root>/projects/<project>/<session-id>.jsonl */
async function listMainFiles(roots) {
  const out = [];
  for (const root of roots) {
    const projects = path.join(root, 'projects');
    let dirs = [];
    try { dirs = await fsp.readdir(projects, { withFileTypes: true }); } catch { continue; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      let ents = [];
      try { ents = await fsp.readdir(path.join(projects, d.name), { withFileTypes: true }); } catch { continue; }
      for (const e of ents) if (e.isFile() && e.name.endsWith('.jsonl')) out.push({ root, file: path.join(projects, d.name, e.name) });
    }
  }
  return out;
}

/**
 * Map a path reported by fs.watch (relative to <root>/projects) to its main
 * session transcript, so subagent activity marks the parent session.
 */
function mainFileFor(projectsDir, rel) {
  const parts = String(rel).split(/[\\/]/).filter(Boolean);
  if (parts.length < 2 || !parts[parts.length - 1].endsWith('.jsonl')) return null;
  const sess = parts[1].endsWith('.jsonl') ? parts[1] : `${parts[1]}.jsonl`;
  return path.join(projectsDir, parts[0], sess);
}

module.exports = { candidateRoots, baseURLFor, listMainFiles, mainFileFor };

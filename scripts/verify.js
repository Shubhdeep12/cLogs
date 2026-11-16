#!/usr/bin/env node
'use strict';
/**
 * Parses every local session and reports how completely request payloads can be
 * reconstructed. Prints counts only — never transcript contents.
 *   node scripts/verify.js [--limit N]
 */
const { candidateRoots, baseURLFor, listMainFiles } = require('../src/discover');
const { Session } = require('../src/session');

(async () => {
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) : Infinity;
  const roots = candidateRoots();
  console.log('config roots:', roots.join(', '));
  let t = Date.now();
  const sessions = await listMainFiles(roots);
  console.log(`found ${sessions.length} session transcripts in ${Date.now() - t} ms`);

  const tot = { sessions: 0, api: 0, legacy: 0, tools: {}, msgs: 0, unresolved: 0, truncated: 0, withResponse: 0, errors: 0, failures: 0 };
  t = Date.now();
  for (const s of sessions.slice(0, limit)) {
    const sess = new Session(s.file, { baseURL: baseURLFor(s.root) });
    try {
      await sess.update();
      const calls = sess.calls();
      tot.sessions++;
      for (const c of calls) {
        if (c.kind === 'api') {
          if (c.legacy) { tot.legacy++; continue; }
          if (c.statusClass === 'error') tot.errors++;
          if (c.id.includes('|err|')) continue;
          tot.api++;
          const d = sess.detail(c.id);
          tot.msgs += d.body.messages.length;
          tot.unresolved += d.unresolved;
          if (d.truncated) tot.truncated++;
          if (d.response) tot.withResponse++;
        } else {
          tot.tools[c.kind] = (tot.tools[c.kind] || 0) + 1;
        }
      }
    } catch (e) {
      tot.failures++;
      console.error('FAILED', s.file, e.stack);
    }
  }
  console.log(`parsed in ${Date.now() - t} ms`);
  console.log(JSON.stringify(tot, null, 2));
  console.log(`message resolution: ${(100 * (1 - tot.unresolved / Math.max(1, tot.msgs))).toFixed(2)}%`);
  process.exit(tot.failures ? 1 : 0);
})();

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { canonicalJSON } = require('../src/transcript');
const { Session, classifyTool } = require('../src/session');
const { Recorder } = require('../src/recorder');
const { buildHar, parseHar } = require('../src/har');
const { buildTranscript, toJSONL } = require('./fixture');

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'calls-test-'));
  fs.mkdirSync(path.join(root, 'projects', '-work-demo'), { recursive: true });
  return root;
}

async function loadSession(lines) {
  const root = tmpRoot();
  const file = path.join(root, 'projects', '-work-demo', 'sess-0001.jsonl');
  fs.writeFileSync(file, toJSONL(lines));
  const s = new Session(file);
  await s.update();
  return { s, root, file };
}

test('canonicalJSON sorts keys and matches compact JSON', () => {
  assert.equal(canonicalJSON({ b: 1, a: [{ d: 'é', c: null }] }), '{"a":[{"c":null,"d":"é"}],"b":1}');
});

test('lists API calls, tool calls and errors in time order', async () => {
  const { s } = await loadSession(buildTranscript().lines);
  const calls = s.calls();
  const api = calls.filter((c) => c.kind === 'api');
  assert.equal(api.length, 3);
  assert.deepEqual(api.map((c) => c.status), ['tool_use', 'end_turn', '529']);
  assert.equal(api[2].statusClass, 'error');
  assert.equal(api[0].tokensIn, 100);
  const web = calls.find((c) => c.kind === 'web');
  assert.equal(web.host, 'example.com');
  assert.equal(web.status, '200');
  assert.equal(web.durationMs, 850);
  const mcp = calls.find((c) => c.kind === 'mcp');
  assert.equal(mcp.host, 'docs');
  assert.equal(mcp.name, 'search');
  assert.ok(calls.every((c, i) => i === 0 || calls[i - 1].startMs <= c.startMs));
});

test('rebuilds delta-encoded request bodies exactly', async () => {
  const { s } = await loadSession(buildTranscript().lines);
  const d1 = s.detail('main|api|r1');
  assert.equal(d1.body.messages.length, 1);
  assert.deepEqual(d1.body.messages[0], { role: 'user', content: [{ type: 'text', text: 'hello there' }] });
  assert.deepEqual(d1.body.system[1].cache_control, { type: 'ephemeral' });
  assert.equal(d1.requestHeaders['anthropic-beta'], 'beta-a,beta-b');
  assert.equal(d1.response.content.length, 3);

  const d2 = s.detail('main|api|r2');
  assert.equal(d2.unresolved, 0);
  assert.deepEqual(d2.body.messages.map((m) => m.role), ['user', 'assistant', 'user', 'system']);
  assert.equal(d2.body.messages[2].content.length, 2, 'parallel tool results merged');
  assert.deepEqual(d2.body.messages[2].content[1].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.equal(d2.body.messages[2].content[0].cache_control, undefined, 'cache control only at its path');
  assert.equal(d2.response.stop_reason, 'end_turn');

  const d3 = s.detail('main|api|r3');
  assert.equal(d3.body.messages.length, 6);
  assert.equal(d3.unresolved, 0);
  assert.equal(d3.error.status, 529);
});

test('picks up appended lines incrementally', async () => {
  const { lines } = buildTranscript();
  const cut = lines.findIndex((l) => l.id === 'r2');
  const { s, file } = await loadSession(lines.slice(0, cut));
  assert.equal(s.calls().filter((c) => c.kind === 'api').length, 1);
  const rest = toJSONL(lines.slice(cut));
  fs.appendFileSync(file, rest.slice(0, 40)); // partial line mid-write
  assert.equal(await s.update(), true);
  fs.appendFileSync(file, rest.slice(40));
  await s.update();
  s._calls = null;
  assert.equal(s.calls().filter((c) => c.kind === 'api').length, 3);
});

test('classifies only real HTTP commands in Bash', () => {
  const bash = (command) => classifyTool({ type: 'tool_use', name: 'Bash', input: { command } });
  assert.equal(bash("grep -oE 'https://[a-z]+' file"), null);
  assert.equal(bash('curl -s https://api.github.com/repos/x').host, 'api.github.com');
  assert.equal(bash('cd x && curl -X DELETE https://h.test/a').method, 'DELETE');
  assert.equal(bash('wget -q -O- https://h.test/f').method, 'GET');
});

test('HAR export → import round trip keeps payloads and responses', async () => {
  const { s } = await loadSession(buildTranscript().lines);
  const har = buildHar([{ info: s.info(), calls: s.calls(), detail: (id) => s.detail(id) }]);
  assert.equal(har.log.version, '1.2');
  assert.equal(har.log.pages.length, 1);
  assert.equal(har.log.entries.length, s.calls().length);
  for (const e of har.log.entries) {
    assert.ok(e.startedDateTime && e.request.url && typeof e.response.status === 'number' && e.timings);
  }
  const api = har.log.entries.find((e) => e.response.headers.some((h) => h.value === 'req_2'));
  assert.equal(api.response.status, 200);
  assert.equal(har.log.entries.find((e) => e._clogs.summary.status === '529').response.status, 529);

  const [imp] = parseHar(JSON.parse(JSON.stringify(har)), 'x.har', 'imp1');
  assert.equal(imp.calls().length, s.calls().length);
  const orig = s.detail('main|api|r2');
  const i = imp.calls().findIndex((c) => c.requestId === 'req_2');
  const back = imp.detail(imp.calls()[i].id);
  assert.deepEqual(back.body, orig.body);
  assert.deepEqual(back.response, orig.response);
  assert.equal(imp.info().title, 'Fixture session');
});

test('imports a generic (non-cLogs) HAR', () => {
  const har = { log: { version: '1.2', entries: [{
    startedDateTime: '2026-01-01T00:00:00.000Z', time: 42,
    request: { method: 'POST', url: 'https://api.anthropic.com/v1/messages', headers: [{ name: 'content-type', value: 'application/json' }], postData: { text: '{"model":"m","messages":[]}' } },
    response: { status: 200, statusText: 'OK', headers: [], content: { size: 2, text: '{"usage":{"input_tokens":3,"output_tokens":4}}' } },
    timings: { wait: 42 },
  }] } };
  const [imp] = parseHar(har, 'g.har', 'imp2');
  const [c] = imp.calls();
  assert.equal(c.kind, 'api');
  assert.equal(c.model, 'm');
  assert.equal(c.tokensOut, 4);
  assert.equal(imp.detail(c.id).body.model, 'm');
});

test('recorder captures only calls that start while recording', async () => {
  const root = tmpRoot();
  const file = path.join(root, 'projects', '-work-demo', 'sess-0001.jsonl');
  const now = Date.now();
  // history from an hour ago, then a new turn written after recording starts
  const old = buildTranscript(now - 3600 * 1000).lines;
  const cut = old.findIndex((l) => l.id === 'r3');
  fs.writeFileSync(file, toJSONL(old.slice(0, cut)));
  const fresh = buildTranscript(now + 1000).lines.slice(cut);
  const events = [];
  const rec = new Recorder({ getRoots: () => [root], onChange: (ch) => events.push(ch) });
  await rec.start();
  try {
    await rec.tick();
    assert.equal(rec.summaries().length, 0, 'nothing captured before new activity');
    fs.appendFileSync(file, toJSONL(fresh));
    await rec.tick();
    const [sum] = rec.summaries();
    assert.equal(sum.count, 1);
    assert.equal(sum.errors, 1);
    const [call] = rec.captured(rec.sessions.get(file));
    assert.equal(rec.sessions.get(file).detail(call.id).body.messages.length, 6, 'history used to rebuild the body');
  } finally {
    await rec.stop();
  }
  assert.equal(rec.recording, false);
  await rec.clear();
  assert.equal(rec.summaries().length, 0);
});

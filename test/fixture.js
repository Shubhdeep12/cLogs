'use strict';
/**
 * Builds a synthetic Claude Code transcript that exercises every path the
 * parser relies on: shapes, blobs, delta-encoded requests, messages resolved
 * by hashing transcript entries, merged parallel tool results, cache-control,
 * tool calls and an API error.
 */
const { hashMessage } = require('../src/transcript');

function buildTranscript(t0 = Date.parse('2026-01-01T10:00:00Z')) {
  const ts = (s) => new Date(t0 + s * 1000).toISOString();
  const sid = 'sess-0001';
  const shape = { system: [{ type: 'text', text: 'You are a test.' }, { type: 'text', text: 'Second block.' }], tools: [{ name: 'WebFetch', description: 'fetch', input_schema: { type: 'object' } }] };
  const lines = [];
  const push = (o) => lines.push({ sessionId: sid, ...o });

  // turn 1: user prompt as a plain transcript entry (wire form: wrapped text block)
  push({ type: 'user', uuid: 'u1', timestamp: ts(0), cwd: '/work/demo', message: { role: 'user', content: 'hello there' } });
  push({ type: 'api-request-shape', shapeHash: 'shape1', timestamp: ts(0), shape });
  const m1 = { role: 'user', content: [{ type: 'text', text: 'hello there' }] };
  push({
    type: 'api-request', id: 'r1', timestamp: ts(1), version: '2.1.325', querySource: 'repl_main_thread', shapeHash: 'shape1',
    params: { model: 'claude-test-1', betas: ['beta-a', 'beta-b'], max_tokens: 1000, thinking: { type: 'adaptive' } },
    keep: 0, tail: [hashMessage(m1)], cacheControl: [{ path: ['system', 1], value: { type: 'ephemeral' } }], requestDigest: 'x',
  });
  const a1 = [
    { type: 'thinking', thinking: 'let me fetch two pages', signature: 'sig' },
    { type: 'tool_use', id: 'toolu_1', name: 'WebFetch', input: { url: 'https://example.com/a?x=1' } },
    { type: 'tool_use', id: 'toolu_2', name: 'mcp__docs__search', input: { q: 'z' } },
  ];
  push({ type: 'assistant', uuid: 'a1a', timestamp: ts(2), requestRef: 'r1', requestId: 'req_1', message: { id: 'msg_1', model: 'claude-test-1', role: 'assistant', content: [a1[0]], stop_reason: null, usage: { input_tokens: 10, output_tokens: 5 } } });
  push({ type: 'assistant', uuid: 'a1b', timestamp: ts(3), requestRef: 'r1', requestId: 'req_1', message: { id: 'msg_1', model: 'claude-test-1', role: 'assistant', content: [a1[1], a1[2]], stop_reason: 'tool_use', usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 40 } } });
  // parallel tool results → two user entries, one wire message
  const tr1 = { type: 'tool_result', tool_use_id: 'toolu_1', content: 'page body' };
  const tr2 = { type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: 'result' }] };
  push({ type: 'user', uuid: 'u2', timestamp: ts(4), message: { role: 'user', content: [tr1] }, toolUseResult: { code: 200, codeText: 'OK', bytes: 9, durationMs: 850, url: 'https://example.com/a?x=1' } });
  push({ type: 'user', uuid: 'u3', timestamp: ts(5), message: { role: 'user', content: [tr2] } });
  // a message that only exists as a blob
  const sysMsg = { role: 'system', content: [{ type: 'text', text: 'reminder' }] };
  push({ type: 'api-request-blob', hash: hashMessage(sysMsg), message: sysMsg });

  // turn 2: delta-encoded on r1
  const a1msg = { role: 'assistant', content: a1 };
  const u23 = { role: 'user', content: [tr1, tr2] };
  push({
    type: 'api-request', id: 'r2', base: 'r1', keep: 1, timestamp: ts(6), version: '2.1.325', querySource: 'repl_main_thread', shapeHash: 'shape1',
    params: { model: 'claude-test-1', betas: ['beta-a'], max_tokens: 1000 },
    tail: [hashMessage(a1msg), hashMessage(u23), hashMessage(sysMsg)],
    cacheControl: [{ path: ['messages', 2, 'content', 1], value: { type: 'ephemeral', ttl: '1h' } }], requestDigest: 'y',
  });
  push({ type: 'assistant', uuid: 'a2', timestamp: ts(9), requestRef: 'r2', requestId: 'req_2', message: { id: 'msg_2', model: 'claude-test-1', role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 3 } } });

  // turn 3: fails
  push({ type: 'user', uuid: 'u4', timestamp: ts(10), message: { role: 'user', content: 'again' } });
  push({
    type: 'api-request', id: 'r3', base: 'r2', keep: 4, timestamp: ts(11), version: '2.1.325', querySource: 'repl_main_thread', shapeHash: 'shape1',
    params: { model: 'claude-test-1', betas: [], max_tokens: 1000 }, tail: [hashMessage({ role: 'assistant', content: [{ type: 'text', text: 'done' }] }), hashMessage({ role: 'user', content: 'again' })], cacheControl: [], requestDigest: 'z',
  });
  push({ type: 'assistant', uuid: 'e1', timestamp: ts(12), isApiErrorMessage: true, apiErrorStatus: 529, error: 'overloaded', message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'API Error' }] } });
  push({ type: 'ai-title', aiTitle: 'Fixture session' });

  return { lines, sid, t0, ts };
}

const toJSONL = (lines) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

module.exports = { buildTranscript, toJSONL };

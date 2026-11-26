// Illustrative data for the interactive demo. Everything here is made up:
// no real sessions, prompts, paths or request ids.

export type Kind = 'api' | 'mcp' | 'web';
export type Msg = { role: 'user' | 'assistant'; blocks: Block[] };
export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; text: string; error?: boolean };

export type Call = {
  id: string;
  kind: Kind;
  method: string;
  name: string;
  host: string;
  source: string; // 'main' or subagent type
  status: string;
  statusClass: 'ok' | 'warn' | 'error' | 'pending';
  at: number; // seconds since session start
  dur: number; // seconds
  tokensIn?: number;
  tokensOut?: number;
  cacheRead?: number;
  bytes?: number;
  requestId?: string;
  // detail
  input?: Record<string, unknown>; // tool calls
  result?: string; // tool calls
  messages?: Msg[]; // api: conversation sent
  response?: Msg; // api: what came back
  stop?: string;
  error?: string;
};

export type Session = {
  id: string;
  title: string;
  project: string;
  account: string;
  live?: boolean;
  calls: Call[];
};

const SYSTEM = ['You are Claude Code, an interactive CLI tool…', '# Environment\nWorking directory: …', '# Tools\n…'];
export const SYSTEM_PROMPT = SYSTEM;
export const TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'WebFetch', 'WebSearch', 'Agent', 'mcp__github__search_issues', 'mcp__linear__create_issue'];
export const BETAS = 'claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05';

const u = (text: string): Msg => ({ role: 'user', blocks: [{ type: 'text', text }] });

const checkout: Session = {
  id: 's1',
  title: 'Fix flaky checkout test',
  project: 'shop-api',
  account: '.claude',
  live: true,
  calls: [
    {
      id: 'c1', kind: 'api', method: 'POST', name: '/v1/messages', host: 'api.anthropic.com', source: 'main',
      status: 'tool_use', statusClass: 'ok', at: 0, dur: 3.12, tokensIn: 48210, tokensOut: 612, cacheRead: 41020, requestId: 'req_demo_01Ab', stop: 'tool_use',
      messages: [u('test_checkout_total fails about 1 in 5 runs on CI but never locally. Find out why and fix it.')],
      response: { role: 'assistant', blocks: [
        { type: 'thinking', text: 'Intermittent failures that only show up on CI usually mean shared state or ordering. Run the test many times first.' },
        { type: 'text', text: "I'll reproduce it first by running the test repeatedly." },
        { type: 'tool_use', name: 'Bash', input: { command: 'pytest tests/test_checkout.py::test_checkout_total -p no:randomly --count=30 -q' } },
      ] },
    },
    {
      id: 'c2', kind: 'mcp', method: 'MCP', name: 'search_issues', host: 'github', source: 'main',
      status: 'ok', statusClass: 'ok', at: 4.6, dur: 1.4,
      input: { repo: 'acme/shop-api', query: 'flaky checkout test', state: 'all' },
      result: '#412  test_checkout_total flaky on CI (open)\n#377  Cart fixture leaks between tests (closed, "wontfix for now")',
    },
    {
      id: 'c3', kind: 'api', method: 'POST', name: '/v1/messages', host: 'api.anthropic.com', source: 'main',
      status: 'tool_use', statusClass: 'ok', at: 6.3, dur: 2.71, tokensIn: 51034, tokensOut: 388, cacheRead: 48100, requestId: 'req_demo_02Cd', stop: 'tool_use',
      messages: [
        u('test_checkout_total fails about 1 in 5 runs on CI but never locally. Find out why and fix it.'),
        { role: 'assistant', blocks: [{ type: 'tool_use', name: 'Bash', input: { command: 'pytest … --count=30 -q' } }] },
        { role: 'user', blocks: [{ type: 'tool_result', text: '24 passed, 6 failed\nAssertionError: assert 59.97 == 39.98' }] },
      ],
      response: { role: 'assistant', blocks: [
        { type: 'text', text: 'Reproduced: 6 of 30 runs fail with an extra item in the cart. Issue #377 mentions a leaking cart fixture. Checking how pytest scopes fixtures.' },
        { type: 'tool_use', name: 'WebFetch', input: { url: 'https://docs.pytest.org/en/stable/how-to/fixtures.html' } },
      ] },
    },
    {
      id: 'c4', kind: 'web', method: 'GET', name: '/en/stable/how-to/fixtures.html', host: 'docs.pytest.org', source: 'main',
      status: '200', statusClass: 'ok', at: 9.4, dur: 0.86, bytes: 86120,
      input: { url: 'https://docs.pytest.org/en/stable/how-to/fixtures.html', prompt: 'How do fixture scopes work?' },
      result: 'Fixtures with scope="module" are created once per test module and shared by every test in it…',
    },
    {
      id: 'c5', kind: 'api', method: 'POST', name: '/v1/messages', host: 'api.anthropic.com', source: 'main',
      status: 'tool_use', statusClass: 'ok', at: 10.9, dur: 6.4, tokensIn: 58466, tokensOut: 1904, cacheRead: 51800, requestId: 'req_demo_03Ef', stop: 'tool_use',
      messages: [u('… 5 earlier messages …'), { role: 'user', blocks: [{ type: 'tool_result', text: 'Fixtures with scope="module" are created once per test module…' }] }],
      response: { role: 'assistant', blocks: [
        { type: 'thinking', text: 'cart is module-scoped, so items added by test_apply_coupon survive into test_checkout_total when CI runs tests in parallel workers with a different order.' },
        { type: 'text', text: 'Found it: the `cart` fixture is module-scoped, so items from other tests leak in depending on run order. Making it function-scoped.' },
        { type: 'tool_use', name: 'Edit', input: { file_path: 'tests/conftest.py', old_string: '@pytest.fixture(scope="module")\ndef cart():', new_string: '@pytest.fixture\ndef cart():' } },
      ] },
    },
    {
      id: 'c6', kind: 'api', method: 'POST', name: '/v1/messages', host: 'api.anthropic.com', source: 'main',
      status: 'end_turn', statusClass: 'ok', at: 19.2, dur: 2.2, tokensIn: 61190, tokensOut: 420, cacheRead: 58300, requestId: 'req_demo_04Gh', stop: 'end_turn',
      messages: [u('… 7 earlier messages …'), { role: 'user', blocks: [{ type: 'tool_result', text: '30 passed in 4.81s' }] }],
      response: { role: 'assistant', blocks: [
        { type: 'text', text: 'Fixed. `cart` in tests/conftest.py was module-scoped, so other tests\' items leaked into test_checkout_total whenever CI ran them first. It\'s function-scoped now, and 30 repeated runs all pass.' },
      ] },
    },
  ],
};

const migration: Session = {
  id: 's2',
  title: 'Draft v2 migration plan',
  project: 'platform',
  account: '.claude-work',
  calls: [
    {
      id: 'm1', kind: 'api', method: 'POST', name: '/v1/messages', host: 'api.anthropic.com', source: 'main',
      status: 'tool_use', statusClass: 'ok', at: 0, dur: 4.1, tokensIn: 22400, tokensOut: 540, cacheRead: 0, requestId: 'req_demo_11Aa', stop: 'tool_use',
      messages: [u('Draft a migration plan for moving the billing service to the v2 API. Look at how v1 is used first.')],
      response: { role: 'assistant', blocks: [
        { type: 'text', text: "I'll send an Explore agent through the codebase to map every v1 call site." },
        { type: 'tool_use', name: 'Agent', input: { subagent_type: 'Explore', description: 'Map billing v1 API usage' } },
      ] },
    },
    {
      id: 'm2', kind: 'api', method: 'POST', name: '/v1/messages', host: 'api.anthropic.com', source: 'Explore',
      status: 'tool_use', statusClass: 'ok', at: 4.8, dur: 2.3, tokensIn: 9100, tokensOut: 210, cacheRead: 6800, requestId: 'req_demo_11Bb', stop: 'tool_use',
      messages: [u('Map billing v1 API usage: list every call site, grouped by endpoint.')],
      response: { role: 'assistant', blocks: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'billing\\.v1\\.', glob: '**/*.ts' } }] },
    },
    {
      id: 'm3', kind: 'api', method: 'POST', name: '/v1/messages', host: 'api.anthropic.com', source: 'Explore',
      status: 'end_turn', statusClass: 'ok', at: 7.9, dur: 3.6, tokensIn: 14800, tokensOut: 860, cacheRead: 9050, requestId: 'req_demo_11Cc', stop: 'end_turn',
      messages: [u('Map billing v1 API usage…'), { role: 'user', blocks: [{ type: 'tool_result', text: '23 matches in 9 files' }] }],
      response: { role: 'assistant', blocks: [{ type: 'text', text: '23 call sites across 9 files. Most go through `invoices.create` (11) and `subscriptions.update` (7).' }] },
    },
    {
      id: 'm4', kind: 'api', method: 'POST', name: '/v1/messages', host: 'api.anthropic.com', source: 'main',
      status: 'end_turn', statusClass: 'ok', at: 12.4, dur: 9.8, tokensIn: 27350, tokensOut: 3120, cacheRead: 22100, requestId: 'req_demo_11Dd', stop: 'end_turn',
      messages: [u('… 3 earlier messages …')],
      response: { role: 'assistant', blocks: [{ type: 'text', text: '## Billing v2 migration\n1. Add a v2 client behind a flag\n2. Move invoices.create (11 call sites)\n3. Move subscriptions.update (7)\n4. Dual-write for one billing cycle, then remove v1' }] },
    },
  ],
};

const triage: Session = {
  id: 's3',
  title: 'Agent SDK: nightly triage',
  project: 'triage-bot',
  account: '.claude',
  calls: [
    {
      id: 't1', kind: 'api', method: 'POST', name: '/v1/messages', host: 'api.anthropic.com', source: 'sdk',
      status: '529', statusClass: 'error', at: 0, dur: 0.6, requestId: 'req_demo_21Aa', error: 'overloaded_error: Overloaded',
      messages: [u('Triage the 12 issues opened in the last 24h. Label them and file the bugs in Linear.')],
    },
    {
      id: 't2', kind: 'api', method: 'POST', name: '/v1/messages', host: 'api.anthropic.com', source: 'sdk',
      status: 'tool_use', statusClass: 'ok', at: 2.1, dur: 5.2, tokensIn: 18800, tokensOut: 1210, cacheRead: 0, requestId: 'req_demo_21Bb', stop: 'tool_use',
      messages: [u('Triage the 12 issues opened in the last 24h. Label them and file the bugs in Linear.')],
      response: { role: 'assistant', blocks: [
        { type: 'text', text: '3 of the 12 are real bugs. Filing the first one.' },
        { type: 'tool_use', name: 'mcp__linear__create_issue', input: { team: 'SHOP', title: 'Coupon total rounds down for EUR', priority: 2 } },
      ] },
    },
    {
      id: 't3', kind: 'mcp', method: 'MCP', name: 'create_issue', host: 'linear', source: 'sdk',
      status: 'ok', statusClass: 'ok', at: 7.6, dur: 0.9,
      input: { team: 'SHOP', title: 'Coupon total rounds down for EUR', priority: 2 },
      result: 'Created SHOP-1042',
    },
  ],
};

export const SESSIONS: Session[] = [checkout, migration, triage];

/** Requests that stream into the first session while the demo is "recording". */
export const LIVE_SCRIPT: Omit<Call, 'id' | 'at'>[] = [
  {
    kind: 'api', method: 'POST', name: '/v1/messages', host: 'api.anthropic.com', source: 'main',
    status: 'tool_use', statusClass: 'ok', dur: 2.8, tokensIn: 62800, tokensOut: 290, cacheRead: 61000, requestId: 'req_demo_05Ij', stop: 'tool_use',
    messages: [u('Nice. Can you also add a regression test so this can\'t come back?')],
    response: { role: 'assistant', blocks: [
      { type: 'text', text: "I'll add a test that runs after test_apply_coupon and asserts the cart starts empty." },
      { type: 'tool_use', name: 'Write', input: { file_path: 'tests/test_cart_isolation.py' } },
    ] },
  },
  {
    kind: 'web', method: 'SEARCH', name: 'pytest-randomly order seed', host: 'web search', source: 'main',
    status: 'ok', statusClass: 'ok', dur: 1.9,
    input: { query: 'pytest-randomly order seed' },
    result: '1. pytest-randomly · PyPI\n2. Reproducing a random test order with -p randomly -p "seed=…"',
  },
  {
    kind: 'api', method: 'POST', name: '/v1/messages', host: 'api.anthropic.com', source: 'main',
    status: 'end_turn', statusClass: 'ok', dur: 3.4, tokensIn: 64100, tokensOut: 512, cacheRead: 62700, requestId: 'req_demo_06Kl', stop: 'end_turn',
    messages: [u('… 11 earlier messages …')],
    response: { role: 'assistant', blocks: [{ type: 'text', text: 'Added tests/test_cart_isolation.py. It runs with a fixed random seed so the order that used to fail is now covered on every CI run.' }] },
  },
];

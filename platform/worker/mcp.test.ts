import { env } from 'cloudflare:test';
import { SELF } from 'cloudflare:test';
import { hashPassword } from './auth';
import { hashAgentKey } from './mcp';
import { signAppletToken } from './tokens';
import { setGithubClient } from './github-bind';
import { GitHubClient } from './github';
import { vi } from 'vitest';

let adminCookie: string;

async function login(username: string): Promise<string> {
  const r = await SELF.fetch('https://x/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'pw-123456' }),
  });
  return r.headers.get('set-cookie')!.split(';')[0];
}

async function seedUser(username: string, role: string): Promise<number> {
  const hash = await hashPassword('pw-123456');
  return (await env.DB.prepare(`INSERT INTO t_users (username, password_hash, role) VALUES (?, ?, ?) RETURNING id`)
    .bind(username, hash, role).first<{ id: number }>())!.id;
}

async function makeAccessCode(): Promise<string> {
  const r = await SELF.fetch('https://x/api/admin/access-codes', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: adminCookie }, body: '{}',
  });
  expect(r.status).toBe(201);
  return (await r.json() as any).code;
}

async function rpc(body: any, key?: string): Promise<Response> {
  return SELF.fetch('https://x/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });
}

async function callTool(name: string, args: any, key: string): Promise<any> {
  const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, key);
  const json: any = await r.json();
  return { status: r.status, json };
}

function toolResult(json: any): any {
  // tools/call 结果包裹在 content[0].text
  return JSON.parse(json.result.content[0].text);
}

beforeAll(async () => {
  const { results } = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='t_users'`).all();
  if (results.length === 0) {
    const { applySchema } = await import('./db/apply');
    await applySchema(env.DB);
  }
  await seedUser('boss11', 'admin');
  adminCookie = await login('boss11');
});

beforeEach(async () => {
  setGithubClient(null);
  await env.DB.exec(`DELETE FROM t_audit_logs WHERE action LIKE 'agent.%'`);
});

const GOOD_FILES = {
  'applet.json': JSON.stringify({
    id: 'mcapp', name: 'MCP 应用', icon: '🔌', entry: 'index.html', version: '1.0.0',
    tables: [{ name: 'items', columns: [{ name: 'title', type: 'text' }] }],
  }),
  'index.html': '<html><script src="/app-runtime.js"></script></html>',
  'main.js': 'console.log("hi");',
};

describe('protocol', () => {
  it('401 without authorization', async () => {
    const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(r.status).toBe(401);
  });

  it('initialize returns protocolVersion and tool capabilities', async () => {
    const code = await makeAccessCode();
    const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, code);
    expect(r.status).toBe(200);
    const json: any = await r.json();
    expect(json.result.protocolVersion).toBeDefined();
    expect(json.result.capabilities.tools).toEqual({});
  });

  it('notifications/initialized returns 204', async () => {
    const code = await makeAccessCode();
    const r = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, code);
    expect(r.status).toBe(204);
  });

  it('unknown method → -32601; bad JSON → -32700', async () => {
    const code = await makeAccessCode();
    const r1 = await rpc({ jsonrpc: '2.0', id: 2, method: 'bogus/method' }, code);
    expect((await r1.json() as any).error.code).toBe(-32601);
    const r2 = await SELF.fetch('https://x/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${code}` },
      body: 'not json',
    });
    expect((await r2.json() as any).error.code).toBe(-32700);
  });

  it('tools/list exposes the four tools', async () => {
    const code = await makeAccessCode();
    const r = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, code);
    const json: any = await r.json();
    const names = json.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(['agent_apply', 'check_applet', 'get_spec', 'get_status', 'submit_applet'].sort());
  });
});

describe('agent access flow', () => {
  it('access_code applies once, then rejected', async () => {
    const code = await makeAccessCode();
    const { status, json } = await callTool('agent_apply', { name: 'claude-dev', fingerprint: 'fp-abc-1' }, code);
    expect(status).toBe(200);
    const out = toolResult(json);
    expect(out.ok).toBe(true);
    expect(out.status).toBe('pending');

    const row = await env.DB.prepare(`SELECT id, status, fingerprint FROM t_agents WHERE name='claude-dev'`).first<any>();
    expect(row.status).toBe('pending');
    expect(row.fingerprint).toBe('fp-abc-1');

    const used = await env.DB.prepare(`SELECT used_by FROM t_agent_access_codes WHERE code=?`).bind(code).first<any>();
    expect(used.used_by).toBe(row.id);

    // 二次用同码 403
    const again = await callTool('agent_apply', { name: 'claude-dev-2', fingerprint: 'fp-x' }, code);
    expect(again.status).toBe(403);
  });

  it('access_code cannot call other tools; api_key cannot call agent_apply', async () => {
    const code = await makeAccessCode();
    const wrong = await callTool('get_spec', { section: 'all' }, code);
    expect(wrong.status).toBe(403);

    const key = 'mk-' + 'x'.repeat(40);
    const hash = await hashAgentKey(key);
    await env.DB.prepare(`INSERT INTO t_agents (name, fingerprint, key_hash, status) VALUES ('pending-agent', 'fp-p', ?, 'pending')`).bind(hash).run();
    const denied = await callTool('agent_apply', { name: 'x', fingerprint: 'y' }, key);
    expect(denied.status).toBe(403);
  });
});

describe('submit flow (approved agent)', () => {
  let agentKey: string;
  let agentId: number;

  beforeAll(async () => {
    // 生成码 → apply → approve → 拿明文 key
    const code = await makeAccessCode();
    await callTool('agent_apply', { name: 'builder', fingerprint: 'fp-build-9' }, code);
    agentId = (await env.DB.prepare(`SELECT id FROM t_agents WHERE name='builder'`).first<any>()).id;
    const r = await SELF.fetch(`https://x/api/admin/agents/${agentId}/approve`, {
      method: 'POST', headers: { cookie: adminCookie }, body: '{}',
    });
    expect(r.status).toBe(200);
    agentKey = (await r.json() as any).key;
  });

  function makeGithubStub() {
    const openPR = vi.fn(async () => 42);
    const putFiles = vi.fn(async () => 'newsha');
    const getHeadSha = vi.fn(async () => null);
    const gh = {
      getHeadSha, putFiles, openPR,
      async getTree() { return []; },
      async getContent() { return null; },
      async getPR(num: number) { return { state: 'open' as const, head: 'applet/mcapp', mergeable: true }; },
      async mergePR() {},
      async deleteDir() { return 'x'; },
    } as unknown as GitHubClient;
    return { gh, openPR, putFiles };
  }

  it('pending agent key cannot submit (403 AGENT_NOT_APPROVED)', async () => {
    const code = await makeAccessCode();
    await callTool('agent_apply', { name: 'still-pending', fingerprint: 'fp-sp' }, code);
    const pendingId = (await env.DB.prepare(`SELECT id FROM t_agents WHERE name='still-pending'`).first<any>()).id;
    const hash = await hashAgentKey('pk-' + 'y'.repeat(40));
    await env.DB.prepare(`UPDATE t_agents SET key_hash=? WHERE id=?`).bind(hash, pendingId).run();

    const r = await callTool('submit_applet', { applet_id: 'someapp', name: 'Some', files: GOOD_FILES }, 'pk-' + 'y'.repeat(40));
    expect(r.status).toBe(403);
    expect(toolResult(r.json).error).toBe('AGENT_NOT_APPROVED');
  });

  it('approved agent submits → PR opened, author fingerprinted, ownership recorded', async () => {
    const { gh, openPR, putFiles } = makeGithubStub();
    setGithubClient(gh);

    const { status, json } = await callTool('submit_applet', { applet_id: 'mcapp', name: 'MCP 应用', files: GOOD_FILES }, agentKey);
    expect(status).toBe(200);
    const out = toolResult(json);
    expect(out.pr_number).toBe(42);

    expect(openPR).toHaveBeenCalledTimes(1);
    expect(putFiles).toHaveBeenCalledTimes(1);
    const calls = putFiles.mock.calls as unknown as any[][];
    const author = calls[0]![3] as { name: string; email: string };
    expect(author.name).toBe(`applet-agent[${agentId}]`);

    const pr = await env.DB.prepare(`SELECT state, branch FROM t_prs WHERE applet_id=(SELECT id FROM t_applets WHERE path='mcapp')`).first<any>();
    expect(pr.state).toBe('open');
    expect(pr.branch).toBe('applet/mcapp');

    const own = await env.DB.prepare(`SELECT source FROM t_agent_applets WHERE agent_id=? AND applet_id=(SELECT id FROM t_applets WHERE path='mcapp')`).bind(agentId).first<any>();
    expect(own.source).toBe('submitted');

    const audit = await env.DB.prepare(`SELECT action FROM t_audit_logs WHERE action='agent.submit'`).all();
    expect(audit.results.length).toBe(1);
  });

  it('re-submit updates same branch, no new PR', async () => {
    const { gh, openPR, putFiles } = makeGithubStub();
    setGithubClient(gh);

    await callTool('submit_applet', { applet_id: 'mcapp', name: 'MCP 应用', files: GOOD_FILES }, agentKey);
    expect(openPR).not.toHaveBeenCalled();
    expect(putFiles).toHaveBeenCalledTimes(1);
  });

  it('other agent cannot submit an owned applet (403 AGENT_SCOPE)', async () => {
    // 第二个 agent：apply + approve
    const code = await makeAccessCode();
    await callTool('agent_apply', { name: 'other', fingerprint: 'fp-other' }, code);
    const otherId = (await env.DB.prepare(`SELECT id FROM t_agents WHERE name='other'`).first<any>()).id;
    const r = await SELF.fetch(`https://x/api/admin/agents/${otherId}/approve`, { method: 'POST', headers: { cookie: adminCookie }, body: '{}' });
    const otherKey = (await r.json() as any).key;

    const res = await callTool('submit_applet', { applet_id: 'mcapp', name: 'MCP 应用', files: GOOD_FILES }, otherKey);
    expect(res.status).toBe(403);
    expect(toolResult(res.json).error).toBe('AGENT_SCOPE');
  });

  it('git failure returns GIT_SUBMIT_FAILED and rolls back orphan rows', async () => {
    // 新 agent + 新 applet，putFiles 故意抛错（模拟 GitHub 故障）
    const code = await makeAccessCode();
    await callTool('agent_apply', { name: 'rollback-agent', fingerprint: 'fp-rb' }, code);
    const rid = (await env.DB.prepare(`SELECT id FROM t_agents WHERE name='rollback-agent'`).first<any>()).id;
    const r0 = await SELF.fetch(`https://x/api/admin/agents/${rid}/approve`, { method: 'POST', headers: { cookie: adminCookie }, body: '{}' });
    const rk = (await r0.json() as any).key;

    setGithubClient({
      async getTree() { return []; },
      async getContent() { return null; },
      async getHeadSha() { return null; },
      async putFiles() { throw new Error('github down'); },
      async openPR() { return 1; },
      async getPR() { return { state: 'open' as const, head: 'x', mergeable: true }; },
      async mergePR() {},
      async deleteDir() { return 'x'; },
    } as unknown as GitHubClient);

    const rbFiles = { ...GOOD_FILES, 'applet.json': (GOOD_FILES['applet.json'] as string).replace('mcapp', 'rb-app') };
    const res = await callTool('submit_applet', { applet_id: 'rb-app', name: 'RB', files: rbFiles }, rk);
    expect(res.status).toBe(403); // 工具级拒绝（JSON-RPC result 包裹，HTTP 语义同 AGENT_SCOPE 等）
    expect(toolResult(res.json).error).toBe('GIT_SUBMIT_FAILED');
    // 无孤儿行：applet 未注册
    const row = await env.DB.prepare(`SELECT id FROM t_applets WHERE path='rb-app'`).first();
    expect(row).toBeNull();
    // 同 agent 换好的 mock 重试应成功建立归属（不再撞 AGENT_SCOPE）
    const { gh: goodGh } = makeGithubNoop();
    setGithubClient(goodGh);
    const res2 = await callTool('submit_applet', { applet_id: 'rb-app', name: 'RB', files: rbFiles }, rk);
    expect(toolResult(res2.json).pr_number).toBe(1);
  });

  it('revoked key is rejected immediately (Review Focus 3)', async () => {
    const r = await SELF.fetch(`https://x/api/admin/agents/${agentId}/revoke`, { method: 'POST', headers: { cookie: adminCookie }, body: '{}' });
    expect(r.status).toBe(200);
    const res = await callTool('get_spec', { section: 'all' }, agentKey);
    expect(res.status).toBe(401);
  });

  it('applet token cannot reach admin API (Review Focus 4)', async () => {
    const token = await signAppletToken({ userId: 1, appletId: 'mcapp', exp: Math.floor(Date.now() / 1000) + 600 }, 'test-signing-key');
    const r = await SELF.fetch('https://x/api/admin/users', { headers: { authorization: `Bearer ${token}` } });
    expect(r.status).toBe(401);
  });
});

describe('tools', () => {
  let toolerKey: string;
  beforeAll(async () => {
    // 专用已批准 agent（builder 的 key 在 revoke 用例中已吊销，不能复用）
    const code = await makeAccessCode();
    await callTool('agent_apply', { name: 'tooler', fingerprint: 'fp-tooler' }, code);
    const id = (await env.DB.prepare(`SELECT id FROM t_agents WHERE name='tooler'`).first<any>()).id;
    const r = await SELF.fetch(`https://x/api/admin/agents/${id}/approve`, { method: 'POST', headers: { cookie: adminCookie }, body: '{}' });
    toolerKey = (await r.json() as any).key;
  });

  it('check_applet returns issues without creating PR', async () => {
    const bad = { ...GOOD_FILES, 'main.js': 'eval("x");' };
    const { status, json } = await callTool('check_applet', { applet_id: 'chkapp', files: bad }, toolerKey);
    expect(status).toBe(200);
    const out = toolResult(json);
    expect(out.issues.some((i: any) => i.rule === 'security.dynamic')).toBe(true);
  });

  it('get_spec returns section text', async () => {
    const { status, json } = await callTool('get_spec', { section: 'security' }, toolerKey);
    expect(status).toBe(200);
    const out = toolResult(json);
    expect(out.section).toBe('security');
    expect(out.text).toContain('安全红线');
  });

  it('submit with eval returns issues, no PR (mock untouched)', async () => {
    const { gh } = makeGithubNoop();
    setGithubClient(gh);
    // 新 agent（未归属任何 applet）直接提交含 eval 的 mcapp2
    const code = await makeAccessCode();
    await callTool('agent_apply', { name: 'sloppy', fingerprint: 'fp-sloppy' }, code);
    const id = (await env.DB.prepare(`SELECT id FROM t_agents WHERE name='sloppy'`).first<any>()).id;
    const r = await SELF.fetch(`https://x/api/admin/agents/${id}/approve`, { method: 'POST', headers: { cookie: adminCookie }, body: '{}' });
    const key = (await r.json() as any).key;

    const bad = { ...GOOD_FILES, 'applet.json': GOOD_FILES['applet.json'].replace('mcapp', 'mcapp2'), 'main.js': 'eval("x");' };
    const { status, json } = await callTool('submit_applet', { applet_id: 'mcapp2', name: 'X', files: bad }, key);
    expect(status).toBe(200);
    expect(toolResult(json).issues.some((i: any) => i.rule === 'security.dynamic')).toBe(true);
    const prs = await env.DB.prepare(`SELECT * FROM t_prs WHERE applet_id=(SELECT id FROM t_applets WHERE path='mcapp2')`).all();
    expect(prs.results).toHaveLength(0);
  });
});

function makeGithubNoop() {
  const gh = {
    async getTree() { return []; },
    async getContent() { return null; },
    async getHeadSha() { return null; },
    async putFiles() { return 's'; },
    async openPR() { return 1; },
    async getPR() { return { state: 'open' as const, head: 'x', mergeable: true }; },
    async mergePR() {},
    async deleteDir() { return 'x'; },
  } as unknown as GitHubClient;
  return { gh };
}

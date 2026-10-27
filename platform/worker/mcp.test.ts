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

  it('tools/list exposes the six tools', async () => {
    const code = await makeAccessCode();
    const r = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, code);
    const json: any = await r.json();
    const names = json.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(['agent_apply', 'check_applet', 'get_spec', 'get_status', 'submit_applet', 'import_data'].sort());
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
    // import_data 的默认归属用户 admin 需要 t_users 行（本文件隔离存储，Task 3 的 setup 不覆盖这里）
    const { hashPassword } = await import('./auth');
    const seedHash = await hashPassword('seed-pw-123');
    await env.DB.prepare(`INSERT OR IGNORE INTO t_users (username, password_hash, role) VALUES ('admin', ?, 'superadmin')`).bind(seedHash).run();
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

  it('resubmit with large files onto existing branch (prod 500 reproduction)', async () => {
    // 生产路径：占位 PR 已存在（closed）→ openPR 复用 → 更新分支。大文件集（>100KB 明文）
    const code = await makeAccessCode();
    await callTool('agent_apply', { name: 'big-payload', fingerprint: 'fp-big' }, code);
    const bid = (await env.DB.prepare(`SELECT id FROM t_agents WHERE name='big-payload'`).first<any>()).id;
    const r0 = await SELF.fetch(`https://x/api/admin/agents/${bid}/approve`, { method: 'POST', headers: { cookie: adminCookie }, body: '{}' });
    const bk = (await r0.json() as any).key;

    const bigBody = 'x'.repeat(60_000);
    const files = {
      'applet.json': (GOOD_FILES['applet.json'] as string).replace('mcapp', 'bigapp'),
      'index.html': GOOD_FILES['index.html'],
      'big.js': `/* ${bigBody} */`,
    };
    const { gh, putFiles, openPR } = makeGithubStub();
    setGithubClient(gh);
    const res = await callTool('submit_applet', { applet_id: 'bigapp', name: 'Big', files }, bk);
    expect(res.status).toBe(200);
    expect(toolResult(res.json).pr_number).toBe(42); // stub 默认值；断言重点是流程走通
    expect(putFiles).toHaveBeenCalledTimes(1);
  });

  it('openPR 422 (historical PR on branch) triggers branch rebuild + retry', async () => {
    const code = await makeAccessCode();
    await callTool('agent_apply', { name: 'rebuild-agent', fingerprint: 'fp-rb2' }, code);
    const rid = (await env.DB.prepare(`SELECT id FROM t_agents WHERE name='rebuild-agent'`).first<any>()).id;
    const r0 = await SELF.fetch(`https://x/api/admin/agents/${rid}/approve`, { method: 'POST', headers: { cookie: adminCookie }, body: '{}' });
    const rk = (await r0.json() as any).key;

    let openPRCalls = 0;
    const gh = {
      async getTree() { return []; },
      async getContent() { return null; },
      async getHeadSha() { return null; },
      async putFiles() { return 'sha-' + ++openPRCalls; },
      async openPR() { openPRCalls++; if (openPRCalls <= 2) throw new Error('openPR: HTTP 422 already exists'); return 30; },
      async deleteBranch() { return; },
      async getPR() { return { state: 'open' as const, head: 'x', mergeable: true }; },
      async mergePR() {},
      async deleteDir() { return 'x'; },
    } as unknown as GitHubClient;
    setGithubClient(gh);

    const files = { ...GOOD_FILES, 'applet.json': (GOOD_FILES['applet.json'] as string).replace('mcapp', 'rb3-app') };
    const res = await callTool('submit_applet', { applet_id: 'rb3-app', name: 'RB3', files }, rk);
    expect(res.status).toBe(200);
    expect(toolResult(res.json).pr_number).toBe(30);
    // putFiles 被调用两次（原始 + 分支重建后重放）
    expect(openPRCalls).toBe(4); // putFiles x2 + openPR x2 计数
  });

  it('resubmit upserts t_prs when a merged row exists (UNIQUE constraint fix)', async () => {
    const code = await makeAccessCode();
    await callTool('agent_apply', { name: 'upsert-agent', fingerprint: 'fp-up' }, code);
    const uid = (await env.DB.prepare(`SELECT id FROM t_agents WHERE name='upsert-agent'`).first<any>()).id;
    const r0 = await SELF.fetch(`https://x/api/admin/agents/${uid}/approve`, { method: 'POST', headers: { cookie: adminCookie }, body: '{}' });
    const uk = (await r0.json() as any).key;

    // 第一次提交（建注册行 + pr 行）
    setGithubClient(makeGithubNoop().gh);
    const files1 = { ...GOOD_FILES, 'applet.json': (GOOD_FILES['applet.json'] as string).replace('mcapp', 'up-app') };
    const r1 = await callTool('submit_applet', { applet_id: 'up-app', name: 'UP', files: files1 }, uk);
    expect(toolResult(r1.json).pr_number).toBe(1);
    // 模拟历史：把 pr 行改成 merged（如占位/合并周期后）
    await env.DB.prepare(`UPDATE t_prs SET state='merged' WHERE applet_id=(SELECT id FROM t_applets WHERE path='up-app')`).run();
    // 第二次提交（同一 applet，无 open 行 → openPR → INSERT 撞主键 → 必须 upsert）
    const files2 = { ...files1, 'index.html': GOOD_FILES['index.html'] };
    const r2 = await callTool('submit_applet', { applet_id: 'up-app', name: 'UP', files: files2 }, uk);
    if (!res2ok(r2)) console.error('r2 body:', JSON.stringify(toolResult(r2.json)).slice(0, 300));
    expect(res2ok(r2)).toBe(true);
    const row = await env.DB.prepare(`SELECT pr_number, state FROM t_prs WHERE applet_id=(SELECT id FROM t_applets WHERE path='up-app')`).first<any>();
    expect(row.state).toBe('open');
  });

  function res2ok(r: { json: any }): boolean {
    return toolResult(r.json).ok === true;
  }

  it('import_data: ownership, column whitelist, success path', async () => {
    // 复用 upsert-agent（已归属 up-app，manifest 有一张表）——注册快照里 up-app 的表是 items
    const code = await makeAccessCode();
    await callTool('agent_apply', { name: 'imp-agent', fingerprint: 'fp-imp' }, code);
    const iid = (await env.DB.prepare(`SELECT id FROM t_agents WHERE name='imp-agent'`).first<any>()).id;
    const r0 = await SELF.fetch(`https://x/api/admin/agents/${iid}/approve`, { method: 'POST', headers: { cookie: adminCookie }, body: '{}' });
    const ik = (await r0.json() as any).key;
    setGithubClient(makeGithubNoop().gh);
    // 先提交 imp-app 建归属
    const impFiles = { ...GOOD_FILES, 'applet.json': (GOOD_FILES['applet.json'] as string).replace('mcapp', 'imp-app') };
    await callTool('submit_applet', { applet_id: 'imp-app', name: 'IMP', files: impFiles }, ik);

    // ① 未归属的 applet → AGENT_SCOPE
    const r1 = await callTool('import_data', { applet_id: 'mcapp', table: 'items', rows: [{ title: 'x' }] }, ik);
    expect(toolResult(r1.json).error).toBe('AGENT_SCOPE');
    // ② 非白名单列 → BAD_COLUMN
    const r2 = await callTool('import_data', { applet_id: 'imp-app', table: 'items', rows: [{ title: 'a', evil: 1 }] }, ik);
    expect(toolResult(r2.json).error).toBe('BAD_COLUMN');
    // ③ 成功导入（admin 用户存在）
    const r3 = await callTool('import_data', { applet_id: 'imp-app', table: 'items', rows: [{ title: 'row1' }, { title: 'row2' }] }, ik);
    expect(toolResult(r3.json).imported).toBe(2);
    // 数据落库且归属 admin
    const rows = await env.DB.prepare(`SELECT user_id, title FROM a_imp_app_items`).all();
    expect(rows.results).toHaveLength(2);
    expect(rows.results[0].title).toBe('row1');
    // 审计
    const audit = await env.DB.prepare(`SELECT action FROM t_audit_logs WHERE action='agent.import_data'`).all();
    expect(audit.results.length).toBe(1);
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

describe('logs endpoint actor-name join', () => {
  it('resolves user username and agent name for audit rows', async () => {
    // beforeEach 清 agent.% 审计——本用例自己产生一条 agent 审计（用 access_code apply）
    const code = await makeAccessCode();
    await callTool('agent_apply', { name: 'log-agent', fingerprint: 'fp-log' }, code);
    const r = await SELF.fetch('https://x/api/admin/logs?limit=50', { headers: { cookie: adminCookie } });
    expect(r.status).toBe(200);
    const { logs } = await r.json() as any;
    // user 类型行应有 user_name=admin
    const userRow = logs.find((l: any) => l.actor_type === 'user' && l.user_name);
    expect(userRow).toBeDefined();
    expect(userRow.user_name).toBe('boss11'); // 该测试文件的 admin seed 名
    // agent 行应有 join 出的认证名称（agent_apply 的 actor_id=agent id）
    const agentRow = logs.find((l: any) => l.actor_type === 'agent' && l.action === 'agent.apply');
    expect(agentRow).toBeDefined();
    expect(agentRow.agent_name).toBe('log-agent');
    expect(agentRow.agent_fingerprint).toBe('fp-log');
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

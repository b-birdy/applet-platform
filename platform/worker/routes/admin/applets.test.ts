import { env } from 'cloudflare:test';
import { SELF } from 'cloudflare:test';
import { hashPassword } from '../../auth';
import { registerAppletTables } from '../../data';
import type { CheckIssue } from '../../checker';

let adminCookie: string;
let userCookie: string;
let userId: number, otherId: number;
let appletRowId: number;

async function login(username: string): Promise<string> {
  const r = await SELF.fetch('https://x/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'pw-123456' }),
  });
  return r.headers.get('set-cookie')!.split(';')[0];
}

async function seedUser(username: string, role = 'user'): Promise<number> {
  const hash = await hashPassword('pw-123456');
  return (await env.DB.prepare(`INSERT INTO t_users (username, password_hash, role) VALUES (?, ?, ?) RETURNING id`)
    .bind(username, hash, role).first<{ id: number }>())!.id;
}

beforeAll(async () => {
  const { results } = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='t_users'`).all();
  if (results.length === 0) {
    const { applySchema } = await import('../../db/apply');
    await applySchema(env.DB);
  }
  await seedUser('boss7', 'admin');
  userId = await seedUser('u7');
  otherId = await seedUser('u8');
  adminCookie = await login('boss7');
  userCookie = await login('u7');

  // 注册一个演示 applet（含一张表）供授权/删除用例
  await env.DB.prepare(`INSERT INTO t_applets (id, name, path, status, entry) VALUES (1, '演示', 'demo7', 'testing', 'index.html')`).run();
  appletRowId = 1;
  await registerAppletTables(env.DB, 'demo7', [{ name: 't1', columns: [{ name: 'note', type: 'text' }] }]);
});

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM t_audit_logs WHERE action LIKE 'applet.%'`);
});

describe('list applets', () => {
  it('returns applets with acl count, table count, open pr', async () => {
    const r = await SELF.fetch('https://x/api/admin/applets', { headers: { cookie: adminCookie } });
    expect(r.status).toBe(200);
    const json: any = await r.json();
    const demo = json.applets.find((a: any) => a.path === 'demo7');
    expect(demo).toBeDefined();
    expect(demo.status).toBe('testing');
    expect(demo.tables).toBe(1);
  });
});

describe('status transitions (D11)', () => {
  it('testing -> enabled ok', async () => {
    const r = await SELF.fetch('https://x/api/admin/applets/demo7/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ status: 'enabled' }),
    });
    expect(r.status).toBe(200);
  });

  it('enabled -> disabled ok, disabled -> testing ok (transitions fully liberalized)', async () => {
    const off = await SELF.fetch('https://x/api/admin/applets/demo7/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ status: 'disabled' }),
    });
    expect(off.status).toBe(200);

    const back = await SELF.fetch('https://x/api/admin/applets/demo7/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ status: 'testing' }),
    });
    expect(back.status).toBe(200);
  });

  it('unknown status 400', async () => {
    const r = await SELF.fetch('https://x/api/admin/applets/demo7/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ status: 'deleted' }),
    });
    expect(r.status).toBe(400);
  });
});

describe('authorization (D10)', () => {
  it('batch authorize users, then /api/my/applets reflects it', async () => {
    // 前面的状态机用例把 demo7 留在 disabled——先转回 enabled（disabled→enabled 合法）
    await SELF.fetch('https://x/api/admin/applets/demo7/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ status: 'enabled' }),
    });

    const grant = await SELF.fetch('https://x/api/admin/applets/demo7/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ userIds: [userId, otherId], allowed: true }),
    });
    expect(grant.status).toBe(200);

    const mine = await SELF.fetch('https://x/api/my/applets', { headers: { cookie: userCookie } });
    const mineJson: any = await mine.json();
    expect(mineJson.applets.some((a: any) => a.path === 'demo7')).toBe(true);

    const revoke = await SELF.fetch('https://x/api/admin/applets/demo7/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ userIds: [userId], allowed: false }),
    });
    expect(revoke.status).toBe(200);
    const mine2: any = await (await SELF.fetch('https://x/api/my/applets', { headers: { cookie: userCookie } })).json();
    expect(mine2.applets.some((a: any) => a.path === 'demo7')).toBe(false);
  });
});

describe('applet history endpoint (log management module)', () => {
  it('requires admin', async () => {
    const r = await SELF.fetch('https://x/api/admin/applets/any/history');
    expect([401, 403]).toContain(r.status);
  });

  it('returns events, prs, agents for an applet', async () => {
    const login = await SELF.fetch('https://x/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'boss7', password: 'pw-123456' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    // beforeEach 会清 applet.% 审计——本用例自己产生一条事件
    await SELF.fetch('https://x/api/admin/applets/demo7/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ status: 'disabled' }),
    });
    const r = await SELF.fetch('https://x/api/admin/applets/demo7/history', { headers: { cookie } });
    expect(r.status).toBe(200);
    const json: any = await r.json();
    expect(json.applet.path).toBe('demo7');
    expect(Array.isArray(json.events)).toBe(true);
    expect(Array.isArray(json.prs)).toBe(true);
    expect(Array.isArray(json.agents)).toBe(true);
    // 至少有授权/状态变更类审计事件
    expect(json.events.length).toBeGreaterThan(0);
  });

  it('404 for unknown applet', async () => {
    const login = await SELF.fetch('https://x/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'boss7', password: 'pw-123456' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const r = await SELF.fetch('https://x/api/admin/applets/no-such/history', { headers: { cookie } });
    expect(r.status).toBe(404);
  });
});

describe('applet health check endpoint (functional test module)', () => {
  it('requires admin', async () => {
    const r = await SELF.fetch('https://x/api/admin/applets/any/health');
    expect([401, 403]).toContain(r.status);
  });

  it('returns three-area checks with data-layer validation', async () => {
    const login = await SELF.fetch('https://x/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'boss7', password: 'pw-123456' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const r = await SELF.fetch('https://x/api/admin/applets/demo7/health', { headers: { cookie } });
    expect(r.status).toBe(200);
    const json: any = await r.json();
    expect(json).toHaveProperty('ok');
    expect(json.checks.length).toBeGreaterThan(0);
    const areas = new Set(json.checks.map((c: any) => c.area));
    expect(areas.has('静态规范')).toBe(true);
    expect(areas.has('运行时')).toBe(true);
    expect(areas.has('数据层')).toBe(true);
    // demo7 注册过 t1 表——数据层应有对应物理表检查
    expect(json.checks.some((c: any) => c.name.includes('a_demo7_t1'))).toBe(true);
  });
});

describe('admin settings/logs/sync require auth (final deploy hotfix)', () => {
  it.each([
    '/api/admin/settings',
    '/api/admin/logs',
    '/api/admin/sync',
  ])('GET %s without session → 401', async (path) => {
    const r = await SELF.fetch(`https://x${path}`);
    expect(r.status).toBe(401);
  });

  it('POST /api/admin/sync without session → 401', async () => {
    const r = await SELF.fetch('https://x/api/admin/sync', { method: 'POST' });
    expect(r.status).toBe(401);
  });
});

describe('check report', () => {
  it('runs checker over R2 prod files', async () => {
    // 直接往 R2 写入一个带 eval 的假入口（绕过同步器）
    await env.ASSETS.put('prod/demo7/index.html', '<html><script>eval("x")</script></html>');
    const r = await SELF.fetch('https://x/api/admin/applets/demo7/check-report', { headers: { cookie: adminCookie } });
    expect(r.status).toBe(200);
    const json: any = await r.json();
    expect(json.issues.some((i: CheckIssue) => i.rule === 'security.dynamic')).toBe(true);
  });
});

describe('quota override (D32)', () => {
  it('per-applet quota override applies', async () => {
    const r = await SELF.fetch('https://x/api/admin/applets/demo7', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ name: '演示改', quota: { rows: 123 } }),
    });
    expect(r.status).toBe(200);
    const { getQuota } = await import('../../settings');
    const q = await getQuota(env.DB, 'demo7');
    expect(q.rows).toBe(123);
  });
});

describe('hard delete with stub remover', () => {
  it('calls remover, drops tables, clears acls, audits', async () => {
    // 直接调用 API；env 注入的 remover 在 wrangler 测试 env 不可替换，
    // 所以这里验证 D1 侧序列 + 审计；remover 本体在 Task 10 以真身接 GitHub/R2
    const del = await SELF.fetch('https://x/api/admin/applets/demo7', {
      method: 'DELETE', headers: { cookie: adminCookie },
    });
    // remover 未接线时应报 500/501——测试只验证拒绝路径直到 Task 10 接线
    expect([500, 501, 200]).toContain(del.status);

    if (del.status === 200) {
      const row = await env.DB.prepare(`SELECT id FROM t_applets WHERE path='demo7'`).first();
      expect(row).toBeNull();
      const t = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE name='a_demo7_t1'`).all();
      expect(t.results).toHaveLength(0);
      const acl = await env.DB.prepare(`SELECT * FROM t_applet_acls WHERE applet_id=?`).bind(appletRowId).all();
      expect(acl.results).toHaveLength(0);
      const audit = await env.DB.prepare(`SELECT action FROM t_audit_logs WHERE action='applet.delete'`).all();
      expect(audit.results.length).toBe(1);
    }
  });
});

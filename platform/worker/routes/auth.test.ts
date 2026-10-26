import { env } from 'cloudflare:test';
import { SELF } from 'cloudflare:test';

beforeAll(async () => {
  const { results } = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='t_users'`
  ).all();
  if (results.length === 0) {
    const { applySchema } = await import('../db/apply');
    await applySchema(env.DB);
  }
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM t_sessions; DELETE FROM t_users; DELETE FROM t_settings; DELETE FROM t_audit_logs;');
});

function setupRequest(newPassword = 'init-pass-123') {
  return SELF.fetch('https://x/api/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ adminPassword: 'test-admin-init', newPassword }),
  });
}

describe('POST /api/setup', () => {
  it('reports needsInit on empty database', async () => {
    const r = await SELF.fetch('https://x/api/setup');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ needsInit: true });
  });

  it('rejects wrong admin password with 403', async () => {
    const r = await SELF.fetch('https://x/api/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adminPassword: 'wrong', newPassword: 'x-pass-123' }),
    });
    expect(r.status).toBe(403);
  });

  it('creates admin (superadmin), default settings, and allows login', async () => {
    const r = await setupRequest();
    expect(r.status).toBe(201);

    const user = await env.DB.prepare(`SELECT role FROM t_users WHERE username='admin'`).first<{ role: string }>();
    expect(user!.role).toBe('superadmin');

    const site = await env.DB.prepare(`SELECT value FROM t_settings WHERE key='site_name'`).first<{ value: string }>();
    expect(site!.value).toBe('Applet 平台');
    const quota = await env.DB.prepare(`SELECT value FROM t_settings WHERE key='quota_rows'`).first<{ value: string }>();
    expect(quota!.value).toBe('10000');

    const login = await SELF.fetch('https://x/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'init-pass-123' }),
    });
    expect(login.status).toBe(200);
    const me = await SELF.fetch('https://x/api/me', {
      headers: { cookie: login.headers.get('set-cookie')!.split(';')[0] },
    });
    expect(me.status).toBe(200);
    const meJson: any = await me.json();
    expect(meJson.username).toBe('admin');
    expect(meJson.role).toBe('superadmin');
  });

  it('refuses to re-init when users already exist', async () => {
    await setupRequest();
    const r = await setupRequest('another-pass-1');
    expect(r.status).toBe(403);
  });
});

describe('login lockout', () => {
  it('locks after threshold failures and reports LOCKED even with correct password', async () => {
    await setupRequest();

    // 把阈值调到 3，缩短测试
    await env.DB.prepare(`UPDATE t_settings SET value='3' WHERE key='lock_threshold'`).run();

    for (let i = 0; i < 3; i++) {
      const bad = await SELF.fetch('https://x/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'nope' }),
      });
      expect(bad.status).toBe(401);
    }

    // 第 4 次即使密码正确也 401 LOCKED
    const locked = await SELF.fetch('https://x/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'init-pass-123' }),
    });
    expect(locked.status).toBe(401);
    expect((await locked.json() as any).code).toBe('LOCKED');

    const row = await env.DB.prepare(`SELECT locked_until, failed_count FROM t_users WHERE username='admin'`).first<any>();
    expect(new Date(row.locked_until + 'Z').getTime()).toBeGreaterThan(Date.now());
    expect(row.failed_count).toBe(3);
  });

  it('resets failed_count on successful login', async () => {
    await setupRequest();
    await SELF.fetch('https://x/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'nope' }),
    });
    const ok = await SELF.fetch('https://x/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'init-pass-123' }),
    });
    expect(ok.status).toBe(200);
    const row = await env.DB.prepare(`SELECT failed_count FROM t_users WHERE username='admin'`).first<any>();
    expect(row.failed_count).toBe(0);
  });
});

describe('logout and audit', () => {
  it('logout invalidates session and login writes audit rows', async () => {
    await setupRequest();
    const login = await SELF.fetch('https://x/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'init-pass-123' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];

    // 失败登录也有一条审计
    await SELF.fetch('https://x/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'bad' }),
    });

    const out = await SELF.fetch('https://x/api/auth/logout', { method: 'POST', headers: { cookie } });
    expect(out.status).toBe(200);
    const after = await SELF.fetch('https://x/api/me', { headers: { cookie } });
    expect(after.status).toBe(401);

    const actions = await env.DB.prepare(
      `SELECT action FROM t_audit_logs WHERE action IN ('login.success','login.failure','logout') ORDER BY id`
    ).all<{ action: string }>();
    const set = new Set(actions.results.map((r) => r.action));
    expect(set.has('login.success')).toBe(true);
    expect(set.has('login.failure')).toBe(true);
    expect(set.has('logout')).toBe(true);
  });
});

import { env } from 'cloudflare:test';
import { SELF } from 'cloudflare:test';
import { hashPassword } from './auth';
import { hmacSha256Hex } from './tokens';

let adminCookie: string;
let userCookie: string;
let userId: number;

async function login(username: string): Promise<string> {
  const r = await SELF.fetch('https://x/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'pw-123456' }),
  });
  return r.headers.get('set-cookie')!.split(';')[0];
}

beforeAll(async () => {
  const { results } = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='t_users'`).all();
  if (results.length === 0) {
    const { applySchema } = await import('./db/apply');
    await applySchema(env.DB);
  }
  const hash = await hashPassword('pw-123456');
  await env.DB.prepare(`INSERT INTO t_users (username, password_hash, role) VALUES ('boss9', ?, 'admin')`).bind(hash).run();
  userId = (await env.DB.prepare(`INSERT INTO t_users (username, password_hash) VALUES ('u9', ?) RETURNING id`).bind(hash).first<any>()).id;
  // serving-app: enabled + 授权 u9；locked-app: testing
  await env.DB.prepare(`INSERT INTO t_applets (id, name, path, status, entry) VALUES (1, '服务中', 'serving-app', 'enabled', 'index.html')`).run();
  await env.DB.prepare(`INSERT INTO t_applets (id, name, path, status, entry) VALUES (2, '测试中', 'locked-app', 'testing', 'index.html')`).run();
  await env.DB.prepare(`INSERT INTO t_applet_acls (applet_id, user_id, allowed) VALUES (1, ?, 1)`).bind(userId).run();
  await env.ASSETS.put('prod/serving-app/index.html', '<html>serving</html>');
  await env.ASSETS.put('prod/locked-app/index.html', '<html>locked</html>');
  await env.ASSETS.put('preview/locked-app/index.html', '<html>preview</html>');
  adminCookie = await login('boss9');
  userCookie = await login('u9');
});

describe('applet static serving', () => {
  it('serves enabled applet to authorized user with correct content-type', async () => {
    const r = await SELF.fetch('https://x/app/serving-app/index.html', { headers: { cookie: userCookie } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(await r.text()).toContain('serving');
  });

  it('serves directory-style path /app/serving-app/ to entry', async () => {
    const r = await SELF.fetch('https://x/app/serving-app/', { headers: { cookie: userCookie } });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('serving');
  });

  it('blocks testing applet for regular user (403)', async () => {
    const r = await SELF.fetch('https://x/app/locked-app/index.html', { headers: { cookie: userCookie } });
    expect(r.status).toBe(403);
    expect((await r.json() as any).error).toBe('APPLET_FORBIDDEN');
  });

  it('allows testing applet for admin', async () => {
    const r = await SELF.fetch('https://x/app/locked-app/index.html', { headers: { cookie: adminCookie } });
    expect(r.status).toBe(200);
  });

  it('blocks unauthenticated', async () => {
    const r = await SELF.fetch('https://x/app/serving-app/index.html');
    expect([401, 403]).toContain(r.status);
  });

  it('blocks unauthorized user for enabled applet', async () => {
    // u9 未授权 locked-app；再建一个 enabled 但未授权 u9 的应用
    await env.DB.prepare(`INSERT INTO t_applets (id, name, path, status, entry) VALUES (3, '未授权', 'stranger-app', 'enabled', 'index.html')`).run();
    await env.ASSETS.put('prod/stranger-app/index.html', '<html>stranger</html>');
    const r = await SELF.fetch('https://x/app/stranger-app/index.html', { headers: { cookie: userCookie } });
    expect(r.status).toBe(403);
  });

  it('preview is admin-only', async () => {
    const denied = await SELF.fetch('https://x/preview/locked-app/index.html', { headers: { cookie: userCookie } });
    expect(denied.status).toBe(403);
    const ok = await SELF.fetch('https://x/preview/locked-app/index.html', { headers: { cookie: adminCookie } });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('preview');
  });

  it('serves app-runtime.js placeholder', async () => {
    const r = await SELF.fetch('https://x/app-runtime.js');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('javascript');
    expect(await r.text()).toContain('window.applet');
  });

  it('404 for unknown file', async () => {
    const r = await SELF.fetch('https://x/app/serving-app/nope.js', { headers: { cookie: userCookie } });
    expect(r.status).toBe(404);
  });
});

describe('github webhook', () => {
  const SECRET = 'test-hook-secret';
  async function sign(payload: string): Promise<string> {
    const sig = await hmacSha256Hex(SECRET, payload);
    return `sha256=${sig}`;
  }

  it('rejects bad signature with 401', async () => {
    const r = await SELF.fetch('https://x/api/hooks/github', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef', 'x-github-event': 'push' },
      body: JSON.stringify({ ref: 'refs/heads/main' }),
    });
    expect(r.status).toBe(401);
  });

  it('accepts push event with valid signature', async () => {
    const payload = JSON.stringify({ ref: 'refs/heads/main' });
    const r = await SELF.fetch('https://x/api/hooks/github', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': await sign(payload), 'x-github-event': 'push' },
      body: payload,
    });
    expect(r.status).toBe(200);
  });

  it('accepts pull_request event targeting applets/', async () => {
    const payload = JSON.stringify({
      action: 'synchronize',
      pull_request: { number: 1, head: { ref: 'applet/syncapp' }, base: { ref: 'main' } },
    });
    const r = await SELF.fetch('https://x/api/hooks/github', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': await sign(payload), 'x-github-event': 'pull_request' },
      body: payload,
    });
    expect(r.status).toBe(200);
  });
});

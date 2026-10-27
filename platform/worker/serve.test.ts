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
  await env.ASSETS.put('prod/serving-app/index.html',
    '<!DOCTYPE html><html><head><link rel="stylesheet" href="style.css"><script src="/app-runtime.js"></script></head><body><script src="main.js"></script>serving</body></html>');
  await env.ASSETS.put('prod/serving-app/style.css', 'body { color: red; }');
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

  it('CSP on applet HTML includes explicit origin (sandboxed iframe: self matches nothing)', async () => {
    const r = await SELF.fetch('https://x/app/serving-app/index.html', { headers: { cookie: adminCookie } });
    const csp = r.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('https://x');
    expect(csp).not.toMatch(/script-src [^;]*'self'/); // 'self' 在不透明 origin 下失效，不得只依赖它
    expect(csp).not.toContain("frame-ancestors 'none'"); // 平台自身要嵌入 iframe，须允许本站
    expect(csp).toMatch(/frame-ancestors https:\/\//);
    expect(csp).not.toMatch(/script-src [^;]*'\//); // script-src 不得含路径源（如 /app-runtime.js，无效源会让整条指令被忽略）
  });

  it('injects platform theme variables into served applet HTML (sandbox iframe cannot inherit parent CSS)', async () => {
    const r = await SELF.fetch('https://x/app/serving-app/index.html', { headers: { cookie: adminCookie } });
    const html = await r.text();
    expect(html).toContain('data-platform-theme');
    expect(html).toContain('--canvas');
    expect(html).toContain('--accent');
    // 注入位置：有 <head> 时在其内，否则前置（两种都先于 body 内容）
    const headEnd = html.indexOf('</head>');
    const injectAt = html.indexOf('data-platform-theme');
    expect(headEnd === -1 ? true : injectAt < headEnd).toBe(true);
  });

  it('inlines relative CSS/JS and runtime into served applet HTML (self-contained for sandboxed iframe)', async () => {
    // serving-app 的入口页带外链脚本；R2 里的对应文件之前已在其他用例写入
    await env.ASSETS.put('prod/serving-app/main.js', 'console.log("inlined-test");');
    const r = await SELF.fetch('https://x/app/serving-app/', { headers: { cookie: adminCookie } });
    const html = await r.text();
    // 运行时已内联（不再有 /app-runtime.js 外链）
    expect(html).toContain('data-applet-runtime');
    expect(html).not.toMatch(/<script\s+src=["']\/app-runtime\.js["']/);
    // 回归：运行时必须从自身地址解析 appletId 拼进数据 URL（漏拼 → 沙箱内所有数据请求 404）
    expect(html).toMatch(/api\/data\/'\s*\+\s*appletId\s*\+\s*'\/'/);
    // CSP 不再含主机源（沙箱 origin=null 匹配不了），只允许内联
    const csp = r.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).not.toContain('script-src https://');
  });

  it('inlines assets from applet subdirectories (path regression: no double-slug)', async () => {
    // 子目录资源（assets/xxx.css）曾因路径拼接重复 slug 而静默内联失败
    await env.ASSETS.put('prod/serving-app/assets/theme.css', '.t { color: teal; }');
    await env.ASSETS.put('prod/serving-app/sub.html',
      '<!DOCTYPE html><html><head><link rel="stylesheet" href="assets/theme.css"></head><body>x</body></html>');
    const r = await SELF.fetch('https://x/app/serving-app/sub.html', { headers: { cookie: adminCookie } });
    const html = await r.text();
    expect(html).toContain('data-inlined-from="assets/theme.css"');
    expect(html).toContain('.t { color: teal; }');
    expect(html).not.toMatch(/<link[^>]*stylesheet/);
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

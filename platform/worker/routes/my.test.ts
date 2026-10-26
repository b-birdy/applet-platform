import { env } from 'cloudflare:test';
import { SELF } from 'cloudflare:test';
import { hashPassword } from '../auth';
import { registerAppletTables } from '../data';
import { signAppletToken, verifyAppletToken } from '../tokens';

let userCookie: string;
let userId: number;
let adminCookie: string;

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
    const { applySchema } = await import('../db/apply');
    await applySchema(env.DB);
  }
  const hash = await hashPassword('pw-123456');
  userId = (await env.DB.prepare(`INSERT INTO t_users (username, password_hash) VALUES ('myuser', ?) RETURNING id`).bind(hash).first<any>()).id;
  await env.DB.prepare(`INSERT INTO t_users (username, password_hash, role) VALUES ('myadmin', ?, 'admin')`).bind(hash).run();
  await env.DB.prepare(`INSERT INTO t_applets (id, name, path, status, entry) VALUES (1, '背单词', 'word-cards', 'enabled', 'index.html')`).run();
  await registerAppletTables(env.DB, 'word-cards', [{ name: 'words', columns: [{ name: 'word', type: 'text', required: true }] }]);
  await env.DB.prepare(`INSERT INTO t_applet_acls (applet_id, user_id, allowed) VALUES (1, ?, 1)`).bind(userId).run();
  // 另一个未授权应用
  await env.DB.prepare(`INSERT INTO t_applets (id, name, path, status, entry) VALUES (2, '隐藏应用', 'hidden-app', 'enabled', 'index.html')`).run();
  userCookie = await login('myuser');
  adminCookie = await login('myadmin');
});

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM a_word_cards_words`);
});

describe('token round-trip through Data API', () => {
  it('issued token authorizes Data API writes for its user+applet', async () => {
    const r = await SELF.fetch('https://x/api/applet-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: userCookie },
      body: JSON.stringify({ appletId: 'word-cards' }),
    });
    expect(r.status).toBe(200);
    const { token } = await r.json() as any;
    const payload = await verifyAppletToken(token, 'test-signing-key');
    expect(payload!.userId).toBe(userId);
    expect(payload!.appletId).toBe('word-cards');

    const post = await SELF.fetch('https://x/api/data/word-cards/words', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ word: 'roundtrip' }),
    });
    expect(post.status).toBe(201);
  });

  it('denies token for unauthorized applet', async () => {
    const r = await SELF.fetch('https://x/api/applet-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: userCookie },
      body: JSON.stringify({ appletId: 'hidden-app' }),
    });
    expect(r.status).toBe(403);
  });

  it('tampered signature → 401; expired token → 401', async () => {
    const good = await signAppletToken({ userId, appletId: 'word-cards', exp: Math.floor(Date.now() / 1000) + 600 }, 'test-signing-key');
    const parts = good.split('.');
    const tampered = `${parts[0]}.${parts[1].slice(0, -2)}ff`;
    const r1 = await SELF.fetch('https://x/api/data/word-cards/words', {
      headers: { authorization: `Bearer ${tampered}` },
    });
    expect(r1.status).toBe(401);

    const expired = await signAppletToken({ userId, appletId: 'word-cards', exp: Math.floor(Date.now() / 1000) - 10 }, 'test-signing-key');
    const r2 = await SELF.fetch('https://x/api/data/word-cards/words', {
      headers: { authorization: `Bearer ${expired}` },
    });
    expect(r2.status).toBe(401);
  });
});

describe('/api/my/usage', () => {
  it('reports rows and last activity per authorized applet', async () => {
    await env.DB.prepare(`INSERT INTO a_word_cards_words (user_id, word) VALUES (?, ?)`).bind(userId, 'usage-row').run();
    const r = await SELF.fetch('https://x/api/my/usage', { headers: { cookie: userCookie } });
    expect(r.status).toBe(200);
    const json: any = await r.json();
    const wc = json.applets.find((a: any) => a.appletId === 'word-cards');
    expect(wc).toBeDefined();
    expect(wc.rows).toBe(1);
    expect(json.applets.find((a: any) => a.appletId === 'hidden-app')).toBeUndefined();
  });
});

describe('/api/my/export + purge', () => {
  it('exports my rows as JSON; purge deletes only mine with audit', async () => {
    await env.DB.prepare(`INSERT INTO a_word_cards_words (user_id, word) VALUES (?, ?)`).bind(userId, 'mine-1').run();
    await env.DB.prepare(`INSERT INTO a_word_cards_words (user_id, word) VALUES (?, ?)`).bind(userId, 'mine-2').run();

    const exp = await SELF.fetch('https://x/api/my/export?applet=word-cards', { headers: { cookie: userCookie } });
    expect(exp.status).toBe(200);
    expect(exp.headers.get('content-type')).toContain('application/json');
    expect(exp.headers.get('content-disposition')).toContain('attachment');
    const data: any = await exp.json();
    expect(data.applet).toBe('word-cards');
    expect(data.tables.words).toHaveLength(2);

    const purge = await SELF.fetch('https://x/api/my/purge?applet=word-cards', { method: 'POST', headers: { cookie: userCookie } });
    expect(purge.status).toBe(200);
    const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM a_word_cards_words WHERE user_id=?`).bind(userId).first<any>();
    expect(left.n).toBe(0);

    const audit = await env.DB.prepare(`SELECT action FROM t_audit_logs WHERE action='my.purge'`).all();
    expect(audit.results.length).toBe(1);
  });

  it('purge refuses unauthorized applet', async () => {
    const r = await SELF.fetch('https://x/api/my/purge?applet=hidden-app', { method: 'POST', headers: { cookie: userCookie } });
    expect(r.status).toBe(403);
  });
});

describe('admin sees all applets in /api/my/applets', () => {
  it('admin list includes testing apps; user list does not', async () => {
    await env.DB.prepare(`INSERT INTO t_applets (id, name, path, status, entry) VALUES (3, '测试中', 'testing-app', 'testing', 'index.html')`).run();
    const adminList: any = await (await SELF.fetch('https://x/api/my/applets', { headers: { cookie: adminCookie } })).json();
    expect(adminList.applets.some((a: any) => a.path === 'testing-app')).toBe(true);
    const userList: any = await (await SELF.fetch('https://x/api/my/applets', { headers: { cookie: userCookie } })).json();
    expect(userList.applets.some((a: any) => a.path === 'testing-app')).toBe(false);
  });
});

describe('sandbox assertions (static)', () => {
  it('AppFrame sandbox excludes allow-same-origin', async () => {
    const src = await import('../../src/views/applet/AppFrame.vue?raw');
    expect(src.default).not.toContain('allow-same-origin');
    expect(src.default).toContain('sandbox');
    expect(src.default).toContain('allow-scripts');
  });

  it('app-runtime exposes data CRUD helpers without cookie access', async () => {
    const src = (await import('../applet-runtime.js?raw')).default as string;
    expect(src).toContain('applet-token');
    expect(src).toContain('data');
    expect(src).not.toContain('document.cookie');
  });
});

import { env } from 'cloudflare:test';
import { SELF } from 'cloudflare:test';
import { registerAppletTables, dropAppletTables, SchemaChangeError, type ManifestTable } from '../data';
import { signAppletToken } from '../tokens';
import { hashPassword } from '../auth';

const MANIFEST_TABLES: ManifestTable[] = [
  { name: 'words', columns: [{ name: 'word', type: 'text', required: true }, { name: 'meaning', type: 'text' }] },
];

let userA: number, userB: number;
let cookieA: string, cookieB: string;
let tokenA: string;

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
  // 平台基础数据：一个 applet 注册 + 两个用户
  await env.DB.prepare(
    `INSERT INTO t_applets (id, name, path, status, entry) VALUES (1, '背单词', 'word-cards', 'enabled', 'index.html')`
  ).run();
  const hash = await hashPassword('pw-123456');
  userA = (await env.DB.prepare(`INSERT INTO t_users (username, password_hash) VALUES ('alice', ?) RETURNING id`).bind(hash).first<any>()).id;
  userB = (await env.DB.prepare(`INSERT INTO t_users (username, password_hash) VALUES ('bob', ?) RETURNING id`).bind(hash).first<any>()).id;
  await registerAppletTables(env.DB, 'word-cards', MANIFEST_TABLES);
  await env.DB.prepare(`INSERT INTO t_applet_acls (applet_id, user_id, allowed) VALUES (1, ?, 1)`).bind(userA).run();
  await env.DB.prepare(`INSERT INTO t_applet_acls (applet_id, user_id, allowed) VALUES (1, ?, 1)`).bind(userB).run();
  cookieA = await login('alice');
  cookieB = await login('bob');
  tokenA = await signAppletToken({ userId: userA, appletId: 'word-cards', exp: Math.floor(Date.now() / 1000) + 3600 }, 'test-signing-key');
});

const BASE = 'https://x/api/data/word-cards/words';

describe('per-user isolation', () => {
  it('user A writes a row, user B sees nothing', async () => {
    const post = await SELF.fetch(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ word: 'hello', meaning: '你好' }),
    });
    expect(post.status).toBe(201);

    const a = await SELF.fetch(BASE, { headers: { cookie: cookieA } });
    const aJson: any = await a.json();
    expect(aJson.total).toBe(1);
    expect(aJson.rows[0].word).toBe('hello');

    const b = await SELF.fetch(BASE, { headers: { cookie: cookieB } });
    const bJson: any = await b.json();
    expect(bJson.rows).toEqual([]);
  });

  it('user B cannot update user A row (404)', async () => {
    const aRows: any = await (await SELF.fetch(BASE, { headers: { cookie: cookieA } })).json();
    const id = aRows.rows[0].id;
    const r = await SELF.fetch(`${BASE}/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: cookieB },
      body: JSON.stringify({ word: 'hacked' }),
    });
    expect(r.status).toBe(404);
  });

  it('POST body user_id is ignored — row belongs to session user', async () => {
    const r = await SELF.fetch(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ word: 'spoof', user_id: userB }),
    });
    expect(r.status).toBe(201);
    const row = await env.DB.prepare(`SELECT user_id FROM a_word_cards_words WHERE word='spoof'`).first<any>();
    expect(row.user_id).toBe(userA);
  });

  it('applet token works and is scoped to its applet', async () => {
    const r = await SELF.fetch(BASE, { headers: { authorization: `Bearer ${tokenA}` } });
    expect(r.status).toBe(200);
    const json: any = await r.json();
    expect(json.total).toBeGreaterThanOrEqual(1);

    const other = await SELF.fetch('https://x/api/data/other-applet/words', {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect([403, 404]).toContain(other.status);

    // 管理路由尚未创建（Task 6/7）——token 不得获得 200；401 在路由存在后由 Task 11 测试钉死
    const admin = await SELF.fetch('https://x/api/admin/users', { headers: { authorization: `Bearer ${tokenA}` } });
    expect(admin.status).not.toBe(200);
  });
});

describe('validation', () => {
  it('rejects unknown column with 400 BAD_COLUMN', async () => {
    const r = await SELF.fetch(`${BASE}?column=evil`, { headers: { cookie: cookieA } });
    expect(r.status).toBe(400);
    expect((await r.json() as any).error).toBe('BAD_COLUMN');
  });

  it('rejects unknown table with 404 TABLE_NOT_FOUND', async () => {
    const r = await SELF.fetch('https://x/api/data/word-cards/nope', { headers: { cookie: cookieA } });
    expect(r.status).toBe(404);
    expect((await r.json() as any).error).toBe('TABLE_NOT_FOUND');
  });

  it('rejects unauthenticated with 401', async () => {
    const r = await SELF.fetch(BASE);
    expect(r.status).toBe(401);
    expect((await r.json() as any).error).toBe('UNAUTHORIZED');
  });
});

describe('quota', () => {
  it('rejects write past quota with 413 QUOTA_EXCEEDED and keeps DB at limit', async () => {
    // 配额调小，避免写 10001 行
    await env.DB.prepare(`INSERT INTO t_settings (key, value) VALUES ('quota.word-cards.rows', '50') ON CONFLICT(key) DO UPDATE SET value='50'`).run();
    // 清空已有行
    await env.DB.exec('DELETE FROM a_word_cards_words');
    // batch 写 50 行
    const rows = Array.from({ length: 50 }, (_, i) => ({ word: `w${i}` }));
    const batch = await SELF.fetch(`${BASE}/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ rows }),
    });
    expect(batch.status).toBe(200);

    const over = await SELF.fetch(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ word: 'over' }),
    });
    expect(over.status).toBe(413);
    const err: any = await over.json();
    expect(err.error).toBe('QUOTA_EXCEEDED');
    expect(err.limit.rows).toBe(50);

    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM a_word_cards_words`).first<any>();
    expect(count.n).toBe(50);
  });
});

describe('batch atomicity', () => {
  it('rolls back whole batch when one row fails', async () => {
    await env.DB.exec('DELETE FROM a_word_cards_words');
    const rows = [{ word: 'ok1' }, { word: null, meaning: 'x' }, { word: 'ok2' }]; // word required → 中间一条失败
    const r = await SELF.fetch(`${BASE}/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ rows }),
    });
    expect(r.status).toBe(400);
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM a_word_cards_words`).first<any>();
    expect(count.n).toBe(0);
  });
});

describe('schema evolution (D24)', () => {
  it('allows adding a column, keeps old data', async () => {
    await env.DB.exec('DELETE FROM a_word_cards_words');
    await SELF.fetch(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ word: 'keep' }),
    });
    const evolved: ManifestTable[] = [{ name: 'words', columns: [{ name: 'word', type: 'text', required: true }, { name: 'meaning', type: 'text' }, { name: 'tag', type: 'text' }] }];
    await registerAppletTables(env.DB, 'word-cards', evolved);
    const row = await env.DB.prepare(`SELECT word, tag FROM a_word_cards_words WHERE word='keep'`).first<any>();
    expect(row.word).toBe('keep');
    expect(row.tag).toBeNull();
  });

  it('throws SchemaChangeError on column removal', async () => {
    const shrunk: ManifestTable[] = [{ name: 'words', columns: [{ name: 'word', type: 'text', required: true }] }];
    expect(registerAppletTables(env.DB, 'word-cards', shrunk)).rejects.toThrow(SchemaChangeError);
  });
});

describe('dropAppletTables', () => {
  it('drops applet tables and manifest snapshot', async () => {
    await dropAppletTables(env.DB, 'word-cards');
    const t = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE name='a_word_cards_words'`).all();
    expect(t.results).toHaveLength(0);
    const snap = await env.DB.prepare(`SELECT value FROM t_settings WHERE key='manifest.word-cards'`).first();
    expect(snap).toBeNull();
    // 重新注册回来，供其他可能的用例使用
    await registerAppletTables(env.DB, 'word-cards', MANIFEST_TABLES);
  });
});

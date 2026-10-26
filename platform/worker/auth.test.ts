import { env } from 'cloudflare:test';
import {
  hashPassword,
  verifyPassword,
  createSession,
  getAuth,
} from './auth';

beforeAll(async () => {
  await applySchemaIfNeeded();
});

// Task 3 的测试自己建表（每文件隔离的 local storage 会重新执行 DDL）
async function applySchemaIfNeeded() {
  const { results } = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='t_users'`
  ).all();
  if (results.length === 0) {
    const { applySchema } = await import('./db/apply');
    await applySchema(env.DB);
  }
}

describe('hashPassword / verifyPassword', () => {
  it('round-trips a password', async () => {
    const stored = await hashPassword('s3cret!');
    expect(stored).toMatch(/^pbkdf2\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword('s3cret!', stored)).toBe(true);
    expect(await verifyPassword('wrong', stored)).toBe(false);
  });

  it('accepts a provided salt (deterministic)', async () => {
    const a = await hashPassword('pw', 'QUJDREVGR0g=');
    const b = await hashPassword('pw', 'QUJDREVGR0g=');
    expect(a).toBe(b);
  });
});

describe('session helpers', () => {
  it('creates a 30-day session and getAuth resolves it from cookie', async () => {
    const now = Date.now();
    const u = await env.DB.prepare(
      `INSERT INTO t_users (username, password_hash) VALUES ('sess-user', 'x') RETURNING id`
    ).first<{ id: number }>();
    const token = await createSession(env.DB, u!.id);
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const row = await env.DB
      .prepare(`SELECT expires_at FROM t_sessions WHERE token = ?`)
      .bind(token)
      .first<{ expires_at: string }>();
    const exp = new Date(row!.expires_at + 'Z').getTime();
    expect(exp - now).toBeGreaterThan(29 * 24 * 3600 * 1000);

    const req = new Request('https://x/api/me', {
      headers: { cookie: `sid=${token}` },
    });
    const auth = await getAuth(req, env.DB);
    expect(auth).toEqual({ userId: u!.id, role: 'user', username: 'sess-user' });
  });

  it('getAuth returns null for expired/missing session', async () => {
    const req = new Request('https://x/api/me');
    expect(await getAuth(req, env.DB)).toBeNull();

    const expired = await env.DB.prepare(
      `INSERT INTO t_users (username, password_hash) VALUES ('sess-exp', 'x') RETURNING id`
    ).first<{ id: number }>();
    const stale = await createSession(env.DB, expired!.id);
    await env.DB.prepare(`UPDATE t_sessions SET expires_at = '2020-01-01 00:00:00' WHERE token = ?`)
      .bind(stale)
      .run();
    const req2 = new Request('https://x/api/me', {
      headers: { cookie: `sid=${stale}` },
    });
    expect(await getAuth(req2, env.DB)).toBeNull();
  });
});

import { Hono } from 'hono';
import { verifyPassword, createSession, getAuth } from '../auth';
import { getSetting } from '../settings';
import { logAudit } from '../audit';

export const authRoutes = new Hono<{ Bindings: { DB: D1Database } }>();

function clientIp(req: Request): string | undefined {
  return req.headers.get('cf-connecting-ip') ?? undefined;
}

authRoutes.post('/api/auth/login', async (c) => {
  const db = c.env.DB;
  const body = await c.req.json<{ username?: string; password?: string }>().catch(() => null);
  if (!body?.username || !body.password) return c.json({ error: 'BAD_REQUEST' }, 400);

  const user = await db.prepare(`SELECT * FROM t_users WHERE username = ?`).bind(body.username).first<{
    id: number; password_hash: string; role: string; username: string; status: string;
    failed_count: number; locked_until: string | null;
  }>();
  // 用户不存在时也走一次哈希验证，避免可枚举时序差
  const hash = user?.password_hash ?? 'pbkdf2$100000$QUJDREVGR0hJSktMTU5PUA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const ok = await verifyPassword(body.password, hash);

  if (user && user.locked_until) {
    const until = new Date(user.locked_until + 'Z').getTime();
    if (!Number.isNaN(until) && until > Date.now()) {
      await logAudit(db, { actor_type: 'user', actor_id: body.username, action: 'login.locked', ip: clientIp(c.req.raw) });
      return c.json({ error: 'LOCKED', code: 'LOCKED' }, 401);
    }
  }

  if (!user || !ok || user.status === 'locked') {
    if (user) {
      const threshold = Number(await getSetting(db, 'lock_threshold', '5'));
      const minutes = Number(await getSetting(db, 'lock_minutes', '10'));
      const failed = user.failed_count + 1;
      if (failed >= threshold) {
        const until = new Date(Date.now() + minutes * 60_000).toISOString().replace('T', ' ').slice(0, 19);
        await db.prepare(`UPDATE t_users SET failed_count = ?, locked_until = ? WHERE id = ?`).bind(failed, until, user.id).run();
      } else {
        await db.prepare(`UPDATE t_users SET failed_count = ? WHERE id = ?`).bind(failed, user.id).run();
      }
    }
    await logAudit(db, { actor_type: 'user', actor_id: body.username, action: 'login.failure', ip: clientIp(c.req.raw) });
    return c.json({ error: 'INVALID_CREDENTIALS' }, 401);
  }

  await db.prepare(`UPDATE t_users SET failed_count = 0, locked_until = NULL WHERE id = ?`).bind(user.id).run();
  const token = await createSession(db, user.id);
  await logAudit(db, { actor_type: 'user', actor_id: String(user.id), action: 'login.success', ip: clientIp(c.req.raw) });
  c.header('Set-Cookie', `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${30 * 24 * 3600}`);
  return c.json({ ok: true, username: user.username, role: user.role });
});

authRoutes.post('/api/auth/logout', async (c) => {
  const db = c.env.DB;
  const cookie = c.req.header('cookie') || '';
  const m = cookie.match(/(?:^|;\s*)sid=([0-9a-f]{64})/);
  if (m) {
    const auth = await getAuth(c.req.raw, db);
    await db.prepare(`DELETE FROM t_sessions WHERE token = ?`).bind(m[1]).run();
    if (auth) await logAudit(db, { actor_type: 'user', actor_id: String(auth.userId), action: 'logout' });
  }
  c.header('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0');
  return c.json({ ok: true });
});

authRoutes.get('/api/me', async (c) => {
  const auth = await getAuth(c.req.raw, c.env.DB);
  if (!auth) return c.json({ error: 'UNAUTHORIZED' }, 401);
  return c.json(auth);
});

import { Hono } from 'hono';
import { hashPassword, createSession } from '../auth';
import { logAudit } from '../audit';

const DEFAULT_SETTINGS: Record<string, string> = {
  site_name: 'Applet 平台',
  registration_enabled: '0',
  lock_threshold: '5',
  lock_minutes: '10',
  quota_rows: '10000',
  quota_bytes: '20971520',
};

export const setupRoutes = new Hono<{ Bindings: { DB: D1Database; ADMIN_INIT_PASSWORD?: string } }>();

setupRoutes.get('/api/setup', async (c) => {
  const row = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM t_users`).first<{ n: number }>();
  return c.json({ needsInit: (row?.n ?? 0) === 0 });
});

setupRoutes.post('/api/setup', async (c) => {
  const db = c.env.DB;
  const body = await c.req.json<{ adminPassword?: string; newPassword?: string }>().catch(() => null);
  const existing = await db.prepare(`SELECT COUNT(*) AS n FROM t_users`).first<{ n: number }>();
  if ((existing?.n ?? 0) > 0) return c.json({ error: 'ALREADY_INITIALIZED' }, 403);
  if (!body?.adminPassword || !body.newPassword) return c.json({ error: 'BAD_REQUEST' }, 400);
  if (!c.env.ADMIN_INIT_PASSWORD || body.adminPassword !== c.env.ADMIN_INIT_PASSWORD) {
    return c.json({ error: 'FORBIDDEN' }, 403);
  }
  if (body.newPassword.length < 8) return c.json({ error: 'WEAK_PASSWORD' }, 400);

  const hash = await hashPassword(body.newPassword);
  const result = await db
    .prepare(`INSERT INTO t_users (username, password_hash, role, nickname) VALUES ('admin', ?, 'superadmin', '管理员')`)
    .bind(hash)
    .run();
  const userId = result.meta.last_row_id as number;

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await db.prepare(`INSERT INTO t_settings (key, value) VALUES (?, ?)`).bind(key, value).run();
  }

  const token = await createSession(db, userId);
  await logAudit(db, { actor_type: 'system', actor_id: 'setup', action: 'setup.init', target: 'admin' });

  c.header(
    'Set-Cookie',
    `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${30 * 24 * 3600}`
  );
  return c.json({ ok: true }, 201);
});

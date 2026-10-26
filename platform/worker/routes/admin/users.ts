// 管理端·用户管理 API（admin 及以上；删除与对 admin 角色的写操作仅 superadmin）
import { Hono } from 'hono';
import { requireRole, hashPassword, type AuthInfo } from '../../auth';
import { logAudit } from '../../audit';

const ROLE_ORDER: Record<string, number> = { user: 0, admin: 1, superadmin: 2 };

export const adminUserRoutes = new Hono<{ Bindings: { DB: D1Database }; Variables: { auth: AuthInfo } }>();

adminUserRoutes.use('/api/admin/users/*', requireRole('admin'));
adminUserRoutes.use('/api/admin/users', requireRole('admin'));

function clientIp(req: Request): string | undefined {
  return req.headers.get('cf-connecting-ip') ?? undefined;
}

type UserRow = {
  id: number; username: string; role: string; nickname: string | null;
  status: string; locked_until: string | null; created_at: string;
};

async function getActor(c: any): Promise<AuthInfo> {
  return c.get('auth');
}

async function isSuperadmin(c: any): Promise<boolean> {
  const auth = await getActor(c);
  return auth.role === 'superadmin';
}

// 对 admin 角色目标用户的写操作仅 superadmin（superadmin 自身可写）
async function guardTargetRole(c: any, targetRole: string): Promise<boolean> {
  if (targetRole === 'user') return true;
  return isSuperadmin(c);
}

adminUserRoutes.get('/api/admin/users', async (c) => {
  const q = c.req.query('q');
  let sql = `SELECT id, username, role, nickname, status, locked_until, created_at FROM t_users`;
  const rows = q
    ? (await c.env.DB.prepare(`${sql} WHERE username LIKE ? OR nickname LIKE ? ORDER BY id`).bind(`%${q}%`, `%${q}%`).all()).results
    : (await c.env.DB.prepare(`${sql} ORDER BY id`).all()).results;
  return c.json({ users: rows });
});

adminUserRoutes.post('/api/admin/users', async (c) => {
  const body = await c.req.json<{ username?: string; password?: string; nickname?: string; role?: string }>().catch(() => null);
  if (!body?.username || !body.password) return c.json({ error: 'BAD_REQUEST' }, 400);
  if (body.password.length < 8) return c.json({ error: 'WEAK_PASSWORD' }, 400);
  const role = body.role ?? 'user';
  if (!(role in ROLE_ORDER)) return c.json({ error: 'BAD_ROLE' }, 400);

  // 建 admin 需要 superadmin
  if (role !== 'user' && !(await isSuperadmin(c))) return c.json({ error: 'FORBIDDEN' }, 403);

  const dup = await c.env.DB.prepare(`SELECT id FROM t_users WHERE username = ?`).bind(body.username).first();
  if (dup) return c.json({ error: 'DUPLICATE' }, 409);

  const hash = await hashPassword(body.password);
  const result = await c.env.DB.prepare(
    `INSERT INTO t_users (username, password_hash, role, nickname) VALUES (?, ?, ?, ?)`
  ).bind(body.username, hash, role, body.nickname ?? null).run();

  const auth = await getActor(c);
  await logAudit(c.env.DB, { actor_type: 'user', actor_id: String(auth.userId), action: 'user.create', target: body.username, detail: { role }, ip: clientIp(c.req.raw) });
  return c.json({ ok: true, id: result.meta.last_row_id }, 201);
});

adminUserRoutes.put('/api/admin/users/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const target = await c.env.DB.prepare(`SELECT id, role, username FROM t_users WHERE id = ?`).bind(id).first<{ id: number; role: string; username: string }>();
  if (!target) return c.json({ error: 'NOT_FOUND' }, 404);
  if (!(await guardTargetRole(c, target.role))) return c.json({ error: 'FORBIDDEN' }, 403);

  const body = await c.req.json<{ nickname?: string; role?: string }>().catch(() => null);
  if (!body) return c.json({ error: 'BAD_REQUEST' }, 400);

  if (body.role !== undefined) {
    if (!(body.role in ROLE_ORDER)) return c.json({ error: 'BAD_ROLE' }, 400);
    if (!(await isSuperadmin(c))) return c.json({ error: 'FORBIDDEN' }, 403);
  }
  if (body.nickname !== undefined) {
    await c.env.DB.prepare(`UPDATE t_users SET nickname = ? WHERE id = ?`).bind(body.nickname, id).run();
  }
  if (body.role !== undefined) {
    await c.env.DB.prepare(`UPDATE t_users SET role = ? WHERE id = ?`).bind(body.role, id).run();
  }

  const auth = await getActor(c);
  await logAudit(c.env.DB, { actor_type: 'user', actor_id: String(auth.userId), action: 'user.update', target: target.username, detail: body, ip: clientIp(c.req.raw) });
  return c.json({ ok: true });
});

adminUserRoutes.delete('/api/admin/users/:id', async (c) => {
  if (!(await isSuperadmin(c))) return c.json({ error: 'FORBIDDEN' }, 403);
  const id = Number(c.req.param('id'));
  const target = await c.env.DB.prepare(`SELECT id, role, username FROM t_users WHERE id = ?`).bind(id).first<{ id: number; role: string; username: string }>();
  if (!target) return c.json({ error: 'NOT_FOUND' }, 404);
  if (target.role === 'superadmin' && target.id === (await getActor(c)).userId) {
    return c.json({ error: 'CANNOT_DELETE_SELF' }, 400);
  }

  // D27: 删除用户连带删除其所有小程序数据行（不 drop 表——表属于 applet）
  const registry = await c.env.DB.prepare(`SELECT key FROM t_settings WHERE key LIKE 'manifest.%'`).all<{ key: string }>();
  for (const { key } of registry.results) {
    const appletId = key.slice('manifest.'.length);
    const snapRow = await c.env.DB.prepare(`SELECT value FROM t_settings WHERE key = ?`).bind(key).first<{ value: string }>();
    if (!snapRow?.value) continue;
    const tables = Object.keys(JSON.parse(snapRow.value));
    for (const t of tables) {
      const physical = `a_${appletId.replace(/[^a-zA-Z0-9]+/g, '_')}_${t}`;
      await c.env.DB.prepare(`DELETE FROM ${physical} WHERE user_id = ?`).bind(id).run();
    }
  }
  await c.env.DB.prepare(`DELETE FROM t_sessions WHERE user_id = ?`).bind(id).run();
  await c.env.DB.prepare(`DELETE FROM t_applet_acls WHERE user_id = ?`).bind(id).run();
  await c.env.DB.prepare(`DELETE FROM t_users WHERE id = ?`).bind(id).run();

  const auth = await getActor(c);
  await logAudit(c.env.DB, { actor_type: 'user', actor_id: String(auth.userId), action: 'user.delete', target: target.username, detail: { id }, ip: clientIp(c.req.raw) });
  return c.json({ ok: true });
});

adminUserRoutes.post('/api/admin/users/:id/reset-password', async (c) => {
  const id = Number(c.req.param('id'));
  const target = await c.env.DB.prepare(`SELECT id, role, username FROM t_users WHERE id = ?`).bind(id).first<{ id: number; role: string; username: string }>();
  if (!target) return c.json({ error: 'NOT_FOUND' }, 404);
  if (!(await guardTargetRole(c, target.role))) return c.json({ error: 'FORBIDDEN' }, 403);

  const body = await c.req.json<{ newPassword?: string }>().catch(() => null);
  if (!body?.newPassword || body.newPassword.length < 8) return c.json({ error: 'WEAK_PASSWORD' }, 400);

  const hash = await hashPassword(body.newPassword);
  await c.env.DB.prepare(`UPDATE t_users SET password_hash = ?, failed_count = 0, locked_until = NULL WHERE id = ?`).bind(hash, id).run();
  // 密码重置后踢掉所有会话
  await c.env.DB.prepare(`DELETE FROM t_sessions WHERE user_id = ?`).bind(id).run();

  const auth = await getActor(c);
  await logAudit(c.env.DB, { actor_type: 'user', actor_id: String(auth.userId), action: 'user.reset_password', target: target.username, ip: clientIp(c.req.raw) });
  return c.json({ ok: true });
});

adminUserRoutes.post('/api/admin/users/:id/lock', async (c) => {
  const id = Number(c.req.param('id'));
  const target = await c.env.DB.prepare(`SELECT id, role, username FROM t_users WHERE id = ?`).bind(id).first<{ id: number; role: string; username: string }>();
  if (!target) return c.json({ error: 'NOT_FOUND' }, 404);
  if (!(await guardTargetRole(c, target.role))) return c.json({ error: 'FORBIDDEN' }, 403);

  await c.env.DB.prepare(`UPDATE t_users SET status = 'locked' WHERE id = ?`).bind(id).run();
  await c.env.DB.prepare(`DELETE FROM t_sessions WHERE user_id = ?`).bind(id).run();

  const auth = await getActor(c);
  await logAudit(c.env.DB, { actor_type: 'user', actor_id: String(auth.userId), action: 'user.lock', target: target.username, ip: clientIp(c.req.raw) });
  return c.json({ ok: true });
});

adminUserRoutes.post('/api/admin/users/:id/unlock', async (c) => {
  const id = Number(c.req.param('id'));
  const target = await c.env.DB.prepare(`SELECT id, role, username FROM t_users WHERE id = ?`).bind(id).first<{ id: number; role: string; username: string }>();
  if (!target) return c.json({ error: 'NOT_FOUND' }, 404);
  if (!(await guardTargetRole(c, target.role))) return c.json({ error: 'FORBIDDEN' }, 403);

  await c.env.DB.prepare(`UPDATE t_users SET status = 'normal', failed_count = 0, locked_until = NULL WHERE id = ?`).bind(id).run();

  const auth = await getActor(c);
  await logAudit(c.env.DB, { actor_type: 'user', actor_id: String(auth.userId), action: 'user.unlock', target: target.username, ip: clientIp(c.req.raw) });
  return c.json({ ok: true });
});

adminUserRoutes.post('/api/admin/users/import', async (c) => {
  const body = await c.req.json<{ csv?: string }>().catch(() => null);
  if (!body?.csv) return c.json({ error: 'BAD_REQUEST' }, 400);

  const lines = body.csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let start = 0;
  if (lines[0]?.toLowerCase().startsWith('username')) start = 1; // 表头

  const imported: string[] = [];
  const failed: { username: string; reason: string }[] = [];
  for (const line of lines.slice(start)) {
    const [username, password, nickname] = line.split(',').map((s) => s.trim());
    if (!username || !password) { failed.push({ username: username || '(空)', reason: 'bad_line' }); continue; }
    if (password.length < 8) { failed.push({ username, reason: 'weak_password' }); continue; }
    const dup = await c.env.DB.prepare(`SELECT id FROM t_users WHERE username = ?`).bind(username).first();
    if (dup) { failed.push({ username, reason: 'duplicate' }); continue; }
    const hash = await hashPassword(password);
    await c.env.DB.prepare(`INSERT INTO t_users (username, password_hash, role, nickname) VALUES (?, ?, 'user', ?)`).bind(username, hash, nickname ?? null).run();
    imported.push(username);
  }

  const auth = await getActor(c);
  await logAudit(c.env.DB, { actor_type: 'user', actor_id: String(auth.userId), action: 'user.import', detail: { imported: imported.length, failed: failed.length }, ip: clientIp(c.req.raw) });
  return c.json({ imported: imported.length, failed });
});

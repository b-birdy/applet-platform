// 用户侧 API：数据用量、导出、清除 + applet token 签发
import { Hono } from 'hono';
import { requireAuth, hashPassword, verifyPassword, type AuthInfo } from '../auth';
import { logAudit } from '../audit';
import { signAppletToken } from '../tokens';
import { appletTable } from '../data';

export const myRoutes = new Hono<{ Bindings: { DB: D1Database; MCP_SIGNING_KEY?: string }; Variables: { auth: AuthInfo } }>();

myRoutes.use('/api/applet-token', requireAuth());
myRoutes.use('/api/my/*', requireAuth());
myRoutes.use('/api/profile', requireAuth());

// 已授权 applet 的 slug 集合（admin 全通过）
async function authorizedSlugs(c: any): Promise<Set<string>> {
  const auth = c.get('auth') as AuthInfo;
  if (auth.role === 'admin' || auth.role === 'superadmin') {
    const rows = (await c.env.DB.prepare(`SELECT path FROM t_applets`).all() as any).results as { path: string }[];
    return new Set(rows.map((r) => r.path));
  }
  const rows = (await c.env.DB.prepare(
    `SELECT a.path FROM t_applets a JOIN t_applet_acls acl ON acl.applet_id = a.id AND acl.user_id = ? AND acl.allowed = 1
     WHERE a.status = 'enabled'`
  ).bind(auth.userId).all() as any).results as { path: string }[];
  return new Set(rows.map((r) => r.path));
}

async function requireAuthorizedApplet(c: any, slug: string): Promise<{ id: number } | null> {
  const slugs = await authorizedSlugs(c);
  if (!slugs.has(slug)) return null;
  return c.env.DB.prepare(`SELECT id FROM t_applets WHERE path = ?`).bind(slug).first() as Promise<{ id: number } | null>;
}

// 列出某用户可访问应用的数据表清单（从 manifest 快照）
async function appletTables(c: any, slug: string): Promise<string[]> {
  const row = await c.env.DB.prepare(`SELECT value FROM t_settings WHERE key = ?`).bind(`manifest.${slug}`).first() as { value: string } | null;
  return row?.value ? Object.keys(JSON.parse(row.value)) : [];
}

// token 签发：60 分钟
myRoutes.post('/api/applet-token', async (c) => {
  const auth = c.get('auth') as AuthInfo;
  const body = await c.req.json().catch((): { appletId?: string } | null => null) as { appletId?: string } | null;
  const appletId = body?.appletId;
  if (!appletId) return c.json({ error: 'BAD_REQUEST' }, 400);
  const applet = await requireAuthorizedApplet(c, appletId);
  if (!applet) return c.json({ error: 'APPLET_FORBIDDEN' }, 403);

  const key = c.env.MCP_SIGNING_KEY;
  if (!key) {
    // fail closed：Secret 漏配宁可不可用，也不签发可伪造凭据
    return c.json({ error: 'SIGNING_KEY_NOT_CONFIGURED' }, 503);
  }
  const token = await signAppletToken({ userId: auth.userId, appletId, exp: Math.floor(Date.now() / 1000) + 3600 }, key);
  return c.json({ token, expiresIn: 3600 });
});

// 数据用量：每授权应用的行数 + 最近活动
myRoutes.get('/api/my/usage', async (c) => {
  const auth = c.get('auth') as AuthInfo;
  const slugs = await authorizedSlugs(c);
  const applets: { appletId: string; rows: number; lastActivity: string | null }[] = [];
  for (const slug of slugs) {
    const tables = await appletTables(c, slug);
    let rows = 0;
    let lastActivity: string | null = null;
    for (const t of tables) {
      const tbl = appletTable(slug, t);
      const count = (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${tbl} WHERE user_id = ?`).bind(auth.userId).first()) as { n: number } | null;
      rows += count?.n ?? 0;
      const last = (await c.env.DB.prepare(`SELECT MAX(created_at) AS at FROM ${tbl} WHERE user_id = ?`).bind(auth.userId).first()) as { at: string | null } | null;
      if (last?.at && (!lastActivity || last.at > lastActivity)) lastActivity = last.at;
    }
    applets.push({ appletId: slug, rows, lastActivity });
  }
  return c.json({ applets });
});

// 数据表预览：每张表的说明与我的行数（不含任何数据内容，防风险）
myRoutes.get('/api/my/tables/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (!await requireAuthorizedApplet(c, slug)) return c.json({ error: 'APPLET_FORBIDDEN' }, 403);
  const auth = c.get('auth') as AuthInfo;
  const row = await c.env.DB.prepare(`SELECT value FROM t_settings WHERE key = ?`).bind(`manifest.${slug}`).first<{ value: string }>();
  if (!row?.value) return c.json({ tables: [] });
  const manifest = JSON.parse(row.value) as Record<string, { columns: Record<string, string>; description?: string }>;
  const tables: { name: string; description: string; rows: number }[] = [];
  for (const [name, def] of Object.entries(manifest)) {
    const tbl = appletTable(slug, name);
    const count = (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${tbl} WHERE user_id = ?`).bind(auth.userId).first()) as { n: number } | null;
    const colNames = Object.keys(def.columns);
    tables.push({
      name,
      description: def.description || `包含 ${colNames.length} 个字段：${colNames.join('、')}`,
      rows: count?.n ?? 0,
    });
  }
  return c.json({ tables });
});

// 导出本人数据（JSON 附件下载）
myRoutes.get('/api/my/export', async (c) => {
  const auth = c.get('auth') as AuthInfo;
  const slug = c.req.query('applet') ?? '';
  if (!slug || !(await requireAuthorizedApplet(c, slug))) return c.json({ error: 'APPLET_FORBIDDEN' }, 403);

  const tables = await appletTables(c, slug);
  const data: Record<string, unknown[]> = {};
  for (const t of tables) {
    const tbl = appletTable(slug, t);
    data[t] = ((await c.env.DB.prepare(`SELECT * FROM ${tbl} WHERE user_id = ? ORDER BY id`).bind(auth.userId).all()) as any).results;
  }
  const body = JSON.stringify({ applet: slug, exported_at: new Date().toISOString(), tables: data }, null, 2);
  return new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${slug}-export.json"`,
    },
  });
});

// 清除本人某应用全部数据（前端有确认弹窗；这里审计）
myRoutes.post('/api/my/purge', async (c) => {
  const auth = c.get('auth') as AuthInfo;
  const slug = c.req.query('applet') ?? '';
  if (!slug || !(await requireAuthorizedApplet(c, slug))) return c.json({ error: 'APPLET_FORBIDDEN' }, 403);

  const tables = await appletTables(c, slug);
  let deleted = 0;
  for (const t of tables) {
    const tbl = appletTable(slug, t);
    const result = await c.env.DB.prepare(`DELETE FROM ${tbl} WHERE user_id = ?`).bind(auth.userId).run();
    deleted += result.meta.changes ?? 0;
  }
  await logAudit(c.env.DB, { actor_type: 'user', actor_id: String(auth.userId), action: 'my.purge', target: slug, detail: { deleted } });
  return c.json({ ok: true, deleted });
});

// ---- 个人资料（计划缺口补齐：Profile 页所需）----

// 改昵称/主题偏好
myRoutes.put('/api/profile', async (c) => {
  const auth = c.get('auth') as AuthInfo;
  const body = await c.req.json().catch((): { nickname?: string; theme?: string } | null => null) as { nickname?: string; theme?: string } | null;
  if (!body) return c.json({ error: 'BAD_REQUEST' }, 400);
  if (body.nickname !== undefined) {
    await c.env.DB.prepare(`UPDATE t_users SET nickname = ? WHERE id = ?`).bind(body.nickname, auth.userId).run();
  }
  if (body.theme !== undefined) {
    const VALID_THEMES = ['light', 'dark', 'minimal', 'neon', 'glass', 'classic'];
    if (body.theme !== undefined && !VALID_THEMES.includes(body.theme)) return c.json({ error: 'BAD_REQUEST' }, 400);
    await c.env.DB.prepare(`INSERT INTO t_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .bind(`theme.${auth.userId}`, body.theme).run();
  }
  return c.json({ ok: true });
});

// 改密码（旧密码必填验证）
myRoutes.post('/api/profile/password', async (c) => {
  const auth = c.get('auth') as AuthInfo;
  const body = await c.req.json().catch((): { oldPassword?: string; newPassword?: string } | null => null) as { oldPassword?: string; newPassword?: string } | null;
  if (!body?.oldPassword || !body.newPassword) return c.json({ error: 'BAD_REQUEST' }, 400);
  if (body.newPassword.length < 8) return c.json({ error: 'WEAK_PASSWORD' }, 400);

  const user = (await c.env.DB.prepare(`SELECT password_hash FROM t_users WHERE id = ?`).bind(auth.userId).first()) as { password_hash: string } | null;
  if (!user || !(await verifyPassword(body.oldPassword, user.password_hash))) {
    return c.json({ error: 'WRONG_PASSWORD' }, 400);
  }
  await c.env.DB.prepare(`UPDATE t_users SET password_hash = ? WHERE id = ?`).bind(await hashPassword(body.newPassword), auth.userId).run();
  await logAudit(c.env.DB, { actor_type: 'user', actor_id: String(auth.userId), action: 'profile.password_changed' });
  return c.json({ ok: true });
});

// 登录历史（本人近 10 条 login.* 审计）
myRoutes.get('/api/my/logins', async (c) => {
  const auth = c.get('auth') as AuthInfo;
  const rows = (await c.env.DB.prepare(
    `SELECT action, at FROM t_audit_logs WHERE actor_type = 'user' AND actor_id = ? AND action LIKE 'login.%'
     ORDER BY id DESC LIMIT 10`
  ).bind(String(auth.userId)).all() as any).results;
  return c.json({ rows });
});

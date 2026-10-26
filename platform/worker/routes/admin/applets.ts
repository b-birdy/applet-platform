// 管理端·小程序管理 API
// :id 参数用 slug（t_applets.path），与 Data API/配额键一致
import { Hono } from 'hono';
import { requireRole, requireAuth, type AuthInfo } from '../../auth';
import { logAudit } from '../../audit';
import { dropAppletTables } from '../../data';
import { checkApplet } from '../../checker';

const STATUSES = new Set(['testing', 'enabled', 'disabled']);
// D11 状态机: testing⇄enabled⇄disabled；disabled→testing 非法
const TRANSITIONS: Record<string, Set<string>> = {
  testing: new Set(['enabled', 'disabled']),
  enabled: new Set(['testing', 'disabled']),
  disabled: new Set(['enabled']),
};

type AppletEnv = {
  Bindings: { DB: D1Database; ASSETS: R2Bucket };
  Variables: { auth: AuthInfo };
};

export const adminAppletRoutes = new Hono<AppletEnv>();
export type AppletRemover = { remove(appletId: string): Promise<void> };

// env 注入 remover（Task 10 接真身）；缺省 stub 抛错
function getRemover(c: any): AppletRemover {
  const wired = (c.env as any).APPLET_REMOVER as AppletRemover | undefined;
  if (wired) return wired;
  return {
    async remove() {
      throw new Error('remover not wired (Task 10)');
    },
  };
}

adminAppletRoutes.use('/api/admin/applets/*', requireRole('admin'));
adminAppletRoutes.use('/api/admin/applets', requireRole('admin'));

adminAppletRoutes.get('/api/admin/applets', async (c) => {
  const rows = (await c.env.DB.prepare(
    `SELECT a.id, a.name, a.path, a.icon, a.status, a.entry, a.created_at,
       (SELECT COUNT(*) FROM t_applet_acls acl WHERE acl.applet_id = a.id AND acl.allowed = 1) AS authorized_users,
       (SELECT COUNT(*) FROM t_prs pr WHERE pr.applet_id = a.id AND pr.state = 'open') AS open_prs
     FROM t_applets a ORDER BY a.id`
  ).all() as any).results as any[];

  // 表数量从 manifest 快照数
  for (const row of rows) {
    const snap = await c.env.DB.prepare(`SELECT value FROM t_settings WHERE key = ?`).bind(`manifest.${row.path}`).first<{ value: string }>();
    row.tables = snap?.value ? Object.keys(JSON.parse(snap.value)).length : 0;
  }
  return c.json({ applets: rows });
});

adminAppletRoutes.put('/api/admin/applets/:id', async (c) => {
  const slug = c.req.param('id');
  const applet = await c.env.DB.prepare(`SELECT id, name, path FROM t_applets WHERE path = ?`).bind(slug).first<{ id: number; name: string; path: string }>();
  if (!applet) return c.json({ error: 'NOT_FOUND' }, 404);

  const body = await c.req.json<{ name?: string; icon?: string; quota?: { rows?: number; bytes?: number } }>().catch(() => null);
  if (!body) return c.json({ error: 'BAD_REQUEST' }, 400);

  if (body.name !== undefined) await c.env.DB.prepare(`UPDATE t_applets SET name = ? WHERE id = ?`).bind(body.name, applet.id).run();
  if (body.icon !== undefined) await c.env.DB.prepare(`UPDATE t_applets SET icon = ? WHERE id = ?`).bind(body.icon, applet.id).run();

  // D32: 专属配额覆盖写 t_settings
  if (body.quota) {
    for (const [dim, val] of Object.entries(body.quota)) {
      if (val === undefined || val === null) continue;
      if (dim !== 'rows' && dim !== 'bytes') return c.json({ error: 'BAD_REQUEST' }, 400);
      const key = `quota.${slug}.${dim}`;
      await c.env.DB.prepare(`INSERT INTO t_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(key, String(val)).run();
    }
  }

  const auth = c.get('auth');
  await logAudit(c.env.DB, { actor_type: 'user', actor_id: String(auth.userId), action: 'applet.update', target: slug, detail: body });
  return c.json({ ok: true });
});

adminAppletRoutes.post('/api/admin/applets/:id/status', async (c) => {
  const slug = c.req.param('id');
  const applet = await c.env.DB.prepare(`SELECT id, status, path FROM t_applets WHERE path = ?`).bind(slug).first<{ id: number; status: string; path: string }>();
  if (!applet) return c.json({ error: 'NOT_FOUND' }, 404);

  const body = await c.req.json<{ status?: string }>().catch(() => null);
  const next = body?.status;
  if (!next || !STATUSES.has(next)) return c.json({ error: 'BAD_STATUS' }, 400);
  if (!TRANSITIONS[applet.status]?.has(next)) {
    return c.json({ error: 'INVALID_TRANSITION', from: applet.status, to: next }, 400);
  }

  await c.env.DB.prepare(`UPDATE t_applets SET status = ? WHERE id = ?`).bind(next, applet.id).run();
  const auth = c.get('auth');
  await logAudit(c.env.DB, { actor_type: 'user', actor_id: String(auth.userId), action: 'applet.status', target: slug, detail: { from: applet.status, to: next } });
  return c.json({ ok: true, status: next });
});

adminAppletRoutes.post('/api/admin/applets/:id/authorize', async (c) => {
  const slug = c.req.param('id');
  const applet = await c.env.DB.prepare(`SELECT id, path FROM t_applets WHERE path = ?`).bind(slug).first<{ id: number; path: string }>();
  if (!applet) return c.json({ error: 'NOT_FOUND' }, 404);

  const body = await c.req.json<{ userIds?: number[]; allowed?: boolean }>().catch(() => null);
  if (!Array.isArray(body?.userIds) || typeof body.allowed !== 'boolean') return c.json({ error: 'BAD_REQUEST' }, 400);

  for (const uid of body.userIds) {
    await c.env.DB.prepare(
      `INSERT INTO t_applet_acls (applet_id, user_id, allowed) VALUES (?, ?, ?)
       ON CONFLICT(applet_id, user_id) DO UPDATE SET allowed = excluded.allowed`
    ).bind(applet.id, uid, body.allowed ? 1 : 0).run();
  }

  const auth = c.get('auth');
  await logAudit(c.env.DB, { actor_type: 'user', actor_id: String(auth.userId), action: 'applet.authorize', target: slug, detail: { userIds: body.userIds, allowed: body.allowed } });
  return c.json({ ok: true, count: body.userIds.length });
});

adminAppletRoutes.get('/api/admin/applets/:id/check-report', async (c) => {
  const slug = c.req.param('id');
  const applet = await c.env.DB.prepare(`SELECT id, path, entry FROM t_applets WHERE path = ?`).bind(slug).first<{ id: number; path: string; entry: string | null }>();
  if (!applet) return c.json({ error: 'NOT_FOUND' }, 404);

  // 从 R2 prod/ 拉文件喂 checker
  const prefix = `prod/${slug}/`;
  const list = await c.env.ASSETS.list({ prefix });
  const files = new Map<string, string>();
  let truncated = false;
  for (const obj of list.objects) {
    if (!obj.key.startsWith(prefix)) continue;
    const rel = obj.key.slice(prefix.length);
    if (obj.size > 5 * 1024 * 1024) { truncated = true; continue; } // 大文件不进 checker 文本
    const body = await c.env.ASSETS.get(obj.key);
    if (body) files.set(rel, await body.text());
  }
  const issues = checkApplet(slug, files);
  if (truncated) issues.push({ level: 'warn', rule: 'asset.skipped', file: '*', message: '部分超大文件未纳入文本检查' });
  return c.json({ issues });
});

// 管理员只读查看任意用户数据
adminAppletRoutes.get('/api/admin/applets/:id/data/:table', async (c) => {
  const slug = c.req.param('id');
  const table = c.req.param('table');
  const snap = await c.env.DB.prepare(`SELECT value FROM t_settings WHERE key = ?`).bind(`manifest.${slug}`).first<{ value: string }>();
  if (!snap?.value) return c.json({ error: 'TABLE_NOT_FOUND' }, 404);
  const tables = JSON.parse(snap.value) as Record<string, unknown>;
  if (!(table in tables)) return c.json({ error: 'TABLE_NOT_FOUND' }, 404);

  const allowed = new Set(['id', 'user_id', 'created_at', ...Object.keys((tables[table] as any).columns ?? {})]);
  const colParam = c.req.query('columns');
  let colList = '*';
  if (colParam) {
    const cols = colParam.split(',').map((s) => s.trim());
    for (const col of cols) if (!allowed.has(col)) return c.json({ error: 'BAD_COLUMN' }, 400);
    colList = cols.map((cl) => `"${cl}"`).join(', ');
  }
  const limit = Math.min(Number(c.req.query('limit') || 100), 1000);
  const offset = Math.max(Number(c.req.query('offset') || 0), 0);
  const physical = `a_${slug.replace(/[^a-zA-Z0-9]+/g, '_')}_${table}`;
  const rows = (await c.env.DB.prepare(`SELECT ${colList} FROM ${physical} ORDER BY id LIMIT ? OFFSET ?`).bind(limit, offset).all()).results;
  const total = (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${physical}`).first()) as { n: number } | null;
  return c.json({ rows, total: total?.n ?? 0 });
});

adminAppletRoutes.delete('/api/admin/applets/:id', async (c) => {
  const slug = c.req.param('id');
  const applet = await c.env.DB.prepare(`SELECT id, path FROM t_applets WHERE path = ?`).bind(slug).first<{ id: number; path: string }>();
  if (!applet) return c.json({ error: 'NOT_FOUND' }, 404);

  // 外部系统清理（github 目录 + R2 键）——Task 10 接线真身
  const remover = getRemover(c);
  await remover.remove(slug);

  // D1 侧硬删除序列
  await dropAppletTables(c.env.DB, slug);
  await c.env.DB.prepare(`DELETE FROM t_applet_acls WHERE applet_id = ?`).bind(applet.id).run();
  await c.env.DB.prepare(`DELETE FROM t_prs WHERE applet_id = ?`).bind(applet.id).run();
  for (const key of [`quota.${slug}.rows`, `quota.${slug}.bytes`]) {
    await c.env.DB.prepare(`DELETE FROM t_settings WHERE key = ?`).bind(key).run();
  }
  await c.env.DB.prepare(`DELETE FROM t_applets WHERE id = ?`).bind(applet.id).run();

  const auth = c.get('auth');
  await logAudit(c.env.DB, { actor_type: 'user', actor_id: String(auth.userId), action: 'applet.delete', target: slug });
  return c.json({ ok: true });
});

// 用户侧最小路由（Task 7 提前实现，Task 14 补 usage/export/purge）
// 仅返回被授权且 enabled 的应用；admin 角色看全部（含 testing/disabled）
adminAppletRoutes.use('/api/my/applets', requireAuth());
adminAppletRoutes.get('/api/my/applets', async (c) => {
  const auth = c.get('auth');
  const isAdmin = auth.role === 'admin' || auth.role === 'superadmin';
  let rows: any[];
  if (isAdmin) {
    rows = (await c.env.DB.prepare(
      `SELECT id, name, path, icon, status, entry FROM t_applets ORDER BY id`
    ).all() as any).results as any[];
  } else {
    rows = (await c.env.DB.prepare(
      `SELECT a.id, a.name, a.path, a.icon, a.status, a.entry
       FROM t_applets a JOIN t_applet_acls acl ON acl.applet_id = a.id AND acl.user_id = ? AND acl.allowed = 1
       WHERE a.status = 'enabled' ORDER BY a.id`
    ).bind(auth.userId).all() as any).results as any[];
  }
  return c.json({ applets: rows });
});

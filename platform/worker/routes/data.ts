// Data API: /api/data/:appletId/:table — 用户隔离的通用 CRUD + batch
// 表/列名走白名单拼接；值永远参数化；强制 user_id 过滤
import { Hono } from 'hono';
import { getAuth, type AuthInfo } from '../auth';
import { getRegisteredTables, appletTable } from '../data';
import { getQuota } from '../settings';
import { verifyAppletToken } from '../tokens';
import { logAudit } from '../audit';

type DataEnv = { Bindings: { DB: D1Database; MCP_SIGNING_KEY?: string } };

async function resolveUser(c: any, appletId: string): Promise<AuthInfo | 'SCOPE' | null> {
  const authHeader = c.req.header('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const payload = await verifyAppletToken(token, c.env.MCP_SIGNING_KEY ?? 'insecure-dev-key');
    if (!payload) return null;
    // 签名有效但 applet 不符 → 作用域错误（403），不是未认证
    if (payload.appletId !== appletId) return 'SCOPE';
    return { userId: payload.userId, role: 'user', username: `applet:${payload.appletId}` };
  }
  return getAuth(c.req.raw, c.env.DB);
}

export const dataRoutes = new Hono<DataEnv>();

dataRoutes.use('/api/data/:appletId/:table/*', async (c, next) => { await next(); });
dataRoutes.use('/api/data/:appletId/:table', async (c, next) => { await next(); });

async function requireAccess(c: any, appletId: string): Promise<AuthInfo | { error: [number, string] }> {
  const auth = await resolveUser(c, appletId);
  if (auth === 'SCOPE') return { error: [403, 'APPLET_FORBIDDEN'] as [number, string] };
  if (!auth) return { error: [401, 'UNAUTHORIZED'] as [number, string] };

  // applet token 已绑定 applet；session 用户需查授权与状态
  if (!auth.username.startsWith('applet:')) {
    const applet = await c.env.DB.prepare(`SELECT status FROM t_applets WHERE path = ?`).bind(appletId).first() as { status: string } | null;
    if (!applet) return { error: [404, 'APPLET_NOT_FOUND'] as [number, string] };
    if (applet.status !== 'enabled') {
      const me = await c.env.DB.prepare(`SELECT role FROM t_users WHERE id = ?`).bind(auth.userId).first() as { role: string } | null;
      if (me?.role !== 'admin' && me?.role !== 'superadmin') return { error: [403, 'APPLET_FORBIDDEN'] as [number, string] };
    } else {
      const acl = await c.env.DB.prepare(`SELECT allowed FROM t_applet_acls WHERE applet_id = (SELECT id FROM t_applets WHERE path = ?) AND user_id = ?`).bind(appletId, auth.userId).first() as { allowed: number } | null;
      const me = await c.env.DB.prepare(`SELECT role FROM t_users WHERE id = ?`).bind(auth.userId).first() as { role: string } | null;
      const isAdmin = me?.role === 'admin' || me?.role === 'superadmin';
      if (!isAdmin && acl?.allowed !== 1) return { error: [403, 'APPLET_FORBIDDEN'] as [number, string] };
    }
  }
  return auth;
}

function parseColumns(c: any, allowed: Set<string>): string[] | { error: [number, string] } {
  const colParam = c.req.query('columns') || c.req.query('column');
  if (!colParam) return ['*'];
  const cols = colParam.split(',').map((s: string) => s.trim());
  for (const col of cols) {
    if (!allowed.has(col)) return { error: [400, 'BAD_COLUMN'] as [number, string] };
  }
  return cols;
}

dataRoutes.get('/api/data/:appletId/:table', async (c) => {
  const { appletId, table } = c.req.param();
  const access = await requireAccess(c, appletId);
  if ('error' in access) return c.json({ error: access.error[1] }, access.error[0] as any);
  const auth = access;

  const registry = await getRegisteredTables(c.env.DB, appletId);
  const allowed = registry.get(table);
  if (!allowed) return c.json({ error: 'TABLE_NOT_FOUND' }, 404);

  const cols = parseColumns(c, allowed);
  if ('error' in cols) return c.json({ error: cols.error[1] }, 400);

  const limit = Math.min(Number(c.req.query('limit') || 100), 1000);
  const offset = Math.max(Number(c.req.query('offset') || 0), 0);
  const colList = cols.includes('*') ? '*' : cols.map((cl) => `"${cl}"`).join(', ');

  const rows = await c.env.DB.prepare(
    `SELECT ${colList} FROM ${appletTable(appletId, table)} WHERE user_id = ? ORDER BY id LIMIT ? OFFSET ?`
  ).bind(auth.userId, limit, offset).all();
  const total = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${appletTable(appletId, table)} WHERE user_id = ?`).bind(auth.userId).first() as { n: number } | null;

  return c.json({ rows: rows.results, total: total?.n ?? 0 });
});

// 写入前配额检查
async function checkQuota(c: any, appletId: string, userId: number, table: string, incoming: number) {
  const quota = await getQuota(c.env.DB, appletId);
  const tbl = appletTable(appletId, table);
  const count = (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${tbl}`).first()) as { n: number } | null;
  const used = count?.n ?? 0;
  if (used + incoming > quota.rows) {
    return c.json({ error: 'QUOTA_EXCEEDED', used: { rows: used, bytes: 0 }, limit: quota }, 413);
  }
  return null;
}

function filterColumns(allowed: Set<string>, body: Record<string, unknown>, skip: Set<string> = new Set()): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // 系统列永不接受客户端写入
  const never = new Set(['id', 'created_at', ...skip]);
  for (const [k, v] of Object.entries(body)) {
    if (k === 'user_id') continue; // 伪造 user_id 一律忽略
    if (never.has(k)) continue;
    if (allowed.has(k)) out[k] = v;
  }
  return out;
}

function validateRequired(allowed: Set<string>, body: Record<string, unknown>): string | null {
  for (const [k, v] of Object.entries(body)) {
    if (allowed.has(k) && (v === null || v === undefined)) return k;
  }
  return null;
}

dataRoutes.post('/api/data/:appletId/:table', async (c) => {
  const { appletId, table } = c.req.param();
  const access = await requireAccess(c, appletId);
  if ('error' in access) return c.json({ error: access.error[1] }, access.error[0] as any);
  const auth = access;

  const registry = await getRegisteredTables(c.env.DB, appletId);
  const allowed = registry.get(table);
  if (!allowed) return c.json({ error: 'TABLE_NOT_FOUND' }, 404);

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return c.json({ error: 'BAD_REQUEST' }, 400);
  const values = filterColumns(allowed, body);
  const bad = validateRequired(allowed, values);
  if (bad) return c.json({ error: 'REQUIRED_FIELD', field: bad }, 400);

  const q = await checkQuota(c, appletId, auth.userId, table, 1);
  if (q) return q;

  const keys = Object.keys(values);
  if (keys.length === 0) return c.json({ error: 'BAD_REQUEST' }, 400);
  const placeholders = keys.map(() => '?').join(', ');
  const result = await c.env.DB.prepare(
    `INSERT INTO ${appletTable(appletId, table)} (user_id, ${keys.map((k) => `"${k}"`).join(', ')}) VALUES (?, ${placeholders})`
  ).bind(auth.userId, ...Object.values(values)).run();

  return c.json({ ok: true, id: result.meta.last_row_id }, 201);
});

dataRoutes.put('/api/data/:appletId/:table/:id', async (c) => {
  const { appletId, table, id } = c.req.param();
  const access = await requireAccess(c, appletId);
  if ('error' in access) return c.json({ error: access.error[1] }, access.error[0] as any);
  const auth = access;

  const registry = await getRegisteredTables(c.env.DB, appletId);
  const allowed = registry.get(table);
  if (!allowed) return c.json({ error: 'TABLE_NOT_FOUND' }, 404);

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return c.json({ error: 'BAD_REQUEST' }, 400);
  const values = filterColumns(allowed, body, new Set(['id', 'created_at']));
  const keys = Object.keys(values);
  if (keys.length === 0) return c.json({ error: 'BAD_REQUEST' }, 400);

  const result = await c.env.DB.prepare(
    `UPDATE ${appletTable(appletId, table)} SET ${keys.map((k) => `"${k}" = ?`).join(', ')} WHERE id = ? AND user_id = ?`
  ).bind(...Object.values(values), Number(id), auth.userId).run();
  if ((result.meta.changes ?? 0) === 0) return c.json({ error: 'NOT_FOUND' }, 404);
  return c.json({ ok: true });
});

dataRoutes.delete('/api/data/:appletId/:table/:id', async (c) => {
  const { appletId, table, id } = c.req.param();
  const access = await requireAccess(c, appletId);
  if ('error' in access) return c.json({ error: access.error[1] }, access.error[0] as any);
  const auth = access;

  const result = await c.env.DB.prepare(
    `DELETE FROM ${appletTable(appletId, table)} WHERE id = ? AND user_id = ?`
  ).bind(Number(id), auth.userId).run();
  if ((result.meta.changes ?? 0) === 0) return c.json({ error: 'NOT_FOUND' }, 404);
  return c.json({ ok: true });
});

dataRoutes.post('/api/data/:appletId/:table/batch', async (c) => {
  const { appletId, table } = c.req.param();
  const access = await requireAccess(c, appletId);
  if ('error' in access) return c.json({ error: access.error[1] }, access.error[0] as any);
  const auth = access;

  const registry = await getRegisteredTables(c.env.DB, appletId);
  const allowed = registry.get(table);
  if (!allowed) return c.json({ error: 'TABLE_NOT_FOUND' }, 404);

  const body = await c.req.json<{ rows?: Record<string, unknown>[] }>().catch(() => null);
  if (!body?.rows || !Array.isArray(body.rows) || body.rows.length === 0) return c.json({ error: 'BAD_REQUEST' }, 400);
  if (body.rows.length > 1000) return c.json({ error: 'TOO_MANY_ROWS' }, 400);

  for (const row of body.rows) {
    const values = filterColumns(allowed, row);
    const bad = validateRequired(allowed, values);
    if (bad) return c.json({ error: 'REQUIRED_FIELD', field: bad }, 400);
    if (Object.keys(values).length === 0) return c.json({ error: 'BAD_REQUEST' }, 400);
  }

  const q = await checkQuota(c, appletId, auth.userId, table, body.rows.length);
  if (q) return q;

  // 事务：全部成功或全部回滚
  const stmts = body.rows.map((row) => {
    const values = filterColumns(allowed, row);
    const keys = Object.keys(values);
    return c.env.DB.prepare(
      `INSERT INTO ${appletTable(appletId, table)} (user_id, ${keys.map((k) => `"${k}"`).join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})`
    ).bind(auth.userId, ...Object.values(values));
  });
  await c.env.DB.batch(stmts);
  return c.json({ ok: true, count: body.rows.length }, 200);
});

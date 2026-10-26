// MCP HTTP 端点（无状态 Streamable HTTP，仅 POST）+ agent 管理 API
import { Hono } from 'hono';
import { hashPassword, type AuthInfo } from '../auth';
import { logAudit } from '../audit';
import { hashAgentKey, randomToken, rpcOk, rpcError, dispatchTool, wrapTool } from '../mcp';

type McpRouteEnv = {
  Bindings: { DB: D1Database; ASSETS: R2Bucket };
  Variables: { auth: AuthInfo };
};

export const mcpRoutes = new Hono<McpRouteEnv>();

async function authenticate(c: any): Promise<{ kind: 'access_code'; code: string } | { kind: 'agent'; agent: { id: number; name: string; status: string } } | null> {
  const header = c.req.header('authorization') ?? '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  if (!token) return null;

  // 1) agent API key（SHA-256 查库 O(1)）
  const keyHash = await hashAgentKey(token);
  const agent = await c.env.DB.prepare(`SELECT id, name, status FROM t_agents WHERE key_hash = ?`).bind(keyHash).first() as { id: number; name: string; status: string } | null;
  if (agent) return { kind: 'agent', agent };

  // 2) 一次性准入码
  const code = await c.env.DB.prepare(`SELECT code FROM t_agent_access_codes WHERE code = ?`).bind(token).first() as { code: string } | null;
  if (code) return { kind: 'access_code', code: token };

  return null;
}

mcpRoutes.post('/mcp', async (c) => {
  const auth = await authenticate(c);
  if (!auth) return c.json({ error: 'UNAUTHORIZED' }, 401);

  let message: any;
  try {
    message = await c.req.json();
  } catch {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }

  // 批量（数组）不必要支持：单请求单消息
  const { id, method, params } = message ?? {};

  // 通知：无 id → 204 无响应体
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') return new Response(null, { status: 204 });
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: notifications not supported except initialized' } }, 400);
  }

  switch (method) {
    case 'initialize':
      return c.json(rpcOk(id, {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'applet-platform', version: '0.1.0' },
      }).body);
    case 'tools/list':
      return c.json(rpcOk(id, {
        tools: [
          { name: 'agent_apply', description: '凭一次性准入码申请接入（仅准入码可用）', inputSchema: { type: 'object', properties: { name: { type: 'string' }, fingerprint: { type: 'string' } }, required: ['name', 'fingerprint'] } },
          { name: 'get_spec', description: '获取小程序开发规范（structure/manifest/data/security/upload/all）', inputSchema: { type: 'object', properties: { section: { type: 'string', enum: ['all', 'structure', 'manifest', 'data', 'security', 'upload'] } } } },
          { name: 'check_applet', description: '对文件集跑规范检查，返回 issues', inputSchema: { type: 'object', properties: { applet_id: { type: 'string' }, files: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['applet_id', 'files'] } },
          { name: 'submit_applet', description: '提交小程序（建分支+PR）；error 级问题阻断', inputSchema: { type: 'object', properties: { applet_id: { type: 'string' }, name: { type: 'string' }, files: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['applet_id', 'name', 'files'] } },
          { name: 'get_status', description: '查询提交状态与检查报告（限已归属 applet）', inputSchema: { type: 'object', properties: { applet_id: { type: 'string' } }, required: ['applet_id'] } },
        ],
      }).body);
    case 'tools/call': {
      const name = params?.name;
      if (typeof name !== 'string') return c.json(rpcError(id, -32602, 'Invalid params: name required').body);
      const result = await dispatchTool({ DB: c.env.DB, ASSETS: c.env.ASSETS, GITHUB: null }, auth, name, params?.arguments ?? {});
      // 工具输出（含拒绝）都作为 JSON-RPC result 返回；HTTP 状态仅表达传输层语义
      return c.json({ jsonrpc: '2.0', id, result: result.body }, result.status as any);
    }
    default:
      return c.json(rpcError(id, -32601, `Method not found: ${method}`).body);
  }
});

// ---------- 管理端：准入码与 agent 审批 ----------

export const mcpAdminRoutes = new Hono<McpRouteEnv & { Variables: { auth: AuthInfo } }>();

mcpAdminRoutes.use('/api/admin/access-codes', requireAdmin());
mcpAdminRoutes.use('/api/admin/agents/*', requireAdmin());
mcpAdminRoutes.use('/api/admin/agents', requireAdmin());

function requireAdmin() {
  return async (c: any, next: () => Promise<void>) => {
    const { requireRole } = await import('../auth');
    return requireRole('admin')(c, next);
  };
}

mcpAdminRoutes.post('/api/admin/access-codes', async (c) => {
  const code = randomToken(16);
  const body = (await c.req.json().catch((): { expiresInHours?: number } | null => null)) as { expiresInHours?: number };
  const hours = Math.min(Math.max(Number(body?.expiresInHours ?? 24), 1), 24 * 7);
  await c.env.DB.prepare(`INSERT INTO t_agent_access_codes (code, created_by, expires_at) VALUES (?, ?, datetime('now', ?))`)
    .bind(code, c.get('auth').userId, `+${hours} hours`).run();
  const auth = c.get('auth');
  await logAudit(c.env.DB, { actor_type: 'user', actor_id: String(auth.userId), action: 'agent.code_created', detail: { hours } });
  return c.json({ code, expiresInHours: hours }, 201);
});

mcpAdminRoutes.get('/api/admin/agents', async (c) => {
  const rows = (await c.env.DB.prepare(
    `SELECT a.id, a.name, a.fingerprint, a.status, a.applied_at, a.last_seen,
       (SELECT COUNT(*) FROM t_agent_applets aa WHERE aa.agent_id = a.id) AS applet_count
     FROM t_agents a ORDER BY a.id`
  ).all() as any).results;
  return c.json({ agents: rows });
});

mcpAdminRoutes.post('/api/admin/agents/:id/approve', async (c) => {
  const id = Number(c.req.param('id'));
  const agent = await c.env.DB.prepare(`SELECT id, name, status FROM t_agents WHERE id = ?`).bind(id).first() as { id: number; name: string; status: string } | null;
  if (!agent) return c.json({ error: 'NOT_FOUND' }, 404);
  if (agent.status !== 'pending') return c.json({ error: 'NOT_PENDING' }, 409);

  // 32B 高熵 key；SHA-256 哈希落库，明文仅此一次返回
  const key = 'apk_' + randomToken(32);
  await c.env.DB.prepare(`UPDATE t_agents SET status = 'approved', key_hash = ?, approved_by = ? WHERE id = ?`)
    .bind(await hashAgentKey(key), c.get('auth').userId, id).run();
  const auth = c.get('auth');
  await logAudit(c.env.DB, { actor_type: 'user', actor_id: String(auth.userId), action: 'agent.approve', target: agent.name });
  return c.json({ ok: true, key }); // 明文仅此一次
});

mcpAdminRoutes.post('/api/admin/agents/:id/reject', async (c) => {
  const id = Number(c.req.param('id'));
  const agent = await c.env.DB.prepare(`SELECT id, name, status FROM t_agents WHERE id = ?`).bind(id).first() as { id: number; name: string; status: string } | null;
  if (!agent) return c.json({ error: 'NOT_FOUND' }, 404);
  if (agent.status !== 'pending') return c.json({ error: 'NOT_PENDING' }, 409);
  await c.env.DB.prepare(`DELETE FROM t_agents WHERE id = ?`).bind(id).run();
  const auth = c.get('auth');
  await logAudit(c.env.DB, { actor_type: 'user', actor_id: String(auth.userId), action: 'agent.reject', target: agent.name });
  return c.json({ ok: true });
});

mcpAdminRoutes.post('/api/admin/agents/:id/revoke', async (c) => {
  const id = Number(c.req.param('id'));
  const agent = await c.env.DB.prepare(`SELECT id, name, status FROM t_agents WHERE id = ?`).bind(id).first() as { id: number; name: string; status: string } | null;
  if (!agent) return c.json({ error: 'NOT_FOUND' }, 404);
  if (agent.status !== 'approved') return c.json({ error: 'NOT_APPROVED' }, 409);
  // 吊销即清 key_hash → 立即 401；归属保留（记录性）
  await c.env.DB.prepare(`UPDATE t_agents SET status = 'revoked', key_hash = NULL WHERE id = ?`).bind(id).run();
  const auth = c.get('auth');
  await logAudit(c.env.DB, { actor_type: 'user', actor_id: String(auth.userId), action: 'agent.revoke', target: agent.name });
  return c.json({ ok: true });
});

mcpAdminRoutes.post('/api/admin/agents/:id/grant', async (c) => {
  const id = Number(c.req.param('id'));
  const agent = await c.env.DB.prepare(`SELECT id, name FROM t_agents WHERE id = ?`).bind(id).first<{ id: number; name: string }>();
  if (!agent) return c.json({ error: 'NOT_FOUND' }, 404);
  const body = await c.req.json<{ appletId?: string }>().catch(() => null);
  if (!body?.appletId) return c.json({ error: 'BAD_REQUEST' }, 400);
  const applet = await c.env.DB.prepare(`SELECT id FROM t_applets WHERE path = ?`).bind(body.appletId).first<{ id: number }>();
  if (!applet) return c.json({ error: 'APPLET_NOT_FOUND' }, 404);

  await c.env.DB.prepare(`INSERT INTO t_agent_applets (agent_id, applet_id, source) VALUES (?, ?, 'granted') ON CONFLICT DO NOTHING`).bind(id, applet.id).run();
  const auth = c.get('auth');
  await logAudit(c.env.DB, { actor_type: 'user', actor_id: String(auth.userId), action: 'agent.grant', target: agent.name, detail: { applet: body.appletId } });
  return c.json({ ok: true });
});

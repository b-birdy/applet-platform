// MCP 服务内核：JSON-RPC 2.0 分发 + agent 工具（无状态）
import { SPEC_MD as specMd } from './spec-text';
import { checkAppletWithSizes } from './checker';
import { getGithubClient } from './github-bind';
import { registerAppletTables, SchemaChangeError, type ManifestTable } from './data';

const enc = new TextEncoder();

/** agent API key 哈希：256 位高熵随机数用 SHA-256 即可（无需口令拉伸），支持 O(1) 查库 */
export async function hashAgentKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(key));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- JSON-RPC 分发 ----------

export type RpcResult = { status: number; body: unknown };

export function rpcError(id: unknown, code: number, message: string): RpcResult {
  return { status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

export function rpcOk(id: unknown, result: unknown): RpcResult {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

/** 工具级拒绝：HTTP 403，但仍是 JSON-RPC result（content 包 JSON 错误） */
function toolDenied(error: string, extra?: Record<string, unknown>): RpcResult {
  return { status: 403, body: wrapTool({ ok: false, error, ...extra }) };
}

export function wrapTool(payload: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

// ---------- get_spec ----------

const SPEC_SECTIONS = ['structure', 'manifest', 'data', 'security', 'upload', '接口参考'];

export function extractSection(md: string, section: string): string | null {
  if (section === 'all') return md;
  const heads: { name: string; start: number }[] = [];
  const re = /^## (.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) heads.push({ name: m[1].trim(), start: m.index });
  for (let i = 0; i < heads.length; i++) {
    const end = i + 1 < heads.length ? heads[i + 1].start : md.length;
    if (heads[i].name === section) return md.slice(heads[i].start, end).trim();
  }
  return null;
}

// ---------- 工具实现 ----------

export type McpEnv = {
  DB: D1Database;
  ASSETS: R2Bucket;
  GITHUB: any; // 延迟经 getGithubClient 解析
};

export type AuthCtx =
  | { kind: 'access_code'; code: string }
  | { kind: 'agent'; agent: { id: number; name: string; status: string } };

const TOOL_NAMES = ['agent_apply', 'get_spec', 'check_applet', 'submit_applet', 'get_status'];

export async function dispatchTool(env: McpEnv, auth: AuthCtx, name: string, args: any): Promise<RpcResult> {
  // access_code 只许 agent_apply
  if (auth.kind === 'access_code') {
    if (name !== 'agent_apply') return toolDenied('ACCESS_CODE_TOOL_FORBIDDEN');
    return agentApply(env, auth.code, args);
  }
  const agent = auth.agent;
  if (name === 'agent_apply') return toolDenied('AGENT_ALREADY_AUTHED');
  if (agent.status !== 'approved') return toolDenied('AGENT_NOT_APPROVED', { status: agent.status });

  switch (name) {
    case 'get_spec': {
      const section = String(args?.section ?? 'all');
      const text = extractSection(specMd, section);
      if (text === null) return { status: 200, body: wrapTool({ ok: false, error: 'UNKNOWN_SECTION', sections: SPEC_SECTIONS }) };
      return { status: 200, body: wrapTool({ ok: true, section, text }) };
    }
    case 'check_applet':
      return checkAppletTool(args);
    case 'submit_applet':
      return submitApplet(env, agent, args);
    case 'get_status':
      return getStatus(env, agent, args);
    default:
      return toolDenied('UNKNOWN_TOOL');
  }
}

async function agentApply(env: McpEnv, code: string, args: any): Promise<RpcResult> {
  const name = String(args?.name ?? '').trim();
  const fingerprint = String(args?.fingerprint ?? '').trim();
  if (!name || !fingerprint) return toolDenied('BAD_REQUEST');

  const row = await env.DB.prepare(`SELECT used_by, expires_at FROM t_agent_access_codes WHERE code = ?`).bind(code).first<{ used_by: number | null; expires_at: string | null }>();
  if (!row) return toolDenied('BAD_CODE');
  if (row.used_by !== null) return toolDenied('CODE_ALREADY_USED');
  if (row.expires_at && new Date(row.expires_at + 'Z').getTime() < Date.now()) return toolDenied('CODE_EXPIRED');

  const result = await env.DB.prepare(`INSERT INTO t_agents (name, fingerprint, status) VALUES (?, ?, 'pending')`).bind(name, fingerprint).run();
  const agentId = result.meta.last_row_id as number;
  await env.DB.prepare(`UPDATE t_agent_access_codes SET used_by = ?, used_at = datetime('now') WHERE code = ?`).bind(agentId, code).run();
  await env.DB.prepare(`INSERT INTO t_audit_logs (actor_type, actor_id, action, target, detail) VALUES ('agent', ?, 'agent.apply', ?, ?)`)
    .bind(String(agentId), name, JSON.stringify({ fingerprint })).run();

  return { status: 200, body: wrapTool({ ok: true, status: 'pending', agent_id: agentId }) };
}

function issuesFromFiles(files: Record<string, string>, appletId: string) {
  const map = new Map<string, string>();
  const sizes = new Map<string, number>();
  for (const [path, content] of Object.entries(files ?? {})) {
    if (typeof content !== 'string') continue;
    map.set(path, content);
    sizes.set(path, enc.encode(content).byteLength);
  }
  return checkAppletWithSizes(appletId, map, sizes);
}

function checkAppletTool(args: any): RpcResult {
  const appletId = String(args?.applet_id ?? '');
  if (!appletId) return toolDenied('BAD_REQUEST');
  const issues = issuesFromFiles(args?.files ?? {}, appletId);
  return { status: 200, body: wrapTool({ ok: !issues.some((i) => i.level === 'error'), issues }) };
}

async function submitApplet(env: McpEnv, agent: { id: number; name: string }, args: any): Promise<RpcResult> {
  const appletId = String(args?.applet_id ?? '').trim();
  const displayName = String(args?.name ?? appletId).trim();
  if (!appletId || !/^[a-z][a-z0-9-]*$/.test(appletId)) return toolDenied('BAD_REQUEST');

  // D25 归属校验：已归属 → 放行；applet 不存在 → 首次提交建立归属；存在但非己有 → AGENT_SCOPE
  const existing = await env.DB.prepare(`SELECT id, entry FROM t_applets WHERE path = ?`).bind(appletId).first<{ id: number; entry: string | null }>();
  if (existing) {
    const owned = await env.DB.prepare(`SELECT 1 AS ok FROM t_agent_applets WHERE agent_id = ? AND applet_id = ?`).bind(agent.id, existing.id).first();
    if (!owned) return toolDenied('AGENT_SCOPE');
  }

  // 检查（含资产体积 D29）；error 阻断
  const issues = issuesFromFiles(args?.files ?? {}, appletId);
  if (issues.some((i) => i.level === 'error')) {
    return { status: 200, body: wrapTool({ ok: false, issues }) };
  }

  const gh = getGithubClient(undefined);
  const files = args?.files ?? {};
  let entry: string | null = null;
  let display = 'embed';
  try {
    const m = JSON.parse(files['applet.json']);
    entry = m.entry ?? null;
    if (m.display === 'new_tab') display = 'new_tab';
  } catch { /* checker 已验过清单 */ }

  const fileMap = new Map<string, string | { contentBase64: string }>();
  for (const [path, content] of Object.entries(files)) {
    if (typeof content === 'string') fileMap.set(`applets/${appletId}/${path}`, content);
  }

  // 无注册行则建（首个提交者建立归属）
  let appletRowId = existing?.id;
  if (!appletRowId) {
    const ins = await env.DB.prepare(`INSERT INTO t_applets (name, path, status, entry, display) VALUES (?, ?, 'testing', ?, ?)`).bind(displayName, appletId, entry, display).run();
    appletRowId = ins.meta.last_row_id as number;
  }

  // 数据表注册/演进（Critical #1：生产链路必须建物理表与清单快照）
  try {
    const manifest = JSON.parse(files['applet.json']);
    if (Array.isArray(manifest.tables)) {
      await registerAppletTables(env.DB, appletId, manifest.tables as ManifestTable[]);
    }
    await env.DB.prepare(`UPDATE t_applets SET entry = ?, display = ? WHERE path = ?`).bind(entry, display, appletId).run();
  } catch (e) {
    if (e instanceof SchemaChangeError) {
      return toolDenied('SCHEMA_CHANGE', { message: e.message, issues: [{ level: 'error', rule: 'manifest.evolution', file: 'applet.json', message: e.message }] });
    }
    throw e;
  }

  const author = { name: `applet-agent[${agent.id}]`, email: `${agent.name}@agents.noreply.applet-platform` };
  await gh.putFiles(`applet/${appletId}`, fileMap, `submit applet ${appletId} by agent ${agent.id}`, author);

  // D28: 已有 open PR 则同分支更新（不新开）
  const open = await env.DB.prepare(`SELECT pr_number FROM t_prs WHERE applet_id = ? AND state = 'open'`).bind(appletRowId).first<{ pr_number: number }>();
  let prNumber: number;
  if (open) {
    prNumber = open.pr_number;
  } else {
    prNumber = await gh.openPR(`Applet: ${displayName} (${appletId})`, `applet/${appletId}`, 'main');
    await env.DB.prepare(`INSERT INTO t_prs (applet_id, pr_number, branch, state) VALUES (?, ?, ?, 'open')`).bind(appletRowId, prNumber, `applet/${appletId}`).run();
    await env.DB.prepare(`INSERT INTO t_agent_applets (agent_id, applet_id, source) VALUES (?, ?, 'submitted') ON CONFLICT DO NOTHING`).bind(agent.id, appletRowId).run();
  }

  // 检查报告落库（管理端可查）
  await env.DB.prepare(`INSERT INTO t_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .bind(`check_report.${appletId}`, JSON.stringify(issues)).run();

  await env.DB.prepare(`INSERT INTO t_audit_logs (actor_type, actor_id, action, target, detail) VALUES ('agent', ?, 'agent.submit', ?, ?)`)
    .bind(String(agent.id), appletId, JSON.stringify({ pr: prNumber })).run();

  return { status: 200, body: wrapTool({ ok: true, pr_number: prNumber }) };
}

async function getStatus(env: McpEnv, agent: { id: number }, args: any): Promise<RpcResult> {
  const appletId = String(args?.applet_id ?? '');
  const applet = await env.DB.prepare(`SELECT id, status FROM t_applets WHERE path = ?`).bind(appletId).first<{ id: number; status: string }>();
  if (!applet) return toolDenied('NOT_FOUND');
  const owned = await env.DB.prepare(`SELECT 1 AS ok FROM t_agent_applets WHERE agent_id = ? AND applet_id = ?`).bind(agent.id, applet.id).first();
  if (!owned) return toolDenied('AGENT_SCOPE');

  const pr = await env.DB.prepare(`SELECT pr_number, state FROM t_prs WHERE applet_id = ? ORDER BY pr_number DESC LIMIT 1`).bind(applet.id).first<{ pr_number: number; state: string }>();
  const report = await env.DB.prepare(`SELECT value FROM t_settings WHERE key = ?`).bind(`check_report.${appletId}`).first<{ value: string }>();
  return {
    status: 200,
    body: wrapTool({
      ok: true,
      applet_id: appletId,
      platform_status: applet.status,
      pr: pr ? { number: pr.pr_number, state: pr.state } : null,
      check_report: report?.value ? JSON.parse(report.value) : null,
    }),
  };
}

export { TOOL_NAMES };

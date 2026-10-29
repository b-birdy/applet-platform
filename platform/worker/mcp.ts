// MCP 服务内核：JSON-RPC 2.0 分发 + agent 工具（无状态）
import { SPEC_MD as specMd } from './spec-text';
import { checkAppletWithSizes } from './checker';
import { getGithubClientForEnv } from './github-bind';
import { registerAppletTables, SchemaChangeError, ReservedColumnError, appletTable, normalizeVersion, type ManifestTable } from './data';
import { getQuota } from './settings';

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
  GITHUB?: unknown;
  GITHUB_TOKEN?: string;
  GITHUB_OWNER?: string;
  GITHUB_REPO?: string;
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
    case 'import_data':
      return importData(env, agent, args);
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

  const gh = getGithubClientForEnv(env);
  const files = args?.files ?? {};
  let entry: string | null = null;
  let display = 'embed';
  let version: string | null = null;
  try {
    const m = JSON.parse(files['applet.json']);
    entry = m.entry ?? null;
    if (m.display === 'new_tab') display = 'new_tab';
    version = normalizeVersion(m.version);
  } catch { /* checker 已验过清单 */ }

  const fileMap = new Map<string, string | { contentBase64: string }>();
  for (const [path, content] of Object.entries(files)) {
    if (typeof content === 'string') fileMap.set(`applets/${appletId}/${path}`, content);
  }

  // 无注册行则建（首个提交者建立归属）；git 操作失败时回滚，避免孤儿行卡死后续提交
  let createdHere = false;
  let appletRowId = existing?.id;
  if (!appletRowId) {
    const ins = await env.DB.prepare(`INSERT INTO t_applets (name, path, status, entry, display, version) VALUES (?, ?, 'testing', ?, ?, ?)`).bind(displayName, appletId, entry, display, version).run();
    appletRowId = ins.meta.last_row_id as number;
    createdHere = true;
  }

  // 数据表注册/演进（Critical #1：生产链路必须建物理表与清单快照）
  try {
    const manifest = JSON.parse(files['applet.json']);
    if (Array.isArray(manifest.tables)) {
      await registerAppletTables(env.DB, appletId, manifest.tables as ManifestTable[]);
    }
    await env.DB.prepare(`UPDATE t_applets SET entry = ?, display = ?, version = COALESCE(?, version) WHERE path = ?`).bind(entry, display, version, appletId).run();
  } catch (e) {
    if (e instanceof SchemaChangeError || e instanceof ReservedColumnError) {
      const rule = e instanceof ReservedColumnError ? 'manifest.table' : 'manifest.evolution';
      return toolDenied(e instanceof ReservedColumnError ? 'RESERVED_COLUMN' : 'SCHEMA_CHANGE', { message: e.message, issues: [{ level: 'error', rule, file: 'applet.json', message: e.message }] });
    }
    throw e;
  }

  const author = { name: `applet-agent[${agent.id}]`, email: `${agent.name}@agents.noreply.applet-platform` };
  // 版本发布说明：清单 changelog 优先（get_spec 已约定），缺省回退通用文案
  let changelog = '';
  try {
    const m = JSON.parse(files['applet.json']);
    if (typeof m.changelog === 'string' && m.changelog.trim()) changelog = m.changelog.trim().split('\n')[0];
  } catch { /* checker 已验过清单 */ }
  const commitMsg = changelog
    ? `submit applet ${appletId} by agent ${agent.id}: ${changelog}`
    : `submit applet ${appletId} by agent ${agent.id}`;
  let newBranchSha: string;
  let prNumber: number;
  try {
    newBranchSha = await gh.putFiles(`applet/${appletId}`, fileMap, commitMsg, author);

    // D28: 已有 open PR 则同分支更新（不新开）
    const open = await env.DB.prepare(`SELECT pr_number FROM t_prs WHERE applet_id = ? AND state = 'open'`).bind(appletRowId).first<{ pr_number: number }>();
    if (open) {
      prNumber = open.pr_number;
    } else {
      try {
        prNumber = await gh.openPR(`Applet: ${displayName} (${appletId})`, `applet/${appletId}`, 'main');
      } catch (e) {
        // 该分支曾有历史 PR（closed/merged）时 GitHub 拒绝再开（422）。
        // 出路：删分支引用 → 重放 putFiles（新提交）→ 再开 PR（新分支引用无历史）。
        if (!(e instanceof Error) || !/422/.test(e.message)) throw e;
        await gh.deleteBranch(`applet/${appletId}`);
        await gh.putFiles(`applet/${appletId}`, fileMap, `${commitMsg} (branch rebuilt)`, author);
        prNumber = await gh.openPR(`Applet: ${displayName} (${appletId})`, `applet/${appletId}`, 'main');
      }
    }
  } catch (e) {
    // 回滚本次新建的注册行/表，让 agent 可以原样重试
    if (createdHere) {
      const tables = Object.keys((JSON.parse(files['applet.json']).tables ?? []) as unknown as Record<string, unknown>);
      for (const t of tables) {
        await env.DB.prepare(`DROP TABLE IF EXISTS ${appletTable(appletId, t)}`).run().catch(() => {});
      }
      await env.DB.prepare(`DELETE FROM t_settings WHERE key = ?`).bind(`manifest.${appletId}`).run().catch(() => {});
      await env.DB.prepare(`DELETE FROM t_applets WHERE id = ?`).bind(appletRowId).run().catch(() => {});
    }
    console.error('submit_applet git failure:', e);
    return toolDenied('GIT_SUBMIT_FAILED', { message: e instanceof Error ? e.message : 'git submit failed', applet_id: appletId });
  }
  if (createdHere || !(await env.DB.prepare(`SELECT 1 AS ok FROM t_prs WHERE applet_id = ? AND state = 'open'`).bind(appletRowId).first())) {
    // upsert：同 applet 可能存在历史 merged 行（t_prs 主键是 applet_id）
    await env.DB.prepare(
      `INSERT INTO t_prs (applet_id, pr_number, branch, state) VALUES (?, ?, ?, 'open')
       ON CONFLICT(applet_id) DO UPDATE SET pr_number = excluded.pr_number, branch = excluded.branch, state = 'open'`
    ).bind(appletRowId, prNumber, `applet/${appletId}`).run();
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
  // 归属 agent 的名字（agent 看得到自己是谁）
  const self = await env.DB.prepare(`SELECT name FROM t_agents WHERE id = ?`).bind(agent.id).first<{ name: string }>();
  // 可操作范围提示（帮助 agent 理解 AGENT_SCOPE）
  const ownedCount = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM t_agent_applets WHERE agent_id = ?`).bind(agent.id).first<{ n: number }>())?.n ?? 0;
  return {
    status: 200,
    body: wrapTool({
      ok: true,
      applet_id: appletId,
      your_agent: { id: agent.id, name: self?.name ?? String(agent.id) },
      platform_status: applet.status,
      status_meaning: applet.status === 'testing' ? '已注册未上线：管理员审阅合并 PR 后手动启用'
        : applet.status === 'enabled' ? '已上线，被授权用户可使用'
        : '已停用',
      pr: pr ? { number: pr.pr_number, state: pr.state } : null,
      check_report: report?.value ? JSON.parse(report.value) : null,
      next_steps: pr?.state === 'open'
        ? '等待管理员在平台内审阅合并；如有 error 级 issues，修正后重新 submit_applet（同分支自动更新本 PR）'
        : '等待管理员审阅；提交新版本会走同分支更新流程',
      your_accessible_applets: ownedCount,
    }),
  };
}

/** agent 向自己名下 applet 的数据表批量导入数据（归属指定用户，保持用户隔离模型） */
async function importData(env: McpEnv, agent: { id: number; name: string }, args: any): Promise<RpcResult> {
  const appletId = String(args?.applet_id ?? '').trim();
  const table = String(args?.table ?? '').trim();
  const rows = Array.isArray(args?.rows) ? args.rows : null;
  const asUser = String(args?.as_user ?? 'admin').trim() || 'admin';
  if (!appletId || !table || !rows || rows.length === 0) return toolDenied('BAD_REQUEST');
  if (rows.length > 1000) return toolDenied('TOO_MANY_ROWS');

  // 归属校验（D25）
  const applet = await env.DB.prepare(`SELECT id FROM t_applets WHERE path = ?`).bind(appletId).first<{ id: number }>();
  if (!applet) return toolDenied('NOT_FOUND');
  const owned = await env.DB.prepare(`SELECT 1 AS ok FROM t_agent_applets WHERE agent_id = ? AND applet_id = ?`).bind(agent.id, applet.id).first();
  if (!owned) return toolDenied('AGENT_SCOPE');

  // 表与列白名单（来自清单快照）
  const snap = await env.DB.prepare(`SELECT value FROM t_settings WHERE key = ?`).bind(`manifest.${appletId}`).first<{ value: string }>();
  if (!snap?.value) return toolDenied('TABLE_NOT_FOUND');
  const manifest = JSON.parse(snap.value) as Record<string, { columns: Record<string, string> }>;
  if (!manifest[table]) return toolDenied('TABLE_NOT_FOUND', { table });
  const allowed = new Set(Object.keys(manifest[table].columns));
  // 清单不携带 required 标记（快照只存 name→type）——required 列由 D1 NOT NULL 兜底，
  // 但把常见 NOT NULL 错误转为清晰提示（见下方 catch）

  // 目标用户
  const user = await env.DB.prepare(`SELECT id FROM t_users WHERE username = ?`).bind(asUser).first<{ id: number }>();
  if (!user) return toolDenied('USER_NOT_FOUND', { username: asUser });

  // 行清洗：托管列丢弃、非白名单列拒绝（显式报错优于静默丢字段——与读路径对称）
  const clean: Record<string, unknown>[] = [];
  for (const r of rows) {
    const vals: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r ?? {})) {
      if (k === 'id' || k === 'created_at' || k === 'user_id') continue;
      if (!allowed.has(k)) return toolDenied('BAD_COLUMN', { table, column: k });
      vals[k] = v;
    }
    if (Object.keys(vals).length === 0) return toolDenied('BAD_REQUEST', { message: '某行不含任何有效列' });
    clean.push(vals);
  }

  // 配额（按目标用户计）
  const quota = await getQuota(env.DB, appletId);
  const count = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${appletTable(appletId, table)} WHERE user_id = ?`).bind(user.id).first()) as { n: number } | null;
  if ((count?.n ?? 0) + clean.length > quota.rows) {
    return toolDenied('QUOTA_EXCEEDED', { used: { rows: count?.n ?? 0 }, limit: quota, incoming: clean.length });
  }

  const stmts = clean.map((vals) => {
    const keys = Object.keys(vals);
    return env.DB.prepare(
      `INSERT INTO ${appletTable(appletId, table)} (user_id, ${keys.map((k) => `"${k}"`).join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})`
    ).bind(user.id, ...Object.values(vals));
  });
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    if (e instanceof Error && /NOT NULL constraint failed: [^.]+\.([a-z_]+)/i.test(e.message)) {
      const col = e.message.match(/NOT NULL constraint failed: [^.]+\.([a-z_]+)/i)![1];
      return toolDenied('REQUIRED_FIELD', { table, column: col, message: `列 ${col} 为必填（NOT NULL），导入行中缺失或为 null` });
    }
    throw e;
  }

  await env.DB.prepare(`INSERT INTO t_audit_logs (actor_type, actor_id, action, target, detail) VALUES ('agent', ?, 'agent.import_data', ?, ?)`)
    .bind(String(agent.id), appletId, JSON.stringify({ table, rows: clean.length, as_user: asUser })).run();

  return { status: 200, body: wrapTool({ ok: true, imported: clean.length, table, as_user: asUser }) };
}

export { TOOL_NAMES };

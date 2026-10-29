// 管理端·小程序管理 API
// :id 参数用 slug（t_applets.path），与 Data API/配额键一致
import { Hono } from 'hono';
import { requireRole, requireAuth, type AuthInfo } from '../../auth';
import { logAudit } from '../../audit';
import { dropAppletTables, normalizeVersion } from '../../data';
import { checkApplet } from '../../checker';
import { createAppletRemover } from '../../remover';
import { getGithubClientForEnv } from '../../github-bind';

const STATUSES = new Set(['testing', 'enabled', 'disabled']);
// 状态任意互切（D11 放宽）：管理员显式操作，无需限制路径
const TRANSITIONS: Record<string, Set<string>> = {
  testing: new Set(['enabled', 'disabled']),
  enabled: new Set(['testing', 'disabled']),
  disabled: new Set(['testing', 'enabled']),
};

type AppletEnv = {
  Bindings: { DB: D1Database; ASSETS: R2Bucket; GITHUB_TOKEN?: string; GITHUB_OWNER?: string; GITHUB_REPO?: string; GITHUB?: unknown };
  Variables: { auth: AuthInfo };
};

export const adminAppletRoutes = new Hono<AppletEnv>();
export type AppletRemover = { remove(appletId: string): Promise<void> };

// env 注入 remover（测试可覆盖）；缺省用真身（github + R2 清理）
function getRemover(c: any): AppletRemover {
  const wired = (c.env as any).APPLET_REMOVER as AppletRemover | undefined;
  if (wired) return wired;
  return createAppletRemover({ DB: c.env.DB, ASSETS: c.env.ASSETS, GITHUB: getGithubClientForEnv(c.env) });
}

adminAppletRoutes.use('/api/admin/applets/*', requireRole('admin'));
adminAppletRoutes.use('/api/admin/applets', requireRole('admin'));

adminAppletRoutes.get('/api/admin/applets', async (c) => {
  const rows = (await c.env.DB.prepare(
    `SELECT a.id, a.name, a.path, a.icon, a.status, a.entry, a.display, a.created_at, a.version,
       (SELECT COUNT(*) FROM t_applet_acls acl WHERE acl.applet_id = a.id AND acl.allowed = 1) AS authorized_users,
       (SELECT COUNT(*) FROM t_prs pr WHERE pr.applet_id = a.id AND pr.state = 'open') AS open_prs,
       (SELECT pr_number FROM t_prs pr WHERE pr.applet_id = a.id AND pr.state = 'open' LIMIT 1) AS open_pr_number
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

  const body = await c.req.json<{ name?: string; icon?: string; display?: string; version?: string; quota?: { rows?: number; bytes?: number } }>().catch(() => null);
  if (!body) return c.json({ error: 'BAD_REQUEST' }, 400);
  if (body.display !== undefined && !['embed', 'new_tab'].includes(body.display)) return c.json({ error: 'BAD_DISPLAY' }, 400);
  if (body.version !== undefined && body.version !== null && body.version !== '' && !normalizeVersion(body.version)) return c.json({ error: 'BAD_VERSION' }, 400);

  if (body.icon !== undefined && body.icon.length > 100_000) return c.json({ error: 'ICON_TOO_LARGE' }, 400);
  if (body.name !== undefined) await c.env.DB.prepare(`UPDATE t_applets SET name = ? WHERE id = ?`).bind(body.name, applet.id).run();
  if (body.icon !== undefined) await c.env.DB.prepare(`UPDATE t_applets SET icon = ? WHERE id = ?`).bind(body.icon, applet.id).run();
  if (body.display !== undefined) await c.env.DB.prepare(`UPDATE t_applets SET display = ? WHERE id = ?`).bind(body.display, applet.id).run();
  if (body.version !== undefined) {
    const ver = body.version === null || body.version === '' ? null : normalizeVersion(body.version);
    await c.env.DB.prepare(`UPDATE t_applets SET version = ? WHERE id = ?`).bind(ver, applet.id).run();
  }

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

  // D1 侧硬删除序列（先清子行，否则 FK 约束失败）
  await dropAppletTables(c.env.DB, slug);
  await c.env.DB.prepare(`DELETE FROM t_agent_applets WHERE applet_id = ?`).bind(applet.id).run();
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

// 功能健康检查（功能性测试模块的自动化部分）：
// ① 静态规范 ② 运行时引用完整性（自包含 HTML 是否有外链残留/资源缺失）
// ③ 数据层健康（清单表 ↔ 物理表一致、平台列存在）
// 版本历史：main 分支上该 applet 目录的提交列表（message 即版本说明）
adminAppletRoutes.get('/api/admin/applets/:id/versions', async (c) => {
  const slug = c.req.param('id');
  const applet = await c.env.DB.prepare(`SELECT id, path FROM t_applets WHERE path = ?`).bind(slug).first<{ id: number; path: string }>();
  if (!applet) return c.json({ error: 'NOT_FOUND' }, 404);
  const gh = getGithubClientForEnv(c.env);
  try {
    const commits = await gh.listCommits('main', `applets/${slug}`);
    return c.json({ versions: commits });
  } catch (e) {
    return c.json({ error: 'GIT_LIST_FAILED', message: e instanceof Error ? e.message : String(e) }, 503);
  }
});

// 切换版本：把 main 上该 applet 目录回退到指定 commit 的内容（生成回退提交，不 force-push、不改历史）
// 数据安全：先跑 registerAppletTables 的演进规则——目标清单若要求改类型/删列/删表 → 拒绝（数据无法承载）
adminAppletRoutes.post('/api/admin/applets/:id/switch-version', async (c) => {
  const slug = c.req.param('id');
  const applet = await c.env.DB.prepare(`SELECT id, path FROM t_applets WHERE path = ?`).bind(slug).first<{ id: number; path: string }>();
  if (!applet) return c.json({ error: 'NOT_FOUND' }, 404);
  const body = await c.req.json<{ sha?: string }>().catch(() => null);
  if (!body?.sha || !/^[0-9a-f]{7,40}$/.test(body.sha)) return c.json({ error: 'BAD_REQUEST' }, 400);

  const gh = getGithubClientForEnv(c.env);

  // 1) 读目标 commit 上该目录的文件清单与内容
  let targetFiles: Map<string, string>;
  try {
    const tree = await gh.getTree(body.sha);
    const paths = tree.filter((e) => e.path.startsWith(`applets/${slug}/`)).map((e) => e.path);
    if (paths.length === 0) return c.json({ error: 'VERSION_EMPTY', message: '目标版本中不存在该小程序的文件' }, 400);
    targetFiles = new Map();
    for (const p of paths) {
      const raw = await gh.getContent(body.sha, p);
      if (raw !== null) targetFiles.set(p, new TextDecoder().decode(raw));
    }
  } catch (e) {
    return c.json({ error: 'GIT_READ_FAILED', message: e instanceof Error ? e.message : String(e) }, 503);
  }
  const manifestRaw = targetFiles.get(`applets/${slug}/applet.json`);
  if (!manifestRaw) return c.json({ error: 'VERSION_MANIFEST_MISSING', message: '目标版本缺少 applet.json' }, 400);
  let manifest: any;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch {
    return c.json({ error: 'VERSION_MANIFEST_INVALID', message: '目标版本 applet.json 不是合法 JSON' }, 400);
  }

  // 2) 数据承载校验：改类型/删表 → 拒绝（数据无法承载）；清单少列放行（管理员显式回退，
  //    物理列与数据保留，仅不再写入）
  const { registerAppletTables, SchemaChangeError, ReservedColumnError } = await import('../../data');
  try {
    if (Array.isArray(manifest.tables)) {
      await registerAppletTables(c.env.DB, slug, manifest.tables, { allowColumnShrink: true });
    }
  } catch (e) {
    if (e instanceof SchemaChangeError || e instanceof ReservedColumnError) {
      return c.json({ error: 'DATA_INCOMPATIBLE', message: `旧版本的数据表无法承载切换（${e.message}）。如确需切换，请先备份并清空相关数据。` }, 409);
    }
    throw e;
  }

  // 3) 以回退提交落到 main（正常 commit，历史保留、可再切回来）
  const author = { name: 'platform[bot]', email: 'platform@noreply.applet-platform' };
  const fileMap = new Map([...targetFiles.entries()].map(([p, content]) => {
    const rel = p.slice(`applets/${slug}/`.length);
    return [rel, content] as const;
  }));
  let newSha: string;
  try {
    // deleteDir 幂等清掉目录再写入目标版本的全部文件（覆盖删除场景：新版本有而旧版本没有的文件）
    newSha = await gh.deleteDir('main', `applets/${slug}`, `revert applets/${slug} to ${body.sha.slice(0, 7)} (version switch)`, author);
    if (fileMap.size > 0) {
      const putMap = new Map([...fileMap.entries()].map(([rel, content]) => [`${slug}/${rel}`, content] as const));
      newSha = await gh.putFiles('main', putMap as any, `revert applets/${slug} to ${body.sha.slice(0, 7)} (version switch)`, author, 'main');
    }
  } catch (e) {
    return c.json({ error: 'GIT_SWITCH_FAILED', message: e instanceof Error ? e.message : String(e) }, 503);
  }

  // 4) 更新注册行 entry/display/version + 刷新 R2
  let entry = manifest.entry ?? null;
  let display = manifest.display === 'new_tab' ? 'new_tab' : 'embed';
  const version = normalizeVersion(manifest.version);
  await c.env.DB.prepare(`UPDATE t_applets SET entry = ?, display = ?, version = COALESCE(?, version) WHERE id = ?`)
    .bind(entry, display, version, applet.id).run();
  const { refreshApplet } = await import('../../sync');
  await refreshApplet({ DB: c.env.DB, ASSETS: c.env.ASSETS, GITHUB: gh } as any, slug);

  const auth = c.get('auth');
  await logAudit(c.env.DB, { actor_type: 'user', actor_id: String(auth.userId), action: 'applet.version_switch', target: slug, detail: { sha: body.sha.slice(0, 7), commit: newSha } });
  return c.json({ ok: true, commit: newSha });
});

adminAppletRoutes.get('/api/admin/applets/:id/health', async (c) => {
  const slug = c.req.param('id');
  const applet = await c.env.DB.prepare(`SELECT id, path, entry, status FROM t_applets WHERE path = ?`).bind(slug).first<{ id: number; path: string; entry: string | null; status: string }>();
  if (!applet) return c.json({ error: 'NOT_FOUND' }, 404);

  const checks: { area: string; name: string; ok: boolean; message: string }[] = [];

  // ① 静态规范（checker 对 R2 现有文件）
  const prefix = `prod/${slug}/`;
  const list = await c.env.ASSETS.list({ prefix });
  const files = new Map<string, string>();
  for (const obj of list.objects) {
    if (!obj.key.startsWith(prefix)) continue;
    if (obj.size > 5 * 1024 * 1024) continue;
    const body = await c.env.ASSETS.get(obj.key);
    if (body) files.set(obj.key.slice(prefix.length), await body.text());
  }
  const { checkApplet } = await import('../../checker');
  const issues = checkApplet(slug, files);
  checks.push({
    area: '静态规范', name: 'checker 全量规则',
    ok: !issues.some((i) => i.level === 'error'),
    message: issues.length ? issues.map((i) => `[${i.level}] ${i.rule} ${i.file}: ${i.message}`).join('\n') : '全部通过',
  });

  // ② 运行时完整性：对"伺服管线输出"（内联+主题注入后）检查，而非原始 R2 文件——
  // 用户浏览器看到的正是伺服结果，检查必须与之一致
  const entry = applet.entry ?? 'index.html';
  const entryHtml = files.get(entry);
  if (!entryHtml) {
    checks.push({ area: '运行时', name: '入口文件', ok: false, message: `入口 ${entry} 在 R2 中不存在（可能未合并 PR 或同步失败）` });
  } else {
    // 模拟 serve 的自包含化流程：内联相对路径资源（与 serve.ts inlineAsset 相同的 key 规则）
    let served = entryHtml;
    const inlineOne = async (path: string): Promise<string | null> => {
      if (/^(https?:|\/|data:)/i.test(path)) return null;
      const normalized = path.replace(/^\.\//, '');
      if (normalized.includes('..')) return null;
      const asset = await c.env.ASSETS.get(`${prefix}${normalized}`);
      return asset ? await asset.text() : null;
    };
    // link stylesheet
    const linkRe = /<link\s+[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi;
    let m: RegExpExecArray | null;
    const linkJobs: Array<{ full: string; href: string }> = [];
    while ((m = linkRe.exec(served))) linkJobs.push({ full: m[0], href: m[1] });
    for (const { full, href } of linkJobs) {
      const css = await inlineOne(href);
      if (css !== null) served = served.replace(full, `<style data-inlined-from="${href}">\n${css}\n</style>`);
    }
    // script src（相对路径）
    const scriptRe = /<script\s+([^>]*)src=["']([^"']+)["']([^>]*)><\/script>/gi;
    const scriptJobs: Array<{ full: string; src: string }> = [];
    while ((m = scriptRe.exec(served))) scriptJobs.push({ full: m[0], src: m[1] + m[2] + m[3] ? m[2] : m[2] });
    for (const { full, src } of scriptJobs) {
      if (/^(https?:|\/)/i.test(src)) continue;
      const js = await inlineOne(src);
      if (js !== null) served = served.replace(full, `<script data-inlined-from="${src}">\n${js}\n</script>`);
    }
    const runtimeRe = /<script\s+src=["']\/app-runtime\.js["']\s*><\/script>/gi;
    if (runtimeRe.test(served)) {
      const { RUNTIME_JS } = await import('../../runtime-text');
      served = served.replace(runtimeRe, `<script data-applet-runtime>\n${RUNTIME_JS}\n</script>`);
    }

    const externalLeft = [...served.matchAll(/<(?:link[^>]*stylesheet|script[^>]*src=)[^>]*>/gi)]
      .filter((mm) => !/app-runtime/.test(mm[0]) && !/https?:\/\//.test(mm[0]))
      .map((mm) => mm[0].slice(0, 80));
    checks.push({ area: '运行时', name: '自包含化（外链残留）', ok: externalLeft.length === 0, message: externalLeft.length ? `内联后仍有外链（资源缺失或路径问题）：${externalLeft.join('; ')}` : '无外链，自包含完整' });
    checks.push({ area: '运行时', name: '平台运行时已内联', ok: served.includes('data-applet-runtime'), message: served.includes('data-applet-runtime') ? '已内联' : '未发现运行时标记——确认入口引入了 /app-runtime.js' });
    checks.push({ area: '运行时', name: '主题变量注入（伺服时）', ok: true, message: '由伺服层按用户主题动态注入，此处不做静态断言' });
  }

  // ③ 数据层：清单声明的表 vs 物理表
  const snapRow = await c.env.DB.prepare(`SELECT value FROM t_settings WHERE key = ?`).bind(`manifest.${slug}`).first<{ value: string }>();
  if (!snapRow?.value) {
    checks.push({ area: '数据层', name: '清单快照', ok: false, message: 'manifest 快照缺失——数据 API 将不可用（TABLE_NOT_FOUND）' });
  } else {
    const declared = Object.keys(JSON.parse(snapRow.value));
    for (const t of declared) {
      const physical = `a_${slug.replace(/[^a-zA-Z0-9]+/g, '_')}_${t}`;
      const exists = await c.env.DB.prepare(`SELECT name FROM sqlite_master WHERE name = ?`).bind(physical).first();
      checks.push({ area: '数据层', name: `物理表 ${physical}`, ok: !!exists, message: exists ? '存在' : '清单已声明但物理表不存在——重新触发同步可修复' });
    }
    // 反向：孤儿物理表
    const declaredPhysical = new Set(declared.map((t) => `a_${slug.replace(/[^a-zA-Z0-9]+/g, '_')}_${t}`));
    const allTables = (await c.env.DB.prepare(`SELECT name FROM sqlite_master WHERE name LIKE ?`).bind(`a_${slug.replace(/[^a-zA-Z0-9]+/g, '_')}_%`).all<{ name: string }>()).results;
    for (const t of allTables) {
      if (!declaredPhysical.has(t.name)) {
        // ?fix=1：直接 DROP 孤儿表（运维参数，幂等；孤儿表不属于任何已声明清单）
        if (c.req.query('fix') === '1') {
          await c.env.DB.prepare(`DROP TABLE IF EXISTS "${t.name}"`).run();
          checks.push({ area: '数据层', name: `孤儿表 ${t.name}`, ok: true, message: '已清理（fix=1 执行 DROP）' });
          const auth = c.get('auth');
          await logAudit(c.env.DB, { actor_type: 'user', actor_id: String(auth.userId), action: 'applet.health_fix', target: slug, detail: { dropped: t.name } });
        } else {
          checks.push({ area: '数据层', name: `孤儿表 ${t.name}`, ok: false, message: '物理表存在但清单未声明（历史残留）——health?fix=1 可自动清理' });
        }
      }
    }
  }

  const allOk = checks.every((c2) => c2.ok);
  return c.json({ ok: allOk, status: applet.status, checks });
});

// 小程序历史时间线（日志管理模块）：该 applet 的审计事件 + PR 状态变化 + agent 归属，按时间倒序
adminAppletRoutes.get('/api/admin/applets/:id/history', async (c) => {
  const slug = c.req.param('id');
  const applet = await c.env.DB.prepare(`SELECT id, path FROM t_applets WHERE path = ?`).bind(slug).first<{ id: number; path: string }>();
  if (!applet) return c.json({ error: 'NOT_FOUND' }, 404);

  // 审计日志中与该 applet 相关的事件（target=path 或 detail 含 path；agent.submit 的 target 是 appletId）
  const audits = (await c.env.DB.prepare(
    `SELECT al.id, al.at, al.actor_type, al.actor_id, al.action, al.target, al.detail,
       u.username AS actor_username
     FROM t_audit_logs al LEFT JOIN t_users u ON u.id = CAST(al.actor_id AS INTEGER) AND al.actor_type = 'user'
     WHERE al.target = ? OR al.action LIKE 'agent.%' OR al.action = 'applet.merge_pr'
     ORDER BY al.id DESC LIMIT 200`
  ).bind(slug).all() as any).results as any[];

  // 过滤：target 精确匹配 slug 的 + agent 提交/审批类事件（宽松匹配后由 detail 校正）
  const relevant = audits.filter((r) =>
    r.target === slug ||
    ['agent.approve', 'agent.reject', 'agent.revoke', 'agent.grant', 'sync.once'].includes(r.action) === false && r.target === slug ||
    (r.action === 'agent.submit' && r.target === slug)
  );

  // PR 历史
  const prs = (await c.env.DB.prepare(
    `SELECT pr_number, branch, state FROM t_prs WHERE applet_id = ? ORDER BY pr_number DESC`
  ).bind(applet.id).all() as any).results;

  // 当前归属 agent
  const agents = (await c.env.DB.prepare(
    `SELECT a.id, a.name, aa.source FROM t_agent_applets aa JOIN t_agents a ON a.id = aa.agent_id WHERE aa.applet_id = ?`
  ).bind(applet.id).all() as any).results;

  return c.json({
    applet: { path: applet.path },
    events: relevant.map((r) => ({
      at: r.at, actorType: r.actor_type, actorId: r.actor_id,
      actorName: r.actor_username ?? (r.actor_type === 'agent' ? `agent#${r.actor_id}` : r.actor_id),
      action: r.action, detail: r.detail ? (() => { try { return JSON.parse(r.detail); } catch { return r.detail; } })() : null,
    })),
    prs, agents,
  });
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
      `SELECT id, name, path, icon, status, entry, display FROM t_applets ORDER BY id`
    ).all() as any).results as any[];
  } else {
    rows = (await c.env.DB.prepare(
      `SELECT a.id, a.name, a.path, a.icon, a.status, a.entry, a.display
       FROM t_applets a JOIN t_applet_acls acl ON acl.applet_id = a.id AND acl.user_id = ? AND acl.allowed = 1
       WHERE a.status = 'enabled' ORDER BY a.id`
    ).bind(auth.userId).all() as any).results as any[];
  }
  return c.json({ applets: rows });
});

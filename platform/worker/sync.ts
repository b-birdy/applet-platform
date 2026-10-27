// 同步器：main 的 applets/ 树 ↔ t_applets 注册表；PR 分支 → R2 preview
import type { GitHubClient } from './github';
import { checkApplet } from './checker';
import { registerAppletTables, normalizeVersion, type ManifestTable } from './data';

export type SyncEnv = {
  DB: D1Database;
  ASSETS: R2Bucket;
  GITHUB: GitHubClient; // 由 index.ts 按 env 组装（token 来自 Secret）
};

const TEXT_EXT = /\.(html?|js|mjs|css|json|svg|txt|md)$/i;

function slugOf(path: string): string | null {
  const m = path.match(/^applets\/([^/]+)\//);
  return m ? m[1] : null;
}

async function listRepoSlugs(env: SyncEnv): Promise<Set<string>> {
  const tree = await env.GITHUB.getTree('main');
  const slugs = new Set<string>();
  for (const e of tree) {
    const s = slugOf(e.path);
    if (s) slugs.add(s);
  }
  return slugs;
}

async function pullFiles(env: SyncEnv, ref: string, slug: string, destPrefix: string): Promise<number> {
  const tree = await env.GITHUB.getTree(ref);
  const files = tree.filter((e) => e.path.startsWith(`applets/${slug}/`));
  let count = 0;
  for (const f of files) {
    const rel = f.path.slice(`applets/${slug}/`.length);
    if (!rel) continue;
    const content = await env.GITHUB.getContent(ref, f.path);
    if (content === null) continue;
    // 复制为显式 ArrayBuffer（workers-types 的 put 接受 ArrayBufferView<ArrayBuffer>）
    const buf = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
    await env.ASSETS.put(`${destPrefix}/${slug}/${rel}`, buf);
    count++;
  }
  return count;
}

/** 单应用刷新：拉 main 上该 applet 的文件到 prod + 注册/演进数据表 + 跑 checker 存报告 */
export async function refreshApplet(env: SyncEnv, slug: string): Promise<void> {
  await pullFiles(env, 'main', slug, 'prod');
  // 数据表注册/演进（幂等）；破坏性变更只记报告不崩同步
  const raw = await env.GITHUB.getContent('main', `applets/${slug}/applet.json`);
  if (raw) {
    try {
      const manifest = JSON.parse(new TextDecoder().decode(raw));
      if (Array.isArray(manifest.tables)) {
        await registerAppletTables(env.DB, slug, manifest.tables as ManifestTable[]);
      }
      const ver = normalizeVersion(manifest.version);
      // 仅回填空值：管理员手改的版本不被同步覆盖；agent 提交时由 mcp 侧更新
      if (ver) await env.DB.prepare(`UPDATE t_applets SET version = ? WHERE path = ? AND version IS NULL`).bind(ver, slug).run();
    } catch (e) {
      if (e instanceof Error && e.name === 'SchemaChangeError') {
        await env.DB.prepare(`INSERT INTO t_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
          .bind(`check_report.${slug}`, JSON.stringify([{ level: 'error', rule: 'manifest.evolution', file: 'applet.json', message: e.message }]))
          .run();
      } else {
        console.error(`refreshApplet ${slug}: manifest register failed:`, e);
      }
    }
  }
  const tree = await env.GITHUB.getTree('main');
  const files = new Map<string, string>();
  for (const f of tree) {
    if (!f.path.startsWith(`applets/${slug}/`)) continue;
    if (!TEXT_EXT.test(f.path)) continue;
    const raw = await env.GITHUB.getContent('main', f.path);
    if (raw !== null) files.set(f.path.slice(`applets/${slug}/`.length), new TextDecoder().decode(raw));
  }
  const issues = checkApplet(slug, files);
  await env.DB.prepare(`INSERT INTO t_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .bind(`check_report.${slug}`, JSON.stringify(issues))
    .run();
}

export async function syncOnce(env: SyncEnv): Promise<{ added: string[]; missing: string[] }> {
  const repoSlugs = await listRepoSlugs(env);
  const registered = (await env.DB.prepare(`SELECT id, path, status FROM t_applets`).all<{ id: number; path: string; status: string }>()).results;

  const added: string[] = [];
  const missing: string[] = [];

  // 新目录 → 注册 testing + 拉文件 + 跑 checker 存报告
  for (const slug of repoSlugs) {
    if (registered.some((r) => r.path === slug)) continue;
    const manifestRaw = await env.GITHUB.getContent('main', `applets/${slug}/applet.json`);
    let name = slug;
    let entry: string | null = null;
    let display = 'embed';
    let version: string | null = null;
    if (manifestRaw) {
      try {
        const m = JSON.parse(new TextDecoder().decode(manifestRaw));
        name = m.name ?? slug;
        entry = m.entry ?? null;
        if (m.display === 'new_tab') display = 'new_tab';
        version = normalizeVersion(m.version);
      } catch { /* 清单坏也先注册，报告会指出 */ }
    }
    await env.DB.prepare(`INSERT INTO t_applets (name, path, status, entry, display, version) VALUES (?, ?, 'testing', ?, ?, ?)`).bind(name, slug, entry, display, version).run();
    await refreshApplet(env, slug);
    added.push(slug);
  }

  // 消失目录 → missing=1（不自动删）；重新出现 → 清标记
  for (const r of registered) {
    const inRepo = repoSlugs.has(r.path);
    if (!inRepo && r.status !== 'disabled') {
      // 注意：消失即标记，与状态无关；disabled 仅表示用户侧不可见
    }
    if (!inRepo) {
      await env.DB.prepare(`UPDATE t_applets SET missing = 1 WHERE path = ?`).bind(r.path).run();
      missing.push(r.path);
    } else {
      await env.DB.prepare(`UPDATE t_applets SET missing = 0 WHERE path = ? AND missing = 1`).bind(r.path).run();
    }
  }

  return { added, missing };
}

export async function syncPreview(env: SyncEnv, slug: string, branch: string): Promise<void> {
  await pullFiles(env, branch, slug, 'preview');
}

// PR 合并路由：平台内一键合并（D12）
import { Hono } from 'hono';
import { requireRole, type AuthInfo } from '../../auth';
import { logAudit } from '../../audit';
import { getGithubClient } from '../../github-bind';
import { syncOnce, refreshApplet } from '../../sync';

export const prRoutes = new Hono<{ Bindings: { DB: D1Database; ASSETS: R2Bucket; GITHUB: any }; Variables: { auth: AuthInfo } }>();

prRoutes.use('/api/admin/applets/:id/merge-pr', requireRole('admin'));

prRoutes.post('/api/admin/applets/:id/merge-pr', async (c) => {
  const slug = c.req.param('id');
  const applet = await c.env.DB.prepare(`SELECT id, path FROM t_applets WHERE path = ?`).bind(slug).first<{ id: number; path: string }>();
  if (!applet) return c.json({ error: 'NOT_FOUND' }, 404);

  const pr = await c.env.DB.prepare(`SELECT pr_number, branch, state FROM t_prs WHERE applet_id = ? AND state = 'open'`).bind(applet.id).first<{ pr_number: number; branch: string; state: string }>();
  if (!pr) return c.json({ error: 'NO_OPEN_PR' }, 409);

  const gh = getGithubClient(c.env.GITHUB);
  // 平台 commit author 固定 platform[bot]；合并本身走 GitHub 身份（token 属平台）
  await gh.mergePR(pr.pr_number, (await gh.getHeadSha(pr.branch)) ?? (await gh.getHeadSha('main'))!);

  await c.env.DB.prepare(`UPDATE t_prs SET state = 'merged' WHERE applet_id = ? AND pr_number = ?`).bind(applet.id, pr.pr_number).run();

  // 合并后同步：注册表对账 + 该应用内容刷新到 prod
  const syncEnv = { DB: c.env.DB, ASSETS: c.env.ASSETS, GITHUB: gh };
  await syncOnce(syncEnv);
  await refreshApplet(syncEnv, slug);

  const auth = c.get('auth');
  await logAudit(c.env.DB, { actor_type: 'user', actor_id: String(auth.userId), action: 'applet.merge_pr', target: slug, detail: { pr: pr.pr_number } });
  return c.json({ ok: true, pr: pr.pr_number });
});

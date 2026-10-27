// 推进中任务：管理员视角的工作流跟踪（推导式——不存进度快照，步骤由活数据实时推导）
// 两种任务（kind:path 唯一）：
//   create — 新建/接入小程序：完成 = applet 已注册且无 open PR（首次合并即关单）
//   modify — 已有小程序的 agent 修改：open PR = 推进中；无 open PR 且末次合并晚于末次
//            复制提示词 = 已完成；管理员也可手动作废（task.cancel 审计）
// 事件源：t_audit_logs 里 action=applet.prompt_copied（detail.kind = create|modify）
import { Hono } from 'hono';
import { logAudit } from '../../audit';
import { requireRole, type AuthInfo } from '../../auth';

type TaskEnv = { Bindings: { DB: D1Database }; Variables: { auth: AuthInfo } };

export const adminTaskRoutes = new Hono<TaskEnv>();

adminTaskRoutes.use('/api/admin/tasks*', requireRole('admin'));

export type TaskRow = {
  key: string;          // kind:path
  kind: 'create' | 'modify';
  path: string;
  name: string;         // 显示名（create 未注册时为 path 本身）
  step: 'waiting_submit' | 'pr_open' | 'done';
  step_label: string;
  pr_number: number | null;
  started_at: string | null;   // 末次复制提示词时间
  aged: boolean;               // 挂起超过 7 天
};

// 前端在复制提示词时上报（wizard 开发/接入 → create；小程序管理「新 Agent 接管」→ modify）
adminTaskRoutes.post('/api/admin/tasks/track', async (c) => {
  const body = await c.req.json<{ kind?: string; path?: string }>().catch(() => null);
  const kind = body?.kind === 'create' ? 'create' : 'modify';
  const path = String(body?.path ?? '').trim();
  if (!path || !/^[a-z][a-z0-9-]*$/.test(path)) return c.json({ error: 'BAD_REQUEST' }, 400);
  const auth = c.get('auth');
  await logAudit(c.env.DB, { actor_type: 'user', actor_id: String(auth.userId), action: 'applet.prompt_copied', target: path, detail: { kind } });
  return c.json({ ok: true });
});

adminTaskRoutes.get('/api/admin/tasks', async (c) => {
  const db = c.env.DB;

  // 最近 14 天的复制提示词事件（同 key 取最近一条）
  const events = (await db.prepare(
    `SELECT al.target, al.detail, al.at FROM t_audit_logs al
     WHERE al.action = 'applet.prompt_copied' AND al.at >= datetime('now', '-14 days')
     ORDER BY al.id DESC`
  ).all<{ target: string; detail: string | null; at: string }>()).results;

  // 手动作废集合（不设时限——作废即永久移除，除非再次复制提示词重新开单）
  const cancelled = new Set((await db.prepare(
    `SELECT target FROM t_audit_logs WHERE action = 'task.cancel' AND target IS NOT NULL`
  ).all<{ target: string }>()).results.map((r) => r.target));

  const applets = (await db.prepare(`SELECT id, path, name FROM t_applets`).all<{ id: number; path: string; name: string }>()).results;
  const byPath = new Map(applets.map((a) => [a.path, a]));
  const openPrs = (await db.prepare(`SELECT applet_id, pr_number FROM t_prs WHERE state = 'open'`).all<{ applet_id: number; pr_number: number }>()).results;
  const openByApplet = new Map(openPrs.map((p) => [p.applet_id, p.pr_number]));
  // 末次合并时间（modify 完成判定用）
  const lastMerge = new Map<string, string>();
  for (const m of (await db.prepare(
    `SELECT target, at FROM t_audit_logs WHERE action = 'applet.merge_pr' AND target IS NOT NULL ORDER BY id DESC`
  ).all<{ target: string; at: string }>()).results) {
    if (!lastMerge.has(m.target)) lastMerge.set(m.target, m.at);
  }

  const tasks = new Map<string, TaskRow>();
  const now = Date.now();
  const parseKind = (d: string | null): 'create' | 'modify' => {
    try { return JSON.parse(d ?? '{}').kind === 'create' ? 'create' : 'modify'; } catch { return 'modify'; }
  };

  for (const ev of events) {
    if (!ev.target) continue;
    const kind = parseKind(ev.detail);
    const key = `${kind}:${ev.target}`;
    if (tasks.has(key) || cancelled.has(key)) continue;
    const applet = byPath.get(ev.target);
    const openPr = applet ? openByApplet.get(applet.id) : undefined;
    let step: TaskRow['step'] = 'waiting_submit';
    let step_label = '等待 agent 提交';
    if (openPr) {
      step = 'pr_open';
      step_label = `PR #${openPr} 待合并`;
    } else if (kind === 'create' && applet) {
      step = 'done';
      step_label = '已完成（PR 已合并）';
    } else if (kind === 'modify' && applet) {
      const mergedAt = lastMerge.get(ev.target);
      if (mergedAt && mergedAt > ev.at) {
        step = 'done';
        step_label = '已完成（PR 已合并）';
      }
    }
    tasks.set(key, {
      key, kind, path: ev.target,
      name: applet?.name ?? ev.target,
      step, step_label,
      pr_number: openPr ?? null,
      started_at: ev.at,
      aged: now - new Date(ev.at.replace(' ', 'T') + 'Z').getTime() > 7 * 86400_000,
    });
  }

  // 有 open PR 但没有复制提示词事件的 applet（直接让 agent 提交的场景）→ 仍显示
  for (const p of openPrs) {
    const applet = applets.find((a) => a.id === p.applet_id);
    if (!applet) continue;
    const key = `modify:${applet.path}`;
    if (!tasks.has(key) && !cancelled.has(key)) {
      tasks.set(key, {
        key, kind: 'modify', path: applet.path, name: applet.name,
        step: 'pr_open', step_label: `PR #${p.pr_number} 待合并`,
        pr_number: p.pr_number, started_at: null, aged: false,
      });
    }
  }

  // 已完成的只保留 3 天内的（完成后短暂可见，之后自然消失）
  const list = [...tasks.values()].filter((t) => t.step !== 'done' || withinDays(t.started_at, 3));
  list.sort((a, b) => (a.step === 'pr_open' ? 0 : 1) - (b.step === 'pr_open' ? 0 : 1) || (b.started_at ?? '').localeCompare(a.started_at ?? ''));
  return c.json({ tasks: list, active: list.filter((t) => t.step !== 'done').length });
});

function withinDays(at: string | null, days: number): boolean {
  if (!at) return true;
  return Date.now() - new Date(at.replace(' ', 'T') + 'Z').getTime() < days * 86400_000;
}

// 手动作废：管理员判断任务已死（agent 放弃等）→ 从列表移除
adminTaskRoutes.post('/api/admin/tasks/:kind/:path/cancel', async (c) => {
  const kind = c.req.param('kind') === 'create' ? 'create' : 'modify';
  const path = c.req.param('path');
  const auth = c.get('auth');
  await logAudit(c.env.DB, { actor_type: 'user', actor_id: String(auth.userId), action: 'task.cancel', target: `${kind}:${path}` });
  return c.json({ ok: true });
});

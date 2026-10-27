import { env, SELF } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';

let adminCookie: string;

beforeAll(async () => {
  const { results } = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='t_users'`).all();
  if (results.length === 0) {
    const { applySchema } = await import('./db/apply');
    await applySchema(env.DB);
  }
  const name = `taskadmin-${Date.now()}`;
  const { hashPassword } = await import('./auth');
  const hash = await hashPassword('pw-123456');
  await env.DB.prepare(`INSERT INTO t_users (username, password_hash, role) VALUES (?, ?, 'superadmin')`)
    .bind(name, hash).run();
  const r = await SELF.fetch('https://x/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: name, password: 'pw-123456' }),
  });
  adminCookie = r.headers.get('set-cookie')!.split(';')[0];
});

async function track(kind: 'create' | 'modify', path: string) {
  return SELF.fetch('https://x/api/admin/tasks/track', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ kind, path }),
  });
}

async function listTasks(): Promise<{ tasks: any[]; active: number }> {
  const r = await SELF.fetch('https://x/api/admin/tasks', { headers: { cookie: adminCookie } });
  expect(r.status).toBe(200);
  return r.json() as any;
}

describe('推进中任务', () => {
  const unique = Date.now();
  const slug = `taskapp-${unique}`;

  it('track requires admin', async () => {
    const r = await SELF.fetch('https://x/api/admin/tasks/track', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'create', path: 'x-app' }),
    });
    expect(r.status).toBe(401);
  });

  it('copying a create prompt opens a waiting_submit task', async () => {
    expect((await track('create', slug)).status).toBe(200);
    const { tasks, active } = await listTasks();
    const t = tasks.find((x) => x.key === `create:${slug}`);
    expect(t).toBeTruthy();
    expect(t.step).toBe('waiting_submit');
    expect(t.kind).toBe('create');
    expect(active).toBeGreaterThanOrEqual(1);
  });

  it('agent submit (registered applet + open PR) moves it to pr_open', async () => {
    const applet = (await env.DB.prepare(`INSERT INTO t_applets (name, path, status) VALUES (?, ?, 'testing') RETURNING id`)
      .bind(slug, slug).first<{ id: number }>())!;
    await env.DB.prepare(`INSERT INTO t_prs (applet_id, pr_number, branch, state) VALUES (?, 9001, 'applet/x', 'open')`).bind(applet.id).run();
    const { tasks } = await listTasks();
    const t = tasks.find((x) => x.key === `create:${slug}`);
    expect(t.step).toBe('pr_open');
    expect(t.pr_number).toBe(9001);
    expect(t.step_label).toContain('9001');
  });

  it('merging the PR (no open PR left) closes the create task as done', async () => {
    await env.DB.prepare(`UPDATE t_prs SET state = 'merged' WHERE pr_number = 9001`).run();
    const { tasks } = await listTasks();
    const t = tasks.find((x) => x.key === `create:${slug}`);
    expect(t.step).toBe('done');
  });

  it('cancel removes the task from the list', async () => {
    await track('modify', slug);
    const r = await SELF.fetch(`https://x/api/admin/tasks/modify/${slug}/cancel`, {
      method: 'POST', headers: { cookie: adminCookie },
    });
    expect(r.status).toBe(200);
    const { tasks } = await listTasks();
    expect(tasks.find((x) => x.key === `modify:${slug}`)).toBeUndefined();
  });

  it('open PR without a prompt event still shows up (direct agent submit)', async () => {
    const slug2 = `orphan-pr-${unique}`;
    const applet = (await env.DB.prepare(`INSERT INTO t_applets (name, path, status) VALUES (?, ?, 'testing') RETURNING id`)
      .bind(slug2, slug2).first<{ id: number }>())!;
    await env.DB.prepare(`INSERT INTO t_prs (applet_id, pr_number, branch, state) VALUES (?, 9002, 'applet/y', 'open')`).bind(applet.id).run();
    const { tasks } = await listTasks();
    const t = tasks.find((x) => x.key === `modify:${slug2}`);
    expect(t).toBeTruthy();
    expect(t.step).toBe('pr_open');
  });
});

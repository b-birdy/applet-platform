import { env } from 'cloudflare:test';
import { SELF } from 'cloudflare:test';
import { hashPassword } from '../../auth';
import { registerAppletTables } from '../../data';
import { setGithubClient } from '../../github-bind';
import { GitHubClient } from '../../github';
import { vi } from 'vitest';

let adminCookie: string;

async function login(username: string): Promise<string> {
  const r = await SELF.fetch('https://x/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'pw-123456' }),
  });
  return r.headers.get('set-cookie')!.split(';')[0];
}

beforeAll(async () => {
  const { results } = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='t_users'`).all();
  if (results.length === 0) {
    const { applySchema } = await import('../../db/apply');
    await applySchema(env.DB);
  }
  const hash = await hashPassword('pw-123456');
  await env.DB.prepare(`INSERT INTO t_users (username, password_hash, role) VALUES ('boss10', ?, 'admin')`).bind(hash).run();
  adminCookie = await login('boss10');
});

// 可复用的 github stub：merge 相关 spy + 同步树
function makeGithubStub(opts: { tree: { path: string; size?: number }[]; contents?: Map<string, string> }) {
  const mergePR = vi.fn(async (_num: number, _sha: string) => {});
  const deleteDir = vi.fn(async (_branch: string, _dir: string, _msg: string, _author: any) => 'delsha');
  const gh = {
    async getTree(_ref: string) {
      return opts.tree;
    },
    async getContent(_ref: string, path: string): Promise<Uint8Array | null> {
      const c = opts.contents?.get(path);
      return c === undefined ? null : new TextEncoder().encode(c);
    },
    async getPR(num: number) {
      return { state: 'open' as const, head: 'applet/mergeapp', mergeable: true };
    },
    async getHeadSha(_branch: string) {
      return 'headsha1';
    },
    mergePR,
    deleteDir,
  } as unknown as GitHubClient;
  return { gh, mergePR, deleteDir };
}

beforeEach(async () => {
  setGithubClient(null);
  await env.DB.exec(`DELETE FROM t_audit_logs WHERE action LIKE 'applet.%'`);
});

describe('POST /api/admin/applets/:id/merge-pr', () => {
  it('merges open PR, marks merged, triggers syncOnce', async () => {
    await env.DB.prepare(`INSERT INTO t_applets (id, name, path, status, entry) VALUES (11, '合并测', 'mergeapp', 'testing', 'index.html')`).run();
    await env.DB.prepare(`INSERT INTO t_prs (applet_id, pr_number, branch, state) VALUES (11, 7, 'applet/mergeapp', 'open')`).run();
    await env.ASSETS.put('prod/mergeapp/stale.html', '<html>stale</html>');

    const { gh, mergePR } = makeGithubStub({
      tree: [{ path: 'applets/mergeapp/applet.json', size: 10 }, { path: 'applets/mergeapp/index.html', size: 40 }],
      contents: new Map([
        ['applets/mergeapp/applet.json', JSON.stringify({ id: 'mergeapp', name: '合并测', entry: 'index.html', version: '1.0.0', tables: [] })],
        ['applets/mergeapp/index.html', '<html>fresh</html>'],
      ]),
    });
    setGithubClient(gh);

    const r = await SELF.fetch('https://x/api/admin/applets/mergeapp/merge-pr', {
      method: 'POST', headers: { cookie: adminCookie },
    });
    expect(r.status).toBe(200);

    expect(mergePR).toHaveBeenCalledWith(7, 'headsha1');
    const pr = await env.DB.prepare(`SELECT state FROM t_prs WHERE applet_id=11`).first<any>();
    expect(pr.state).toBe('merged');

    // syncOnce 跑过：stale.html 被重新同步（prod 键仍存在，fresh 内容覆盖 index）
    const idx = await env.ASSETS.get('prod/mergeapp/index.html');
    expect(await idx!.text()).toContain('fresh');

    const audit = await env.DB.prepare(`SELECT action FROM t_audit_logs WHERE action='applet.merge_pr'`).all();
    expect(audit.results.length).toBe(1);
  });

  it('returns 409 when no open PR', async () => {
    await env.DB.prepare(`INSERT INTO t_applets (id, name, path, status, entry) VALUES (12, '无PR', 'nopr', 'testing', 'index.html')`).run();
    const { gh } = makeGithubStub({ tree: [] });
    setGithubClient(gh);

    const r = await SELF.fetch('https://x/api/admin/applets/nopr/merge-pr', {
      method: 'POST', headers: { cookie: adminCookie },
    });
    expect(r.status).toBe(409);
  });
});

describe('hard delete via real remover', () => {
  it('deleteDir called, R2 keys cleared, D1 cleaned, audited', async () => {
    await env.DB.prepare(`INSERT INTO t_applets (id, name, path, status, entry) VALUES (13, '删除测', 'delapp', 'enabled', 'index.html')`).run();
    await registerAppletTables(env.DB, 'delapp', [{ name: 't1', columns: [{ name: 'note', type: 'text' }] }]);
    await env.DB.prepare(`INSERT INTO t_applet_acls (applet_id, user_id, allowed) VALUES (13, 1, 1)`).run();
    await env.DB.prepare(`INSERT INTO t_prs (applet_id, pr_number, branch, state) VALUES (13, 9, 'applet/delapp', 'merged')`).run();
    await env.ASSETS.put('prod/delapp/index.html', '<html>prod</html>');
    await env.ASSETS.put('preview/delapp/index.html', '<html>preview</html>');
    // 不该被删的键
    await env.ASSETS.put('prod/other/index.html', '<html>other</html>');

    const { gh, deleteDir } = makeGithubStub({ tree: [] });
    setGithubClient(gh);

    const r = await SELF.fetch('https://x/api/admin/applets/delapp', {
      method: 'DELETE', headers: { cookie: adminCookie },
    });
    expect(r.status).toBe(200);

    expect(deleteDir).toHaveBeenCalled();
    const call = deleteDir.mock.calls[0] as any[];
    expect(call[0]).toBe('main');
    expect(call[1]).toBe('applets/delapp/'); // brief: deleteDir 目录参数带尾斜杠

    expect(await env.ASSETS.get('prod/delapp/index.html')).toBeNull();
    expect(await env.ASSETS.get('preview/delapp/index.html')).toBeNull();
    expect(await env.ASSETS.get('prod/other/index.html')).not.toBeNull();

    const row = await env.DB.prepare(`SELECT id FROM t_applets WHERE path='delapp'`).first();
    expect(row).toBeNull();
    const t = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE name='a_delapp_t1'`).all();
    expect(t.results).toHaveLength(0);
    const acl = await env.DB.prepare(`SELECT * FROM t_applet_acls WHERE applet_id=13`).all();
    expect(acl.results).toHaveLength(0);
    const audit = await env.DB.prepare(`SELECT action FROM t_audit_logs WHERE action='applet.delete'`).all();
    expect(audit.results.length).toBe(1);
  });
});

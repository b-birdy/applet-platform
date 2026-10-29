import { env } from 'cloudflare:test';
import { SELF } from 'cloudflare:test';
import { hashPassword } from '../../auth';
import { registerAppletTables } from '../../data';
import { setGithubClient } from '../../github-bind';
import { GitHubClient } from '../../github';
import { vi } from 'vitest';

let adminCookie: string;
const SLUG = `verapp-${Date.now()}`;
const OLD_MANIFEST = JSON.stringify({
  id: SLUG, name: '版本测试', entry: 'index.html', version: 'v1.0',
  tables: [{ name: 'items', columns: [{ name: 'title', type: 'text' }] }],
});
const NEW_MANIFEST = JSON.stringify({
  id: SLUG, name: '版本测试', entry: 'index.html', version: 'v2.0',
  tables: [{ name: 'items', columns: [{ name: 'title', type: 'text' }, { name: 'note', type: 'text' }] }],
});
const BROKEN_MANIFEST = JSON.stringify({
  id: SLUG, name: '版本测试', entry: 'index.html', version: 'v0.9',
  // 类型改变 text → integer（数据无法承载，应拒绝）
  tables: [{ name: 'items', columns: [{ name: 'title', type: 'integer' }] }],
});
const HTML = '<html><script src="/app-runtime.js"></script></html>';

async function login(username: string): Promise<string> {
  const r = await SELF.fetch('https://x/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'pw-123456' }),
  });
  return r.headers.get('set-cookie')!.split(';')[0];
}

function makeStub(entries: { path: string; size?: number }[], contents: Map<string, string>) {
  return {
    async getTree(_ref: string) { return entries; },
    async getContent(_ref: string, path: string): Promise<Uint8Array | null> {
      const c = contents.get(path);
      return c === undefined ? null : new TextEncoder().encode(c);
    },
    async getHeadSha(_b: string) { return 'basesha'; },
    async deleteDir(_b: string, _d: string, _m: string, _a: any) { return 'delsha'; },
    async putFiles(_b: string, _f: Map<string, any>, _m: string, _a: any, _base?: string) { return 'putsha'; },
  } as unknown as GitHubClient;
}

beforeAll(async () => {
  const { results } = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='t_users'`).all();
  if (results.length === 0) {
    const { applySchema } = await import('../../db/apply');
    await applySchema(env.DB);
  }
  const hash = await hashPassword('pw-123456');
  await env.DB.prepare(`INSERT INTO t_users (username, password_hash, role) VALUES ('verboss', ?, 'admin')`).bind(hash).run();
  adminCookie = await login('verboss');
  await env.DB.prepare(`INSERT INTO t_applets (name, path, status, entry) VALUES ('版本测试', ?, 'testing', 'index.html')`).bind(SLUG).run();
  // 当前（最新 v2）快照：items 有 title + note
  await registerAppletTables(env.DB, SLUG, [{ name: 'items', columns: [{ name: 'title', type: 'text' }, { name: 'note', type: 'text' }] }]);
});

beforeEach(() => setGithubClient(null));

describe('版本切换', () => {
  it('lists versions from git history', async () => {
    setGithubClient(makeStub([], new Map()) as any);
    const ghStub = makeStub([], new Map());
    (ghStub as any).listCommits = vi.fn(async () => [
      { sha: 'aaaaaaaa11111111', message: 'submit applet v2', date: '2026-10-29T10:00:00Z', author: 'agent' },
      { sha: 'bbbbbbbb22222222', message: 'submit applet v1', date: '2026-10-28T10:00:00Z', author: 'agent' },
    ]);
    setGithubClient(ghStub);
    const r = await SELF.fetch(`https://x/api/admin/applets/${SLUG}/versions`, { headers: { cookie: adminCookie } });
    expect(r.status).toBe(200);
    const json: any = await r.json();
    expect(json.versions).toHaveLength(2);
    expect(json.versions[0].message).toContain('v2');
  });

  it('switches to an older compatible version (add-column direction ok)', async () => {
    // 旧版本清单没有 note 列——兼容（只少列，不加不删不改动），应放行
    const tree = [
      { path: `applets/${SLUG}/applet.json`, size: 10 },
      { path: `applets/${SLUG}/index.html`, size: 10 },
    ];
    const contents = new Map<string, string>([
      [`applets/${SLUG}/applet.json`, OLD_MANIFEST],
      [`applets/${SLUG}/index.html`, HTML],
    ]);
    setGithubClient(makeStub(tree, contents));
    const r = await SELF.fetch(`https://x/api/admin/applets/${SLUG}/switch-version`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ sha: 'bbbbbbbb22222222' }),
    });
    expect(r.status).toBe(200);
    const row = await env.DB.prepare(`SELECT version FROM t_applets WHERE path = ?`).bind(SLUG).first<any>();
    expect(row.version).toBe('v1.0');
    const audit = await env.DB.prepare(`SELECT action FROM t_audit_logs WHERE action = 'applet.version_switch' AND target = ?`).bind(SLUG).all();
    expect(audit.results).toHaveLength(1);
  });

  it('rejects switch when the old schema cannot carry current data (type change)', async () => {
    const tree = [{ path: `applets/${SLUG}/applet.json`, size: 10 }];
    const contents = new Map<string, string>([[`applets/${SLUG}/applet.json`, BROKEN_MANIFEST]]);
    setGithubClient(makeStub(tree, contents));
    const r = await SELF.fetch(`https://x/api/admin/applets/${SLUG}/switch-version`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ sha: 'cccccccc33333333' }),
    });
    expect(r.status).toBe(409);
    const json: any = await r.json();
    expect(json.error).toBe('DATA_INCOMPATIBLE');
    expect(json.message).toContain('无法承载');
  });

  it('data survives the switch (rows intact)', async () => {
    await env.DB.prepare(`INSERT INTO a_${SLUG.replace(/-/g, '_')}_items (user_id, title) VALUES (999, 'keepme')`).run();
    const tree = [
      { path: `applets/${SLUG}/applet.json`, size: 10 },
      { path: `applets/${SLUG}/index.html`, size: 10 },
    ];
    const contents = new Map<string, string>([
      [`applets/${SLUG}/applet.json`, OLD_MANIFEST],
      [`applets/${SLUG}/index.html`, HTML],
    ]);
    setGithubClient(makeStub(tree, contents));
    const r = await SELF.fetch(`https://x/api/admin/applets/${SLUG}/switch-version`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ sha: 'dddddddd44444444' }),
    });
    expect(r.status).toBe(200);
    const cnt = await env.DB.prepare(`SELECT COUNT(*) AS n FROM a_${SLUG.replace(/-/g, '_')}_items`).first<{ n: number }>();
    expect(cnt!.n).toBe(1);
  });
});

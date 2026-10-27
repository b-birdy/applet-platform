import { env } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';
import { syncOnce, syncPreview } from './sync';
import { GitHubClient } from './github';

// 内存 GitHubClient stub：getTree/getContent 按注册的仓库状态回答
function makeStubGH(tree: { path: string; size?: number }[], contents: Map<string, string>) {
  const gh = {
    async getTree(_ref: string) {
      return tree;
    },
    async getContent(_ref: string, path: string): Promise<Uint8Array | null> {
      const c = contents.get(path);
      return c === undefined ? null : new TextEncoder().encode(c);
    },
  } as unknown as GitHubClient;
  return gh;
}

const MANIFEST = JSON.stringify({
  id: 'syncapp',
  name: '同步测试',
  icon: '📦',
  entry: 'index.html',
  version: '1.0.0',
  tables: [{ name: 'items', columns: [{ name: 'title', type: 'text' }] }],
});

beforeAll(async () => {
  const { results } = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='t_users'`).all();
  if (results.length === 0) {
    const { applySchema } = await import('./db/apply');
    await applySchema(env.DB);
  }
});

describe('syncOnce', () => {
  it('registers a new applet as testing, syncs files to R2, stores check report', async () => {
    const contents = new Map<string, string>([
      ['applets/syncapp/applet.json', MANIFEST],
      ['applets/syncapp/index.html', '<html><script src="/app-runtime.js"></script></html>'],
    ]);
    const gh = makeStubGH(
      [
        { path: 'applets/syncapp/applet.json', size: MANIFEST.length },
        { path: 'applets/syncapp/index.html', size: 60 },
      ],
      contents
    );
    const result = await syncOnce({ DB: env.DB, ASSETS: env.ASSETS, GITHUB: gh } as any);
    expect(result.added).toContain('syncapp');

    const row = await env.DB.prepare(`SELECT status, missing FROM t_applets WHERE path='syncapp'`).first<any>();
    expect(row.status).toBe('testing');
    expect(row.missing).toBe(0);

    const obj = await env.ASSETS.get('prod/syncapp/applet.json');
    expect(await obj!.text()).toBe(MANIFEST);

    const report = await env.DB.prepare(`SELECT value FROM t_settings WHERE key='check_report.syncapp'`).first<any>();
    expect(report).not.toBeNull();
    expect(JSON.parse(report.value)).toEqual([]);
  });

  it('creates physical tables + manifest snapshot on first sync (Critical #1)', async () => {
    // 用一个全新的 applet 走生产同步路径
    const m2 = MANIFEST.replace('syncapp', 'tableapp');
    const contents = new Map<string, string>([
      ['applets/tableapp/applet.json', m2],
      ['applets/tableapp/index.html', '<html><script src="/app-runtime.js"></script></html>'],
    ]);
    const gh = makeStubGH(
      [{ path: 'applets/tableapp/applet.json', size: m2.length }, { path: 'applets/tableapp/index.html', size: 60 }],
      contents
    );
    await syncOnce({ DB: env.DB, ASSETS: env.ASSETS, GITHUB: gh } as any);
    // 物理表存在（syncapp 的表在更早用例的 manifest 声明了 items）
    const phys = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE name='a_tableapp_items'`).all();
    expect(phys.results).toHaveLength(1);
    const snap = await env.DB.prepare(`SELECT value FROM t_settings WHERE key='manifest.tableapp'`).first<any>();
    expect(snap).not.toBeNull();
    expect(JSON.parse(snap.value).items).toBeDefined();
  });

  it('is idempotent — second run adds nothing', async () => {
    const gh = makeStubGH(
      [{ path: 'applets/syncapp/applet.json', size: 10 }, { path: 'applets/syncapp/index.html', size: 60 }],
      new Map([['applets/syncapp/applet.json', MANIFEST], ['applets/syncapp/index.html', '<html></html>']])
    );
    const result = await syncOnce({ DB: env.DB, ASSETS: env.ASSETS, GITHUB: gh } as any);
    expect(result.added).toEqual([]);
  });

  it('marks applets missing from repo with missing=1 (no auto-delete)', async () => {
    // 空树 → syncapp 应标记 missing
    const gh = makeStubGH([], new Map());
    const result = await syncOnce({ DB: env.DB, ASSETS: env.ASSETS, GITHUB: gh } as any);
    expect(result.missing).toContain('syncapp');
    const row = await env.DB.prepare(`SELECT missing FROM t_applets WHERE path='syncapp'`).first<any>();
    expect(row.missing).toBe(1);
    // 数据仍在
    const still = await env.DB.prepare(`SELECT COUNT(*) AS n FROM t_applets WHERE path='syncapp'`).first<any>();
    expect(still.n).toBe(1);
  });

  it('self-heals R2 holes: registered applet with missing entry gets re-pulled', async () => {
    // 模拟历史断层：syncapp 已注册、missing=0，但 R2 内容被删（如合并后同步失败）
    await env.DB.prepare(`UPDATE t_applets SET missing = 0, entry = 'index.html' WHERE path = 'syncapp'`).run();
    const dels = (await env.ASSETS.list({ prefix: 'prod/syncapp/' })).objects.map((o) => o.key);
    for (const k of dels) await env.ASSETS.delete(k);
    expect(await env.ASSETS.get('prod/syncapp/applet.json')).toBeNull();

    const contents = new Map<string, string>([
      ['applets/syncapp/applet.json', MANIFEST],
      ['applets/syncapp/index.html', '<html><script src="/app-runtime.js"></script></html>'],
    ]);
    const gh = makeStubGH(
      [{ path: 'applets/syncapp/applet.json', size: MANIFEST.length }, { path: 'applets/syncapp/index.html', size: 60 }],
      contents
    );
    await syncOnce({ DB: env.DB, ASSETS: env.ASSETS, GITHUB: gh } as any);
    // 入口文件已被补拉回来
    const obj = await env.ASSETS.get('prod/syncapp/applet.json');
    expect(obj).not.toBeNull();
    expect(await obj!.text()).toBe(MANIFEST);
  });
});

describe('syncPreview', () => {
  it('pulls PR branch files into preview/ prefix', async () => {
    const contents = new Map<string, string>([
      ['applets/syncapp/index.html', '<html><body>preview</body></html>'],
    ]);
    const gh = makeStubGH([{ path: 'applets/syncapp/index.html', size: 40 }], contents);
    await syncPreview({ DB: env.DB, ASSETS: env.ASSETS, GITHUB: gh } as any, 'syncapp', 'applet/syncapp');
    const obj = await env.ASSETS.get('preview/syncapp/index.html');
    expect(await obj!.text()).toContain('preview');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { GitHubClient } from './github';

// 内存 fetch mock：按 (method, url) 记录请求并按注册的响应表回答
type Recorded = { method: string; url: string; body?: any; headers: Record<string, string> };

function makeFetch(routes: Array<{ match: (m: string, url: string) => boolean; reply: (req: Recorded) => { status: number; body: any } }>) {
  const recorded: Recorded[] = [];
  const impl = (async (url: any, init?: any) => {
    const method = (init?.method || 'GET').toUpperCase();
    const req: Recorded = { method, url: String(url), body: init?.body ? JSON.parse(init.body) : undefined, headers: (init?.headers as Record<string, string>) || {} };
    recorded.push(req);
    const route = routes.find((r) => r.match(method, req.url));
    if (!route) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    const { status, body } = route.reply(req);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { impl, recorded };
}

const API = 'https://api.github.com/repos/o/r';

describe('GitHubClient', () => {
  it('getHeadSha returns null on 404', async () => {
    const { impl } = makeFetch([]);
    const gh = new GitHubClient('t', 'o', 'r', impl);
    expect(await gh.getHeadSha('nope')).toBeNull();
  });

  it('getHeadSha returns sha on 200', async () => {
    const { impl } = makeFetch([
      { match: (m, u) => m === 'GET' && u === `${API}/git/ref/heads/main`, reply: () => ({ status: 200, body: { object: { sha: 'abc123' } } }) },
    ]);
    const gh = new GitHubClient('t', 'o', 'r', impl);
    expect(await gh.getHeadSha('main')).toBe('abc123');
  });

  it('putFiles runs blob->tree->commit and updates ref, returns sha', async () => {
    const { impl, recorded } = makeFetch([
      { match: (m, u) => m === 'POST' && u === `${API}/git/blobs`, reply: () => ({ status: 201, body: { sha: 'blob1' } }) },
      { match: (m, u) => m === 'GET' && u === `${API}/git/ref/heads/main`, reply: () => ({ status: 200, body: { object: { sha: 'base1' } } }) },
      { match: (m, u) => m === 'GET' && u === `${API}/git/commits/base1`, reply: () => ({ status: 200, body: { tree_sha: 'treebase' } }) },
      { match: (m, u) => m === 'POST' && u === `${API}/git/trees`, reply: () => ({ status: 201, body: { sha: 'tree1' } }) },
      { match: (m, u) => m === 'POST' && u === `${API}/git/commits`, reply: () => ({ status: 201, body: { sha: 'commit1' } }) },
      { match: (m, u) => m === 'PATCH' && u === `${API}/git/refs/heads/applet%2Fdemo`, reply: () => ({ status: 200, body: { object: { sha: 'commit1' } } }) },
    ]);
    const gh = new GitHubClient('t', 'o', 'r', impl);
    const files = new Map<string, string | { contentBase64: string }>();
    files.set('applets/demo/index.html', '<html></html>');
    files.set('applets/demo/logo.png', { contentBase64: 'iVBORw0' });
    const sha = await gh.putFiles('applet/demo', files, 'msg', { name: 'applet-agent[3]', email: 'demo@agents.noreply.applet-platform' });

    expect(sha).toBe('commit1');
    const blobs = recorded.filter((r) => r.url === `${API}/git/blobs`);
    expect(blobs).toHaveLength(2);
    expect(blobs[0].method).toBe('POST');
    expect(blobs[0].headers.authorization).toBe('Bearer t');
    expect(blobs[0].body.encoding).toBe('utf-8'); // 文本文件
    expect(blobs[1].body.encoding).toBe('base64'); // 二进制占位
    expect(blobs[1].body.content).toBe('iVBORw0');
    const tree = recorded.find((r) => r.url === `${API}/git/trees`);
    expect(tree!.body.base_tree).toBe('treebase');
    expect(tree!.body.tree).toHaveLength(2);
    expect(tree!.body.tree[0].path).toBe('applets/demo/index.html');
    const commit = recorded.find((r) => r.url === `${API}/git/commits` && r.method === 'POST');
    expect(commit!.body.parents).toEqual(['base1']); // 父提交是 baseRef(main) 的 head——保证 PR 可建
    expect(commit!.body.author.name).toBe('applet-agent[3]');
    const ref = recorded.find((r) => r.url === `${API}/git/refs/heads/applet%2Fdemo`);
    expect(ref!.method).toBe('PATCH');
    expect(ref!.body.sha).toBe('commit1');
    expect(ref!.body.force).toBe(true);
  });

  it('getPR 404 throws NotFound', async () => {
    const { impl } = makeFetch([]);
    const gh = new GitHubClient('t', 'o', 'r', impl);
    await expect(gh.getPR(9)).rejects.toThrow(/not found/i);
  });

  it('getPR returns mapped state', async () => {
    const { impl } = makeFetch([
      { match: (m, u) => m === 'GET' && u === `${API}/pulls/12`, reply: () => ({ status: 200, body: { state: 'open', merged: false, head: { ref: 'applet/demo' }, mergeable: true } }) },
    ]);
    const gh = new GitHubClient('t', 'o', 'r', impl);
    const pr = await gh.getPR(12);
    expect(pr).toEqual({ state: 'open', head: 'applet/demo', mergeable: true });
  });

  it('mergePR fetches sha then PUTs squash merge', async () => {
    const { impl, recorded } = makeFetch([
      { match: (m, u) => m === 'GET' && u === `${API}/pulls/12`, reply: () => ({ status: 200, body: { state: 'open', merged: false, head: { ref: 'applet/demo' }, mergeable: true } }) },
      { match: (m, u) => m === 'GET' && u === `${API}/pulls/12/commits`, reply: () => ({ status: 200, body: [{ sha: 'head1' }] }) },
      { match: (m, u) => m === 'PUT' && u === `${API}/pulls/12/merge`, reply: () => ({ status: 200, body: { merged: true } }) },
    ]);
    const gh = new GitHubClient('t', 'o', 'r', impl);
    await gh.mergePR(12, 'head1');
    const merge = recorded.find((r) => r.method === 'PUT' && r.url === `${API}/pulls/12/merge`);
    expect(merge).toBeDefined();
    expect(merge!.body.sha).toBe('head1');
    expect(merge!.body.merge_method).toBe('squash');
  });

  it('deleteDir filters tree by prefix and commits deletion', async () => {
    const { impl, recorded } = makeFetch([
      { match: (m, u) => m === 'GET' && u === `${API}/git/ref/heads/applet%2Fdemo`, reply: () => ({ status: 200, body: { object: { sha: 'base1' } } }) },
      { match: (m, u) => m === 'GET' && u === `${API}/git/commits/base1`, reply: () => ({ status: 200, body: { tree_sha: 'treebase' } }) },
      { match: (m, u) => m === 'GET' && u.startsWith(`${API}/git/trees/treebase`), reply: () => ({
          status: 200,
          body: { tree: [
            { path: 'applets/demo/index.html', type: 'blob', sha: 's1' },
            { path: 'applets/other/x.js', type: 'blob', sha: 's2' },
            { path: 'README.md', type: 'blob', sha: 's3' },
          ] },
        }) },
      { match: (m, u) => m === 'POST' && u === `${API}/git/trees`, reply: () => ({ status: 201, body: { sha: 'tree2' } }) },
      { match: (m, u) => m === 'POST' && u === `${API}/git/commits`, reply: () => ({ status: 201, body: { sha: 'commit2' } }) },
      { match: (m, u) => m === 'PATCH' && u === `${API}/git/refs/heads/applet%2Fdemo`, reply: () => ({ status: 200, body: {} }) },
    ]);
    const gh = new GitHubClient('t', 'o', 'r', impl);
    const sha = await gh.deleteDir('applet/demo', 'applets/demo', 'rm demo', { name: 'platform[bot]', email: 'bot@noreply' });
    expect(sha).toBe('commit2');
    const tree = recorded.find((r) => r.url === `${API}/git/trees` && r.method === 'POST');
    // 只删除前缀内的文件
    expect(tree!.body.tree).toEqual([
      { path: 'applets/demo/index.html', sha: null, mode: '100644', type: 'blob' },
    ]);
  });

  it('openPR returns number', async () => {
    const { impl, recorded } = makeFetch([
      { match: (m, u) => m === 'POST' && u === `${API}/pulls`, reply: () => ({ status: 201, body: { number: 12 } }) },
    ]);
    const gh = new GitHubClient('t', 'o', 'r', impl);
    const n = await gh.openPR('title', 'applet/demo', 'main');
    expect(n).toBe(12);
    const pr = recorded.find((r) => r.url === `${API}/pulls`);
    expect(pr!.body.head).toBe('applet/demo');
    expect(pr!.body.base).toBe('main');
  });

  it('getTree filters to applets/ recursively with sizes', async () => {
    const { impl } = makeFetch([
      { match: (m, u) => m === 'GET' && u.includes(`${API}/git/trees/main`), reply: () => ({
          status: 200,
          body: { tree: [
            { path: 'applets/demo/index.html', type: 'blob', size: 100 },
            { path: 'platform/worker/index.ts', type: 'blob', size: 500 },
            { path: 'applets/demo/assets', type: 'tree' },
          ], truncated: false },
        }) },
    ]);
    const gh = new GitHubClient('t', 'o', 'r', impl);
    const tree = await gh.getTree('main');
    expect(tree).toEqual([{ path: 'applets/demo/index.html', size: 100 }]);
  });
});

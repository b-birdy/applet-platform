// GitHub REST 客户端（裸 fetch，可注入 fetchImpl 供测试）
export type CommitAuthor = { name: string; email: string };

/** UTF-8 安全的 base64（btoa 原生只认 Latin-1；unescape 在 Workers 不存在） */
function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
export type PutFile = string | { contentBase64: string };

export class NotFound extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'NotFound';
  }
}

export class GitHubClient {
  private api: string;
  constructor(private token: string, private owner: string, private repo: string, private fetchImpl: typeof fetch = fetch.bind(globalThis)) {
    // fetch.bind: Workers 里解绑的 fetch 会抛 Illegal invocation
    this.api = `https://api.github.com/repos/${owner}/${repo}`;
  }

  private async call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T | null }> {
    const url = path.startsWith('http') ? path : `${this.api}${path}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'applet-platform',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: T | null = null;
    try {
      json = (await res.json()) as T;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }

  private encPath(branch: string): string {
    return encodeURIComponent(branch).replace(/%2F/gi, '%2F'); // 分支名中的 / 保留为 %2F
  }

  async getHeadSha(branch: string): Promise<string | null> {
    const { status, json } = await this.call('GET', `/git/ref/heads/${this.encPath(branch)}`);
    if (status === 404) return null;
    if (status !== 200) throw new Error(`getHeadSha ${branch}: HTTP ${status}`);
    return (json as any).object.sha as string;
  }

  async createBranch(name: string, fromSha: string): Promise<void> {
    const { status, json } = await this.call('POST', '/git/refs', { ref: `refs/heads/${name}`, sha: fromSha });
    if (status !== 201) throw new Error(`createBranch ${name}: HTTP ${status} ${JSON.stringify(json)}`);
  }

  /**
   * blob → tree → commit → 更新引用；返回新 commit sha。
   * 提交永远以 baseRef（默认 main）的 head 为父：保证与 base 有共同祖先（PR 前提），
   * 且 force-push 语义幂等——孤儿分支会被自愈。分支不存在时自动创建。
   */
  async putFiles(branch: string, files: Map<string, PutFile>, message: string, author: CommitAuthor, baseRef = 'main'): Promise<string> {
    // 1. blobs
    const treeItems: { path: string; mode: string; type: string; sha: string }[] = [];
    for (const [path, content] of files) {
      const isB64 = typeof content !== 'string';
      // encoding 必须与 content 的实际形态一致：内容统一为 base64（utf8ToBase64 或自带 base64）
      const { status, json } = await this.call('POST', '/git/blobs', {
        content: isB64 ? content.contentBase64 : utf8ToBase64(content),
        encoding: 'base64',
      });
      if (status !== 201) throw new Error(`blob ${path}: HTTP ${status}`);
      treeItems.push({ path, mode: '100644', type: 'blob', sha: (json as any).sha });
    }

    // 2. 父 commit（取 baseRef 的 head，保证 PR 可建）与 base tree
    const baseSha = await this.getHeadSha(baseRef);
    let baseTree: string | undefined;
    if (baseSha) {
      const { json } = await this.call('GET', `/git/commits/${baseSha}`);
      baseTree = (json as any).tree_sha ?? (json as any).tree?.sha;
    }

    // 3. tree
    const { status: treeStatus, json: treeJson } = await this.call('POST', '/git/trees', { base_tree: baseTree, tree: treeItems });
    if (treeStatus !== 201) throw new Error(`tree: HTTP ${treeStatus}`);

    // 4. commit
    const { status: commitStatus, json: commitJson } = await this.call('POST', '/git/commits', {
      message,
      tree: (treeJson as any).sha,
      parents: baseSha ? [baseSha] : [],
      author: { name: author.name, email: author.email, date: new Date().toISOString() },
    });
    if (commitStatus !== 201) throw new Error(`commit: HTTP ${commitStatus}`);
    const newSha = (commitJson as any).sha as string;

    // 5. 更新/创建分支引用：GitHub 对 PATCH 不存在的 ref 返回 422（非 404），
    //    不赌状态码——先查分支是否存在再决定更新还是创建
    const branchSha = await this.getHeadSha(branch);
    if (branchSha) {
      const { status } = await this.call('PATCH', `/git/refs/heads/${this.encPath(branch)}`, { sha: newSha, force: true });
      if (status !== 200) throw new Error(`update ref: HTTP ${status}`);
    } else {
      await this.createBranch(branch, newSha);
    }
    return newSha;
  }

  /** 删除 branch 上 dir/ 前缀下的全部文件，返回新 commit sha */
  async deleteDir(branch: string, dir: string, message: string, author: CommitAuthor): Promise<string> {
    const baseSha = await this.getHeadSha(branch);
    if (!baseSha) throw new NotFound(`branch ${branch} not found`);
    const { json: baseCommit } = await this.call('GET', `/git/commits/${baseSha}`);
    const baseTree = (baseCommit as any).tree_sha ?? (baseCommit as any).tree?.sha;

    const { json: fullTree } = await this.call('GET', `/git/trees/${baseTree}?recursive=1`);
    const victims = ((fullTree as any).tree as { path: string; type: string }[])
      .filter((e) => e.type === 'blob' && (e.path === dir || e.path.startsWith(`${dir}/`)))
      .map((e) => ({ path: e.path, sha: null, mode: '100644', type: 'blob' }));
    // 目录不存在/为空：视为已删（幂等），静默返回
    if (victims.length === 0) return baseSha;

    const { status: treeStatus, json: treeJson } = await this.call('POST', '/git/trees', { base_tree: baseTree, tree: victims });
    if (treeStatus !== 201) throw new Error(`delete tree: HTTP ${treeStatus}`);

    const { status: commitStatus, json: commitJson } = await this.call('POST', '/git/commits', {
      message,
      tree: (treeJson as any).sha,
      parents: [baseSha],
      author: { name: author.name, email: author.email, date: new Date().toISOString() },
    });
    if (commitStatus !== 201) throw new Error(`delete commit: HTTP ${commitStatus}`);
    const newSha = (commitJson as any).sha as string;

    const { status } = await this.call('PATCH', `/git/refs/heads/${this.encPath(branch)}`, { sha: newSha, force: true });
    if (status !== 200) throw new Error(`update ref after delete: HTTP ${status}`);
    return newSha;
  }

  async openPR(title: string, head: string, base: string): Promise<number> {
    const { status, json } = await this.call('POST', '/pulls', { title, head, base, body: '' });
    if (status !== 201) throw new Error(`openPR: HTTP ${status} ${JSON.stringify(json)}`);
    return (json as any).number as number;
  }

  async getPR(num: number): Promise<{ state: 'open' | 'closed' | 'merged'; head: string; mergeable: boolean }> {
    const { status, json } = await this.call('GET', `/pulls/${num}`);
    if (status === 404) throw new NotFound(`PR #${num} not found`);
    if (status !== 200) throw new Error(`getPR: HTTP ${status}`);
    const merged = (json as any).merged === true;
    return {
      state: merged ? 'merged' : ((json as any).state === 'closed' ? 'closed' : 'open'),
      head: (json as any).head.ref,
      mergeable: (json as any).mergeable === true,
    };
  }

  /** 关闭 PR（硬删除时配套；404 视为已关） */
  async closePR(num: number): Promise<void> {
    const { status } = await this.call('PATCH', `/pulls/${num}`, { state: 'closed' });
    if (status !== 200 && status !== 404) throw new Error(`closePR: HTTP ${status}`);
  }

  /** 删除分支（404 视为已删） */
  async deleteBranch(branch: string): Promise<void> {
    const { status } = await this.call('DELETE', `/git/refs/heads/${this.encPath(branch)}`);
    if (status !== 204 && status !== 422 && status !== 404) throw new Error(`deleteBranch: HTTP ${status}`);
  }

  async mergePR(num: number, sha: string): Promise<void> {
    const pr = await this.getPR(num); // 先 GET 确认存在（404 → NotFound）
    if (pr.state !== 'open') throw new Error(`PR #${num} is ${pr.state}, not open`);
    const { status, json } = await this.call('PUT', `/pulls/${num}/merge`, { sha, merge_method: 'squash' });
    if (status !== 200) throw new Error(`mergePR: HTTP ${status} ${JSON.stringify(json)}`);
  }

  async getTree(ref: string): Promise<{ path: string; size?: number }[]> {
    const { status, json } = await this.call('GET', `/git/trees/${encodeURIComponent(ref)}?recursive=1`);
    if (status !== 200) throw new Error(`getTree: HTTP ${status}`);
    const entries = ((json as any).tree as { path: string; type: string; size?: number }[]) ?? [];
    return entries
      .filter((e) => e.type === 'blob' && e.path.startsWith('applets/'))
      .map((e) => ({ path: e.path, size: e.size }));
  }

  /** 拉取单文件原始字节（raw media type，二进制安全）；404 → null */
  async getContent(ref: string, path: string): Promise<Uint8Array | null> {
    const url = `${this.api}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`;
    const res = await this.fetchImpl(url, {
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github.raw',
        'user-agent': 'applet-platform',
      },
    });
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error(`getContent ${path}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

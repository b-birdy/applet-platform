// 小程序静态资源服务：/app/:id/*、/preview/:id/*、/app-runtime.js
import { Hono } from 'hono';
import { getAuth, type AuthInfo } from './auth';
import { RUNTIME_JS as runtimeJs } from './runtime-text';

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  map: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json',
};

function contentTypeOf(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

export const serveRoutes = new Hono<{ Bindings: { DB: D1Database; ASSETS: R2Bucket }; Variables: { auth: AuthInfo | null } }>();

// 权限检查：enabled 应用需授权用户（admin 越过）；testing/disabled 仅 admin
async function appletAccess(c: any, slug: string): Promise<{ ok: true; auth: AuthInfo } | { ok: false; status: number; error: string }> {
  const auth = await getAuth(c.req.raw, c.env.DB);
  if (!auth) return { ok: false, status: 401, error: 'UNAUTHORIZED' };
  const isAdmin = auth.role === 'admin' || auth.role === 'superadmin';

  const applet = await c.env.DB.prepare(`SELECT id, status FROM t_applets WHERE path = ?`).bind(slug).first() as { id: number; status: string } | null;
  if (!applet) return { ok: false, status: 404, error: 'APPLET_NOT_FOUND' };

  if (applet.status === 'testing' || applet.status === 'disabled') {
    if (!isAdmin) return { ok: false, status: 403, error: 'APPLET_FORBIDDEN' };
    return { ok: true, auth };
  }
  if (!isAdmin) {
    const acl = await c.env.DB.prepare(`SELECT allowed FROM t_applet_acls WHERE applet_id = ? AND user_id = ?`).bind(applet.id, auth.userId).first() as { allowed: number } | null;
    if (acl?.allowed !== 1) return { ok: false, status: 403, error: 'APPLET_FORBIDDEN' };
  }
  return { ok: true, auth };
}

// 异步正则替换（内联多文件时逐个拉 R2）
async function replaceAsync(input: string, re: RegExp, replacer: (...args: any[]) => Promise<string>): Promise<string> {
  const jobs: Promise<string>[] = [];
  input.replace(re, (...args) => {
    jobs.push(replacer(...args));
    return args[0] as string;
  });
  const results = await Promise.all(jobs);
  let i = 0;
  return input.replace(re, () => results[i++]);
}

async function serveFrom(c: any, prefix: string, slug: string, filePath: string, adminOnly: boolean): Promise<Response> {
  if (adminOnly) {
    const auth = await getAuth(c.req.raw, c.env.DB);
    const isAdmin = auth?.role === 'admin' || auth?.role === 'superadmin';
    if (!isAdmin) {
      if (!auth) return c.json({ error: 'UNAUTHORIZED' }, 401);
      return c.json({ error: 'APPLET_FORBIDDEN' }, 403);
    }
  } else {
    const access = await appletAccess(c, slug);
    if (!access.ok) return c.json({ error: access.error }, access.status as any);
  }

  const key = `${prefix}/${slug}/${filePath}`;
  const obj = await c.env.ASSETS.get(key);
  if (!obj) return c.json({ error: 'NOT_FOUND' }, 404);
  const headers: Record<string, string> = { 'content-type': contentTypeOf(filePath), 'cache-control': 'no-store' };
  // CSP（final review I6）：静态检查是提交时红线，CSP 是运行时红线。
  // 沙箱 iframe（无 allow-same-origin）内 origin 不透明，'self' 匹配空集——
  // 必须用请求的显式 origin 才能放行小程序自己的脚本与 Data API 请求。
  if (/\.html?$/i.test(filePath)) {
    const origin = new URL(c.req.url).origin;
    // 沙箱 iframe（origin=null）无法匹配任何主机源——外部 CSS/JS 会被整条拦下。
    // 因此 HTML 伺服时把同目录的 CSS/JS 全部内联（自包含文档），CSP 只需允许内联。
    headers['content-security-policy'] =
      `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src ${origin}; frame-ancestors ${origin}`;
  }
  let body: ReadableStream | string = obj.body;
  // 主题变量注入：小程序的 style.css 消费平台 CSS 变量（--canvas 等），
  // 但沙箱 iframe 是独立文档，继承不到平台 SPA 的变量——伺服 HTML 时按用户主题内联注入。
  if (/\.html?$/i.test(filePath)) {
    const auth = await getAuth(c.req.raw, c.env.DB);
    const themeRow = auth
      ? await c.env.DB.prepare(`SELECT value FROM t_settings WHERE key = ?`).bind(`theme.${auth.userId}`).first() as { value: string } | null
      : null;
    const dark = themeRow?.value === 'dark';
    const themeStyle = dark
      ? `:root{--canvas:#121816;--panel:#1A211F;--ink:#E6EBE9;--ink-2:#A8B2AF;--ink-3:#6E7A77;--line:#2A332F;--line-strong:#3A4540;--accent:#2FA39A;--accent-weak:#1D3A37;--ok:#4CAF72;--warn:#D29A45;--off:#5F6B68;--danger:#E07070}`
      : `:root{--canvas:#F6F7F5;--panel:#FFFFFF;--ink:#1C2422;--ink-2:#5A6663;--ink-3:#8B9693;--line:#E3E6E2;--line-strong:#D2D8D4;--accent:#176E68;--accent-weak:#E4F0EE;--ok:#2F8A4C;--warn:#B9791F;--off:#9AA5A2;--danger:#C24E4E}`;
    const inject = `<style data-platform-theme>${themeStyle}</style>`;
    let html = await obj.text();
    // 注入到 <head> 之后（若无 head 标签则前置）
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head[^>]*>/i, (m: string) => `${m}\n${inject}`);
    } else {
      html = inject + html;
    }
    // 自包含化：沙箱 iframe 无法加载外部 CSS/JS（origin=null 匹配不了 CSP 主机源），
    // 把相对路径的 <link rel=stylesheet> 与 <script src> 内联为对应内容。
    const baseDir = `prod/${slug}/`;
    const inlineAsset = async (path: string): Promise<string | null> => {
      // 只处理 applet 目录内的相对路径（./x、x、子目录/x），拒绝绝对路径与跨目录逃逸
      if (/^(https?:|\/|data:)/i.test(path)) return null;
      const normalized = path.replace(/^\.\//, '');
      if (normalized.includes('..')) return null;
      // baseDir 已含 slug（prod/<slug>/），normalized 相对 applet 根
      const asset = await c.env.ASSETS.get(`${baseDir}${normalized}`);
      return asset ? await asset.text() : null;
    };
    // 内联样式表
    html = await replaceAsync(html, /<link\s+[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi,
      async (m: string, href: string) => {
        const css = await inlineAsset(href);
        return css === null ? m : `<style data-inlined-from="${href}">\n${css}\n</style>`;
      });
    // 内联脚本（保留 /app-runtime.js 外链——它由平台独立伺服，同源且 CSP 例外已不需要：
    // 运行时也内联，见下）
    html = await replaceAsync(html, /<script\s+([^>]*)src=["']([^"']+)["']([^>]*)><\/script>/gi,
      async (m: string, pre: string, src: string, post: string) => {
        if (/^(https?:|\/)/i.test(src)) return m; // 绝对路径/平台路径不动
        const js = await inlineAsset(src);
        if (js === null) return m;
        const attrs = (pre + ' ' + post).replace(/\bsrc\b/g, '').trim();
        return `<script ${attrs}>\n${js}\n</script>`;
      });
    // 运行时脚本也内联（消除最后一个外部请求）
    html = html.replace(/<script\s+src=["']\/app-runtime\.js["']\s*><\/script>/gi,
      `<script data-applet-runtime>\n${runtimeJs}\n</script>`);
    headers['content-length'] = String(new TextEncoder().encode(html).byteLength);
    body = html;
  }
  return new Response(body, { headers });
}

function splitPath(raw: string): { slug: string; file: string } | null {
  // "/app/<slug>/..." → slug + 文件路径；目录式路径解析到入口 index.html
  const trimmed = raw.replace(/\/+$/, '');
  const parts = trimmed.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const slug = parts[1];
  if (parts.length === 2) return { slug, file: 'index.html' };
  return { slug, file: parts.slice(2).join('/') };
}

serveRoutes.get('/app/:slug{.*}', async (c) => {
  const split = splitPath(new URL(c.req.url).pathname);
  if (!split) return c.json({ error: 'NOT_FOUND' }, 404);
  return serveFrom(c, 'prod', split.slug, split.file, false);
});

serveRoutes.get('/preview/:slug{.*}', async (c) => {
  const split = splitPath(new URL(c.req.url).pathname);
  if (!split) return c.json({ error: 'NOT_FOUND' }, 404);
  return serveFrom(c, 'preview', split.slug, split.file, true);
});

// 内置运行时也通过 /app-runtime.js 伺服（内容来自 runtime-text.ts）——
// 内联进自包含 HTML 后此路由保留给直接访问场景
serveRoutes.get('/app-runtime.js', () =>
  new Response(runtimeJs, {
    headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' },
  })
);

// SPA 回退：前端路由（/、/login、/profile、/admin/*…）交给 assets 层
// （not_found_handling = single-page-application 自动回 index.html）
serveRoutes.get('/:spa{.*}', async (c) => {
  const path = new URL(c.req.url).pathname;
  if (!path.startsWith('/api/') && path !== '/app-runtime.js' && !path.startsWith('/app/') && !path.startsWith('/preview/') && !path.startsWith('/mcp')) {
    const fetcher = (c.env as any).ASSET_FILES as Fetcher | undefined;
    if (!fetcher) return c.json({ error: 'SPA_NOT_DEPLOYED' }, 404);
    return fetcher.fetch(c.req.raw);
  }
  return c.json({ error: 'NOT_FOUND' }, 404);
});

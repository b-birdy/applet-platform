// 小程序静态资源服务：/app/:id/*、/preview/:id/*、/app-runtime.js
import { Hono } from 'hono';
import { getAuth, type AuthInfo } from './auth';

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
  return new Response(obj.body, { headers: { 'content-type': contentTypeOf(filePath), 'cache-control': 'no-store' } });
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

// 内置运行时（Task 14 前为占位）
serveRoutes.get('/app-runtime.js', (c) =>
  new Response('window.applet = { ready: false };\n', {
    headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' },
  })
);

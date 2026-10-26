// GitHub webhook 接收端
import { Hono } from 'hono';
import { hmacSha256Hex } from '../tokens';
import { syncOnce, syncPreview } from '../sync';
import { getGithubClientForEnv } from '../github-bind';

export const hookRoutes = new Hono<{ Bindings: { DB: D1Database; ASSETS: R2Bucket; GITHUB: any; GH_WEBHOOK_SECRET?: string } }>();

hookRoutes.post('/api/hooks/github', async (c) => {
  const secret = c.env.GH_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: 'WEBHOOK_NOT_CONFIGURED' }, 503);

  const body = await c.req.text();
  const sig = c.req.header('x-hub-signature-256') ?? '';
  const expected = `sha256=${await hmacSha256Hex(secret, body)}`;
  if (sig !== expected) return c.json({ error: 'BAD_SIGNATURE' }, 401);

  const event = c.req.header('x-github-event');
  const payload = JSON.parse(body);

  if (event === 'push' && payload.ref === 'refs/heads/main') {
    // 同步失败仍返回 200（避免 GitHub 对配置类错误无限重试）；cron 每 5 分钟兜底
    try {
      const result = await syncOnce({ DB: c.env.DB, ASSETS: c.env.ASSETS, GITHUB: getGithubClientForEnv(c.env) });
      return c.json({ ok: true, ...result });
    } catch (e) {
      console.error('webhook syncOnce failed:', e);
      return c.json({ ok: false, error: 'SYNC_FAILED' });
    }
  }

  if (event === 'pull_request' && ['opened', 'synchronize'].includes(payload.action)) {
    const branch = payload.pull_request?.head?.ref;
    const changed = (payload.pull_request?.changed_files ?? 0) > 0;
    // 分支名 applet/<slug> 才处理
    const m = typeof branch === 'string' ? branch.match(/^applet\/([^/]+)$/) : null;
    if (m) {
      try {
        await syncPreview({ DB: c.env.DB, ASSETS: c.env.ASSETS, GITHUB: getGithubClientForEnv(c.env) }, m[1], branch);
        return c.json({ ok: true, preview: m[1] });
      } catch (e) {
        console.error('webhook syncPreview failed:', e);
        return c.json({ ok: false, error: 'SYNC_FAILED' });
      }
    }
    return c.json({ ok: true, skipped: 'branch-not-applet', changed });
  }

  return c.json({ ok: true, ignored: event });
});

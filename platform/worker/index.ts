import { Hono } from 'hono';
import { setupRoutes } from './routes/setup';
import { authRoutes } from './routes/auth';
import { dataRoutes } from './routes/data';
import { adminUserRoutes } from './routes/admin/users';
import { adminAppletRoutes } from './routes/admin/applets';
import { hookRoutes } from './routes/hooks';
import { serveRoutes } from './serve';
import { syncOnce } from './sync';
import { GitHubClient } from './github';
import { requireAuth, type AuthInfo } from './auth';

type Bindings = {
  DB: D1Database;
  ASSETS: R2Bucket;
  ADMIN_INIT_PASSWORD?: string;
  MCP_SIGNING_KEY?: string;
  GH_WEBHOOK_SECRET?: string;
  GITHUB_TOKEN?: string;
  GITHUB_OWNER?: string;
  GITHUB_REPO?: string;
};

const app = new Hono<{ Bindings: Bindings; Variables: { auth: AuthInfo } }>();

// GitHub 客户端组装（测试注入 GITHUB env 时优先）
function githubOf(env: Bindings & { GITHUB?: GitHubClient }): GitHubClient {
  if ((env as any).GITHUB) return (env as any).GITHUB;
  if (!env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) {
    throw new Error('GitHub not configured (GITHUB_TOKEN/GITHUB_OWNER/GITHUB_REPO secrets)');
  }
  return new GitHubClient(env.GITHUB_TOKEN, env.GITHUB_OWNER, env.GITHUB_REPO);
}

app.get('/api/health', (c) => c.json({ ok: true }));
app.route('/', setupRoutes);
app.route('/', authRoutes);
app.route('/', dataRoutes);
app.route('/', adminUserRoutes);
app.route('/', adminAppletRoutes);
app.route('/', hookRoutes);
app.route('/', serveRoutes);
// 示例受保护路由：验证 requireAuth 中间件可用
app.get('/api/whoami', requireAuth(), (c) => c.json(c.get('auth')));

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Bindings, _ctx: ExecutionContext) {
    // cron: 每 5 分钟同步一次 main 分支
    try {
      await syncOnce({ DB: env.DB, ASSETS: env.ASSETS, GITHUB: githubOf(env as Bindings & { GITHUB?: GitHubClient }) });
    } catch (e) {
      // cron 内不抛——同步失败留待下次，错误进日志
      console.error('scheduled syncOnce failed:', e);
    }
  },
};

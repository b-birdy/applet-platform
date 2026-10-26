import { Hono } from 'hono';
import { setupRoutes } from './routes/setup';
import { authRoutes } from './routes/auth';
import { dataRoutes } from './routes/data';
import { adminUserRoutes } from './routes/admin/users';
import { adminAppletRoutes } from './routes/admin/applets';
import { hookRoutes } from './routes/hooks';
import { prRoutes } from './routes/admin/pr';
import { mcpRoutes, mcpAdminRoutes } from './routes/mcp';
import { myRoutes } from './routes/my';
import { serveRoutes } from './serve';
import { syncOnce } from './sync';
import { GitHubClient } from './github';
import { getGithubClientForEnv } from './github-bind';
import { createAppletRemover } from './remover';
import { requireAuth, type AuthInfo } from './auth';

type Bindings = {
  DB: D1Database;
  ASSETS: R2Bucket;
  ADMIN_INIT_PASSWORD?: string;
  MCP_SIGNING_KEY?: string;
  GH_WEBHOOK_SECRET?: string;
  ASSET_FILES?: Fetcher;
  GITHUB_TOKEN?: string;
  GITHUB_OWNER?: string;
  GITHUB_REPO?: string;
};

const app = new Hono<{ Bindings: Bindings; Variables: { auth: AuthInfo } }>();

// GitHub 客户端组装（测试注入 GITHUB env 或 github-bind override 时优先）
function githubOf(env: Bindings & { GITHUB?: GitHubClient }): GitHubClient {
  return getGithubClientForEnv(env);
}

// remover 接线：applet DELETE 路由的 env.APPLET_REMOVER
export function createBindings(env: Bindings & { GITHUB?: GitHubClient }) {
  const gh = githubOf(env);
  return { github: gh, remover: createAppletRemover({ DB: env.DB, ASSETS: env.ASSETS, GITHUB: gh }) };
}

app.get('/api/health', (c) => c.json({ ok: true }));
app.route('/', setupRoutes);
app.route('/', authRoutes);
app.route('/', dataRoutes);
app.route('/', adminUserRoutes);
app.route('/', adminAppletRoutes);
app.route('/', hookRoutes);
app.route('/', prRoutes);
app.route('/', mcpRoutes);
app.route('/', mcpAdminRoutes);
app.route('/', myRoutes);
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

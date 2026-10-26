import { Hono } from 'hono';
import { setupRoutes } from './routes/setup';
import { authRoutes } from './routes/auth';
import { dataRoutes } from './routes/data';
import { requireAuth, type AuthInfo } from './auth';

type Bindings = {
  DB: D1Database;
  ASSETS: R2Bucket;
  ADMIN_INIT_PASSWORD?: string;
  MCP_SIGNING_KEY?: string;
};

const app = new Hono<{ Bindings: Bindings; Variables: { auth: AuthInfo } }>();

app.get('/api/health', (c) => c.json({ ok: true }));
app.route('/', setupRoutes);
app.route('/', authRoutes);
app.route('/', dataRoutes);
// 示例受保护路由：验证 requireAuth 中间件可用
app.get('/api/whoami', requireAuth(), (c) => c.json(c.get('auth')));

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, _env: Bindings, _ctx: ExecutionContext) {
    // cron 逻辑后续任务接入
  },
};

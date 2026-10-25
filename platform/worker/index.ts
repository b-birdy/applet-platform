import { Hono } from 'hono';

type Bindings = {
  DB: D1Database;
  ASSETS: R2Bucket;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get('/api/health', (c) => c.json({ ok: true }));

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, _env: Bindings, _ctx: ExecutionContext) {
    // cron 逻辑后续任务接入
  },
};

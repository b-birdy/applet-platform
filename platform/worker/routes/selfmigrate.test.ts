// 部署自迁移：全新库（无表）时 GET /api/setup 自动建表
import { env } from 'cloudflare:test';
import { SELF } from 'cloudflare:test';
import { applySchema } from '../db/apply';

beforeAll(async () => {
  // 本文件独立存储：先确保表存在，再由测试本身拆除验证自迁移
  const { results } = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='t_users'`).all();
  if (results.length === 0) await applySchema(env.DB);
});

it('GET /api/setup self-migrates an empty database', async () => {
  // 模拟"刚部署、没跑过 wrangler d1 execute"的库
  const tables = (await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 't_%'`).all<{ name: string }>()).results.map((r) => r.name);
  for (const t of tables) await env.DB.prepare(`DROP TABLE "${t}"`).run();

  const r = await SELF.fetch('https://x/api/setup');
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ needsInit: true });

  const after = (await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 't_%'`).all<{ name: string }>()).results.map((r) => r.name);
  expect(after).toContain('t_users');
  expect(after).toContain('t_applets');

  // 自迁移后 POST /api/setup 完整可用
  const init = await SELF.fetch('https://x/api/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ adminPassword: 'test-admin-init', newPassword: 'selfmigrate-pw' }),
  });
  expect(init.status).toBe(201);
});

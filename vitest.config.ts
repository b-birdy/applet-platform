import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  test: {
    projects: [
      {
        // worker 测试：workerd 池 + wrangler 绑定（DB/ASSETS）
        plugins: [
          cloudflareTest({
            main: './platform/worker/index.ts',
            wrangler: { configPath: './platform/worker/wrangler.toml' },
            miniflare: {
              bindings: {
                ADMIN_INIT_PASSWORD: 'test-admin-init',
                MCP_SIGNING_KEY: 'test-signing-key',
              },
            },
          }),
        ],
        test: {
          name: 'worker',
          include: ['platform/worker/**/*.test.ts'],
          globals: true,
        },
      },
      {
        // 前端 store 测试（Task 13）：jsdom
        test: {
          name: 'web',
          include: ['platform/src/**/*.test.ts'],
          environment: 'jsdom',
        },
      },
    ],
  },
});

import { SELF } from 'cloudflare:test';

it('health', async () => {
  const r = await SELF.fetch('https://x/api/health');
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ ok: true });
});

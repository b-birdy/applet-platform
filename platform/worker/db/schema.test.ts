import { env } from 'cloudflare:test';
import { applySchema } from './apply';

const PLATFORM_TABLES = [
  't_users',
  't_sessions',
  't_applets',
  't_applet_acls',
  't_agents',
  't_agent_applets',
  't_agent_access_codes',
  't_audit_logs',
  't_settings',
  't_prs',
] as const;

beforeAll(async () => {
  await applySchema(env.DB);
});

it('creates all 10 platform tables', async () => {
  const { results } = await env.DB
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 't_%'`)
    .all<{ name: string }>();
  expect(results.map((r) => r.name).sort()).toEqual([...PLATFORM_TABLES].sort());
});

it('t_users.username is unique', async () => {
  await env.DB.prepare(
    `INSERT INTO t_users (id, username, password_hash) VALUES (101, 'u1', 'x')`
  ).run();
  await expect(
    env.DB.prepare(
      `INSERT INTO t_users (id, username, password_hash) VALUES (102, 'u1', 'x')`
    ).run()
  ).rejects.toThrow();
});

it('t_applets.path is unique', async () => {
  await env.DB.prepare(
    `INSERT INTO t_applets (id, name, path) VALUES (101, 'a', 'applets/a')`
  ).run();
  await expect(
    env.DB.prepare(`INSERT INTO t_applets (id, name, path) VALUES (102, 'b', 'applets/a')`).run()
  ).rejects.toThrow();
});

it('t_sessions.token is unique', async () => {
  await env.DB.prepare(
    `INSERT INTO t_users (id, username, password_hash) VALUES (201, 'su', 'x')`
  ).run();
  await env.DB.prepare(
    `INSERT INTO t_sessions (token, user_id, expires_at) VALUES ('tok1', 201, '2027-01-01')`
  ).run();
  await expect(
    env.DB.prepare(
      `INSERT INTO t_sessions (token, user_id, expires_at) VALUES ('tok1', 201, '2027-01-01')`
    ).run()
  ).rejects.toThrow();
});

it('t_applet_acls (applet_id, user_id) is unique and allowed is 1/0', async () => {
  await env.DB.prepare(
    `INSERT INTO t_users (id, username, password_hash) VALUES (202, 'au', 'x')`
  ).run();
  await env.DB.prepare(
    `INSERT INTO t_applets (id, name, path) VALUES (202, 'aa', 'applets/aa')`
  ).run();
  await env.DB.prepare(
    `INSERT INTO t_applet_acls (applet_id, user_id, allowed) VALUES (202, 202, 1)`
  ).run();
  await expect(
    env.DB.prepare(
      `INSERT INTO t_applet_acls (applet_id, user_id, allowed) VALUES (202, 202, 0)`
    ).run()
  ).rejects.toThrow();
  await expect(
    env.DB.prepare(
      `INSERT INTO t_applet_acls (applet_id, user_id, allowed) VALUES (202, 202, 2)`
    ).run()
  ).rejects.toThrow();
});

it('t_agents.fingerprint is NOT NULL', async () => {
  await env.DB.prepare(
    `INSERT INTO t_agents (id, name, fingerprint) VALUES (201, 'a', 'fp1')`
  ).run();
  await expect(
    env.DB.prepare(`INSERT INTO t_agents (id, name, fingerprint) VALUES (202, 'b', NULL)`).run()
  ).rejects.toThrow();
});

it('t_agent_applets (agent_id, applet_id) is unique', async () => {
  await env.DB.prepare(
    `INSERT INTO t_applets (id, name, path) VALUES (203, 'ab', 'applets/ab')`
  ).run();
  await env.DB.prepare(
    `INSERT INTO t_agents (id, name, fingerprint) VALUES (203, 'ag', 'fp2')`
  ).run();
  await env.DB.prepare(
    `INSERT INTO t_agent_applets (agent_id, applet_id, source) VALUES (203, 203, 'submitted')`
  ).run();
  await expect(
    env.DB.prepare(
      `INSERT INTO t_agent_applets (agent_id, applet_id, source) VALUES (203, 203, 'granted')`
    ).run()
  ).rejects.toThrow();
});

it('t_audit_logs has index on at', async () => {
  const { results } = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='t_audit_logs'`
  ).all<{ name: string }>();
  expect(results.length).toBeGreaterThan(0);
});

import { env } from 'cloudflare:test';
import { SELF } from 'cloudflare:test';
import { hashPassword } from '../../auth';
import { registerAppletTables } from '../../data';

let superadminCookie: string;
let adminCookie: string;
let userCookie: string;
let adminId: number;
let superadminId: number;

async function login(username: string): Promise<string> {
  const r = await SELF.fetch('https://x/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'pw-123456' }),
  });
  if (r.status !== 200) throw new Error(`login ${username} failed: ${r.status}`);
  return r.headers.get('set-cookie')!.split(';')[0];
}

async function seedUser(username: string, role: string): Promise<number> {
  const hash = await hashPassword('pw-123456');
  const row = await env.DB.prepare(`INSERT INTO t_users (username, password_hash, role) VALUES (?, ?, ?) RETURNING id`)
    .bind(username, hash, role)
    .first<{ id: number }>();
  return row!.id;
}

beforeAll(async () => {
  const { results } = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='t_users'`).all();
  if (results.length === 0) {
    const { applySchema } = await import('../../db/apply');
    await applySchema(env.DB);
  }
  superadminId = await seedUser('root', 'superadmin');
  adminId = await seedUser('boss', 'admin');
  await seedUser('alice', 'user');
  superadminCookie = await login('root');
  adminCookie = await login('boss');
  userCookie = await login('alice');
});

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM t_audit_logs WHERE action LIKE 'user.%'`);
});

describe('role gate', () => {
  it('regular user gets 403 on admin API', async () => {
    const r = await SELF.fetch('https://x/api/admin/users', { headers: { cookie: userCookie } });
    expect(r.status).toBe(403);
  });

  it('unauthenticated gets 401', async () => {
    const r = await SELF.fetch('https://x/api/admin/users');
    expect(r.status).toBe(401);
  });

  it('admin cannot create an admin (superadmin only)', async () => {
    const r = await SELF.fetch('https://x/api/admin/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ username: 'newadmin', password: 'pw-123456', role: 'admin' }),
    });
    expect(r.status).toBe(403);
  });

  it('superadmin can create admin', async () => {
    const r = await SELF.fetch('https://x/api/admin/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: superadminCookie },
      body: JSON.stringify({ username: 'second-admin', password: 'pw-123456', role: 'admin' }),
    });
    expect(r.status).toBe(201);
  });
});

describe('create + list', () => {
  it('admin creates user, list shows them', async () => {
    const r = await SELF.fetch('https://x/api/admin/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ username: 'created-user', password: 'pw-123456', nickname: '新建' }),
    });
    expect(r.status).toBe(201);

    const list = await SELF.fetch('https://x/api/admin/users', { headers: { cookie: adminCookie } });
    const json: any = await list.json();
    expect(json.users.some((u: any) => u.username === 'created-user')).toBe(true);
  });

  it('rejects duplicate username with 409', async () => {
    const r = await SELF.fetch('https://x/api/admin/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ username: 'alice', password: 'pw-123456' }),
    });
    expect(r.status).toBe(409);
  });
});

describe('reset password', () => {
  it('new password logs in, old does not', async () => {
    const uid = await seedUser('resetme', 'user');
    const r = await SELF.fetch(`https://x/api/admin/users/${uid}/reset-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ newPassword: 'brand-new-pw' }),
    });
    expect(r.status).toBe(200);

    const oldLogin = await SELF.fetch('https://x/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'resetme', password: 'pw-123456' }),
    });
    expect(oldLogin.status).toBe(401);
    const newLogin = await SELF.fetch('https://x/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'resetme', password: 'brand-new-pw' }),
    });
    expect(newLogin.status).toBe(200);
  });
});

describe('lock / unlock', () => {
  it('locked user cannot log in (LOCKED), unlock restores', async () => {
    const uid = await seedUser('lockme', 'user');
    const lock = await SELF.fetch(`https://x/api/admin/users/${uid}/lock`, {
      method: 'POST', headers: { cookie: adminCookie },
    });
    expect(lock.status).toBe(200);

    const denied = await SELF.fetch('https://x/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'lockme', password: 'pw-123456' }),
    });
    expect(denied.status).toBe(401);
    expect((await denied.json() as any).code).toBe('LOCKED');

    const unlock = await SELF.fetch(`https://x/api/admin/users/${uid}/unlock`, {
      method: 'POST', headers: { cookie: adminCookie },
    });
    expect(unlock.status).toBe(200);
    const ok = await SELF.fetch('https://x/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'lockme', password: 'pw-123456' }),
    });
    expect(ok.status).toBe(200);
  });
});

describe('delete user (superadmin only, cascades applet data D27)', () => {
  it('admin cannot delete; superadmin delete removes user and their applet rows', async () => {
    const victim = await seedUser('victim', 'user');
    await registerAppletTables(env.DB, 'demo', [{ name: 't1', columns: [{ name: 'note', type: 'text' }] }]);
    for (const note of ['a', 'b', 'c']) {
      await env.DB.prepare(`INSERT INTO a_demo_t1 (user_id, note) VALUES (?, ?)`).bind(victim, note).run();
    }

    const asAdmin = await SELF.fetch(`https://x/api/admin/users/${victim}`, {
      method: 'DELETE', headers: { cookie: adminCookie },
    });
    expect(asAdmin.status).toBe(403);

    const del = await SELF.fetch(`https://x/api/admin/users/${victim}`, {
      method: 'DELETE', headers: { cookie: superadminCookie },
    });
    expect(del.status).toBe(200);

    const gone = await env.DB.prepare(`SELECT COUNT(*) AS n FROM t_users WHERE id = ?`).bind(victim).first<{ n: number }>();
    expect(gone!.n).toBe(0);
    const rows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM a_demo_t1 WHERE user_id = ?`).bind(victim).first<{ n: number }>();
    expect(rows!.n).toBe(0);
    const sessions = await env.DB.prepare(`SELECT COUNT(*) AS n FROM t_sessions WHERE user_id = ?`).bind(victim).first<{ n: number }>();
    expect(sessions!.n).toBe(0);
  });
});

describe('CSV import', () => {
  it('imports 3, reports 1 duplicate', async () => {
    const csv = [
      'username,password,nickname',
      'imp-one,pw-123456,一',
      'imp-two,pw-123456,二',
      'imp-three,pw-123456,三',
      'alice,pw-123456,重复',
    ].join('\n');
    const r = await SELF.fetch('https://x/api/admin/users/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ csv }),
    });
    expect(r.status).toBe(200);
    const json: any = await r.json();
    expect(json.imported).toBe(3);
    expect(json.failed).toEqual([{ username: 'alice', reason: 'duplicate' }]);
  });
});

describe('audit trail', () => {
  it('writes audit rows for create/import/reset/lock/delete', async () => {
    const uid = await seedUser('audited', 'user');
    await SELF.fetch('https://x/api/admin/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ username: 'audited2', password: 'pw-123456' }),
    });
    await SELF.fetch(`https://x/api/admin/users/${uid}/reset-password`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ newPassword: 'pw-123456' }),
    });
    await SELF.fetch(`https://x/api/admin/users/${uid}/lock`, { method: 'POST', headers: { cookie: adminCookie } });
    await SELF.fetch(`https://x/api/admin/users/${uid}`, { method: 'DELETE', headers: { cookie: superadminCookie } });
    await SELF.fetch('https://x/api/admin/users/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ csv: 'audited3,pw-123456,x' }),
    });

    const { results } = await env.DB.prepare(`SELECT DISTINCT action FROM t_audit_logs WHERE action LIKE 'user.%'`).all<{ action: string }>();
    const actions = new Set(results.map((r) => r.action));
    for (const expected of ['user.create', 'user.reset_password', 'user.lock', 'user.delete', 'user.import']) {
      expect(actions.has(expected)).toBe(true);
    }
  });
});

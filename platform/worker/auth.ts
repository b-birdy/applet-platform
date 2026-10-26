// 认证内核：PBKDF2 口令哈希 + 会话 + 角色中间件
// hash 格式: pbkdf2$<iter>$<salt_b64>$<hash_b64>
const PBKDF2_ITERATIONS = 100_000;

function b64encode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashPassword(pw: string, saltB64?: string): Promise<string> {
  const salt = saltB64 ? b64decode(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64encode(salt)}$${b64encode(bits)}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [scheme, iterStr, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'pbkdf2') return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: b64decode(saltB64) as BufferSource, iterations: Number(iterStr), hash: 'SHA-256' },
    key,
    256
  );
  const expect = b64decode(hashB64);
  const got = new Uint8Array(bits);
  if (expect.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= expect[i] ^ got[i];
  return diff === 0; // 常量时间比较
}

export async function createSession(db: D1Database, userId: number): Promise<string> {
  const token = randomHex(32);
  const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);
  await db
    .prepare(`INSERT INTO t_sessions (token, user_id, expires_at) VALUES (?, ?, ?)`)
    .bind(token, userId, expires)
    .run();
  return token;
}

export type AuthInfo = { userId: number; role: string; username: string };

export async function getAuth(request: Request, db: D1Database): Promise<AuthInfo | null> {
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(/(?:^|;\s*)sid=([0-9a-f]{64})/);
  if (!m) return null;
  const row = await db
    .prepare(
      `SELECT s.user_id, s.expires_at, u.role, u.username, u.status
       FROM t_sessions s JOIN t_users u ON u.id = s.user_id WHERE s.token = ?`
    )
    .bind(m[1])
    .first<{ user_id: number; expires_at: string; role: string; username: string; status: string }>();
  if (!row) return null;
  // SQLite datetime('now') 存 UTC；比较用 UTC epoch
  const expires = new Date(row.expires_at + 'Z').getTime();
  if (Number.isNaN(expires) || expires < Date.now()) return null;
  if (row.status === 'locked') return null;
  return { userId: row.user_id, role: row.role, username: row.username };
}

const ROLE_ORDER: Record<string, number> = { user: 0, admin: 1, superadmin: 2 };

export type AppEnv = { DB: D1Database; ASSETS: R2Bucket } & Record<string, unknown>;

// Hono 中间件工厂：绑定到 app.use() 时用 c.env；路由内取上下文请复用 getAuth
export function requireAuth() {
  return createAuthMiddleware(0);
}

export function requireRole(min: 'user' | 'admin' | 'superadmin') {
  return createAuthMiddleware(ROLE_ORDER[min]);
}

function createAuthMiddleware(minLevel: number) {
  return async (c: any, next: () => Promise<void>) => {
    const auth = await getAuth(c.req.raw, c.env.DB);
    if (!auth) return c.json({ error: 'UNAUTHORIZED' }, 401);
    if (ROLE_ORDER[auth.role] === undefined || ROLE_ORDER[auth.role] < minLevel) {
      return c.json({ error: 'FORBIDDEN' }, 403);
    }
    c.set('auth', auth);
    await next();
  };
}

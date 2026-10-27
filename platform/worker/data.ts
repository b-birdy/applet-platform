// 小程序数据表管理：注册（含 D24 演进校验）、删除、白名单查询
export type ManifestColumn = { name: string; type: 'text' | 'integer' | 'real' | 'blob'; required?: boolean; default?: unknown };
export type ManifestTable = { name: string; columns: ManifestColumn[] };

const COL_NAME_RE = /^[a-z][a-z0-9_]*$/;

// applet id 规范化后拼物理表名（id 含连字符时转下划线，保证合法 SQL 标识符）
export function appletTable(appletId: string, table: string): string {
  return `a_${appletId.replace(/[^a-zA-Z0-9]+/g, '_')}_${table}`;
}

// 版本号两级归一化：v1.0 / 1.0 / 1.0.0 / 2 → v1.0 / v1.0 / v1.0 / v2.0；非法返回 null
export function normalizeVersion(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = String(v).trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.\d+)?$/);
  if (!m) return null;
  return `v${Number(m[1])}.${m[2] !== undefined ? Number(m[2]) : 0}`;
}
const TYPE_MAP: Record<string, string> = { text: 'TEXT', integer: 'INTEGER', real: 'REAL', blob: 'BLOB' };

export class SchemaChangeError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'SchemaChangeError';
  }
}

/** 清单声明与平台托管列冲突（id/user_id/created_at）——结构化返回而非 500 */
export class ReservedColumnError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ReservedColumnError';
  }
}

type Snapshot = Record<string, { columns: Record<string, string> }>;

function readSnapshot(raw: string | null | undefined): Snapshot {
  return raw ? JSON.parse(raw) : {};
}

export async function registerAppletTables(db: D1Database, appletId: string, tables: ManifestTable[]): Promise<void> {
  const key = `manifest.${appletId}`;
  const existingRow = await db.prepare(`SELECT value FROM t_settings WHERE key = ?`).bind(key).first<{ value: string }>();
  const snapshot = readSnapshot(existingRow?.value);

  // D24：与快照比对——仅允许新增列；改类型/删列/删表拒绝
  for (const t of tables) {
    const prev = snapshot[t.name];
    if (prev) {
      const prevCols = new Set(Object.keys(prev.columns));
      for (const col of t.columns) {
        if (prevCols.has(col.name) && prev.columns[col.name] !== col.type) {
          throw new SchemaChangeError(`表 ${t.name}.${col.name} 类型改变 ${prev.columns[col.name]} → ${col.type}，禁止`);
        }
        prevCols.delete(col.name);
      }
      if (prevCols.size > 0) {
        throw new SchemaChangeError(`表 ${t.name} 删除列: ${[...prevCols].join(', ')}，禁止`);
      }
    }
  }
  for (const name of Object.keys(snapshot)) {
    if (!tables.some((t) => t.name === name)) {
      throw new SchemaChangeError(`表 ${name} 被删除，禁止`);
    }
  }

  for (const t of tables) {
    await ensureTable(db, appletId, t, snapshot[t.name]);
  }

  // 写新快照
  const next: Snapshot = {};
  for (const t of tables) {
    next[t.name] = { columns: Object.fromEntries(t.columns.map((c) => [c.name, c.type])) };
  }
  await db
    .prepare(`INSERT INTO t_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .bind(key, JSON.stringify(next))
    .run();
}

async function ensureTable(db: D1Database, appletId: string, t: ManifestTable, prev?: { columns: Record<string, string> }): Promise<void> {
  const table = appletTable(appletId, t.name);
  if (!prev) {
    const cols = t.columns
      .map((c) => {
        const parts = [c.name, TYPE_MAP[c.type]];
        if (c.required) parts.push('NOT NULL');
        if (c.default !== undefined) parts.push(`DEFAULT ${typeof c.default === 'string' ? `'${c.default.replace(/'/g, "''")}'` : c.default}`);
        return parts.join(' ');
      })
      .join(', ');
    try {
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS "${table}" (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), ${cols})`
        )
        .run();
    } catch (e) {
      if (e instanceof Error && /duplicate column/i.test(e.message)) {
        throw new ReservedColumnError(`表 ${t.name} 声明了平台托管列（id/user_id/created_at 由平台自动提供，不可声明）`);
      }
      throw e;
    }
    await db.prepare(`CREATE INDEX IF NOT EXISTS "idx_${table}_user" ON "${table}" (user_id)`).run();
  } else {
    // 只加缺失的列（ALTER TABLE ADD COLUMN）
    const info = await db.prepare(`PRAGMA table_info("${table}")`).all<{ name: string }>();
    const have = new Set(info.results.map((r) => r.name));
    for (const c of t.columns) {
      if (!have.has(c.name)) {
        // 注意: NOT NULL 列在 ALTER ADD 时必须有 DEFAULT，否则存量行无法满足；required 列在演进场景放宽
        await db.prepare(`ALTER TABLE "${table}" ADD COLUMN "${c.name}" ${TYPE_MAP[c.type]}`).run();
      }
    }
  }
}

export async function dropAppletTables(db: D1Database, appletId: string): Promise<void> {
  const key = `manifest.${appletId}`;
  const row = await db.prepare(`SELECT value FROM t_settings WHERE key = ?`).bind(key).first<{ value: string }>();
  if (row?.value) {
    const snapshot = readSnapshot(row.value);
    for (const name of Object.keys(snapshot)) {
      await db.prepare(`DROP TABLE IF EXISTS "${appletTable(appletId, name)}"`).run();
    }
  }
  await db.prepare(`DELETE FROM t_settings WHERE key = ?`).bind(key).run();
}

// 读取已注册清单（供路由白名单用）
export async function getRegisteredTables(db: D1Database, appletId: string): Promise<Map<string, Set<string>>> {
  const row = await db.prepare(`SELECT value FROM t_settings WHERE key = ?`).bind(`manifest.${appletId}`).first<{ value: string }>();
  const out = new Map<string, Set<string>>();
  if (row?.value) {
    const snapshot = readSnapshot(row.value) as Snapshot;
    for (const [name, def] of Object.entries(snapshot)) {
      out.set(name, new Set(['id', 'user_id', 'created_at', ...Object.keys(def.columns)]));
    }
  }
  return out;
}

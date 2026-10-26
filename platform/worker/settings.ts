// 系统设置读取（t_settings 键值对）
export async function getSetting(db: D1Database, key: string, fallback?: string): Promise<string> {
  const row = await db.prepare(`SELECT value FROM t_settings WHERE key = ?`).bind(key).first<{ value: string }>();
  return row?.value ?? fallback ?? '';
}

export type Quota = { rows: number; bytes: number };

const DEFAULT_QUOTA: Quota = { rows: 10000, bytes: 20971520 };

export async function getQuota(db: D1Database, appletId?: string): Promise<Quota> {
  if (appletId) {
    const rows = await getSetting(db, `quota.${appletId}.rows`);
    const bytes = await getSetting(db, `quota.${appletId}.bytes`);
    if (rows || bytes) {
      return {
        rows: rows ? Number(rows) : (await globalRows(db)),
        bytes: bytes ? Number(bytes) : (await globalBytes(db)),
      };
    }
  }
  return { rows: await globalRows(db), bytes: await globalBytes(db) };
}

async function globalRows(db: D1Database): Promise<number> {
  const v = await getSetting(db, 'quota_rows');
  return v ? Number(v) : DEFAULT_QUOTA.rows;
}

async function globalBytes(db: D1Database): Promise<number> {
  const v = await getSetting(db, 'quota_bytes');
  return v ? Number(v) : DEFAULT_QUOTA.bytes;
}

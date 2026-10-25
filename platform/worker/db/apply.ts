import schemaSql from './schema.sql?raw';

// dev 应用 schema：wrangler d1 execute applet-platform --file=platform/worker/db/schema.sql --local|--remote
// 测试内用本 helper（D1 exec 按换行拆分不可靠，故自行按 ';' 拆分后 batch）
export async function applySchema(db: D1Database): Promise<void> {
  const statements = schemaSql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  await db.batch(statements.map((s) => db.prepare(s)));
}

// 审计日志
export type AuditEntry = {
  actor_type: 'user' | 'agent' | 'system';
  actor_id: string;
  action: string;
  target?: string;
  detail?: unknown;
  ip?: string;
};

export async function logAudit(db: D1Database, e: AuditEntry): Promise<void> {
  await db
    .prepare(`INSERT INTO t_audit_logs (actor_type, actor_id, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(e.actor_type, e.actor_id, e.action, e.target ?? null, e.detail ? JSON.stringify(e.detail) : null, e.ip ?? null)
    .run();
}

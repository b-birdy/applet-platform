-- Applet 平台 D1 schema（spec §5）
-- t_users.password_hash 格式: pbkdf2$<iter>$<salt_b64>$<hash_b64>

CREATE TABLE t_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  nickname TEXT,
  status TEXT NOT NULL DEFAULT 'normal',
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_users_username ON t_users(username);

CREATE TABLE t_sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES t_users(id),
  expires_at TEXT NOT NULL
);

CREATE TABLE t_applets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  icon TEXT,
  status TEXT NOT NULL DEFAULT 'testing',
  entry TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sync_commit TEXT,
  missing INTEGER NOT NULL DEFAULT 0,
  display TEXT NOT NULL DEFAULT 'embed'
);
CREATE UNIQUE INDEX idx_applets_path ON t_applets(path);

CREATE TABLE t_applet_acls (
  applet_id INTEGER NOT NULL REFERENCES t_applets(id),
  user_id INTEGER NOT NULL REFERENCES t_users(id),
  allowed INTEGER NOT NULL DEFAULT 1 CHECK (allowed IN (0, 1)),
  PRIMARY KEY (applet_id, user_id)
);

CREATE TABLE t_agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  key_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  applied_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_by INTEGER,
  last_seen TEXT
);

CREATE TABLE t_agent_applets (
  agent_id INTEGER NOT NULL REFERENCES t_agents(id),
  applet_id INTEGER NOT NULL REFERENCES t_applets(id),
  source TEXT NOT NULL CHECK (source IN ('submitted', 'granted')),
  PRIMARY KEY (agent_id, applet_id)
);

CREATE TABLE t_agent_access_codes (
  code TEXT PRIMARY KEY,
  created_by INTEGER,
  used_by INTEGER REFERENCES t_agents(id),
  expires_at TEXT,
  used_at TEXT
);

CREATE TABLE t_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  ip TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_audit_logs_at ON t_audit_logs(at);

CREATE TABLE t_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE t_prs (
  applet_id INTEGER PRIMARY KEY REFERENCES t_applets(id),
  pr_number INTEGER NOT NULL,
  branch TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  check_report TEXT
);

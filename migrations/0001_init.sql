-- EdgeForms D1 schema
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  verified_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS forms (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  destination_email TEXT NOT NULL,
  reply_to_field TEXT NOT NULL DEFAULT 'email',
  allowed_origins TEXT,
  redirect_url TEXT,
  honeypot_field TEXT NOT NULL DEFAULT '_gotcha',
  notify_email INTEGER NOT NULL DEFAULT 1,
  store_submissions INTEGER NOT NULL DEFAULT 1,
  schema_json TEXT,
  embed_html TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  ip_hash TEXT,
  origin TEXT,
  user_agent TEXT,
  payload_r2_key TEXT,
  payload_preview TEXT,
  email_status TEXT NOT NULL DEFAULT 'queued',
  email_id TEXT,
  email_error TEXT,
  spam_score REAL NOT NULL DEFAULT 0,
  FOREIGN KEY (form_id) REFERENCES forms(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_forms_user ON forms(user_id);
CREATE INDEX IF NOT EXISTS idx_forms_slug ON forms(slug);
CREATE INDEX IF NOT EXISTS idx_submissions_form ON submissions(form_id, received_at DESC);

-- Link an EdgeForms user to a RegisterMySite account without copying passwords.
ALTER TABLE users ADD COLUMN account_user_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_account_user_id ON users(account_user_id);

-- Clear leftover local passwords once a user is linked to RegisterMySite.
UPDATE users SET password_hash = '', password_salt = '' WHERE account_user_id IS NOT NULL;

-- Add name, email, phone to user_config for cross-checking (from Clerk)
ALTER TABLE user_config
  ADD COLUMN IF NOT EXISTS name TEXT,
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS phone TEXT;

COMMENT ON COLUMN user_config.name IS 'User display name from Clerk (firstName + lastName)';
COMMENT ON COLUMN user_config.email IS 'Primary email from Clerk';
COMMENT ON COLUMN user_config.phone IS 'Primary phone from Clerk (when signed in with phone)';

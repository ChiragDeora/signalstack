-- Phone-based Clerk sign-in is being dropped in favor of Google sign-in.
-- Clear stored phone numbers but keep the column for potential future use.
UPDATE user_config SET phone = NULL WHERE phone IS NOT NULL;

-- Wipe all rows from every table in the public schema.
-- Keeps table structure, indexes, constraints, and RLS policies intact.
-- Also resets identity/serial counters.
--
-- Usage:
-- 1) Open Supabase Dashboard -> SQL Editor
-- 2) Paste this script and run it
-- 3) Confirm prompt before executing in production

DO $$
DECLARE
  tbl RECORD;
BEGIN
  FOR tbl IN
    SELECT schemaname, tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  LOOP
    EXECUTE format(
      'TRUNCATE TABLE %I.%I RESTART IDENTITY CASCADE;',
      tbl.schemaname,
      tbl.tablename
    );
  END LOOP;
END $$;

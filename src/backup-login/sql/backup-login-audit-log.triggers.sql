-- =====================================================================
-- backup_login_audit_logs — APPEND-ONLY ENFORCEMENT
-- Wave: wave-backup-login-thaid-fallback (DB-01)
-- Source of Truth: SECURITY-01 §7.12.3 (verbatim)
--
-- This script is IDEMPOTENT — safe to re-run.
--
-- Apply via psql AFTER the backend boots once (so synchronize:true has
-- created the `backup_login_audit_logs` table):
--
--   psql "$DATABASE_URL" -f \
--     backend/src/backup-login/sql/backup-login-audit-log.triggers.sql
--
-- The retention-sweep cron (BE-01) MUST set
--   SET LOCAL app.retention_sweep_in_progress = 'true';
-- inside the same transaction as the DELETE in order to bypass the
-- BEFORE DELETE trigger. Outside the cron, ANY UPDATE or DELETE
-- against this table raises EXCEPTION.
--
-- Verification (post-apply):
--   \dft backup_login_audit_logs_immutable
--   \d  backup_login_audit_logs
-- Both BEFORE UPDATE and BEFORE DELETE triggers should appear.
--
-- Manual proof:
--   UPDATE backup_login_audit_logs SET outcome = 'x'
--     WHERE id = (SELECT id FROM backup_login_audit_logs LIMIT 1);
--   -- ERROR:  backup_login_audit_logs is append-only
--   DELETE FROM backup_login_audit_logs
--     WHERE id = (SELECT id FROM backup_login_audit_logs LIMIT 1);
--   -- ERROR:  backup_login_audit_logs is append-only
-- =====================================================================

CREATE OR REPLACE FUNCTION backup_login_audit_logs_immutable()
RETURNS TRIGGER AS $$
BEGIN
  -- Escape hatch for the retention-sweep cron (SECURITY-01 §7.12.3).
  -- The second arg `true` to current_setting() returns NULL when the
  -- GUC is unset (vs raising), so this is safe to evaluate outside
  -- the cron transaction.
  IF current_setting('app.retention_sweep_in_progress', true) = 'true' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'backup_login_audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS backup_login_audit_logs_no_update
  ON backup_login_audit_logs;
CREATE TRIGGER backup_login_audit_logs_no_update
BEFORE UPDATE ON backup_login_audit_logs
FOR EACH ROW EXECUTE FUNCTION backup_login_audit_logs_immutable();

DROP TRIGGER IF EXISTS backup_login_audit_logs_no_delete
  ON backup_login_audit_logs;
CREATE TRIGGER backup_login_audit_logs_no_delete
BEFORE DELETE ON backup_login_audit_logs
FOR EACH ROW EXECUTE FUNCTION backup_login_audit_logs_immutable();

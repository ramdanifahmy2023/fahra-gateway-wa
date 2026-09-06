\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE backup_records IN SHARE ROW EXCLUSIVE MODE;

DO $rollback$
DECLARE
  affected integer;
BEGIN
  IF (SELECT count(*) FROM backup_records WHERE id IN (
    'f7f35ffb-f793-474a-925c-4dc6d8b02207',
    '796d14e3-6c7c-4d18-a0a4-69ac39591d28',
    'd3415f9e-dc7f-4537-b7b3-fd3fdceebb9d',
    '2309e714-d48b-4b94-b8d9-8e80f2f7ffe3',
    'd03e04f5-a797-4579-8269-8089272506a2'
  )) <> 5 THEN
    RAISE EXCEPTION 'rollback precondition: reconciled rows changed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM backup_records
    WHERE id='5bba9361-41c8-4f3d-ae59-7f5eb5122313'
      AND status='failed' AND metadata->>'classification'='orphan-queued-operation'
  ) THEN
    RAISE EXCEPTION 'rollback precondition: orphan row changed';
  END IF;

  DELETE FROM backup_records WHERE id IN (
    'f7f35ffb-f793-474a-925c-4dc6d8b02207',
    '796d14e3-6c7c-4d18-a0a4-69ac39591d28',
    'd3415f9e-dc7f-4537-b7b3-fd3fdceebb9d',
    '2309e714-d48b-4b94-b8d9-8e80f2f7ffe3',
    'd03e04f5-a797-4579-8269-8089272506a2'
  );
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 5 THEN
    RAISE EXCEPTION 'rollback delete count mismatch: %', affected;
  END IF;

  UPDATE backup_records
  SET operation='backup',
      filename='pending-5bba9361-41c8-4f3d-ae59-7f5eb5122313.ocgwb',
      status='queued',
      format_version=1,
      artifact_path=NULL,
      encrypted=true,
      checksum=NULL,
      size_bytes=NULL,
      started_at='2026-08-13T15:54:31.957343+07'::timestamptz,
      completed_at=NULL,
      initiated_by=NULL,
      error=NULL,
      metadata='{"schedule":"weekly","scheduledDate":"2026-08-13","scheduledWeek":"2026-W33"}'::jsonb,
      created_at='2026-08-13T15:54:31.957343+07'::timestamptz
  WHERE id='5bba9361-41c8-4f3d-ae59-7f5eb5122313';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION 'rollback update count mismatch: %', affected;
  END IF;
END
$rollback$;

COMMIT;

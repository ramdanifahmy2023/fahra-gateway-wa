\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE backup_records IN SHARE ROW EXCLUSIVE MODE;

DO $repair$
DECLARE
  affected integer;
BEGIN
  IF (SELECT count(*) FROM backup_records) <> 1 THEN
    RAISE EXCEPTION 'repair precondition: backup_records count changed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM backup_records
    WHERE id='5bba9361-41c8-4f3d-ae59-7f5eb5122313' AND operation='backup' AND status='queued'
  ) THEN
    RAISE EXCEPTION 'repair precondition: orphan queued operation changed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM backup_records WHERE id IN (
      'f7f35ffb-f793-474a-925c-4dc6d8b02207',
      '796d14e3-6c7c-4d18-a0a4-69ac39591d28',
      'd3415f9e-dc7f-4537-b7b3-fd3fdceebb9d',
      '2309e714-d48b-4b94-b8d9-8e80f2f7ffe3',
      'd03e04f5-a797-4579-8269-8089272506a2'
    )
  ) THEN
    RAISE EXCEPTION 'repair precondition: target metadata already exists';
  END IF;

  UPDATE backup_records
  SET status='failed',
      error='Reconciled 2026-08-14: orphaned weekly operation caused by restored terminal dedupe collision',
      completed_at=now(),
      metadata=metadata || '{"reconciled":true,"classification":"orphan-queued-operation","artifactPresent":false}'::jsonb
  WHERE id='5bba9361-41c8-4f3d-ae59-7f5eb5122313' AND status='queued';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION 'repair update count mismatch: %', affected;
  END IF;

  INSERT INTO backup_records(
    id,operation,filename,status,format_version,artifact_path,encrypted,checksum,size_bytes,
    started_at,completed_at,initiated_by,error,metadata,created_at
  ) VALUES
  (
    'f7f35ffb-f793-474a-925c-4dc6d8b02207','backup',
    'openclaw-gateway-f7f35ffb-f793-474a-925c-4dc6d8b02207.ocgwb','completed',2,
    'openclaw-gateway-f7f35ffb-f793-474a-925c-4dc6d8b02207.ocgwb',true,
    'feed0dbdedf17a080ec6385f6f243e7179e64942d86101655f65cbd820a10f47',9713832,
    '2026-08-10T12:56:14.592+07'::timestamptz,'2026-08-10T16:25:23.733+07'::timestamptz,NULL,NULL,
    '{"schedule":"historical-daily","reconciled":true,"classification":"canonical-artifact-metadata-rehydrated","sourceQueueJobId":"74b9541d-428e-47ff-8481-912692fdb6cb"}'::jsonb,
    '2026-08-10T12:56:14.592+07'::timestamptz
  ),
  (
    '796d14e3-6c7c-4d18-a0a4-69ac39591d28','backup',
    'openclaw-gateway-796d14e3-6c7c-4d18-a0a4-69ac39591d28.ocgwb','completed',2,
    'openclaw-gateway-796d14e3-6c7c-4d18-a0a4-69ac39591d28.ocgwb',true,
    'bbea5f1ecdbcb25f8c4fa1817edc5c2b815f4276cba5aa1e5c41c4f3242ee09a',9778552,
    '2026-08-11T02:02:37.153+07'::timestamptz,'2026-08-11T02:02:42.775+07'::timestamptz,NULL,NULL,
    '{"schedule":"historical-daily","reconciled":true,"classification":"canonical-artifact-metadata-rehydrated","sourceQueueJobId":"615195ab-c12a-4602-931d-00dd35157303"}'::jsonb,
    '2026-08-11T02:02:37.153+07'::timestamptz
  ),
  (
    'd3415f9e-dc7f-4537-b7b3-fd3fdceebb9d','backup',
    'openclaw-gateway-d3415f9e-dc7f-4537-b7b3-fd3fdceebb9d.ocgwb','completed',2,
    'openclaw-gateway-d3415f9e-dc7f-4537-b7b3-fd3fdceebb9d.ocgwb',true,
    'e1e851f2470fdcfa7740be1b75eeea96f95860ff9e7ce6cce18938f5a967d693',9788324,
    '2026-08-11T11:54:36.430+07'::timestamptz,'2026-08-11T11:54:41.894+07'::timestamptz,NULL,NULL,
    '{"schedule":"weekly","scheduledDate":"2026-08-11","scheduledWeek":"2026-W33","reconciled":true,"classification":"canonical-artifact-metadata-rehydrated-after-restore","sourceQueueJobId":"9c6a71be-17e9-4e28-a3dc-29339cca2d32","queueHistoricalStatus":"dead_letter"}'::jsonb,
    '2026-08-11T11:54:36.430+07'::timestamptz
  ),
  (
    '2309e714-d48b-4b94-b8d9-8e80f2f7ffe3','backup',
    'openclaw-gateway-2309e714-d48b-4b94-b8d9-8e80f2f7ffe3.ocgwb','completed',2,
    'openclaw-gateway-2309e714-d48b-4b94-b8d9-8e80f2f7ffe3.ocgwb',true,
    '3c57350c43837a7a61676ae77f288b66c2dc170dd66c3f2bc01304c9c467e1e0',9529844,
    '2026-08-11T05:31:45.745+07'::timestamptz,'2026-08-11T05:31:45.993+07'::timestamptz,NULL,NULL,
    '{"schedule":"manual","reconciled":true,"classification":"canonical-artifact-untracked-manual-or-recovery","provenance":"unconfirmed"}'::jsonb,
    '2026-08-11T05:31:45.745+07'::timestamptz
  ),
  (
    'd03e04f5-a797-4579-8269-8089272506a2','backup',
    'openclaw-gateway-d03e04f5-a797-4579-8269-8089272506a2.ocgwb','failed',2,
    'openclaw-gateway-d03e04f5-a797-4579-8269-8089272506a2.ocgwb',true,
    '735dce44341b04bda7364f7a595a8a533bb2ac55a11b5a01556e265b5f3ed9ff',4062,
    '2026-08-13T15:30:45.095+07'::timestamptz,'2026-08-13T15:30:45.099+07'::timestamptz,NULL,
    'Suspicious-empty artifact from incident window; do not restore',
    '{"schedule":"weekly","scheduledDate":"2026-08-13","scheduledWeek":"2026-W33","reconciled":true,"classification":"suspicious-empty","doNotRestore":true,"clearBytes":8493}'::jsonb,
    '2026-08-13T15:30:45.095+07'::timestamptz
  );
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 5 THEN
    RAISE EXCEPTION 'repair insert count mismatch: %', affected;
  END IF;

  IF (SELECT count(*) FROM backup_records) <> 6 THEN
    RAISE EXCEPTION 'repair final count mismatch';
  END IF;
END
$repair$;

COMMIT;

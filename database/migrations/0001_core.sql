CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION set_row_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS runtime_instances (
    id UUID PRIMARY KEY,
    service_name TEXT NOT NULL,
    instance_name TEXT NOT NULL,
    runtime TEXT NOT NULL CHECK (runtime IN ('bun', 'node')),
    version TEXT NOT NULL,
    pid INTEGER NOT NULL CHECK (pid > 0),
    started_at TIMESTAMPTZ NOT NULL,
    heartbeat_at TIMESTAMPTZ NOT NULL,
    stopped_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (service_name, instance_name)
);

CREATE INDEX IF NOT EXISTS runtime_instances_heartbeat_idx
    ON runtime_instances (service_name, heartbeat_at DESC)
    WHERE stopped_at IS NULL;

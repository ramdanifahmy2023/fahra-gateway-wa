CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('admin', 'openclaw', 'service', 'system', 'anonymous', 'internal')),
    actor_id TEXT,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT,
    request_id UUID,
    ip_address TEXT,
    user_agent TEXT,
    before_data JSONB,
    after_data JSONB,
    result TEXT NOT NULL DEFAULT 'success' CHECK (result IN ('success', 'denied', 'failed')),
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_logs_recent_idx ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_resource_idx ON audit_logs (resource_type, resource_id, created_at DESC);

CREATE TABLE IF NOT EXISTS operational_logs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    level TEXT NOT NULL CHECK (level IN ('trace', 'debug', 'info', 'warn', 'error', 'fatal')),
    service TEXT NOT NULL,
    event TEXT NOT NULL,
    message TEXT NOT NULL,
    request_id UUID,
    correlation_id UUID,
    context JSONB NOT NULL DEFAULT '{}'::JSONB,
    error_code TEXT,
    error_stack_redacted TEXT
);

CREATE INDEX IF NOT EXISTS operational_logs_recent_idx ON operational_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS operational_logs_service_level_idx ON operational_logs (service, level, created_at DESC);

CREATE TABLE IF NOT EXISTS backup_records (
    id UUID PRIMARY KEY,
    operation TEXT NOT NULL DEFAULT 'backup' CHECK (operation IN ('backup', 'restore')),
    filename TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('queued', 'started', 'running', 'restoring', 'completed', 'failed', 'cancelled')),
    format_version INTEGER NOT NULL DEFAULT 1 CHECK (format_version > 0),
    artifact_path TEXT,
    encrypted BOOLEAN NOT NULL DEFAULT TRUE,
    checksum TEXT CHECK (checksum IS NULL OR checksum ~ '^[0-9a-f]{64}$'),
    size_bytes BIGINT CHECK (size_bytes IS NULL OR size_bytes >= 0),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    initiated_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
    error TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (artifact_path IS NULL OR artifact_path !~ '(^/|(^|/)\.\.(/|$))')
);

CREATE INDEX IF NOT EXISTS backup_records_recent_idx ON backup_records (started_at DESC);

CREATE TABLE IF NOT EXISTS uploads (
    id UUID PRIMARY KEY,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
    sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    purpose TEXT NOT NULL DEFAULT 'outbound_document'
        CHECK (purpose IN ('outbound_image', 'outbound_document', 'knowledge_import', 'restore')),
    status TEXT NOT NULL DEFAULT 'ready'
        CHECK (status IN ('uploading', 'ready', 'consumed', 'quarantined', 'deleted')),
    CHECK (stored_name !~ '(^/|(^|/)\.\.(/|$))')
);

CREATE INDEX IF NOT EXISTS uploads_cleanup_idx ON uploads (expires_at) WHERE expires_at IS NOT NULL;

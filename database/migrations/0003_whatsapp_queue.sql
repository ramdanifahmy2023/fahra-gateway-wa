CREATE TABLE IF NOT EXISTS whatsapp_connection (
    id UUID PRIMARY KEY,
    singleton_key BOOLEAN NOT NULL DEFAULT TRUE UNIQUE CHECK (singleton_key),
    phone_number TEXT,
    jid TEXT,
    display_name TEXT,
    status TEXT NOT NULL DEFAULT 'logged_out'
        CHECK (status IN ('logged_out', 'qr_pending', 'connecting', 'connected', 'reconnecting', 'disconnected', 'auth_failed')),
    session_generation BIGINT NOT NULL DEFAULT 0 CHECK (session_generation >= 0),
    reconnect_attempt INTEGER NOT NULL DEFAULT 0 CHECK (reconnect_attempt >= 0),
    last_connected_at TIMESTAMPTZ,
    last_disconnected_at TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_connection_jid_uidx ON whatsapp_connection (jid) WHERE jid IS NOT NULL;

CREATE TRIGGER whatsapp_connection_set_updated_at
BEFORE UPDATE ON whatsapp_connection
FOR EACH ROW EXECUTE FUNCTION set_row_updated_at();

-- The encrypted value is a versioned AES-256-GCM envelope containing nonce,
-- authentication tag, ciphertext and AAD metadata. The master key is never stored here.
CREATE TABLE IF NOT EXISTS whatsapp_auth_state (
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    value_encrypted BYTEA NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (scope, key)
);

CREATE INDEX IF NOT EXISTS whatsapp_auth_state_scope_idx ON whatsapp_auth_state (scope, updated_at DESC);

CREATE TABLE IF NOT EXISTS whatsapp_connection_events (
    id UUID PRIMARY KEY,
    account_id UUID REFERENCES whatsapp_connection(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('qr', 'connecting', 'open', 'close', 'reconnect_scheduled', 'logged_out', 'error')),
    reason_code TEXT,
    retry_number INTEGER NOT NULL DEFAULT 0 CHECK (retry_number >= 0),
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS whatsapp_connection_events_recent_idx
    ON whatsapp_connection_events (occurred_at DESC);

CREATE TABLE IF NOT EXISTS whatsapp_groups (
    jid TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_jid TEXT,
    participant_count INTEGER NOT NULL DEFAULT 0 CHECK (participant_count >= 0),
    agent_is_participant BOOLEAN NOT NULL DEFAULT FALSE,
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    last_synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER whatsapp_groups_set_updated_at
BEFORE UPDATE ON whatsapp_groups
FOR EACH ROW EXECUTE FUNCTION set_row_updated_at();

CREATE TABLE IF NOT EXISTS whatsapp_group_participants (
    group_jid TEXT NOT NULL REFERENCES whatsapp_groups(jid) ON DELETE CASCADE,
    participant_jid TEXT NOT NULL,
    display_name TEXT,
    is_admin BOOLEAN NOT NULL DEFAULT FALSE,
    is_super_admin BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (group_jid, participant_jid)
);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id UUID PRIMARY KEY,
    wa_message_id TEXT,
    remote_jid TEXT NOT NULL,
    participant_jid TEXT,
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    message_type TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'document', 'audio', 'video', 'sticker', 'location', 'contact', 'reaction', 'unknown')),
    text_body TEXT,
    media JSONB NOT NULL DEFAULT '{}'::JSONB,
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    status TEXT NOT NULL DEFAULT 'received'
        CHECK (status IN ('received', 'ignored', 'queued', 'processing', 'sent', 'delivered', 'read', 'retrying', 'failed', 'dead', 'dead_letter')),
    error TEXT,
    received_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    group_jid TEXT REFERENCES whatsapp_groups(jid) ON DELETE SET NULL,
    reply_to_message_id UUID REFERENCES whatsapp_messages(id) ON DELETE SET NULL,
    mentions TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    agent_mentioned BOOLEAN NOT NULL DEFAULT FALSE,
    processing_state TEXT NOT NULL DEFAULT 'pending'
        CHECK (processing_state IN ('pending', 'ignored', 'forward_queued', 'forwarded', 'responded', 'failed')),
    retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    queue_job_id UUID,
    idempotency_key TEXT,
    dedupe_key TEXT,
    media_path TEXT,
    UNIQUE (direction, remote_jid, wa_message_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_messages_dedupe_uidx
    ON whatsapp_messages (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_messages_idempotency_uidx
    ON whatsapp_messages (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS whatsapp_messages_chat_idx
    ON whatsapp_messages (remote_jid, created_at DESC);
CREATE INDEX IF NOT EXISTS whatsapp_messages_recovery_idx
    ON whatsapp_messages (status, updated_at)
    WHERE status IN ('queued', 'processing', 'retrying', 'failed');
CREATE INDEX IF NOT EXISTS whatsapp_messages_queue_job_idx
    ON whatsapp_messages (queue_job_id) WHERE queue_job_id IS NOT NULL;

CREATE TRIGGER whatsapp_messages_set_updated_at
BEFORE UPDATE ON whatsapp_messages
FOR EACH ROW EXECUTE FUNCTION set_row_updated_at();

CREATE TABLE IF NOT EXISTS message_delivery_events (
    id UUID PRIMARY KEY,
    message_id UUID NOT NULL REFERENCES whatsapp_messages(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'delivered', 'read', 'retrying', 'failed', 'dead', 'dead_letter')),
    wa_status_code INTEGER,
    error_code TEXT,
    error_message TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS message_delivery_events_message_idx
    ON message_delivery_events (message_id, occurred_at DESC);

-- PostgreSQL is the durable queue of record. Redis, when present, is only a
-- wake-up/coordination accelerator; every recoverable job lives in this table.
CREATE TABLE IF NOT EXISTS queue_jobs (
    id UUID PRIMARY KEY,
    queue_name TEXT NOT NULL,
    job_type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'available', 'locked', 'processing', 'completed', 'retrying', 'failed', 'dead', 'dead_letter', 'cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 6 CHECK (max_attempts > 0),
    available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_at TIMESTAMPTZ,
    locked_by TEXT,
    last_error TEXT,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    dedupe_key TEXT UNIQUE,
    priority SMALLINT NOT NULL DEFAULT 100,
    lock_expires_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    idempotency_key TEXT,
    correlation_id UUID,
    CHECK (attempts <= max_attempts OR status IN ('failed', 'dead', 'dead_letter'))
);

CREATE UNIQUE INDEX IF NOT EXISTS queue_jobs_idempotency_uidx
    ON queue_jobs (queue_name, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS queue_jobs_claim_idx
    ON queue_jobs (queue_name, priority, available_at, created_at)
    WHERE status IN ('pending', 'available', 'retrying');
CREATE INDEX IF NOT EXISTS queue_jobs_stale_lock_idx
    ON queue_jobs (lock_expires_at)
    WHERE status IN ('locked', 'processing');

CREATE TRIGGER queue_jobs_set_updated_at
BEFORE UPDATE ON queue_jobs
FOR EACH ROW EXECUTE FUNCTION set_row_updated_at();

ALTER TABLE whatsapp_messages
    ADD CONSTRAINT whatsapp_messages_queue_job_fk
    FOREIGN KEY (queue_job_id) REFERENCES queue_jobs(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS queue_job_attempts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id UUID NOT NULL REFERENCES queue_jobs(id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    worker_id TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    outcome TEXT CHECK (outcome IS NULL OR outcome IN ('completed', 'retry', 'failed', 'dead')),
    error_code TEXT,
    error_message TEXT,
    backoff_ms INTEGER CHECK (backoff_ms IS NULL OR backoff_ms >= 0),
    UNIQUE (job_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS integration_outbox (
    id UUID PRIMARY KEY,
    event_type TEXT NOT NULL,
    aggregate_type TEXT NOT NULL,
    aggregate_id UUID,
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivered', 'retrying', 'failed', 'dead')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 6 CHECK (max_attempts > 0),
    available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at TIMESTAMPTZ,
    response_status INTEGER,
    response_body_hash TEXT,
    last_error TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    correlation_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS integration_outbox_dispatch_idx
    ON integration_outbox (available_at, created_at)
    WHERE status IN ('pending', 'retrying');

CREATE TRIGGER integration_outbox_set_updated_at
BEFORE UPDATE ON integration_outbox
FOR EACH ROW EXECUTE FUNCTION set_row_updated_at();

CREATE TABLE IF NOT EXISTS openclaw_responses (
    id UUID PRIMARY KEY,
    correlation_id UUID NOT NULL,
    source_event_id UUID REFERENCES integration_outbox(id) ON DELETE SET NULL,
    response_message_id UUID REFERENCES whatsapp_messages(id) ON DELETE SET NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted', 'queued', 'sent', 'failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS openclaw_responses_correlation_idx ON openclaw_responses (correlation_id);

CREATE TRIGGER openclaw_responses_set_updated_at
BEFORE UPDATE ON openclaw_responses
FOR EACH ROW EXECUTE FUNCTION set_row_updated_at();

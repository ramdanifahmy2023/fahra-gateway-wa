-- OpenClaw WhatsApp Gateway — PostgreSQL 14+ schema snapshot
-- Canonical runtime upgrades use the ordered files in database/migrations/.
-- This standalone snapshot intentionally excludes seed data and secrets.

BEGIN;

-- Source: migrations/0001_core.sql
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

-- Source: migrations/0002_identity_auth.sql
CREATE TABLE IF NOT EXISTS admin_users (
    id UUID PRIMARY KEY,
    email TEXT NOT NULL CHECK (email = LOWER(BTRIM(email)) AND POSITION('@' IN email) > 1),
    password_hash TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'locked', 'disabled')),
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    force_password_change BOOLEAN NOT NULL DEFAULT TRUE,
    failed_login_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_attempts >= 0),
    locked_until TIMESTAMPTZ,
    last_login_at TIMESTAMPTZ,
    password_changed_at TIMESTAMPTZ,
    password_initialized_at TIMESTAMPTZ,
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((status = 'pending' AND password_hash IS NULL) OR password_hash IS NOT NULL),
    CHECK (NOT is_active OR status IN ('active', 'locked'))
);

CREATE UNIQUE INDEX IF NOT EXISTS admin_users_email_lower_uidx ON admin_users (LOWER(email));

CREATE TRIGGER admin_users_set_updated_at
BEFORE UPDATE ON admin_users
FOR EACH ROW EXECUTE FUNCTION set_row_updated_at();

CREATE TABLE IF NOT EXISTS admin_refresh_tokens (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    family_id UUID,
    token_hash TEXT NOT NULL CHECK (LENGTH(token_hash) >= 43),
    issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    revoke_reason TEXT,
    replaced_by UUID REFERENCES admin_refresh_tokens(id) ON DELETE SET NULL,
    created_ip_hash TEXT,
    user_agent_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (expires_at > issued_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS admin_refresh_tokens_hash_uidx ON admin_refresh_tokens (token_hash);
CREATE INDEX IF NOT EXISTS admin_refresh_tokens_family_idx ON admin_refresh_tokens (family_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS admin_refresh_tokens_active_idx
    ON admin_refresh_tokens (user_id, expires_at)
    WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS admin_login_attempts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    admin_user_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
    email_normalized TEXT NOT NULL,
    succeeded BOOLEAN NOT NULL,
    failure_code TEXT,
    ip_hash TEXT,
    user_agent_hash TEXT,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS admin_login_attempts_email_idx
    ON admin_login_attempts (email_normalized, occurred_at DESC);

CREATE TABLE IF NOT EXISTS internal_api_keys (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    key_prefix TEXT NOT NULL CHECK (LENGTH(key_prefix) BETWEEN 4 AND 32),
    key_hash TEXT NOT NULL CHECK (LENGTH(key_hash) >= 43),
    scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
    expires_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS internal_api_keys_name_lower_uidx ON internal_api_keys (LOWER(name));
CREATE UNIQUE INDEX IF NOT EXISTS internal_api_keys_hash_uidx ON internal_api_keys (key_hash);

CREATE TRIGGER internal_api_keys_set_updated_at
BEFORE UPDATE ON internal_api_keys
FOR EACH ROW EXECUTE FUNCTION set_row_updated_at();

CREATE TABLE IF NOT EXISTS agent_profile (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    singleton_key BOOLEAN NOT NULL DEFAULT TRUE UNIQUE CHECK (singleton_key),
    name TEXT NOT NULL,
    persona TEXT NOT NULL DEFAULT '',
    jobdesk TEXT NOT NULL DEFAULT '',
    system_instruction TEXT NOT NULL DEFAULT '',
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER agent_profile_set_updated_at
BEFORE UPDATE ON agent_profile
FOR EACH ROW EXECUTE FUNCTION set_row_updated_at();

CREATE TABLE IF NOT EXISTS knowledge_items (
    id UUID PRIMARY KEY,
    title TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Umum',
    content TEXT NOT NULL,
    tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS knowledge_items_category_idx ON knowledge_items (category, updated_at DESC);
CREATE INDEX IF NOT EXISTS knowledge_items_enabled_idx ON knowledge_items (enabled, updated_at DESC);

CREATE TRIGGER knowledge_items_set_updated_at
BEFORE UPDATE ON knowledge_items
FOR EACH ROW EXECUTE FUNCTION set_row_updated_at();

CREATE TABLE IF NOT EXISTS agent_tools (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    endpoint TEXT NOT NULL,
    method TEXT NOT NULL CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
    headers JSONB NOT NULL DEFAULT '{}'::JSONB,
    input_schema JSONB NOT NULL DEFAULT '{}'::JSONB,
    config_encrypted TEXT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_tools_name_lower_uidx ON agent_tools (LOWER(name));

CREATE TRIGGER agent_tools_set_updated_at
BEFORE UPDATE ON agent_tools
FOR EACH ROW EXECUTE FUNCTION set_row_updated_at();

CREATE TABLE IF NOT EXISTS agent_jobs (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    instruction TEXT NOT NULL,
    schedule TEXT,
    timezone TEXT NOT NULL DEFAULT 'Asia/Jakarta',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    last_run_at TIMESTAMPTZ,
    next_run_at TIMESTAMPTZ,
    last_status TEXT CHECK (last_status IS NULL OR last_status IN ('queued', 'running', 'succeeded', 'failed')),
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_jobs_name_lower_uidx ON agent_jobs (LOWER(name));
CREATE INDEX IF NOT EXISTS agent_jobs_due_idx ON agent_jobs (next_run_at) WHERE enabled AND next_run_at IS NOT NULL;

CREATE TRIGGER agent_jobs_set_updated_at
BEFORE UPDATE ON agent_jobs
FOR EACH ROW EXECUTE FUNCTION set_row_updated_at();

CREATE TABLE IF NOT EXISTS ai_providers (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    provider_type TEXT NOT NULL DEFAULT 'openai-compatible'
        CHECK (provider_type IN ('9router', 'openrouter', 'openai-compatible')),
    base_url TEXT NOT NULL,
    api_key_encrypted TEXT,
    model TEXT NOT NULL,
    temperature NUMERIC(3,2) NOT NULL DEFAULT 0.70 CHECK (temperature BETWEEN 0 AND 2),
    max_tokens INTEGER NOT NULL DEFAULT 4096 CHECK (max_tokens BETWEEN 1 AND 1000000),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    last_validated_at TIMESTAMPTZ,
    validation_status TEXT CHECK (validation_status IS NULL OR validation_status IN ('valid', 'invalid', 'unreachable')),
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_providers_name_lower_uidx ON ai_providers (LOWER(name));
CREATE UNIQUE INDEX IF NOT EXISTS ai_providers_one_default_uidx ON ai_providers (is_default) WHERE is_default;

CREATE TRIGGER ai_providers_set_updated_at
BEFORE UPDATE ON ai_providers
FOR EACH ROW EXECUTE FUNCTION set_row_updated_at();

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value JSONB,
    value_encrypted TEXT,
    is_secret BOOLEAN NOT NULL DEFAULT FALSE,
    description TEXT,
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        (is_secret AND value_encrypted IS NOT NULL AND value IS NULL)
        OR (NOT is_secret AND value_encrypted IS NULL AND value IS NOT NULL)
    )
);

CREATE TRIGGER app_settings_set_updated_at
BEFORE UPDATE ON app_settings
FOR EACH ROW EXECUTE FUNCTION set_row_updated_at();

-- Source: migrations/0003_whatsapp_queue.sql
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

-- Source: migrations/0004_operations.sql
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

-- Source: migrations/0005_contact_memory.sql
CREATE TABLE IF NOT EXISTS contact_memory (
    remote_jid TEXT PRIMARY KEY,
    display_name TEXT,
    candidate_name TEXT,
    recruitment_stage TEXT NOT NULL DEFAULT 'new'
        CHECK (recruitment_stage IN ('new', 'asked_job', 'form_link_sent', 'form_submitted', 'under_review')),
    form_submitted BOOLEAN NOT NULL DEFAULT FALSE,
    last_summary TEXT NOT NULL DEFAULT '',
    last_message_at TIMESTAMPTZ,
    revision BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS contact_memory_last_message_idx
    ON contact_memory (last_message_at DESC);

CREATE TRIGGER contact_memory_set_updated_at
BEFORE UPDATE ON contact_memory
FOR EACH ROW EXECUTE FUNCTION set_row_updated_at();

-- Source: migrations/0006_manual_mode.sql
ALTER TABLE contact_memory
  ADD COLUMN IF NOT EXISTS ai_paused_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ai_pause_reason TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS handled_by TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS needs_admin_reply BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS contact_memory_needs_admin_reply_idx
  ON contact_memory (needs_admin_reply, last_message_at DESC);

CREATE INDEX IF NOT EXISTS contact_memory_ai_paused_until_idx
  ON contact_memory (ai_paused_until);

-- Source: migrations/0007_crm_lite.sql
ALTER TABLE contact_memory
  ADD COLUMN IF NOT EXISTS crm_status TEXT NOT NULL DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS assignee_user_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sla_due_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS consent_status TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS do_not_contact BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS do_not_contact_reason TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS do_not_contact_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS do_not_contact_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ai_mode_override TEXT NOT NULL DEFAULT 'inherit';

ALTER TABLE contact_memory
  DROP CONSTRAINT IF EXISTS contact_memory_crm_status_check,
  ADD CONSTRAINT contact_memory_crm_status_check CHECK (crm_status IN ('new', 'open', 'waiting_human', 'waiting_customer', 'resolved', 'closed')),
  DROP CONSTRAINT IF EXISTS contact_memory_priority_check,
  ADD CONSTRAINT contact_memory_priority_check CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  DROP CONSTRAINT IF EXISTS contact_memory_consent_status_check,
  ADD CONSTRAINT contact_memory_consent_status_check CHECK (consent_status IN ('unknown', 'granted', 'denied', 'revoked')),
  DROP CONSTRAINT IF EXISTS contact_memory_ai_mode_override_check,
  ADD CONSTRAINT contact_memory_ai_mode_override_check CHECK (ai_mode_override IN ('inherit', 'off', 'suggest_only', 'assist')),
  DROP CONSTRAINT IF EXISTS contact_memory_do_not_contact_reason_check,
  ADD CONSTRAINT contact_memory_do_not_contact_reason_check CHECK (
    (do_not_contact = FALSE AND do_not_contact_reason = '' AND do_not_contact_at IS NULL AND do_not_contact_by IS NULL)
    OR (do_not_contact = TRUE AND do_not_contact_reason <> '' AND do_not_contact_at IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS contact_memory_crm_status_idx
  ON contact_memory (crm_status, priority, COALESCE(sla_due_at, last_message_at, updated_at) DESC);
CREATE INDEX IF NOT EXISTS contact_memory_assignee_idx
  ON contact_memory (assignee_user_id, crm_status) WHERE assignee_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS contact_memory_do_not_contact_idx
  ON contact_memory (do_not_contact, updated_at DESC) WHERE do_not_contact;

CREATE TABLE IF NOT EXISTS crm_config_state (
  singleton_key BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton_key),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER crm_config_state_set_updated_at
BEFORE UPDATE ON crm_config_state
FOR EACH ROW EXECUTE FUNCTION set_row_updated_at();

INSERT INTO crm_config_state(singleton_key) VALUES(TRUE) ON CONFLICT(singleton_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS crm_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#8E8E93',
  description TEXT NOT NULL DEFAULT '',
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (name = BTRIM(name) AND LENGTH(name) BETWEEN 1 AND 40),
  CHECK (color ~ '^#[0-9A-Fa-f]{6}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS crm_tags_name_lower_uidx ON crm_tags (LOWER(name));
CREATE TRIGGER crm_tags_set_updated_at
BEFORE UPDATE ON crm_tags
FOR EACH ROW EXECUTE FUNCTION set_row_updated_at();

CREATE TABLE IF NOT EXISTS crm_contact_tags (
  remote_jid TEXT NOT NULL REFERENCES contact_memory(remote_jid) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES crm_tags(id) ON DELETE CASCADE,
  created_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (remote_jid, tag_id)
);

CREATE INDEX IF NOT EXISTS crm_contact_tags_tag_idx ON crm_contact_tags (tag_id, created_at DESC);

CREATE TABLE IF NOT EXISTS crm_internal_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  remote_jid TEXT NOT NULL REFERENCES contact_memory(remote_jid) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (body = BTRIM(body) AND LENGTH(body) BETWEEN 1 AND 5000),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  deleted_at TIMESTAMPTZ,
  deleted_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS crm_internal_notes_contact_idx
  ON crm_internal_notes (remote_jid, created_at DESC) WHERE deleted_at IS NULL;
CREATE TRIGGER crm_internal_notes_set_updated_at
BEFORE UPDATE ON crm_internal_notes
FOR EACH ROW EXECUTE FUNCTION set_row_updated_at();

INSERT INTO app_settings(key,value,is_secret,description)
VALUES
  ('crm.enabled', 'false'::jsonb, false, 'CRM Lite master switch; false by default for Phase 3A'),
  ('crm.ai.enabled', 'false'::jsonb, false, 'CRM AI master switch; forced false in Phase 3A'),
  ('crm.ai.mode', '"off"'::jsonb, false, 'CRM AI mode; off only in Phase 3A'),
  ('crm.default_sla_hours', '24'::jsonb, false, 'Default CRM SLA hours for future assignment helpers'),
  ('crm.default_status', '"open"'::jsonb, false, 'Default CRM pipeline status'),
  ('crm.default_priority', '"normal"'::jsonb, false, 'Default CRM priority'),
  ('crm.default_ai_override', '"inherit"'::jsonb, false, 'Default per-contact AI override'),
  ('crm.notes_required_on_close', 'false'::jsonb, false, 'Require an internal note before closing a contact'),
  ('crm.human_override_required', 'true'::jsonb, false, 'Keep human takeover controls visible'),
  ('crm.allow_auto_reply', 'false'::jsonb, false, 'CRM auto-reply disabled by default')
ON CONFLICT(key) DO NOTHING;

-- Source: migrations/0008_crm_consent_source.sql
ALTER TABLE contact_memory
  ADD COLUMN IF NOT EXISTS consent_source TEXT NOT NULL DEFAULT '';

ALTER TABLE contact_memory
  DROP CONSTRAINT IF EXISTS contact_memory_consent_source_check,
  ADD CONSTRAINT contact_memory_consent_source_check
    CHECK (LENGTH(consent_source) <= 200);

COMMIT;

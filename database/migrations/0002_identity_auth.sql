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

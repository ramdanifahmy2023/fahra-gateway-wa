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

ALTER TABLE contact_memory
  ADD COLUMN IF NOT EXISTS ai_paused_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ai_pause_reason TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS handled_by TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS needs_admin_reply BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS contact_memory_needs_admin_reply_idx
  ON contact_memory (needs_admin_reply, last_message_at DESC);

CREATE INDEX IF NOT EXISTS contact_memory_ai_paused_until_idx
  ON contact_memory (ai_paused_until);

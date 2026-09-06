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

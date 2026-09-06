ALTER TABLE contact_memory
  ADD COLUMN IF NOT EXISTS consent_source TEXT NOT NULL DEFAULT '';

ALTER TABLE contact_memory
  DROP CONSTRAINT IF EXISTS contact_memory_consent_source_check,
  ADD CONSTRAINT contact_memory_consent_source_check
    CHECK (LENGTH(consent_source) <= 200);

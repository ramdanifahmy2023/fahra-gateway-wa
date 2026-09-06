-- Idempotent, non-secret bootstrap data.
--
-- SECURITY: this file deliberately does not contain the bootstrap password or
-- any password hash. After migrations and this seed complete, install.mjs must
-- Argon2id-hash BOOTSTRAP_ADMIN_PASSWORD and update the pending admin using a
-- parameterized query. Until then the pending account cannot authenticate.

BEGIN;

INSERT INTO admin_users (
    id,
    email,
    password_hash,
    status,
    is_active,
    force_password_change
)
SELECT
    '00000000-0000-4000-8000-000000000001'::UUID,
    'ramdanifahmy2023@gmail.com',
    NULL,
    'pending',
    FALSE,
    TRUE
WHERE NOT EXISTS (
    SELECT 1 FROM admin_users WHERE LOWER(email) = 'ramdanifahmy2023@gmail.com'
);

INSERT INTO agent_profile (
    id,
    singleton_key,
    name,
    persona,
    jobdesk,
    system_instruction
)
VALUES (
    '00000000-0000-4000-8000-000000000010'::UUID,
    TRUE,
    'OpenClaw Agent',
    '',
    '',
    ''
)
ON CONFLICT (singleton_key) DO NOTHING;

INSERT INTO whatsapp_connection (id, singleton_key, status)
VALUES ('00000000-0000-4000-8000-000000000020'::UUID, TRUE, 'logged_out')
ON CONFLICT (singleton_key) DO NOTHING;

INSERT INTO app_settings (key, value, is_secret, description)
VALUES
    (
        'whatsapp.mention_only',
        'true'::JSONB,
        FALSE,
        'Hanya teruskan pesan grup yang menyebut JID agent secara eksplisit.'
    ),
    (
        'queue.max_attempts',
        '6'::JSONB,
        FALSE,
        'Jumlah percobaan maksimum sebelum job menjadi dead-letter.'
    ),
    (
        'queue.base_backoff_ms',
        '1000'::JSONB,
        FALSE,
        'Backoff eksponensial dasar dalam milidetik.'
    ),
    (
        'locale.timezone',
        '"Asia/Jakarta"'::JSONB,
        FALSE,
        'Zona waktu default dashboard dan scheduler.'
    )
ON CONFLICT (key) DO NOTHING;

COMMIT;

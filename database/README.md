# Database

PostgreSQL 14+ adalah durable source of truth. Redis tidak menyimpan satu-satunya salinan job atau message.

## Files

- `schema.sql` — snapshot standalone dari seluruh DDL, tanpa seed/secret.
- `migrations/0001_core.sql` — migration registry helper, heartbeat runtime.
- `migrations/0002_identity_auth.sql` — admin, token, agent identity, provider/settings.
- `migrations/0003_whatsapp_queue.sql` — session ciphertext, groups, messages, queue, outbox.
- `migrations/0004_operations.sql` — audit/log, upload, dan backup metadata.
- `migrations/0005_contact_memory.sql` — durable contact memory.
- `migrations/0006_manual_mode.sql` — human takeover/manual-mode fields.
- `migrations/0007_crm_lite.sql` — CRM Lite human-first, tags, notes, DNC, dan safe-off settings.
- `seed.sql` — bootstrap non-secret dan default aman.

Runtime installer menjalankan ordered migrations, bukan `schema.sql`. Jangan mengubah migration yang pernah dirilis; buat file bernomor baru.

## Migration protocol

1. Acquire PostgreSQL advisory lock khusus aplikasi.
2. Buat/verifikasi `schema_migrations`.
3. Hitung SHA-256 dari bytes migration.
4. Jika filename sudah ada, checksum harus sama persis.
5. Jika belum, jalankan file dalam transaction dan catat filename/checksum.
6. Berhenti pada error; jangan menandai migration applied.

Runner membungkus satu file migration dan insert registry dalam transaksi yang sama. File migration sengaja tidak memuat `BEGIN/COMMIT`. Session advisory lock tetap dimiliki sampai seluruh batch selesai.

## Bootstrap admin

`seed.sql` membuat admin pending tanpa `password_hash`. Installer wajib:

1. membaca bootstrap password dari secure input/requirement;
2. menghasilkan Argon2id hash di memory;
3. menjalankan parameterized update yang hanya menyasar akun pending;
4. menyetel `status='active'`, `is_active=true`, `force_password_change=true`, dan timestamp initialized;
5. menghapus buffer/input sebisa runtime dan tidak mencatatnya.

SQL seed tidak boleh diberi literal password ataupun precomputed hash publik.

## Entity groups

| Domain     | Tables                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------- |
| Auth       | `admin_users`, `admin_refresh_tokens`, `admin_login_attempts`, `internal_api_keys`                                  |
| Identity   | `agent_profile`, `knowledge_items`, `agent_tools`, `agent_jobs`, `ai_providers`, `app_settings`                     |
| CRM        | `contact_memory`, `crm_config_state`, `crm_tags`, `crm_contact_tags`, `crm_internal_notes`                          |
| WhatsApp   | `whatsapp_connection`, `whatsapp_auth_state`, `whatsapp_groups`, `whatsapp_group_participants`, `whatsapp_messages` |
| Durability | `queue_jobs`, `queue_job_attempts`, `integration_outbox`, `openclaw_responses`, `message_delivery_events`           |
| Operations | `audit_logs`, `operational_logs`, `backup_records`, `uploads`, `runtime_instances`                                  |

Agent identity tidak mempunyai foreign key ke session/account WhatsApp. Relogin atau penggantian nomor hanya mengganti `whatsapp_connection`/`whatsapp_auth_state` dan tidak menghapus identity tables.

## Auth state encryption

`whatsapp_auth_state.value_encrypted` menyimpan satu binary envelope versioned. Envelope memuat nonce, tag, ciphertext, key version, dan AAD metadata; master key berada di environment. Primary key `(scope,key)` cocok dengan credential dan Signal key namespaces Baileys.

## Dedupe dan idempotency

- Event Baileys: unique `(direction, remote_jid, wa_message_id)`.
- Normalisasi ekstra: unique partial `whatsapp_messages.dedupe_key`.
- Request outbound: unique partial `whatsapp_messages.idempotency_key`.
- Job: `queue_jobs.dedupe_key` dan `(queue_name,idempotency_key)`.
- Bridge: `integration_outbox.idempotency_key` dan `openclaw_responses.idempotency_key`.

Pada unique conflict, service membaca record existing dan mengembalikan hasil konsisten; tidak membuat send kedua.

## Queue recovery

Worker mengklaim job dengan `FOR UPDATE SKIP LOCKED`, mengisi `locked_by`, `locked_at`, dan `lock_expires_at`, lalu mencatat attempt. Network I/O tidak dilakukan sambil menahan transaction. Recovery scan mengembalikan lease kedaluwarsa ke retry dengan backoff. `status='dead_letter'` adalah nama terminal canonical (`dead` tetap diterima untuk kompatibilitas worker); requeue dilakukan melalui service/API agar audit dan idempotency terjaga.

Formula konseptual retry:

```text
delay = min(max_backoff, base_backoff × 2^(attempt-1)) + random_jitter
```

## Backup consistency

Backup logical fallback memakai transaction `REPEATABLE READ` tanpa DML dan table lock `SHARE` sehingga snapshot database serta file tetap konsisten. Session sudah ciphertext; artifact keseluruhan tetap dienkripsi lagi. File `uploads` hanya disertakan bila message/job recoverable mereferensikannya. Restore mewajibkan set migration exact dan tidak menjalankan command lifecycle WhatsApp lama yang tertinggal.

## Retention

Retention dijalankan sebagai audited queue job, bukan cascade delete ad-hoc. Hapus delivery/log/payload hanya setelah kebutuhan recovery dan audit terpenuhi. Session, identity, active jobs, migration records, dan current refresh/security state tidak termasuk purge umum.

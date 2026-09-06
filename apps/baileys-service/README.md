# Baileys Service

Service transport WhatsApp mandiri untuk OpenClaw WhatsApp Gateway. Modul ini tidak memiliki prompt, provider AI, reasoning, knowledge retrieval, atau logic agent. Semua pesan inbound yang memenuhi aturan routing dipersistensikan dahulu, lalu diteruskan secara durable ke Gateway API lokal.

## Tanggung jawab

- koneksi WhatsApp Web melalui `@whiskeysockets/baileys`;
- QR pairing sementara di `DATA_DIR/whatsapp/qr.json` dan `qr.png` (mode file `0600`, TTL bawaan 60 detik);
- credential dan seluruh Signal key di PostgreSQL, terenkripsi AES-256-GCM dengan AAD per-record;
- reconnect exponential backoff dengan jitter;
- pesan inbound (`notify` dan reconnect `append`) masuk encrypted write-ahead spool sebelum transaksi database, dengan dedupe idempotent dan group mention detection dari `contextInfo.mentionedJid`;
- worker PostgreSQL `FOR UPDATE SKIP LOCKED` untuk outbound/control;
- transactional integration outbox untuk event OpenClaw;
- retry, lease recovery, dead-letter state, delivery receipt, status/heartbeat, dan structured logging.

DM diproses langsung. Pesan grup tanpa exact mention tetap disimpan idempotent sebagai `status=ignored`/`processing_state=ignored`, tetapi tidak pernah membuat outbox OpenClaw. Hanya pesan grup dengan JID account agent tepat di `mentionedJid` yang diteruskan; pencarian substring seperti `@nama` tidak digunakan.

## Environment wajib

| Variable | Keterangan |
| --- | --- |
| `DATABASE_URL` | PostgreSQL yang sudah tersedia |
| `INTERNAL_API_KEY` | Minimal 32 byte; dikirim pada `x-internal-api-key` |
| `GATEWAY_INTERNAL_URL` | Wajib loopback, bawaan `http://127.0.0.1:3100` |
| `WHATSAPP_SESSION_ENCRYPTION_KEY` | Tepat 32 byte, canonical base64 atau 64 hex |
| `DATA_DIR` | Direktori di dalam workspace; berisi `whatsapp`, `uploads`, `logs` |

Tuning mengikuti environment bersama project: `DATABASE_SSL`, `DATABASE_POOL_MAX`, `QUEUE_POLL_MS`, `QUEUE_LEASE_SECONDS`, `WHATSAPP_QR_TTL_SECONDS`, `WHATSAPP_MAX_RECONNECT_DELAY_MS`, dan `UPLOAD_MAX_BYTES`. Nama alternatif lama berbasis millisecond tetap diterima bila eksplisit.

Override nama tabel tersedia melalui `WHATSAPP_AUTH_TABLE`, `WHATSAPP_MESSAGES_TABLE`, `WHATSAPP_GROUPS_TABLE`, `WHATSAPP_CONNECTION_TABLE`, `WHATSAPP_CONNECTION_EVENTS_TABLE`, `QUEUE_JOBS_TABLE`, dan `INTEGRATION_OUTBOX_TABLE`. Identifier hanya menerima nama PostgreSQL aman (`table` atau `schema.table`).

## Kontrak database

Service memvalidasi kontrak sebelum membuka socket. Migration bersama harus menyediakan:

- `whatsapp_auth_state(scope,key,value_encrypted,updated_at)`, primary key `(scope,key)`;
- `whatsapp_messages`: kolom core message termasuk `attempts` dan `queue_job_id`, unique `(direction,remote_jid,wa_message_id)` dan unique `dedupe_key` bila tidak null;
- `queue_jobs`: queue/status/attempt/lease/priority fields pada migration project;
- `queue_job_attempts` dan `message_delivery_events`;
- `integration_outbox`: event/status/attempt/idempotency/correlation fields;
- `whatsapp_groups(jid,name,owner_jid,participant_count,agent_is_participant,metadata,last_synced_at,created_at,updated_at)`;
- `whatsapp_connection` dan `whatsapp_connection_events` untuk lifecycle/reconnect dashboard;
- `operational_logs` untuk lifecycle/retry penting (best effort; pino tetap log utama).

Nama tabel dapat berbeda melalui environment override, tetapi nama kolom adalah kontrak versioned dan tidak ditebak diam-diam.

## Kontrak queue

Outbound memakai `queue_name=whatsapp-outbound`:

- `send-text`: `{ "messageId":"<uuid>", "remoteJid":"...", "text":"..." }`
- `send-image`: `{ "messageId":"<uuid>", "remoteJid":"...", "filePath":"relative/to/uploads", "mimeType":"image/png", "caption":"..." }`
- `send-document`: `{ "messageId":"<uuid>", "remoteJid":"...", "filePath":"...", "mimeType":"application/pdf", "fileName":"dokumen.pdf", "caption":"..." }`
- `send-video`: `{ "messageId":"<uuid>", "remoteJid":"...", "filePath":"...", "mimeType":"video/mp4", "caption":"..." }`
- `send-audio`: `{ "messageId":"<uuid>", "remoteJid":"...", "filePath":"...", "mimeType":"audio/mpeg", "voiceNote":false }`

Voice note memakai job `send-audio` yang sama dengan `voiceNote:true`, tetapi hanya menerima OGG Opus (`audio/ogg`). Audio biasa menerima MP3 atau OGG Opus. Caption audio sengaja ditolak karena kontraknya tidak andal di Baileys/WhatsApp.

Media dapat memakai `base64` sebagai pengganti `filePath`. File path selalu dibatasi ke `DATA_DIR/uploads`, mengikuti realpath, menolak symlink escape, dan dibatasi ukurannya. Setiap job memakai deterministic WhatsApp message ID agar recovery setelah crash tidak menghasilkan ID baru.

Control memakai `queue_name=whatsapp-control` dan `job_type`: `connect`, `disconnect`, `restart`, `logout`, atau `sync-groups`.

## Inbound OpenClaw

Inbound disimpan dan integration outbox dibuat dalam transaksi yang sama. Worker mengirim:

```http
POST /internal/openclaw/event
x-internal-api-key: <secret>
idempotency-key: <eventId>
```

Body mengikuti kontrak `{eventId,waMessageId,remoteJid,participantJid?,isGroup,text,quotedMessageId?,timestamp,payload?}`. HTTP `409` dianggap idempotent duplicate yang sudah diterima. HTTP 408/425/429/5xx dan network error diretry; penolakan 4xx lain masuk dead state.

## Health lokal

- `GET http://127.0.0.1:3101/health/live`
- `GET http://127.0.0.1:3101/health/ready`
- `GET http://127.0.0.1:3101/status` dengan header `x-internal-api-key`

Health server hanya boleh bind ke loopback. Ketiga route tersebut hanya menerima `GET`; method lain mengembalikan `405`. Liveness/readiness tetap publik di loopback untuk probe lokal, sedangkan snapshot `/status` membutuhkan internal API key. Readiness mensyaratkan PostgreSQL, tetapi status pairing/disconnected dilaporkan terpisah agar supervisor tidak restart-loop ketika menunggu QR.

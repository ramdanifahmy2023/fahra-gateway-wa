# Kontrak API

Gateway API hanya mendengarkan alamat loopback. Dashboard mengakses route admin melalui BFF same-origin yang memiliki allowlist; route `/internal/*` tidak pernah diteruskan ke Cloudflare Tunnel.

## Autentikasi

| Ruang API | Autentikasi | Catatan |
|---|---|---|
| `/health/live`, `/health/ready` | Tidak ada | Respons minimal untuk process supervisor; tidak memuat detail dependency |
| `/api/v1/auth/login`, `/refresh`, `/logout` | Credential atau refresh token di body | Dashboard menyimpan token dalam cookie HttpOnly, SameSite=Strict |
| `/api/v1/*` lainnya | `Authorization: Bearer <access-token>` | Sebelum password awal diganti, hanya route auth yang diizinkan |
| `/internal/*` | `X-Internal-API-Key: <INTERNAL_API_KEY>` | Hanya loopback/private workspace; tidak diekspos BFF dashboard |

Semua payload JSON memakai `Content-Type: application/json`. Error mempunyai bentuk stabil:

```json
{
  "error": {
    "code": "IDEMPOTENCY_KEY_REQUIRED",
    "message": "Header Idempotency-Key wajib diisi untuk pengiriman pesan",
    "details": null
  }
}
```

Setiap respons menyertakan header `X-Request-Id` UUID yang dibuat Gateway untuk korelasi log.

## API internal OpenClaw

### `POST /internal/openclaw/event`

Menerima event inbound yang sudah lolos exact-mention detection dari Baileys. Deduplikasi dilakukan melalui `eventId` dan identitas pesan WhatsApp.

```json
{
  "eventId": "wa-event-stabil",
  "waMessageId": "ABCD1234",
  "remoteJid": "120363000000000000@g.us",
  "participantJid": "628123456789@s.whatsapp.net",
  "isGroup": true,
  "text": "@agent tolong rangkum",
  "quotedMessageId": null,
  "timestamp": "2026-08-09T10:00:00.000Z",
  "payload": {}
}
```

Respons `202` mengembalikan `messageId`, `queueJobId`, dan `status: "queued"`. Pemrosesan OpenClaw berlangsung dari antrean PostgreSQL dan kegagalan terminal dapat direqueue dari dashboard.

### `POST /internal/messages/send`

Header `Idempotency-Key` wajib berisi 8–128 karakter dari himpunan `A-Z`, `a-z`, angka, titik, garis bawah, titik dua, atau tanda hubung. OpenClaw harus memakai nilai yang sama saat mengulang request logis yang sama.

Pesan teks:

```json
{
  "to": "628123456789",
  "type": "text",
  "text": "Jawaban dari OpenClaw",
  "replyTo": "ABCD1234"
}
```

Pesan media menggunakan `uploadId` yang dibuat terlebih dahulu melalui route upload admin:

```json
{
  "to": "120363000000000000@g.us",
  "type": "document",
  "uploadId": "00000000-0000-4000-8000-000000000000",
  "caption": "Dokumen hasil",
  "fileName": "hasil.pdf"
}
```

Tipe media outbound yang didukung:

- `image`: JPEG, PNG, atau WebP; caption opsional.
- `document`: format dokumen pada allowlist upload; caption dan `fileName` opsional.
- `video`: MP4 dengan signature `ftyp`; caption opsional.
- `audio`: MP3 atau OGG Opus tanpa caption. Tambahkan `"voiceNote": true` untuk push-to-talk; voice note wajib OGG Opus.

Contoh voice note:

```json
{
  "to": "628123456789",
  "type": "audio",
  "uploadId": "00000000-0000-4000-8000-000000000000",
  "voiceNote": true
}
```

Tujuan menerima nomor E.164, JID PN (`@s.whatsapp.net`), JID LID (`@lid`), atau JID grup (`@g.us`). Domain JID lain ditolak. Respons `202` hanya berarti command sudah durable, bukan telah terkirim ke WhatsApp.

Untuk seluruh pesan media, OpenClaw lebih dulu mengunggah satu file melalui `POST /internal/uploads` sebagai multipart field `file`. Route loopback-only ini memakai API key internal, batas `UPLOAD_MAX_BYTES`, allowlist MIME + signature, nama file tersanitasi, hash SHA-256, dan permission owner-only. Nilai `data.id` dari respons dipakai sebagai `uploadId`; route ini tidak diteruskan proxy dashboard atau tunnel.

### `GET /internal/agent/context`

Mengembalikan snapshot profil, knowledge aktif, tool aktif beserta konfigurasi rahasianya, job aktif dan timezone, satu AI provider aktif, serta settings operasional non-secret terpilih beserta revision. Endpoint ini sensitif dan hanya boleh dibaca OpenClaw melalui API key internal.

### `GET /internal/agent/brief`

Mengembalikan hanya profil agent dan knowledge aktif. Bridge WhatsApp memakai endpoint ini untuk membangun konteks balasan; endpoint tidak mengirim provider API key, tool secret, job, atau settings.

## Bridge Gateway ke OpenClaw

Gateway worker membaca snapshot `GET /internal/agent/brief`, lalu mengirim `POST` OpenAI-compatible ke `OPENCLAW_WEBHOOK_URL`, yang secara default adalah:

```text
http://127.0.0.1:18789/v1/chat/completions
```

URL harus memakai HTTP loopback dan path tepat `/v1/chat/completions`. Request memakai bearer token Gateway, agent `wa-hrd`, session stabil per JID, profil + knowledge aktif sebagai system context, request ID, dan idempotency key stabil. Redirect tidak diikuti dan respons JSON dibatasi ukurannya. Jawaban `choices[0].message.content` dibuat menjadi command WhatsApp dengan idempotency key turunan dari event.

## Route admin

| Area | Route utama |
|---|---|
| Auth | `POST /api/v1/auth/login`, `/refresh`, `/logout`, `/change-password`; `GET /me` |
| Overview | `GET /api/v1/dashboard/overview`, `/api/v1/health` |
| WhatsApp | `GET /api/v1/whatsapp/status`, `/qr`; `POST /actions` |
| Pesan | `GET /api/v1/messages`, `/:id`; `POST /messages`, `/:id/retry`, `/uploads` |
| Grup | `GET /api/v1/groups`; `POST /api/v1/groups/sync` |
| Agent | `GET|PUT /api/v1/agent/profile` |
| Knowledge | `GET|POST /api/v1/knowledge`; `GET|PUT|DELETE /:id` |
| Tools | `GET|POST /api/v1/tools`; `PUT|DELETE /:id` |
| Jobs | `GET|POST /api/v1/jobs`; `PUT|DELETE /:id`; `POST /:id/run` |
| Provider | `GET|POST /api/v1/ai-providers`; `PUT|DELETE /:id`; `POST /:id/test` |
| Operasi | `GET /api/v1/logs`, `/audit-logs`, `/backups`, `/settings` |
| Backup | `POST /api/v1/backups`, `GET /:id/download`, `POST /:id/restore` |

`POST /api/v1/messages` dan alias `/messages/send` juga mewajibkan `Idempotency-Key`. Upload memakai multipart field file tunggal dengan batas `UPLOAD_MAX_BYTES`. Resource yang mendukung optimistic concurrency menerima field `revision` dan mengembalikan `409 REVISION_CONFLICT` jika data sudah berubah.

## Health

| Endpoint | Tujuan |
|---|---|
| `GET /health/live` | Proses API hidup |
| `GET /health/ready` | Database, checksum migration, dan kontrak schema siap |
| `GET /api/v1/health` | Detail integrasi untuk admin terautentikasi |
| `GET /internal/health` | Detail integrasi untuk caller internal |

Gunakan `npm run doctor` untuk diagnosis deployment lintas proses; endpoint health bukan pengganti doctor.

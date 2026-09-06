# Product Requirements Document

## OpenClaw WhatsApp Gateway

**Status:** Final untuk implementasi  
**Versi dokumen:** 1.0  
**Model produk:** private, single-tenant, satu admin, satu agent OpenClaw, satu nomor WhatsApp aktif

## 1. Ringkasan

OpenClaw WhatsApp Gateway adalah connector WhatsApp privat berbasis `@whiskeysockets/baileys` yang berjalan sepenuhnya dari direktori kerja agent OpenClaw. Produk menggantikan connector WhatsApp bawaan yang tidak stabil, menyediakan antrean persisten, retry, monitoring, dan penyimpanan identitas agent yang tidak bergantung pada nomor atau session WhatsApp.

Gateway bukan AI engine. OpenClaw tetap memegang reasoning, workflow, knowledge execution, dan tool execution. Gateway hanya menangani transport WhatsApp, state koneksi, routing, persistensi, serta observability.

## 2. Sasaran

- Menjaga koneksi WhatsApp dan session Baileys tetap dapat dipulihkan setelah restart.
- Memastikan pesan yang telah diterima atau diterima untuk dikirim tidak hilang ketika WhatsApp, Redis, OpenClaw, atau proses aplikasi terputus.
- Meneruskan pesan grup hanya saat metadata WhatsApp berisi mention tepat terhadap JID agent.
- Menyimpan profil, knowledge, tools, jobs, dan konfigurasi provider secara terpisah dari session WhatsApp.
- Beroperasi tanpa root, sudo, apt, Docker, systemd, atau perubahan `/etc`.
- Menyediakan dashboard monitoring Bahasa Indonesia melalui Cloudflare Tunnel outbound.
- Menyediakan instalasi, doctor, start/stop, backup, dan restore dari direktori proyek.

## 3. Di luar cakupan

- CRM, pipeline penjualan, billing, campaign, atau broadcast marketing.
- SaaS, organisasi, multi-tenant, multi-admin, dan multi-agent.
- AI inference atau prompt reasoning di Gateway.
- Provisioning VPS, database server, Redis server, DNS, atau akun Cloudflare.
- Membuka port publik/inbound atau memasang service global.
- Menjamin kompatibilitas dengan perubahan protokol WhatsApp yang belum didukung Baileys.

## 4. Pengguna dan trust boundary

| Aktor | Hak | Batasan |
|---|---|---|
| Admin | Mengelola connector, identitas agent, pesan, provider, backup, dan settings | Satu akun; wajib mengganti password pada login pertama |
| OpenClaw | Menerima event dan mengirim respons melalui API internal | Hanya localhost/private workspace network dan internal API key |
| Baileys service | Membaca session terenkripsi, menerima dan mengirim pesan | Tidak memiliki AI logic |
| Cloudflare Tunnel | Meneruskan HTTPS dashboard ke listener loopback | Hanya route dashboard; API internal tidak diproksikan |

## 5. Requirement fungsional

### FR-01 — Workspace-local runtime

Seluruh source, build, state, logs, upload, backup, PID, dan konfigurasi proses berada di bawah `openclaw-whatsapp-gateway/`. Karena kontrak command adalah `npm run ...`, Node.js/npm menjadi bootstrap installer dan build reproducible. Bila Bun kompatibel tersedia, process runner memprioritaskannya untuk Gateway API/Baileys/bridge; Next.js standalone tetap memakai Node. Tanpa Bun, seluruh service memakai Node. Installer tidak boleh menjalankan `sudo`, package manager OS, Docker, `systemctl`, `pm2 startup`, atau menulis ke lokasi global.

### FR-02 — Database discovery-first

Urutan discovery PostgreSQL:

1. `DATABASE_URL` atau variabel PostgreSQL yang diberikan environment;
2. service/credential managed yang diekspos oleh environment agent;
3. PostgreSQL lokal yang sudah berjalan dan dapat diakses;
4. berhenti aman dengan instruksi jika tidak ditemukan.

Installer tidak memasang PostgreSQL. Semua migration harus transactional, berurutan, mempunyai checksum immutable, dan aman terhadap dua installer bersamaan melalui advisory lock.

### FR-03 — Redis opsional

Urutan discovery Redis: `REDIS_URL`, service managed, lalu Redis lokal yang sudah dapat diakses. Bila Redis tidak tersedia, service wajib tetap beroperasi memakai `queue_jobs` di PostgreSQL. Redis hanya akselerator wake-up/coordination; bukan sumber data antrean.

### FR-04 — Lifecycle WhatsApp

- QR login dengan TTL singkat; QR tidak disimpan di log atau database permanen.
- Session dan Signal keys disimpan dalam envelope AES-256-GCM.
- Auto reconnect dengan exponential backoff dan jitter, kecuali logout permanen.
- Status connecting, connected, disconnected, reconnecting, dan auth failure terlihat di dashboard.
- Hanya satu socket aktif melalui lease/leader lock.
- Ganti nomor/relogin tidak menghapus profil dan data agent.

### FR-05 — Pesan inbound

1. Baileys menerima event.
2. Gateway membuat dedupe key dan menyimpan pesan secara transactional.
3. DM dapat diproses; pesan grup diproses hanya jika `mentionedJid` memuat JID agent secara tepat.
4. Event ditulis ke transactional outbox dan durable queue.
5. Worker mengirim event ke OpenClaw memakai internal API key dan idempotency key.
6. Kegagalan sementara dijadwalkan ulang memakai exponential backoff; kegagalan terminal masuk dead-letter untuk recovery.

### FR-06 — Pesan outbound

OpenClaw dapat mengirim text, image, atau document ke DM maupun grup. API harus mewajibkan idempotency key, menyimpan command sebelum mengakuinya, memvalidasi upload workspace-local, dan memperbarui status queued/sent/delivered/read/failed/dead dari receipt WhatsApp.

### FR-07 — Internal bridge

- Gateway → OpenClaw: `POST /internal/openclaw/event` pada origin OpenClaw yang dikonfigurasi.
- OpenClaw → Gateway: `POST /internal/messages/send`.
- OpenClaw → Gateway: `GET /internal/agent/context`.

Semua request memakai internal API key, request ID, timestamp, batas ukuran, dan loopback/private-origin policy. Route internal tidak boleh diteruskan oleh proxy dashboard atau tunnel publik.

### FR-08 — Persistent identity

Database menyimpan `agent_profile`, `knowledge_items`, `agent_tools`, `agent_jobs`, provider AI, dan settings. Snapshot context yang dibaca OpenClaw harus konsisten dan menyertakan revision sehingga cache dapat diinvalidasi.

### FR-09 — Admin dan audit

Bootstrap email adalah `ramdanifahmy2023@gmail.com`. Password awal wajib unik per instalasi dan tidak boleh muncul dalam SQL, log, process arguments, atau backup plaintext. Installer meng-hash dengan Argon2id, mengaktifkan akun secara parameterized, dan menyetel `force_password_change=true`. Login pertama harus mengganti password sebelum route admin lain dapat dipakai. Login mempunyai rate limit/lockout, refresh token rotation, dan audit log.

### FR-10 — Dashboard

Dashboard Next.js + TypeScript + Tailwind + shadcn/ui berbahasa Indonesia dengan gaya dark enterprise. Menu wajib: Dashboard, WhatsApp, Messages, Groups, Agent Profile, Knowledge, Tools, Jobs, AI Provider, Logs, Backup, Settings. Provider mendukung 9router, OpenRouter, dan OpenAI-compatible dengan Base URL, API Key, Model, Temperature, dan Max Token.

### FR-11 — Backup dan restore

`npm run backup` menghasilkan artifact workspace-local terenkripsi dan ber-checksum yang mencakup identity, knowledge, tools, jobs, konfigurasi, database dump/logical export, serta ciphertext session WhatsApp. Upload tidak disertakan secara default kecuali masih direferensikan pesan aktif. `npm run restore` wajib memverifikasi format, checksum, AEAD tag, kompatibilitas schema, dan membuat safety backup sebelum mutasi.

### FR-12 — Operasi

Command wajib: `npm run install`, `doctor`, `start`, `stop`, `restart`, `status`, `backup`, dan `restore`. PM2 dipakai bila tersedia secara workspace-local. Jika tidak, fallback runner mengelola PID/lock di `.runtime/` serta log, restart, dan shutdown di dalam workspace tanpa service global.

## 6. Requirement nonfungsional

| ID | Requirement |
|---|---|
| NFR-01 Durability | Acknowledge inbound/outbound hanya setelah record durable tersimpan. Queue dapat dipulihkan setelah crash. |
| NFR-02 Security | Semua listener bind ke `127.0.0.1`; secret terenkripsi/redacted; query parameterized; path upload dibatasi ke `data/uploads`. |
| NFR-03 Availability | Worker reconnect dan queue recovery otomatis; poison job tidak memblokir job lain. |
| NFR-04 Maintainability | TypeScript strict, modul terpisah, migration immutable, structured logs, kontrak API tervalidasi. |
| NFR-05 Observability | Health per dependency, request/correlation ID, delivery timeline, queue depth, retry/dead count. |
| NFR-06 Compatibility | PostgreSQL 14+, Node.js/npm untuk bootstrap/build; Bun diprioritaskan untuk service TypeScript yang kompatibel dan Node menjadi fallback. |
| NFR-07 Privacy | Payload/log mempunyai retention dan redaction; QR, password, API key, token, dan plaintext session tidak dilog. |

## 7. Kriteria penerimaan

- Instalasi berhasil dari user workspace biasa tanpa menulis keluar proyek.
- Doctor membedakan configured, reachable, degraded, dan failed; Redis yang hilang menghasilkan mode PostgreSQL queue, bukan kehilangan pesan.
- Restart paksa setelah pesan tersimpan tidak menghilangkan pesan dan worker melanjutkan dari antrean.
- Event duplikat Baileys dan request outbound dengan idempotency key sama menghasilkan satu pesan logis.
- Pesan grup tanpa exact mention disimpan sebagai ignored dan tidak diteruskan ke OpenClaw.
- Session database tidak dapat didekripsi tanpa master key workspace.
- Login pertama memaksa penggantian password dan merotasi/revokasi token yang lama.
- Tunnel hanya mencapai dashboard; route `/internal/*` tidak dapat dicapai dari hostname publik.
- Backup dapat diverifikasi dan dipulihkan pada database kosong dengan schema kompatibel.

## 8. Tahapan implementasi

1. Architecture + repository.
2. Database + foundation.
3. Baileys service.
4. Gateway API + OpenClaw bridge.
5. Dashboard.
6. Installer + doctor.
7. Backup + deployment.

Perubahan arsitektur wajib dicatat sebagai ADR dan hanya dilakukan bila ada alasan teknis yang memengaruhi keamanan, durability, atau compatibility workspace.

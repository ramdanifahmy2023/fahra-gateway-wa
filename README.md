# OpenClaw WhatsApp Gateway

Private WhatsApp gateway berbasis `@whiskeysockets/baileys` untuk satu OpenClaw Agent. Project berjalan dari foldernya sendiri dan tidak membutuhkan root, sudo, apt, Docker, systemd, Nginx, atau perubahan `/etc`.

> Gateway adalah transport dan monitoring layer. Reasoning, workflow, knowledge execution, serta tool execution tetap dilakukan oleh OpenClaw.

## Kapabilitas

- QR authentication dan encrypted Baileys session persistence.
- Reconnect, connection monitoring, dedupe, retry, recovery, dan delivery status.
- Text/image/document ke DM maupun grup.
- Exact group mention detection sebelum event diteruskan ke OpenClaw.
- PostgreSQL durable queue dengan Redis opsional untuk readiness dan koordinasi deployment.
- Admin API dan internal API key untuk OpenClaw bridge.
- Persistent agent profile, knowledge, tools, jobs, dan OpenAI-compatible provider.
- Dashboard Indonesia bergaya dark enterprise.
- Workspace-local runner/PM2, Cloudflare Tunnel outbound, backup, dan restore.

## Arsitektur ringkas

| Komponen               | Peran                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `apps/baileys-service` | Socket/session WhatsApp, inbound listener, outbound worker                                       |
| `apps/gateway-api`     | Auth admin, CRUD, durable command, internal bridge, health                                       |
| `apps/dashboard`       | Next.js UI dan allowlisted same-origin proxy                                                     |
| PostgreSQL             | Identity, session ciphertext, messages, queue, audit, backup metadata                            |
| Redis                  | Opsional: discovery, health/readiness, dan fondasi koordinasi; queue tetap durable di PostgreSQL |
| Cloudflare Tunnel      | Koneksi outbound dari dashboard loopback ke hostname publik                                      |

Desain lengkap: [docs/architecture.md](docs/architecture.md). Requirement final: [PRD.md](PRD.md).

## Prasyarat

- Workspace Linux/macOS yang writable.
- Node.js LTS dengan npm untuk bootstrap `npm run ...`, dependency install, dan build.
- Bun opsional; bila kompatibel dan tersedia, runner memprioritaskannya untuk Gateway API/Baileys/bridge. Next.js standalone tetap Node.
- PostgreSQL 14+ yang sudah tersedia melalui URL direct/session-pooling beserta izin schema; transaction/statement pooling tidak didukung.
- Redis opsional.
- OpenClaw yang dapat dicapai melalui localhost/private workspace network.
- Token Cloudflare Tunnel opsional untuk dashboard eksternal.

Installer tidak akan memasang runtime/database/Redis secara global. Jika Node/npm atau PostgreSQL belum disediakan oleh environment, siapkan melalui fasilitas workspace/managed service terlebih dahulu.

## Quick start

Ekstrak proyek ke workspace agent, masuk ke direktori proyek, lalu:

```bash
npm run install
npm run doctor
npm run start
```

`npm` tetap menjadi package runner build yang reproducible. Bun yang kompatibel hanya dipilih untuk proses service yang mendukungnya; bila tidak ada, service berjalan dengan Node.js.

Installer melakukan discovery, membuat `.env` dengan permission owner-only bila belum ada, menguji PostgreSQL/Redis/OpenClaw, menjalankan migration dan seed, meng-hash bootstrap password, build, start, dan health check. Tidak ada perintah privileged.

## Command operasi

```bash
npm run install
npm run doctor
npm run start
npm run stop
npm run restart
npm run status
npm run backup
npm run restore -- data/backups/<nama-artifact>.ocgwb --yes
```

Semua command harus dijalankan dari project root. PID, lock, dan state lifecycle berada di `.runtime/`; payload persisten serta log berada di `data/`. Jangan menjalankan dua process manager berbeda pada workspace yang sama.

## Bootstrap admin

- Email: `ramdanifahmy2023@gmail.com`
- Password awal: nilai unik `BOOTSTRAP_ADMIN_PASSWORD` yang diberikan saat instalasi.

Password requirement ini hanya digunakan installer untuk menghasilkan hash Argon2id dan tidak terdapat di `database/seed.sql`. Login pertama wajib mengganti password melalui dashboard loopback.

Untuk mencegah perebutan akun bootstrap yang credential awalnya diketahui, runner menunda Cloudflare Tunnel sampai password berhasil diganti melalui dashboard loopback. Sesudah mengganti password, jalankan `npm run restart`; Cloudflare Access tetap direkomendasikan sebagai lapisan tambahan.

## Environment penting

Salinannya didokumentasikan lengkap di `.env.example`. Variabel utama:

```dotenv
DATABASE_URL=
DATABASE_POOL_MODE=
REDIS_URL=
OPENCLAW_WEBHOOK_URL=http://127.0.0.1:18789/v1/chat/completions
OPENCLAW_API_KEY=
INTERNAL_API_KEY=
WHATSAPP_SESSION_ENCRYPTION_KEY=
JWT_SECRET=
SESSION_ENCRYPTION_KEY=
BACKUP_ENCRYPTION_KEY=
HOST=127.0.0.1
GATEWAY_PORT=3100
DASHBOARD_PORT=3200
CLOUDFLARE_TUNNEL_TOKEN=
CLOUDFLARE_HOSTNAME=
```

Jangan menaruh `.env` dalam ZIP, Git, chat, atau log. Bila environment agent sudah menyuntikkan secret, installer mempertahankan sumber itu dan tidak menyalinnya tanpa alasan.

## Health dan doctor

Health HTTP digunakan untuk liveness/readiness proses. `npm run doctor` melakukan audit deployment yang lebih luas dan tidak memodifikasi state. Output ringkas yang diharapkan:

```text
OpenClaw WhatsApp Gateway Doctor

Runtime
✓ Bun/Node

Workspace
✓ Writable

Database
✓ Connected

Redis
✓ Connected

WhatsApp
✓ Running

OpenClaw
✓ Reachable

Dashboard
✓ Running

Cloudflare Tunnel
✓ Configured
```

Redis dapat tampil sebagai PostgreSQL queue fallback tanpa membuat keseluruhan doctor gagal. WhatsApp sebelum pairing dapat berstatus menunggu QR; proses dan heartbeat-nya tetap harus healthy.

## Tunnel

Tunnel bersifat outbound dan origin-nya adalah `http://127.0.0.1:3200` (atau `DASHBOARD_PORT`). Token dibaca dari `CLOUDFLARE_TUNNEL_TOKEN` dan tidak di-hardcode. Lihat [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Backup

Backup disimpan di `data/backups/`, terenkripsi dan ber-checksum. Simpan `BACKUP_ENCRYPTION_KEY`, `SESSION_ENCRYPTION_KEY`, dan `WHATSAPP_SESSION_ENCRYPTION_KEY` source di lokasi aman terpisah; artifact tidak dapat dibuka tanpa backup key dan ciphertext aplikasi/session tidak dapat digunakan dengan key yang berbeda. File upload hanya disertakan bila masih direferensikan pesan/job recoverable.

## Dokumentasi

- [INSTALL.md](INSTALL.md) — instalasi workspace-local.
- [INSTALL-PROMPT.md](INSTALL-PROMPT.md) — prompt siap kirim ke agent OpenClaw.
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — PM2/fallback runner dan Cloudflare Tunnel.
- [docs/ADR-001-durable-queue.md](docs/ADR-001-durable-queue.md) — alasan PostgreSQL menjadi sumber antrean durable.
- [docs/API.md](docs/API.md) — kontrak admin API dan bridge internal OpenClaw.
- [docs/BACKUP-RESTORE.md](docs/BACKUP-RESTORE.md) — format artifact dan prosedur recovery.
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — diagnosis kegagalan.
- [docs/SECURITY.md](docs/SECURITY.md) — trust boundary dan secret handling.
- [database/README.md](database/README.md) — schema, migration, dan queue semantics.

## Status produksi

Project ditujukan untuk production workspace OpenClaw. Sebelum pemakaian nyata, wajib menjalankan build/test, `npm run doctor`, pairing QR, test DM, test mention grup, simulasi restart saat queue berisi job, serta backup/restore drill pada environment target.

Baileys adalah library tidak resmi dan penggunaan WhatsApp harus mematuhi ketentuan serta risiko platform WhatsApp.

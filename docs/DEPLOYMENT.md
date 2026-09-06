# Deployment Workspace-Local

## Model deployment

Deployment berada di satu project root milik user agent. Tidak ada unit systemd, init service, container daemon, reverse proxy OS, atau port inbound.

```text
Cloudflare edge
    ↑ koneksi tunnel outbound
cloudflared workspace
    ↓ http://127.0.0.1:${DASHBOARD_PORT}
Next.js dashboard
    ↓ allowlisted server-side proxy
Gateway API 127.0.0.1:${GATEWAY_PORT}
    ↔ PostgreSQL / optional Redis
Baileys worker ↔ WhatsApp
OpenClaw bridge ↔ OpenClaw localhost
```

## Layout state

| Path                                              | Isi                                                 | Backup default                           |
| ------------------------------------------------- | --------------------------------------------------- | ---------------------------------------- |
| `data/logs/`                                      | structured process logs                             | Tidak                                    |
| `data/uploads/`                                   | media upload tervalidasi                            | Hanya yang direferensikan                |
| `data/backups/`                                   | artifact encrypted                                  | n/a                                      |
| `.runtime/pids/`                                  | PID fallback runner dan child                       | Tidak                                    |
| `.runtime/runner-instance.json`                   | Heartbeat identity fallback runner, owner-only      | Tidak                                    |
| `.runtime/locks/`                                 | install/lifecycle/runner lock tervalidasi           | Tidak                                    |
| `.runtime/pm2/`                                   | workspace PM2 home                                  | Tidak                                    |
| `.runtime/staging/`                               | copy source dan build kandidat                      | Tidak                                    |
| `.runtime/releases/`                              | artifact lama selama activation/rollback            | Tidak                                    |
| `.runtime/bin/`                                   | binary workspace yang diprovisikan operator         | Tidak                                    |
| `.runtime/postgres/`, `.runtime/postgres-socket/` | data cluster lokal dan socket private, bila dipakai | Sesuai backup database                   |
| `.runtime/redis/`                                 | state Redis lokal opsional                          | Tidak; queue durable tetap di PostgreSQL |
| PostgreSQL                                        | state durable dan encrypted session                 | Ya                                       |

Folder `.runtime` dan seluruh subfoldernya dibuat mode `0700`; `.env`, token/PID/lock owner, serta log dibuat mode `0600`. Path state sensitif dan log menolak symlink. Runtime harus menolak project root atau `.env` yang writable oleh user lain pada host bersama.

File process log dibatasi workspace-local sebesar 50 MiB per file. Start melakukan pemeriksaan awal, fallback runner memeriksa ulang setiap lima menit, dan maintenance worker melakukan hal yang sama ketika dikelola PM2. File yang melampaui batas ditruncate dengan open non-symlink owner-only; `doctor` melaporkan file yang masih melewati cap. Tidak ada dependency pada modul global `pm2-logrotate`.

## Activation install

`npm run install` mengambil exclusive install lock di `.runtime/locks`. Lock owner memuat PID, workspace, command, dan process start marker; lock hanya dibersihkan sebagai stale setelah ownership tersebut gagal divalidasi.

Dependency dan build dibuat pada copy source private di `.runtime/staging`, bukan pada artifact aktif. Setelah build dan preflight database lulus, installer mencoba safety backup build aktif, menghentikan service, lalu memindahkan artifact `node_modules`, `dist`, dan `.next` dengan rename di filesystem workspace. Artifact sebelumnya ditahan di `.runtime/releases` sampai activation/start/health lokal lulus.

Jika activation atau start gagal, installer mengembalikan artifact lama dan mencoba menjalankan kembali service yang sebelumnya aktif. Rollback ini hanya berlaku pada artifact aplikasi: **migration/seed database yang sudah commit tidak di-rollback**. Safety backup otomatis bersifat best effort, sehingga operator produksi tetap wajib membuat dan menguji backup eksplisit sebelum update.

## PM2 workspace

Jika PM2 tersedia sebagai dependency project, lifecycle script menyetel `PM2_HOME=<project>/.runtime/pm2` dan memakai ecosystem file di `deployment/pm2/`. Dilarang menjalankan:

```text
pm2 startup
pm2 save (ke home global)
systemctl
```

PM2 mengelola Gateway API, OpenClaw bridge, maintenance worker, Baileys service, Dashboard, dan cloudflared bila tunnel diaktifkan. Restart policy mempunyai delay/backoff agar konfigurasi fatal tidak menjadi restart loop.

Gateway/Baileys/bridge memakai Bun hanya bila versinya dapat diparse dan `>=1.2.0`; jika tidak, konfigurasi PM2 dan fallback runner konsisten memakai Node. Dashboard standalone selalu memakai Node.

## Fallback runner

Tanpa PM2, `scripts/start.mjs` menjalankan supervisor workspace. Supervisor:

- mengambil exclusive workspace lock;
- menulis PID atomik ke `.runtime/pids`;
- spawn process tanpa shell interpolation;
- menulis stdout/stderr ke file owner-only di `data/logs`;
- restart child yang dikonfigurasi untuk autorestart dengan exponential backoff;
- meneruskan SIGTERM/SIGINT dan menunggu graceful timeout;
- menghapus PID hanya setelah memastikan PID tersebut milik proses project.

`status` tidak mempercayai PID file saja; ia mencocokkan PID aktif dengan command service workspace, sedangkan `doctor` menambahkan validasi health endpoint. Lock lifecycle/runner juga memvalidasi process start marker untuk mencegah reuse PID.

`start`, `stop`, dan fallback runner memakai lock workspace terpisah. `runner-mode` hanya hint status, bukan authority lifecycle: start/stop selalu memeriksa PID PM2 workspace dan PID/process-group fallback secara independen. Fallback runner juga memperbarui `.runtime/runner-instance.json` secara atomik; start/stop mengamati perubahan heartbeat sebelum mempercayai PID ketika `/proc`/`ps` tidak tersedia. Jika startup PM2 hanya berhasil sebagian, seluruh process PM2 pada `PM2_HOME` workspace dibersihkan dan dibuktikan mati sebelum fallback dimulai; keduanya tidak dijalankan bersamaan. Status menandai `conflict` bila kedua backend terdeteksi.

## Restore journal dan lifecycle fail-closed

Setiap restore—baik dari dashboard maupun CLI—membuat journal durable owner-only di `.runtime/restore-handoff.json` sebelum service dihentikan. Journal menyimpan operation ID, hash artifact, source filename, staging path workspace-relative, phase, serta PID/process-start token coordinator; credential otorisasi hanya disimpan sebagai digest. Urutan phase adalah `ready` (handoff worker), `granted`, `stopping`, `restoring`, `committed`, `starting`, `verifying`, lalu `completed`, atau `recovery_start`/`failed` saat recovery.

`start`, `stop`, dan `install` biasa menolak journal nonterminal. Lifecycle child restore hanya diizinkan bila token, operation ID, parent PID, command, dan process-start token cocok. Lock lifecycle yang tampak stale tidak cukup untuk melewati journal. Marker `ready`/`granted` dengan coordinator mati dapat dibersihkan otomatis karena phase stop belum pernah diotorisasi; marker terminal juga dapat dibersihkan setelah coordinator mati. Cleanup aman lebih dulu memvalidasi dan menghapus staging decrypted owner-only yang direferensikan journal; kegagalan cleanup meninggalkan marker fail-closed. Coordinator mati pada `stopping` atau phase sesudahnya tetap fail-closed dan harus mengikuti runbook recovery di `docs/TROUBLESHOOTING.md`.

## Isolasi environment service

Setiap process menerima allowlist environment sesuai tugasnya, bukan salinan `.env` penuh:

- Gateway menerima credential API/session dan koneksi data yang memang dipakai Gateway.
- Bridge menerima credential OpenClaw/internal bridge; Baileys menerima credential session WhatsApp/internal yang dibutuhkan.
- Maintenance menerima key backup dan koneksi data, tanpa credential tunnel atau bootstrap.
- Dashboard hanya menerima Node/host/port, URL Gateway, dan batas upload—tanpa database/API/session key.
- Redis lokal tidak menerima secret aplikasi. `cloudflared` menerima environment proses minimum dan token melalui `.runtime/cloudflare-token` mode `0600`, bukan argument command line.

`start` operator/installer menggabungkan `.env` dengan managed process environment (managed value menang), lalu mematerialisasi hanya key konfigurasi OCGW yang diizinkan secara atomik ke `.env` mode `0600`. Ini memberi autonomous restart/restore snapshot stabil tanpa menyalin environment host lain. Semua child menerima `OCGW_SANITIZED_SERVICE_ENV=1`; start yang dipanggil worker memakai snapshot file dan tidak menulis compatibility secret kembali.

Nilai bootstrap, tunnel, dan backup tidak disebarkan ke service yang tidak membutuhkannya. Ketika menambah variabel baru, tambahkan hanya ke allowlist process pemilik fungsi tersebut.

## PostgreSQL workspace-local

Installer hanya membuat cluster lokal jika binary PostgreSQL sudah tersedia; project tidak memasang package sistem. Cluster berada di `.runtime/postgres`, listen pada `127.0.0.1:55432`, dan setiap start/restart memakai opsi tersimpan yang harus persis sesuai hardening:

Untuk PostgreSQL managed, pilih endpoint direct atau session-pooling. Endpoint transaction/statement pooling tidak kompatibel dengan session advisory lock yang menjaga migration, singleton worker, backup, dan restore. Installer/Doctor mendeteksi pola URL pooler yang umum secara best-effort, tetapi operator tetap wajib memverifikasi mode pada provider. `DATABASE_POOL_MODE=session` hanya boleh dipakai untuk endpoint yang telah dikonfirmasi session-affine.

```text
-h 127.0.0.1 -p 55432 -k <project>/.runtime/postgres-socket -c unix_socket_permissions=0700
```

Socket directory harus regular directory workspace mode `0700`. Startup ditolak bila opsi tersimpan hilang/tidak cocok; local cluster yang sudah berjalan dengan opsi lain direstart menggunakan opsi di atas.

## Cloudflare Tunnel

### Prasyarat di Cloudflare

1. Domain aktif pada akun Cloudflare.
2. Buat named tunnel dan public hostname untuk dashboard.
3. Service origin: `http://127.0.0.1:3200` atau nilai `DASHBOARD_PORT`.
4. Buat Cloudflare Access self-hosted application untuk hostname tersebut.
5. Ambil connector token dengan scope minimal; jangan gunakan Global API Key.

### Environment

```dotenv
CLOUDFLARE_TUNNEL_TOKEN=
CLOUDFLARE_HOSTNAME=dashboard.example.com
```

Token disinkronkan secara atomik dari `.env` ke `.runtime/cloudflare-token` mode `0600`. Jangan menaruh token di process argument, ecosystem file yang dikomit, log, atau prompt chat. Runner menggunakan `cloudflared tunnel run --token-file ...` dan karena itu mewajibkan `cloudflared >=2025.4.0`. Binary lebih lama atau versi yang tidak dapat diparse tidak dimasukkan ke PM2/fallback runner; `npm run doctor` melaporkannya sebagai incompatible agar tidak terjadi crashloop.

### Binary

Urutan discovery:

1. `.runtime/bin/cloudflared` yang diprovisikan dan diverifikasi operator;
2. `cloudflared` yang sudah tersedia di `PATH`.

Installer tidak mengunduh executable dan tidak menggunakan package manager OS. Jika binary belum tersedia, service lokal tetap dapat berjalan dan doctor melaporkan tunnel belum tersedia.

### Validasi

- Origin local dashboard mengembalikan health/HTML.
- Process cloudflared connected dan hostname sesuai `CLOUDFLARE_HOSTNAME`.
- HTTPS hostname menampilkan Cloudflare Access atau halaman login.
- Request ke `/internal/agent/context` dan `/internal/messages/send` melalui hostname publik ditolak/404.
- Gateway API port dan dashboard tidak bind ke `0.0.0.0`/`::`.

## Deployment tanpa tunnel

App dapat beroperasi lokal selama bootstrap tanpa token Cloudflare, tetapi doctor menandai tunnel `Not configured` sebagai blocker deployment eksternal. Kondisi produksi yang diminta project ini baru lengkap setelah token dan hostname tersedia. Jangan mengganti solusi dengan membuka port inbound.

## Startup setelah workspace/agent restart

Tanpa systemd, kemampuan autostart bergantung pada lifecycle agent OpenClaw/hosting. Daftarkan satu command workspace yang didukung environment:

```bash
cd <project-root> && npm run start
```

Jangan menyatakan “aktif saat reboot” sebelum mekanisme hosting benar-benar diuji. Queue PostgreSQL memungkinkan proses aman dilanjutkan meskipun startup manual terlambat.

## Checklist produksi

- [ ] ZIP/checksum diverifikasi dan tidak mengandung `.env`, backup, log, atau session.
- [ ] Database khusus aplikasi atau schema terisolasi.
- [ ] Semua secret CSPRNG dan file permission ketat.
- [ ] Password bootstrap sudah diganti.
- [ ] Cloudflare Access aktif.
- [ ] Exact mention test lulus.
- [ ] Redis disconnect fallback test lulus.
- [ ] Restart/crash recovery test lulus dengan queue berisi job.
- [ ] Dead-letter dan manual requeue test lulus.
- [ ] Backup + restore drill lulus.
- [ ] Retention log/pesan/backup disetujui.

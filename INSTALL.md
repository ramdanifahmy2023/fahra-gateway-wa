# Instalasi Workspace-Local

Panduan ini sengaja tidak memuat `sudo`, `apt`, Docker, systemd, `pm2 startup`, atau perubahan `/etc`. Jika sebuah langkah membutuhkan privilege tersebut, hentikan: environment yang dipakai bukan target deployment project ini.

## 1. Tempatkan proyek

Ekstrak ZIP sehingga project root berisi `package.json`, `apps/`, `database/`, `scripts/`, `deployment/`, dan `data/`.

```bash
cd /path/workspace/openclaw-whatsapp-gateway
```

Project root harus writable oleh user agent. Hindari path temporary yang dihapus saat agent restart.

## 2. Runtime

Command `npm run ...` membutuhkan Node.js/npm sebagai bootstrap. Installer melakukan discovery berikut:

1. Node.js LTS + npm yang memenuhi minimum project untuk install/build;
2. Bun `>=1.2.0` sebagai runtime pilihan untuk Gateway API/Baileys/bridge;
3. Node.js sebagai fallback service runtime dan runtime wajib untuk Next.js standalone;
4. berhenti aman bila bootstrap Node/npm tidak tersedia.

Project ini tidak mengunduh atau memasang runtime. Sediakan Node.js/npm—dan Bun bila ingin diprioritaskan—melalui fasilitas workspace/hosting yang sudah ada.

## 3. PostgreSQL

PostgreSQL 14+ wajib tersedia sebelum migrasi. Urutan discovery:

1. `DATABASE_URL` dari environment atau `.env`;
2. credential managed yang disediakan environment agent;
3. kombinasi `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`;
4. endpoint localhost yang sudah berjalan;
5. cluster workspace-local hanya bila binary `initdb`, `pg_ctl`, dan `createdb` memang sudah tersedia.

Contoh connection URL:

```dotenv
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require
```

Gunakan `sslmode=require`/`verify-full` untuk database remote sesuai sertifikat provider. User database memerlukan izin connect dan membuat/mengubah object pada schema aplikasi. Installer tidak memasang PostgreSQL. Bila memakai binary lokal yang sudah tersedia, cluster disimpan di `.runtime/postgres`, hanya listen pada `127.0.0.1:55432`, dan selalu memakai socket private `.runtime/postgres-socket` dengan `unix_socket_permissions=0700`.

Gunakan endpoint PostgreSQL direct atau session-pooling. Transaction/statement pooling (misalnya PgBouncer transaction mode atau managed transaction-pool URL) tidak didukung karena migration, singleton worker, backup, dan restore memakai session advisory lock. Installer menolak indikator URL yang jelas seperti hostname `pooler`/`-pooler`, port umum `6432`/`6543`, atau query `pool_mode=transaction|statement`. Deteksi ini best-effort, bukan bukti session affinity. Untuk endpoint yang tampak pooled tetapi provider secara eksplisit menjamin session affinity, set `DATABASE_POOL_MODE=session`; jangan gunakan override tersebut untuk transaction pooler. Managed provider biasanya menyediakan URL direct/session terpisah.

## 4. Redis

Isi `REDIS_URL` bila service tersedia:

```dotenv
REDIS_URL=rediss://default:PASSWORD@HOST:6379/0
```

Redis tidak wajib. Jika discovery/test gagal, installer menyetel queue driver PostgreSQL dan memberi status degraded/optional. Menyalakan Redis kemudian tidak memerlukan migrasi data karena seluruh job durable tetap berada di PostgreSQL.

## 5. Konfigurasi

Jalankan:

```bash
npm run install
```

Pada fresh install, script:

1. memastikan workspace, `.runtime/`, dan `data/` writable serta owner-only untuk state sensitif;
2. memvalidasi Node/npm dan memilih Bun `>=1.2.0` bila tersedia; Bun lebih lama/tidak terbaca otomatis dilewati ke Node;
3. membuat `.env` owner-only bila belum ada;
4. menemukan dan menguji PostgreSQL;
5. menemukan Redis atau memilih database queue;
6. menghasilkan secret kriptografi yang belum tersedia;
7. mengambil exclusive install lock yang memvalidasi PID, command, workspace, dan process start marker sebelum menganggap lock lama stale;
8. menyalin source ke staging private di `.runtime/staging/`, lalu menginstal dependency dari lockfile dengan dev/build tooling eksplisit (`--include=dev`) dan build seluruh app di sana;
9. menguji koneksi database dengan build staging dan mencoba safety backup build aktif sebelum migration;
10. menghentikan service dan mengaktifkan `node_modules`, `dist`, serta `.next` dengan rename atomik; build lama ditahan di `.runtime/releases/` selama verifikasi;
11. menjalankan migration, seed non-secret, dan bootstrap admin;
12. memilih PM2 workspace bila tersedia, jika tidak fallback runner, lalu melakukan health check lokal dan doctor.

Installer idempotent: `.env` tidak dibuat ulang (hanya key allowlist dari managed environment yang diperbarui atomik), data tidak ditimpa, migration tidak diulang, serta credential/session tidak diregenerasi pada rerun. Dua install bersamaan ditolak oleh lock workspace. Jika activation/start gagal, artifact aplikasi dikembalikan ke build lama dan service lama dicoba dijalankan kembali. **Migration/seed yang sudah commit tidak di-rollback oleh artifact rollback.** Safety backup sebelum migration bersifat best effort; untuk perubahan produksi tetap jalankan `npm run backup` dan verifikasi artifact terlebih dahulu.

Semua restore membuat journal durable `.runtime/restore-handoff.json` sebelum downtime. Selama journal nonterminal aktif, install/start/stop biasa ditolak meskipun lifecycle lock tampak stale. Jika coordinator restore mati, ikuti tabel phase dan prosedur recovery di `docs/TROUBLESHOOTING.md`; jangan menghapus marker secara refleks.

Pada start operator/installer, nilai konfigurasi yang diinjeksi managed environment menang atas `.env`; hanya key allowlist OCGW yang disimpan atomik ke `.env` mode `0600`. Snapshot ini diperlukan agar PM2/fallback restart serta restore terkoordinasi memakai credential yang sama. Child service diberi marker sanitasi sehingga compatibility value/fake secret worker tidak pernah ditulis kembali ke `.env`.

Setelah hash admin bootstrap berhasil dibuat, installer langsung mengganti `BOOTSTRAP_ADMIN_PASSWORD` di `.env` dengan nilai acak inert (tidak dicetak) sepanjang sedikitnya 32 karakter. Password login awal tetap nilai yang dipakai saat bootstrap sampai pengguna menggantinya pada login pertama; field `.env` yang sudah dirotasi tidak mengubah hash admin pada rerun.

### Variabel yang harus ditinjau

| Variabel                          | Wajib        | Keterangan                                       |
| --------------------------------- | ------------ | ------------------------------------------------ |
| `DATABASE_URL`                    | Ya           | PostgreSQL 14+                                   |
| `DATABASE_POOL_MODE`              | Tidak        | Konfirmasi `direct`/`session` bila diperlukan    |
| `REDIS_URL`                       | Tidak        | Kosong berarti PostgreSQL queue fallback         |
| `OPENCLAW_WEBHOOK_URL`            | Ya           | Endpoint Chat Completions OpenClaw loopback       |
| `OPENCLAW_API_KEY`                | Ya           | Key yang dipakai Gateway saat mengirim event     |
| `INTERNAL_API_KEY`                | Ya           | Key yang dipakai OpenClaw saat memanggil Gateway |
| `WHATSAPP_SESSION_ENCRYPTION_KEY` | Ya           | 32-byte master key encoded sesuai `.env.example` |
| `SESSION_ENCRYPTION_KEY`          | Ya           | Provider/tool/settings encryption                |
| `JWT_SECRET`                      | Ya           | Signing key admin session                        |
| `BACKUP_ENCRYPTION_KEY`           | Ya           | Harus dicadangkan terpisah dari artifact         |
| `CLOUDFLARE_TUNNEL_TOKEN`         | Untuk tunnel | Token connector, bukan API token global          |
| `CLOUDFLARE_HOSTNAME`             | Untuk tunnel | Hostname dashboard final                         |

Installer dapat menghasilkan secret lokal yang kosong dengan CSPRNG, tetapi tidak boleh menampilkan nilai penuh ke terminal/log. OpenClaw key yang harus sama pada dua aplikasi perlu diprovisikan secara aman oleh environment.

## 6. Bootstrap admin

Seed hanya membuat akun pending `ramdanifahmy2023@gmail.com` tanpa hash. Installer membuat atau menerima password bootstrap unik, meng-hash-nya dengan Argon2id, lalu menyimpan hash saja. Login pertama wajib mengganti password; session bootstrap direvokasi setelah perubahan.

Segera lakukan perubahan password melalui dashboard lokal `http://127.0.0.1:3200`. Walaupun token tunnel sudah dikonfigurasi, runner sengaja menahan proses `cloudflared` selama `force_password_change=true`, sehingga credential bootstrap yang diketahui tidak pernah diekspos publik. Setelah password diganti, jalankan `npm run restart`; marker owner-only dibuat dari status database dan tunnel baru boleh aktif. Jangan menaruh password awal di `.env` permanen jika installer dapat menerimanya dari environment sementara/secure input.

## 7. Verifikasi

```bash
npm run doctor
npm run status
```

Kondisi lulus minimum:

- runtime memenuhi versi;
- project root/data writable dan bukan symlink berbahaya;
- PostgreSQL connected, schema version tepat, dan migration checksum valid;
- tiga app running dan listener hanya loopback;
- queue worker dapat claim/release probe job;
- OpenClaw reachable/authenticated atau dilaporkan blocker eksplisit;
- dashboard login HTTP healthy;
- tunnel configured/running bila token dan hostname diisi.

Redis boleh optional. WhatsApp `Waiting for QR` bukan failure sebelum pairing.

## 8. Pairing WhatsApp

1. Buka dashboard melalui local origin untuk login bootstrap; tunnel belum aktif pada tahap ini.
2. Login dan ganti password.
3. Buka menu **WhatsApp** dan minta QR.
4. Scan dari WhatsApp linked devices sebelum TTL berakhir.
5. Pastikan status Connected dan JID agent terdeteksi.
6. Uji DM dan grup dengan exact `@mention`.

QR tidak disimpan di database/log. Jangan mengambil screenshot QR untuk dibagikan.

## 9. Cloudflare Tunnel outbound

Isi:

```dotenv
CLOUDFLARE_TUNNEL_TOKEN=<connector-token>
CLOUDFLARE_HOSTNAME=dashboard.example.com
```

Lalu:

```bash
npm run restart
npm run doctor
```

Tunnel menargetkan `http://127.0.0.1:3200`. Gunakan `cloudflared` versi **2025.4.0 atau lebih baru** yang sudah tersedia di `PATH`, atau letakkan binary resmi yang telah diverifikasi di `.runtime/bin/cloudflared`. Batas versi ini diperlukan untuk mode secret-safe `tunnel run --token-file`; versi lama/tidak dikenali tidak dimasukkan ke process manager dan dilaporkan oleh doctor. Installer tidak mengunduh binary. Tidak ada port inbound yang dibuka.

Konfigurasikan Cloudflare Access sebelum membagikan hostname. Jangan meneruskan `/internal/*` atau Gateway API port secara langsung.

## 10. Operasi

```bash
npm run start
npm run stop
npm run restart
npm run status
```

PM2 hanya menggunakan `PM2_HOME` di `.runtime/pm2`. Fallback runner menggunakan `.runtime/pids`, `.runtime/locks`, heartbeat owner-only `.runtime/runner-instance.json`, dan log owner-only di `data/logs`. Jangan memakai process manager keduanya bersamaan. `start`/`stop` memeriksa kedua backend secara independen dari file `runner-mode`; bila `/proc`/`ps` tidak tersedia, PID fallback harus membuktikan heartbeat instance yang berubah sebelum menerima signal. Start/runner memakai lock eksklusif dan memvalidasi ownership PID/process-group agar dua command bersamaan tidak membuat supervisor ganda.

## 11. Backup dan restore

```bash
npm run backup
npm run restore -- data/backups/<artifact>.ocgwb --yes
```

Restore bersifat mutating. Script harus meminta konfirmasi pada terminal interaktif atau memerlukan flag eksplisit yang didokumentasikan untuk agent automation. Ia memverifikasi checksum dan encryption tag sebelum downtime, membuat rescue backup, menghentikan worker, restore transactionally, menjalankan migrations, lalu health check.

Jangan menghapus backup lama sebelum minimal satu restore drill berhasil. Simpan `BACKUP_ENCRYPTION_KEY` dan credential database di penyimpanan aman terpisah.

## 12. Update

1. Buat dan verifikasi backup eksplisit.
2. Verifikasi source/release notes, lalu jalankan `npm run install` dari project root.
3. Installer membangun copy private di `.runtime/staging`; dependency/build aktif tidak disentuh saat tahap ini gagal.
4. Setelah staging lulus, service dihentikan dan artifact diaktifkan dengan rename workspace-local; artifact sebelumnya ditahan sementara di `.runtime/releases`.
5. Migration, start, dan health dijalankan. Kegagalan activation/start memulihkan artifact lama dan mencoba restart service lama.
6. Artifact rollback tidak mengembalikan perubahan database. Database rollback hanya melalui migration/restore yang memang didukung dan telah diuji.

Jika gagal, lihat [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

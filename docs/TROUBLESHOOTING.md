# Troubleshooting

Mulai dari command read-only:

```bash
npm run doctor
npm run status
```

Jangan menghapus `.env`, `data/`, `.runtime/pids`, `.runtime/locks`, row database, session, atau queue untuk “mencoba ulang”. Tindakan itu dapat menghilangkan akses, merusak ownership process, atau membuang pesan yang belum terkirim.

## Install/start sedang terkunci

Lock berada di `.runtime/locks` dan menyimpan PID, command, workspace, serta process start marker. Command akan membersihkan lock stale hanya bila owner tidak lagi valid. Jangan menghapus lock ketika PID owner masih hidup; hentikan command pemilik secara normal atau tunggu selesai. Jika status PID tidak dapat diverifikasi dengan aman, kumpulkan output `npm run status` dan eskalasi alih-alih memaksa start kedua.

## Install gagal saat activation

Build kandidat dibuat di `.runtime/staging`; artifact lama ditahan sementara di `.runtime/releases`. Bila activation/start gagal, installer mengembalikan artifact lama dan mencoba restart service lama. Jangan memindahkan isi kedua folder tersebut ketika installer masih berjalan.

Rollback artifact **tidak** membatalkan migration/seed database yang sudah commit. Periksa output migration dan health sebelum mencoba lagi. Untuk recovery database, gunakan backup eksplisit/prosedur restore yang kompatibel—jangan menganggap safety backup best effort pasti tersedia.

## Restore journal tertinggal

Doctor menampilkan operation ID, source artifact, dan phase dari `.runtime/restore-handoff.json`. Jangan langsung menghapus marker atau menjalankan service lain: lock PID stale tidak membuktikan database dan file konsisten.

1. Pastikan PID coordinator pada journal benar-benar mati dan tidak ada `scripts/restore.mjs` aktif. Simpan journal, `data/logs/restore-coordinator.log`, serta folder staging yang disebut journal sebagai evidence owner-only.
2. Untuk `ready` atau `granted`, downtime belum diotorisasi; worker akan membersihkan marker stale otomatis. Jika tidak, perbaiki permission/format marker dahulu—jangan memaksa start.
3. Untuk `stopping`, mutasi restore belum dimulai. Setelah memverifikasi coordinator mati dan database/file aktif lama konsisten, pindahkan marker ke nama recovery unik di `.runtime/releases/`, lalu jalankan `npm run start` dan `npm run doctor`.
4. Untuk `restoring`, status COMMIT sengaja dianggap ambigu. Jangan start. Pulihkan safety backup yang tervalidasi atau lakukan inspeksi PostgreSQL/file staging oleh operator; pertahankan journal sampai satu state konsisten dipilih.
5. Untuk `committed`, database dan aktivasi file sudah commit. Setelah menyimpan journal sebagai evidence, pindahkan marker ke `.runtime/releases/`, jalankan `npm run migrate`, `npm run start`, lalu `npm run doctor`. `starting`, `verifying`, atau `recovery_start` juga boleh dilanjutkan hanya setelah konsistensi artifact/DB diverifikasi.
6. `completed`/`failed` biasanya dibersihkan otomatis setelah coordinator mati. Jika tetap ada karena I/O/permission error, simpan evidence, koreksi filesystem owner-only, lalu pindahkan marker terminal dan verifikasi doctor.

Gunakan nama tujuan yang memuat operation ID dan belum ada; jangan overwrite journal recovery sebelumnya. Jika phase atau hash artifact tidak cocok dengan log/backup record, berhenti dan eskalasi—jangan mengubah field JSON manual.

## Runtime tidak ditemukan

**Gejala:** doctor gagal pada Bun/Node.

- Pastikan runtime tersedia di `PATH` milik user agent, bukan hanya shell root lain.
- Bila runtime workspace disediakan hosting, gunakan path yang didokumentasikan provider.
- Jangan menjalankan apt/sudo. Provision runtime melalui fitur resmi environment atau binary workspace terverifikasi.
- Node bootstrap harus versi 22+, sedangkan Bun service runtime harus `>=1.2.0`. Bun lebih lama/tidak terbaca akan dilaporkan doctor dan dilewati ke Node.

## Workspace tidak writable

- Pastikan project berada di workspace persisten dan dimiliki user agent.
- Periksa quota/inode; build dan backup memerlukan ruang sementara.
- Jangan mengubah ownership dengan sudo. Pindahkan/ekstrak ulang oleh user yang benar.
- Tolak path project yang world-writable atau symlink ke luar workspace.

## PostgreSQL tidak ditemukan

**Gejala:** `Database ✗ Not configured` atau connection timeout.

1. Pastikan `DATABASE_URL` benar dan tidak memiliki whitespace/newline.
2. Uji hostname/port melalui test installer; jangan mencetak URL karena mengandung password.
3. Untuk provider managed, periksa TLS/allowlist dan database/user yang tepat.
4. Pastikan PostgreSQL 14+ dan user bisa membuat table/index/function/trigger pada schema aplikasi.
5. Localhost hanya valid bila database benar-benar berjalan di environment yang sama.

Installer tidak akan memasang PostgreSQL. Sediakan service managed/environment lalu ulangi `npm run install`. Jika binary PostgreSQL sudah ada dan cluster workspace-local dipakai, pastikan `.runtime/postgres-socket` merupakan directory regular mode `0700` dan `.runtime/postgres-start-options` masih berisi opsi private socket yang dibuat installer; jangan menggantinya dengan socket global.

## Migration checksum mismatch

Migration yang sudah applied telah berubah atau database berasal dari build berbeda. Jangan update checksum row secara manual.

- Cocokkan release dengan artifact/commit yang pernah memasang database.
- Pulihkan file migration asli atau upgrade melalui release yang benar.
- Buat backup sebelum tindakan koreksi.
- Eskalasi bila migration file pernah diedit; jangan meneruskan startup.

## Redis gagal

Redis opsional. Doctor seharusnya menampilkan PostgreSQL queue active. Jika app berhenti hanya karena Redis hilang, itu bug konfigurasi/implementasi.

- Kosongkan `REDIS_URL` hanya setelah memastikan tidak ada typo yang perlu diperbaiki.
- Restart service untuk masuk mode database queue.
- Verifikasi `queue_jobs` terus diproses dan tidak ada dua mode consumer yang mengirim job sama; dedupe tetap menjadi pengaman.

## WhatsApp menunggu QR

- Buka menu WhatsApp dan generate QR baru; QR mempunyai TTL pendek.
- Pastikan jam environment akurat.
- Jangan menyalin QR dari log—QR tidak seharusnya ada di log.
- Jika session lama sengaja logout, buat session generation baru; jangan menghapus identity tables.

## Reconnect loop

Lihat structured event dan disconnect reason yang sudah di-redact.

- `loggedOut`/bad session: hentikan retry agresif dan lakukan pairing baru.
- network/timeout: biarkan exponential backoff berjalan.
- duplicate connection: cari process manager kedua atau stale instance; jangan jalankan PM2 dan fallback runner bersamaan.
- checksum/tag auth state gagal: master key salah atau ciphertext rusak. Pulihkan key/backup; jangan mengabaikan authentication failure.

## Pesan grup tidak diteruskan

- Pastikan agent masih menjadi participant dan JID pada `whatsapp_connection.jid` benar.
- Mention harus terdapat pada `mentionedJid`; text yang hanya mengetik nama tanpa metadata mention sengaja diabaikan.
- Periksa `whatsapp_messages.agent_mentioned` dan `processing_state`.
- Pastikan group enabled dan metadata baru selesai sync.

## Pesan tertahan/retry

Periksa jumlah job berdasarkan status melalui dashboard/log, tanpa mengubah row langsung.

- `available/retrying`: tunggu `available_at` atau cari dependency outage.
- `locked/processing` melewati lease: recovery worker harus mengembalikannya.
- `dead`: perbaiki penyebab, lalu gunakan requeue admin yang mempertahankan idempotency.
- OpenClaw unreachable: outbox akan retry; jangan resend manual dengan key baru.

## OpenClaw tidak reachable

- `OPENCLAW_WEBHOOK_URL` harus menunjuk `http://127.0.0.1:18789/v1/chat/completions`.
- Cocokkan API key tanpa mencetak nilainya; rotasi kedua sisi bila ragu.
- Pastikan event endpoint menerima request ID/idempotency dan merespons cepat setelah durable acceptance.
- Jangan mengganti URL dengan public internet endpoint kecuali trust boundary ditinjau ulang.

## Dashboard local hidup tetapi hostname mati

1. Pastikan `http://127.0.0.1:${DASHBOARD_PORT}` sehat dari workspace.
2. Pastikan token/hostname terisi, binary cloudflared sesuai arsitektur, dan versinya minimal 2025.4.0 (`cloudflared --version`). Versi lama/tidak dikenali sengaja tidak dijalankan karena belum memenuhi kontrak `--token-file`.
3. Periksa status tunnel di dashboard Cloudflare.
4. Origin tunnel harus HTTP loopback, bukan hostname publik itu sendiri.
5. Token revoked membutuhkan connector token baru; jangan menampilkan token lama di log.

Tidak membuka port inbound sebagai workaround.

Jika PM2 gagal sebagian lalu fallback juga tidak mulai, periksa `.runtime/pm2` dan `.runtime/locks` melalui `npm run status`. Startup seharusnya membersihkan process PM2 workspace sebelum fallback; jangan menjalankan `pm2` global dengan home default untuk memperbaikinya.

## Login bootstrap gagal

- Cek admin tidak lagi `status=pending` dan `password_hash` telah terisi oleh installer.
- Jika install berhenti sebelum hash, ulangi installer; seed idempotent.
- Periksa lockout dan waktu `locked_until`.
- Jangan menyetel hash manual atau menyimpan plaintext dalam SQL.

## Backup gagal

- Periksa ruang dan permission `data/backups`.
- Pastikan backup key tersedia dan konsisten.
- Backup memakai logical export bawaan melalui satu snapshot PostgreSQL; `pg_dump` bukan dependency.
- Backup gagal tidak boleh meninggalkan artifact yang terlihat valid; file staging harus berbeda suffix dan dihapus/ditandai incomplete.

## Restore gagal

- Jangan mengulang restore buta.
- Pertahankan rescue backup dan log correlation ID.
- Bedakan kegagalan preflight (database belum berubah) dengan kegagalan setelah downtime.
- Verifikasi key, AEAD tag, checksum, format version, schema compatibility, dan target database.
- Bila health pascarestore gagal, biarkan worker berhenti sampai consistency check selesai.

## Data yang aman dilampirkan saat eskalasi

- versi release/runtime/OS tanpa hostname privat;
- output doctor yang telah di-redact;
- event/error code dan correlation ID;
- jumlah job per status;
- schema migration version/checksum, bukan connection URL.

Jangan lampirkan `.env`, QR, cookie, JWT, API key, token tunnel, password, database URL, plaintext message pribadi, atau auth-state ciphertext bila tidak diperlukan.

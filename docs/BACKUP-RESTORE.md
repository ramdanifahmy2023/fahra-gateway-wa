# Backup dan Restore Workspace-Local

Artifact `.ocgwb` adalah envelope `OCGWB1` yang dikompresi dengan gzip dan dienkripsi AES-256-GCM. Envelope memuat checksum SHA-256 untuk clear payload, compressed payload, dan ciphertext. Setiap file di dalam manifest juga membawa ukuran dan SHA-256 sendiri.

## Cakupan durable

Manifest versi 2 memuat tabel dalam urutan dependency: admin/auth, identitas agent, konfigurasi, koneksi dan auth WhatsApp, group/participant, upload metadata, `queue_jobs` sebelum `whatsapp_messages`, attempt, delivery event, integration outbox, response OpenClaw, audit, dan operational log.

Kebijakan tabel yang tidak masuk artifact:

- `runtime_instances`: state proses ephemeral; dibersihkan saat restore dan dibuat ulang oleh runtime.
- `backup_records`: history artifact/operation milik workspace target; dipertahankan. Restore hanya memperbarui row operation yang diberikan melalui `--operation-id`.

File `data/whatsapp/` dicadangkan rekursif sebagai file owner-only, kecuali `qr.png`, `qr.json`, `status.json`, temporary variant-nya, dan marker repository `.gitkeep` pada root data. Auth Baileys utama tetap berada dalam `whatsapp_auth_state` yang sudah terenkripsi. Isi `data/uploads/` hanya disertakan bila direferensikan pesan/job outbound recoverable (`queued`, `processing`, `retrying`, `failed`, `dead`, atau `dead_letter`). Semua source file dibuka dengan `O_NOFOLLOW`, diperiksa realpath containment, owner/mode, ukuran, dan hash.

## Backup

```bash
npm run backup
```

Command langsung otomatis membuat row `backup_records` agar hasilnya tampil di Dashboard. Dump memakai satu dedicated PostgreSQL client dengan transaksi `REPEATABLE READ`, mengambil table lock `SHARE`, lalu membaca dengan server-side cursor. Lock sengaja menahan writer selama snapshot database dan file agar encrypted inbound spool tidak hilang di celah commit. Transaksi tidak menjalankan DML, tetapi tidak dideklarasikan SQL `READ ONLY` karena PostgreSQL melarang `LOCK TABLE ... SHARE` pada transaksi read-only. Artifact ditulis mode `0600`, di-`fsync`, lalu dipublikasikan atomik tanpa overwrite melalui hard link di `data/backups/`.

Worker asynchronous memakai `--backup-id=<uuid>`. Script mengambil PostgreSQL advisory lock per operation, mengubah row menjadi `running`, dan memakai nama canonical `openclaw-gateway-<backup-id>.ocgwb`. Retry akan menghapus temporary file milik operation, memvalidasi serta menggunakan kembali artifact canonical yang sudah selesai ditulis, atau mengembalikan row `completed` yang checksum/AEAD/manifest-nya masih valid. Dengan demikian crash setelah atomic rename tetapi sebelum update database tidak menghasilkan artifact kedua. Backup juga mengambil shared advisory lock lifecycle/migration sampai snapshot database dan file selesai dibentuk; restore mengambil lock yang sama secara exclusive.

### Backup otomatis

Singleton maintenance worker memeriksa jadwal setiap lima menit. Setelah pukul 02:00 pada `locale.timezone` (fallback `Asia/Jakarta`), worker membuat maksimal satu backup otomatis untuk minggu lokal tersebut. Row otomatis ditandai melalui metadata `{ "schedule": "weekly", "scheduledDate": "YYYY-MM-DD", "scheduledWeek": "YYYY-Www" }`; queue memakai dedupe key `backup-weekly:YYYY-Www` dan tetap menjalankan `scripts/backup.mjs`, sehingga format, enkripsi, lock, retry, dan atomic publication sama dengan backup manual.

Retention mempertahankan tujuh backup otomatis mingguan completed terbaru. Backup manual, safety backup, artifact yang belum completed, dan backup yang pernah menjadi sumber restore tidak dipilih oleh retention otomatis. Penghapusan dilakukan artifact dahulu, kemudian row `backup_records`; kegagalan file tidak menghapus metadata DB. Tidak ada cron OS atau konfigurasi scheduler terpisah.

Verifikasi operasi:

```sql
SELECT id,status,filename,metadata,completed_at
FROM backup_records
WHERE operation='backup'
ORDER BY created_at DESC
LIMIT 10;
```

Rollback scheduler: kembalikan perubahan `maintenance-worker.ts` dan `backup-maintenance-policy.ts`, jalankan `npm run verify`, lalu restart gateway melalui prosedur normal. Rollback kode tidak menghapus artifact yang sudah dibuat. Jangan menghapus artifact manual sebagai bagian rollback.

## Restore operator

```bash
npm run restore -- openclaw-gateway-<timestamp>.ocgwb --yes
```

Nama file wajib diberikan eksplisit. Script tidak memilih “backup terbaru” secara implisit karena pemilihan yang ambigu tidak aman untuk operasi destruktif.

Tanpa `--skip-safety`, restore selalu membuat safety backup sebelum downtime. Sebelum service dihentikan, restore sudah memvalidasi AEAD/checksum, manifest, seluruh base64/path/hash file, migration filename/checksum, bentuk kolom target, topology file/directory, dan staging file owner-only. `.env` serta file artifact/session/upload dibuka non-symlink dengan pemeriksaan owner, mode, inode, realpath, ukuran, dan hash.

Di dalam satu dedicated-client transaction, restore:

1. mengambil advisory lock migration/restore serta `ACCESS EXCLUSIVE` lock seluruh graph tabel agar writer non-kooperatif tidak dapat mencampur snapshot;
2. mempertahankan `backup_records`, mengosongkan durable snapshot secara reverse dependency, lalu import dependency-order;
3. menyelesaikan self-FK `admin_refresh_tokens.replaced_by` dan `whatsapp_messages.reply_to_message_id` pada pass kedua dengan USER update-trigger dinonaktifkan secara transactional agar timestamp artifact tetap exact;
4. menjalankan resequence identity columns;
5. merevoke seluruh refresh token dengan reason `restore`;
6. membatalkan stale `maintenance`, `whatsapp-control`, dan queue non-allowlisted; hanya lease `whatsapp-outbound` dan `openclaw-events` yang dipulihkan;
7. me-reset integration outbox yang tertinggal pada `processing`;
8. memindahkan seluruh regular file target di `data/whatsapp/` dan `data/uploads/` ke staging rollback, lalu mengaktifkan hanya file artifact melalui atomic rename sebelum database commit.

Artinya file upload target yang tidak masuk artifact tidak dibiarkan sebagai data stale/orphan; row metadata tanpa file recoverable ditandai `deleted`. Marker root `.gitkeep` bukan state aplikasi dan dipertahankan. Sesudah commit, migration runner dijalankan kembali, service dimulai, lalu Gateway API, Baileys live endpoint, dan Dashboard diperiksa. Kegagalan sebelum commit me-rollback database, mengembalikan seluruh file lama dari staging, dan mencoba menyalakan service kembali hanya bila konsistensi database/file sudah terbukti. Hasil COMMIT yang ambigu atau rollback file yang tidak lengkap selalu dibiarkan fail-closed dengan staging tetap tersedia.

## Kontrak operation ID

Pemanggil asynchronous harus membuat row `backup_records` terpisah dengan `operation='restore'`, filename request yang unik, dan status `queued`, lalu menjalankan:

```bash
node scripts/restore.mjs <artifact.ocgwb> --yes --operation-id=<restore-operation-uuid>
```

Script mengubah status menjadi `restoring`, lalu `completed` hanya setelah start dan health check berhasil, atau `failed` dengan error setelah hasil nyata. Jangan memakai ID row source backup sebagai operation ID.

Worker maintenance memakai handoff internal terautentikasi agar coordinator restore tidak menjadi child proses yang ikut dihentikan PM2/fallback runner. Argumen internalnya adalah `--handoff-parent-pid=<pid>` dan `--handoff-job-id=<uuid>` bersama `--operation-id`; token acak hanya dikirim melalui `OCGW_RESTORE_HANDOFF_TOKEN`, tidak melalui argv atau log. Marker owner-only menjalani phase `ready -> granted -> stopping -> restoring -> committed -> starting -> verifying -> completed`. Parent harus memberi grant durable dan benar-benar keluar sebelum coordinator boleh memulai downtime.

Command operator langsung juga membuat journal owner-only (mulai dari phase `granted`) dengan artifact checksum dan path staging. Karena itu crash/power-loss tidak membuat `start`, `stop`, maintenance, backup, atau restore kedua berjalan di atas state parsial. Marker pre-downtime/terminal yang coordinator-nya terbukti sudah mati dibersihkan aman bersama staging; marker nonterminal `stopping` sampai `recovery_start` tetap fail-closed untuk pemeriksaan operator. Jangan menghapus journal atau staging nonterminal secara refleks. Cocokkan `context.sourceFilename`, `context.artifactSha256`, `context.stageRelativePath`, row `backup_records`, safety backup terbaru, serta event `backup.restore_committed` di `operational_logs`; pulihkan dari safety artifact setelah status COMMIT/file ditentukan. Jika belum dapat dibuktikan, biarkan service berhenti dan pertahankan staging. Prosedur phase-by-phase ada di [Troubleshooting](./TROUBLESHOOTING.md#restore-journal-tertinggal).

## Batas memori eksplisit

Format saat ini memakai pagewise database reads tetapi container terenkripsi masih dibentuk sebagai bounded in-memory payload; implementasi ini belum streaming end-to-end. Agar tidak terjadi pertumbuhan memori tanpa batas, proses berhenti dengan error bila cap terlampaui.

| Environment                   |   Default |
| ----------------------------- | --------: |
| `BACKUP_MAX_ARTIFACT_BYTES`   |  67108864 |
| `BACKUP_MAX_CLEAR_BYTES`      |  50331648 |
| `BACKUP_MAX_FILE_BYTES`       |  26214400 |
| `BACKUP_MAX_TOTAL_FILE_BYTES` |  29360128 |
| `BACKUP_MAX_FILES`            |      5000 |
| `BACKUP_MAX_ROW_BYTES`        |   2097152 |
| `BACKUP_MAX_TABLE_ROWS`       |    250000 |
| `BACKUP_MAX_TOTAL_ROWS`       |    500000 |
| `BACKUP_PAGE_ROWS`            |       500 |
| `BACKUP_MAX_WORKING_BYTES`    | 536870912 |

`BACKUP_PAGE_ROWS` adalah batas yang diminta; script menurunkannya secara dinamis berdasarkan ukuran row maksimum yang dihitung di server, `BACKUP_MAX_ROW_BYTES`, dan `BACKUP_MAX_WORKING_BYTES` (default worst case 4 row, hingga 500 untuk row kecil). Server-side cursor membuat traversal tetap linear tanpa `LIMIT/OFFSET` berulang. Konfigurasi yang estimasi aggregate-nya melewati working budget ditolak sebelum dump. Sesuaikan cap di `.env` dengan RAM workspace dan retention data sebelum produksi. Kenaikan cap meningkatkan peak memory karena object graph, JSON, gzip, ciphertext, dan base64 dapat hidup bersamaan. Estimasi ini konservatif tetapi bukan pengukuran RSS eksak; untuk artifact lebih besar diperlukan container streaming generasi berikutnya.

## Kompatibilitas dan batasan

- Artifact lama tanpa manifest versi 2 ditolak; buat backup baru sebelum upgrade.
- `DATABASE_URL` wajib menunjuk PostgreSQL direct atau session-pooling. Transaction/statement pooling tidak mempertahankan session advisory lock dan sengaja ditolak. Pemeriksaan hostname/port/query URL hanya best-effort; gunakan URL direct/session resmi provider. `DATABASE_POOL_MODE=session` hanya untuk false positive setelah provider mengonfirmasi session affinity.
- Target wajib memiliki set filename dan checksum migration yang persis sama dengan artifact. Target superset ditolak karena migration baru dapat menambah type/domain/UNIQUE/CHECK/FK/trigger yang tidak dapat dibuktikan kompatibel hanya dari riwayat filename. Untuk restore lintas versi: samakan schema target, lakukan restore, lalu jalankan upgrade aplikasi/migration sebagai langkah terpisah.
- Target wajib mempertahankan tiga kunci workspace source: `BACKUP_ENCRYPTION_KEY` untuk membuka artifact, `SESSION_ENCRYPTION_KEY` untuk `agent_tools.config_encrypted`/`ai_providers.api_key_encrypted` dan secret aplikasi lain, serta `WHATSAPP_SESSION_ENCRYPTION_KEY` untuk auth/spool Baileys. Kunci tidak disimpan atau di-rewrap di artifact. Konfirmasi HMAC untuk dua domain data terenkripsi diverifikasi sebelum downtime dan mismatch membatalkan restore.
- Isi upload yang tidak lagi direferensikan pesan/job recoverable memang tidak masuk artifact. Karena restore mengganti penuh direktori upload aktif, file non-recoverable tersebut juga tidak dipulihkan oleh artifact maupun safety backup yang memakai kebijakan sama; gunakan retention/arsip terpisah bila file itu harus dipertahankan.
- PostgreSQL tidak dapat rollback setelah COMMIT sukses. Bila migration/start/health gagal sesudah commit, script menandai operation gagal dan safety backup menjadi jalur rollback operator.

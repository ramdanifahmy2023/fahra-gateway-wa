# ADR-001 — PostgreSQL sebagai sumber kebenaran antrean

**Status:** Diterima  
**Tanggal:** 2026-08-09

## Konteks

Deployment target adalah workspace OpenClaw yang tidak menjamin Redis tersedia dan tidak mengizinkan installer memasang service sistem. Pada saat yang sama, pesan yang sudah diterima untuk diproses atau dikirim tidak boleh hilang ketika Redis, WhatsApp, OpenClaw, atau proses aplikasi terputus.

Memakai Redis sebagai satu-satunya antrean akan membuat durability bergantung pada konfigurasi persistence Redis yang berada di luar kendali workspace. Menulis payload yang sama ke Redis dan PostgreSQL tanpa protokol commit terdistribusi juga menambah kondisi dual-write yang dapat menghasilkan job hilang atau ganda.

## Keputusan

PostgreSQL 14+ menjadi sumber kebenaran untuk seluruh job durable, lease, attempts, backoff, dedupe, idempotency, dan status terminal. Worker memakai transaksi, `FOR UPDATE SKIP LOCKED`, lease kedaluwarsa, dan advisory lock untuk concurrency.

Installer tetap melakukan discovery dan health check Redis sesuai urutan managed/environment/lokal. Bila tersedia, Redis hanya boleh dipakai untuk wake-up atau koordinasi yang dapat direkonstruksi; payload recoverable tidak boleh hanya berada di Redis. Bila Redis tidak tersedia, worker melakukan polling PostgreSQL dengan interval terkonfigurasi.

## Alasan teknis

- Acknowledge inbound/outbound dapat dilakukan dalam transaksi yang sama dengan message dan job.
- Tidak ada dual-write Redis/PostgreSQL pada jalur durability.
- Recovery tetap bekerja ketika Redis tidak tersedia atau kehilangan persistence.
- Tidak memerlukan daemon tambahan di workspace.
- Backup/restore dapat mengambil snapshot konsisten dari satu sumber data durable.

## Konsekuensi

- PostgreSQL wajib tersedia; Redis tetap opsional.
- Latensi dequeue fallback bergantung pada `QUEUE_POLL_MS`.
- Tuning index, pool, retention, dan vacuum PostgreSQL menjadi bagian operasi.
- Jika wake-up Redis ditambahkan, event wake-up harus dianggap hint dan aman hilang.

## Rollback

Perubahan ke Redis-primary memerlukan migration queue, protokol outbox/commit yang mencegah dual-write, recovery drill, dan backup kompatibel. Tanpa itu, perubahan tidak boleh dilakukan hanya sebagai penggantian driver konfigurasi.

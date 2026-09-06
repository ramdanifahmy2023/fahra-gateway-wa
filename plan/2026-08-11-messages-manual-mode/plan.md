# Plan — Manual Mode Messages

## Tujuan
Admin bisa mengambil alih chat tertentu supaya AI tidak membalas otomatis, lengkap dengan pause sementara dan daftar chat yang butuh balasan admin.

## Tahap 1 — Manual mode permanen
- Tambah status per nomor: AI aktif / manual mode.
- Tombol di header chat: Ambil alih manual / Aktifkan AI.
- Jika manual mode aktif, pesan masuk tidak diteruskan ke AI.

## Tahap 2 — Manual mode sementara
- Tambah pilihan pause: 30 menit, 1 jam, 24 jam.
- Setelah waktu habis, AI aktif lagi otomatis.

## Tahap 3 — Inbox butuh balasan admin
- Tambah filter cepat “Butuh balasan admin”.
- Chat manual mode / pesan inbound yang belum dibalas admin lebih mudah ditemukan.

## Data yang ditambah
- `contact_memory.ai_paused_until`
- `contact_memory.ai_pause_reason`
- `contact_memory.handled_by`
- `contact_memory.needs_admin_reply`

## Verifikasi
- Migrasi database.
- Typecheck gateway-api + dashboard.
- Build.
- Restart live.
- Status semua service online.

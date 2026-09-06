# Messages Page — Manual Mode & Manual Reply

Last updated: 2026-08-11

## Status live
Versi source code saat ini sudah memuat perbaikan terakhir untuk halaman `/messages`.

## Fitur yang sudah masuk

### 1. Layout Messages
- Daftar chat di kiri punya scroll sendiri.
- History chat di kanan punya scroll sendiri.
- Form balasan manual berada di bawah chat aktif.
- Klik chat otomatis mengisi penerima.
- Pesan inbound bisa dibalas memakai tombol `Balas`.
- Reply/quote memakai `replyTo` dan `replyToParticipant`.

### 2. Manual mode permanen
- Admin bisa ambil alih chat memakai tombol `Ambil alih manual`.
- Saat manual mode aktif, AI tidak membalas chat itu.
- Pesan masuk tetap tersimpan di history.
- Admin bisa menyalakan AI lagi memakai tombol `Aktifkan AI lagi`.

### 3. Manual mode sementara
- Pause tersedia: `30m`, `1j`, `24j`.
- Setelah waktu habis, pesan baru berikutnya boleh diproses AI lagi.

### 4. Inbox butuh balasan admin
- Chat manual / butuh admin diberi label `butuh admin`.
- Ada filter `Butuh balasan admin`.
- Setelah admin mengirim balasan manual, label butuh admin dibersihkan.

### 5. Anti AI nimbrung
- Saat admin mengirim balasan manual, chat otomatis masuk manual mode permanen.
- Pending queue AI untuk chat itu dibatalkan.
- Saat manual mode dinyalakan dari tombol, pending queue AI juga dibatalkan.
- Saat AI dinyalakan lagi, pesan lama tidak di-replay otomatis; hanya pesan baru yang diproses.

## File utama
- Dashboard UI: `apps/dashboard/src/components/features/messages-center.tsx`
- Messages API: `apps/gateway-api/src/modules/messages.ts`
- Contact memory API: `apps/gateway-api/src/modules/contact-memory.ts`
- Inbound handler: `apps/gateway-api/src/modules/internal.ts`
- Migrasi DB: `database/migrations/0006_manual_mode.sql`

## Dokumentasi kerja
- `plan/2026-08-11-messages-page-improvements/`
- `plan/2026-08-11-messages-manual-mode/`
- `plan/2026-08-11-manual-mode-audit-fix/`

## Verifikasi terakhir
- Typecheck gateway API lulus.
- Typecheck dashboard lulus.
- Build lulus.
- Restart live sukses.
- Semua service online.

## Catatan packing source code
Saat source code dipacking / didistribusikan, pastikan folder berikut ikut:
- `apps/`
- `database/migrations/`
- `docs/`
- `plan/`
- `scripts/`
- `packages/`
- `package.json`
- `package-lock.json`

Jangan sertakan:
- `.runtime/`
- `data/`
- file `.env` asli
- log runtime

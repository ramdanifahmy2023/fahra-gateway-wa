# Maintenance — Audit Fix Manual Mode Messages

Setelah fix:
- Test admin kirim manual tanpa klik Manual dulu: AI harus pause.
- Test tombol Aktifkan AI muncul setelah manual mode aktif.
- Test Aktifkan AI: pesan baru berikutnya boleh diproses AI.
- Pastikan pesan lama tidak di-replay otomatis.

## Packing source code
- Sertakan `docs/MESSAGES-MANUAL-MODE.md` sebagai ringkasan versi terakhir.
- Sertakan migrasi `database/migrations/0006_manual_mode.sql`.
- Jangan sertakan `.runtime/`, `data/`, `.env` asli, atau log runtime.

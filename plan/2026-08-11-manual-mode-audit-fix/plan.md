# Plan — Audit Fix Manual Mode Messages

## Masalah dari user
- Balas manual sudah bisa.
- Tombol hidupkan AI lagi tidak terlihat / tidak muncul jelas.
- Setelah admin balas manual, AI masih ikut membalas.

## Temuan audit
1. Status manual mode di UI rawan tidak terbaca
   - Data conversation dari API memakai nama field campuran.
   - UI mencari `remoteJid` saja untuk chat aktif.
   - Jika data yang datang `remote_jid`, UI gagal mengenali chat aktif.
   - Akibatnya tombol `Aktifkan AI` tidak muncul.

2. Manual reply belum otomatis mengambil alih chat
   - Admin bisa mengirim manual reply tanpa menekan tombol `Manual` dulu.
   - Sistem masih menganggap AI aktif.
   - Akibatnya AI tetap boleh membalas pesan masuk berikutnya.

3. Job AI yang sudah antre / sedang proses belum dibatalkan
   - Kalau pesan inbound sudah masuk antrean AI sebelum admin klik manual/balas manual, AI masih bisa membalas.
   - Manual mode hanya mencegah pesan berikutnya, belum menghentikan antrean lama.

4. Tombol mode kurang eksplisit
   - UI hanya menampilkan `Aktifkan AI` saat status manual terbaca.
   - Kalau status gagal terbaca, admin tidak punya kontrol jelas.

## Target perbaikan
1. UI selalu bisa membaca status chat aktif dengan aman.
2. Tombol mode selalu jelas:
   - `Manual aktif`
   - `Aktifkan AI lagi`
   - `AI aktif`
3. Saat admin kirim balasan manual:
   - otomatis aktifkan manual mode untuk kontak itu.
   - bersihkan antrean AI pending untuk kontak itu.
4. Saat manual mode dinyalakan:
   - pending job AI untuk kontak itu dibatalkan.
   - pesan inbound pending ditandai manual/ignored, bukan dibalas AI.
5. Saat AI dihidupkan lagi:
   - hanya pesan baru setelah itu yang diproses AI.
   - pesan lama tidak di-replay otomatis supaya tidak dobel balas.

## Implementasi minimal
- Backend:
  - perbaiki endpoint manual-mode agar juga membatalkan queue `openclaw-events` pending untuk JID tersebut.
  - saat outbound manual dari admin, otomatis set manual mode permanen.
  - jangan lakukan ini untuk outbound dari OpenClaw/AI.
- Dashboard:
  - cari selected conversation pakai `remoteJid` atau `remote_jid`.
  - tampilkan kontrol AI/manual lebih jelas.
  - setelah kirim manual, refresh conversation state.

## Verifikasi
- Typecheck gateway-api.
- Typecheck dashboard.
- Build.
- Restart.
- Status service online.
- Uji manual ringan via DB/API jika memungkinkan.

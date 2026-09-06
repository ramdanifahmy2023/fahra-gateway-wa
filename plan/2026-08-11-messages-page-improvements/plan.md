# Plan — Perbaikan Messages Page

## Tujuan
Membuat halaman `/messages` lebih mudah dipakai admin: daftar chat rapi, history chat punya scroll sendiri, admin bisa balas manual dari chat yang sedang dibuka, dan bisa reply/quote pesan tertentu.

## Scope
1. Layout seperti chat app:
   - kiri: daftar percakapan
   - kanan: history chat
   - bawah kanan: form balasan manual
2. Scroll terpisah:
   - daftar percakapan scroll sendiri
   - isi chat scroll sendiri
3. Manual reply:
   - klik chat otomatis memilih penerima
   - form balasan muncul di bawah chat aktif
   - kirim tetap lewat queue WhatsApp
4. Reply/quote pesan:
   - tombol Balas pada bubble pesan
   - preview pesan yang sedang dibalas
   - kirim `replyTo` dan `replyToParticipant`
5. Filter kecil:
   - direction filter dipakai oleh conversation API
   - tanggal akhir dibuat sampai akhir hari

## Di luar scope
- Pause AI otomatis per kontak belum diubah dulu. Ini butuh desain handoff supaya tidak salah mematikan agent.
- Attachment composer tetap dipertahankan, tapi fokus utama teks manual.

## File utama
- `apps/dashboard/src/components/features/messages-center.tsx`
- `apps/gateway-api/src/modules/messages.ts`
- `plan/2026-08-11-messages-page-improvements/*`

## Verifikasi
- Typecheck dashboard + gateway-api
- Build full project
- Restart live service
- Status service online

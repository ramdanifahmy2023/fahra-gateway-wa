# Evaluation — Manual Mode Messages

## Status
Selesai deploy live.

## Tahap 1 — Manual mode permanen
Selesai.
- Admin bisa klik `Manual` pada chat aktif.
- AI pause untuk kontak itu sampai admin klik `Aktifkan AI`.
- Pesan baru tetap masuk history, tapi tidak diteruskan ke AI.

## Tahap 2 — Manual mode sementara
Selesai.
- Tombol pause tersedia: `30m`, `1j`, `24j`.
- Setelah waktu habis, pesan berikutnya diproses AI lagi.

## Tahap 3 — Inbox butuh balasan admin
Selesai.
- Chat ditandai `butuh admin`.
- Ada filter cepat `Butuh balasan admin`.
- Inbound saat manual mode otomatis masuk daftar butuh admin.

## Verifikasi
- `npm run typecheck --workspace=@ocgw/gateway-api` lulus.
- `npm run typecheck --workspace=@ocgw/dashboard` lulus.
- `npm run migrate` menerapkan `0006_manual_mode.sql`.
- `npm run build` lulus.
- `npm run restart` lulus.
- `npm run status` semua service online.

## Catatan
- Marker `butuh admin` otomatis hilang setelah admin mengirim balasan manual.
- Tombol “sudah dibalas” terpisah belum diperlukan saat ini.

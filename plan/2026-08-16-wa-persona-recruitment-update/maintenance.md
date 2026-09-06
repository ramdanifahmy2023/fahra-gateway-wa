# Maintenance: WA Persona Recruitment Update

Tanggal: 2026-08-16

## Status Maintain
- Live update selesai dan terverifikasi.
- Tidak perlu restart; `/internal/agent/brief` membaca DB live.

## Yang Diamati
Pantau setelah live update:
- Kandidat bertanya lowongan tapi dijawab hanya Internet Marketing.
- Kandidat AI Content Creator mendapat jawaban terlalu umum.
- AI menyebut detail gaji/jadwal/benefit tidak resmi.
- Jawaban terlalu panjang atau pakai markdown.
- Kandidat sudah isi form tapi AI tidak minta posisi yang dilamar.

## Jadwal Cek
- 24 jam setelah live update: sampling 10-20 chat kandidat terbaru.
- 7 hari setelah live update: audit FAQ yang sering ditanya.

## Improvement Backlog
- Tambah knowledge khusus portofolio AI Content Creator jika afahmy mau.
- Tambah knowledge contoh tugas harian tiap divisi.
- Tambah short-answer templates untuk kandidat yang bingung memilih posisi.
- Tambah FAQ tools AI yang diutamakan kalau sudah ada kebijakan resmi.

## Rollback
- Restore dari `references/wa-persona-recruitment-update-2026-08-16/pre-update.json` bila ada regresi besar.
- Setelah rollback, verify `/internal/agent/brief`, synthetic QA, dan `npm run doctor`.

## Auto-fix vs Human-review
- Auto-fix: typo, wording lebih natural, konsistensi lowongan aktif.
- Wajib approval afahmy: gaji, kuota, alamat detail, perubahan link form, broadcast, auto-reply massal.

# Blueprint: WA Persona Recruitment Update

Status: draft-plan-only
Tanggal: 2026-08-16
Owner: fahra oc

## 1. What
Perbaiki persona/knowledge WA Baileys `Neng fahra` supaya rekrutmen aktif tidak hanya Internet Marketing, tapi juga:

1. Divisi Marketing Digital
2. AI Content Creator

## 2. Why
Persona dan knowledge saat ini masih mengarah ke satu lowongan lama: Internet Marketing. Jika kandidat bertanya lowongan terbaru, AI bisa memberi info kurang lengkap atau salah fokus.

## 3. Current State
Hasil inspeksi live database gateway:

- `agent_profile.name`: `Neng fahra`
- `agent_profile.revision`: 5
- Persona/jobdesk/system instruction masih menyebut lowongan aktif hanya Internet Marketing.
- Knowledge aktif terkait lowongan:
  - `Informasi Lowongan / Lowongan yang Tersedia`
  - `Karier / HRD - FAQ Balasan Pelamar`
  - `Karier / HRD - Profil Perusahaan dan Lowongan Digital Marketing`
  - knowledge pendukung alur, keamanan, status, kompensasi, privasi, interview.

## 4. Asumsi vs Keputusan
- Asumsi: link pendaftaran tetap `https://karir.fahmyid.com`.
- Asumsi: lokasi kerja tetap Kota Tasikmalaya.
- Asumsi: jam kerja, gaji, benefit tetap jangan disebut detail kecuali sudah ada info resmi.
- Keputusan sementara: `Internet Marketing` diperlakukan sebagai bagian/alias dari `Divisi Marketing Digital`, bukan posisi terpisah ketiga, kecuali afahmy mengoreksi.
- Keputusan sementara: `AI Content Creator` adalah lowongan baru yang boleh disebut aktif.

## 5. Scope
### In scope
- Backup snapshot `agent_profile` dan `knowledge_items` sebelum perubahan.
- Revisi `agent_profile.persona` agar tetap manusiawi, HRD, WhatsApp-friendly, tapi lowongan aktif menjadi multi-posisi.
- Revisi `agent_profile.jobdesk` agar bisa menjawab dua divisi rekrutmen.
- Revisi `agent_profile.system_instruction` agar tidak lagi hard-code hanya Internet Marketing.
- Revisi knowledge lowongan/FAQ/profil kerja agar menyebut:
  - Staff/Divisi Marketing Digital
  - AI Content Creator
- Tambah detail aman untuk AI Content Creator: membuat ide konten, script/caption, visual brief, editing ringan, tren sosmed, AI tools, koordinasi dengan marketing.
- Tambah detail aman untuk Marketing Digital: marketplace, promosi, voucher, campaign, laporan, optimasi produk.
- Uji dengan prompt sintetis kandidat.

### Out of scope
- Mengubah form `karir.fahmyid.com`.
- Mengirim broadcast/reply WA ke kandidat.
- Mengubah jadwal, gaji, benefit, kuota, alamat detail tanpa data resmi.
- Mengubah bridge worker, provider, Cloudflare tunnel, backup, atau scheduler.

## 6. Acceptance Criteria
- [ ] Backup current DB identity/knowledge tersimpan lokal, secret-free.
- [ ] Persona tidak lagi menyebut hanya Internet Marketing sebagai satu-satunya lowongan.
- [ ] Jawaban lowongan menyebut Marketing Digital dan AI Content Creator.
- [ ] Sistem tetap melarang janji diterima/lolos/interview/gaji/detail sensitif.
- [ ] Format WhatsApp tetap no markdown, pendek, natural.
- [ ] Knowledge aktif konsisten dengan persona.
- [ ] Synthetic QA minimal 8 pertanyaan PASS.
- [ ] `npm run doctor` PASS setelah update, bila service disentuh/di-restart tidak perlu kecuali ada kebutuhan.

## 7. Risiko
| Risiko | Dampak | Mitigasi |
|---|---|---|
| Info posisi kurang tepat | Kandidat mendapat ekspektasi salah | Pakai wording umum, tandai detail resmi lewat HRD/interview |
| AI menyebut gaji/jadwal/benefit tidak resmi | Risiko HR/komplain | Perkuat system instruction larangan mengarang |
| Knowledge lama konflik | Jawaban campur versi lama | Update semua knowledge terkait lowongan, bukan hanya persona |
| Markdown masuk ke WA | Tampilan tidak natural | Pertahankan aturan no markdown di persona/system |
| DB update salah | Persona rusak | Backup snapshot + update revision-aware + verify readback |

## 8. Approval Gate
- Agent kerjakan sendiri: backup, draft teks, dry-run, update DB identity/knowledge setelah afahmy bilang gas.
- Butuh approval afahmy: eksekusi live update persona/knowledge di gateway DB, kalau plan ini sudah cocok.
- Butuh data tambahan jika mau presisi: kuota, syarat khusus AI Content Creator, portofolio wajib/tidak, skill tools AI yang diutamakan, remote/on-site.

## 9. Proposed Copy Direction
### Lowongan aktif baru
Jawaban standar lowongan:

Saat ini PT FahmyID Digital Group sedang membuka rekrutmen untuk Divisi Marketing Digital dan AI Content Creator. Untuk Marketing Digital, fokusnya membantu optimasi produk, promo, marketplace, dan laporan sederhana. Untuk AI Content Creator, fokusnya membuat ide konten, caption/script, visual brief, serta bantu produksi konten dengan tools AI. Pendaftaran resmi lewat https://karir.fahmyid.com, lalu kabari lagi di sini kalau sudah terkirim, nya.

### Persona direction
- Tetap `Neng fahra`, asisten AI HRD tahap awal.
- Bahasa Indonesia santai, Sunda tipis bila cocok.
- Jawaban 1-4 kalimat.
- Jangan terlihat seperti template.
- Kalau kandidat tanya posisi mana cocok, bantu jelaskan beda tugas secara umum lalu arahkan isi form.

## 10. Rollback Plan
- Simpan snapshot sebelum update: `references/wa-persona-recruitment-update-2026-08-16/pre-update.json`.
- Jika hasil buruk, restore `agent_profile` dan `knowledge_items` terkait dari snapshot, lalu verify `/internal/agent/brief` dan synthetic QA.

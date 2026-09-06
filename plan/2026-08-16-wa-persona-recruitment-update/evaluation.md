# Evaluation: WA Persona Recruitment Update

Tanggal: 2026-08-16

## Hasil vs Acceptance Criteria
| Kriteria | Status | Catatan |
|---|---|---|
| Backup current DB identity/knowledge | ✅ | `pre-update.json` 34.617 bytes |
| Persona tidak lagi menyebut hanya Internet Marketing | ✅ | Revision 6; active jobs Marketing Digital + AI Content Creator |
| Jawaban lowongan menyebut Marketing Digital dan AI Content Creator | ✅ | Synthetic chat QA case 1 PASS |
| Sistem tetap melarang janji diterima/lolos/interview/gaji/detail sensitif | ✅ | Policy QA PASS; salary/status answers safe |
| Format WhatsApp no markdown, pendek, natural | ✅ | Rule retained in profile + system instruction |
| Knowledge aktif konsisten | ✅ | 6 knowledge items updated; stale hard-code count 0 |
| Synthetic QA minimal 8 pertanyaan | ✅ | 8/8 PASS |
| `npm run doctor` | ✅ | Semua pemeriksaan lulus |

## What Went Well
- Live mutation dibatasi ke DB identity/knowledge saja; tidak menyentuh bridge, tunnel, scheduler, auth, atau backup system.
- Backup ada sebelum update.
- QA tidak hanya string check; synthetic chat call juga dijalankan ke model `wa-hrd`.

## What Could Be Improved
- Detail posisi AI Content Creator masih aman/umum. Bisa diperinci setelah afahmy memberi kuota, portofolio, tools, sistem kerja, dan syarat khusus.

## Lesson Learned
- Untuk WA HRD, update persona harus satu paket dengan knowledge FAQ/profil/alur; kalau tidak, prompt bisa konflik.

## Keputusan
- `Internet Marketing` diposisikan sebagai bagian/fokus dari Divisi Marketing Digital.
- `AI Content Creator` menjadi lowongan aktif baru.
- Gaji, benefit, jadwal detail, kuota, dan alamat detail tetap tidak dijawab pasti oleh AI.

## Next Step
- Pantau 24 jam chat kandidat.
- Kalau afahmy kasih detail posisi, update knowledge tambahan tanpa ubah bridge.

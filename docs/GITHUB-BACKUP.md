# Menyimpan Update ke GitHub

Project ini memakai Git untuk menyimpan source code, konfigurasi contoh, migrasi database, dokumentasi, dan perubahan lain yang memang aman dibagikan ke repository:

<https://github.com/ramdanifahmy2023/fahra-gateway-wa>

Remote yang dipakai adalah `origin` dan branch utama adalah `main`.

## Bedakan Git backup dan backup aplikasi

- `git commit` dan `git push` menyimpan perubahan file project ke GitHub.
- `npm run backup` membuat artifact database dan file aplikasi terenkripsi di `data/backups/`.
- `.env`, runtime, sesi WhatsApp, log, upload, dan artifact backup berada di daftar pengecualian `.gitignore`. Jangan memaksa file tersebut masuk Git dengan `git add -f`.

GitHub bukan tempat menyimpan secret atau data operasional WhatsApp. Simpan key backup dan file `.env` di lokasi aman yang terpisah.

## Alur setiap kali ada update

Jalankan semua perintah dari root project:

```bash
cd /Users/fahra/.openclaw/workspace-fahra/openclaw-whatsapp-gateway
```

1. Ambil perubahan terbaru dari GitHub sebelum mulai bekerja:

   ```bash
   git pull --rebase origin main
   ```

2. Periksa perubahan lokal:

   ```bash
   git status --short
   git diff --check
   ```

3. Jalankan pemeriksaan sesuai ruang perubahan. Untuk perubahan kode atau konfigurasi, gunakan:

   ```bash
   npm run verify
   ```

   Untuk perubahan dokumentasi saja, `git diff --check` biasanya cukup.

4. Tinjau daftar file yang akan disimpan, lalu stage perubahan:

   ```bash
   git add -A
   git diff --cached --stat
   git diff --cached --name-only
   ```

   Pastikan tidak ada `.env`, token, credential, data WhatsApp, log, atau artifact backup di daftar tersebut.

5. Buat commit dengan pesan yang menjelaskan perubahan:

   ```bash
   git commit -m "jelaskan perubahan secara singkat"
   ```

6. Push ke GitHub:

   ```bash
   git push origin main
   ```

7. Pastikan local branch sudah bersih dan sejajar dengan GitHub:

   ```bash
   git status --short --branch
   git log -1 --oneline
   ```

Output branch yang sehat terlihat seperti `main...origin/main` tanpa daftar file berubah.

## Perintah cepat

Untuk perubahan yang sudah diperiksa dan memang siap disimpan:

```bash
git add -A && git commit -m "jelaskan perubahan secara singkat" && git push origin main
```

Tetap gunakan alur lengkap di atas bila perubahan menyentuh kode, konfigurasi, atau file yang belum dikenal.

## Jika push ditolak

Penolakan biasanya berarti ada commit baru di GitHub. Jangan gunakan force push. Jalankan:

```bash
git pull --rebase origin main
```

Jika Git menemukan konflik, selesaikan konflik pada file yang disebutkan, lalu lanjutkan:

```bash
git add <file-yang-sudah-diperbaiki>
git rebase --continue
git push origin main
```

Jika rebase harus dibatalkan:

```bash
git rebase --abort
```

Jangan memakai `git push --force` pada branch `main` kecuali ada keputusan eksplisit untuk mengganti riwayat repository.

## Jika ada perubahan lokal yang belum siap di-commit

Jangan menjalankan `git pull --rebase` secara membabi buta. Simpan pekerjaan pada branch atau commit sementara, atau gunakan stash untuk perubahan yang memang aman disimpan sementara:

```bash
git stash push -m "pekerjaan sementara"
git pull --rebase origin main
git stash pop
```

Periksa kembali hasil `git status --short` setelah `git stash pop`.

## Melihat riwayat dan memulihkan perubahan

```bash
git log --oneline --decorate --graph -20
git show --stat <commit>
```

Untuk membatalkan satu commit yang sudah dipush, gunakan commit pembalik agar riwayat tetap tercatat:

```bash
git revert <commit>
git push origin main
```

## Pemeriksaan remote

Jika perlu memastikan repository dan branch yang digunakan:

```bash
git remote -v
git branch --show-current
git ls-remote origin refs/heads/main
```

Remote yang benar:

```text
https://github.com/ramdanifahmy2023/fahra-gateway-wa.git
```

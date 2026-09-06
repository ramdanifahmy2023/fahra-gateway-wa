# Cloudflare Tunnel workspace-local

Dashboard hanya bind ke `127.0.0.1:3200`. Tunnel membuat koneksi outbound; tidak ada port inbound yang perlu dibuka.

1. Buat tunnel dan public hostname di dashboard Cloudflare Zero Trust.
2. Arahkan service hostname ke `http://127.0.0.1:3200`.
3. Isi `CLOUDFLARE_TUNNEL_TOKEN` dan `CLOUDFLARE_HOSTNAME` di `.env`.
4. Sediakan binary `cloudflared >=2025.4.0` yang sudah ada di workspace/host, atau simpan binary resmi dengan versi tersebut di `.runtime/bin/cloudflared` dan beri mode executable.
5. Jalankan `npm run restart`, lalu `npm run doctor`.

Pada instalasi baru, login dan ganti password bootstrap melalui dashboard loopback terlebih dahulu. `cloudflared` tidak akan dimulai selama database masih menandai `force_password_change=true`; setelah perubahan password, `npm run restart` mengaktifkannya secara aman.

Token disinkronkan secara atomik ke `.runtime/cloudflare-token` (mode `0600`) oleh installer maupun setiap `start/restart`, lalu diberikan melalui `--token-file`; token tidak ditempel pada command line atau source code. Rotasi token di `.env` cukup diikuti `npm run restart`.

Process manager memvalidasi output `cloudflared --version` sebelum menambahkan service. Versi di bawah 2025.4.0 atau output versi yang tidak dikenali ditahan dan dilaporkan oleh `npm run doctor`, bukan direstart berulang. Token tidak pernah digunakan sebagai argument CLI atau fallback environment.

Untuk supply-chain yang aman, operator dapat memperoleh binary dari rilis resmi Cloudflare dan wajib memverifikasi SHA-256 yang diterbitkan untuk versi serta arsitektur yang dipilih sebelum menaruhnya di `.runtime/bin/cloudflared`. Installer tidak mengunduh executable.

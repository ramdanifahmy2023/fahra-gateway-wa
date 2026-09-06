# Prompt Instalasi untuk Agent OpenClaw

Lampirkan ZIP project dan kirim prompt berikut kepada agent yang berada di workspace target. Isi hostname/token melalui secret environment atau lampiran credential aman, bukan teks chat.

```text
Gunakan ZIP OpenClaw WhatsApp Gateway yang saya lampirkan dan instal sepenuhnya di workspace Anda sendiri.

WAJIB workspace-local: jangan gunakan atau meminta root/sudo, apt, Docker, systemd, pm2 startup, jangan mengubah /etc, dan jangan membuat service global. Jangan ubah source kecuali ada blocker implementasi yang dibuktikan.

Kerjakan otomatis: verifikasi checksum/path ZIP → ekstrak ke openclaw-whatsapp-gateway → baca INSTALL.md → validasi Node/npm bootstrap dan deteksi Bun opsional untuk service kompatibel → deteksi credential PostgreSQL managed/environment/local dan uji koneksi → deteksi Redis atau gunakan PostgreSQL queue fallback → buat .env tanpa menampilkan secret → jalankan npm run install → npm run doctor → minta pemilik login melalui dashboard loopback dan mengganti password bootstrap sebelum tunnel boleh hidup → pairing QR dengan pemilik bila UI dapat diakses → jalankan Cloudflare Tunnel outbound memakai CLOUDFLARE_TUNNEL_TOKEN dan CLOUDFLARE_HOSTNAME menuju dashboard loopback → validasi HTTPS dan pastikan /internal/* tidak publik.

Jika PM2 tidak tersedia, gunakan fallback runner workspace. Jangan install PostgreSQL/Redis sendiri. Berhenti hanya bila PostgreSQL/credential wajib benar-benar tidak tersedia, secret tunnel belum diprovisikan, atau ada kegagalan keamanan. Laporkan runtime, lokasi project, schema version, mode queue, status seluruh proses, hasil doctor, URL dashboard, dan blocker tanpa membocorkan credential/token/password/QR.
```

File secret minimum biasanya berisi `DATABASE_URL`, key OpenClaw/Gateway yang cocok, dan bila diperlukan `CLOUDFLARE_TUNNEL_TOKEN` serta `CLOUDFLARE_HOSTNAME`. Agent tidak membutuhkan SSH root karena instalasi dilakukan di workspace tempat agent itu berjalan.

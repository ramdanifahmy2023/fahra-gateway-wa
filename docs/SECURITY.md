# Security Model

## Trust boundary

- Dashboard publik berhenti di Cloudflare Tunnel/Access (bila diaktifkan) dan listener Next.js loopback.
- Gateway API dan OpenClaw bridge hanya berada pada localhost/private workspace boundary.
- PostgreSQL/Redis di jaringan publik wajib memakai TLS sesuai kebijakan provider; endpoint private mengikuti trust boundary environment.
- WhatsApp/Baileys adalah external protocol boundary; seluruh payload dianggap untrusted.

## Secret inventory

| Secret | Penyimpanan | Database |
|---|---|---|
| Password admin | input sementara; hash Argon2id | hash saja |
| Refresh token | cookie HttpOnly | hash saja |
| Internal API key | secure environment | hash/prefix saja bila diregistrasi |
| JWT secret | `.env`/secret environment | tidak |
| Session master key | `.env`/secret environment | tidak |
| Baileys auth state | n/a | AES-256-GCM envelope |
| Provider/tool key | input admin | AES-256-GCM envelope |
| Tunnel token | secret environment/file | tidak |
| Backup key | secret environment terpisah | tidak |

`.env` harus owner-only dan tidak pernah masuk backup artifact secara plaintext. Back up key material melalui secret manager atau prosedur manual yang terpisah.

Service process tidak mewarisi `.env` penuh. Environment dibangun dari allowlist per service: Dashboard, Redis, dan `cloudflared` tidak menerima database/internal/session/backup secret; tunnel token diberikan melalui file `.runtime/cloudflare-token` mode `0600`. Penambahan konfigurasi baru wajib memperbarui hanya allowlist service yang benar-benar memakainya.

Managed environment diprioritaskan pada start operator dan hanya key konfigurasi terdaftar yang disinkronkan ke `.env` owner-only untuk restart/restore mandiri. Marker `OCGW_SANITIZED_SERVICE_ENV=1` membedakan child environment yang sudah disanitasi, sehingga dummy compatibility secret tidak dapat meracuni snapshot credential nyata.

`BOOTSTRAP_ADMIN_PASSWORD` hanya input bootstrap. Sesudah bootstrap berhasil, installer merotasi field `.env` tersebut ke random inert yang tidak pernah dicetak; hash password awal tetap tersimpan sampai first-login password change, dan rerun bootstrap tidak menimpa hash yang sudah ada.

## Enkripsi envelope

Ciphertext sensitif memakai format versioned yang menyertakan algorithm, random 96-bit nonce, authentication tag, ciphertext, dan AAD. AAD mengikat row ke table/record/field agar ciphertext tidak dapat dipindahkan antar-record. AES key adalah 256-bit hasil decode yang divalidasi panjangnya; tidak diturunkan dari password pendek. Rotasi master key memerlukan re-encryption terkontrol sebelum key lama dihapus.

## Authentication

- Argon2id dengan parameter yang disesuaikan kapasitas workspace dan minimum keamanan yang didokumentasikan.
- Access JWT singkat, audience/issuer eksplisit, algorithm allowlist, dan `jti`.
- Refresh token opaque, rotating family, reuse detection, hash-only storage, dan revocation saat password berubah.
- Login rate limit dan database lockout tidak bergantung pada Redis.
- First login hanya dapat mengakses password-change/logout/health yang relevan.

## Internal API

- Key minimal 256-bit CSPRNG, dibandingkan constant-time setelah parsing ketat.
- Listener loopback; `X-Forwarded-For` tidak dipercaya kecuali proxy allowlist.
- Request ID dan idempotency key wajib untuk mutasi.
- Body limit, content-type allowlist, schema validation, timeout, dan response redaction.
- Dashboard proxy mempunyai allowlist route admin dan memblokir `/internal/*` tanpa bergantung pada string-prefix yang mudah dibypass.

## Media dan path safety

- Upload disimpan dengan server-generated `stored_name`, bukan nama user.
- Path di-resolve terhadap realpath `data/uploads`; absolute path, `..`, NUL, symlink escape, dan device file ditolak.
- MIME allowlist terpisah untuk image/document; multipart parser memberlakukan size limit sebelum request diterima.
- File quarantine/incomplete tidak pernah dikirim.
- Backup mengecualikan upload default kecuali row message aktif mereferensikannya.

## Logging dan audit

Logger structured memakai daftar redaction untuk header dan field sensitif. Password, token, authorization, cookie, session, credential, QR, ciphertext, atau raw provider response sensitif tidak boleh dicatat. Error yang ditampilkan ke admin tidak memuat credential atau stack internal.

Audit log mencatat siapa, aksi, resource, hasil, timestamp, request ID, dan metadata aman. IP/user-agent dianggap data pribadi; retention dibatasi. Audit tidak menggantikan application logs dan tidak boleh dapat dimodifikasi melalui API biasa.

## Dependency dan release

- Lockfile wajib dan install memakai frozen lockfile.
- Script lifecycle dependency tidak boleh memicu deployment secara tidak sengaja saat dependency install.
- Install memakai exclusive owner-validated lock, membangun pada copy private `.runtime/staging`, lalu mengaktifkan artifact dengan rename workspace-local.
- Artifact lama ditahan di `.runtime/releases` selama health validation; artifact rollback tidak boleh diklaim sebagai rollback migration database.
- Release ZIP mengecualikan `.env`, state di `data/`, build cache, logs, backups, session, dan `node_modules`; placeholder directory kosong tetap disertakan.
- ZIP diverifikasi checksum, path traversal, symlink, permission, dan secret scan sebelum ekstraksi.
- Binary workspace disediakan operator/hosting dan harus diverifikasi checksum/signature resmi sebelum ditempatkan di `.runtime/bin`; installer tidak mengunduh executable.
- Restore journal menyimpan token otorisasi hanya sebagai SHA-256 digest; raw token hidup pada coordinator/child environment minimum dan tidak ditulis ke log. Journal, staging context, dan coordinator log wajib owner-only serta dipertahankan saat recovery fail-closed.

## Incident minimum

Jika secret diduga bocor: hentikan tunnel bila perlu, rotasi tunnel/internal/provider/JWT/session keys sesuai dampak, revoke refresh families, audit akses, dan buat backup forensik yang terenkripsi. Rotasi session master key memerlukan re-encryption auth state; mengganti key tanpa migrasi membuat session tidak dapat dibaca.

Jangan mengirim credential ke chat/log. Gunakan secret attachment atau mekanisme environment yang disediakan platform.

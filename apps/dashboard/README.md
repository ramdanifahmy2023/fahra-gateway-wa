# Dashboard OpenClaw WhatsApp Gateway

Dashboard admin Next.js untuk deployment workspace-local. Browser hanya berkomunikasi dengan route handler same-origin. `GATEWAY_API_URL` dibaca server-side dan default ke `http://127.0.0.1:3100`.

## Security model

- Access JWT dan refresh token disimpan dalam cookie `HttpOnly`, `SameSite=Strict`.
- Token tidak dikembalikan ke JavaScript browser atau `localStorage`.
- Refresh token dirotasi server-side saat Gateway API membalas `401`.
- Proxy `/api/gateway/*` memakai allowlist resource admin.
- Mutasi same-origin diverifikasi dan semua response privat memakai `Cache-Control: no-store`.
- Base URL Gateway API non-loopback ditolak kecuali operator sengaja mengaktifkan `ALLOW_REMOTE_GATEWAY_API=true`.

## Kontrak endpoint Gateway API

Dashboard mengasumsikan endpoint berikut:

| Area          | Endpoint                                                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Auth          | `POST /api/v1/auth/login`, `refresh`, `logout`, `change-password`; `GET /api/v1/auth/me`                                    |
| Overview      | `GET /api/v1/dashboard/overview`                                                                                            |
| WhatsApp      | `GET /api/v1/whatsapp/status`, `qr`; `POST /api/v1/whatsapp/actions` dengan `{ action }`                                    |
| Pesan         | `GET /api/v1/messages`; `POST /api/v1/uploads` (multipart); `POST /api/v1/messages/send`; `POST /api/v1/messages/:id/retry` |
| Grup          | `GET /api/v1/groups`; `POST /api/v1/groups/sync`                                                                            |
| Profil        | `GET/PUT /api/v1/agent/profile` (alias canonical `/agent-profile` diperbolehkan di backend)                                 |
| CRUD          | `/api/v1/knowledge`, `/tools`, `/jobs`, `/ai-providers`                                                                     |
| Aksi          | `POST /api/v1/jobs/:id/run`, `/ai-providers/:id/test`                                                                       |
| Observability | `GET /api/v1/logs`, `/audit-logs`                                                                                           |
| Backup        | `GET/POST /api/v1/backups`; `GET /:id/download`; `POST /:id/restore`                                                        |
| Settings      | `GET/PUT /api/v1/settings`                                                                                                  |
| Health        | `GET /health/live`, `/ready`, `/integrations`                                                                               |

Semua response collection dapat berupa array atau envelope `{ data: { items: [] } }`. Semua endpoint admin membutuhkan Bearer access JWT. Token refresh hanya boleh diterima endpoint auth.

## Menjalankan

```bash
npm run dev
npm run typecheck
npm run build
npm run start
```

Environment server:

```dotenv
GATEWAY_API_URL=http://127.0.0.1:3100
DASHBOARD_HOST=127.0.0.1
DASHBOARD_PORT=3200
# Opsional; default mengikuti UPLOAD_MAX_BYTES + overhead multipart.
DASHBOARD_MAX_BODY_BYTES=27262976
```

Build memakai Next.js 16 dengan Webpack dan `output: standalone`. Script build menyalin aset statik ke bundle standalone, sedangkan `npm run start` menemukan layout standalone monorepo secara otomatis dan bind ke `127.0.0.1`.

# Inbox Phase 2

Messages Center menyediakan tindakan percakapan dan observability tambahan melalui dashboard terautentikasi `/messages`.

## Fitur

- Reaction ke pesan inbound: quick emoji, emoji custom, atau hapus reaction.
- Mark as read untuk satu pesan inbound.
- Indikator typing dengan durasi custom 1–15 detik.
- Receipt analytics 24 jam: sent, delivered, read, failed, retrying, dead.
- Failed queue 24 jam: tipe job, status, attempts, waktu, dan alasan aman; retry tersedia bila job tertaut ke message row.

## Kontrak API

Semua endpoint membutuhkan admin session yang valid.

- `POST /api/v1/messages/:id/reaction` body `{ "emoji": "👍" }`; empty string menghapus reaction.
- `POST /api/v1/messages/:id/mark-read`
- `POST /api/v1/messages/:id/typing` body `{ "durationSeconds": 10 }`
- `GET /api/v1/messages/analytics/receipts?days=1`
- `GET /api/v1/messages/queue/failed?hours=24&limit=50`

`:id` pada tiga mutation route selalu UUID pesan inbound yang sudah tersimpan. API tidak menerima arbitrary WhatsApp key/JID sebagai target.

## Safety

- Mutation hanya berjalan setelah tindakan eksplisit admin di dashboard.
- Reaction/read/typing masuk durable `whatsapp-outbound` queue dengan dedupe key.
- Reaction memakai outbound replay fence yang sama dengan pesan normal.
- Typing dibatasi 1–15 detik dan selalu mencoba mengirim presence `paused` di `finally`.
- Failed queue tidak mengembalikan payload, message body, raw JID, atau raw worker error. Error dipetakan ke alasan operasional yang aman.
- Proxy dashboard membuka method/path exact saja.
- Tidak ada automation default dan tidak ada DB migration.

## Operasi

Setelah perubahan source:

```bash
npm run verify
npm run restart
npm run doctor
```

Jangan menjalankan live reaction/read/typing canary ke customer/group tanpa target dan approval yang jelas. Source/unit tests tidak mengirim tindakan WhatsApp.

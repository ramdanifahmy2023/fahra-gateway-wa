# Mobile Conversation Boxes — Messages Page

## Tujuan
Ubah halaman Messages agar mobile-friendly dan mudah membaca history: 1 nomor/JID tampil sebagai 1 box conversation, bukan 1 row per pesan.

## Masalah Saat Ini
- UI `MessagesCenter` memakai table `min-w-[820px]` dengan horizontal scroll.
- Di HP, filter terlalu banyak dalam satu row; input/status/date membuat layar sempit.
- Data API `/api/v1/messages` mengembalikan pesan individual, bukan grup per nomor.
- Detail modal hanya detail 1 pesan; tidak cocok untuk membaca history penuh 1 pelamar.
- Operator HRD butuh baca konteks percakapan pelamar, bukan status teknis per pesan.

## Scope
- Audit dashboard messages page.
- Rancang update minimal: conversation list berbasis `remote_jid`.
- Tambah endpoint/API mode untuk grouped conversations + latest messages per contact.
- Mobile layout card-first.
- Tetap pertahankan status teknis dan retry untuk pesan gagal.

## Non-Scope
- Tidak mengubah agent WA/HRD behavior.
- Tidak mengubah schema DB kecuali audit membuktikan perlu.
- Tidak menghapus table view lama sebelum ada pengganti stabil.

## Acceptance
- Di mobile: tanpa horizontal table utama.
- 1 nomor/JID = 1 conversation box.
- Box menampilkan ringkasan: nomor, pesan terakhir, waktu, status terakhir, unread/pending/failure indicator.
- Saat box dibuka: terlihat history lengkap/terbaru per nomor dalam bubble inbound/outbound.
- Filter/search tetap bisa dipakai.
- Build/typecheck lulus.

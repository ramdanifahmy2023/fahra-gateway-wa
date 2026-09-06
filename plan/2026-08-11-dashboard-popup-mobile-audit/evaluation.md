# Evaluation

## Root cause utama
File global: `apps/dashboard/src/components/ui/dialog.tsx`

`DialogContent` sekarang:
```tsx
fixed left-1/2 top-1/2 max-h-[90vh] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg p-6
```

Masalah di HP:
- Modal selalu center; keyboard HP bisa menutup field bawah.
- `max-h-[90vh]` + translate center bikin scroll area terasa sempit.
- Padding `p-6` terlalu besar buat layar 360–390px.
- Tombol close absolute bisa nutup title/description panjang.
- Form footer pakai `flex justify-end`; di HP tombol bisa sempit/berdesakan.
- Konten detail/grid modal kadang tetap 2 kolom di breakpoint tertentu atau memaksa teks panjang.

## Popup/form terdampak

### 1. Messages detail
File: `apps/dashboard/src/components/features/messages-center.tsx`
- `DialogContent title="Detail pesan"`
- Isi grid detail banyak field + JSON/pre.
- Risiko: teks panjang, JSON metadata, JID, queue id bikin horizontal overflow.

### 2. Contact Memory edit
File: `apps/dashboard/src/components/features/contact-memory-center.tsx`
- `DialogContent title="Edit contact memory"`
- Form textarea + select + checkbox.
- Risiko: footer/tombol tidak sticky; keyboard menutup submit; modal terlalu tinggi.

### 3. Generic Resource Manager forms
File: `apps/dashboard/src/components/features/resource-manager.tsx`
Dipakai banyak page admin:
- knowledge
- tools
- jobs
- ai-providers
- settings/catalog-like resource pages yang memakai ResourceManager

Masalah:
- Semua create/edit form bergantung ke `DialogContent` global.
- Fields bisa password/textarea/select/JSON-like; mobile butuh full-screen sheet.
- Footer `flex justify-end gap-2` kurang mobile-friendly.

## Table page lain masih mobile risk
Bukan popup, tapi masih responsif buruk:
- `contact-memory-center.tsx`: table `min-w-[960px]`
- `backup-panel.tsx`: table `min-w-[840px]`
- `logs-viewer.tsx`: table `min-w-[920px]`
- `resource-manager.tsx`: table `min-w-[760px]`

## Rekomendasi fix minimal

### Fix global DialogContent dulu
Ubah modal jadi mobile sheet/fullscreen-ish:
- Mobile: `fixed inset-x-0 bottom-0 top-auto max-h-[92dvh] w-full translate-x-0 translate-y-0 rounded-t-2xl rounded-b-none p-4`
- Desktop sm+: balik ke centered modal.
- Tambah `overscroll-contain` dan `break-words`.
- Header beri padding kanan untuk close button.

Contoh target class:
```tsx
fixed inset-x-0 bottom-0 z-50 max-h-[92dvh] w-full overflow-y-auto overscroll-contain rounded-t-2xl border border-border bg-card p-4 shadow-panel outline-none sm:left-1/2 sm:top-1/2 sm:bottom-auto sm:w-[calc(100%-2rem)] sm:max-w-2xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg sm:p-6
```

### Fix form footer reusable
Di `resource-manager.tsx`:
```tsx
<div className="grid gap-2 border-t border-border pt-5 sm:flex sm:justify-end">
  <Button className="w-full sm:w-auto" ...>Batal</Button>
  <Button className="w-full sm:w-auto" ...>Simpan</Button>
</div>
```

### Fix detail modal content
Di `messages-center.tsx`:
- wrapper: `min-w-0`
- `pre`: `max-w-full overflow-x-auto`
- id/JID text: `break-all`

### Fix contact memory footer
Tambahkan tombol full width mobile.

## Risiko
- Mengubah `DialogContent` global berdampak semua popup. Bagus untuk konsistensi, tapi harus test semua modal utama.
- Fullscreen bottom sheet di mobile berbeda tampilan, tapi lebih usable.
- Perlu cek iOS Safari `dvh` support; fallback `vh` bisa ditambah bila perlu.

## Verifikasi wajib
- 390x844 viewport:
  - Messages detail popup
  - Contact Memory edit popup
  - Knowledge add/edit popup
  - AI Provider add/edit popup
- Keyboard open pada input bawah.
- Scroll modal tidak scroll body belakang.

## Sub-agent confirmation
Audit kedua mengonfirmasi:
- Fix paling hemat: patch `components/ui/dialog.tsx` global dulu.
- Patch kedua: footer sticky/full-width di `resource-manager.tsx`, karena modal create/edit panjang dipakai banyak page.
- Contact Memory dan Messages detail kemungkinan membaik otomatis setelah DialogContent global responsive.

## Page priority
1. Knowledge add/edit popup — sering dipakai untuk AI knowledge.
2. AI Provider add/edit popup — form panjang/secret.
3. Jobs add/edit popup — form config.
4. Tools add/edit popup.
5. Contact Memory edit.
6. Messages detail.

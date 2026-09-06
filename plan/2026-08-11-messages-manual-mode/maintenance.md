# Maintenance — Manual Mode Messages

Setelah deploy:
- Uji chat manual mode: inbound tersimpan, AI tidak menjawab.
- Uji aktifkan AI lagi.
- Uji pause 30 menit / 1 jam / 24 jam.
- Cek filter “Butuh balasan admin”.

## Follow-up kecil yang disarankan
- Clear `needs_admin_reply` otomatis setelah admin mengirim balasan manual.
- Tambah label waktu pause berakhir di UI.
- Tambah filter khusus Manual Mode selain Butuh Admin jika daftar chat makin ramai.

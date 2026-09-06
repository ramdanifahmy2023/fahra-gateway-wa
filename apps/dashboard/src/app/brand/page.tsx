/* eslint-disable @next/next/no-img-element */
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Brand Kit · OpenClaw WhatsApp Gateway",
  description: "Logo, warna, aturan pakai, dan aset resmi OpenClaw WhatsApp Gateway.",
};

const colors = [
  ["Latar gelap", "#0C111B", "Untuk halaman utama dan hero."],
  ["Panel", "#101724", "Untuk kartu dan area konten."],
  ["Teks utama", "#F2F6FA", "Untuk teks di latar gelap."],
  ["Teks lembut", "#94A3B8", "Untuk keterangan tambahan."],
  ["Hijau gateway", "#20C768", "Untuk tombol utama dan tanda aktif."],
  ["Biru sinyal", "#38BDF8", "Untuk aksen koneksi."],
  ["Kuning peringatan", "#F59E0B", "Untuk spark dan warning."],
];

const values = [
  ["Privat dulu", "Data dan kendali tetap di sisi owner."],
  ["Stabil dulu", "Antrian, backup, dan log lebih penting dari gimmick."],
  ["Mudah dioperasikan", "Saat AI perlu dijeda, manusia bisa ambil alih."],
  ["Jelas jejaknya", "Setiap aksi penting harus bisa dilacak."],
];

const assets = [
  "ocgw-brand-kit.zip",
  "ocgw-mark-dark.svg",
  "ocgw-mark-light.svg",
  "ocgw-mark-mono-black.svg",
  "ocgw-mark-mono-white.svg",
  "ocgw-lockup-horizontal-dark.svg",
  "ocgw-lockup-horizontal-light.svg",
  "ocgw-lockup-stacked-dark.svg",
  "ocgw-lockup-stacked-light.svg",
  "ocgw-lockup-horizontal-dark@1x.png",
  "ocgw-lockup-horizontal-dark@2x.png",
  "ocgw-lockup-horizontal-dark@3x.png",
  "ocgw-lockup-stacked-dark@1x.png",
  "ocgw-lockup-stacked-dark@2x.png",
  "ocgw-lockup-stacked-dark@3x.png",
  "ocgw-app-icon.svg",
  "ocgw-logo-clear-space.svg",
  "BACA-DULU.txt",
  "SHA256SUMS.txt",
];

export default function BrandPage() {
  return (
    <main className="min-h-screen overflow-x-hidden break-words bg-[#0C111B] text-[#F2F6FA]">
      <section className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-16">
        <p className="break-words font-mono text-sm uppercase tracking-[0.18em] text-[#20C768] sm:tracking-[0.35em]">&gt; brand kit</p>
        <div className="mt-8 grid gap-10 lg:grid-cols-[1fr_360px] lg:items-center">
          <div>
            <img src="/brand/ocgw-lockup-horizontal-dark.svg" alt="OpenClaw WhatsApp Gateway" className="mb-8 h-auto min-w-0 w-full max-w-[520px]" />
            <h1 className="max-w-4xl break-words text-4xl font-black tracking-[-0.035em] sm:text-7xl sm:tracking-[-0.06em]">LOCAL BY DEFAULT. RELIABLE BY DESIGN.</h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-[#94A3B8]">
              Panduan resmi untuk memakai logo, warna, dan identitas OpenClaw WhatsApp Gateway. Dipakai untuk dashboard, dokumentasi, installer, materi partner, dan presentasi.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a className="inline-flex min-h-11 min-w-0 max-w-full items-center justify-center whitespace-normal rounded-lg bg-[#20C768] px-5 py-3 text-center text-sm font-bold text-[#07130C]" href="/brand/ocgw-brand-kit.zip">UNDUH BRAND KIT (.ZIP)</a>
              <a className="inline-flex min-h-11 min-w-0 max-w-full items-center justify-center whitespace-normal rounded-lg border border-white/15 px-5 py-3 text-center text-sm font-bold text-[#F2F6FA]" href="#aturan">LIHAT ATURAN PAKAI</a>
            </div>
          </div>
          <div className="min-w-0 rounded-2xl border border-white/10 bg-[#101724] p-5 sm:p-8">
            <img src="/brand/ocgw-app-icon.svg" alt="Logo kecil OpenClaw WhatsApp Gateway" className="mx-auto h-auto w-48 max-w-full" />
            <p className="mt-6 text-center font-mono text-sm text-[#94A3B8]">BAILEYS · LOCAL-FIRST · PRIVATE OPS</p>
          </div>
        </div>
      </section>

      <section className="border-y border-white/10 bg-[#101724]/70">
        <div className="mx-auto grid max-w-6xl gap-4 px-4 py-10 sm:px-6 md:grid-cols-3">
          {[["VISI", "WhatsApp automation yang tetap aman, privat, dan bisa dikendalikan owner."], ["MISI", "Menyatukan WhatsApp, AI agent, antrian, backup, log, dan mode manual dalam satu gateway."], ["SOSOK", "Operator tenang: praktis, rapi, kuat, tidak banyak gaya."]].map(([title, body]) => (
            <article key={title} className="rounded-2xl border border-white/10 bg-[#0C111B] p-6">
              <h2 className="font-mono text-sm text-[#38BDF8]">{title}</h2>
              <p className="mt-3 text-lg font-semibold leading-7">{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <h2 className="font-mono text-sm uppercase tracking-[0.28em] text-[#20C768]">Nilai brand</h2>
        <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {values.map(([title, body]) => (
            <div key={title} className="rounded-2xl border border-white/10 bg-[#101724] p-5">
              <h3 className="font-semibold">{title}</h3>
              <p className="mt-2 text-sm leading-6 text-[#94A3B8]">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <h2 className="font-mono text-sm uppercase tracking-[0.28em] text-[#20C768]">Logo resmi</h2>
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <div className="rounded-2xl border border-white/10 bg-[#101724] p-6"><img src="/brand/ocgw-lockup-horizontal-dark.svg" alt="Logo horizontal gelap" className="w-full" /><p className="mt-4 text-sm text-[#94A3B8]">Gunakan ini untuk header, dokumen, dan halaman gelap.</p></div>
          <div className="rounded-2xl border border-white/10 bg-white p-6"><img src="/brand/ocgw-lockup-horizontal-light.svg" alt="Logo horizontal terang" className="w-full" /><p className="mt-4 text-sm text-slate-600">Gunakan ini untuk latar putih atau terang.</p></div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <h2 className="font-mono text-sm uppercase tracking-[0.28em] text-[#20C768]">Jarak aman logo</h2>
        <div className="mt-5 grid gap-6 lg:grid-cols-[320px_1fr]">
          <div className="min-w-0 rounded-2xl border border-white/10 bg-[#101724] p-5 sm:p-8"><img src="/brand/ocgw-logo-clear-space.svg" alt="Contoh jarak aman logo" className="mx-auto h-auto w-64 max-w-full" /></div>
          <div className="rounded-2xl border border-white/10 bg-[#101724] p-8 text-[#94A3B8]">
            <p className="text-xl font-semibold text-[#F2F6FA]">Beri ruang napas di sekitar logo.</p>
            <p className="mt-4 leading-8">Jangan tempelkan logo ke pinggir kartu, foto, atau teks lain. Jarak aman minimal kira-kira satu bagian kecil dari tinggi logo. Kalau ragu, beri jarak lebih longgar.</p>
            <p className="mt-4 leading-8">Ukuran terkecil logo: 16px. Untuk ukuran sangat kecil, pakai ikon saja, bukan logo dengan teks.</p>
          </div>
        </div>
      </section>

      <section id="aturan" className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <h2 className="font-mono text-sm uppercase tracking-[0.28em] text-[#20C768]">Boleh / jangan</h2>
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-[#20C768]/30 bg-[#101724] p-6"><p className="font-bold text-[#20C768]">BOLEH</p><ul className="mt-4 space-y-3 text-[#94A3B8]"><li>Pakai file resmi dari brand kit.</li><li>Pakai warna resmi.</li><li>Taruh di latar polos dan kontras.</li><li>Skalakan secara proporsional.</li></ul></div>
          <div className="rounded-2xl border border-[#F59E0B]/30 bg-[#101724] p-6"><p className="font-bold text-[#F59E0B]">JANGAN</p><ul className="mt-4 space-y-3 text-[#94A3B8]"><li>Jangan diputar, ditarik, atau dipipihkan.</li><li>Jangan ganti warna seenaknya.</li><li>Jangan tambah glow, shadow, gradient, atau pattern.</li><li>Jangan taruh di foto ramai tanpa alas solid.</li></ul></div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <h2 className="font-mono text-sm uppercase tracking-[0.28em] text-[#20C768]">Warna resmi</h2>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {colors.map(([name, hex, use]) => (
            <div key={hex} className="rounded-2xl border border-white/10 bg-[#101724] p-4">
              <div className="h-20 rounded-xl border border-white/10" style={{ background: hex }} />
              <p className="mt-3 text-sm text-[#94A3B8]">{name}</p><p className="font-mono text-lg font-bold">{hex}</p><p className="mt-2 text-xs leading-5 text-[#94A3B8]">{use}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <h2 className="font-mono text-sm uppercase tracking-[0.28em] text-[#20C768]">Tipografi</h2>
        <div className="mt-5 grid gap-4 md:grid-cols-3">
          <div className="rounded-2xl border border-white/10 bg-[#101724] p-6"><p className="text-sm text-[#94A3B8]">Judul</p><p className="mt-3 text-3xl font-black tracking-[-0.04em]">Inter / System</p></div>
          <div className="rounded-2xl border border-white/10 bg-[#101724] p-6"><p className="text-sm text-[#94A3B8]">Label teknis</p><p className="mt-3 font-mono text-2xl">MONO 123</p></div>
          <div className="rounded-2xl border border-white/10 bg-[#101724] p-6"><p className="text-sm text-[#94A3B8]">Isi tulisan</p><p className="mt-3 leading-7 text-[#94A3B8]">Gunakan bahasa singkat, jelas, dan tidak terlalu teknis saat dibaca publik.</p></div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <h2 className="font-mono text-sm uppercase tracking-[0.28em] text-[#20C768]">Unduh aset</h2>
        <div className="mt-5 rounded-2xl border border-white/10 bg-[#101724] p-6">
          <a className="inline-flex min-h-11 min-w-0 max-w-full items-center justify-center whitespace-normal rounded-lg bg-[#20C768] px-5 py-3 text-center text-sm font-bold text-[#07130C]" href="/brand/ocgw-brand-kit.zip">UNDUH SEMUA (.ZIP)</a>
          <div className="mt-6 grid gap-3 md:grid-cols-2">
            {assets.map((asset) => <a key={asset} className="min-h-11 break-all rounded-xl border border-white/10 p-4 font-mono text-sm text-[#94A3B8] hover:border-[#20C768] hover:text-[#F2F6FA]" href={`/brand/${asset}`}>{asset}</a>)}
          </div>
          <p className="mt-6 text-sm leading-6 text-[#94A3B8]">Aset dibuat otomatis dari sumber yang sama. Jangan menggambar ulang logo dari screenshot.</p>
        </div>
      </section>
    </main>
  );
}

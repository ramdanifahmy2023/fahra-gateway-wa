import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="text-center">
        <p className="text-sm font-semibold uppercase tracking-widest text-primary">
          404
        </p>
        <h1 className="mt-3 text-3xl font-semibold">Halaman tidak ditemukan</h1>
        <p className="mt-2 text-muted-foreground">
          Alamat yang Anda buka tidak tersedia di konsol ini.
        </p>
        <Button asChild className="mt-6">
          <Link href="/dashboard">Kembali ke dashboard</Link>
        </Button>
      </div>
    </main>
  );
}

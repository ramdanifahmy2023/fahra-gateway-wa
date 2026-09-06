"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => console.error(error), [error]);
  return (
    <html lang="id" className="dark">
      <body className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
        <main className="max-w-lg rounded-lg border border-border bg-card p-8 text-center">
          <p className="text-xs font-semibold uppercase tracking-[.2em] text-destructive">
            Kesalahan aplikasi
          </p>
          <h1 className="mt-3 text-2xl font-semibold">
            Dashboard tidak dapat ditampilkan
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Terjadi kesalahan tak terduga. Coba muat ulang; detail teknis
            tersimpan pada log server.
          </p>
          <Button className="mt-6" onClick={reset}>
            Coba lagi
          </Button>
        </main>
      </body>
    </html>
  );
}

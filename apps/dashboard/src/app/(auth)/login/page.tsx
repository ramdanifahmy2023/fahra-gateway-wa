/* eslint-disable @next/next/no-img-element */
import { Suspense } from "react";
import { ShieldCheck } from "lucide-react";
import { LoginForm } from "@/components/auth/login-form";

export const metadata = { title: "Login" };

export default function LoginPage() {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-x-hidden px-3 py-5 sm:p-5">
      <section className="relative grid min-w-0 w-full max-w-5xl overflow-hidden rounded-xl border border-border bg-card md:grid-cols-[1.05fr_.95fr]">
        <div className="hidden border-r border-border bg-secondary/25 p-10 md:flex md:flex-col md:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-sm font-medium text-primary">
              <img src="/brand/ocgw-app-icon.svg" alt="" className="h-4 w-4" />
              OpenClaw WhatsApp Gateway
            </div>
            <h1 className="mt-12 max-w-md text-4xl font-semibold leading-tight tracking-tight">
              Local by default. Reliable by design.
            </h1>
            <p className="mt-5 max-w-md text-sm leading-7 text-muted-foreground">
              Pantau koneksi Baileys, antrean pesan, bridge OpenClaw, dan
              identitas agent tanpa mengekspos layanan internal.
            </p>
          </div>
          <div className="flex items-center gap-3 border-t border-border/70 pt-6 text-xs text-muted-foreground">
            <ShieldCheck className="h-4 w-4 text-primary" />
            Sesi aman · akses tercatat · single tenant
          </div>
        </div>
        <div className="min-w-0 p-5 sm:p-10 md:p-12">
          <div className="md:hidden">
            <div className="inline-flex items-center gap-2 text-sm font-semibold text-primary">
              <img src="/brand/ocgw-app-icon.svg" alt="" className="h-4 w-4" />
              OpenClaw WhatsApp Gateway
            </div>
          </div>
          <p className="mt-8 break-words text-xs font-semibold uppercase tracking-[.12em] text-primary sm:tracking-[.2em] md:mt-0">
            Baileys · Local-first ops
          </p>
          <h2 className="mt-3 break-words text-2xl font-semibold tracking-tight sm:text-3xl">
            Selamat datang
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Masuk untuk mengelola OpenClaw WhatsApp Gateway.
          </p>
          <Suspense
            fallback={
              <div className="mt-8 h-72 animate-pulse rounded-lg bg-secondary/40" />
            }
          >
            <LoginForm />
          </Suspense>
        </div>
      </section>
    </main>
  );
}

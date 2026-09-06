import { KeyRound, ShieldAlert } from "lucide-react";
import { ChangePasswordForm } from "@/components/auth/change-password-form";

export const metadata = { title: "Ganti Password" };

export default function ChangePasswordPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-5">
      <section className="w-full max-w-lg rounded-xl border border-border bg-card p-7 sm:p-10">
        <div className="flex items-start gap-4">
          <span className="rounded-lg border border-warning/25 bg-warning/10 p-3 text-warning">
            <ShieldAlert className="h-6 w-6" />
          </span>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[.18em] text-warning">
              Tindakan wajib
            </p>
            <h1 className="mt-2 text-2xl font-semibold">
              Ganti password pertama
            </h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Akun bootstrap tidak dapat menggunakan dashboard sebelum password
              awal diganti.
            </p>
          </div>
        </div>
        <ChangePasswordForm />
        <div className="mt-6 flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <KeyRound className="h-3.5 w-3.5" />
          Password disimpan sebagai hash kuat oleh Gateway API.
        </div>
      </section>
    </main>
  );
}

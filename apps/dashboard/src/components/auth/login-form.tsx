"use client";

import { FormEvent, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Eye, EyeOff, LoaderCircle, LockKeyhole, Mail } from "lucide-react";
import { apiFetch } from "@/lib/client-api";
import type { SessionPayload } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InlineNotice } from "@/components/ui/feedback";

export function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const session = await apiFetch<SessionPayload>("/api/session/login", {
        method: "POST",
        body: { email: email.trim(), password },
      });
      const requested = search.get("kembali");
      const safeReturn =
        requested?.startsWith("/") && !requested.startsWith("//")
          ? requested
          : "/dashboard";
      router.replace(
        session.mustChangePassword ? "/ubah-password" : safeReturn,
      );
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Login gagal. Periksa kembali kredensial Anda.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-8 space-y-5">
      {search.get("expired") ? (
        <InlineNotice tone="warning">
          Sesi Anda berakhir. Silakan masuk kembali.
        </InlineNotice>
      ) : null}
      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
      <div className="space-y-2">
        <Label htmlFor="email">Email admin</Label>
        <div className="relative">
          <Mail className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="pl-10"
            placeholder="admin@domain.com"
            required
            autoFocus
          />
        </div>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="password">Password</Label>
          <span className="text-xs text-muted-foreground">Akses privat</span>
        </div>
        <div className="relative">
          <LockKeyhole className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
          <Input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="pl-10 pr-12"
            required
          />
          <button
            type="button"
            className="absolute right-0 top-0 inline-flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setShowPassword((value) => !value)}
            aria-label={
              showPassword ? "Sembunyikan password" : "Tampilkan password"
            }
          >
            {showPassword ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>
      <Button className="w-full" size="lg" disabled={submitting}>
        {submitting ? (
          <>
            <LoaderCircle className="h-4 w-4 animate-spin" />
            Memverifikasi…
          </>
        ) : (
          "Masuk ke dashboard"
        )}
      </Button>
      <p className="text-center text-xs leading-5 text-muted-foreground">
        Akses dicatat di audit log. Jangan berbagi kredensial admin.
      </p>
    </form>
  );
}

"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, LoaderCircle } from "lucide-react";
import { apiFetch } from "@/lib/client-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InlineNotice } from "@/components/ui/feedback";

export function ChangePasswordForm() {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (newPassword.length < 12)
      return setError("Password baru minimal 12 karakter.");
    if (newPassword !== confirmation)
      return setError("Konfirmasi password tidak sama.");
    if (newPassword === currentPassword)
      return setError("Password baru harus berbeda dari password saat ini.");
    setSubmitting(true);
    try {
      await apiFetch("/api/session/change-password", {
        method: "POST",
        body: { currentPassword, newPassword },
      });
      router.replace("/dashboard");
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Password gagal diubah.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-7 space-y-5">
      <InlineNotice tone="warning">
        Password bootstrap hanya boleh digunakan sekali. Buat password unik
        sebelum melanjutkan.
      </InlineNotice>
      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
      <div className="space-y-2">
        <Label htmlFor="current-password">Password saat ini</Label>
        <Input
          id="current-password"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="new-password">Password baru</Label>
        <Input
          id="new-password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          required
        />
        <p className="text-xs text-muted-foreground">
          Minimal 12 karakter. Gunakan kombinasi yang tidak dipakai di layanan
          lain.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="confirm-password">Konfirmasi password baru</Label>
        <Input
          id="confirm-password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          required
        />
      </div>
      <Button className="w-full" size="lg" disabled={submitting}>
        {submitting ? (
          <LoaderCircle className="h-4 w-4 animate-spin" />
        ) : (
          <CheckCircle2 className="h-4 w-4" />
        )}
        {submitting ? "Menyimpan…" : "Simpan dan lanjutkan"}
      </Button>
    </form>
  );
}

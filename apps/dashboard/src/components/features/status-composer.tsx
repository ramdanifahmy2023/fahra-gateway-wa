"use client";

import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { ImageIcon, RadioTower, Send, Type, Video } from "lucide-react";

import { apiFetch } from "@/lib/client-api";
import { getString, unwrapRecord } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { InlineNotice } from "@/components/ui/feedback";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page";
import { Textarea } from "@/components/ui/textarea";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
type StatusType = "text" | "image" | "video";

const statusTypes: Array<{
  value: StatusType;
  label: string;
  description: string;
  icon: typeof Type;
}> = [
  { value: "text", label: "Teks", description: "Warna dan font", icon: Type },
  { value: "image", label: "Gambar", description: "JPEG, PNG, WebP", icon: ImageIcon },
  { value: "video", label: "Video", description: "MP4 hingga 25 MB", icon: Video },
];

export function StatusComposer() {
  const [type, setType] = useState<StatusType>("text");
  const [text, setText] = useState("");
  const [backgroundColor, setBackgroundColor] = useState("#7C3AED");
  const [font, setFont] = useState(1);
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{
    tone: "success" | "danger" | "warning";
    text: string;
  } | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);

  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  function switchType(next: StatusType) {
    setType(next);
    setFile(null);
    setResult(null);
    setNotice(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  function selectFile(next: File | null) {
    setNotice(null);
    if (!next) {
      setFile(null);
      return;
    }
    const allowed =
      type === "image"
        ? ["image/jpeg", "image/png", "image/webp"]
        : ["video/mp4"];
    if (!allowed.includes(next.type)) {
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
      setNotice({
        tone: "danger",
        text:
          type === "image"
            ? "Gambar harus JPEG, PNG, atau WebP."
            : "Video harus memakai format MP4.",
      });
      return;
    }
    if (next.size <= 0 || next.size > MAX_UPLOAD_BYTES) {
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
      setNotice({ tone: "danger", text: "Ukuran file harus antara 1 byte dan 25 MB." });
      return;
    }
    setFile(next);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setNotice(null);
    setResult(null);
    const trimmed = text.trim();
    if (type === "text" && !trimmed) {
      setNotice({ tone: "danger", text: "Isi Status teks wajib diisi." });
      return;
    }
    if (trimmed.length > 700) {
      setNotice({ tone: "danger", text: "Teks atau caption maksimal 700 karakter." });
      return;
    }
    if (type !== "text" && !file) {
      setNotice({ tone: "danger", text: "Pilih file yang akan dijadikan Status." });
      return;
    }
    const confirmation =
      type === "text"
        ? `Kirim Status teks ini sekarang?\n\n${trimmed}`
        : `Kirim Status ${type === "image" ? "gambar" : "video"} ini sekarang${trimmed ? ` dengan caption “${trimmed}”` : ""}?`;
    if (!window.confirm(confirmation)) return;

    setSubmitting(true);
    try {
      let response: unknown;
      if (type === "text") {
        response = await apiFetch("/api/gateway/status/text", {
          method: "POST",
          body: { text: trimmed, backgroundColor, font },
        });
      } else {
        const uploadBody = new FormData();
        uploadBody.set("file", file!);
        uploadBody.set("purpose", `status-${type}`);
        const upload = unwrapRecord(
          await apiFetch("/api/gateway/uploads", {
            method: "POST",
            body: uploadBody,
          }),
        );
        const uploadId = getString(upload, "uploadId", "id");
        if (!uploadId) throw new Error("Gateway tidak mengembalikan ID upload.");
        response = await apiFetch("/api/gateway/status/media", {
          method: "POST",
          body: {
            uploadId,
            type,
            caption: trimmed || undefined,
          },
        });
      }
      const accepted = unwrapRecord(response);
      setResult(accepted);
      setNotice({
        tone: "success",
        text: `Status ${type === "text" ? "teks" : type} diterima Baileys untuk ${String(accepted.audienceCount ?? 0)} audiens.`,
      });
      setText("");
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
    } catch (caught) {
      setNotice({
        tone: "danger",
        text:
          caught instanceof Error
            ? caught.message
            : "Status gagal dikirim. Jangan kirim ulang bila hasilnya ambigu.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Baileys broadcast"
        title="Status WhatsApp"
        description="Buat dan kirim Status teks, gambar, atau video ke audiens Status akun WhatsApp yang terhubung. Pengiriman tidak diulang otomatis bila hasilnya ambigu."
      />
      {notice ? (
        <div className="mb-5">
          <InlineNotice tone={notice.tone}>{notice.text}</InlineNotice>
        </div>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(320px,440px)]">
        <Card>
          <CardHeader>
            <CardTitle>Buat Status</CardTitle>
            <CardDescription>Pilih format, periksa preview, lalu konfirmasi sebelum kirim.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-3">
                {statusTypes.map((item) => {
                  const Icon = item.icon;
                  const active = type === item.value;
                  return (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() => switchType(item.value)}
                      className={`flex min-h-24 flex-col items-start rounded-lg border p-4 text-left transition ${active ? "border-primary bg-primary/10" : "border-border bg-card hover:bg-accent"}`}
                    >
                      <Icon className={`h-5 w-5 ${active ? "text-primary" : "text-muted-foreground"}`} />
                      <span className="mt-3 text-sm font-semibold">{item.label}</span>
                      <span className="mt-1 text-xs text-muted-foreground">{item.description}</span>
                    </button>
                  );
                })}
              </div>

              {type === "text" ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="status-color">Warna latar</Label>
                    <div className="flex gap-2">
                      <Input
                        id="status-color"
                        type="color"
                        value={backgroundColor}
                        onChange={(event) => setBackgroundColor(event.target.value.toUpperCase())}
                        className="w-16 p-1"
                      />
                      <Input
                        value={backgroundColor}
                        onChange={(event) => setBackgroundColor(event.target.value.toUpperCase())}
                        pattern="#[0-9A-Fa-f]{6}"
                        aria-label="Kode warna"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="status-font">Gaya font WhatsApp</Label>
                    <select
                      id="status-font"
                      value={font}
                      onChange={(event) => setFont(Number(event.target.value))}
                      className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-ring"
                    >
                      {[0, 1, 2, 3, 4, 5].map((value) => (
                        <option key={value} value={value}>Font {value}</option>
                      ))}
                    </select>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="status-file">File {type === "image" ? "gambar" : "video"}</Label>
                  <Input
                    ref={fileInput}
                    id="status-file"
                    type="file"
                    accept={type === "image" ? "image/jpeg,image/png,image/webp" : "video/mp4"}
                    onChange={(event) => selectFile(event.target.files?.[0] ?? null)}
                  />
                  <p className="text-xs text-muted-foreground">Maksimal 25 MB. File disimpan owner-only dan hanya nama UUID yang diteruskan ke Baileys.</p>
                </div>
              )}

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="status-text">{type === "text" ? "Isi Status" : "Caption"}</Label>
                  <span className="text-xs text-muted-foreground">{text.length}/700</span>
                </div>
                <Textarea
                  id="status-text"
                  rows={5}
                  maxLength={700}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  placeholder={type === "text" ? "Tulis Status WhatsApp…" : "Caption opsional…"}
                  required={type === "text"}
                />
              </div>

              <Button type="submit" disabled={submitting} className="w-full sm:w-auto">
                <Send className="h-4 w-4" />
                {submitting ? "Mengirim…" : "Preview lalu kirim"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Preview</CardTitle>
            <CardDescription>Tampilan perkiraan; rendering akhir mengikuti WhatsApp.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="mx-auto aspect-[9/16] w-full max-w-[330px] overflow-hidden rounded-[28px] border border-border bg-black shadow-xl">
              {type === "text" ? (
                <div
                  className="flex h-full items-center justify-center p-8 text-center text-2xl font-semibold leading-relaxed text-white"
                  style={{ backgroundColor }}
                >
                  {text.trim() || "Preview Status teks"}
                </div>
              ) : previewUrl ? (
                <div className="relative h-full w-full">
                  {type === "image" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={previewUrl} alt="Preview Status" className="h-full w-full object-contain" />
                  ) : (
                    <video src={previewUrl} controls className="h-full w-full object-contain" />
                  )}
                  {text.trim() ? (
                    <div className="absolute inset-x-0 bottom-0 bg-black/65 px-4 py-5 text-center text-sm font-medium text-white">{text.trim()}</div>
                  ) : null}
                </div>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center text-muted-foreground">
                  <RadioTower className="h-10 w-10" />
                  <p className="text-sm">Pilih file untuk menampilkan preview.</p>
                </div>
              )}
            </div>
            {result ? (
              <div className="mt-5 rounded-lg border border-success/40 bg-success/10 p-4 text-sm">
                <p className="font-semibold text-success">Diterima Baileys</p>
                <p className="mt-1 text-muted-foreground">Audiens: {String(result.audienceCount ?? 0)} · tujuan status@broadcast</p>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

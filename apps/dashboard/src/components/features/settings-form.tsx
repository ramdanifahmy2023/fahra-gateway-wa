"use client";

import { FormEvent, useEffect, useState } from "react";
import {
  KeyRound,
  LoaderCircle,
  RefreshCw,
  Save,
  Server,
  Settings2,
} from "lucide-react";
import { apiFetch } from "@/lib/client-api";
import { getBoolean, getString, unwrapRecord } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ErrorState,
  InlineNotice,
  LoadingState,
} from "@/components/ui/feedback";
import { PageHeader } from "@/components/ui/page";

type Settings = {
  agentMention: string;
  timezone: string;
  messageRetentionDays: number;
  openclawUrl: string;
  processGroupMentionsOnly: boolean;
};
const defaults: Settings = {
  agentMention: "",
  timezone: "Asia/Jakarta",
  messageRetentionDays: 90,
  openclawUrl: "http://127.0.0.1:18789/v1/chat/completions",
  processGroupMentionsOnly: true,
};

export function SettingsForm() {
  const [settings, setSettings] = useState(defaults);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = unwrapRecord(await apiFetch("/api/gateway/settings"));
      setSettings({
        agentMention: getString(data, "agentMention", "mentionName"),
        timezone: getString(data, "timezone") || defaults.timezone,
        messageRetentionDays: Number(
          data.messageRetentionDays ??
            data.retentionDays ??
            defaults.messageRetentionDays,
        ),
        openclawUrl:
          getString(data, "openclawUrl", "openclawBaseUrl") ||
          defaults.openclawUrl,
        processGroupMentionsOnly:
          "processGroupMentionsOnly" in data || "mentionOnly" in data
            ? getBoolean(data, "processGroupMentionsOnly", "mentionOnly")
            : true,
      });
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Pengaturan gagal dimuat.",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, []);
  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch("/api/gateway/settings", {
        method: "PUT",
        body: settings,
      });
      setNotice("Pengaturan berhasil disimpan dan dicatat pada audit log.");
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Pengaturan gagal disimpan.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Gateway configuration"
        title="Settings"
        description="Pengaturan operasional single-tenant. Secret runtime tetap dikelola melalui environment workspace."
        actions={
          <Button variant="outline" onClick={() => void load()}>
            <RefreshCw className="h-4 w-4" />
            Muat ulang
          </Button>
        }
      />
      {loading ? (
        <LoadingState />
      ) : error && !settings.timezone ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : (
        <form onSubmit={save} className="grid gap-5 xl:grid-cols-[1fr_360px]">
          <Card>
            <CardHeader>
              <CardTitle>Pengaturan umum</CardTitle>
              <CardDescription>
                URL OpenClaw dan retensi dibaca worker secara dinamis. Timezone
                serta nama mention disimpan sebagai metadata operasional.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {notice ? (
                <InlineNotice tone="success">{notice}</InlineNotice>
              ) : null}
              {error ? (
                <InlineNotice tone="danger">{error}</InlineNotice>
              ) : null}
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="mention">Nama mention agent</Label>
                  <Input
                    id="mention"
                    value={settings.agentMention}
                    onChange={(event) =>
                      setSettings((value) => ({
                        ...value,
                        agentMention: event.target.value,
                      }))
                    }
                    placeholder="@openclaw"
                  />
                  <p className="text-xs text-muted-foreground">
                    Deteksi utama tetap memakai mentionedJid, bukan pencocokan
                    teks longgar.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="timezone">Timezone</Label>
                  <Input
                    id="timezone"
                    value={settings.timezone}
                    onChange={(event) =>
                      setSettings((value) => ({
                        ...value,
                        timezone: event.target.value,
                      }))
                    }
                    required
                  />
                  <p className="text-xs text-muted-foreground">
                    Referensi tampilan/context; jadwal workflow tetap dieksekusi
                    oleh OpenClaw.
                  </p>
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="retention">Retensi pesan (hari)</Label>
                  <Input
                    id="retention"
                    type="number"
                    min={1}
                    max={3650}
                    value={settings.messageRetentionDays}
                    onChange={(event) =>
                      setSettings((value) => ({
                        ...value,
                        messageRetentionDays: event.target.valueAsNumber,
                      }))
                    }
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="openclaw-url">OpenClaw URL</Label>
                  <Input
                    id="openclaw-url"
                    type="url"
                    value={settings.openclawUrl}
                    onChange={(event) =>
                      setSettings((value) => ({
                        ...value,
                        openclawUrl: event.target.value,
                      }))
                    }
                    required
                  />
                  <p className="text-xs text-muted-foreground">
                    Gunakan localhost; API internal tidak boleh diekspos publik.
                  </p>
                </div>
              </div>
              <label className="flex items-center justify-between rounded-md border border-border bg-background/30 p-4">
                <span>
                  <span className="block text-sm font-medium">
                    Hanya proses mention di grup
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    DM tetap diterima; pesan grup tanpa mention disimpan sebagai
                    ignored.
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={settings.processGroupMentionsOnly}
                  disabled
                  aria-describedby="mention-policy"
                  className="h-4 w-4 accent-emerald-500"
                />
              </label>
              <p id="mention-policy" className="text-xs text-muted-foreground">
                Kebijakan ini wajib untuk menjaga gateway tetap sebagai
                connector; keputusan pemrosesan tetap berada di OpenClaw.
              </p>
              <div className="flex justify-end">
                <Button disabled={saving}>
                  {saving ? (
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  {saving ? "Menyimpan…" : "Simpan pengaturan"}
                </Button>
              </div>
            </CardContent>
          </Card>
          <aside className="space-y-4">
            <Card>
              <CardHeader>
                <span className="mb-2 w-fit rounded-md border border-primary/20 bg-primary/10 p-2.5 text-primary">
                  <Server className="h-5 w-5" />
                </span>
                <CardTitle>Konfigurasi runtime</CardTitle>
              </CardHeader>
              <CardContent className="text-sm leading-6 text-muted-foreground">
                Database URL, Redis URL, encryption key, internal API key, dan
                token tunnel tidak ditampilkan atau diubah dari browser.
              </CardContent>
            </Card>
            <Card>
              <CardContent className="space-y-3 pt-6">
                <div className="flex gap-3">
                  <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <p className="text-xs leading-5 text-muted-foreground">
                    Perubahan secret dilakukan melalui `.env` workspace dan
                    restart terkontrol.
                  </p>
                </div>
                <div className="flex gap-3">
                  <Settings2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <p className="text-xs leading-5 text-muted-foreground">
                    Gunakan menu AI Provider untuk API key model
                    OpenAI-compatible.
                  </p>
                </div>
              </CardContent>
            </Card>
          </aside>
        </form>
      )}
    </>
  );
}

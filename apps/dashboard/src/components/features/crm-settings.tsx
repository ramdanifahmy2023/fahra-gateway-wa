"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { LoaderCircle, RefreshCw, Save } from "lucide-react";
import { ApiError, apiFetch } from "@/lib/client-api";
import { asRecord, unwrapRecord } from "@/lib/utils";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ErrorState, InlineNotice, LoadingState } from "@/components/ui/feedback";
import { PageHeader } from "@/components/ui/page";

type Notice = { tone: "success" | "danger" | "warning"; text: string } | null;
type Settings = {
  crmEnabled: boolean;
  notesRequiredOnClose: boolean;
  expectedRevision: number | null;
};

const defaults: Settings = {
  crmEnabled: false,
  notesRequiredOnClose: false,
  expectedRevision: null,
};

export function CrmSettings() {
  const [settings, setSettings] = useState<Settings>(defaults);
  const [effective, setEffective] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  async function load(options: { preserveNotice?: boolean } = {}) {
    setLoading(true);
    setError(null);
    if (!options.preserveNotice) setNotice(null);
    try {
      const payload = unwrapRecord(await apiFetch("/api/gateway/crm/config"));
      const config = asRecord(payload.config);
      const revision = Number(payload.revision);
      setSettings({
        crmEnabled: config["crm.enabled"] === true,
        notesRequiredOnClose: config["crm.notes_required_on_close"] === true,
        expectedRevision: Number.isInteger(revision) && revision > 0 ? revision : null,
      });
      setEffective(config);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Konfigurasi CRM gagal dimuat.");
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
    if (!settings.expectedRevision) {
      setNotice({ tone: "warning", text: "Revision belum tersedia. Muat ulang sebelum menyimpan." });
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch("/api/gateway/crm/config", {
        method: "PUT",
        body: {
          expectedRevision: settings.expectedRevision,
          "crm.enabled": settings.crmEnabled,
          "crm.ai.enabled": false,
          "crm.ai.mode": "off",
          "crm.notes_required_on_close": settings.notesRequiredOnClose,
          "crm.human_override_required": true,
          "crm.allow_auto_reply": false,
        },
      });
      setNotice({ tone: "success", text: "Konfigurasi CRM tersimpan dan dibaca ulang." });
      await load({ preserveNotice: true });
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        setNotice({ tone: "warning", text: "Konflik revision. Muat ulang, cek effective state, lalu simpan lagi." });
      } else {
        setNotice({ tone: "danger", text: caught instanceof Error ? caught.message : "Konfigurasi CRM gagal disimpan." });
      }
    } finally {
      setSaving(false);
    }
  }

  const effectiveEntries = useMemo(
    () => Object.entries(effective).filter(([key]) => !key.toLowerCase().includes("secret")),
    [effective],
  );

  return (
    <>
      <PageHeader
        eyebrow="CRM Phase 3A"
        title="CRM Settings"
        description="Seluruh konfigurasi operasional CRM manusia tersedia di web. AI master tetap OFF untuk pilot ini."
        actions={<Button variant="outline" onClick={() => void load()}><RefreshCw className="h-4 w-4" />Muat ulang</Button>}
      />
      {loading ? <LoadingState /> : error ? <ErrorState message={error} onRetry={() => void load()} /> : (
        <form onSubmit={save} className="grid gap-5 xl:grid-cols-[1fr_360px]">
          <Card>
            <CardHeader>
              <CardTitle>CRM master</CardTitle>
              <CardDescription>Pengaturan default untuk kontak dan workflow manusia.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {notice ? <InlineNotice tone={notice.tone}>{notice.text}</InlineNotice> : null}
              <label className="flex items-center justify-between rounded-md border border-border bg-background/30 p-4">
                <span><span className="block text-sm font-medium">CRM enabled</span><span className="text-xs text-muted-foreground">Menyalakan operasi CRM manual; tidak menyalakan AI.</span></span>
                <input type="checkbox" checked={settings.crmEnabled} onChange={(event) => setSettings((current) => ({ ...current, crmEnabled: event.target.checked }))} />
              </label>
              <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={settings.notesRequiredOnClose} onChange={(event) => setSettings((current) => ({ ...current, notesRequiredOnClose: event.target.checked }))} />Wajib catatan internal sebelum status ditutup</label>
              <div className="rounded-md border border-warning/25 bg-warning/5 p-4">
                <div className="flex items-center justify-between gap-3"><div><p className="text-sm font-medium text-amber-100">AI master</p><p className="text-xs text-muted-foreground">OFF dan dikunci untuk Phase 3A. Auto-reply/auto-send tidak tersedia.</p></div><Badge>OFF</Badge></div>
              </div>
              <div className="rounded-md border border-border bg-background/30 p-3 text-xs text-muted-foreground">Revision: {String(settings.expectedRevision ?? "none")}</div>
              <Button disabled={saving || !settings.expectedRevision}>{saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Simpan konfigurasi</Button>
            </CardContent>
          </Card>

          <div className="space-y-5">
            <Card>
              <CardHeader><CardTitle>Status efektif</CardTitle><CardDescription>Readback authoritative dari backend.</CardDescription></CardHeader>
              <CardContent className="space-y-2 text-sm">
                <StatusBadge value={settings.crmEnabled ? "crm on" : "crm off"} />
                <div className="mt-3 space-y-2">
                  {effectiveEntries.map(([key, value]) => <div key={key} className="flex justify-between gap-3 rounded-md border border-border bg-background/30 px-3 py-2"><span className="text-muted-foreground">{key}</span><span className="max-w-44 truncate text-right">{String(value)}</span></div>)}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Human-first guard</CardTitle><CardDescription>Phase 3A sengaja tanpa auto-send.</CardDescription></CardHeader>
              <CardContent className="space-y-2 text-sm text-muted-foreground">
                <p>• Catatan CRM internal, tidak dikirim ke WhatsApp.</p>
                <p>• Human override selalu tersedia dan dikunci ON.</p>
                <p>• AI master dan auto-reply dipaksa OFF oleh backend.</p>
              </CardContent>
            </Card>
          </div>
        </form>
      )}
    </>
  );
}

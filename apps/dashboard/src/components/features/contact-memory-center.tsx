"use client";

import { FormEvent, useMemo, useState } from "react";
import { Edit3, LoaderCircle, RefreshCw, Search, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/client-api";
import { useApiResource } from "@/hooks/use-api-resource";
import { formatDateTime, getBoolean, getRecordId, getString, getValue, unwrapCollection, unwrapRecord } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { EmptyState, ErrorState, InlineNotice, LoadingState } from "@/components/ui/feedback";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page";
import { StatusBadge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";

const stages = ["new", "asked_job", "form_link_sent", "form_submitted", "under_review"];

export function ContactMemoryCenter() {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const search = new URLSearchParams({ limit: "50", page: String(page) });
  if (query) search.set("search", query);
  const resource = useApiResource<unknown>(`/api/gateway/contact-memory?${search.toString()}`, { pollMs: 30_000 });
  const records = useMemo(() => unwrapCollection(resource.data), [resource.data]);
  const meta = unwrapRecord(unwrapRecord(resource.data).meta);
  const total = Number(meta.total ?? records.length);
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const [values, setValues] = useState({ candidateName: "", displayName: "", recruitmentStage: "new", formSubmitted: false, lastSummary: "" });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  function openEdit(record: Record<string, unknown>) {
    setEditing(record);
    setValues({
      candidateName: getString(record, "candidateName"),
      displayName: getString(record, "displayName"),
      recruitmentStage: getString(record, "recruitmentStage") || "new",
      formSubmitted: getBoolean(record, "formSubmitted"),
      lastSummary: getString(record, "lastSummary"),
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    setSaving(true);
    setNotice(null);
    try {
      await apiFetch(`/api/gateway/contact-memory/${encodeURIComponent(getRecordId(editing))}`, { method: "PUT", body: values });
      setEditing(null);
      setNotice({ tone: "success", text: "Memory kontak diperbarui." });
      void resource.reload(true);
    } catch (caught) {
      setNotice({ tone: "danger", text: caught instanceof Error ? caught.message : "Memory gagal disimpan." });
    } finally {
      setSaving(false);
    }
  }

  async function remove(record: Record<string, unknown>) {
    const id = getRecordId(record);
    if (!id || !window.confirm(`Hapus memory kontak ${id}? Chat log whatsapp_messages tetap ada.`)) return;
    try {
      await apiFetch(`/api/gateway/contact-memory/${encodeURIComponent(id)}`, { method: "DELETE" });
      setNotice({ tone: "success", text: "Memory kontak dihapus." });
      void resource.reload(true);
    } catch (caught) {
      setNotice({ tone: "danger", text: caught instanceof Error ? caught.message : "Memory gagal dihapus." });
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Per-number HRD memory"
        title="Contact Memory"
        description="Ringkasan deterministic per nomor WA. Bukan full chat log; full log tetap di Messages."
        actions={<Button variant="outline" onClick={() => void resource.reload()}><RefreshCw className="h-4 w-4" />Muat ulang</Button>}
      />
      {notice ? <div className="mb-4"><InlineNotice tone={notice.tone}>{notice.text}</InlineNotice></div> : null}
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div><CardTitle>Memory kontak</CardTitle><CardDescription>Edit manual hanya untuk koreksi ringkasan/tahap.</CardDescription></div>
            <div className="relative lg:w-80"><Search className="absolute left-3 top-3.5 h-4 w-4 text-muted-foreground" /><Input aria-label="Cari memory kontak" className="pl-9" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Cari nomor, nama, ringkasan…" /></div>
          </div>
        </CardHeader>
        <CardContent>
          {resource.loading ? <LoadingState /> : resource.error ? <ErrorState message={resource.error} onRetry={() => void resource.reload()} /> : !records.length ? <EmptyState title="Belum ada memory" description="Memory muncul setelah nomor WA berinteraksi dengan agent HRD." /> : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="data-table min-w-[960px]">
                <thead><tr><th>Kontak</th><th>Tahap</th><th>Form</th><th>Ringkasan</th><th>Update</th><th><span className="sr-only">Aksi</span></th></tr></thead>
                <tbody>{records.map((record) => {
                  const id = getRecordId(record);
                  return <tr key={id}>
                    <td><p className="font-mono text-xs">{getString(record, "remoteJid")}</p><p className="text-xs text-muted-foreground">{getString(record, "candidateName") || getString(record, "displayName") || "Tidak tersedia"}</p></td>
                    <td><StatusBadge value={getString(record, "recruitmentStage") || "new"} /></td>
                    <td>{getBoolean(record, "formSubmitted") ? "Sudah" : "Belum"}</td>
                    <td className="max-w-md truncate text-sm">{getString(record, "lastSummary") || "Tidak tersedia"}</td>
                    <td className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(getValue(record, "lastMessageAt") ?? getValue(record, "updatedAt"))}</td>
                    <td><div className="flex gap-1"><Button variant="ghost" size="sm" onClick={() => openEdit(record)}><Edit3 className="h-3.5 w-3.5" />Edit</Button><Button variant="ghost" size="sm" onClick={() => void remove(record)}><Trash2 className="h-3.5 w-3.5" />Hapus</Button></div></td>
                  </tr>;
                })}</tbody>
              </table>
            </div>
          )}
          {records.length ? <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground"><span>Halaman {page} • total {total}</span><div className="flex gap-2"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Sebelumnya</Button><Button variant="outline" size="sm" disabled={page * 50 >= total} onClick={() => setPage((value) => value + 1)}>Berikutnya</Button></div></div> : null}
        </CardContent>
      </Card>
      <Dialog open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent title="Edit contact memory" description={editing ? getRecordId(editing) : undefined}>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2"><Label htmlFor="contact-candidate-name">Nama kandidat</Label><Input id="contact-candidate-name" value={values.candidateName} onChange={(event) => setValues((current) => ({ ...current, candidateName: event.target.value }))} /></div>
            <div className="space-y-2"><Label htmlFor="contact-display-name">Display name</Label><Input id="contact-display-name" value={values.displayName} onChange={(event) => setValues((current) => ({ ...current, displayName: event.target.value }))} /></div>
            <div className="space-y-2"><Label htmlFor="contact-stage">Tahap</Label><select id="contact-stage" className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-ring" value={values.recruitmentStage} onChange={(event) => setValues((current) => ({ ...current, recruitmentStage: event.target.value }))}>{stages.map((stage) => <option key={stage} value={stage}>{stage}</option>)}</select></div>
            <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5" checked={values.formSubmitted} onChange={(event) => setValues((current) => ({ ...current, formSubmitted: event.target.checked }))} />Form sudah dikirim</label>
            <div className="space-y-2"><Label htmlFor="contact-summary">Ringkasan</Label><Textarea id="contact-summary" value={values.lastSummary} onChange={(event) => setValues((current) => ({ ...current, lastSummary: event.target.value }))} maxLength={500} /></div>
            <div className="sticky bottom-0 -mx-4 border-t border-border bg-card/95 px-4 pb-1 pt-4 sm:-mx-6 sm:px-6">
              <Button className="w-full sm:w-auto" disabled={saving}>{saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}Simpan</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

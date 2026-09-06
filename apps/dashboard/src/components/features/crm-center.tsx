"use client";

import { FormEvent, useMemo, useState } from "react";
import Link from "next/link";
import { LoaderCircle, Plus, RefreshCw, Search, Settings2, Trash2 } from "lucide-react";
import { ApiError, apiErrorCode, apiFetch } from "@/lib/client-api";
import { useApiResource } from "@/hooks/use-api-resource";
import {
  asRecord,
  formatDateTime,
  getBoolean,
  getRecordId,
  getString,
  getValue,
  responseMeta,
  unwrapCollection,
  unwrapRecord,
} from "@/lib/utils";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  EmptyState,
  ErrorState,
  InlineNotice,
  LoadingState,
} from "@/components/ui/feedback";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page";
import { Textarea } from "@/components/ui/textarea";

type Tone = "success" | "danger" | "warning";
type Notice = { tone: Tone; text: string } | null;
type ContactForm = {
  status: string;
  priority: string;
  slaDueAt: string;
  consentStatus: string;
  doNotContact: boolean;
  doNotContactReason: string;
  aiOverride: string;
  expectedRevision: string | number | null;
};

const statuses = ["new", "open", "waiting_human", "waiting_customer", "resolved", "closed"];
const priorities = ["low", "normal", "high", "urgent"];
const consentStatuses = ["unknown", "granted", "denied", "revoked"];
const aiOverrides = ["inherit", "off", "suggest_only", "assist"];
const blankForm: ContactForm = {
  status: "open",
  priority: "normal",
  slaDueAt: "",
  consentStatus: "unknown",
  doNotContact: false,
  doNotContactReason: "",
  aiOverride: "inherit",
  expectedRevision: null,
};

export function CrmCenter() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [aiOverride, setAiOverride] = useState("");
  const [dncOnly, setDncOnly] = useState(false);
  const [page, setPage] = useState(1);
  const params = new URLSearchParams({ page: String(page), limit: "50" });
  if (query) params.set("search", query);
  if (status) params.set("crmStatus", status);
  if (priority) params.set("priority", priority);
  if (aiOverride) params.set("aiModeOverride", aiOverride);
  if (dncOnly) params.set("doNotContact", "true");

  const contactsResource = useApiResource<unknown>(
    `/api/gateway/crm/contacts?${params.toString()}`,
    { pollMs: 30_000 },
  );
  const contacts = useMemo(
    () => unwrapCollection(contactsResource.data),
    [contactsResource.data],
  );
  const meta = responseMeta(contactsResource.data);
  const total = Number(meta.total ?? contacts.length);
  const tagsResource = useApiResource<unknown>("/api/gateway/crm/tags", {
    pollMs: 60_000,
  });
  const allTags = useMemo(() => unwrapCollection(tagsResource.data), [tagsResource.data]);

  const [selectedJid, setSelectedJid] = useState("");
  const selected = contacts.find((contact) => contactJid(contact) === selectedJid) ?? null;
  const [form, setForm] = useState<ContactForm>(blankForm);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [newTag, setNewTag] = useState("");
  const [note, setNote] = useState("");
  const [notesBusy, setNotesBusy] = useState(false);

  const notesResource = useApiResource<unknown>(
    selectedJid
      ? `/api/gateway/crm/contacts/${encodeURIComponent(selectedJid)}/notes`
      : "/api/gateway/crm/contacts/none/notes",
    { enabled: Boolean(selectedJid), pollMs: 30_000 },
  );
  const notes = useMemo(() => unwrapCollection(notesResource.data), [notesResource.data]);

  function selectContact(contact: Record<string, unknown>) {
    const jid = contactJid(contact);
    setSelectedJid(jid);
    setForm(contactToForm(contact));
    setNotice(null);
  }

  async function reloadSelected() {
    await contactsResource.reload(true);
    await notesResource.reload(true);
  }

  async function saveContact(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setSaving(true);
    setNotice(null);
    try {
      const updated = unwrapRecord(await apiFetch(`/api/gateway/crm/contacts/${encodeURIComponent(selectedJid)}`, {
        method: "PUT",
        body: {
          crmStatus: form.status,
          priority: form.priority,
          slaDueAt: form.slaDueAt ? new Date(form.slaDueAt).toISOString() : null,
          consentStatus: form.consentStatus,
          doNotContact: form.doNotContact,
          ...(form.doNotContact ? { doNotContactReason: form.doNotContactReason.trim() } : {}),
          aiModeOverride: form.aiOverride,
          expectedRevision: form.expectedRevision,
        },
      }));
      setForm(contactToForm(updated));
      setNotice({ tone: "success", text: "Kontak CRM tersimpan." });
      await reloadSelected();
    } catch (caught) {
      setNotice(conflictNotice(caught, "Kontak CRM gagal disimpan."));
    } finally {
      setSaving(false);
    }
  }

  async function attachTag(tag: Record<string, unknown>) {
    if (!selectedJid) return;
    const id = getRecordId(tag);
    if (!id) return;
    try {
      await apiFetch(
        `/api/gateway/crm/contacts/${encodeURIComponent(selectedJid)}/tags/${encodeURIComponent(id)}`,
        { method: "PUT", body: { expectedRevision: form.expectedRevision } },
      );
      setNotice({ tone: "success", text: "Tag ditambahkan." });
      await contactsResource.reload(true);
    } catch (caught) {
      setNotice(conflictNotice(caught, "Tag gagal ditambahkan."));
    }
  }

  async function createAndAttachTag(event: FormEvent) {
    event.preventDefault();
    if (!selectedJid || !newTag.trim()) return;
    try {
      const created = unwrapRecord(
        await apiFetch("/api/gateway/crm/tags", {
          method: "POST",
          body: { name: newTag.trim() },
        }),
      );
      const tag = Object.keys(created).length ? created : { id: newTag.trim(), name: newTag.trim() };
      setNewTag("");
      await tagsResource.reload(true);
      await attachTag(tag);
    } catch (caught) {
      setNotice(conflictNotice(caught, "Tag gagal dibuat."));
    }
  }

  async function removeTag(tag: Record<string, unknown>) {
    if (!selectedJid) return;
    const id = getRecordId(tag);
    if (!id) return;
    try {
      await apiFetch(
        `/api/gateway/crm/contacts/${encodeURIComponent(selectedJid)}/tags/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      setNotice({ tone: "success", text: "Tag dilepas." });
      await contactsResource.reload(true);
    } catch (caught) {
      setNotice(conflictNotice(caught, "Tag gagal dilepas."));
    }
  }

  async function addNote(event: FormEvent) {
    event.preventDefault();
    if (!selectedJid || !note.trim()) return;
    setNotesBusy(true);
    try {
      await apiFetch(`/api/gateway/crm/contacts/${encodeURIComponent(selectedJid)}/notes`, {
        method: "POST",
          body: { body: note.trim() },
      });
      setNote("");
      setNotice({ tone: "success", text: "Catatan internal disimpan. Tidak dikirim ke kontak." });
      await notesResource.reload(true);
    } catch (caught) {
      setNotice(conflictNotice(caught, "Catatan gagal disimpan."));
    } finally {
      setNotesBusy(false);
    }
  }

  async function deleteNote(noteRecord: Record<string, unknown>) {
    const id = getRecordId(noteRecord);
    if (!id || !window.confirm("Hapus catatan internal ini?")) return;
    try {
      await apiFetch(`/api/gateway/crm/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
      setNotice({ tone: "success", text: "Catatan dihapus." });
      await notesResource.reload(true);
    } catch (caught) {
      setNotice(conflictNotice(caught, "Catatan gagal dihapus."));
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Human-first CRM"
        title="CRM"
        description="Kelola kontak, SLA, consent, tag, dan catatan internal. Phase 3A tidak mengirim pesan otomatis."
        actions={<div className="flex flex-wrap gap-2">
          <Button asChild variant="outline"><Link href="/crm/settings"><Settings2 className="h-4 w-4" />Settings</Link></Button>
          <Button variant="outline" onClick={() => void reloadSelected()}><RefreshCw className="h-4 w-4" />Muat ulang</Button>
        </div>}
      />
      {notice ? <div className="mb-4"><InlineNotice tone={notice.tone}>{notice.text}</InlineNotice></div> : null}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_460px]">
        <Card>
          <CardHeader>
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <CardTitle>Kontak CRM</CardTitle>
                <CardDescription>Filter, cari, lalu pilih kontak untuk edit manual.</CardDescription>
              </div>
              <div className="relative lg:w-80">
                <Search className="absolute left-3 top-3.5 h-4 w-4 text-muted-foreground" />
                <Input
                  aria-label="Cari kontak CRM"
                  className="pl-9"
                  value={query}
                  onChange={(event) => { setQuery(event.target.value); setPage(1); }}
                  placeholder="Cari nama, nomor, tag…"
                />
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 md:grid-cols-4">
              <Select label="Status" value={status} values={statuses} onChange={setStatus} />
              <Select label="Prioritas" value={priority} values={priorities} onChange={setPriority} />
              <Select label="AI override" value={aiOverride} values={aiOverrides} onChange={setAiOverride} />
              <label className="flex min-h-11 items-center gap-2 pt-6 text-sm">
                <input type="checkbox" checked={dncOnly} onChange={(event) => setDncOnly(event.target.checked)} />
                DNC saja
              </label>
            </div>
            {contactsResource.loading ? <LoadingState /> : contactsResource.error ? (
              <ErrorState message={contactsResource.error} onRetry={() => void contactsResource.reload()} />
            ) : !contacts.length ? (
              <EmptyState title="Belum ada kontak CRM" description="Data muncul setelah backend CRM mengembalikan daftar kontak." />
            ) : (
              <div className="grid gap-3 lg:hidden">
                {contacts.map((contact) => <ContactCard key={contactJid(contact)} contact={contact} selected={contactJid(contact) === selectedJid} onSelect={() => selectContact(contact)} />)}
              </div>
            )}
            {contacts.length ? (
              <div className="hidden overflow-x-auto rounded-md border border-border lg:block">
                <table className="data-table min-w-[980px]">
                  <thead><tr><th>Kontak</th><th>Status</th><th>Prioritas</th><th>SLA</th><th>AI</th><th>DNC</th><th>Tag</th></tr></thead>
                  <tbody>{contacts.map((contact) => {
                    const jid = contactJid(contact);
                    return <tr key={jid} className={jid === selectedJid ? "bg-accent/40" : undefined} onClick={() => selectContact(contact)}>
                      <td><p className="font-mono text-xs">{jid}</p><p className="text-xs text-muted-foreground">{displayName(contact)}</p></td>
                      <td><StatusBadge value={getString(contact, "crmStatus") || "open"} /></td>
                      <td>{getString(contact, "priority") || "normal"}</td>
                      <td className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(getValue(contact, "slaDueAt") ?? getValue(contact, "slaAt"))}</td>
                      <td>{getString(contact, "aiModeOverride") || "inherit"}</td>
                      <td>{getBoolean(contact, "doNotContact", "dnc") ? "Ya" : "Tidak"}</td>
                      <td><TagList tags={contactTags(contact)} /></td>
                    </tr>;
                  })}</tbody>
                </table>
              </div>
            ) : null}
            {contacts.length ? <div className="flex items-center justify-between text-xs text-muted-foreground"><span>Halaman {page} • total {total}</span><div className="flex gap-2"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Sebelumnya</Button><Button variant="outline" size="sm" disabled={page * 50 >= total} onClick={() => setPage((value) => value + 1)}>Berikutnya</Button></div></div> : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Detail kontak</CardTitle>
            <CardDescription>{selected ? selectedJid : "Pilih kontak dari daftar."}</CardDescription>
          </CardHeader>
          <CardContent>
            {!selected ? <EmptyState title="Belum dipilih" description="Pilih satu kontak untuk edit status, prioritas, SLA, consent, DNC, AI override, tag, dan catatan." /> : (
              <div className="space-y-5">
                <div className="rounded-md border border-border bg-background/30 p-3 text-sm">
                  <p className="font-medium">{displayName(selected)}</p>
                  <p className="font-mono text-xs text-muted-foreground">{selectedJid}</p>
                  <p className="mt-2 text-xs text-muted-foreground">Revision: {String(form.expectedRevision ?? "none")}</p>
                  {nullableId(selected) ? <p className="mt-1 text-xs text-muted-foreground">PIC: {picText(selected)}</p> : null}
                </div>
                <form onSubmit={saveContact} className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Select label="Status" value={form.status} values={statuses} onChange={(value) => setForm((current) => ({ ...current, status: value }))} required />
                    <Select label="Prioritas" value={form.priority} values={priorities} onChange={(value) => setForm((current) => ({ ...current, priority: value }))} required />
                  </div>
                  <div className="space-y-2"><Label htmlFor="crm-sla">SLA deadline</Label><Input id="crm-sla" type="datetime-local" value={form.slaDueAt} onChange={(event) => setForm((current) => ({ ...current, slaDueAt: event.target.value }))} /></div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Select label="Consent" value={form.consentStatus} values={consentStatuses} onChange={(value) => setForm((current) => ({ ...current, consentStatus: value }))} required />
                    <Select label="AI override" value={form.aiOverride} values={aiOverrides} onChange={(value) => setForm((current) => ({ ...current, aiOverride: value }))} required />
                  </div>
                  <div className="grid gap-2 text-sm">
                    <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={form.doNotContact} onChange={(event) => setForm((current) => ({ ...current, doNotContact: event.target.checked }))} />Do not contact</label>
                  </div>
                  {form.doNotContact ? <div className="space-y-2"><Label htmlFor="crm-dnc-reason">Alasan DNC</Label><Input id="crm-dnc-reason" value={form.doNotContactReason} onChange={(event) => setForm((current) => ({ ...current, doNotContactReason: event.target.value }))} maxLength={500} required /></div> : null}
                  <Button className="w-full" disabled={saving}>{saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}Simpan kontak</Button>
                </form>
                <div className="space-y-3 border-t border-border pt-4">
                  <h3 className="text-sm font-medium">Tags</h3>
                  <TagList tags={contactTags(selected)} onRemove={(tag) => void removeTag(tag)} />
                  <div className="flex flex-wrap gap-2">
                    {allTags.map((tag) => <Button key={getRecordId(tag) || getString(tag, "name")} variant="outline" size="sm" onClick={() => void attachTag(tag)}><Plus className="h-3.5 w-3.5" />{tagName(tag)}</Button>)}
                  </div>
                  <form onSubmit={createAndAttachTag} className="flex gap-2">
                    <Input aria-label="Tag baru" value={newTag} onChange={(event) => setNewTag(event.target.value)} placeholder="Tag baru" maxLength={40} />
                    <Button type="submit" variant="secondary">Tambah</Button>
                  </form>
                </div>
                <div className="space-y-3 border-t border-border pt-4">
                  <h3 className="text-sm font-medium">Catatan internal</h3>
                  <InlineNotice tone="warning">Catatan ini internal CRM. Tidak pernah dikirim ke kontak.</InlineNotice>
                  <form onSubmit={addNote} className="space-y-2">
                    <Textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Tulis catatan internal…" maxLength={1000} />
                    <Button disabled={notesBusy || !note.trim()}>{notesBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}Simpan catatan</Button>
                  </form>
                  <div className="space-y-2">
                    {notesResource.loading ? <LoadingState compact /> : notes.map((entry) => (
                      <div key={getRecordId(entry)} className="rounded-md border border-border bg-background/30 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <p className="whitespace-pre-wrap text-sm">{getString(entry, "content", "note", "body")}</p>
                          <Button variant="ghost" size="sm" onClick={() => void deleteNote(entry)}><Trash2 className="h-3.5 w-3.5" />Hapus</Button>
                        </div>
                        <p className="mt-2 text-xs text-muted-foreground">{formatDateTime(getValue(entry, "createdAt"))}</p>
                      </div>
                    ))}
                    {!notesResource.loading && !notes.length ? <p className="text-sm text-muted-foreground">Belum ada catatan.</p> : null}
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function Select({ label, value, values, onChange, required = false }: { label: string; value: string; values: string[]; onChange: (value: string) => void; required?: boolean }) {
  return <div className="space-y-2"><Label>{label}</Label><select className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-ring" value={value} onChange={(event) => onChange(event.target.value)} required={required}><option value="">Semua</option>{values.map((entry) => <option key={entry} value={entry}>{entry}</option>)}</select></div>;
}

function ContactCard({ contact, selected, onSelect }: { contact: Record<string, unknown>; selected: boolean; onSelect: () => void }) {
  return <button type="button" onClick={onSelect} className={`rounded-md border border-border p-4 text-left ${selected ? "bg-accent" : "bg-card"}`}><div className="flex items-start justify-between gap-3"><div><p className="font-medium">{displayName(contact)}</p><p className="font-mono text-xs text-muted-foreground">{contactJid(contact)}</p></div><StatusBadge value={getString(contact, "crmStatus") || "open"} /></div><div className="mt-3 flex flex-wrap gap-2 text-xs"><Badge>{getString(contact, "priority") || "normal"}</Badge><Badge>{getString(contact, "aiModeOverride") || "inherit"}</Badge>{getBoolean(contact, "doNotContact", "dnc") ? <Badge>DNC</Badge> : null}</div></button>;
}

function TagList({ tags, onRemove }: { tags: Record<string, unknown>[]; onRemove?: (tag: Record<string, unknown>) => void }) {
  if (!tags.length) return <span className="text-xs text-muted-foreground">Tanpa tag</span>;
  return <div className="flex flex-wrap gap-1.5">{tags.map((tag) => <Badge key={getRecordId(tag) || tagName(tag)}>{tagName(tag)}{onRemove ? <button type="button" className="ml-1 text-muted-foreground hover:text-foreground" onClick={() => onRemove(tag)} aria-label={`Lepas tag ${tagName(tag)}`}>×</button> : null}</Badge>)}</div>;
}

function contactJid(contact: Record<string, unknown>): string {
  return getString(contact, "jid", "remoteJid", "remote_jid", "waJid") || getRecordId(contact);
}

export function displayName(contact: Record<string, unknown>): string {
  return getString(contact, "displayName", "candidateName", "name", "pushName", "contactName") || "Tanpa nama";
}

function contactTags(contact: Record<string, unknown>): Record<string, unknown>[] {
  const value = getValue(contact, "tags");
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function tagName(tag: Record<string, unknown>): string {
  return getString(tag, "name", "label") || getRecordId(tag);
}

function nullableId(contact: Record<string, unknown>): string | null {
  return getString(contact, "assigneeUserId", "assigneeId", "assignedToId", "picId", "ownerId") || null;
}

function picText(contact: Record<string, unknown>): string {
  return getString(contact, "assigneeLabel", "assigneeName", "assignedToName", "picName", "ownerName") || nullableId(contact) || "Tidak tersedia";
}

function revision(record: Record<string, unknown>): string | number | null {
  const value = getValue(record, "expectedRevision") ?? getValue(record, "revision") ?? getValue(record, "version");
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function contactToForm(contact: Record<string, unknown>): ContactForm {
  return {
    status: getString(contact, "crmStatus") || blankForm.status,
    priority: getString(contact, "priority") || blankForm.priority,
    slaDueAt: toLocalDateTime(getValue(contact, "slaDueAt") ?? getValue(contact, "slaAt")),
    consentStatus: getString(contact, "consentStatus") || blankForm.consentStatus,
    doNotContact: getBoolean(contact, "doNotContact", "dnc"),
    doNotContactReason: getString(contact, "doNotContactReason"),
    aiOverride: getString(contact, "aiModeOverride") || blankForm.aiOverride,
    expectedRevision: revision(contact),
  };
}

function toLocalDateTime(value: unknown): string {
  if (!value) return "";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function conflictNotice(caught: unknown, fallback: string): { tone: Tone; text: string } {
  if (caught instanceof ApiError && caught.status === 409 && apiErrorCode(caught) === "REVISION_CONFLICT") return { tone: "warning", text: "Konflik revision. Muat ulang, cek perubahan terbaru, lalu simpan lagi." };
  return { tone: "danger", text: caught instanceof Error ? caught.message : fallback };
}

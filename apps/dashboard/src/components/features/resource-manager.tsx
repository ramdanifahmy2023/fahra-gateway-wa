"use client";

import { FormEvent, useMemo, useState } from "react";
import {
  Edit3,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Zap,
} from "lucide-react";
import { apiFetch } from "@/lib/client-api";
import { useApiResource } from "@/hooks/use-api-resource";
import type { ColumnDefinition, FieldDefinition } from "@/lib/types";
import {
  formatDateTime,
  getBoolean,
  getRecordId,
  getString,
  getValue,
  unwrapCollection,
} from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  EmptyState,
  ErrorState,
  InlineNotice,
  LoadingState,
} from "@/components/ui/feedback";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page";
import { StatusBadge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";

type ActionDefinition = { label: string; suffix: string; confirm?: string };

type Props = {
  title: string;
  eyebrow: string;
  description: string;
  endpoint: string;
  itemName: string;
  emptyDescription: string;
  fields: FieldDefinition[];
  columns: ColumnDefinition[];
  action?: ActionDefinition;
};

export function ResourceManager(props: Props) {
  const resource = useApiResource<unknown>(
    `/api/gateway${props.endpoint}?limit=100`,
  );
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    tone: "success" | "danger";
    text: string;
  } | null>(null);
  const records = useMemo(
    () =>
      unwrapCollection(resource.data).filter((record) =>
        Object.values(record).some(
          (value) =>
            typeof value === "string" &&
            value.toLowerCase().includes(query.toLowerCase()),
        ),
      ),
    [query, resource.data],
  );

  function create() {
    setEditing(null);
    const initial: Record<string, unknown> = {};
    for (const field of props.fields)
      initial[field.name] =
        field.defaultValue ??
        (field.type === "checkbox"
          ? true
          : field.type === "select"
            ? (field.options?.[0]?.value ?? "")
            : "");
    setValues(initial);
    setOpen(true);
  }

  function edit(record: Record<string, unknown>) {
    setEditing(record);
    const initial: Record<string, unknown> = {};
    for (const field of props.fields)
      initial[field.name] =
        field.type === "password" ? "" : (getValue(record, field.name) ?? "");
    setValues(initial);
    setOpen(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setNotice(null);
    const id = editing ? getRecordId(editing) : "";
    const payload = Object.fromEntries(
      Object.entries(values).filter(
        ([key, value]) =>
          !(
            props.fields.find((field) => field.name === key)?.type ===
              "password" && value === ""
          ),
      ),
    );
    if (editing && getValue(editing, "revision") !== undefined)
      payload.revision = getValue(editing, "revision");
    try {
      await apiFetch(
        `/api/gateway${props.endpoint}${id ? `/${encodeURIComponent(id)}` : ""}`,
        { method: id ? "PUT" : "POST", body: payload },
      );
      setOpen(false);
      setNotice({
        tone: "success",
        text: `${props.itemName} berhasil ${id ? "diperbarui" : "ditambahkan"}.`,
      });
      void resource.reload(true);
    } catch (caught) {
      setNotice({
        tone: "danger",
        text:
          caught instanceof Error
            ? caught.message
            : `${props.itemName} gagal disimpan.`,
      });
    } finally {
      setSaving(false);
    }
  }

  async function remove(record: Record<string, unknown>) {
    const id = getRecordId(record);
    if (
      !id ||
      !window.confirm(
        `Hapus ${props.itemName.toLowerCase()} “${getString(record, "name", "title")}”? Tindakan ini tercatat di audit log.`,
      )
    )
      return;
    setWorkingId(id);
    try {
      await apiFetch(
        `/api/gateway${props.endpoint}/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      setNotice({
        tone: "success",
        text: `${props.itemName} berhasil dihapus.`,
      });
      void resource.reload(true);
    } catch (caught) {
      setNotice({
        tone: "danger",
        text: caught instanceof Error ? caught.message : "Data gagal dihapus.",
      });
    } finally {
      setWorkingId(null);
    }
  }

  async function executeAction(record: Record<string, unknown>) {
    if (!props.action) return;
    const id = getRecordId(record);
    if (!id) return;
    if (props.action.confirm && !window.confirm(props.action.confirm)) return;
    setWorkingId(id);
    try {
      await apiFetch(
        `/api/gateway${props.endpoint}/${encodeURIComponent(id)}/${props.action.suffix}`,
        { method: "POST", headers: { "idempotency-key": crypto.randomUUID() } },
      );
      setNotice({
        tone: "success",
        text: `${props.action.label} berhasil dijadwalkan.`,
      });
      void resource.reload(true);
    } catch (caught) {
      setNotice({
        tone: "danger",
        text:
          caught instanceof Error
            ? caught.message
            : `${props.action.label} gagal.`,
      });
    } finally {
      setWorkingId(null);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow={props.eyebrow}
        title={props.title}
        description={props.description}
        actions={
          <>
            <Button variant="outline" onClick={() => void resource.reload()}>
              <RefreshCw className="h-4 w-4" />
              Muat ulang
            </Button>
            <Button onClick={create}>
              <Plus className="h-4 w-4" />
              Tambah {props.itemName}
            </Button>
          </>
        }
      />
      {notice ? (
        <div className="mb-5">
          <InlineNotice tone={notice.tone}>{notice.text}</InlineNotice>
        </div>
      ) : null}
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <CardTitle>{props.title}</CardTitle>
              <CardDescription>
                Perubahan tersimpan ke database dan dicatat pada audit log.
              </CardDescription>
            </div>
            <div className="relative w-full sm:w-72">
              <Search className="absolute left-3 top-3.5 h-4 w-4 text-muted-foreground" />
              <Input
                aria-label={`Cari ${props.itemName.toLowerCase()}`}
                className="pl-9"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`Cari ${props.itemName.toLowerCase()}…`}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {resource.loading ? (
            <LoadingState />
          ) : resource.error ? (
            <ErrorState
              message={resource.error}
              onRetry={() => void resource.reload()}
            />
          ) : !records.length ? (
            <EmptyState
              title={
                query
                  ? "Data tidak ditemukan"
                  : `Belum ada ${props.itemName.toLowerCase()}`
              }
              description={
                query ? "Ubah kata pencarian Anda." : props.emptyDescription
              }
              action={
                !query ? (
                  <Button size="sm" onClick={create}>
                    <Plus className="h-3.5 w-3.5" />
                    Tambah sekarang
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="data-table min-w-[760px]">
                <thead>
                  <tr>
                    {props.columns.map((column) => (
                      <th key={column.key}>{column.label}</th>
                    ))}
                    <th className="w-36">
                      <span className="sr-only">Aksi</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((record, index) => {
                    const id = getRecordId(record);
                    return (
                      <tr key={id || index}>
                        {props.columns.map((column) => (
                          <td key={column.key}>{formatCell(record, column)}</td>
                        ))}
                        <td>
                          <div className="flex justify-end gap-1">
                            {props.action ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={workingId === id}
                                onClick={() => void executeAction(record)}
                              >
                                {workingId === id ? (
                                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Zap className="h-3.5 w-3.5" />
                                )}
                                {props.action.label}
                              </Button>
                            ) : null}
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => edit(record)}
                              aria-label={`Edit ${props.itemName}`}
                            >
                              <Edit3 className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="hover:bg-destructive/10 hover:text-destructive"
                              disabled={workingId === id}
                              onClick={() => void remove(record)}
                              aria-label={`Hapus ${props.itemName}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title={`${editing ? "Edit" : "Tambah"} ${props.itemName}`}
          description="Isi field berikut lalu simpan ke Gateway API."
        >
          <form onSubmit={submit} className="space-y-4">
            {props.fields.map((field) => (
              <Field
                key={field.name}
                field={field}
                value={values[field.name]}
                editing={Boolean(editing)}
                onChange={(value) =>
                  setValues((current) => ({ ...current, [field.name]: value }))
                }
              />
            ))}
            <div className="sticky bottom-0 -mx-4 flex flex-col-reverse gap-2 border-t border-border bg-card/95 px-4 pb-1 pt-4 sm:-mx-6 sm:flex-row sm:justify-end sm:px-6">
              <Button
                type="button"
                variant="outline"
                className="w-full sm:w-auto"
                onClick={() => setOpen(false)}
              >
                Batal
              </Button>
              <Button className="w-full sm:w-auto" disabled={saving}>
                {saving ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : null}
                {saving ? "Menyimpan…" : "Simpan"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Field({
  field,
  value,
  editing,
  onChange,
}: {
  field: FieldDefinition;
  value: unknown;
  editing: boolean;
  onChange: (value: unknown) => void;
}) {
  const inputId = `field-${field.name}`;
  if (field.type === "checkbox")
    return (
      <label className="flex items-center justify-between gap-3 rounded-md border border-border bg-background/30 p-3">
        <span className="min-w-0">
          <span className="block text-sm font-medium">{field.label}</span>
          {field.help ? (
            <span className="mt-1 block text-xs text-muted-foreground">
              {field.help}
            </span>
          ) : null}
        </span>
        <input
          id={inputId}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
          className="h-4 w-4 shrink-0 accent-emerald-500"
        />
      </label>
    );
  return (
    <div className="space-y-2">
      <Label htmlFor={inputId}>{field.label}</Label>
      {field.type === "textarea" ? (
        <Textarea
          id={inputId}
          value={String(value ?? "")}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
          required={field.required}
        />
      ) : field.type === "select" ? (
        <select
          id={inputId}
          value={String(value ?? "")}
          onChange={(event) => onChange(event.target.value)}
          required={field.required}
          className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-ring"
        >
          {field.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <Input
          id={inputId}
          type={field.type ?? "text"}
          value={String(value ?? "")}
          onChange={(event) =>
            onChange(
              field.type === "number"
                ? event.target.valueAsNumber
                : event.target.value,
            )
          }
          placeholder={
            editing && field.type === "password"
              ? "Kosongkan jika tidak diubah"
              : field.placeholder
          }
          required={field.required && !(editing && field.type === "password")}
          min={field.min}
          max={field.max}
          step={field.step}
        />
      )}
      {field.help ? (
        <p className="text-xs leading-5 text-muted-foreground">{field.help}</p>
      ) : null}
    </div>
  );
}

function formatCell(record: Record<string, unknown>, column: ColumnDefinition) {
  const value = getValue(record, column.key);
  if (column.format === "date")
    return (
      <span className="whitespace-nowrap text-xs text-muted-foreground">
        {formatDateTime(value)}
      </span>
    );
  if (column.format === "status")
    return (
      <StatusBadge
        value={value ?? (record.enabled === false ? "inactive" : "active")}
      />
    );
  if (column.format === "boolean")
    return (
      <StatusBadge
        value={getBoolean(record, column.key) ? "active" : "inactive"}
      />
    );
  if (column.format === "secret")
    return (
      <span className="font-mono text-xs text-muted-foreground">••••••••</span>
    );
  const text = String(value ?? "Tidak tersedia");
  return (
    <span className="block max-w-sm truncate" title={text}>
      {text}
    </span>
  );
}

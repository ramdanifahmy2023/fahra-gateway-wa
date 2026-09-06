"use client";

import { useMemo, useState } from "react";
import {
  Archive,
  Download,
  HardDriveDownload,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { apiFetch } from "@/lib/client-api";
import { useApiResource } from "@/hooks/use-api-resource";
import {
  formatDateTime,
  formatNumber,
  getRecordId,
  getString,
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
import {
  EmptyState,
  ErrorState,
  InlineNotice,
  LoadingState,
} from "@/components/ui/feedback";
import { PageHeader } from "@/components/ui/page";
import { StatusBadge } from "@/components/ui/badge";

export function BackupPanel() {
  const resource = useApiResource<unknown>("/api/gateway/backups?limit=100");
  const backups = useMemo(
    () => unwrapCollection(resource.data),
    [resource.data],
  );
  const [working, setWorking] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    tone: "success" | "danger" | "warning";
    text: string;
  } | null>(null);

  async function createBackup() {
    setWorking("create");
    setNotice(null);
    try {
      await apiFetch("/api/gateway/backups", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: { scope: "full" },
      });
      setNotice({
        tone: "success",
        text: "Backup dijadwalkan. Proses berjalan di worker agar request dashboard tetap responsif.",
      });
      window.setTimeout(() => void resource.reload(true), 1500);
    } catch (caught) {
      setNotice({
        tone: "danger",
        text:
          caught instanceof Error
            ? caught.message
            : "Backup gagal dijadwalkan.",
      });
    } finally {
      setWorking(null);
    }
  }

  async function restore(record: Record<string, unknown>) {
    const id = getRecordId(record);
    if (
      !id ||
      !window.confirm(
        "Restore akan mengganti state database saat ini. Pastikan tidak ada operasi penting yang berjalan. Lanjutkan?",
      )
    )
      return;
    const confirmation = window.prompt(
      "Ketik RESTORE untuk mengonfirmasi pemulihan:",
    );
    if (confirmation !== "RESTORE") return;
    setWorking(id);
    setNotice({
      tone: "warning",
      text: "Restore sedang dijadwalkan. Dashboard dapat tidak tersedia sementara.",
    });
    try {
      await apiFetch(`/api/gateway/backups/${encodeURIComponent(id)}/restore`, {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: { confirmation: "RESTORE" },
      });
      setNotice({
        tone: "success",
        text: "Restore diterima worker. Pantau status dan log sebelum menjalankan operasi lain.",
      });
      window.setTimeout(() => void resource.reload(true), 2000);
    } catch (caught) {
      setNotice({
        tone: "danger",
        text:
          caught instanceof Error
            ? caught.message
            : "Restore gagal dijadwalkan.",
      });
    } finally {
      setWorking(null);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Disaster recovery"
        title="Backup"
        description="Lindungi agent identity, knowledge, konfigurasi, database, dan session WhatsApp terenkripsi."
        actions={
          <>
            <Button variant="outline" onClick={() => void resource.reload()}>
              <RefreshCw className="h-4 w-4" />
              Muat ulang
            </Button>
            <Button
              onClick={() => void createBackup()}
              disabled={working === "create"}
            >
              {working === "create" ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <HardDriveDownload className="h-4 w-4" />
              )}
              {working === "create" ? "Menjadwalkan…" : "Buat backup"}
            </Button>
          </>
        }
      />
      {notice ? (
        <div className="mb-5">
          <InlineNotice tone={notice.tone}>{notice.text}</InlineNotice>
        </div>
      ) : null}
      <div className="mb-5 grid divide-y divide-border rounded-lg border border-border bg-card md:grid-cols-3 md:divide-x md:divide-y-0">
        <Info
          icon={<Archive className="h-5 w-5" />}
          title="Workspace-local"
          text="Artefak berada di direktori data/backups yang dapat ditulis workspace."
        />
        <Info
          icon={<ShieldCheck className="h-5 w-5" />}
          title="Terenkripsi"
          text="Session WhatsApp dan secret tidak disimpan sebagai plaintext."
        />
        <Info
          icon={<RotateCcw className="h-5 w-5" />}
          title="Recovery terkontrol"
          text="Restore memerlukan konfirmasi dan tercatat di audit log."
        />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Riwayat backup &amp; restore</CardTitle>
          <CardDescription>
            Status berasal dari worker backup; file tidak diproses oleh browser.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {resource.loading ? (
            <LoadingState />
          ) : resource.error ? (
            <ErrorState
              message={resource.error}
              onRetry={() => void resource.reload()}
            />
          ) : !backups.length ? (
            <EmptyState
              title="Belum ada backup"
              description="Buat backup pertama sebelum melakukan perubahan besar atau pairing ulang."
              action={
                <Button size="sm" onClick={() => void createBackup()}>
                  <HardDriveDownload className="h-3.5 w-3.5" />
                  Buat backup
                </Button>
              }
            />
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="data-table min-w-[840px]">
                <thead>
                  <tr>
                    <th>Operasi</th>
                    <th>File</th>
                    <th>Status</th>
                    <th>Ukuran</th>
                    <th>Dibuat</th>
                    <th className="w-52">
                      <span className="sr-only">Aksi</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {backups.map((backup, index) => {
                    const id = getRecordId(backup);
                    const operation =
                      getString(backup, "operation").toLowerCase() || "backup";
                    const isBackup = operation === "backup";
                    return (
                      <tr key={id || index}>
                        <td className="capitalize">{operation}</td>
                        <td>
                          <p className="max-w-sm truncate font-medium">
                            {isBackup
                              ? getString(backup, "fileName", "name") || id
                              : `Sumber: ${getString(backup, "artifactPath") || "artifact backup"}`}
                          </p>
                          <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                            {getString(backup, "checksum", "sha256") ||
                              "Checksum belum tersedia"}
                          </p>
                        </td>
                        <td>
                          <StatusBadge
                            value={getString(backup, "status") || "unknown"}
                          />
                        </td>
                        <td>
                          {backup.sizeBytes
                            ? `${formatNumber(Number(backup.sizeBytes) / 1024 / 1024)} MB`
                            : "Tidak tersedia"}
                        </td>
                        <td className="whitespace-nowrap text-xs text-muted-foreground">
                          {formatDateTime(backup.createdAt)}
                        </td>
                        <td>
                          <div className="flex justify-end gap-1">
                            {isBackup &&
                            getString(backup, "status").toLowerCase() ===
                              "completed" ? (
                              <Button variant="ghost" size="sm" asChild>
                                <a
                                  href={`/api/gateway/backups/${encodeURIComponent(id)}/download`}
                                  download
                                >
                                  <Download className="h-3.5 w-3.5" />
                                  Unduh
                                </a>
                              </Button>
                            ) : null}
                            {isBackup ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={
                                  working === id ||
                                  getString(backup, "status").toLowerCase() !==
                                    "completed"
                                }
                                onClick={() => void restore(backup)}
                              >
                                {working === id ? (
                                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <RotateCcw className="h-3.5 w-3.5" />
                                )}
                                Restore
                              </Button>
                            ) : null}
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
    </>
  );
}

function Info({
  icon,
  title,
  text,
}: {
  icon: React.ReactNode;
  title: string;
  text: string;
}) {
  return (
    <div className="flex gap-3 p-4">
      <span className="rounded-md border border-border bg-secondary/60 p-2.5 text-primary">
        {icon}
      </span>
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{text}</p>
      </div>
    </div>
  );
}

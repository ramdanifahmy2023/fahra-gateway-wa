"use client";

import { useMemo, useState } from "react";
import { LoaderCircle, RefreshCw, Search, UsersRound } from "lucide-react";
import { apiFetch } from "@/lib/client-api";
import { useApiResource } from "@/hooks/use-api-resource";
import {
  formatDateTime,
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
import { Input } from "@/components/ui/input";
import { Badge, StatusBadge } from "@/components/ui/badge";
import {
  EmptyState,
  ErrorState,
  InlineNotice,
  LoadingState,
} from "@/components/ui/feedback";
import { PageHeader } from "@/components/ui/page";

export function GroupsPanel() {
  const resource = useApiResource<unknown>("/api/gateway/groups?limit=100", {
    pollMs: 30_000,
  });
  const [query, setQuery] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<{
    tone: "success" | "danger";
    text: string;
  } | null>(null);
  const groups = useMemo(
    () =>
      unwrapCollection(resource.data).filter((group) => {
        const haystack =
          `${getString(group, "name", "subject")} ${getString(group, "jid", "id")}`.toLowerCase();
        return haystack.includes(query.toLowerCase());
      }),
    [query, resource.data],
  );

  async function sync() {
    setSyncing(true);
    setNotice(null);
    try {
      await apiFetch("/api/gateway/groups/sync", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
      });
      setNotice({
        tone: "success",
        text: "Sinkronisasi grup dijadwalkan. Daftar akan diperbarui setelah Baileys selesai.",
      });
      window.setTimeout(() => void resource.reload(true), 1500);
    } catch (caught) {
      setNotice({
        tone: "danger",
        text: caught instanceof Error ? caught.message : "Sinkronisasi gagal.",
      });
    } finally {
      setSyncing(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Group directory"
        title="Groups"
        description="Daftar grup WhatsApp yang tersedia untuk mention detection dan pengiriman pesan."
        actions={
          <Button onClick={() => void sync()} disabled={syncing}>
            {syncing ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {syncing ? "Sinkronisasi…" : "Sinkronkan grup"}
          </Button>
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
              <CardTitle>Grup terdeteksi</CardTitle>
              <CardDescription>
                Pesan grup hanya diproses bila JID agent ada pada metadata
                mention.
              </CardDescription>
            </div>
            <div className="relative w-full sm:w-72">
              <Search className="absolute left-3 top-3.5 h-4 w-4 text-muted-foreground" />
              <Input
                aria-label="Cari grup berdasarkan nama atau JID"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="pl-9"
                placeholder="Cari nama atau JID…"
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
          ) : !groups.length ? (
            <EmptyState
              title={query ? "Grup tidak ditemukan" : "Belum ada grup"}
              description={
                query
                  ? "Ubah kata pencarian Anda."
                  : "Hubungkan WhatsApp lalu jalankan sinkronisasi grup."
              }
            />
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {groups.map((group, index) => (
                <article
                  key={getRecordId(group) || index}
                  className="rounded-lg border border-border bg-background/30 p-4"
                >
                  <div className="flex items-start gap-3">
                    <span className="rounded-md border border-border bg-secondary p-2.5 text-primary">
                      <UsersRound className="h-5 w-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="truncate font-medium">
                          {getString(group, "name", "subject") ||
                            "Grup tanpa nama"}
                        </h3>
                        <StatusBadge
                          value={group.active === false ? "inactive" : "active"}
                        />
                      </div>
                      <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                        {getString(group, "jid", "id")}
                      </p>
                    </div>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Badge>
                      {getString(group, "participantCount", "size") || "0"}{" "}
                      anggota
                    </Badge>
                    {group.agentIsParticipant ? (
                      <Badge>Agent anggota</Badge>
                    ) : null}
                  </div>
                  <p className="mt-4 border-t border-border/60 pt-3 text-[11px] text-muted-foreground">
                    Diperbarui{" "}
                    {formatDateTime(group.updatedAt ?? group.lastSyncedAt)}
                  </p>
                </article>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}

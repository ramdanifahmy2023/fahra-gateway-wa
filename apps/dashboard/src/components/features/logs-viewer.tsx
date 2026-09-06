"use client";

import { useMemo, useState } from "react";
import { RefreshCw, Search, ShieldCheck, TerminalSquare } from "lucide-react";
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
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/feedback";
import { PageHeader } from "@/components/ui/page";
import { StatusBadge } from "@/components/ui/badge";

export function LogsViewer() {
  const [tab, setTab] = useState<"operational" | "audit">("operational");
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState("");
  const params = new URLSearchParams({ limit: "100" });
  if (query) params.set("search", query);
  if (level && tab === "operational") params.set("level", level);
  const endpoint = tab === "audit" ? "/audit-logs" : "/logs";
  const resource = useApiResource<unknown>(
    `/api/gateway${endpoint}?${params}`,
    { pollMs: 15_000 },
  );
  const logs = useMemo(() => unwrapCollection(resource.data), [resource.data]);

  return (
    <>
      <PageHeader
        eyebrow="Observability"
        title="Logs"
        description="Telusuri event operasional dan audit administrator tanpa membaca file log langsung."
        actions={
          <Button variant="outline" onClick={() => void resource.reload()}>
            <RefreshCw className="h-4 w-4" />
            Muat ulang
          </Button>
        }
      />
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <CardTitle>
                {tab === "audit" ? "Audit log" : "Log operasional"}
              </CardTitle>
              <CardDescription>
                {tab === "audit"
                  ? "Jejak aksi admin dan perubahan konfigurasi."
                  : "Event service terstruktur; secret dan QR sudah direduksi backend."}
              </CardDescription>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="flex rounded-md border border-border bg-background p-1">
                <button
                  className={`flex min-h-11 items-center gap-2 rounded px-3 py-1.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${tab === "operational" ? "bg-secondary text-foreground" : "text-muted-foreground"}`}
                  onClick={() => setTab("operational")}
                >
                  <TerminalSquare className="h-3.5 w-3.5" />
                  Operasional
                </button>
                <button
                  className={`flex min-h-11 items-center gap-2 rounded px-3 py-1.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${tab === "audit" ? "bg-secondary text-foreground" : "text-muted-foreground"}`}
                  onClick={() => setTab("audit")}
                >
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Audit
                </button>
              </div>
              <div className="relative">
                <Search className="absolute left-3 top-3.5 h-4 w-4 text-muted-foreground" />
                <Input
                  aria-label="Cari event log"
                  className="pl-9 sm:w-64"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Cari event…"
                />
              </div>
              {tab === "operational" ? (
                <select
                  aria-label="Filter level log"
                  value={level}
                  onChange={(event) => setLevel(event.target.value)}
                  className="h-11 rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-ring"
                >
                  <option value="">Semua level</option>
                  <option value="error">Error</option>
                  <option value="warn">Warning</option>
                  <option value="info">Info</option>
                  <option value="debug">Debug</option>
                </select>
              ) : null}
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
          ) : !logs.length ? (
            <EmptyState
              title="Belum ada log"
              description="Event yang sesuai filter belum tersedia."
            />
          ) : (
            <div className="overflow-hidden rounded-md border border-border bg-[#070a10]">
              <div className="max-h-[650px] overflow-auto">
                <table className="data-table min-w-[920px] font-mono text-xs">
                  <thead className="sticky top-0 z-10">
                    <tr>
                      <th>Waktu</th>
                      <th>{tab === "audit" ? "Aktor" : "Level"}</th>
                      <th>{tab === "audit" ? "Aksi" : "Service"}</th>
                      <th>Event / detail</th>
                      <th>Request ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((log, index) => (
                      <tr key={getRecordId(log) || index}>
                        <td className="whitespace-nowrap text-muted-foreground">
                          {formatDateTime(log.createdAt ?? log.timestamp)}
                        </td>
                        <td>
                          {tab === "audit" ? (
                            getString(
                              log,
                              "actorEmail",
                              "actor",
                              "adminEmail",
                            ) || "system"
                          ) : (
                            <StatusBadge
                              value={getString(log, "level") || "info"}
                            />
                          )}
                        </td>
                        <td>
                          {getString(
                            log,
                            tab === "audit" ? "action" : "service",
                            "source",
                            "module",
                          ) || "gateway"}
                        </td>
                        <td>
                          <p className="max-w-2xl whitespace-pre-wrap break-words text-foreground/90">
                            {getString(
                              log,
                              "message",
                              "event",
                              "description",
                            ) ||
                              JSON.stringify(log.metadata ?? log.detail ?? {})}
                          </p>
                        </td>
                        <td className="max-w-44 truncate text-muted-foreground">
                          {getString(log, "requestId", "traceId") || "Tidak tersedia"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}

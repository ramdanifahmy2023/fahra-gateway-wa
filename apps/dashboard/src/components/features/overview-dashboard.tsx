"use client";

import Link from "next/link";
import {
  Activity,
  ArrowRight,
  Bot,
  Clock3,
  Database,
  MessageSquareText,
  RefreshCw,
  Server,
  Wifi,
} from "lucide-react";
import { useApiResource } from "@/hooks/use-api-resource";
import {
  asRecord,
  formatDateTime,
  formatNumber,
  getString,
  unwrapCollection,
  unwrapRecord,
} from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ErrorState, LoadingState, EmptyState } from "@/components/ui/feedback";
import { Metric, PageHeader } from "@/components/ui/page";
import { StatusBadge } from "@/components/ui/badge";

export function OverviewDashboard() {
  const overview = useApiResource<unknown>("/api/gateway/dashboard/overview", {
    pollMs: 30_000,
  });
  const health = useApiResource<unknown>("/api/gateway/health", {
    pollMs: 30_000,
  });

  if (overview.loading)
    return (
      <>
        <PageHeader
          eyebrow="Command center"
          title="Dashboard"
          description="Ringkasan operasional gateway secara real-time."
        />
        <LoadingState />
      </>
    );
  if (overview.error)
    return (
      <>
        <PageHeader
          eyebrow="Command center"
          title="Dashboard"
          description="Ringkasan operasional gateway secara real-time."
        />
        <ErrorState
          message={overview.error}
          onRetry={() => void overview.reload()}
        />
      </>
    );

  const data = unwrapRecord(overview.data);
  const messageStats = asRecord(data.messages ?? data.messageStats);
  const whatsapp = asRecord(data.whatsapp ?? data.connection);
  const queue = asRecord(data.queue ?? data.queues);
  const agent = asRecord(data.agent ?? data.agentProfile);
  const recent = Array.isArray(data.recentActivity)
    ? data.recentActivity.map(asRecord)
    : unwrapCollection(data.activity);
  const healthData = unwrapRecord(health.data);
  const dependencies = Object.entries(healthData).map(([name, value]) => {
    const check = asRecord(value);
    const explicitStatus = getString(check, "status", "state").toLowerCase();
    const healthy =
      check.ok === true ||
      check.available === true ||
      check.connected === true ||
      check.writable === true ||
      ["connected", "ready", "healthy", "running", "open"].includes(
        explicitStatus,
      );
    const degraded = !healthy && check.mode === "postgresql-fallback";
    return {
      name,
      ...check,
      status: healthy ? "healthy" : degraded ? "degraded" : "unavailable",
    };
  });

  return (
    <>
      <PageHeader
        eyebrow="Command center"
        title="Dashboard"
        description="Ringkasan koneksi WhatsApp, aliran pesan, queue, dan integrasi OpenClaw dari satu layar."
        actions={
          <Button variant="outline" onClick={() => void overview.reload()}>
            <RefreshCw className="h-4 w-4" />
            Muat ulang
          </Button>
        }
      />
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          label="WhatsApp"
          value={
            <StatusBadge
              value={
                getString(whatsapp, "status", "connectionStatus") || "unknown"
              }
            />
          }
          detail={
            getString(whatsapp, "phoneNumber", "jid") || "Belum ada nomor"
          }
          icon={<Wifi className="h-5 w-5" />}
          tone="success"
        />
        <Metric
          label="Pesan 24 jam"
          value={formatNumber(
            messageStats.total24h ??
              messageStats.today ??
              messageStats.totalToday ??
              data.messagesToday,
          )}
          detail={`${formatNumber(messageStats.inbound24h ?? messageStats.inboundToday ?? messageStats.inbound)} masuk · ${formatNumber(messageStats.outbound24h ?? messageStats.outboundToday ?? messageStats.outbound)} keluar`}
          icon={<MessageSquareText className="h-5 w-5" />}
        />
        <Metric
          label="Queue tertunda"
          value={formatNumber(
            queue.pending ?? queue.waiting ?? data.pendingMessages,
          )}
          detail={`${formatNumber(queue.failed ?? data.failedMessages)} gagal memerlukan perhatian`}
          icon={<Clock3 className="h-5 w-5" />}
          tone={
            Number(queue.failed ?? data.failedMessages ?? 0) > 0
              ? "warning"
              : "default"
          }
        />
        <Metric
          label="OpenClaw"
          value={
            <StatusBadge
              value={
                getString(
                  asRecord(data.openclaw ?? healthData.openclaw),
                  "status",
                ) || "unknown"
              }
            />
          }
          detail={
            asRecord(data.openclaw ?? healthData.openclaw).latencyMs !==
            undefined
              ? `${formatNumber(asRecord(data.openclaw ?? healthData.openclaw).latencyMs)} ms`
              : "Status bridge internal"
          }
          icon={<Bot className="h-5 w-5" />}
        />
      </section>

      <section className="mt-5 grid gap-5 xl:grid-cols-[1.4fr_.6fr]">
        <Card>
          <CardHeader className="flex-row items-start justify-between">
            <div>
              <CardTitle>Aktivitas terbaru</CardTitle>
              <CardDescription>
                Event terbaru yang diproses Gateway.
              </CardDescription>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/logs">
                Lihat log <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            {!recent.length ? (
              <EmptyState
                title="Belum ada aktivitas"
                description="Event akan tampil setelah gateway menerima koneksi atau pesan."
              />
            ) : (
              <div className="divide-y divide-border/60">
                {recent.slice(0, 8).map((item, index) => (
                  <div
                    key={getString(item, "id") || index}
                    className="flex items-start gap-3 py-3.5"
                  >
                    <span className="mt-1 rounded-md border border-border bg-secondary/50 p-2 text-primary">
                      <Activity className="h-3.5 w-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="truncate text-sm font-medium">
                          {getString(
                            item,
                            "title",
                            "event",
                            "action",
                            "message",
                          ) || "Event gateway"}
                        </p>
                        <span className="text-xs text-muted-foreground">
                          {formatDateTime(item.createdAt ?? item.timestamp)}
                        </span>
                      </div>
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {getString(item, "description", "detail", "source") ||
                          "Tidak ada detail tambahan"}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Kesehatan integrasi</CardTitle>
            <CardDescription>Pemeriksaan dependency runtime.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {health.loading ? (
              <LoadingState compact />
            ) : health.error ? (
              <ErrorState
                message={health.error}
                onRetry={() => void health.reload()}
              />
            ) : dependencies.length ? (
              dependencies.map((item, index) => (
                <div
                  key={getString(item, "name", "service") || index}
                  className="flex items-center justify-between rounded-md border border-border bg-background/30 px-3 py-3"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="rounded-md bg-secondary p-2 text-muted-foreground">
                      {getString(item, "name", "service")
                        .toLowerCase()
                        .includes("database") ? (
                        <Database className="h-4 w-4" />
                      ) : (
                        <Server className="h-4 w-4" />
                      )}
                    </span>
                    <div>
                      <p className="text-sm font-medium">
                        {getString(item, "name", "service") || "Dependency"}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {getString(item, "latency", "detail") ||
                          "Pemeriksaan aktif"}
                      </p>
                    </div>
                  </div>
                  <StatusBadge value={item.status} />
                </div>
              ))
            ) : (
              <EmptyState
                title="Belum ada detail health"
                description="Endpoint integrasi belum mengembalikan daftar dependency."
              />
            )}
          </CardContent>
        </Card>
      </section>

      <Card className="mt-5">
        <CardHeader>
          <CardTitle>Akses cepat</CardTitle>
          <CardDescription>
            Navigasi pendukung setelah status dan aktivitas diperiksa.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid divide-y divide-border md:grid-cols-3 md:divide-x md:divide-y-0">
            <QuickLink
              href="/whatsapp"
              icon={<Wifi className="h-5 w-5" />}
              title="Kelola WhatsApp"
              detail={
                getString(whatsapp, "lastConnectedAt")
                  ? `Terhubung ${formatDateTime(whatsapp.lastConnectedAt)}`
                  : "Pairing, reconnect, dan status sesi"
              }
            />
            <QuickLink
              href="/agent-profile"
              icon={<Bot className="h-5 w-5" />}
              title={getString(agent, "name") || "Profil Agent"}
              detail="Persona dan instruksi tetap persisten"
            />
            <QuickLink
              href="/backup"
              icon={<Database className="h-5 w-5" />}
              title="Perlindungan data"
              detail={
                data.lastBackupAt
                  ? `Backup ${formatDateTime(data.lastBackupAt)}`
                  : "Buat backup workspace sekarang"
              }
            />
          </div>
        </CardContent>
      </Card>
    </>
  );
}

function QuickLink({
  href,
  icon,
  title,
  detail,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <Link
      href={href}
      className="group flex min-h-20 items-center gap-4 rounded-md p-4 transition hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="rounded-md border border-border bg-secondary/60 p-2.5 text-primary">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        <p className="mt-1 truncate text-xs text-muted-foreground">{detail}</p>
      </div>
      <ArrowRight className="h-4 w-4 text-muted-foreground transition group-hover:translate-x-1 group-hover:text-primary" />
    </Link>
  );
}

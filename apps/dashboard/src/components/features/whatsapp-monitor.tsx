"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Cable,
  LogOut,
  QrCode,
  RefreshCcw,
  RefreshCw,
  Smartphone,
  Wifi,
  WifiOff,
} from "lucide-react";
import { apiFetch } from "@/lib/client-api";
import { useApiResource } from "@/hooks/use-api-resource";
import { asRecord, formatDateTime, getString, unwrapRecord } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ErrorState,
  InlineNotice,
  LoadingState,
} from "@/components/ui/feedback";
import { Metric, PageHeader } from "@/components/ui/page";
import { StatusBadge } from "@/components/ui/badge";
import { QrViewer } from "@/components/features/qr-viewer";

export function WhatsAppMonitor() {
  const status = useApiResource<unknown>("/api/gateway/whatsapp/status", {
    pollMs: 5_000,
  });
  const [action, setAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    tone: "success" | "danger";
    text: string;
  } | null>(null);
  const data = unwrapRecord(status.data);
  const connection = asRecord(data.connection ?? data);
  const state =
    getString(connection, "status", "state", "connectionStatus") || "unknown";
  const connected = ["connected", "open", "online", "ready"].includes(
    state.toLowerCase(),
  );

  async function command(
    name: "connect" | "restart" | "disconnect" | "logout",
  ) {
    if (
      (name === "disconnect" || name === "logout") &&
      !window.confirm(
        name === "logout"
          ? "Logout akan menghapus tautan perangkat WhatsApp. Lanjutkan?"
          : "Putuskan koneksi WhatsApp sekarang?",
      )
    )
      return;
    setAction(name);
    setNotice(null);
    try {
      await apiFetch("/api/gateway/whatsapp/actions", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: { action: name },
      });
      setNotice({
        tone: "success",
        text: "Perintah diterima dan sedang diproses service Baileys.",
      });
      window.setTimeout(() => void status.reload(true), 1200);
    } catch (caught) {
      setNotice({
        tone: "danger",
        text:
          caught instanceof Error ? caught.message : "Perintah gagal dikirim.",
      });
    } finally {
      setAction(null);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Baileys service"
        title="WhatsApp"
        description="Pantau lifecycle koneksi, perangkat tertaut, dan sesi WhatsApp yang tersimpan terenkripsi."
        actions={
          <>
            <Button variant="outline" onClick={() => void status.reload()}>
              <RefreshCw className="h-4 w-4" />
              Muat ulang
            </Button>
            <Button asChild>
              <Link href="/whatsapp/qr">
                <QrCode className="h-4 w-4" />
                Buka QR penuh
              </Link>
            </Button>
          </>
        }
      />
      {notice ? (
        <div className="mb-4">
          <InlineNotice tone={notice.tone}>{notice.text}</InlineNotice>
        </div>
      ) : null}
      {status.loading ? (
        <LoadingState />
      ) : status.error ? (
        <ErrorState
          message={status.error}
          onRetry={() => void status.reload()}
        />
      ) : (
        <>
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric
              label="Status koneksi"
              value={<StatusBadge value={state} />}
              detail={
                getString(connection, "reason", "lastDisconnectReason") ||
                "Lifecycle dipantau otomatis"
              }
              icon={
                connected ? (
                  <Wifi className="h-5 w-5" />
                ) : (
                  <WifiOff className="h-5 w-5" />
                )
              }
              tone={connected ? "success" : "warning"}
            />
            <Metric
              label="Nomor terhubung"
              value={
                <span className="text-lg">
                  {getString(connection, "phoneNumber", "phone", "jid") || "Tidak tersedia"}
                </span>
              }
              detail={
                getString(connection, "displayName", "pushName") ||
                "Belum ada profil"
              }
              icon={<Smartphone className="h-5 w-5" />}
            />
            <Metric
              label="Terhubung sejak"
              value={
                <span className="text-base">
                  {formatDateTime(
                    connection.connectedAt ?? connection.lastConnectedAt,
                  )}
                </span>
              }
              detail={`Reconnect: ${getString(connection, "reconnectAttempt", "reconnectAttempts") || "0"}`}
              icon={<Cable className="h-5 w-5" />}
            />
            <Metric
              label="Session"
              value={
                <StatusBadge
                  value={
                    getString(asRecord(data.session), "status") ||
                    (data.hasSession ? "tersimpan" : "tidak ada")
                  }
                />
              }
              detail={
                data.sessionUpdatedAt
                  ? formatDateTime(data.sessionUpdatedAt)
                  : "Credential terenkripsi"
              }
              icon={<RefreshCcw className="h-5 w-5" />}
            />
          </section>
          <section className="mt-5 grid gap-5 xl:grid-cols-[.85fr_1.15fr]">
            <Card>
              <CardHeader>
                <CardTitle>Kontrol koneksi</CardTitle>
                <CardDescription>
                  Perintah diteruskan ke control queue; UI tidak mengubah state
                  secara palsu.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Button
                  className="w-full justify-start"
                  onClick={() => void command("connect")}
                  disabled={Boolean(action)}
                >
                  <Wifi className="h-4 w-4" />
                  Mulai / pairing koneksi
                </Button>
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => void command("restart")}
                  disabled={Boolean(action)}
                >
                  <RefreshCcw className="h-4 w-4" />
                  Reconnect service
                </Button>
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => void command("disconnect")}
                  disabled={Boolean(action) || !connected}
                >
                  <WifiOff className="h-4 w-4" />
                  Putuskan sementara
                </Button>
                <Button
                  variant="destructive"
                  className="w-full justify-start"
                  onClick={() => void command("logout")}
                  disabled={Boolean(action)}
                >
                  <LogOut className="h-4 w-4" />
                  Logout dan hapus tautan
                </Button>
                <p className="pt-2 text-xs leading-5 text-muted-foreground">
                  Logout hanya menghapus session WhatsApp. Profil, knowledge,
                  tools, dan jobs agent tetap berada di database.
                </p>
              </CardContent>
            </Card>
            <QrViewer compact />
          </section>
        </>
      )}
    </>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import QRCode from "qrcode";
import { Clock3, QrCode, RefreshCw, ShieldCheck } from "lucide-react";
import { useApiResource } from "@/hooks/use-api-resource";
import { getString, unwrapRecord } from "@/lib/utils";
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

export function QrViewer({ compact = false }: { compact?: boolean }) {
  const qrResource = useApiResource<unknown>("/api/gateway/whatsapp/qr", {
    pollMs: 3_000,
  });
  const [image, setImage] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const data = useMemo(() => unwrapRecord(qrResource.data), [qrResource.data]);
  const rawQr = getString(data, "dataUrl", "qr", "qrCode", "value", "data");

  useEffect(() => {
    let active = true;
    const timeout = window.setTimeout(() => {
      if (!active) return;
      setRenderError(null);
      if (!rawQr) {
        setImage(null);
        return;
      }
      if (rawQr.startsWith("data:image/")) {
        setImage(rawQr);
        return;
      }
      void QRCode.toDataURL(rawQr, {
        width: 420,
        margin: 2,
        errorCorrectionLevel: "M",
        color: { dark: "#07120c", light: "#ffffff" },
      })
        .then((value) => {
          if (active) setImage(value);
        })
        .catch(() => {
          if (active)
            setRenderError("Payload QR dari service tidak dapat dirender.");
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [rawQr]);

  const content = qrResource.loading ? (
    <LoadingState label="Menunggu QR dari Baileys…" />
  ) : qrResource.errorStatus === 404 ? (
    <EmptyState
      title="QR belum tersedia"
      description="Minta sesi pairing baru jika nomor WhatsApp belum terhubung."
      action={
        <Button
          variant="outline"
          size="sm"
          onClick={() => void qrResource.reload()}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Periksa lagi
        </Button>
      }
    />
  ) : qrResource.error ? (
    <ErrorState
      message={qrResource.error}
      onRetry={() => void qrResource.reload()}
    />
  ) : renderError ? (
    <ErrorState message={renderError} />
  ) : image ? (
    <div className="flex flex-col items-center">
      <div className="rounded-xl border border-white/10 bg-white p-4 shadow-2xl">
        <Image
          src={image}
          alt="QR pairing WhatsApp"
          width={420}
          height={420}
          unoptimized
          className={compact ? "h-56 w-56" : "h-72 w-72 max-w-full"}
        />
      </div>
      <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
        <Clock3 className="h-3.5 w-3.5 text-warning" />
        QR diperbarui otomatis dan tidak disimpan di browser.
      </div>
    </div>
  ) : (
    <EmptyState
      title="QR belum tersedia"
      description="Minta sesi pairing baru jika nomor WhatsApp belum terhubung."
      action={
        <Button
          variant="outline"
          size="sm"
          onClick={() => void qrResource.reload()}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Periksa lagi
        </Button>
      }
    />
  );

  if (compact) return content;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <span className="rounded-md border border-primary/20 bg-primary/10 p-2.5 text-primary">
            <QrCode className="h-5 w-5" />
          </span>
          <div>
            <CardTitle>QR pairing WhatsApp</CardTitle>
            <CardDescription>
              Pindai dari WhatsApp → Perangkat tertaut.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {content}
        <div className="mt-5">
          <InlineNotice tone="info">
            <span className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" />
              QR bersifat sementara. Jangan bagikan tangkapan layar pairing.
            </span>
          </InlineNotice>
        </div>
      </CardContent>
    </Card>
  );
}

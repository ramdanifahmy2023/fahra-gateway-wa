import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { QrViewer } from "@/components/features/qr-viewer";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page";

export const metadata = { title: "QR WhatsApp" };

export default function QrPage() {
  return (
    <>
      <PageHeader
        eyebrow="Pairing aman"
        title="Pindai QR WhatsApp"
        description="QR diambil langsung dari service Baileys dan diperbarui otomatis selama proses pairing."
        actions={
          <Button asChild variant="outline">
            <Link href="/whatsapp">
              <ArrowLeft className="h-4 w-4" />
              Kembali
            </Link>
          </Button>
        }
      />
      <div className="mx-auto max-w-xl">
        <QrViewer />
      </div>
    </>
  );
}

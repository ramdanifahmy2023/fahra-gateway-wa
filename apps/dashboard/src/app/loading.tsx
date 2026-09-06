import { LoadingState } from "@/components/ui/feedback";

export default function Loading() {
  return (
    <div className="min-h-screen">
      <LoadingState label="Menyiapkan konsol…" />
    </div>
  );
}

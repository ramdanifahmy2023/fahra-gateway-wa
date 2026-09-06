import { AlertTriangle, Inbox, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function LoadingState({
  label = "Memuat data…",
  compact = false,
}: {
  label?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-center gap-3 text-sm text-muted-foreground",
        compact ? "py-6" : "min-h-56",
      )}
    >
      <LoaderCircle className="h-4 w-4 animate-spin text-primary" />
      {label}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex min-h-44 flex-col items-center justify-center gap-3 rounded-lg border border-destructive/25 bg-destructive/5 p-6 text-center">
      <AlertTriangle className="h-6 w-6 text-red-300" />
      <div>
        <p className="font-medium text-red-200">Data tidak dapat dimuat</p>
        <p className="mt-1 max-w-lg text-sm text-muted-foreground">{message}</p>
      </div>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Coba lagi
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center rounded-lg border border-dashed border-border bg-background/25 p-7 text-center">
      <span className="mb-3 rounded-full border border-border bg-secondary/60 p-3">
        <Inbox className="h-5 w-5 text-muted-foreground" />
      </span>
      <p className="font-medium">{title}</p>
      <p className="mt-1 max-w-lg text-sm text-muted-foreground">
        {description}
      </p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function InlineNotice({
  tone = "info",
  children,
}: {
  tone?: "info" | "success" | "warning" | "danger";
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2 text-sm",
        tone === "info" && "border-sky-400/25 bg-sky-400/5 text-sky-200",
        tone === "success" && "border-success/25 bg-success/5 text-emerald-200",
        tone === "warning" && "border-warning/25 bg-warning/5 text-amber-200",
        tone === "danger" &&
          "border-destructive/25 bg-destructive/5 text-red-200",
      )}
    >
      {children}
    </div>
  );
}

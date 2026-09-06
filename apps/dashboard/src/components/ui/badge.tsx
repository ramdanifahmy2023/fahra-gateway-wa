import { type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Badge({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-border bg-secondary px-2.5 py-0.5 text-xs font-medium text-secondary-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function StatusBadge({ value }: { value: unknown }) {
  const label = String(value ?? "unknown").toLowerCase();
  const positive = [
    "connected",
    "online",
    "healthy",
    "ready",
    "active",
    "sent",
    "delivered",
    "read",
    "success",
    "running",
  ].some((item) => label.includes(item));
  const warning = [
    "pending",
    "connecting",
    "queued",
    "retry",
    "warning",
    "degraded",
  ].some((item) => label.includes(item));
  return (
    <Badge
      className={cn(
        positive && "border-success/30 bg-success/10 text-success",
        warning && "border-warning/30 bg-warning/10 text-warning",
        !positive &&
          !warning &&
          "border-destructive/30 bg-destructive/10 text-red-300",
      )}
    >
      <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-current" />
      {label || "unknown"}
    </Badge>
  );
}

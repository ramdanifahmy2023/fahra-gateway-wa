import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 border-b border-border/60 pb-6 md:flex-row md:items-end md:justify-between">
      <div>
        {eyebrow ? (
          <p className="mb-2 text-xs font-semibold uppercase tracking-[.18em] text-primary">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
          {title}
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

export function Metric({
  label,
  value,
  detail,
  icon,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  icon: ReactNode;
  tone?: "default" | "success" | "warning";
}) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-lg border bg-card p-5",
        tone === "success"
          ? "border-success/45"
          : tone === "warning"
            ? "border-warning/55"
            : "border-border",
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {label}
          </p>
          <div className="mt-2 text-2xl font-semibold tracking-tight">
            {value}
          </div>
          {detail ? (
            <div className="mt-2 text-xs text-muted-foreground">{detail}</div>
          ) : null}
        </div>
        <div
          className={cn(
            "rounded-md border bg-secondary/60 p-2.5",
            tone === "success"
              ? "border-success/45 text-success"
              : tone === "warning"
                ? "border-warning/55 text-warning"
                : "border-border text-primary",
          )}
        >
          {icon}
        </div>
      </div>
    </div>
  );
}

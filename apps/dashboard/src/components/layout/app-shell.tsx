/* eslint-disable @next/next/no-img-element */
"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  ChevronRight,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  ShieldCheck,
  X,
} from "lucide-react";
import { navigation } from "@/lib/navigation";
import { cn, getString, unwrapRecord } from "@/lib/utils";
import { apiFetch } from "@/lib/client-api";
import { StatusBadge } from "@/components/ui/badge";

export function AppShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [desktopNavigation, setDesktopNavigation] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [user, setUser] = useState<Record<string, unknown>>({});
  const [ready, setReady] = useState("checking");
  const mobileOpenButton = useRef<HTMLButtonElement>(null);
  const mobileCloseButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let active = true;
    const timeout = window.setTimeout(() => {
      if (
        window.localStorage.getItem("ocgw_sidebar_collapsed") === "1" &&
        active
      )
        setCollapsed(true);
      void apiFetch("/api/session/me")
        .then((payload) => {
          if (active) setUser(unwrapRecord(payload));
        })
        .catch(() => undefined);
      void apiFetch<Record<string, unknown>>("/api/health/ready")
        .then((payload) => {
          if (active)
            setReady(getString(unwrapRecord(payload), "status") || "ready");
        })
        .catch(() => {
          if (active) setReady("unavailable");
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)");
    const update = () => setDesktopNavigation(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!mobileOpen) return;
    mobileCloseButton.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      mobileOpenButton.current?.focus();
      setMobileOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileOpen]);

  function closeMobileNavigation(restoreFocus = false) {
    if (restoreFocus) mobileOpenButton.current?.focus();
    setMobileOpen(false);
  }

  function toggleCollapsed() {
    setCollapsed((value) => {
      window.localStorage.setItem("ocgw_sidebar_collapsed", value ? "0" : "1");
      return !value;
    });
  }

  async function logout() {
    await apiFetch("/api/session/logout", { method: "POST" }).catch(
      () => undefined,
    );
    router.replace("/login");
    router.refresh();
  }

  const current = navigation.find(
    (item) => path === item.href || path.startsWith(`${item.href}/`),
  );
  const email =
    getString(unwrapRecord(user.user ?? user.data ?? user), "email") ||
    "Administrator";
  const navigationCollapsed = desktopNavigation && collapsed;

  return (
    <div className="min-h-screen bg-background">
      {mobileOpen ? (
        <button
          className="fixed inset-0 z-40 bg-black/70 lg:hidden"
          aria-label="Tutup navigasi"
          tabIndex={-1}
          onClick={() => closeMobileNavigation(true)}
        />
      ) : null}
      <aside
        aria-hidden={!desktopNavigation && !mobileOpen}
        inert={!desktopNavigation && !mobileOpen}
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex flex-col border-r border-border bg-[#0a0e15]/98 transition-[width,transform] duration-200 lg:translate-x-0",
          navigationCollapsed ? "w-[76px]" : "w-[268px]",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-[68px] items-center border-b border-border px-4 py-4">
          <Link
            href="/dashboard"
            aria-label="Dashboard"
            className="flex min-h-11 min-w-0 items-center gap-3"
            onClick={() => closeMobileNavigation()}
          >
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-primary/25 bg-primary/10">
              <img src="/brand/ocgw-app-icon.svg" alt="" className="h-7 w-7" />
            </span>
            {!navigationCollapsed ? (
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">
                  OpenClaw WhatsApp Gateway
                </p>
                <p className="truncate text-[11px] uppercase tracking-[.16em] text-muted-foreground">
                  Baileys · Local-first ops
                </p>
              </div>
            ) : null}
          </Link>
          <button
            ref={mobileCloseButton}
            className="ml-auto inline-flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
            onClick={() => closeMobileNavigation(true)}
            aria-label="Tutup menu"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav
          className="flex-1 space-y-1 overflow-y-auto p-3"
          aria-label="Navigasi utama"
        >
          {!navigationCollapsed ? (
            <p className="mb-3 px-3 pt-2 text-[10px] font-semibold uppercase tracking-[.18em] text-muted-foreground">
              Operasional
            </p>
          ) : null}
          {navigation.map((item) => {
            const active =
              path === item.href || path.startsWith(`${item.href}/`);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-label={navigationCollapsed ? item.label : undefined}
                title={navigationCollapsed ? item.label : undefined}
                onClick={() => closeMobileNavigation()}
                className={cn(
                  "group flex h-11 items-center gap-3 rounded-md px-3 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
                  navigationCollapsed && "justify-center px-0",
                )}
              >
                <Icon className="h-[18px] w-[18px] shrink-0" />
                {!navigationCollapsed ? <span>{item.label}</span> : null}
                {active && !navigationCollapsed ? (
                  <ChevronRight className="ml-auto h-3.5 w-3.5" />
                ) : null}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-border p-3">
          {!navigationCollapsed ? (
            <div className="mb-3 rounded-md border border-border bg-secondary/30 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  Gateway API
                </span>
                <StatusBadge value={ready} />
              </div>
            </div>
          ) : null}
          <button
            onClick={logout}
            aria-label="Keluar"
            className={cn(
              "flex min-h-11 w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              navigationCollapsed && "justify-center px-0",
            )}
            title={navigationCollapsed ? "Keluar" : undefined}
          >
            <LogOut className="h-[18px] w-[18px]" />
            {!navigationCollapsed ? "Keluar" : null}
          </button>
        </div>
      </aside>

      <div
        aria-hidden={!desktopNavigation && mobileOpen}
        inert={!desktopNavigation && mobileOpen}
        className={cn(
          "transition-[padding] duration-200",
          collapsed ? "lg:pl-[76px]" : "lg:pl-[268px]",
        )}
      >
        <header className="sticky top-0 z-30 flex h-[68px] items-center border-b border-border bg-background px-4 sm:px-6">
          <button
            ref={mobileOpenButton}
            className="mr-3 inline-flex h-11 w-11 items-center justify-center rounded-md border border-input text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Buka menu"
          >
            <Menu className="h-4 w-4" />
          </button>
          <button
            className="mr-4 hidden h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:inline-flex"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Perluas sidebar" : "Perkecil sidebar"}
          >
            {collapsed ? (
              <PanelLeftOpen className="h-4 w-4" />
            ) : (
              <PanelLeftClose className="h-4 w-4" />
            )}
          </button>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {current?.label ?? "OpenClaw WhatsApp Gateway"}
            </p>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Activity className="h-3 w-3 text-primary" />
              Local by default. Reliable by design.
            </div>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="max-w-48 truncate text-xs font-medium">{email}</p>
              <p className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
                <ShieldCheck className="h-3 w-3 text-primary" />
                Admin
              </p>
            </div>
            <span className="grid h-9 w-9 place-items-center rounded-full border border-primary/25 bg-primary/10 text-xs font-semibold uppercase text-primary">
              {email.slice(0, 2)}
            </span>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1600px] p-4 sm:p-6 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}

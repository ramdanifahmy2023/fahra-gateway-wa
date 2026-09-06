import { NextResponse } from "next/server";
import {
  applySessionCookies,
  clearSessionCookies,
  readSessionCookies,
  secureCookies,
} from "@/lib/server/auth";
import {
  callGateway,
  parseJson,
  refreshSession,
  sanitizePayload,
} from "@/lib/server/gateway";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: import("next/server").NextRequest) {
  const session = await readSessionCookies();
  if (!session.accessToken && !session.refreshToken) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  try {
    let accessToken = session.accessToken;
    let refreshed = null;
    let upstream = accessToken
      ? await callGateway("/api/v1/auth/me", {}, accessToken)
      : null;
    if (!upstream || upstream.status === 401) {
      await upstream?.body?.cancel().catch(() => undefined);
      refreshed = await refreshSession();
      if (!refreshed) {
        const response = NextResponse.json(
          { authenticated: false },
          { status: 401 },
        );
        clearSessionCookies(response, secureCookies(request));
        return response;
      }
      accessToken = refreshed.tokens.accessToken;
      upstream = await callGateway("/api/v1/auth/me", {}, accessToken);
    }

    const payload = sanitizePayload(await parseJson(upstream));
    const root = asRecord(payload);
    const data = asRecord(root.data ?? root);
    const user = asRecord(data.user ?? data.admin ?? data);
    const userMustChange = Boolean(
      user.forcePasswordChange ??
      user.force_password_change ??
      user.mustChangePassword ??
      user.must_change_password,
    );
    const response = NextResponse.json(
      {
        authenticated: upstream.ok,
        user,
        mustChangePassword:
          refreshed?.mustChangePassword ??
          (session.forcePasswordChange || userMustChange),
      },
      { status: upstream.status },
    );
    if (refreshed)
      applySessionCookies(
        response,
        refreshed.tokens,
        refreshed.mustChangePassword,
        secureCookies(request),
      );
    return response;
  } catch {
    return NextResponse.json(
      { authenticated: false, error: "Gateway API tidak dapat dijangkau." },
      { status: 503 },
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

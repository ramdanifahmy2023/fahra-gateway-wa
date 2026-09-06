import { NextRequest, NextResponse } from "next/server";
import {
  applySessionCookies,
  readSessionCookies,
  secureCookies,
} from "@/lib/server/auth";
import {
  callGateway,
  ensureSameOrigin,
  extractAuthResult,
  parseJson,
  readBoundedJson,
  RequestBodyTooLargeError,
  refreshSession,
  sanitizePayload,
} from "@/lib/server/gateway";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const csrf = ensureSameOrigin(request);
  if (csrf) return csrf;
  let body: unknown;
  try {
    body = await readBoundedJson(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError)
      return NextResponse.json({ error: error.message }, { status: 413 });
    throw error;
  }
  const session = await readSessionCookies();
  let accessToken = session.accessToken;
  let refreshed = null;

  if (!accessToken && session.refreshToken) {
    refreshed = await refreshSession();
    accessToken = refreshed?.tokens.accessToken;
  }
  if (!accessToken)
    return NextResponse.json({ error: "Sesi tidak valid." }, { status: 401 });

  try {
    let upstream = await callGateway(
      "/api/v1/auth/change-password",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      accessToken,
    );

    if (upstream.status === 401 && session.refreshToken) {
      refreshed = await refreshSession();
      if (refreshed) {
        await upstream.body?.cancel().catch(() => undefined);
        upstream = await callGateway(
          "/api/v1/auth/change-password",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
          refreshed.tokens.accessToken,
        );
      }
    }

    const payload = await parseJson(upstream);
    if (!upstream.ok)
      return NextResponse.json(sanitizePayload(payload), {
        status: upstream.status,
      });

    const rotated = extractAuthResult(payload);
    const response = NextResponse.json({
      success: true,
      message: "Password berhasil diubah.",
    });
    if (rotated)
      applySessionCookies(
        response,
        rotated.tokens,
        false,
        secureCookies(request),
      );
    else
      response.cookies.set("ocgw_force_change", "0", {
        httpOnly: true,
        sameSite: "strict",
        secure: secureCookies(request),
        path: "/",
        maxAge: 604800,
      });
    return response;
  } catch {
    return NextResponse.json(
      { error: "Gateway API tidak dapat dijangkau." },
      { status: 503 },
    );
  }
}

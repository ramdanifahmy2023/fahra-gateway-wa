import { NextRequest, NextResponse } from "next/server";
import { applySessionCookies, secureCookies } from "@/lib/server/auth";
import {
  callGateway,
  ensureSameOrigin,
  extractAuthResult,
  parseJson,
  readBoundedJson,
  RequestBodyTooLargeError,
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
  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { error: "Payload login tidak valid." },
      { status: 400 },
    );
  }

  try {
    const upstream = await callGateway("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await parseJson(upstream);
    if (!upstream.ok) {
      return NextResponse.json(sanitizePayload(payload), {
        status: upstream.status,
      });
    }
    const auth = extractAuthResult(payload);
    if (!auth)
      return NextResponse.json(
        { error: "Respons autentikasi gateway tidak lengkap." },
        { status: 502 },
      );

    const response = NextResponse.json({
      authenticated: true,
      user: auth.user,
      mustChangePassword: auth.mustChangePassword,
    });
    applySessionCookies(
      response,
      auth.tokens,
      auth.mustChangePassword,
      secureCookies(request),
    );
    return response;
  } catch {
    return NextResponse.json(
      { error: "Gateway API tidak dapat dijangkau." },
      { status: 503 },
    );
  }
}

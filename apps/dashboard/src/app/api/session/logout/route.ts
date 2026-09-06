import { NextRequest, NextResponse } from "next/server";
import {
  clearSessionCookies,
  readSessionCookies,
  secureCookies,
} from "@/lib/server/auth";
import { callGateway, ensureSameOrigin } from "@/lib/server/gateway";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const csrf = ensureSameOrigin(request);
  if (csrf) return csrf;
  const session = await readSessionCookies();
  if (session.refreshToken) {
    await callGateway(
      "/api/v1/auth/logout",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: session.refreshToken }),
      },
      session.accessToken,
    ).catch(() => undefined);
  }
  const response = NextResponse.json({ success: true });
  clearSessionCookies(response, secureCookies(request));
  return response;
}

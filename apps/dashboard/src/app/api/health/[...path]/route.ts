import { NextRequest, NextResponse } from "next/server";
import {
  callGateway,
  copyResponse,
  proxyAuthenticatedGatewayGet,
} from "@/lib/server/gateway";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const allowed = new Set(["live", "ready", "integrations"]);
  if (path.length !== 1 || !path[0] || !allowed.has(path[0])) {
    return NextResponse.json(
      { error: "Health endpoint tidak ditemukan." },
      { status: 404 },
    );
  }
  if (path[0] === "integrations")
    return proxyAuthenticatedGatewayGet(request, "/health/integrations");
  try {
    return copyResponse(await callGateway(`/health/${path[0]}`));
  } catch {
    return NextResponse.json(
      { status: "unavailable", error: "Gateway API tidak dapat dijangkau." },
      { status: 503 },
    );
  }
}

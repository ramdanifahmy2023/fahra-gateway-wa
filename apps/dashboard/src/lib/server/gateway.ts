import "server-only";

import { NextRequest, NextResponse } from "next/server";
import {
  applySessionCookies,
  type AuthTokens,
  readSessionCookies,
  secureCookies,
} from "@/lib/server/auth";

const rawGatewayUrl = process.env.GATEWAY_API_URL ?? "http://127.0.0.1:3100";
const gatewayUrl = new URL(rawGatewayUrl);

if (
  !isLoopback(gatewayUrl.hostname) &&
  process.env.ALLOW_REMOTE_GATEWAY_API !== "true"
) {
  throw new Error(
    "GATEWAY_API_URL harus memakai alamat loopback kecuali ALLOW_REMOTE_GATEWAY_API=true.",
  );
}

const allowedProxyRoutes: Array<{ method: string; pattern: RegExp }> = [
  route("GET", "dashboard/overview"),
  route("GET", "whatsapp/status"),
  route("GET", "whatsapp/qr"),
  route("POST", "whatsapp/actions"),
  route("GET", "messages"),
  route("GET", "messages/conversations"),
  route("GET", "messages/:id"),
  route("GET", "messages/analytics/receipts"),
  route("GET", "messages/queue/failed"),
  route("POST", "messages"),
  route("POST", "messages/send"),
  route("POST", "messages/:id/retry"),
  route("POST", "messages/:id/reaction"),
  route("POST", "messages/:id/mark-read"),
  route("POST", "messages/:id/typing"),
  route("POST", "uploads"),
  route("POST", "status/text"),
  route("POST", "status/media"),
  route("GET", "crm/config"),
  route("PUT", "crm/config"),
  route("GET", "crm/contacts"),
  route("PUT", "crm/contacts/:jid"),
  route("GET", "crm/tags"),
  route("POST", "crm/tags"),
  route("PUT", "crm/contacts/:jid/tags/:tagId"),
  route("DELETE", "crm/contacts/:jid/tags/:tagId"),
  route("GET", "crm/contacts/:jid/notes"),
  route("POST", "crm/contacts/:jid/notes"),
  route("DELETE", "crm/notes/:noteId"),
  route("GET", "contact-memory"),
  route("POST", "contact-memory/:jid/manual-mode"),
  route("POST", "contact-memory/:jid/ai-mode"),
  route("PUT", "contact-memory/:jid"),
  route("DELETE", "contact-memory/:jid"),
  route("GET", "groups"),
  route("POST", "groups/sync"),
  route("GET", "health"),
  route("GET", "agent-profile"),
  route("PUT", "agent-profile"),
  route("GET", "agent/profile"),
  route("PUT", "agent/profile"),
  route("GET", "knowledge"),
  route("POST", "knowledge"),
  route("GET", "knowledge/:id"),
  route("PUT", "knowledge/:id"),
  route("DELETE", "knowledge/:id"),
  route("GET", "tools"),
  route("POST", "tools"),
  route("PUT", "tools/:id"),
  route("DELETE", "tools/:id"),
  route("GET", "jobs"),
  route("POST", "jobs"),
  route("PUT", "jobs/:id"),
  route("DELETE", "jobs/:id"),
  route("POST", "jobs/:id/run"),
  route("GET", "ai-providers"),
  route("POST", "ai-providers"),
  route("PUT", "ai-providers/:id"),
  route("DELETE", "ai-providers/:id"),
  route("POST", "ai-providers/:id/test"),
  route("GET", "logs"),
  route("GET", "audit-logs"),
  route("GET", "settings"),
  route("PUT", "settings"),
  route("GET", "backups"),
  route("POST", "backups"),
  route("GET", "backups/:id/download"),
  route("POST", "backups/:id/restore"),
];

function route(method: string, template: string): { method: string; pattern: RegExp } {
  const pattern = template
    .split("/")
    .map((segment) => (segment.startsWith(":") ? "[^/]+" : escapeRegExp(segment)))
    .join("/");
  return { method, pattern: new RegExp(`^${pattern}$`) };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isAllowedProxyRoute(method: string, path: string): boolean {
  return allowedProxyRoutes.some(
    (route) => route.method === method && route.pattern.test(path),
  );
}

type AuthResult = {
  tokens: AuthTokens;
  user?: Record<string, unknown>;
  mustChangePassword: boolean;
};
const refreshFlights = new Map<string, Promise<AuthResult | null>>();

export class RequestBodyTooLargeError extends Error {}

export async function readBoundedBody(
  request: NextRequest,
  maximumBytes: number,
): Promise<ArrayBuffer | undefined> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes)
    throw new RequestBodyTooLargeError(
      "Ukuran permintaan melewati batas dashboard.",
    );
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RequestBodyTooLargeError(
        "Ukuran permintaan melewati batas dashboard.",
      );
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

export async function readBoundedJson(
  request: NextRequest,
  maximumBytes = 64 * 1024,
): Promise<unknown> {
  const body = await readBoundedBody(request, maximumBytes);
  if (!body || body.byteLength === 0) return null;
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
}

export function ensureSameOrigin(request: NextRequest): NextResponse | null {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return null;
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  const forwardedHost = request.headers
    .get("x-forwarded-host")
    ?.split(",")[0]
    ?.trim();
  const expectedHost = forwardedHost ?? request.headers.get("host");

  if (origin) {
    try {
      const originUrl = new URL(origin);
      if (!expectedHost || originUrl.host !== expectedHost) {
        return NextResponse.json(
          { error: "Origin permintaan tidak diizinkan." },
          { status: 403 },
        );
      }
      return null;
    } catch {
      return NextResponse.json(
        { error: "Origin permintaan tidak valid." },
        { status: 403 },
      );
    }
  }

  if (fetchSite === "same-origin") return null;
  return NextResponse.json(
    { error: "Origin permintaan wajib untuk aksi ini." },
    { status: 403 },
  );
}

export async function callGateway(
  path: string,
  init: RequestInit = {},
  accessToken?: string,
): Promise<Response> {
  const url = new URL(path, gatewayUrl);
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);

  return fetch(url, {
    ...init,
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
}

export async function parseJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

export function extractAuthResult(payload: unknown): AuthResult | null {
  const root = asRecord(payload);
  const data = asRecord(root.data ?? root);
  const tokenContainer = asRecord(data.tokens ?? data.token ?? data);
  const accessToken = asString(
    tokenContainer.accessToken ?? tokenContainer.access_token,
  );
  const refreshToken = asString(
    tokenContainer.refreshToken ?? tokenContainer.refresh_token,
  );
  if (!accessToken) return null;

  const user = asRecord(data.user ?? data.admin ?? root.user ?? root.admin);
  const mustChangePassword = Boolean(
    data.mustChangePassword ??
    data.must_change_password ??
    data.requiresPasswordChange ??
    data.requires_password_change ??
    data.forcePasswordChange ??
    data.force_password_change ??
    user.mustChangePassword ??
    user.must_change_password ??
    user.forcePasswordChange ??
    user.force_password_change,
  );

  return {
    tokens: {
      accessToken,
      refreshToken: refreshToken || undefined,
      accessExpiresIn: asNumber(
        tokenContainer.accessExpiresIn ?? tokenContainer.expiresIn,
      ),
      refreshExpiresIn: asNumber(tokenContainer.refreshExpiresIn),
    },
    user: Object.keys(user).length
      ? (sanitizePayload(user) as Record<string, unknown>)
      : undefined,
    mustChangePassword,
  };
}

export async function refreshSession(): Promise<AuthResult | null> {
  const { refreshToken } = await readSessionCookies();
  if (!refreshToken) return null;
  const existing = refreshFlights.get(refreshToken);
  if (existing) return existing;
  const flight = (async () => {
    const response = await callGateway("/api/v1/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!response.ok) return null;
    return extractAuthResult(await parseJson(response));
  })();
  refreshFlights.set(refreshToken, flight);
  try {
    return await flight;
  } finally {
    refreshFlights.delete(refreshToken);
  }
}

export async function proxyGatewayRequest(
  request: NextRequest,
  pathSegments: string[],
): Promise<NextResponse> {
  const encodedPath = pathSegments
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  if (!encodedPath || !isAllowedProxyRoute(request.method, encodedPath)) {
    return NextResponse.json(
      { error: "Endpoint dashboard tidak diizinkan." },
      { status: 404 },
    );
  }
  const csrf = ensureSameOrigin(request);
  if (csrf) return csrf;
  const session = await readSessionCookies();
  if (!session.accessToken && !session.refreshToken)
    return NextResponse.json(
      { error: "Sesi admin diperlukan." },
      { status: 401 },
    );

  const uploadBytes = positiveInteger(
    process.env.UPLOAD_MAX_BYTES,
    25 * 1024 * 1024,
  );
  const maximumBodyBytes = positiveInteger(
    process.env.DASHBOARD_MAX_BODY_BYTES,
    uploadBytes + 1024 * 1024,
  );
  const targetPath = `/api/v1/${encodedPath}${request.nextUrl.search}`;
  const headers = forwardHeaders(request.headers);
  let body: ArrayBuffer | undefined;
  try {
    body = ["GET", "HEAD"].includes(request.method)
      ? undefined
      : await readBoundedBody(request, maximumBodyBytes);
  } catch (error) {
    if (!(error instanceof RequestBodyTooLargeError)) throw error;
    return NextResponse.json({ error: error.message }, { status: 413 });
  }
  let upstream = await callGateway(
    targetPath,
    { method: request.method, headers, body },
    session.accessToken,
  );
  let refreshed: AuthResult | null = null;
  if (upstream.status === 401 && session.refreshToken) {
    refreshed = await refreshSession();
    if (refreshed) {
      await upstream.body?.cancel().catch(() => undefined);
      upstream = await callGateway(
        targetPath,
        { method: request.method, headers, body },
        refreshed.tokens.accessToken,
      );
    }
  }

  const response = await copyResponse(upstream);
  if (refreshed)
    applySessionCookies(
      response,
      refreshed.tokens,
      refreshed.mustChangePassword,
      secureCookies(request),
    );
  return response;
}

export async function proxyAuthenticatedGatewayGet(
  request: NextRequest,
  targetPath: string,
): Promise<NextResponse> {
  const session = await readSessionCookies();
  let accessToken = session.accessToken;
  let refreshed: AuthResult | null = null;
  if (!accessToken && session.refreshToken) {
    refreshed = await refreshSession();
    accessToken = refreshed?.tokens.accessToken;
  }
  if (!accessToken)
    return NextResponse.json(
      { error: "Sesi admin diperlukan." },
      { status: 401 },
    );

  let upstream = await callGateway(targetPath, {}, accessToken);
  if (upstream.status === 401 && session.refreshToken) {
    refreshed = await refreshSession();
    if (refreshed) {
      await upstream.body?.cancel().catch(() => undefined);
      upstream = await callGateway(targetPath, {}, refreshed.tokens.accessToken);
    }
  }

  const response = await copyResponse(upstream);
  if (refreshed)
    applySessionCookies(
      response,
      refreshed.tokens,
      refreshed.mustChangePassword,
      secureCookies(request),
    );
  return response;
}

export async function copyResponse(upstream: Response): Promise<NextResponse> {
  const headers = new Headers();
  for (const name of [
    "content-type",
    "content-disposition",
    "content-length",
    "etag",
    "last-modified",
    "x-request-id",
    "retry-after",
  ]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("cache-control", "no-store, max-age=0");
  return new NextResponse(upstream.body, { status: upstream.status, headers });
}

export function sanitizePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizePayload);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replaceAll("_", "");
    if (["accesstoken", "refreshtoken", "token"].includes(normalized)) continue;
    result[key] = sanitizePayload(entry);
  }
  return result;
}

function forwardHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const name of [
    "accept",
    "content-type",
    "if-match",
    "if-none-match",
    "idempotency-key",
    "x-request-id",
  ]) {
    const value = source.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

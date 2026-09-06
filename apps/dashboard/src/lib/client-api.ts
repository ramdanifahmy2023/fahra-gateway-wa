"use client";

type ApiOptions = Omit<RequestInit, "body"> & {
  body?: BodyInit | Record<string, unknown> | null;
};

export class ApiError extends Error {
  readonly status: number;
  readonly details: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

export function apiErrorCode(error: ApiError): string {
  const details = error.details;
  if (!details || typeof details !== "object") return "";
  const nested = (details as Record<string, unknown>).error;
  if (!nested || typeof nested !== "object") return "";
  const code = (nested as Record<string, unknown>).code;
  return typeof code === "string" ? code : "";
}

function errorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    if (typeof record.error === "string") return record.error;
    if (record.error && typeof record.error === "object") {
      const nested = record.error as Record<string, unknown>;
      if (typeof nested.message === "string") return nested.message;
    }
  }
  return fallback;
}

export async function apiFetch<T = unknown>(
  path: string,
  options: ApiOptions = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  let body = options.body as BodyInit | null | undefined;

  if (
    body &&
    !(body instanceof FormData) &&
    !(body instanceof URLSearchParams) &&
    typeof body !== "string"
  ) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(body);
  }

  headers.set("accept", "application/json");
  const response = await fetch(path, {
    ...options,
    body,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });

  const contentType = response.headers.get("content-type") ?? "";
  const payload: unknown = contentType.includes("application/json")
    ? await response.json().catch(() => null)
    : await response.text().catch(() => "");

  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/api/session/")) {
      window.location.replace(
        new URL("/login?expired=1", window.location.origin).toString(),
      );
    }
    throw new ApiError(
      errorMessage(payload, `Permintaan gagal (${response.status})`),
      response.status,
      payload,
    );
  }

  return payload as T;
}

export async function apiFetchResponse<T = unknown>(
  path: string,
  options: ApiOptions = {},
): Promise<{ data: T; response: Response }> {
  const headers = new Headers(options.headers);
  let body = options.body as BodyInit | null | undefined;
  if (body && !(body instanceof FormData) && typeof body !== "string") {
    headers.set("content-type", "application/json");
    body = JSON.stringify(body);
  }
  headers.set("accept", "application/json");
  const response = await fetch(path, {
    ...options,
    body,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as T;
  if (!response.ok)
    throw new ApiError(
      errorMessage(payload, `Permintaan gagal (${response.status})`),
      response.status,
      payload,
    );
  return { data: payload, response };
}

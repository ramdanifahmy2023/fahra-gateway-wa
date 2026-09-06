import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cookieValues = vi.hoisted(() => new Map<string, string>());

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieValues.has(name) ? { value: cookieValues.get(name) } : undefined,
  }),
}));

import { GET } from "./route";

const context = (path: string[]) => ({ params: Promise.resolve({ path }) });
const request = (path: string) => {
  const value = new Request(`http://localhost${path}`, {
    headers: { host: "localhost" },
  }) as unknown as { nextUrl?: URL };
  value.nextUrl = new URL(`http://localhost${path}`);
  return value as never;
};
type FetchCall = [URL | RequestInfo, RequestInit | undefined];

describe("dashboard health proxy", () => {
  beforeEach(() => cookieValues.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("keeps live public", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(request("/api/health/live"), context(["live"]));

    expect(response.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as unknown as FetchCall;
    expect(String(url)).toBe("http://127.0.0.1:3100/health/live");
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
  });

  it("requires admin session for integrations", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      request("/api/health/integrations"),
      context(["integrations"]),
    );

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards admin auth to integrations", async () => {
    cookieValues.set("ocgw_access", "access-token");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      request("/api/health/integrations"),
      context(["integrations"]),
    );

    expect(response.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as unknown as FetchCall;
    expect(String(url)).toBe("http://127.0.0.1:3100/health/integrations");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer access-token",
    );
  });

  it("refreshes the dashboard session before integrations", async () => {
    cookieValues.set("ocgw_refresh", "refresh-token");
    const fetchMock = vi.fn(async (url: URL | RequestInfo) => {
      if (String(url).endsWith("/api/v1/auth/refresh"))
        return new Response(
          JSON.stringify({ tokens: { accessToken: "new-access" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      request("/api/health/integrations"),
      context(["integrations"]),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1] as unknown as FetchCall;
    expect(String(url)).toBe("http://127.0.0.1:3100/health/integrations");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer new-access",
    );
    expect(response.headers.getSetCookie().join("\n")).toContain("ocgw_access");
  });
});

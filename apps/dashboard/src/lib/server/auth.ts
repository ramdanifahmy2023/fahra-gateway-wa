import "server-only";

import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const ACCESS_COOKIE = "ocgw_access";
export const REFRESH_COOKIE = "ocgw_refresh";
export const FORCE_CHANGE_COOKIE = "ocgw_force_change";

type AuthTokens = {
  accessToken: string;
  refreshToken?: string;
  accessExpiresIn?: number;
  refreshExpiresIn?: number;
};

const cookieBase = {
  httpOnly: true,
  sameSite: "strict" as const,
  path: "/",
};

export function secureCookies(request: NextRequest): boolean {
  const authority = (
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    ""
  )
    .split(",")[0]!
    .trim();
  const host = (
    authority.startsWith("[")
      ? authority.slice(1, authority.indexOf("]"))
      : authority.split(":")[0]!
  ).toLowerCase();
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(host);
  return (
    !loopback ||
    request.nextUrl.protocol === "https:" ||
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https"
  );
}

export async function readSessionCookies() {
  const jar = await cookies();
  return {
    accessToken: jar.get(ACCESS_COOKIE)?.value,
    refreshToken: jar.get(REFRESH_COOKIE)?.value,
    forcePasswordChange: jar.get(FORCE_CHANGE_COOKIE)?.value === "1",
  };
}

export function applySessionCookies(
  response: NextResponse,
  tokens: AuthTokens,
  forcePasswordChange?: boolean,
  secure = true,
) {
  response.cookies.set(ACCESS_COOKIE, tokens.accessToken, {
    ...cookieBase,
    secure,
    maxAge: normalizeTtl(tokens.accessExpiresIn, 15 * 60),
  });

  if (tokens.refreshToken) {
    response.cookies.set(REFRESH_COOKIE, tokens.refreshToken, {
      ...cookieBase,
      secure,
      maxAge: normalizeTtl(tokens.refreshExpiresIn, 7 * 24 * 60 * 60),
    });
  }

  response.cookies.set(FORCE_CHANGE_COOKIE, forcePasswordChange ? "1" : "0", {
    ...cookieBase,
    secure,
    maxAge: normalizeTtl(tokens.refreshExpiresIn, 7 * 24 * 60 * 60),
  });
}

export function clearSessionCookies(response: NextResponse, secure = true) {
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, FORCE_CHANGE_COOKIE]) {
    response.cookies.set(name, "", {
      ...cookieBase,
      secure,
      expires: new Date(0),
    });
  }
}

function normalizeTtl(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0
    ? Math.floor(Number(value))
    : fallback;
}

export type { AuthTokens };

import { NextRequest, NextResponse } from "next/server";

const publicPaths = new Set(["/login", "/brand"]);
const publicPrefixes = ["/brand/"];

export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const hasSession = Boolean(
    request.cookies.get("ocgw_access")?.value ||
    request.cookies.get("ocgw_refresh")?.value,
  );
  const mustChange = request.cookies.get("ocgw_force_change")?.value === "1";

  if (path === "/login") {
    if (hasSession)
      return NextResponse.redirect(
        new URL(mustChange ? "/ubah-password" : "/dashboard", request.url),
      );
    return NextResponse.next();
  }

  if (publicPaths.has(path) || publicPrefixes.some((prefix) => path.startsWith(prefix)))
    return NextResponse.next();

  if (!hasSession) {
    const login = new URL("/login", request.url);
    if (path !== "/") login.searchParams.set("kembali", path);
    return NextResponse.redirect(login);
  }

  if (mustChange && path !== "/ubah-password")
    return NextResponse.redirect(new URL("/ubah-password", request.url));
  if (!mustChange && path === "/ubah-password")
    return NextResponse.redirect(new URL("/dashboard", request.url));
  if (path === "/")
    return NextResponse.redirect(new URL("/dashboard", request.url));
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};

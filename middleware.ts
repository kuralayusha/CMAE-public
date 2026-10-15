import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * On Vercel, the site is a public download landing + API host only.
 * Desktop/local Next keeps the full app (tracker, settings, …).
 */
export function middleware(request: NextRequest) {
  const onVercel = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
  if (!onVercel) {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/api")) {
    return NextResponse.next();
  }
  if (pathname.startsWith("/_next")) {
    return NextResponse.next();
  }
  if (pathname === "/favicon.ico" || pathname === "/robots.txt") {
    return NextResponse.next();
  }

  // Landing + legacy /download alias
  if (pathname === "/" || pathname === "/download") {
    return NextResponse.next();
  }

  const url = request.nextUrl.clone();
  url.pathname = "/";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt)$).*)",
  ],
};

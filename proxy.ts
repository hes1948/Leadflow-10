// proxy.ts

import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";

const PUBLIC_PAGES = new Set([
  "/",
  "/login",
  "/signup",
]);

const PUBLIC_API_ROUTES = new Set([
  "/api/auth/google/callback",
  "/api/google/callback",
]);

const PUBLIC_API_PREFIXES = [
  "/api/webhooks/",
] as const;

function isPublicAsset(pathname: string): boolean {
  return (
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico" ||
    pathname.startsWith("/favicon") ||
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml"
  );
}

function isPublicPage(pathname: string): boolean {
  return PUBLIC_PAGES.has(pathname);
}

function isPublicApi(pathname: string): boolean {
  if (PUBLIC_API_ROUTES.has(pathname)) {
    return true;
  }

  return PUBLIC_API_PREFIXES.some((prefix) =>
    pathname.startsWith(prefix),
  );
}

function isProtectedPage(pathname: string): boolean {
  return (
    pathname === "/dashboard" ||
    pathname.startsWith("/dashboard/") ||
    pathname === "/settings" ||
    pathname.startsWith("/settings/")
  );
}

function isProtectedApi(pathname: string): boolean {
  return pathname.startsWith("/api/") && !isPublicApi(pathname);
}

function createLoginRedirect(
  req: NextRequest,
  error?: string,
): NextResponse {
  const loginUrl = req.nextUrl.clone();

  loginUrl.pathname = "/login";
  loginUrl.searchParams.set(
    "next",
    `${req.nextUrl.pathname}${req.nextUrl.search}`,
  );

  if (error) {
    loginUrl.searchParams.set("error", error);
  }

  return NextResponse.redirect(loginUrl);
}

function jsonError(
  error: string,
  status: number,
): NextResponse {
  return NextResponse.json(
    {
      success: false,
      error,
    },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
      },
    },
  );
}

export async function proxy(
  req: NextRequest,
): Promise<NextResponse> {
  const pathname = req.nextUrl.pathname;

  // This POST handler independently authenticates every request with getUser().
  // Let its admission limiter cover authentication and durable intake together.
  // Never trust a caller-supplied user/company header or an unverified session.
  if (pathname === "/api/lead" && req.method === "POST") {
    return NextResponse.next();
  }

  if (
    isPublicAsset(pathname) ||
    isPublicPage(pathname) ||
    isPublicApi(pathname)
  ) {
    return NextResponse.next();
  }

  const protectedPage = isProtectedPage(pathname);
  const protectedApi = isProtectedApi(pathname);

  if (!protectedPage && !protectedApi) {
    return NextResponse.next();
  }

  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL;

  const supabaseAnonKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error("proxy_missing_supabase_environment", {
      pathname,
      hasSupabaseUrl: Boolean(supabaseUrl),
      hasSupabaseAnonKey: Boolean(supabaseAnonKey),
    });

    if (protectedApi) {
      return jsonError(
        "server_configuration_error",
        500,
      );
    }

    return createLoginRedirect(
      req,
      "server_configuration_error",
    );
  }

  let response = NextResponse.next({
    request: req,
  });

  const supabase = createServerClient(
    supabaseUrl,
    supabaseAnonKey,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },

        setAll(cookiesToSet) {
          for (const {
            name,
            value,
          } of cookiesToSet) {
            req.cookies.set(name, value);
          }

          response = NextResponse.next({
            request: req,
          });

          for (const {
            name,
            value,
            options,
          } of cookiesToSet) {
            response.cookies.set(
              name,
              value,
              options,
            );
          }
        },
      },
    },
  );

  try {
    /*
     * getClaims verifies the signed access token and avoids calling
     * the Supabase Auth user endpoint on every dashboard/API request.
     *
     * This prevents frequent dashboard polling from hammering the
     * Auth API and triggering over_request_rate_limit errors.
     */
    const {
      data,
      error,
    } = await supabase.auth.getClaims();

    if (error) {
      console.warn("proxy_supabase_claims_error", {
        pathname,
        code:
          "code" in error
            ? error.code
            : undefined,
        message: error.message,
      });
    }

    const userId = data?.claims?.sub;
    const isAuthenticated =
      typeof userId === "string" &&
      userId.length > 0;

    if (!isAuthenticated) {
      if (protectedApi) {
        return jsonError("unauthorized", 401);
      }

      return createLoginRedirect(req);
    }

    return response;
  } catch (error) {
    console.error(
      "proxy_authentication_check_failed",
      {
        pathname,
        message:
          error instanceof Error
            ? error.message
            : String(error),
      },
    );

    if (protectedApi) {
      return jsonError(
        "authentication_check_failed",
        503,
      );
    }

    return createLoginRedirect(
      req,
      "authentication_check_failed",
    );
  }
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/settings/:path*",
    "/api/:path*",
  ],
};
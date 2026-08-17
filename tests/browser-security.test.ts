import { describe, expect, it } from "vitest";
import {
  createContentSecurityPolicy,
  getStaticBrowserSecurityHeaders,
} from "../lib/server/browser-security";

describe("browser security policy", () => {
  it("builds a nonce-bound production CSP without unsafe script execution", () => {
    const policy = createContentSecurityPolicy("0123456789abcdef0123456789abcdef", true);

    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("script-src 'self' 'nonce-0123456789abcdef0123456789abcdef'");
    expect(policy).toContain(
      "script-src-elem 'self' 'nonce-0123456789abcdef0123456789abcdef' https://va.vercel-scripts.com",
    );
    expect(policy).not.toContain("script-src 'self' https:");
    expect(policy).not.toContain("'unsafe-inline' 'unsafe-eval'");
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("form-action 'self'");
    expect(policy).toContain("upgrade-insecure-requests");
  });

  it("allows development evaluation only outside production", () => {
    const policy = createContentSecurityPolicy("0123456789abcdef", false);
    expect(policy).toContain("'unsafe-eval'");
    expect(policy).toContain("script-src-elem 'self' 'nonce-0123456789abcdef' https://va.vercel-scripts.com");
    expect(policy).not.toContain("upgrade-insecure-requests");
  });

  it("rejects invalid nonce values", () => {
    expect(() => createContentSecurityPolicy("short", true)).toThrow(
      "A valid CSP nonce is required.",
    );
  });

  it("returns defensive browser headers and production HSTS", () => {
    const headers = new Map(
      getStaticBrowserSecurityHeaders(true).map(({ key, value }) => [key, value]),
    );

    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(headers.get("Permissions-Policy")).toContain("camera=()");
    expect(headers.get("Strict-Transport-Security")).toContain("max-age=63072000");

    const developmentHeaders = new Map(
      getStaticBrowserSecurityHeaders(false).map(({ key, value }) => [key, value]),
    );
    expect(developmentHeaders.has("Strict-Transport-Security")).toBe(false);
  });
});

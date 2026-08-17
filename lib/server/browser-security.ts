export type BrowserSecurityHeader = {
  key: string;
  value: string;
};

const STATIC_SECURITY_HEADERS: BrowserSecurityHeader[] = [
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "Origin-Agent-Cluster", value: "?1" },
  {
    key: "Permissions-Policy",
    value:
      "accelerometer=(), autoplay=(), browsing-topics=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
];

export const getStaticBrowserSecurityHeaders = (
  production = process.env.NODE_ENV === "production",
): BrowserSecurityHeader[] => [
  ...STATIC_SECURITY_HEADERS,
  ...(production
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains",
        },
      ]
    : []),
];

export const createBrowserRequestNonce = () =>
  crypto.randomUUID().replaceAll("-", "");

export function createContentSecurityPolicy(
  nonce: string,
  production = process.env.NODE_ENV === "production",
) {
  if (!/^[A-Za-z0-9+/=_-]{16,128}$/u.test(nonce)) {
    throw new Error("A valid CSP nonce is required.");
  }

  // Speed Insights is rendered by @vercel/speed-insights in preview/production.
  // Keep the external script allow-list exact instead of weakening nonce policy.
  const scriptSources = [
    "'self'",
    `'nonce-${nonce}'`,
    "https://va.vercel-scripts.com",
  ];
  if (!production) scriptSources.push("'unsafe-eval'");

  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    `script-src ${scriptSources.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://*.vercel-insights.com",
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ];
  if (production) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

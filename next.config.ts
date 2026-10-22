import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  async redirects() {
    return [
      { source: "/search", destination: "/research", permanent: true },
      {
        source: "/search/live/:jobId",
        destination: "/research/live/:jobId",
        permanent: true,
      },
      { source: "/api/search", destination: "/api/research", permanent: false },
      {
        source: "/api/search/:path*",
        destination: "/api/research/:path*",
        permanent: false,
      },
    ];
  },
  /**
   * Keep Vercel Functions Storage small:
   * - Never ship macOS/Windows native binaries to Linux serverless.
   * - Scope heavy natives to the routes that need them (not "/**").
   * Desktop Electron packs its own node_modules; these includes are for Vercel.
   */
  outputFileTracingIncludes: {
    "/api/**": [
      "./locales/**/*",
      "./version-policy.json",
      "./package.json",
      "./node_modules/better-sqlite3/**/*",
    ],
    "/api/settings/cv/**": [
      "./node_modules/pdfjs-dist/**/*",
      "./node_modules/pdf-parse/**/*",
      "./node_modules/@napi-rs/canvas/**/*",
    ],
  },
  serverExternalPackages: [
    "better-sqlite3",
    "playwright",
    "@cursor/sdk",
    "imapflow",
    "nodemailer",
    "pdf-parse",
    "@napi-rs/canvas",
    "cheerio",
  ],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;

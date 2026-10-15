import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingIncludes: {
    "/**": [
      "./locales/**/*",
      "./version-policy.json",
      "./package.json",
      "./node_modules/better-sqlite3/**/*",
      "./node_modules/pdfjs-dist/**/*",
      "./node_modules/pdf-parse/**/*",
      "./node_modules/@napi-rs/canvas/**/*",
      "./node_modules/@napi-rs/canvas-darwin-arm64/**/*",
      "./node_modules/@napi-rs/canvas-darwin-x64/**/*",
      "./node_modules/@napi-rs/canvas-win32-x64-msvc/**/*",
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

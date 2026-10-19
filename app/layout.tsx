import type { Metadata } from "next";
import { I18nProvider } from "@/components/I18nProvider";
import { VersionGate } from "@/components/VersionGate";
import { loadActivePack, loadEnPack } from "@/lib/i18n/pack";
import type { LocalePack } from "@/lib/i18n/types";
import "./globals.css";
import "@/components/folder-browser.css";

export const metadata: Metadata = {
  title: "CMAE",
  description: "Local-first cold mail agent — tracker, search, and Gmail drafts",
  openGraph: {
    title: "CMAE",
    description: "Local-first cold mail agent — tracker, search, and Gmail drafts",
    images: [{ url: "/icons/icon-512.png", width: 512, height: 512, alt: "CMAE" }],
  },
  twitter: {
    card: "summary",
    title: "CMAE",
    description: "Local-first cold mail agent — tracker, search, and Gmail drafts",
    images: ["/icons/icon-512.png"],
  },
};

export const dynamic = "force-dynamic";

export default function RootLayout({ children }: LayoutProps<"/">) {
  let initialCode = "en";
  let initialPack: LocalePack = {};
  let initialEn: LocalePack = {};
  try {
    initialEn = loadEnPack();
    const active = loadActivePack();
    initialCode = active.code;
    initialPack = active.pack;
  } catch {
    /* first boot / missing locales — client will fetch */
  }

  return (
    <html lang={initialCode.slice(0, 2) || "en"} className="h-full">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-full flex flex-col antialiased">
        <I18nProvider
          initialCode={initialCode}
          initialPack={initialPack}
          initialEn={initialEn}
        >
          <VersionGate>{children}</VersionGate>
        </I18nProvider>
      </body>
    </html>
  );
}

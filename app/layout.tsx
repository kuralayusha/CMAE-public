import type { Metadata } from "next";
import { I18nProvider } from "@/components/I18nProvider";
import { LocaleStaleGate } from "@/components/LocaleStaleGate";
import { VersionGate } from "@/components/VersionGate";
import { loadActivePack, loadEnPack } from "@/lib/i18n/pack";
import { t } from "@/lib/i18n/t";
import type { LocalePack } from "@/lib/i18n/types";
import { getThemeBootScript } from "@/lib/theme";
import "./globals.css";
import "@/components/folder-browser.css";

export async function generateMetadata(): Promise<Metadata> {
  const title = t("meta.title");
  const description = t("meta.description");
  const ogAlt = t("meta.ogAlt");
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: [{ url: "/icons/icon-512.png", width: 512, height: 512, alt: ogAlt }],
    },
    twitter: {
      card: "summary",
      title,
      description,
      images: ["/icons/icon-512.png"],
    },
  };
}

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
    <html
      lang={initialCode.slice(0, 2) || "en"}
      className="h-full"
      suppressHydrationWarning
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: getThemeBootScript(),
          }}
        />
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
      <body
        className="min-h-full flex flex-col antialiased"
        suppressHydrationWarning
      >
        <I18nProvider
          initialCode={initialCode}
          initialPack={initialPack}
          initialEn={initialEn}
        >
          <LocaleStaleGate>
            <VersionGate>{children}</VersionGate>
          </LocaleStaleGate>
        </I18nProvider>
      </body>
    </html>
  );
}

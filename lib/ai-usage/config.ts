/**
 * Usage-telemetry endpoints. Env wins; the embedded defaults are public values
 * (Edge Function URLs + the project's publishable anon key — never a service
 * role key) that ship with the desktop build. Empty = feature inert.
 */

const EMBEDDED = {
  ingestUrl: "https://your-project-ref.supabase.co/functions/v1/cmae-ingest",
  // Public anon key (project is test DB `example-project`); endpoints do not
  // require a JWT, the key is only sent for gateway compatibility.
  anonKey:
    "REDACTED_JWT",
  pricesUrl: "https://your-project-ref.supabase.co/functions/v1/cmae-prices",
  reportUrl: "https://your-project-ref.supabase.co/functions/v1/cmae-report",
};

const env = (name: string) => process.env[name]?.trim() ?? "";

export function usageConfig() {
  return {
    ingestUrl: env("CMAE_USAGE_INGEST_URL") || EMBEDDED.ingestUrl,
    anonKey: env("CMAE_USAGE_ANON_KEY") || EMBEDDED.anonKey,
    pricesUrl: env("CMAE_USAGE_PRICES_URL") || EMBEDDED.pricesUrl,
    reportUrl: env("CMAE_USAGE_REPORT_URL") || EMBEDDED.reportUrl,
    /** Admin report secret — never embedded; set CMAE_USAGE_REPORT_SECRET. */
    reportSecret: env("CMAE_USAGE_REPORT_SECRET"),
  };
}

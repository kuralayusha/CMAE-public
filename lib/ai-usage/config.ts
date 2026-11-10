/**
 * Usage-telemetry endpoints, read from the environment only. Nothing is
 * embedded: when the URLs are unset the corresponding feature (upload, remote
 * price refresh, remote report) is a silent no-op.
 *
 * - CMAE_USAGE_INGEST_URL    Edge Function that receives anonymous usage counters
 * - CMAE_USAGE_PRICES_URL    Edge Function that serves the model price table
 * - CMAE_USAGE_REPORT_URL    Edge Function that serves the usage report
 * - CMAE_USAGE_ANON_KEY      Optional publishable key sent as apikey/Bearer
 * - CMAE_USAGE_REPORT_SECRET Admin report secret
 */

const env = (name: string) => process.env[name]?.trim() ?? "";

export function usageConfig() {
  return {
    ingestUrl: env("CMAE_USAGE_INGEST_URL"),
    anonKey: env("CMAE_USAGE_ANON_KEY"),
    pricesUrl: env("CMAE_USAGE_PRICES_URL"),
    reportUrl: env("CMAE_USAGE_REPORT_URL"),
    reportSecret: env("CMAE_USAGE_REPORT_SECRET"),
  };
}

/**
 * Usage-telemetry endpoints. Env wins; the embedded defaults are public values
 * (Edge Function URLs + the project's publishable anon key — never a service
 * role key) that ship with the desktop build. Empty = feature inert.
 */

const EMBEDDED = {
  ingestUrl: "",
  anonKey: "",
  pricesUrl: "",
};

const env = (name: string) => process.env[name]?.trim() ?? "";

export function usageConfig() {
  return {
    ingestUrl: env("CMAE_USAGE_INGEST_URL") || EMBEDDED.ingestUrl,
    anonKey: env("CMAE_USAGE_ANON_KEY") || EMBEDDED.anonKey,
    pricesUrl: env("CMAE_USAGE_PRICES_URL") || EMBEDDED.pricesUrl,
  };
}

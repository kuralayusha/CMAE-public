/**
 * Next compiles this for Node + Edge — keep Node-only imports behind a dynamic import.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation.node");
  }
}

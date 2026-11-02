// Runs once when the Next.js server boots (node runtime only).
//
// Two boot-time jobs:
//   1. Apply pending database migrations so the schema is always current before
//      any request.
//   2. Run the inference-provider preflight (PRD: provider configuration fails
//      fast at startup with a clear error, not at first request).
//
// The preflight distinguishes a *malformed* configuration from one that is merely
// incomplete:
//   - An unknown INFERENCE_PROVIDER / INFERENCE_FALLBACK_PROVIDER value, or an
//     unparseable VASTAI_MODEL_MAP, is an operator error that no request could
//     ever recover from, so registration rethrows and the process refuses to
//     start serving with a guess.
//   - A selected provider that is switched on but missing a required variable
//     (for example INFERENCE_PROVIDER=vastai with no VASTAI_BASE_URL) is logged
//     as a fatal preflight error naming the exact variable, and the control
//     plane reports it. Booting anyway keeps the public site and the diagnostics
//     reachable so the variable can be set in the deployment settings without
//     reading server logs.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  try {
    const { ensureMigrated } = await import("./lib/server/migrate");
    await ensureMigrated();
  } catch (error) {
    console.error("[instrumentation] migration on boot failed:", error);
  }

  try {
    const { preflightInferenceProviders } = await import("./lib/server/provider");
    const selection = await preflightInferenceProviders();
    console.log(JSON.stringify({ event: "inference_provider_preflight_ok", provider: selection.provider, fallback: selection.fallback }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown provider configuration error";
    console.error(JSON.stringify({ event: "inference_provider_preflight_failed", message }));
    // A malformed value is unrecoverable at runtime: refuse to serve a guess.
    if (/Unknown INFERENCE_(FALLBACK_)?PROVIDER|VASTAI_MODEL_MAP/.test(message)) throw error;
  }
}

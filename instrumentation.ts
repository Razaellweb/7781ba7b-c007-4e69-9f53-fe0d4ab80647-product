// Runs once when the Next.js server boots (node runtime only). Applies pending
// database migrations so the schema is always current before any request, then
// brings every server-side wallet onto the Alchemy watch list.
//
// The watch backfill lives here because it must NOT depend on a user action: every
// deposit address this deployment has ever generated (including rows written before
// watch tracking existed) is submitted to Alchemy's Address Activity webhook at
// boot, so monitoring starts without anyone opening the Fund dialog. Registration is
// configuration-gated (ALCHEMY_API_KEY + ALCHEMY_NETWORK or ALCHEMY_RPC_URL, plus
// ALCHEMY_NOTIFY_AUTH_TOKEN and ALCHEMY_WEBHOOK_ID / ALCHEMY_WEBHOOK_URL), and a
// gated miss is recorded truthfully and retried on the next run, so wallets become
// watched as soon as the missing variable is supplied.
//
// Both steps are best-effort: a failure here must never prevent the server from
// starting.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { ensureMigrated } = await import("./lib/server/migrate");
    await ensureMigrated();
  } catch (error) {
    console.error("[instrumentation] migration on boot failed:", error);
  }
  try {
    const { registerUnwatchedWallets } = await import("./lib/server/funding");
    const sweep = await registerUnwatchedWallets(200);
    if (sweep.attempted > 0) {
      console.info(JSON.stringify({ event: "funding_watch_backfill_boot", attempted: sweep.attempted, watched: sweep.watched, reason: sweep.reason }));
    }
  } catch (error) {
    console.error("[instrumentation] alchemy watch backfill on boot failed:", error);
  }
}

// Runs once when the Next.js server boots (node runtime only). Applies pending
// database migrations so the schema is always current before any request.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { ensureMigrated } = await import("./lib/server/migrate");
    await ensureMigrated();
  } catch (error) {
    console.error("[instrumentation] migration on boot failed:", error);
  }
}

import { NextResponse } from "next/server";
import { gpuRentalConfig } from "../../../../lib/server/config";
import { ensureMigrated } from "../../../../lib/server/migrate";
import { sweepStaleRentals } from "../../../../lib/server/gpu-rentals";
import { NO_STORE } from "../../../../lib/server/gpu-http";

// Scheduled catch-up for rentals nobody has synced recently (vercel.json cron).
// Vercel sends `Authorization: Bearer $CRON_SECRET`; without a configured
// secret the endpoint stays closed. Machines also check in every minute on
// their own, so this is a backstop rather than the main billing driver.
export async function GET(request: Request) {
  const secret = gpuRentalConfig().cronSecret;
  if (!secret) return NextResponse.json({ error: "Sweep is not configured" }, { status: 503, headers: NO_STORE });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  try {
    await ensureMigrated();
    const swept = await sweepStaleRentals(50);
    return NextResponse.json({ swept }, { headers: NO_STORE });
  } catch (error) {
    console.error(JSON.stringify({ event: "gpu_sweep_failed", error: error instanceof Error ? error.name : "unknown" }));
    return NextResponse.json({ error: "Sweep failed" }, { status: 503, headers: NO_STORE });
  }
}

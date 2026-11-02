import { NextResponse } from "next/server";
import { ensureMigrated } from "../../../../../../lib/server/migrate";
import { GpuRentalError, heartbeat } from "../../../../../../lib/server/gpu-rentals";
import { NO_STORE } from "../../../../../../lib/server/gpu-http";

// Lease check-in from a rented machine (see lib/server/gpu-templates.ts). It is
// authenticated by the machine's own lease token, not a user session. Each
// check-in advances that rental's billing, which is what keeps billing moving
// without a scheduler.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureMigrated();
    const { id } = await params;
    const authorization = request.headers.get("authorization");
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : null;
    const result = await heartbeat(id, token);
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof GpuRentalError && error.status === 401) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
    // Any other failure: tell the machine to keep its current deadline.
    console.error(JSON.stringify({ event: "gpu_heartbeat_failed", error: error instanceof Error ? error.name : "unknown" }));
    return NextResponse.json({ error: "Heartbeat unavailable" }, { status: 503, headers: NO_STORE });
  }
}

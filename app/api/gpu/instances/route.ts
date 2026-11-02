import { after, NextResponse } from "next/server";
import { authenticatePrivyRequest } from "../../../../lib/server/auth";
import { ensureMigrated } from "../../../../lib/server/migrate";
import { rateLimit } from "../../../../lib/server/redis";
import { ensureDefaultAllowance } from "../../../../lib/server/accounting";
import { availableBalanceMicroUsd, launchRental, listRentals, rentalSettings, sweepStaleRentals } from "../../../../lib/server/gpu-rentals";
import { gpuErrorResponse, NO_STORE } from "../../../../lib/server/gpu-http";

// The signed-in user's GPU machines.
//   GET  → machines (synced to the present), balance, and launch settings
//   POST → launch a machine { offerId, template, model?, sshPublicKey? }
// Billing, renewal and shutdown live in lib/server/gpu-rentals.ts.

const LAUNCH_RATE_LIMIT = 10;
const LAUNCH_RATE_WINDOW_SECONDS = 3600;

export async function GET(request: Request) {
  try {
    await ensureMigrated();
    const account = await authenticatePrivyRequest(request.headers.get("authorization"));
    await ensureDefaultAllowance(account.accountId);
    const rentals = await listRentals(account.accountId);
    const balance = await availableBalanceMicroUsd(account.accountId);
    // Keep other users' machines moving too, after the response is sent.
    after(() => sweepStaleRentals());
    return NextResponse.json({ rentals, balanceUsd: Number(balance) / 1_000_000, settings: rentalSettings() }, { headers: NO_STORE });
  } catch (error) {
    return gpuErrorResponse(error, "Your machines could not be loaded right now.");
  }
}

export async function POST(request: Request) {
  try {
    await ensureMigrated();
    const account = await authenticatePrivyRequest(request.headers.get("authorization"));
    try {
      if (!(await rateLimit(`gpu:launch:${account.accountId}`, LAUNCH_RATE_LIMIT, LAUNCH_RATE_WINDOW_SECONDS))) {
        return NextResponse.json({ error: "Too many launches. Try again later.", code: "RATE_LIMITED" }, { status: 429, headers: NO_STORE });
      }
    } catch {
      console.error(JSON.stringify({ event: "gpu_launch_rate_limit_unavailable" }));
    }
    let body: Record<string, unknown>;
    try {
      const parsed = await request.json();
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      body = parsed as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Send the launch details as JSON.", code: "INVALID_REQUEST" }, { status: 400, headers: NO_STORE });
    }
    const rental = await launchRental(account.accountId, { offerId: body.offerId, template: body.template, model: body.model, sshPublicKey: body.sshPublicKey }, new URL(request.url).origin);
    return NextResponse.json({ rental }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return gpuErrorResponse(error, "The machine could not be launched right now. Nothing was charged.");
  }
}

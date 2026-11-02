import { NextResponse } from "next/server";
import { authenticatePrivyRequest } from "../../../../../lib/server/auth";
import { ensureMigrated } from "../../../../../lib/server/migrate";
import { stopRental } from "../../../../../lib/server/gpu-rentals";
import { gpuErrorResponse, NO_STORE } from "../../../../../lib/server/gpu-http";

// Stops (destroys) one of the signed-in user's machines. Billing stops at the
// minute it is stopped; the unused part of the prepaid block is returned.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureMigrated();
    const account = await authenticatePrivyRequest(request.headers.get("authorization"));
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Machine not found.", code: "NOT_FOUND" }, { status: 404, headers: NO_STORE });
    const rental = await stopRental(account.accountId, id);
    return NextResponse.json({ rental }, { headers: NO_STORE });
  } catch (error) {
    return gpuErrorResponse(error, "The machine could not be stopped right now. Try again.");
  }
}

import { NextResponse } from "next/server";
import { AuthenticationError } from "./auth";
import { accountingCause, GpuRentalError } from "./gpu-rentals";
import { VastUnavailableError } from "./vast";

export const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Maps a GPU rental failure to a sanitized JSON response. */
export function gpuErrorResponse(error: unknown, fallback: string) {
  if (error instanceof AuthenticationError) return NextResponse.json({ error: error.message, code: error.code }, { status: 401, headers: NO_STORE });
  if (error instanceof GpuRentalError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: NO_STORE });
  const accounting = accountingCause(error);
  if (accounting) return NextResponse.json({ error: accounting.message, code: accounting.code }, { status: 402, headers: NO_STORE });
  if (error instanceof VastUnavailableError) {
    const message = error.kind === "unconfigured" || error.kind === "credentials_rejected"
      ? "GPU machines are not available yet. Nothing was charged."
      : "GPU machines are temporarily unavailable. Try again shortly.";
    return NextResponse.json({ error: message, code: "GPU_UNAVAILABLE", kind: error.kind }, { status: 503, headers: NO_STORE });
  }
  console.error(JSON.stringify({ event: "gpu_rentals_unhandled_failure", error: error instanceof Error ? error.name : "unknown" }));
  return NextResponse.json({ error: fallback, code: "GPU_UNAVAILABLE" }, { status: 503, headers: NO_STORE });
}

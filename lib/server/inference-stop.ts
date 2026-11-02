import { cacheGet, cacheSet, redisEnabled } from "./redis";

// The seam between the Playground's "Stop" button and the stream serving it.
//
// Two transports, because one is not enough:
//   * PROCESS-LOCAL: a TTL'd set of operation keys. This is the path that must
//     work in every deployment, including one without Redis configured; on a
//     single server it is exact and immediate.
//   * REDIS: the same key written with a short TTL and read by the streaming
//     handler, so a Stop pressed on one instance reaches a stream held by
//     another. Optional: a missing Redis must never disable Stop.
//
// Writing a stop is one-way (`requestStop` only sets). Each turn observes and
// consumes it, and the entry expires on its own, so a later turn that reuses the
// key is unaffected.

const STOP_TTL_MS = 120_000;
const localStops = new Map<string, number>();

function sweep(now: number): void {
  for (const [key, expiresAt] of localStops) if (expiresAt <= now) localStops.delete(key);
}

/** Registers a stop for one operation key in this process AND (best-effort) Redis. */
export async function requestStop(operationKey: string): Promise<void> {
  const now = Date.now();
  sweep(now);
  localStops.set(operationKey, now + STOP_TTL_MS);
  if (redisEnabled()) {
    // Best effort: an unavailable Redis must not turn Stop into a no-op locally.
    await cacheSet(`stop:${operationKey}`, true, Math.ceil(STOP_TTL_MS / 1000)).catch(() => undefined);
  }
}

/**
 * Whether a stop has been requested for this operation key.
 *
 * `false` (not an exception) when the optional cross-instance transport fails:
 * a transient Redis error must not abort a healthy stream.
 */
export async function stopRequested(operationKey: string): Promise<boolean> {
  const now = Date.now();
  const expiresAt = localStops.get(operationKey);
  if (expiresAt !== undefined) {
    if (expiresAt > now) return true;
    localStops.delete(operationKey);
  }
  if (!redisEnabled()) return false;
  return (await cacheGet<boolean>(`stop:${operationKey}`).catch(() => null)) === true;
}

/** Clears the local entry once a turn has acted on it (Redis expires itself). */
export function clearStop(operationKey: string): void {
  localStops.delete(operationKey);
}

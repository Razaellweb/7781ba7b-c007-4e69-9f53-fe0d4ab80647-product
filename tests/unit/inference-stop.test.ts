import { describe, expect, it } from "vitest";
import { clearStop, requestStop, stopRequested } from "../../lib/server/inference-stop";

// The Playground's "Stop" button is only real if the streaming handler observes it.
// These invariants are what make a stop abort the upstream request rather than
// silently doing nothing when the optional cross-instance cache is unconfigured.

describe("inference stop registry", () => {
  it("reports a stop that was requested, and only for that operation key", async () => {
    await requestStop("op-stop-1");
    expect(await stopRequested("op-stop-1")).toBe(true);
    // A different in-flight turn is unaffected: two tabs stream independently.
    expect(await stopRequested("op-stop-2")).toBe(false);
  });

  it("forgets a stop once the turn that acted on it has finished", async () => {
    await requestStop("op-stop-3");
    expect(await stopRequested("op-stop-3")).toBe(true);
    clearStop("op-stop-3");
    expect(await stopRequested("op-stop-3")).toBe(false);
  });

  it("treats an unknown key as not stopped rather than failing", async () => {
    // Redis is unconfigured in this environment, which is exactly the deployment
    // where the local registry has to carry the whole behaviour.
    expect(await stopRequested("never-requested")).toBe(false);
  });

  it("is idempotent, so a repeated press is harmless", async () => {
    await requestStop("op-stop-4");
    await requestStop("op-stop-4");
    expect(await stopRequested("op-stop-4")).toBe(true);
    clearStop("op-stop-4");
  });
});

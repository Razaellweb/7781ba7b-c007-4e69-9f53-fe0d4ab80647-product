import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Runs the GPU rental billing engine against a real Postgres with the
// marketplace faked at the HTTP layer. Needs TEST_DATABASE_URL (an empty,
// disposable database); skipped otherwise.
//   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/owtest npx vitest run tests/integration/gpu-rentals.test.ts

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const run = TEST_DATABASE_URL ? describe : describe.skip;

type FakeInstance = { id: number; actual_status: string | null; intended_status: string; public_ipaddr: string; ports: Record<string, Array<{ HostIp: string; HostPort: string }>>; jupyter_token: string; dph_total: number; label: string };

const vast = {
  offers: new Map<number, Record<string, unknown>>(),
  instances: new Map<number, FakeInstance>(),
  nextId: 9000,
  createMode: "ok" as "ok" | "timeout" | "reject",
  lastCreateBody: null as Record<string, unknown> | null,
  destroyed: [] as number[],
  sshAttached: [] as number[],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function fakeVast(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const path = url.pathname;
  if (path.endsWith("/gpu_names/unique/")) return json({ success: true, gpu_names: ["RTX 4090"] });
  if (path.endsWith("/bundles/")) {
    const q = JSON.parse(url.searchParams.get("q") ?? "{}") as { id?: { eq?: number } };
    const offers = [...vast.offers.values()].filter((offer) => q.id?.eq === undefined || offer.id === q.id.eq);
    return json({ offers });
  }
  const ask = path.match(/\/asks\/(\d+)\/$/);
  if (ask && method === "PUT") {
    if (vast.createMode === "reject") return json({ success: false, error: "invalid_args", msg: "no_such_ask" }, 400);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    vast.lastCreateBody = body;
    const id = vast.nextId++;
    vast.instances.set(id, { id, actual_status: "loading", intended_status: "running", public_ipaddr: "203.0.113.7", ports: { "22/tcp": [{ HostIp: "0.0.0.0", HostPort: "40022" }], "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "40080" }], "8000/tcp": [{ HostIp: "0.0.0.0", HostPort: "40800" }] }, jupyter_token: "jupytertoken123", dph_total: 0.4, label: String(body.label) });
    if (vast.createMode === "timeout") throw new TypeError("fetch failed");
    return json({ success: true, new_contract: id });
  }
  const sshAttach = path.match(/\/instances\/(\d+)\/ssh\/$/);
  if (sshAttach && method === "POST") { vast.sshAttached.push(Number(sshAttach[1])); return json({ success: true }); }
  const instance = path.match(/\/api\/v0\/instances\/(\d+)\/$/);
  if (instance && method === "GET") return json({ instances: vast.instances.get(Number(instance[1])) ?? null });
  if (instance && method === "DELETE") { const id = Number(instance[1]); vast.instances.delete(id); vast.destroyed.push(id); return json({ success: true }); }
  if (path.endsWith("/api/v1/instances/")) {
    const filters = JSON.parse(url.searchParams.get("select_filters") ?? "{}") as { label?: { eq?: string } };
    return json({ instances: [...vast.instances.values()].filter((item) => item.label === filters.label?.eq) });
  }
  return json({ error: "not_found" }, 404);
}

const OFFER_ID = 54321;
const offer = (overrides: Record<string, unknown> = {}) => ({ id: OFFER_ID, gpu_name: "RTX 4090", num_gpus: 1, gpu_ram: 24564, dph_total: 0.4, reliability2: 0.99, verified: true, rentable: true, geolocation: "Oregon, US", cuda_max_good: 12.8, direct_port_count: 20, ...overrides });

// Provider $0.40/hr × 1.15 = $0.46/hr = 460000 µUSD per hour block.
const RATE = 460_000n;
const HOUR = 3_600_000;

run("GPU rental billing (real Postgres)", () => {
  let mod: typeof import("../../lib/server/gpu-rentals");
  let db: typeof import("../../lib/server/db");
  let accountId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.VAST_API_KEY = "test-vast-key";
    process.env.GPU_BILLING_BLOCK_MINUTES = "60";
    process.env.APP_BASE_URL = "https://app.example.test";
    const { migrate } = await import("../../lib/server/migrate");
    await migrate();
    await migrate(); // re-running is a no-op
    mod = await import("../../lib/server/gpu-rentals");
    db = await import("../../lib/server/db");
  });

  afterAll(async () => {
    await db?.getDb().end();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(fakeVast as typeof fetch);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vast.offers.clear();
    vast.offers.set(OFFER_ID, offer());
    vast.instances.clear();
    vast.createMode = "ok";
    vast.destroyed = [];
    vast.sshAttached = [];
    const rows = await db.query<{ id: string }>(`INSERT INTO user_accounts (privy_user_id) VALUES ($1) RETURNING id`, [`did:privy:test-${Math.random()}`]);
    accountId = rows[0].id;
  });

  const balance = () => mod.availableBalanceMicroUsd(accountId);
  const rentalRow = async (id: string) => (await db.query<Record<string, unknown>>(`SELECT * FROM gpu_rentals WHERE id=$1`, [id]))[0];
  const launch = (extra: Record<string, unknown> = {}) => mod.launchRental(accountId, { offerId: OFFER_ID, template: "pytorch-jupyter", ...extra }, "https://ignored.example");
  const markRunning = (id: string) => { const instance = [...vast.instances.values()].find((item) => item.label === `ow-${id}`); if (instance) instance.actual_status = "running"; };
  const launchedAt = async (id: string) => new Date((await rentalRow(id)).created_at as string).getTime();

  it("prepays the first hour at the marked-up rate and reports the workspace price", async () => {
    const rental = await launch();
    expect(rental.status).toBe("launching");
    expect(rental.hourlyRateUsd).toBeCloseTo(0.46);
    expect(await balance()).toBe(5_000_000n - RATE);
    const body = vast.lastCreateBody!;
    expect(body.image).toBe("pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime");
    expect(body.label).toBe(`ow-${rental.id}`);
    expect((body.env as Record<string, string>).OW_LEASE_URL).toBe(`https://app.example.test/api/gpu/instances/${rental.id}/heartbeat`);
    expect(JSON.stringify(rental)).not.toMatch(/vast/i);
  });

  it("marks the machine running and exposes connection details once the host reports it", async () => {
    const rental = await launch({ sshPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl me@laptop" });
    markRunning(rental.id);
    await mod.syncRental(rental.id);
    const [listed] = (await mod.listRentals(accountId)).filter((item) => item.id === rental.id);
    expect(listed.status).toBe("running");
    expect(listed.access?.jupyterUrl).toBe("https://203.0.113.7:40080/?token=jupytertoken123");
    expect(listed.access?.sshCommand).toBe("ssh -p 40022 root@203.0.113.7");
    expect(listed.access?.sshKeyAttached).toBe(true);
    expect(vast.sshAttached).toHaveLength(1);
  });

  it("renews before the block ends and settles the finished block in full", async () => {
    const rental = await launch();
    markRunning(rental.id);
    const start = await launchedAt(rental.id);
    await mod.syncRental(rental.id, start + 1000);
    await mod.syncRental(rental.id, start + 55 * 60_000); // inside the renewal window
    expect((await rentalRow(rental.id)).next_operation_key).toBe(`gpu:${rental.id}:1`);
    expect(await balance()).toBe(5_000_000n - 2n * RATE);
    await mod.syncRental(rental.id, start + HOUR + 1000); // block 0 is over
    const row = await rentalRow(rental.id);
    expect(row.block_index).toBe(1);
    expect(row.total_debited_micro_usd).toBe(RATE.toString());
    expect(await balance()).toBe(5_000_000n - 2n * RATE);
  });

  it("charges only the minutes used when the user stops mid-block", async () => {
    const rental = await launch();
    markRunning(rental.id);
    await mod.syncRental(rental.id);
    await db.query(`UPDATE gpu_rentals SET block_started_at = now() - interval '20 minutes 30 seconds' WHERE id=$1`, [rental.id]);
    const stopped = await mod.stopRental(accountId, rental.id);
    expect(stopped.status).toBe("ended");
    expect(stopped.endReason).toBe("user_stopped");
    expect(vast.destroyed).toHaveLength(1);
    const charged = (RATE * 21n + 59n) / 60n; // 21 started minutes, rounded up
    expect((await rentalRow(rental.id)).total_debited_micro_usd).toBe(charged.toString());
    expect(await balance()).toBe(5_000_000n - charged);
  });

  it("shuts the machine down when the balance cannot cover the next block", async () => {
    // Spend the allowance down so only the first block fits.
    await db.query(`INSERT INTO compute_ledger_entries (account_id, entry_type, amount_micro_usd, idempotency_key) VALUES ($1,'user_debit',$2,$3)`, [accountId, (5_000_000n - RATE - 1000n).toString(), `test-spend-${accountId}`]);
    const rental = await launch();
    markRunning(rental.id);
    const start = await launchedAt(rental.id);
    await mod.syncRental(rental.id, start + 1000);
    await mod.syncRental(rental.id, start + 55 * 60_000);
    expect((await rentalRow(rental.id)).renewal_blocked).toBe(true);
    const beat = await mod.heartbeat(rental.id, null).catch((error) => error);
    expect(beat).toBeInstanceOf(mod.GpuRentalError);
    await mod.syncRental(rental.id, start + HOUR + 30_000);
    const row = await rentalRow(rental.id);
    expect(row.status).toBe("ended");
    expect(row.end_reason).toBe("balance_exhausted");
    expect(row.total_debited_micro_usd).toBe(RATE.toString());
    expect(vast.destroyed).toHaveLength(1);
    expect(BigInt(row.unbilled_micro_usd as string)).toBeGreaterThan(0n); // 30s of provider time past the paid block
  });

  it("ends the rental when the host loses the machine", async () => {
    const rental = await launch();
    markRunning(rental.id);
    await mod.syncRental(rental.id);
    vast.instances.clear();
    await db.query(`UPDATE gpu_rentals SET block_started_at = now() - interval '5 minutes' WHERE id=$1`, [rental.id]);
    await mod.syncRental(rental.id);
    const row = await rentalRow(rental.id);
    expect(row.status).toBe("ended");
    expect(row.end_reason).toBe("provider_ended");
    expect(await balance()).toBe(5_000_000n - BigInt(row.total_debited_micro_usd as string));
  });

  it("refuses to launch without enough balance for the first block, and creates nothing", async () => {
    await db.query(`INSERT INTO compute_ledger_entries (account_id, entry_type, amount_micro_usd, idempotency_key) VALUES ($1,'user_debit',$2,$3)`, [accountId, "4900000", `test-spend-${accountId}`]);
    const error = await launch().catch((caught) => caught);
    expect(error).toBeInstanceOf(mod.GpuRentalError);
    expect(error.status).toBe(402);
    expect(error.message).toMatch(/first 60 minutes/);
    expect(vast.instances.size).toBe(0);
  });

  it("refunds a launch the marketplace rejects", async () => {
    vast.createMode = "reject";
    const error = await launch().catch((caught) => caught);
    expect(error.code).toBe("OFFER_UNAVAILABLE");
    expect(await balance()).toBe(5_000_000n);
  });

  it("adopts a machine whose create call timed out", async () => {
    vast.createMode = "timeout";
    const rental = await launch();
    expect(rental.status).toBe("launching");
    expect((await rentalRow(rental.id)).provider_instance_id).toBeNull();
    const start = await launchedAt(rental.id);
    await mod.syncRental(rental.id, start + 3 * 60_000);
    expect((await rentalRow(rental.id)).provider_instance_id).not.toBeNull();
  });

  it("destroys and fully refunds a machine that never starts", async () => {
    const rental = await launch();
    await db.query(`UPDATE gpu_rentals SET created_at = now() - interval '31 minutes' WHERE id=$1`, [rental.id]);
    await mod.syncRental(rental.id);
    const row = await rentalRow(rental.id);
    expect(row.status).toBe("failed");
    expect(row.end_reason).toBe("launch_failed");
    expect(vast.destroyed).toHaveLength(1);
    expect(await balance()).toBe(5_000_000n);
  });

  it("authenticates heartbeats with the machine's lease token", async () => {
    const rental = await launch();
    const token = (vast.lastCreateBody!.env as Record<string, string>).OW_LEASE_TOKEN;
    await expect(mod.heartbeat(rental.id, "wrong-token")).rejects.toMatchObject({ status: 401 });
    const beat = await mod.heartbeat(rental.id, token);
    expect(beat.action).toBe("continue");
    expect(beat.paidUntilEpoch).toBeGreaterThan(Date.now() / 1000 + 50 * 60);
    markRunning(rental.id);
    await mod.stopRental(accountId, rental.id);
    expect((await mod.heartbeat(rental.id, token)).action).toBe("stop");
  });

  it("enforces the running-machine limit and the setup's hardware needs", async () => {
    await launch();
    await launch();
    await expect(launch()).rejects.toMatchObject({ code: "TOO_MANY_RENTALS" });
    await db.query(`UPDATE gpu_rentals SET status='ended' WHERE account_id=$1`, [accountId]);
    vast.offers.set(OFFER_ID, offer({ gpu_ram: 8192 }));
    await expect(launch({ template: "vllm-server", model: "Qwen/Qwen2.5-14B-Instruct" })).rejects.toMatchObject({ code: "OFFER_INCOMPATIBLE" });
  });
});

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { query, transaction } from "./db";
import { AccountingError, ensureDefaultAllowance, reserveCompute } from "./accounting";
import { gpuRentalConfig } from "./config";
import { computeUserDebit } from "./pricing";
import { buildInstanceSpec, getTemplate, offerIncompatibility, publicTemplates } from "./gpu-templates";
import {
  attachSshKey,
  createInstance,
  destroyInstance,
  findInstanceByLabel,
  getInstance,
  getRentableOffer,
  VastUnavailableError,
  type VastInstance,
} from "./vast";

// GPU rentals through the workspace, billed from the compute allowance.
//
// Billing is prepaid in blocks (GPU_BILLING_BLOCK_MINUTES, default 60). Each
// block is a compute_reservations hold. Ten minutes before a block ends the next
// one is reserved; when a block ends it is settled in full and the next becomes
// current. If the next block cannot be reserved, the machine is destroyed when
// the paid block ends. Stopping mid-block settles only the minutes used.
//
// Nothing here needs a scheduler. A rental advances whenever it is synced:
//   - every minute from the machine itself (lease heartbeat),
//   - whenever its owner opens the GPU page,
//   - from a sweep that GPU requests and the daily cron run over stale rentals.
// A claim column keeps those from processing the same rental at once.

const SYNC_CLAIM_SECONDS = 90;
const HEARTBEAT_MIN_SYNC_MS = 30_000;
const ADOPT_LOST_LAUNCH_AFTER_MS = 2 * 60_000;
const GIVE_UP_LOST_LAUNCH_AFTER_MS = 10 * 60_000;
// A machine that never reaches "running" (image pull failure, dead host) is
// destroyed and fully refunded after this long.
const MAX_STARTUP_MS = 30 * 60_000;
const LEASE_GRACE_SECONDS = 300;
const RECENT_ENDED_DAYS = 7;
// Page refreshes within this window reuse the last sync instead of asking the
// marketplace again.
const LIST_MIN_SYNC_MS = 15_000;
const SSH_KEY_PATTERN = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/=]{40,4096}( [^\r\n]{0,200})?$/;

export class GpuRentalError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "GpuRentalError";
    this.code = code;
    this.status = status;
  }
}

type RentalStatus = "launching" | "running" | "ended" | "failed";
type EndReason = "user_stopped" | "balance_exhausted" | "provider_ended" | "launch_failed";

export type RentalRow = {
  id: string;
  account_id: string;
  status: RentalStatus;
  end_reason: EndReason | null;
  template: string;
  model: string | null;
  offer_id: string;
  provider_instance_id: string | null;
  provider_status: string | null;
  gpu_name: string;
  gpu_count: number | null;
  gpu_ram_gb: string | null;
  location: string | null;
  provider_hourly_micro_usd: string;
  hourly_rate_micro_usd: string;
  markup_micro: string;
  block_minutes: number;
  block_index: number;
  block_started_at: Date;
  block_ends_at: Date;
  current_operation_key: string | null;
  next_operation_key: string | null;
  renewal_blocked: boolean;
  total_debited_micro_usd: string;
  unbilled_micro_usd: string;
  lease_token_hash: string;
  ssh_public_key: string | null;
  ssh_key_attached: boolean;
  service_api_key: string | null;
  connection: { ip?: string; ports?: Record<string, number>; jupyterToken?: string } | null;
  last_synced_at: Date | null;
  created_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
};

// ---------------------------------------------------------------------------
// Money. Integer micro-USD only.
// ---------------------------------------------------------------------------

const ceilDiv = (value: bigint, divisor: bigint) => (value % divisor === 0n ? value / divisor : value / divisor + 1n);

export function providerHourlyMicroUsd(providerHourlyUsd: number): bigint {
  return BigInt(Math.ceil(providerHourlyUsd * 1_000_000));
}

/** The user's hourly rate: provider cost times the GPU markup, rounded up. */
export function userHourlyMicroUsd(providerHourlyUsd: number, markupMicro: bigint): bigint {
  return computeUserDebit(providerHourlyMicroUsd(providerHourlyUsd), { markupMicro, minChargeMicroUsd: 0n });
}

/** User-facing hourly price in USD, for offer cards and filters. */
export function userHourlyUsd(providerHourlyUsd: number | null, markupMicro = gpuRentalConfig().markupMicro): number | null {
  if (providerHourlyUsd === null) return null;
  return Number(userHourlyMicroUsd(providerHourlyUsd, markupMicro)) / 1_000_000;
}

/** Converts a user-price filter bound back to the provider's price. */
export function providerHourlyUsdForUserPrice(userUsd: number | null, markupMicro = gpuRentalConfig().markupMicro): number | null {
  if (userUsd === null) return null;
  return (userUsd * 1_000_000) / Number(markupMicro);
}

export function blockCostMicroUsd(hourlyRate: bigint, blockMinutes: number): bigint {
  return ceilDiv(hourlyRate * BigInt(blockMinutes), 60n);
}

/** Cost of `elapsedMs`, billed per started minute (at least one), capped at one block. */
export function proratedCostMicroUsd(hourlyRate: bigint, elapsedMs: number, blockMinutes: number): bigint {
  const minutes = Math.min(blockMinutes, Math.max(1, Math.ceil(elapsedMs / 60_000)));
  return ceilDiv(hourlyRate * BigInt(minutes), 60n);
}

// transaction() wraps every failure in DatabaseError, so an AccountingError
// thrown by reserveCompute arrives as its `cause`.
export function accountingCause(error: unknown): AccountingError | null {
  let current: unknown = error;
  while (current instanceof Error) {
    if (current instanceof AccountingError) return current;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return null;
}

const toUsd = (micro: bigint | string) => Number(BigInt(micro)) / 1_000_000;
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const operationKey = (rentalId: string, block: number) => `gpu:${rentalId}:${block}`;

// Releases a block's hold and debits `debit` from it (capped at the hold).
// Idempotent: a block that is already settled is left alone.
async function settleBlock(rental: RentalRow, key: string | null, debit: bigint, providerCost: bigint): Promise<bigint> {
  if (!key) return 0n;
  return transaction(async (db) => {
    const found = await db.query<{ id: string; account_id: string; reserved_micro_usd: string; status: string }>(`SELECT id, account_id, reserved_micro_usd, status FROM compute_reservations WHERE operation_key=$1 FOR UPDATE`, [key]);
    const row = found.rows[0];
    if (!row || row.status !== "reserved") return 0n;
    const reserved = BigInt(row.reserved_micro_usd);
    const charged = debit > reserved ? reserved : debit < 0n ? 0n : debit;
    await db.query(`UPDATE compute_reservations SET status=$2, settled_micro_usd=$3, provider_cost_micro_usd=$4, settled_at=now() WHERE id=$1`, [row.id, charged > 0n ? "settled" : "released", charged.toString(), providerCost.toString()]);
    const metadata = JSON.stringify({ channel: "gpu", rentalId: rental.id });
    await db.query(`INSERT INTO compute_ledger_entries (account_id,reservation_id,entry_type,amount_micro_usd,idempotency_key,metadata) VALUES ($1,$2,'release',$3,$4,$5) ON CONFLICT (idempotency_key) DO NOTHING`, [row.account_id, row.id, reserved.toString(), `release:${key}`, metadata]);
    if (charged > 0n) {
      await db.query(`INSERT INTO compute_ledger_entries (account_id,reservation_id,entry_type,amount_micro_usd,idempotency_key,metadata) VALUES ($1,$2,'user_debit',$3,$4,$5) ON CONFLICT (idempotency_key) DO NOTHING`, [row.account_id, row.id, charged.toString(), `debit:${key}`, metadata]);
      await db.query(`UPDATE gpu_rentals SET total_debited_micro_usd = total_debited_micro_usd + $2 WHERE id=$1`, [rental.id, charged.toString()]);
    }
    return charged;
  });
}

function providerCostFor(rental: RentalRow, elapsedMs: number): bigint {
  return ceilDiv(BigInt(rental.provider_hourly_micro_usd) * BigInt(Math.max(0, Math.ceil(elapsedMs / 1000))), 3600n);
}

async function loadRental(rentalId: string): Promise<RentalRow | null> {
  const rows = await query<RentalRow>(`SELECT * FROM gpu_rentals WHERE id=$1`, [rentalId]);
  return rows[0] ?? null;
}

async function saveRental(rental: RentalRow, fields: Partial<RentalRow>): Promise<RentalRow> {
  const entries = Object.entries(fields);
  if (entries.length === 0) return rental;
  const sets = entries.map(([column], index) => `${column}=$${index + 2}`).join(", ");
  const values = entries.map(([, value]) => (value !== null && typeof value === "object" && !(value instanceof Date) ? JSON.stringify(value) : value));
  const rows = await query<RentalRow>(`UPDATE gpu_rentals SET ${sets} WHERE id=$1 RETURNING *`, [rental.id, ...values]);
  return rows[0] ?? { ...rental, ...fields };
}

// Ends a rental: settles the current block for the time it ran (or refunds it),
// releases any reserved next block, and records why it ended.
async function finishRental(rental: RentalRow, endAt: Date, reason: EndReason, options: { refund?: boolean; unbilledMicroUsd?: bigint } = {}): Promise<RentalRow> {
  const blockStart = new Date(rental.block_started_at).getTime();
  const elapsed = Math.max(0, endAt.getTime() - blockStart);
  const debit = options.refund || elapsed === 0 ? 0n : proratedCostMicroUsd(BigInt(rental.hourly_rate_micro_usd), elapsed, rental.block_minutes);
  await settleBlock(rental, rental.current_operation_key, debit, options.refund ? 0n : providerCostFor(rental, elapsed));
  await settleBlock(rental, rental.next_operation_key, 0n, 0n);
  const unbilled = BigInt(rental.unbilled_micro_usd) + (options.unbilledMicroUsd ?? 0n);
  console.info(JSON.stringify({ event: "gpu_rental_ended", rentalId: rental.id, reason, unbilledMicroUsd: unbilled.toString() }));
  return saveRental(rental, {
    status: reason === "launch_failed" ? "failed" : "ended",
    end_reason: reason,
    ended_at: endAt,
    current_operation_key: null,
    next_operation_key: null,
    renewal_blocked: false,
    unbilled_micro_usd: unbilled.toString(),
  });
}

function connectionFrom(instance: VastInstance) {
  return { ip: instance.publicIp ?? undefined, ports: instance.ports, jupyterToken: instance.jupyterToken ?? undefined };
}

// ---------------------------------------------------------------------------
// Sync: advances one rental to the present.
// ---------------------------------------------------------------------------

async function claim(rentalId: string): Promise<RentalRow | null> {
  const rows = await query<RentalRow>(`UPDATE gpu_rentals SET sync_claimed_until = now() + make_interval(secs => $2) WHERE id=$1 AND status IN ('launching','running') AND (sync_claimed_until IS NULL OR sync_claimed_until < now()) RETURNING *`, [rentalId, SYNC_CLAIM_SECONDS]);
  return rows[0] ?? null;
}

async function releaseClaim(rentalId: string) {
  await query(`UPDATE gpu_rentals SET sync_claimed_until = NULL, last_synced_at = now() WHERE id=$1`, [rentalId]);
}

async function advance(initial: RentalRow, now: number): Promise<RentalRow> {
  let rental = initial;

  // A launch whose create call timed out: the machine may exist without our
  // knowing its id. Look it up by label, or give up and refund.
  if (rental.provider_instance_id === null) {
    const age = now - new Date(rental.created_at).getTime();
    if (age < ADOPT_LOST_LAUNCH_AFTER_MS) return rental;
    const found = await findInstanceByLabel(`ow-${rental.id}`).catch(() => undefined);
    if (found) {
      rental = await saveRental(rental, { provider_instance_id: String(found.id) });
    } else if (found === null && age > GIVE_UP_LOST_LAUNCH_AFTER_MS) {
      return finishRental(rental, new Date(now), "launch_failed", { refund: true });
    } else {
      return rental;
    }
  }

  const instanceId = Number(rental.provider_instance_id);
  let instance: VastInstance | null;
  try {
    instance = await getInstance(instanceId);
  } catch (error) {
    // The marketplace is unreachable: leave the rental as it is. The machine's
    // own lease deadline still bounds the spend.
    console.error(JSON.stringify({ event: "gpu_rental_sync_lookup_failed", rentalId: rental.id, kind: error instanceof VastUnavailableError ? error.kind : "unknown" }));
    return rental;
  }

  const blockEndsAt = new Date(rental.block_ends_at).getTime();

  // Gone, or stopped (by its host, a crash, or its own lease script).
  if (instance === null || instance.actualStatus === "exited" || instance.intendedStatus === "stopped") {
    if (instance) await destroyInstance(instanceId).catch(() => undefined);
    const neverStarted = rental.started_at === null;
    return finishRental(rental, new Date(Math.min(now, blockEndsAt)), neverStarted ? "launch_failed" : "provider_ended", { refund: neverStarted });
  }

  const updates: Partial<RentalRow> = { provider_status: instance.actualStatus, connection: connectionFrom(instance) };
  if (instance.actualStatus === "running" && rental.started_at === null) {
    updates.started_at = new Date(now);
    updates.status = "running";
  }
  rental = await saveRental(rental, updates);

  if (rental.started_at === null && now - new Date(rental.created_at).getTime() > MAX_STARTUP_MS) {
    try {
      await destroyInstance(instanceId);
    } catch {
      return rental;
    }
    return finishRental(rental, new Date(now), "launch_failed", { refund: true });
  }

  if (rental.status === "running" && rental.ssh_public_key && !rental.ssh_key_attached) {
    try {
      await attachSshKey(instanceId, rental.ssh_public_key);
      rental = await saveRental(rental, { ssh_key_attached: true });
    } catch {
      // Retried on the next sync.
    }
  }

  const hourlyRate = BigInt(rental.hourly_rate_micro_usd);
  const blockCost = blockCostMicroUsd(hourlyRate, rental.block_minutes);
  const blockMs = rental.block_minutes * 60_000;
  const renewWindowMs = Math.min(10 * 60_000, Math.floor(blockMs / 3));

  // Catch up block by block; a late sync can cross several block boundaries.
  for (let guard = 0; guard < 200; guard += 1) {
    const endsAt = new Date(rental.block_ends_at).getTime();
    if (now < endsAt - renewWindowMs) break;

    if (!rental.next_operation_key) {
      const nextKey = operationKey(rental.id, rental.block_index + 1);
      try {
        await reserveCompute(rental.account_id, nextKey, blockCost, { channel: "gpu" });
        rental = await saveRental(rental, { next_operation_key: nextKey, renewal_blocked: false });
      } catch (error) {
        if (!accountingCause(error)) throw error;
        if (!rental.renewal_blocked) rental = await saveRental(rental, { renewal_blocked: true });
      }
    }

    if (now < endsAt) break;

    if (rental.next_operation_key) {
      await settleBlock(rental, rental.current_operation_key, blockCost, providerCostFor(rental, blockMs));
      rental = await saveRental(rental, {
        block_index: rental.block_index + 1,
        block_started_at: new Date(endsAt),
        block_ends_at: new Date(endsAt + blockMs),
        current_operation_key: rental.next_operation_key,
        next_operation_key: null,
      });
      continue;
    }

    // The paid time is over and the balance cannot cover more: shut it down.
    try {
      await destroyInstance(instanceId);
    } catch {
      return rental; // Retried on the next sync; overrun is accounted then.
    }
    const overrunMs = Math.max(0, now - endsAt);
    await settleBlock(rental, rental.current_operation_key, blockCost, providerCostFor(rental, blockMs));
    rental = await saveRental(rental, { current_operation_key: null });
    return finishRental(rental, new Date(endsAt), "balance_exhausted", { unbilledMicroUsd: providerCostFor(rental, overrunMs) });
  }
  return rental;
}

/** Brings one rental up to date. Safe to call concurrently. */
export async function syncRental(rentalId: string, now = Date.now()): Promise<RentalRow | null> {
  const claimed = await claim(rentalId);
  if (!claimed) return loadRental(rentalId);
  try {
    return await advance(claimed, now);
  } finally {
    await releaseClaim(rentalId);
  }
}

/** Syncs rentals nobody has synced recently. Errors are logged, never thrown. */
export async function sweepStaleRentals(limit = 3): Promise<number> {
  try {
    const stale = await query<{ id: string }>(`SELECT id FROM gpu_rentals WHERE status IN ('launching','running') AND (last_synced_at IS NULL OR last_synced_at < now() - interval '2 minutes') ORDER BY last_synced_at NULLS FIRST LIMIT $1`, [limit]);
    for (const { id } of stale) {
      await syncRental(id).catch((error) => console.error(JSON.stringify({ event: "gpu_rental_sweep_failed", rentalId: id, error: error instanceof Error ? error.name : "unknown" })));
    }
    return stale.length;
  } catch (error) {
    console.error(JSON.stringify({ event: "gpu_rental_sweep_unavailable", error: error instanceof Error ? error.name : "unknown" }));
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Launch, list, stop, heartbeat.
// ---------------------------------------------------------------------------

export type LaunchRequest = { offerId: unknown; template: unknown; model?: unknown; sshPublicKey?: unknown };

export async function launchRental(accountId: string, request: LaunchRequest, requestOrigin: string): Promise<PublicRental> {
  const cfg = gpuRentalConfig();
  const template = getTemplate(request.template);
  if (!template) throw new GpuRentalError("Choose one of the listed setups.", "INVALID_TEMPLATE", 400);
  const offerId = typeof request.offerId === "number" ? request.offerId : typeof request.offerId === "string" && /^\d{1,15}$/.test(request.offerId) ? Number(request.offerId) : NaN;
  if (!Number.isSafeInteger(offerId) || offerId <= 0) throw new GpuRentalError("That machine could not be found.", "INVALID_OFFER", 400);
  const model = template.models ? (typeof request.model === "string" && request.model ? request.model : template.defaultModel ?? null) : null;
  const sshKey = typeof request.sshPublicKey === "string" && request.sshPublicKey.trim() ? request.sshPublicKey.trim() : null;
  if (sshKey && !SSH_KEY_PATTERN.test(sshKey)) throw new GpuRentalError("That does not look like an SSH public key. Paste the single line from your .pub file.", "INVALID_SSH_KEY", 400);

  await ensureDefaultAllowance(accountId);
  const active = await query<{ count: string }>(`SELECT count(*)::text count FROM gpu_rentals WHERE account_id=$1 AND status IN ('launching','running')`, [accountId]);
  if (Number(active[0]?.count ?? 0) >= cfg.maxActiveRentals) throw new GpuRentalError(`You can run up to ${cfg.maxActiveRentals} machines at once. Stop one to launch another.`, "TOO_MANY_RENTALS", 409);

  // The price always comes from the marketplace, never from the browser.
  const offer = await getRentableOffer(offerId);
  if (!offer || offer.hourlyPriceUsd === null) throw new GpuRentalError("That machine was just taken. Pick another one.", "OFFER_UNAVAILABLE", 409);
  const incompatible = offerIncompatibility(template, offer, model);
  if (incompatible) throw new GpuRentalError(incompatible, "OFFER_INCOMPATIBLE", 400);
  const hourlyRate = userHourlyMicroUsd(offer.hourlyPriceUsd, cfg.markupMicro);
  if (hourlyRate > BigInt(Math.round(cfg.maxHourlyUsd * 1_000_000))) throw new GpuRentalError(`Machines above $${cfg.maxHourlyUsd.toFixed(2)}/hr cannot be launched from the workspace.`, "PRICE_LIMIT", 400);

  const id = randomUUID();
  const leaseToken = randomBytes(32).toString("base64url");
  const serviceKey = template.id === "vllm-server" ? `ow_gpu_${randomBytes(24).toString("base64url")}` : null;
  const now = new Date();
  const blockEnds = new Date(now.getTime() + cfg.blockMinutes * 60_000);
  const firstKey = operationKey(id, 0);

  let rental = (await query<RentalRow>(
    `INSERT INTO gpu_rentals (id, account_id, status, template, model, offer_id, gpu_name, gpu_count, gpu_ram_gb, location, provider_hourly_micro_usd, hourly_rate_micro_usd, markup_micro, block_minutes, block_started_at, block_ends_at, current_operation_key, lease_token_hash, ssh_public_key, service_api_key, created_at)
     VALUES ($1,$2,'launching',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$14) RETURNING *`,
    [id, accountId, template.id, model, offerId, offer.gpuName, offer.gpuCount, offer.gpuRamGb, offer.location, providerHourlyMicroUsd(offer.hourlyPriceUsd).toString(), hourlyRate.toString(), cfg.markupMicro.toString(), cfg.blockMinutes, now, blockEnds, firstKey, hashToken(leaseToken), sshKey, serviceKey],
  ))[0];

  const blockCost = blockCostMicroUsd(hourlyRate, cfg.blockMinutes);
  try {
    await reserveCompute(accountId, firstKey, blockCost, { channel: "gpu" });
  } catch (error) {
    rental = await saveRental(rental, { status: "failed", end_reason: "launch_failed", ended_at: new Date(), current_operation_key: null });
    const accounting = accountingCause(error);
    if (accounting) {
      const message = accounting.code === "INSUFFICIENT_COMPUTE"
        ? `Your balance needs to cover the first ${cfg.blockMinutes} minutes ($${toUsd(blockCost).toFixed(2)}) to launch this machine.`
        : accounting.message;
      throw new GpuRentalError(message, accounting.code, 402);
    }
    throw error;
  }

  const baseUrl = cfg.appBaseUrl ?? requestOrigin.replace(/\/+$/, "");
  const spec = buildInstanceSpec(template, {
    label: `ow-${id}`,
    diskGb: cfg.diskGb,
    leaseUrl: `${baseUrl}/api/gpu/instances/${id}/heartbeat`,
    leaseToken,
    initialDeadlineSeconds: cfg.blockMinutes * 60 + LEASE_GRACE_SECONDS,
    model,
    serviceKey,
  });

  let instanceId: number;
  try {
    instanceId = await createInstance(offerId, spec);
  } catch (error) {
    if (error instanceof VastUnavailableError && (error.kind === "timeout" || error.kind === "transport")) {
      // The machine may have been created anyway; sync adopts it by label or
      // refunds after a few minutes.
      return publicRental(rental);
    }
    await finishRental(rental, new Date(), "launch_failed", { refund: true });
    if (error instanceof VastUnavailableError && error.kind === "request_rejected") throw new GpuRentalError("That machine was just taken. Pick another one.", "OFFER_UNAVAILABLE", 409);
    throw new GpuRentalError("Machines cannot be launched right now. Nothing was charged.", "LAUNCH_UNAVAILABLE", 503);
  }

  rental = await saveRental(rental, { provider_instance_id: String(instanceId) });
  console.info(JSON.stringify({ event: "gpu_rental_launched", rentalId: id, template: template.id }));
  return publicRental(rental);
}

export async function stopRental(accountId: string, rentalId: string): Promise<PublicRental> {
  const owned = await query<RentalRow>(`SELECT * FROM gpu_rentals WHERE id=$1 AND account_id=$2`, [rentalId, accountId]);
  if (!owned[0]) throw new GpuRentalError("Machine not found.", "NOT_FOUND", 404);
  if (owned[0].status === "ended" || owned[0].status === "failed") return publicRental(owned[0]);

  let claimed: RentalRow | null = null;
  for (let attempt = 0; attempt < 10 && !claimed; attempt += 1) {
    claimed = await claim(rentalId);
    if (!claimed) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!claimed) throw new GpuRentalError("This machine is busy updating. Try again in a moment.", "BUSY", 409);

  try {
    let instanceId = claimed.provider_instance_id === null ? null : Number(claimed.provider_instance_id);
    if (instanceId === null) {
      const found = await findInstanceByLabel(`ow-${claimed.id}`).catch(() => undefined);
      if (found === undefined) throw new GpuRentalError("The machine could not be stopped right now. Try again.", "STOP_UNAVAILABLE", 503);
      instanceId = found?.id ?? null;
    }
    if (instanceId !== null) {
      try {
        await destroyInstance(instanceId);
      } catch {
        throw new GpuRentalError("The machine could not be stopped right now. Try again.", "STOP_UNAVAILABLE", 503);
      }
    }
    const neverStarted = claimed.started_at === null;
    const ended = await finishRental(claimed, new Date(), neverStarted ? "launch_failed" : "user_stopped", { refund: neverStarted });
    return publicRental(ended);
  } finally {
    await releaseClaim(rentalId);
  }
}

export async function listRentals(accountId: string) {
  const active = await query<{ id: string; last_synced_at: Date | null }>(`SELECT id, last_synced_at FROM gpu_rentals WHERE account_id=$1 AND status IN ('launching','running')`, [accountId]);
  const due = active.filter((row) => row.last_synced_at === null || Date.now() - new Date(row.last_synced_at).getTime() >= LIST_MIN_SYNC_MS);
  await Promise.all(due.map(({ id }) => syncRental(id).catch(() => null)));
  const rows = await query<RentalRow>(
    `SELECT * FROM gpu_rentals WHERE account_id=$1 AND (status IN ('launching','running') OR ended_at > now() - make_interval(days => $2)) ORDER BY created_at DESC LIMIT 20`,
    [accountId, RECENT_ENDED_DAYS],
  );
  return rows.map(publicRental);
}

/** Lease check-in from the machine. Returns whether it may keep running. */
export async function heartbeat(rentalId: string, token: string | null): Promise<{ action: "continue" | "stop"; paidUntilEpoch?: number }> {
  if (!/^[0-9a-f-]{36}$/.test(rentalId) || !token) throw new GpuRentalError("Unauthorized", "UNAUTHORIZED", 401);
  const rental = await loadRental(rentalId);
  const expected = Buffer.from(rental?.lease_token_hash ?? "", "hex");
  const actual = Buffer.from(hashToken(token), "hex");
  if (!rental || expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new GpuRentalError("Unauthorized", "UNAUTHORIZED", 401);
  if (rental.status === "ended" || rental.status === "failed") return { action: "stop" };

  await query(`UPDATE gpu_rentals SET last_heartbeat_at = now() WHERE id=$1`, [rentalId]);
  const recentlySynced = rental.last_synced_at !== null && Date.now() - new Date(rental.last_synced_at).getTime() < HEARTBEAT_MIN_SYNC_MS;
  const current = recentlySynced ? rental : (await syncRental(rentalId)) ?? rental;
  if (current.status === "ended" || current.status === "failed") return { action: "stop" };
  const paidUntil = new Date(current.block_ends_at).getTime() + (current.next_operation_key ? current.block_minutes * 60_000 : 0);
  return { action: "continue", paidUntilEpoch: Math.floor(paidUntil / 1000) };
}

export async function availableBalanceMicroUsd(accountId: string): Promise<bigint> {
  const rows = await query<{ available: string }>(`SELECT GREATEST(COALESCE(SUM(CASE WHEN entry_type IN ('grant','release','refund') THEN amount_micro_usd WHEN entry_type IN ('reservation','user_debit') THEN -amount_micro_usd ELSE 0 END),0),0)::text available FROM compute_ledger_entries WHERE account_id=$1`, [accountId]);
  return BigInt(rows[0]?.available ?? "0");
}

export function rentalSettings() {
  const cfg = gpuRentalConfig();
  return { blockMinutes: cfg.blockMinutes, maxHourlyUsd: cfg.maxHourlyUsd, maxActiveRentals: cfg.maxActiveRentals, templates: publicTemplates() };
}

// ---------------------------------------------------------------------------
// Browser-safe view. No provider ids, offer internals, or lease secrets.
// ---------------------------------------------------------------------------

export type PublicRental = ReturnType<typeof publicRental>;

export function publicRental(rental: RentalRow) {
  const template = getTemplate(rental.template);
  const rate = BigInt(rental.hourly_rate_micro_usd);
  const active = rental.status === "launching" || rental.status === "running";
  const elapsedInBlock = active ? Math.max(0, Date.now() - new Date(rental.block_started_at).getTime()) : 0;
  const accruing = active && rental.current_operation_key ? proratedCostMicroUsd(rate, elapsedInBlock, rental.block_minutes) : 0n;
  const ports = rental.connection?.ports ?? {};
  const ip = rental.connection?.ip;
  const ready = rental.status === "running" && Boolean(ip);
  const paidUntil = active ? new Date(new Date(rental.block_ends_at).getTime() + (rental.next_operation_key ? rental.block_minutes * 60_000 : 0)) : null;
  return {
    id: rental.id,
    status: rental.status,
    endReason: rental.end_reason,
    setup: template?.name ?? rental.template,
    setupId: rental.template,
    model: rental.model,
    gpuName: rental.gpu_name,
    gpuCount: rental.gpu_count,
    gpuRamGb: rental.gpu_ram_gb === null ? null : Number(rental.gpu_ram_gb),
    location: rental.location,
    hourlyRateUsd: toUsd(rate),
    chargedUsd: toUsd(BigInt(rental.total_debited_micro_usd) + accruing),
    paidUntil: paidUntil?.toISOString() ?? null,
    renewalBlocked: rental.renewal_blocked,
    createdAt: new Date(rental.created_at).toISOString(),
    startedAt: rental.started_at ? new Date(rental.started_at).toISOString() : null,
    endedAt: rental.ended_at ? new Date(rental.ended_at).toISOString() : null,
    access: ready ? {
      jupyterUrl: ports["8080/tcp"] && rental.connection?.jupyterToken ? `https://${ip}:${ports["8080/tcp"]}/?token=${rental.connection.jupyterToken}` : null,
      sshCommand: ports["22/tcp"] ? `ssh -p ${ports["22/tcp"]} root@${ip}` : null,
      sshKeyAttached: rental.ssh_key_attached,
      apiBaseUrl: ports["8000/tcp"] ? `http://${ip}:${ports["8000/tcp"]}/v1` : null,
      apiKey: ports["8000/tcp"] ? rental.service_api_key : null,
    } : null,
  };
}


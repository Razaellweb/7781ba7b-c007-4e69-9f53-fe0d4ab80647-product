import { NextResponse } from "next/server";
import { ensureMigrated } from "../../../../lib/server/migrate";
import { query } from "../../../../lib/server/db";
import { alchemyWebhooksEnabled, parseAddressActivity, verifyAlchemyAuthToken, verifyAlchemySignature } from "../../../../lib/server/alchemy";
import { ingestActivities } from "../../../../lib/server/funding";

// Alchemy Address Activity webhook.
//
// Security order is deliberate and non-negotiable:
//   1. The raw body is read as text and the signature is verified with HMAC-SHA256
//      keyed by ALCHEMY_WEBHOOK_SIGNING_KEY BEFORE the payload is parsed or any row
//      is written. A missing or invalid signature returns 401 and changes nothing.
//   2. Only then is the payload parsed, validated, and recorded.
//
// Nothing here credits funds directly: `ingestActivities` applies the same
// chain/token/recipient/amount validation, confirmation gating, and idempotent
// credit path the polling reconciliation uses.

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(request: Request) {
  // Verification must be possible at all: without a configured signing key every
  // delivery is rejected rather than trusted blindly.
  if (!alchemyWebhooksEnabled()) {
    console.error(JSON.stringify({ event: "funding_webhook_unconfigured" }));
    return NextResponse.json({ error: "Webhook is not configured" }, { status: 503, headers: NO_STORE });
  }

  const rawBody = await request.text();
  const signature = request.headers.get("x-alchemy-signature");
  if (!verifyAlchemyAuthToken(request.headers.get("authorization"))) {
    console.warn(JSON.stringify({ event: "funding_webhook_auth_rejected" }));
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }
  if (!verifyAlchemySignature(rawBody, signature)) {
    // No state change at all: the event is not stored and no deposit is touched.
    console.warn(JSON.stringify({ event: "funding_webhook_signature_rejected" }));
    return NextResponse.json({ error: "Invalid signature" }, { status: 401, headers: NO_STORE });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    console.warn(JSON.stringify({ event: "funding_webhook_malformed_body" }));
    return NextResponse.json({ error: "Malformed payload" }, { status: 400, headers: NO_STORE });
  }

  try {
    await ensureMigrated();
  } catch (error) {
    console.error(JSON.stringify({ event: "funding_webhook_migration_failed", error: error instanceof Error ? error.name : "unknown" }));
    return NextResponse.json({ error: "Webhook unavailable" }, { status: 503, headers: NO_STORE });
  }

  const envelope = (payload ?? {}) as { id?: unknown; webhookId?: unknown; type?: unknown; event?: { network?: unknown } };
  const eventId = typeof envelope.id === "string" && envelope.id.length > 0 ? envelope.id : null;
  const webhookId = typeof envelope.webhookId === "string" ? envelope.webhookId : null;
  const eventType = typeof envelope.type === "string" ? envelope.type : null;
  const network = typeof envelope.event?.network === "string" ? envelope.event.network : null;

  // Alchemy only sends address activity from the webhook we registered. Other
  // webhook types are acknowledged and ignored rather than processed as transfers.
  if (eventType && eventType.toUpperCase() !== "ADDRESS_ACTIVITY") {
    console.info(JSON.stringify({ event: "funding_webhook_ignored_type", eventType }));
    return NextResponse.json({ received: true, ignored: true }, { headers: NO_STORE });
  }

  const activities = parseAddressActivity(payload);
  if (activities.length === 0) {
    // A verified but malformed/empty delivery must not credit anything. It is
    // recorded for audit so an operator can see it happened.
    console.warn(JSON.stringify({ event: "funding_webhook_no_activities", eventId }));
    if (eventId) {
      await query(
        `INSERT INTO alchemy_webhook_events (webhook_id, event_id, event_type, network, payload, status, last_error)
         VALUES ($1,$2,$3,$4,$5,'rejected',$6)
         ON CONFLICT (event_id) WHERE event_id IS NOT NULL DO NOTHING`,
        [webhookId, eventId, eventType, network, JSON.stringify(payload), "no_parseable_activity"]
      ).catch(() => undefined);
    }
    return NextResponse.json({ received: true, recorded: 0, credited: 0 }, { headers: NO_STORE });
  }

  // Persist the verified delivery. `event_id` is unique, so a redelivery of the
  // same event updates the existing row instead of creating a second one; the
  // deposit-level unique key then makes processing it again a no-op credit.
  let eventRowId: string | null = null;
  try {
    const inserted = await query<{ id: string }>(
      `INSERT INTO alchemy_webhook_events (webhook_id, event_id, event_type, network, payload, status, attempts)
       VALUES ($1,$2,$3,$4,$5,'received',1)
       ON CONFLICT (event_id) WHERE event_id IS NOT NULL
         DO UPDATE SET attempts = alchemy_webhook_events.attempts + 1
       RETURNING id`,
      [webhookId, eventId, eventType, network, JSON.stringify(payload)]
    );
    eventRowId = inserted[0]?.id ?? null;
  } catch (error) {
    console.error(JSON.stringify({ event: "funding_webhook_record_failed", eventId, error: error instanceof Error ? error.name : "unknown" }));
  }

  try {
    const result = await ingestActivities(activities);
    if (eventRowId) {
      const status = result.failed > 0 ? "failed" : "processed";
      await query(
        `UPDATE alchemy_webhook_events
            SET status=$2, last_error=$3, processed_at=CASE WHEN $2='processed' THEN now() ELSE processed_at END
          WHERE id=$1`,
        [eventRowId, status, result.failed > 0 ? `${result.failed} activity item(s) failed` : null]
      ).catch(() => undefined);
    }
    return NextResponse.json({ received: true, ...result }, { headers: NO_STORE });
  } catch (error) {
    // The event row is already stored, so the sweeper retries it. Alchemy is told
    // the delivery failed so it can also redeliver.
    if (eventRowId) {
      await query(`UPDATE alchemy_webhook_events SET status='failed', last_error=$2 WHERE id=$1`, [eventRowId, error instanceof Error ? error.message.slice(0, 500) : "unknown error"]).catch(() => undefined);
    }
    console.error(JSON.stringify({ event: "funding_webhook_processing_failed", eventId, error: error instanceof Error ? error.name : "unknown" }));
    return NextResponse.json({ error: "Processing failed" }, { status: 500, headers: NO_STORE });
  }
}

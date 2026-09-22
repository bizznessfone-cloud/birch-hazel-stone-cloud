/**
 * CP26B.2 — Domain A webhook extraction + ordered apply.
 * Schema-capability gated so Production 0023 remains callable until 0024 is applied.
 * Never calls the historical last-write-wins 8-arg sbg_apply_billing_event.
 */
import type { Sql } from "@/lib/db";
import { assertStripePriceId, SaasLifecycleError } from "./saas-lifecycle.ts";

export const ORDERED_BILLING_APPLY_REGPROCEDURE =
  "sbg_apply_billing_event(text,text,bigint,uuid,text,text,text,text,timestamptz,boolean)";

export type BillingApplyOutcome = "applied" | "duplicate" | "stale" | "ambiguous" | "rejected";

export class OrderedBillingSchemaError extends Error {
  constructor(message = "Ordered billing persistence is not installed.") {
    super(message);
    this.name = "OrderedBillingSchemaError";
  }
}

export class DomainAWebhookExtractError extends Error {
  readonly code: "missing_created" | "malformed_created" | "missing_cancel_at_period_end" | "missing_identity";
  constructor(message: string, code: DomainAWebhookExtractError["code"]) {
    super(message);
    this.name = "DomainAWebhookExtractError";
    this.code = code;
  }
}

export type DomainASubscriptionEvent = {
  eventId: string;
  eventType: string;
  eventCreated: number;
  hotelId: string;
  customerId: string | null;
  subscriptionId: string;
  priceId: string | null;
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
};

function unixToIso(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000).toISOString() : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function extractStripeCreated(event: unknown): number {
  const created = asObject(event)?.created;
  if (created == null) {
    throw new DomainAWebhookExtractError("Stripe event.created is missing.", "missing_created");
  }
  if (typeof created !== "number" || !Number.isInteger(created) || created < 0) {
    throw new DomainAWebhookExtractError("Stripe event.created is malformed.", "malformed_created");
  }
  return created;
}

export function extractCancelAtPeriodEnd(object: unknown): boolean {
  const value = asObject(object)?.cancel_at_period_end;
  if (typeof value !== "boolean") {
    throw new DomainAWebhookExtractError(
      "Stripe subscription cancel_at_period_end is missing or malformed.",
      "missing_cancel_at_period_end",
    );
  }
  return value;
}

export function extractDomainASubscriptionEvent(event: unknown): DomainASubscriptionEvent {
  const root = asObject(event);
  const eventId = typeof root?.id === "string" ? root.id : "";
  const eventType = typeof root?.type === "string" ? root.type : "";
  const eventCreated = extractStripeCreated(event);
  const data = asObject(root?.data);
  const object = asObject(data?.object);
  const metadata = asObject(object?.metadata) ?? {};
  const items = asObject(object?.items);
  const itemList = Array.isArray(items?.data) ? items.data : [];
  const firstItem = asObject(itemList[0]);
  const price = asObject(firstItem?.price);
  const hotelId = typeof metadata.hotel_id === "string" ? metadata.hotel_id : "";
  const subscriptionId = typeof object?.id === "string" ? object.id : "";
  if (!eventId || !hotelId || !subscriptionId) {
    throw new DomainAWebhookExtractError(
      "Domain A subscription event is missing hotel or subscription identity.",
      "missing_identity",
    );
  }
  const customer = object?.customer;
  return {
    eventId,
    eventType,
    eventCreated,
    hotelId,
    customerId: typeof customer === "string" ? customer : null,
    subscriptionId,
    priceId: typeof price?.id === "string" ? price.id : null,
    status: typeof object?.status === "string" ? object.status : "",
    currentPeriodEnd: unixToIso(object?.current_period_end),
    cancelAtPeriodEnd: extractCancelAtPeriodEnd(object),
  };
}

export function configuredDomainAPriceIds(env: NodeJS.Dict<string> = process.env): string[] {
  return ["STRIPE_BASIC_PRICE_ID", "STRIPE_PRO_PRICE_ID", "STRIPE_PREMIUM_PRICE_ID"]
    .map((key) => String(env[key] ?? "").trim())
    .filter(Boolean)
    .map((value) => assertStripePriceId(value));
}

export function assertDomainAWebhookPriceId(
  priceId: string | null,
  env: NodeJS.Dict<string> = process.env,
): string {
  if (!priceId) {
    throw new SaasLifecycleError("Domain A webhook price is missing.", "invalid_price_id");
  }
  const trimmed = assertStripePriceId(priceId);
  const allowed = configuredDomainAPriceIds(env);
  if (!allowed.includes(trimmed)) {
    throw new SaasLifecycleError("Domain A webhook price is not a configured SCAN BOOK GO price.", "invalid_price_id");
  }
  return trimmed;
}

export async function hasOrderedBillingApply(db: Sql): Promise<boolean> {
  const rows = await db.query<{ ok: boolean }>(
    "select to_regprocedure($1) is not null as ok",
    [ORDERED_BILLING_APPLY_REGPROCEDURE],
  );
  return rows[0]?.ok === true;
}

export async function applyDomainABillingEvent(
  db: Sql,
  event: DomainASubscriptionEvent,
  env: NodeJS.Dict<string> = process.env,
): Promise<BillingApplyOutcome> {
  if (!(await hasOrderedBillingApply(db))) {
    throw new OrderedBillingSchemaError();
  }
  const priceId = assertDomainAWebhookPriceId(event.priceId, env);
  const rows = await db.query<{ sbg_apply_billing_event: string }>(
    "select sbg_apply_billing_event($1, $2, $3::bigint, $4::uuid, $5, $6, $7, $8, $9::timestamptz, $10::boolean)",
    [
      event.eventId,
      event.eventType,
      event.eventCreated,
      event.hotelId,
      event.customerId,
      event.subscriptionId,
      priceId,
      event.status,
      event.currentPeriodEnd,
      event.cancelAtPeriodEnd,
    ],
  );
  const outcome = rows[0]?.sbg_apply_billing_event;
  if (
    outcome === "applied" ||
    outcome === "duplicate" ||
    outcome === "stale" ||
    outcome === "ambiguous" ||
    outcome === "rejected"
  ) {
    return outcome;
  }
  throw new Error("Ordered billing apply returned an unexpected outcome.");
}

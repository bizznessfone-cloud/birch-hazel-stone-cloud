/**
 * CP26 FINALISATION — Domain A webhook is organisation subscription quantity.
 * The 10-argument hotel apply remains for historical compatibility and is not
 * the active commercial path. Never calls the 8-arg sbg_apply_billing_event.
 */
import type { Sql } from "@/lib/db";
import { saasCommerceMode } from "./saas-commerce.server.ts";
import { assertStripePriceId, SaasLifecycleError } from "./saas-lifecycle.ts";
import { PROPERTY_LICENCE_PLAN } from "./property-licence.ts";

export const ORDERED_BILLING_APPLY_REGPROCEDURE =
  "sbg_apply_billing_event(text,text,bigint,uuid,text,text,text,text,timestamptz,boolean)";

export const ORGANISATION_BILLING_APPLY_REGPROCEDURE =
  "sbg_apply_organisation_billing_event(text,text,bigint,uuid,text,text,text,text,timestamptz,boolean,integer,text,uuid)";

export type BillingApplyOutcome = "applied" | "duplicate" | "stale" | "ambiguous" | "rejected";

export class OrderedBillingSchemaError extends Error {
  constructor(message = "Ordered billing persistence is not installed.") {
    super(message);
    this.name = "OrderedBillingSchemaError";
  }
}

export class DomainAWebhookExtractError extends Error {
  readonly code:
    | "missing_created"
    | "malformed_created"
    | "missing_cancel_at_period_end"
    | "missing_identity"
    | "missing_quantity"
    | "ambiguous_items"
    | "invalid_interval";
  constructor(message: string, code: DomainAWebhookExtractError["code"]) {
    super(message);
    this.name = "DomainAWebhookExtractError";
    this.code = code;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DomainASubscriptionEvent = {
  eventId: string;
  eventType: string;
  eventCreated: number;
  organisationId: string;
  customerId: string | null;
  subscriptionId: string;
  priceId: string | null;
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  quantity: number;
};

export type LegacyHotelSubscriptionEvent = {
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

function customerIdOf(customer: unknown): string | null {
  if (typeof customer === "string" && customer.trim()) return customer;
  const id = asObject(customer)?.id;
  return typeof id === "string" && id.trim() ? id : null;
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
  if (itemList.length !== 1) {
    throw new DomainAWebhookExtractError(
      "Domain A subscription event does not have exactly one subscription item.",
      "ambiguous_items",
    );
  }
  const firstItem = asObject(itemList[0]);
  const price = asObject(firstItem?.price);
  const recurring = asObject(price?.recurring);
  if (recurring?.interval != null && recurring.interval !== "month") {
    throw new DomainAWebhookExtractError(
      "Domain A subscription interval is not monthly.",
      "invalid_interval",
    );
  }
  const organisationId = typeof metadata.organisation_id === "string" ? metadata.organisation_id.trim().toLowerCase() : "";
  const subscriptionId = typeof object?.id === "string" ? object.id : "";
  if (!eventId || !UUID_RE.test(organisationId) || !subscriptionId) {
    throw new DomainAWebhookExtractError(
      "Domain A subscription event is missing organisation or subscription identity.",
      "missing_identity",
    );
  }
  const quantity = firstItem?.quantity;
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 0) {
    throw new DomainAWebhookExtractError(
      "Domain A subscription quantity is missing or malformed.",
      "missing_quantity",
    );
  }
  return {
    eventId,
    eventType,
    eventCreated,
    organisationId,
    customerId: customerIdOf(object?.customer),
    subscriptionId,
    priceId: typeof price?.id === "string" ? price.id : null,
    status: typeof object?.status === "string" ? object.status : "",
    currentPeriodEnd: unixToIso(object?.current_period_end),
    cancelAtPeriodEnd: extractCancelAtPeriodEnd(object),
    quantity,
  };
}

/** Historical hotel-tier extractor. Not used by the webhook route. */
export function extractLegacyHotelSubscriptionEvent(event: unknown): LegacyHotelSubscriptionEvent {
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
  return {
    eventId,
    eventType,
    eventCreated,
    hotelId,
    customerId: typeof object?.customer === "string" ? object.customer : null,
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

export async function hasOrganisationBillingApply(db: Sql): Promise<boolean> {
  const rows = await db.query<{ ok: boolean }>(
    "select to_regprocedure($1) is not null as ok",
    [ORGANISATION_BILLING_APPLY_REGPROCEDURE],
  );
  return rows[0]?.ok === true;
}

async function resolveMappedPropertyLicenceVersion(
  db: Sql,
  priceId: string,
  environment: "test" | "live",
): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `select v.id::text as id
       from sbg_saas_stripe_mappings m
       join sbg_saas_price_versions v on v.id = m.price_version_id
       join sbg_saas_plans p on p.code = v.plan_code
      where m.stripe_price_id = $1
        and m.environment = $2
        and m.status = 'verified'
        and v.plan_code = $3
        and p.active = true
        and v.purchasable
        and v.retired_at is null
        and v.currency = 'EUR'
        and v.billing_interval = 'month'
        and v.interval_count = 1`,
    [priceId, environment, PROPERTY_LICENCE_PLAN],
  );
  if (rows.length !== 1 || !rows[0]?.id) {
    throw new SaasLifecycleError(
      "Domain A webhook price is not the property licence price.",
      "invalid_price_id",
    );
  }
  return rows[0].id;
}

export async function applyDomainABillingEvent(
  db: Sql,
  event: DomainASubscriptionEvent,
  env: NodeJS.Dict<string> = process.env,
): Promise<BillingApplyOutcome> {
  if (!(await hasOrganisationBillingApply(db))) {
    throw new OrderedBillingSchemaError("Organisation billing persistence is not installed.");
  }
  if (!Number.isInteger(event.quantity) || event.quantity < 0) {
    throw new DomainAWebhookExtractError(
      "Domain A subscription quantity is missing or malformed.",
      "missing_quantity",
    );
  }
  const mode = saasCommerceMode(env);
  if (mode !== "test" && mode !== "live") {
    throw new SaasLifecycleError("SBG SaaS commerce is not enabled.", "invalid_price_id");
  }
  if (!event.priceId) {
    throw new SaasLifecycleError("Domain A webhook price is missing.", "invalid_price_id");
  }
  const priceId = assertStripePriceId(event.priceId);
  const priceVersionId = await resolveMappedPropertyLicenceVersion(db, priceId, mode);
  const rows = await db.query<{ sbg_apply_organisation_billing_event: string }>(
    `select sbg_apply_organisation_billing_event(
       $1, $2, $3::bigint, $4::uuid, $5, $6, $7, $8, $9::timestamptz, $10::boolean, $11::integer, $12, $13::uuid
     ) as sbg_apply_organisation_billing_event`,
    [
      event.eventId,
      event.eventType,
      event.eventCreated,
      event.organisationId,
      event.customerId,
      event.subscriptionId,
      priceId,
      event.status,
      event.currentPeriodEnd,
      event.cancelAtPeriodEnd,
      event.quantity,
      "month",
      priceVersionId,
    ],
  );
  const outcome = rows[0]?.sbg_apply_organisation_billing_event;
  if (
    outcome === "applied" ||
    outcome === "duplicate" ||
    outcome === "stale" ||
    outcome === "ambiguous" ||
    outcome === "rejected"
  ) {
    return outcome;
  }
  throw new Error("Organisation billing apply returned an unexpected outcome.");
}

/** Historical hotel apply. Not used by the webhook route. */
export async function applyLegacyHotelBillingEvent(
  db: Sql,
  event: LegacyHotelSubscriptionEvent,
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

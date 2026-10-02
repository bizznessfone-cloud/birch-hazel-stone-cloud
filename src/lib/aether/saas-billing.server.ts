/**
 * CP26 FINALISATION — Domain A is organisation + property licence + quantity N.
 * Commerce gate runs before Stripe. No price is written before purchase.
 * Domain B is not imported. hotels.status is not written.
 */
import type { Sql } from "@/lib/db";
import { assertDomainACommerceAllowedForOrganisation } from "./saas-commerce.server.ts";
import {
  SaasLifecycleError,
  assertCheckoutAllowed,
  assertPortalAllowed,
  billingViewModel,
  type BillingAccountSnapshot,
} from "./saas-lifecycle.ts";
import { createBillingPortal, createSubscriptionCheckout, StripeSessionCreatedError } from "./stripe.server.ts";
import {
  PROPERTY_LICENCE_PLAN,
  authorisePropertyLicenceQuantity,
  propertyHasDomainAEntitlement,
  usableLicensedQuantity,
} from "./property-licence.ts";

export type OrganisationBillingRow = {
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_price_id: string | null;
  status: string;
  current_period_end: string | null;
  licensed_quantity: number;
};

async function ownedHotel(db: Sql, userId: string, hotelId: string) {
  const rows = await db.query<{ id: string }>(
    "select hotel_id as id from app_hotel_accounts where user_id = $1 and hotel_id = $2::uuid",
    [userId, hotelId],
  );
  if (!rows[0]) throw new Error("Hotel not found.");
}

async function assertOrganisationBillingAuthority(db: Sql, userId: string, organisationId: string) {
  const rows = await db.query<{ ok: number }>(
    `select 1 as ok
       from sbg_organisation_members
      where organisation_id = $1::uuid
        and user_id = $2
        and billing_authority
        and removed_at is null`,
    [organisationId, userId],
  );
  if (!rows[0]) throw new Error("Organisation billing authority required.");
}

async function loadOrganisationBilling(db: Sql, organisationId: string): Promise<OrganisationBillingRow | null> {
  const rows = await db.query<OrganisationBillingRow>(
    `select stripe_customer_id, stripe_subscription_id, stripe_price_id, status,
            current_period_end, licensed_quantity
       from sbg_organisation_billing
      where organisation_id = $1::uuid`,
    [organisationId],
  );
  return rows[0] ?? null;
}

async function resolvePropertyLicenceCheckoutPrice(db: Sql, environment: "test" | "live"): Promise<string> {
  try {
    const rows = await db.query<{ price_id: string }>(
      "select sbg_resolve_domain_a_checkout_price($1, $2) as price_id",
      [PROPERTY_LICENCE_PLAN, environment],
    );
    const priceId = rows[0]?.price_id;
    if (!priceId) {
      throw new SaasLifecycleError("Property licence checkout price is not available.", "invalid_price_id");
    }
    return priceId;
  } catch (error) {
    if (error instanceof SaasLifecycleError) throw error;
    throw new SaasLifecycleError("Property licence checkout price is not available.", "invalid_price_id");
  }
}

async function assertCurrentOrganisationMember(db: Sql, userId: string, organisationId: string) {
  const rows = await db.query<{ ok: number }>(
    `select 1 as ok
       from sbg_organisation_members
      where organisation_id = $1::uuid
        and user_id = $2
        and removed_at is null`,
    [organisationId, userId],
  );
  if (!rows[0]) throw new Error("Hotel not found.");
}

export async function loadDomainABillingState(db: Sql, userId: string, hotelId: string) {
  await ownedHotel(db, userId, hotelId);
  const hotelRows = await db.query<{ organisation_id: string | null }>(
    "select organisation_id::text as organisation_id from hotels where id = $1::uuid",
    [hotelId],
  );
  const organisationId = hotelRows[0]?.organisation_id ?? null;
  // Hotel ownership is not organisation billing access. Membership is checked
  // before Stripe, licence, or subscription rows are read. The denial matches
  // a missing hotel so this path is not an organisation-existence oracle.
  if (organisationId) await assertCurrentOrganisationMember(db, userId, organisationId);
  const connection = await db.query<{
    stripe_account_id: string;
    livemode: boolean;
    disconnected_at: string | null;
  }>(
    "select stripe_account_id, livemode, disconnected_at from sbg_stripe_connections where hotel_id = $1::uuid",
    [hotelId],
  );
  const billing = organisationId ? await loadOrganisationBilling(db, organisationId) : null;
  const allocation = await db.query<{ ok: number }>(
    `select 1 as ok
       from sbg_property_licence_allocations
      where hotel_id = $1::uuid
        and released_at is null`,
    [hotelId],
  );
  const balance = organisationId
    ? await db.query<{ licensed_quantity: number; active_allocations: number; available_licences: number }>(
        `select licensed_quantity, active_allocations, available_licences
           from sbg_organisation_licence_balance
          where organisation_id = $1::uuid`,
        [organisationId],
      )
    : [];
  const allocationActive = Boolean(allocation[0]);
  const lifecycle = billingViewModel(billing);
  return {
    billing,
    connection: connection[0] ?? null,
    lifecycle,
    organisationId,
    allocationActive,
    propertyEntitled: propertyHasDomainAEntitlement({
      organisationId,
      allocationActive,
      subscriptionStatus: billing?.status ?? null,
    }),
    licensedQuantity: balance[0]?.licensed_quantity ?? billing?.licensed_quantity ?? 0,
    activeAllocations: balance[0]?.active_allocations ?? 0,
    availableLicences: balance[0]?.available_licences ?? 0,
  };
}

export async function ensureHotelOrganisation(input: {
  db: Sql;
  userId: string;
  hotelId: string;
}) {
  await ownedHotel(input.db, input.userId, input.hotelId);
  const hotelRows = await input.db.query<{ organisation_id: string | null; name: string }>(
    "select organisation_id::text as organisation_id, name from hotels where id = $1::uuid",
    [input.hotelId],
  );
  const hotel = hotelRows[0];
  if (!hotel) throw new Error("Hotel not found.");
  if (hotel.organisation_id) {
    await assertOrganisationBillingAuthority(input.db, input.userId, hotel.organisation_id);
    return { organisationId: hotel.organisation_id };
  }
  const created = await input.db.query<{ id: string }>(
    "select sbg_create_organisation_for_user($1, $2)::text as id",
    [input.userId, hotel.name],
  );
  const organisationId = created[0]?.id;
  if (!organisationId) throw new Error("Organisation could not be created.");
  await input.db.query("select sbg_attach_hotel_to_organisation($1, $2::uuid, $3::uuid)", [
    input.userId,
    organisationId,
    input.hotelId,
  ]);
  return { organisationId };
}

export class DomainACheckoutClaimError extends Error {
  readonly code: "checkout_in_progress" | "checkout_attach_failed";

  constructor(
    code: "checkout_in_progress" | "checkout_attach_failed",
    message = code === "checkout_in_progress"
      ? "A SCAN BOOK GO checkout is already in progress for this organisation."
      : "Domain A checkout session could not be attached.",
  ) {
    super(message);
    this.name = "DomainACheckoutClaimError";
    this.code = code;
  }
}

const DOMAIN_A_CLAIM_TTL_SECONDS = 600;

function reusableAttachedCheckout(sessionId: string | null, url: string | null): string | null {
  if (typeof sessionId !== "string" || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return null;
  if (typeof url !== "string" || !url.startsWith("https://")) return null;
  return url;
}

export async function startDomainACheckout(input: {
  db: Sql;
  userId: string;
  organisationId: string;
  quantity: unknown;
  origin: string;
}) {
  const quantity = authorisePropertyLicenceQuantity(input.quantity);
  await assertOrganisationBillingAuthority(input.db, input.userId, input.organisationId);
  const billing = await loadOrganisationBilling(input.db, input.organisationId);
  assertCheckoutAllowed(billing);
  const commerce = assertDomainACommerceAllowedForOrganisation(input.organisationId);
  const priceId = await resolvePropertyLicenceCheckoutPrice(input.db, commerce.mode);
  const claimRows = await input.db.query<{
    outcome: string;
    claim_token: string | null;
    stripe_checkout_session_id: string | null;
    stripe_checkout_url: string | null;
  }>(
    `select outcome, claim_token::text as claim_token, stripe_checkout_session_id, stripe_checkout_url
       from sbg_claim_domain_a_checkout($1, $2::uuid, $3::integer, $4::integer)`,
    [input.userId, input.organisationId, quantity, DOMAIN_A_CLAIM_TTL_SECONDS],
  );
  const claim = claimRows[0];
  if (!claim) throw new DomainACheckoutClaimError("checkout_attach_failed");
  if (claim.outcome === "subscription_exists") {
    throw new SaasLifecycleError(
      "This organisation already has a SCAN BOOK GO subscription. Use Manage billing.",
      "subscription_exists",
    );
  }
  if (claim.outcome === "busy") throw new DomainACheckoutClaimError("checkout_in_progress");
  if (claim.outcome === "session_attached") {
    const url = reusableAttachedCheckout(claim.stripe_checkout_session_id, claim.stripe_checkout_url);
    if (!url) throw new DomainACheckoutClaimError("checkout_in_progress");
    return { url, quantity };
  }
  if (claim.outcome !== "claimed" || !claim.claim_token) {
    throw new DomainACheckoutClaimError("checkout_attach_failed");
  }

  const idempotencyKey = `sbg-domain-a:${input.organisationId}:${claim.claim_token}`;
  let checkout: { id: string; url: string };
  try {
    checkout = await createSubscriptionCheckout({
      priceId,
      organisationId: input.organisationId,
      userId: input.userId,
      quantity,
      customerId: billing?.stripe_customer_id,
      successUrl: `${input.origin}/app/billing?organisationId=${input.organisationId}&checkout=success`,
      cancelUrl: `${input.origin}/app/billing?organisationId=${input.organisationId}&checkout=cancel`,
      idempotencyKey,
    });
  } catch (error) {
    if (error instanceof StripeSessionCreatedError) {
      throw new DomainACheckoutClaimError("checkout_attach_failed");
    }
    try {
      await input.db.query("select sbg_release_domain_a_checkout_claim($1, $2::uuid, $3::uuid)", [
        input.userId,
        input.organisationId,
        claim.claim_token,
      ]);
    } catch {
      /* Stripe failure stays visible. The claim is left for a later retry only if release itself failed. */
    }
    throw error;
  }

  try {
    await input.db.query(
      "select sbg_attach_domain_a_checkout_session($1, $2::uuid, $3::uuid, $4, $5)",
      [input.userId, input.organisationId, claim.claim_token, checkout.id, checkout.url],
    );
  } catch {
    throw new DomainACheckoutClaimError("checkout_attach_failed");
  }
  return { url: checkout.url, quantity };
}

export async function startDomainAPortal(input: {
  db: Sql;
  userId: string;
  organisationId: string;
  origin: string;
}) {
  await assertOrganisationBillingAuthority(input.db, input.userId, input.organisationId);
  const billing = await loadOrganisationBilling(input.db, input.organisationId);
  assertPortalAllowed(billing);
  if (!billing?.stripe_customer_id) {
    throw new SaasLifecycleError(
      "Stripe billing customer is missing for this subscription.",
      "portal_customer_missing",
    );
  }
  assertDomainACommerceAllowedForOrganisation(input.organisationId);
  const portal = await createBillingPortal(
    billing.stripe_customer_id,
    `${input.origin}/app/billing?organisationId=${input.organisationId}`,
  );
  return { url: portal.url };
}

export async function allocatePropertyLicence(input: {
  db: Sql;
  userId: string;
  organisationId: string;
  hotelId: string;
}) {
  await ownedHotel(input.db, input.userId, input.hotelId);
  const billing = await loadOrganisationBilling(input.db, input.organisationId);
  if (!billing) throw new Error("no purchased property licences");
  const usable = usableLicensedQuantity(billing.licensed_quantity);
  const active = await input.db.query<{ n: number }>(
    `select count(*)::int as n
       from sbg_property_licence_allocations
      where organisation_id = $1::uuid
        and released_at is null`,
    [input.organisationId],
  );
  if (Number(active[0]?.n ?? 0) >= usable) throw new Error("no available property licence");
  const rows = await input.db.query<{ id: string }>(
    "select sbg_allocate_property_licence($1, $2::uuid, $3::uuid)::text as id",
    [input.userId, input.organisationId, input.hotelId],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("Property licence could not be allocated.");
  return { id };
}

export { SaasLifecycleError };
export type { BillingAccountSnapshot };

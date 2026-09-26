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
import { createBillingPortal, createSubscriptionCheckout } from "./stripe.server.ts";
import {
  PROPERTY_LICENCE_PLAN,
  authorisePropertyLicenceQuantity,
  propertyHasDomainAEntitlement,
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

export async function loadDomainABillingState(db: Sql, userId: string, hotelId: string) {
  await ownedHotel(db, userId, hotelId);
  const hotelRows = await db.query<{ organisation_id: string | null }>(
    "select organisation_id::text as organisation_id from hotels where id = $1::uuid",
    [hotelId],
  );
  const organisationId = hotelRows[0]?.organisation_id ?? null;
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
  const checkout = await createSubscriptionCheckout({
    priceId,
    organisationId: input.organisationId,
    userId: input.userId,
    quantity,
    customerId: billing?.stripe_customer_id,
    successUrl: `${input.origin}/app/billing?organisationId=${input.organisationId}&checkout=success`,
    cancelUrl: `${input.origin}/app/billing?organisationId=${input.organisationId}&checkout=cancel`,
  });
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

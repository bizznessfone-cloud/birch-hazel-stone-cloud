/**
 * CP26C-O2 — Owner read queries. Domain A / SaaS hotels only.
 * Never reads Domain B guest payment volume. Never writes commerce mode or hotels.
 */
import type { Sql } from "@/lib/db";
import { isSaasEntitled, parseBillingStatus } from "./saas-lifecycle.ts";

export const SBG_SAAS_PLAN_CODES = ["basic", "pro", "premium"] as const;
export type SbgSaasPlanCode = (typeof SBG_SAAS_PLAN_CODES)[number];

export const SBG_SAAS_PLAN_LABELS: Record<SbgSaasPlanCode, string> = {
  basic: "Basic",
  pro: "Pro",
  premium: "Premium",
};

const ENTITLED_SQL = `('active', 'trialing', 'past_due')`;

function n(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string {
  return value == null ? "" : String(value);
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

async function organisationSubscriptionMoney(db: Sql): Promise<{
  mrr: number;
  arr: number;
  propertyLicence: number;
}> {
  const [row] = await db.query<{ mrr: unknown; property_licence: unknown }>(
    `select
       coalesce(sum(v.amount_minor::bigint * b.licensed_quantity::bigint) filter (
         where b.status in ${ENTITLED_SQL}
       ), 0)::bigint as mrr,
       count(*) filter (where b.status in ${ENTITLED_SQL})::int as property_licence
     from sbg_organisation_billing b
     left join sbg_saas_price_versions v on v.id = b.price_version_id
      and v.plan_code = 'property_licence'`,
  );
  const mrr = n(row?.mrr);
  return { mrr, arr: mrr * 12, propertyLicence: n(row?.property_licence) };
}

export type OwnerOverview = {
  operatorAccounts: number;
  saasHotels: number;
  signups7d: number;
  signups30d: number;
  unconfigured: number;
  configured: number;
  live: number;
  subscribed: number;
  activeSubscriptions: number;
  trialingSubscriptions: number;
  pastDueSubscriptions: number;
  canceledSubscriptions: number;
  incompleteSubscriptions: number;
  mrr: number;
  arr: number;
  planDistribution: { property_licence: number };
  funnel: {
    account: number;
    hotelCreated: number;
    configured: number;
    subscribed: number;
    live: number;
    rates: {
      hotelFromAccount: number | null;
      configuredFromHotel: number | null;
      subscribedFromConfigured: number | null;
      liveFromSubscribed: number | null;
    };
  };
  recentSignups: Array<{
    userId: string;
    email: string;
    name: string;
    hotelId: string;
    hotelName: string;
    hotelCode: string;
    at: string;
  }>;
  recentEvents: Array<{
    eventId: string;
    eventType: string;
    hotelId: string | null;
    hotelName: string | null;
    outcome: string | null;
    at: string;
  }>;
  attention: Array<{ kind: string; hotelId: string; hotelName: string; hotelCode: string; detail: string }>;
};

export async function loadOwnerOverview(db: Sql): Promise<OwnerOverview> {
  const [counts] = await db.query<{
    operator_accounts: unknown;
    saas_hotels: unknown;
    signups_7d: unknown;
    signups_30d: unknown;
    unconfigured: unknown;
    configured: unknown;
    live: unknown;
    subscribed: unknown;
    active_subs: unknown;
    trialing_subs: unknown;
    past_due_subs: unknown;
    canceled_subs: unknown;
    incomplete_subs: unknown;
  }>(
    `with owned as (
       select distinct h.id, h.status
         from hotels h
         join app_hotel_accounts aha on aha.hotel_id = h.id
     ),
     first_own as (
       select user_id, min(created_at) as signed_up_at
         from app_hotel_accounts
        group by user_id
     )
     select
       (select count(*)::int from first_own) as operator_accounts,
       (select count(*)::int from owned) as saas_hotels,
       (select count(*)::int from first_own where signed_up_at >= now() - interval '7 days') as signups_7d,
       (select count(*)::int from first_own where signed_up_at >= now() - interval '30 days') as signups_30d,
       (select count(*)::int from owned where status = 'unconfigured') as unconfigured,
       (select count(*)::int from owned where status in ('configured', 'live')) as configured,
       (select count(*)::int from owned where status = 'live') as live,
       (select count(*)::int
          from sbg_property_licence_allocations a
          join sbg_organisation_billing ob on ob.organisation_id = a.organisation_id
          join owned o on o.id = a.hotel_id
         where a.released_at is null
           and ob.status in ${ENTITLED_SQL}) as subscribed,
       (select count(*)::int from sbg_organisation_billing where status = 'active') as active_subs,
       (select count(*)::int from sbg_organisation_billing where status = 'trialing') as trialing_subs,
       (select count(*)::int from sbg_organisation_billing where status = 'past_due') as past_due_subs,
       (select count(*)::int from sbg_organisation_billing where status = 'canceled') as canceled_subs,
       (select count(*)::int from sbg_organisation_billing where status in ('incomplete', 'incomplete_expired')) as incomplete_subs`,
  );

  const operatorAccounts = n(counts?.operator_accounts);
  const saasHotels = n(counts?.saas_hotels);
  const configured = n(counts?.configured);
  const subscribed = n(counts?.subscribed);
  const live = n(counts?.live);
  const money = await organisationSubscriptionMoney(db);

  const recentSignups = await db.query<{
    user_id: string;
    email: string;
    name: string;
    hotel_id: string;
    hotel_name: string;
    hotel_code: string;
    at: string;
  }>(
    `select aha.user_id,
            u.email,
            u.name,
            h.id as hotel_id,
            h.name as hotel_name,
            h.code as hotel_code,
            aha.created_at::text as at
       from app_hotel_accounts aha
       join "user" u on u.id = aha.user_id
       join hotels h on h.id = aha.hotel_id
      order by aha.created_at desc
      limit 8`,
  );

  const recentEvents = await db.query<{
    event_id: string;
    event_type: string;
    hotel_id: string | null;
    hotel_name: string | null;
    outcome: string | null;
    at: string;
  }>(
    `select e.event_id,
            e.event_type,
            e.hotel_id::text as hotel_id,
            h.name as hotel_name,
            e.outcome,
            e.processed_at::text as at
       from sbg_stripe_events e
       left join hotels h on h.id = e.hotel_id
      where e.hotel_id is null
         or exists (
              select 1 from app_hotel_accounts aha
               where aha.hotel_id = e.hotel_id
            )
      order by e.processed_at desc
      limit 8`,
  );

  const attentionRows = await db.query<{
    kind: string;
    hotel_id: string;
    hotel_name: string;
    hotel_code: string;
    detail: string;
  }>(
    `select * from (
       select 'past_due'::text as kind,
              h.id::text as hotel_id,
              h.name as hotel_name,
              h.code as hotel_code,
              'Subscription past due'::text as detail
         from hotels h
         join sbg_property_licence_allocations a on a.hotel_id = h.id and a.released_at is null
         join sbg_organisation_billing b on b.organisation_id = a.organisation_id
        where b.status = 'past_due'
          and exists (select 1 from app_hotel_accounts aha where aha.hotel_id = h.id)
       union
       select 'incomplete',
              h.id::text,
              h.name,
              h.code,
              'Subscription incomplete'
         from hotels h
         join sbg_property_licence_allocations a on a.hotel_id = h.id and a.released_at is null
         join sbg_organisation_billing b on b.organisation_id = a.organisation_id
        where b.status in ('incomplete', 'incomplete_expired')
          and exists (select 1 from app_hotel_accounts aha where aha.hotel_id = h.id)
       union
       select 'configured_unsubscribed',
              h.id::text,
              h.name,
              h.code,
              'Configured, no property licence'
         from hotels h
        where h.status in ('configured', 'live')
          and not exists (
            select 1
              from sbg_property_licence_allocations a
              join sbg_organisation_billing b on b.organisation_id = a.organisation_id
             where a.hotel_id = h.id
               and a.released_at is null
               and b.status in ${ENTITLED_SQL}
          )
          and exists (select 1 from app_hotel_accounts aha where aha.hotel_id = h.id)
       union
       select 'unconfigured',
              h.id::text,
              h.name,
              h.code,
              'Hotel unconfigured'
         from hotels h
        where h.status = 'unconfigured'
          and exists (select 1 from app_hotel_accounts aha where aha.hotel_id = h.id)
     ) attention
     order by kind, hotel_name
     limit 20`,
  );

  return {
    operatorAccounts,
    saasHotels,
    signups7d: n(counts?.signups_7d),
    signups30d: n(counts?.signups_30d),
    unconfigured: n(counts?.unconfigured),
    configured,
    live,
    subscribed,
    activeSubscriptions: n(counts?.active_subs),
    trialingSubscriptions: n(counts?.trialing_subs),
    pastDueSubscriptions: n(counts?.past_due_subs),
    canceledSubscriptions: n(counts?.canceled_subs),
    incompleteSubscriptions: n(counts?.incomplete_subs),
    mrr: money.mrr,
    arr: money.arr,
    planDistribution: { property_licence: money.propertyLicence },
    funnel: {
      account: operatorAccounts,
      hotelCreated: saasHotels,
      configured,
      subscribed,
      live,
      rates: {
        hotelFromAccount: rate(saasHotels, operatorAccounts),
        configuredFromHotel: rate(configured, saasHotels),
        subscribedFromConfigured: rate(subscribed, configured),
        liveFromSubscribed: rate(live, subscribed),
      },
    },
    recentSignups: recentSignups.map((row) => ({
      userId: text(row.user_id),
      email: text(row.email),
      name: text(row.name),
      hotelId: text(row.hotel_id),
      hotelName: text(row.hotel_name),
      hotelCode: text(row.hotel_code),
      at: text(row.at),
    })),
    recentEvents: recentEvents.map((row) => ({
      eventId: text(row.event_id),
      eventType: text(row.event_type),
      hotelId: row.hotel_id ? text(row.hotel_id) : null,
      hotelName: row.hotel_name ? text(row.hotel_name) : null,
      outcome: row.outcome ? text(row.outcome) : null,
      at: text(row.at),
    })),
    attention: attentionRows.map((row) => ({
      kind: text(row.kind),
      hotelId: text(row.hotel_id),
      hotelName: text(row.hotel_name),
      hotelCode: text(row.hotel_code),
      detail: text(row.detail),
    })),
  };
}

export type OwnerHotelListRow = {
  id: string;
  name: string;
  code: string;
  publicSlug: string;
  status: string;
  locality: string;
  ownedAt: string;
  ownerCount: number;
  operatorEmail: string;
  operatorName: string;
  billingStatus: string | null;
  stripePriceId: string | null;
  currentPeriodEnd: string | null;
  entitled: boolean;
};

export async function loadOwnerHotels(
  db: Sql,
  input: { q?: string; status?: string } = {},
): Promise<OwnerHotelListRow[]> {
  const q = String(input.q ?? "").trim().slice(0, 80).toLowerCase();
  const status = String(input.status ?? "").trim();
  const statusFilter = ["unconfigured", "configured", "live"].includes(status) ? status : "";
  const rows = await db.query<{
    id: string;
    name: string;
    code: string;
    public_slug: string;
    status: string;
    locality: string;
    owned_at: string;
    owner_count: unknown;
    operator_email: string;
    operator_name: string;
    billing_status: string | null;
    stripe_price_id: string | null;
    current_period_end: string | null;
  }>(
    `select h.id::text as id,
            h.name,
            h.code,
            h.public_slug,
            h.status,
            h.locality,
            own.owned_at::text as owned_at,
            own.owner_count,
            own.operator_email,
            own.operator_name,
            b.status as billing_status,
            b.stripe_price_id,
            b.current_period_end::text as current_period_end
       from hotels h
       join lateral (
         select min(aha.created_at) as owned_at,
                count(*)::int as owner_count,
                (array_agg(u.email order by aha.created_at))[1] as operator_email,
                (array_agg(u.name order by aha.created_at))[1] as operator_name
           from app_hotel_accounts aha
           join "user" u on u.id = aha.user_id
          where aha.hotel_id = h.id
       ) own on own.owner_count > 0
       left join sbg_property_licence_allocations alloc
         on alloc.hotel_id = h.id and alloc.released_at is null
       left join sbg_organisation_billing b
         on b.organisation_id = alloc.organisation_id
      where ($1 = '' or h.status = $1)
        and (
          $2 = ''
          or position($2 in lower(h.name)) > 0
          or position($2 in lower(h.code)) > 0
          or position($2 in lower(h.public_slug)) > 0
          or position($2 in lower(own.operator_email)) > 0
        )
      order by own.owned_at desc, h.name asc
      limit 200`,
    [statusFilter, q],
  );

  return rows.map((row) => ({
    id: text(row.id),
    name: text(row.name),
    code: text(row.code),
    publicSlug: text(row.public_slug),
    status: text(row.status),
    locality: text(row.locality),
    ownedAt: text(row.owned_at),
    ownerCount: n(row.owner_count),
    operatorEmail: text(row.operator_email),
    operatorName: text(row.operator_name),
    billingStatus: row.billing_status ? text(row.billing_status) : null,
    stripePriceId: row.stripe_price_id ? text(row.stripe_price_id) : null,
    currentPeriodEnd: row.current_period_end ? text(row.current_period_end) : null,
    entitled: isSaasEntitled(parseBillingStatus(row.billing_status)),
  }));
}

export type OwnerHotelDetail = {
  id: string;
  name: string;
  code: string;
  publicSlug: string;
  status: string;
  locality: string;
  timezone: string;
  currency: string;
  createdAt: string;
  owners: Array<{ userId: string; email: string; name: string; ownedAt: string }>;
  services: number;
  destinations: number;
  billing: {
    status: string | null;
    entitled: boolean;
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    stripePriceId: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean | null;
  };
  connect: { state: "absent" | "connected" | "disconnected"; livemode: boolean | null };
  recentEvents: Array<{
    eventId: string;
    eventType: string;
    outcome: string | null;
    at: string;
  }>;
};

export async function loadOwnerHotelDetail(
  db: Sql,
  hotelId: string,
): Promise<OwnerHotelDetail | null> {
  const id = String(hotelId ?? "").trim();
  if (!id) return null;
  const hotels = await db.query<{
    id: string;
    name: string;
    code: string;
    public_slug: string;
    status: string;
    locality: string;
    iana_timezone: string;
    currency: string;
    created_at: string;
  }>(
    `select h.id::text as id,
            h.name,
            h.code,
            h.public_slug,
            h.status,
            h.locality,
            h.iana_timezone,
            btrim(h.currency) as currency,
            h.created_at::text as created_at
       from hotels h
      where h.id = $1::uuid
        and exists (select 1 from app_hotel_accounts aha where aha.hotel_id = h.id)
      limit 1`,
    [id],
  );
  const hotel = hotels[0];
  if (!hotel) return null;

  const [owners, counts, billingRows, connectRows, events] = await Promise.all([
    db.query<{ user_id: string; email: string; name: string; owned_at: string }>(
      `select aha.user_id, u.email, u.name, aha.created_at::text as owned_at
         from app_hotel_accounts aha
         join "user" u on u.id = aha.user_id
        where aha.hotel_id = $1::uuid
        order by aha.created_at asc`,
      [id],
    ),
    db.query<{ services: unknown; destinations: unknown }>(
      `select
         (select count(*)::int from hotel_services where hotel_id = $1::uuid and active) as services,
         (select count(*)::int from hotel_destinations where hotel_id = $1::uuid and active) as destinations`,
      [id],
    ),
    db.query<{
      status: string;
      stripe_customer_id: string | null;
      stripe_subscription_id: string | null;
      stripe_price_id: string | null;
      current_period_end: string | null;
      cancel_at_period_end: boolean | null;
    }>(
      `select b.status,
              b.stripe_customer_id,
              b.stripe_subscription_id,
              b.stripe_price_id,
              b.current_period_end::text as current_period_end,
              b.cancel_at_period_end
         from sbg_property_licence_allocations a
         join sbg_organisation_billing b on b.organisation_id = a.organisation_id
        where a.hotel_id = $1::uuid
          and a.released_at is null`,
      [id],
    ),
    db.query<{ livemode: boolean; disconnected_at: string | null }>(
      `select livemode, disconnected_at::text as disconnected_at
         from sbg_stripe_connections
        where hotel_id = $1::uuid`,
      [id],
    ),
    db.query<{ event_id: string; event_type: string; outcome: string | null; at: string }>(
      `select event_id, event_type, outcome, processed_at::text as at
         from sbg_stripe_events
        where hotel_id = $1::uuid
        order by processed_at desc
        limit 12`,
      [id],
    ),
  ]);

  const billing = billingRows[0] ?? null;
  const connect = connectRows[0] ?? null;
  let connectState: OwnerHotelDetail["connect"]["state"] = "absent";
  if (connect) connectState = connect.disconnected_at ? "disconnected" : "connected";

  return {
    id: text(hotel.id),
    name: text(hotel.name),
    code: text(hotel.code),
    publicSlug: text(hotel.public_slug),
    status: text(hotel.status),
    locality: text(hotel.locality),
    timezone: text(hotel.iana_timezone),
    currency: text(hotel.currency),
    createdAt: text(hotel.created_at),
    owners: owners.map((row) => ({
      userId: text(row.user_id),
      email: text(row.email),
      name: text(row.name),
      ownedAt: text(row.owned_at),
    })),
    services: n(counts[0]?.services),
    destinations: n(counts[0]?.destinations),
    billing: {
      status: billing?.status ? text(billing.status) : null,
      entitled: isSaasEntitled(parseBillingStatus(billing?.status ?? null)),
      stripeCustomerId: billing?.stripe_customer_id ? text(billing.stripe_customer_id) : null,
      stripeSubscriptionId: billing?.stripe_subscription_id ? text(billing.stripe_subscription_id) : null,
      stripePriceId: billing?.stripe_price_id ? text(billing.stripe_price_id) : null,
      currentPeriodEnd: billing?.current_period_end ? text(billing.current_period_end) : null,
      cancelAtPeriodEnd:
        billing?.cancel_at_period_end == null ? null : Boolean(billing.cancel_at_period_end),
    },
    connect: { state: connectState, livemode: connect ? Boolean(connect.livemode) : null },
    recentEvents: events.map((row) => ({
      eventId: text(row.event_id),
      eventType: text(row.event_type),
      outcome: row.outcome ? text(row.outcome) : null,
      at: text(row.at),
    })),
  };
}

export type OwnerRevenue = {
  domain: "A";
  caption: "SBG SaaS";
  active: number;
  trialing: number;
  pastDue: number;
  canceled: number;
  incomplete: number;
  unpaid: number;
  paused: number;
  entitled: number;
  newEntitled30d: number;
  canceled30d: number;
  mrr: number;
  arr: number;
  recent: Array<{
    organisationId: string;
    organisationName: string;
    status: string;
    licensedQuantity: number;
    updatedAt: string;
  }>;
};

export async function loadOwnerRevenue(db: Sql): Promise<OwnerRevenue> {
  const [row] = await db.query<{
    active: unknown;
    trialing: unknown;
    past_due: unknown;
    canceled: unknown;
    incomplete: unknown;
    unpaid: unknown;
    paused: unknown;
    entitled: unknown;
    new_30d: unknown;
    canceled_30d: unknown;
  }>(
    `with billing as (
       select b.*
         from sbg_organisation_billing b
     )
     select
       (select count(*)::int from billing where status = 'active') as active,
       (select count(*)::int from billing where status = 'trialing') as trialing,
       (select count(*)::int from billing where status = 'past_due') as past_due,
       (select count(*)::int from billing where status = 'canceled') as canceled,
       (select count(*)::int from billing where status in ('incomplete', 'incomplete_expired')) as incomplete,
       (select count(*)::int from billing where status = 'unpaid') as unpaid,
       (select count(*)::int from billing where status = 'paused') as paused,
       (select count(*)::int from billing where status in ${ENTITLED_SQL}) as entitled,
       (select count(*)::int from billing
         where status in ${ENTITLED_SQL} and updated_at >= now() - interval '30 days') as new_30d,
       (select count(*)::int from billing
         where status = 'canceled' and updated_at >= now() - interval '30 days') as canceled_30d`,
  );

  const recent = await db.query<{
    organisation_id: string;
    organisation_name: string;
    status: string;
    licensed_quantity: number;
    updated_at: string;
  }>(
    `select o.id::text as organisation_id,
            o.name as organisation_name,
            b.status,
            b.licensed_quantity,
            b.updated_at::text as updated_at
       from sbg_organisation_billing b
       join sbg_organisations o on o.id = b.organisation_id
      order by b.updated_at desc
      limit 12`,
  );
  const money = await organisationSubscriptionMoney(db);

  return {
    domain: "A",
    caption: "SBG SaaS",
    active: n(row?.active),
    trialing: n(row?.trialing),
    pastDue: n(row?.past_due),
    canceled: n(row?.canceled),
    incomplete: n(row?.incomplete),
    unpaid: n(row?.unpaid),
    paused: n(row?.paused),
    entitled: n(row?.entitled),
    newEntitled30d: n(row?.new_30d),
    canceled30d: n(row?.canceled_30d),
    mrr: money.mrr,
    arr: money.arr,
    recent: recent.map((item) => ({
      organisationId: text(item.organisation_id),
      organisationName: text(item.organisation_name),
      status: text(item.status),
      licensedQuantity: n(item.licensed_quantity),
      updatedAt: text(item.updated_at),
    })),
  };
}

export async function resolveAllowlistHotelNames(
  db: Sql,
  ids: readonly string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db.query<{ name: string }>(
    `select name from hotels where id = any($1::uuid[]) order by name`,
    [ids],
  );
  return rows.map((row) => text(row.name)).filter(Boolean);
}

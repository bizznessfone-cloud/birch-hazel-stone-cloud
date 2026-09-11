/**
 * CP14.3 owner-only hotel provisioner.
 *
 * Takes a hotel UNCONFIGURED → CONFIGURED → LIVE.
 * Not an HTTP API. Not an /ops capability. Callers are owner scripts
 * (AETHER_DATABASE_OWNER_URL) and tests. Guest, hotel_desk, and
 * provider_dispatcher must not import this module.
 *
 * Lifecycle is fail-closed:
 *   unconfigured → configured   (identity complete)
 *   configured   → live         (identity + ≥1 active dest + exactly 1 active agreement)
 * Downgrades are not provided. Status is changed only by named promotions.
 * unconfigured → live is rejected unless provisionHotel() performs the
 * configured transition in the same owner transaction.
 *
 * Seeded demo fixtures gate / harbor / legacy are refused.
 * Does not write occupancy ranges. Does not convert timezones.
 */
import { hotelIdentity, normalizeHotelCode } from "./hotel.ts";

export const RESERVED_DEMO_HOTEL_CODES = ["gate", "harbor"] as const;
export const RESERVED_DEMO_PROVIDER_CODES = ["legacy"] as const;

export const DESTINATION_KINDS = ["airport", "port", "hotel", "other"] as const;
export type DestinationKind = (typeof DESTINATION_KINDS)[number];

export const HOTEL_STATUSES = ["unconfigured", "configured", "live"] as const;
export type HotelStatus = (typeof HOTEL_STATUSES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY_RE = /^[A-Z]{3}$/;
const PLACEHOLDER_LOCALITY = "unspecified";

export type ProvisionDb = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (db: ProvisionDb) => Promise<T>): Promise<T>;
};

export type ProvisionErrorCode =
  | "invalid"
  | "not_found"
  | "conflict"
  | "incomplete"
  | "forbidden"
  | "illegal_transition";

export class ProvisionError extends Error {
  readonly code: ProvisionErrorCode;
  readonly issues: string[];
  constructor(code: ProvisionErrorCode, message: string, issues: string[] = []) {
    super(message);
    this.name = "ProvisionError";
    this.code = code;
    this.issues = issues.length > 0 ? issues : [message];
  }
}

export type ProvisionedHotel = {
  id: string;
  code: string;
  name: string;
  locality: string;
  ianaTimezone: string;
  currency: string;
  status: HotelStatus;
};

export type HotelDestination = {
  id: string;
  hotelId: string;
  kind: DestinationKind;
  name: string;
  sortOrder: number;
  active: boolean;
  amountMinor: number;
};

export type ProviderRecord = {
  id: string;
  code: string;
  name: string;
  kind: "in_house" | "external";
};

export type CompletenessReport = {
  ok: boolean;
  issues: string[];
  hotel: ProvisionedHotel | null;
  activeDestinationCount: number;
  activeAgreementCount: number;
  executingProviderId: string | null;
};

export type CreateHotelInput = {
  code: string;
  name: string;
};

export type ConfigureHotelInput = {
  hotelId: string;
  code: string;
  name: string;
  locality: string;
  ianaTimezone: string;
  currency: string;
};

export type UpsertDestinationInput = {
  hotelId: string;
  id?: string | null;
  kind: string;
  name: string;
  sortOrder?: number;
  active?: boolean;
  amountMinor: number;
};

export type EnsureProviderInput = {
  code: string;
  name: string;
  kind?: string;
};

export type EstablishAgreementInput = {
  hotelId: string;
  providerId: string;
};

export type ProvisionHotelInput = {
  hotel: {
    code: string;
    name: string;
    locality: string;
    ianaTimezone: string;
    currency: string;
  };
  destinations: Array<{
    kind: string;
    name: string;
    sortOrder?: number;
    active?: boolean;
    amountMinor: number;
  }>;
  provider: EnsureProviderInput;
  goLive?: boolean;
};

type HotelRow = {
  id: string;
  code: string;
  name: string;
  locality: string;
  iana_timezone: string;
  currency: string;
  status: string;
};

const HOTEL_SELECT = `
  select id, code, name, locality,
         btrim(iana_timezone) as iana_timezone,
         btrim(currency) as currency,
         status
    from hotels
`;

function isReservedHotelCode(code: string): boolean {
  return (RESERVED_DEMO_HOTEL_CODES as readonly string[]).includes(code);
}

function isReservedProviderCode(code: string): boolean {
  return (RESERVED_DEMO_PROVIDER_CODES as readonly string[]).includes(code);
}

function requireUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value.trim())) {
    throw new ProvisionError("invalid", `${label} is required`);
  }
  return value.trim().toLowerCase();
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new ProvisionError("invalid", `${label} is required`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ProvisionError("invalid", `${label} is required`);
  }
  return trimmed;
}

function requireHotelCode(value: unknown): string {
  const code = normalizeHotelCode(value);
  if (!code) {
    throw new ProvisionError("invalid", "hotel code is invalid");
  }
  return code;
}

function requireCurrency(value: unknown): string {
  if (typeof value !== "string") {
    throw new ProvisionError("invalid", "currency is invalid");
  }
  const currency = value.trim().toUpperCase();
  if (!CURRENCY_RE.test(currency)) {
    throw new ProvisionError("invalid", "currency is invalid");
  }
  return currency;
}

function requireKind(value: unknown): DestinationKind {
  if (typeof value !== "string" || !DESTINATION_KINDS.includes(value as DestinationKind)) {
    throw new ProvisionError("invalid", "destination kind is invalid");
  }
  return value as DestinationKind;
}

function requireAmountMinor(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ProvisionError("invalid", "amount_minor must be an integer >= 0");
  }
  return value;
}

function requireSortOrder(value: unknown): number {
  if (value == null) return 0;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ProvisionError("invalid", "sort_order must be an integer");
  }
  return value;
}

function requireActive(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value !== "boolean") {
    throw new ProvisionError("invalid", "active must be a boolean");
  }
  return value;
}

function requireProviderKind(value: unknown): "in_house" | "external" {
  if (value == null || value === "") return "external";
  if (value === "in_house" || value === "external") return value;
  throw new ProvisionError("invalid", "provider kind is invalid");
}

function requireIdentity(input: { code: string; name: string }) {
  try {
    return hotelIdentity(input);
  } catch {
    throw new ProvisionError("invalid", "hotel code or name is invalid");
  }
}

function toHotel(row: HotelRow): ProvisionedHotel {
  const status = row.status as HotelStatus;
  if (!HOTEL_STATUSES.includes(status)) {
    throw new ProvisionError("invalid", "hotel status is invalid");
  }
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    locality: row.locality,
    ianaTimezone: row.iana_timezone,
    currency: row.currency,
    status,
  };
}

function identityIssues(hotel: ProvisionedHotel): string[] {
  const issues: string[] = [];
  if (!normalizeHotelCode(hotel.code)) issues.push("code is invalid");
  if (!hotel.name.trim()) issues.push("name is required");
  if (!hotel.locality.trim()) issues.push("locality is required");
  if (hotel.locality.trim().toLowerCase() === PLACEHOLDER_LOCALITY) {
    issues.push("locality is still the unspecified placeholder");
  }
  if (!hotel.ianaTimezone.trim()) issues.push("iana_timezone is required");
  if (!CURRENCY_RE.test(hotel.currency.trim().toUpperCase())) {
    issues.push("currency is invalid");
  }
  return issues;
}

function assertMutableHotel(hotel: ProvisionedHotel, allowLiveDest = false): void {
  if (isReservedHotelCode(hotel.code)) {
    throw new ProvisionError(
      "forbidden",
      "seeded demo hotels cannot be provisioned",
      [`${hotel.code} is a reserved demo fixture`],
    );
  }
  if (hotel.status === "live" && !allowLiveDest) {
    throw new ProvisionError(
      "illegal_transition",
      "live hotels cannot be reconfigured by this provisioner",
    );
  }
}

function pgCode(err: unknown): string | undefined {
  return (err as { code?: string }).code;
}

async function wrapConflict<T>(fn: () => Promise<T>, message: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (pgCode(err) === "23505") {
      throw new ProvisionError("conflict", message);
    }
    throw err;
  }
}

export async function loadHotel(db: ProvisionDb, hotelId: string): Promise<ProvisionedHotel> {
  const id = requireUuid(hotelId, "hotelId");
  const rows = await db.query<HotelRow>(`${HOTEL_SELECT} where id = $1::uuid`, [id]);
  const row = rows[0];
  if (!row) throw new ProvisionError("not_found", "hotel not found");
  return toHotel(row);
}

export async function loadHotelByCode(db: ProvisionDb, hotelCode: string): Promise<ProvisionedHotel> {
  const code = requireHotelCode(hotelCode);
  const rows = await db.query<HotelRow>(`${HOTEL_SELECT} where lower(code) = $1`, [code]);
  const row = rows[0];
  if (!row) throw new ProvisionError("not_found", "hotel not found");
  return toHotel(row);
}

export async function createHotel(
  db: ProvisionDb,
  input: CreateHotelInput,
): Promise<ProvisionedHotel> {
  const identity = requireIdentity({ code: input.code, name: input.name });
  if (isReservedHotelCode(identity.code)) {
    throw new ProvisionError(
      "forbidden",
      "seeded demo hotels cannot be provisioned",
      [`${identity.code} is a reserved demo fixture`],
    );
  }
  const rows = await wrapConflict(
    () =>
      db.query<HotelRow>(
        `insert into hotels (code, name)
         values ($1, $2)
         returning id, code, name, locality,
                   btrim(iana_timezone) as iana_timezone,
                   btrim(currency) as currency,
                   status`,
        [identity.code, identity.name],
      ),
    "hotel code already exists",
  );
  const row = rows[0];
  if (!row) throw new ProvisionError("conflict", "hotel insert failed");
  const hotel = toHotel(row);
  if (hotel.status !== "unconfigured") {
    throw new ProvisionError("illegal_transition", "new hotel must default to unconfigured");
  }
  return hotel;
}

export async function configureHotel(
  db: ProvisionDb,
  input: ConfigureHotelInput,
): Promise<ProvisionedHotel> {
  const existing = await loadHotel(db, input.hotelId);
  assertMutableHotel(existing);
  const identity = requireIdentity({ code: input.code, name: input.name });
  if (isReservedHotelCode(identity.code)) {
    throw new ProvisionError(
      "forbidden",
      "seeded demo hotels cannot be provisioned",
      [`${identity.code} is a reserved demo fixture`],
    );
  }
  const locality = requireText(input.locality, "locality");
  if (locality.toLowerCase() === PLACEHOLDER_LOCALITY) {
    throw new ProvisionError("invalid", "locality is still the unspecified placeholder");
  }
  const ianaTimezone = requireText(input.ianaTimezone, "iana_timezone");
  const currency = requireCurrency(input.currency);
  const rows = await wrapConflict(
    () =>
      db.query<HotelRow>(
        `update hotels
            set code = $2,
                name = $3,
                locality = $4,
                iana_timezone = $5,
                currency = $6
          where id = $1::uuid
            and status <> 'live'
        returning id, code, name, locality,
                  btrim(iana_timezone) as iana_timezone,
                  btrim(currency) as currency,
                  status`,
        [existing.id, identity.code, identity.name, locality, ianaTimezone, currency],
      ),
    "hotel code already exists",
  );
  const row = rows[0];
  if (!row) {
    throw new ProvisionError("illegal_transition", "live hotels cannot be reconfigured by this provisioner");
  }
  return toHotel(row);
}

export async function upsertHotelDestination(
  db: ProvisionDb,
  input: UpsertDestinationInput,
): Promise<HotelDestination> {
  const hotel = await loadHotel(db, input.hotelId);
  assertMutableHotel(hotel, true);
  const kind = requireKind(input.kind);
  const name = requireText(input.name, "destination name");
  const amountMinor = requireAmountMinor(input.amountMinor);
  const sortOrder = requireSortOrder(input.sortOrder);
  const active = requireActive(input.active);

  if (input.id) {
    const destId = requireUuid(input.id, "destination id");
    const updated = await db.query<{
      id: string;
      hotel_id: string;
      kind: DestinationKind;
      name: string;
      sort_order: number;
      active: boolean;
      amount_minor: number;
    }>(
      `update hotel_destinations
          set kind = $3,
              name = $4,
              sort_order = $5,
              active = $6,
              amount_minor = $7
        where id = $1::uuid
          and hotel_id = $2::uuid
      returning id, hotel_id, kind, name, sort_order, active, amount_minor`,
      [destId, hotel.id, kind, name, sortOrder, active, amountMinor],
    );
    const row = updated[0];
    if (!row) {
      throw new ProvisionError(
        "forbidden",
        "destination is not in this hotel's catalogue",
      );
    }
    return {
      id: row.id,
      hotelId: row.hotel_id,
      kind: row.kind,
      name: row.name,
      sortOrder: Number(row.sort_order),
      active: row.active,
      amountMinor: Number(row.amount_minor),
    };
  }

  const existing = await db.query<{ id: string }>(
    `select id
       from hotel_destinations
      where hotel_id = $1::uuid
        and kind = $2
        and lower(btrim(name)) = lower(btrim($3))
      limit 1`,
    [hotel.id, kind, name],
  );
  if (existing[0]) {
    return upsertHotelDestination(db, { ...input, id: existing[0].id });
  }

  const inserted = await wrapConflict(
    () =>
      db.query<{
        id: string;
        hotel_id: string;
        kind: DestinationKind;
        name: string;
        sort_order: number;
        active: boolean;
        amount_minor: number;
      }>(
        `insert into hotel_destinations (hotel_id, kind, name, sort_order, active, amount_minor)
         values ($1::uuid, $2, $3, $4, $5, $6)
         returning id, hotel_id, kind, name, sort_order, active, amount_minor`,
        [hotel.id, kind, name, sortOrder, active, amountMinor],
      ),
    "destination already exists for this hotel",
  );
  const row = inserted[0];
  if (!row) throw new ProvisionError("conflict", "destination insert failed");
  return {
    id: row.id,
    hotelId: row.hotel_id,
    kind: row.kind,
    name: row.name,
    sortOrder: Number(row.sort_order),
    active: row.active,
    amountMinor: Number(row.amount_minor),
  };
}

export async function ensureProvider(
  db: ProvisionDb,
  input: EnsureProviderInput,
): Promise<ProviderRecord> {
  const code = requireHotelCode(input.code);
  const name = requireText(input.name, "provider name");
  const kind = requireProviderKind(input.kind);
  const existing = await db.query<ProviderRecord>(
    `select id, code, name, kind from providers where lower(code) = $1 limit 1`,
    [code],
  );
  if (existing[0]) {
    return existing[0];
  }
  if (isReservedProviderCode(code)) {
    throw new ProvisionError("forbidden", "seeded demo providers cannot be created");
  }
  const inserted = await wrapConflict(
    () =>
      db.query<ProviderRecord>(
        `insert into providers (code, name, kind)
         values ($1, $2, $3)
         returning id, code, name, kind`,
        [code, name, kind],
      ),
    "provider code already exists",
  );
  const row = inserted[0];
  if (!row) throw new ProvisionError("conflict", "provider insert failed");
  return row;
}

export async function establishActiveAgreement(
  db: ProvisionDb,
  input: EstablishAgreementInput,
): Promise<{ id: string; hotelId: string; providerId: string; active: boolean }> {
  const hotel = await loadHotel(db, input.hotelId);
  assertMutableHotel(hotel, true);
  const providerId = requireUuid(input.providerId, "providerId");
  const provider = await db.query<{ id: string }>(
    "select id from providers where id = $1::uuid",
    [providerId],
  );
  if (!provider[0]) throw new ProvisionError("not_found", "provider not found");

  await db.query(
    `update hotel_provider_agreements
        set active = false
      where hotel_id = $1::uuid
        and active
        and provider_id is distinct from $2::uuid`,
    [hotel.id, providerId],
  );
  const rows = await wrapConflict(
    () =>
      db.query<{ id: string; hotel_id: string; provider_id: string; active: boolean }>(
        `insert into hotel_provider_agreements (hotel_id, provider_id, active)
         values ($1::uuid, $2::uuid, true)
         on conflict (hotel_id, provider_id) do update
           set active = true
         returning id, hotel_id, provider_id, active`,
        [hotel.id, providerId],
      ),
    "hotel already has an active provider agreement",
  );
  const row = rows[0];
  if (!row?.active) {
    throw new ProvisionError("conflict", "active provider agreement was not established");
  }
  return {
    id: row.id,
    hotelId: row.hotel_id,
    providerId: row.provider_id,
    active: row.active,
  };
}

export async function validateHotelIdentity(
  db: ProvisionDb,
  hotelId: string,
): Promise<CompletenessReport> {
  const hotel = await loadHotel(db, hotelId);
  const issues = identityIssues(hotel);
  if (isReservedHotelCode(hotel.code)) {
    issues.push(`${hotel.code} is a reserved demo fixture`);
  }
  return {
    ok: issues.length === 0,
    issues,
    hotel,
    activeDestinationCount: 0,
    activeAgreementCount: 0,
    executingProviderId: null,
  };
}

export async function validateHotelForLive(
  db: ProvisionDb,
  hotelId: string,
): Promise<CompletenessReport> {
  const hotel = await loadHotel(db, hotelId);
  const issues = identityIssues(hotel);
  if (isReservedHotelCode(hotel.code)) {
    issues.push(`${hotel.code} is a reserved demo fixture`);
  }

  const destinations = await db.query<{
    id: string;
    kind: string;
    name: string;
    amount_minor: number;
    active: boolean;
  }>(
    `select id, kind, name, amount_minor, active
       from hotel_destinations
      where hotel_id = $1::uuid
        and active`,
    [hotel.id],
  );
  if (destinations.length < 1) {
    issues.push("at least one active destination is required");
  }
  for (const dest of destinations) {
    if (!DESTINATION_KINDS.includes(dest.kind as DestinationKind)) {
      issues.push(`destination ${dest.id} has an invalid kind`);
    }
    if (!dest.name.trim()) {
      issues.push(`destination ${dest.id} has an empty name`);
    }
    if (!Number.isInteger(Number(dest.amount_minor)) || Number(dest.amount_minor) < 0) {
      issues.push(`destination ${dest.id} has an invalid amount`);
    }
  }

  const agreements = await db.query<{ id: string; provider_id: string }>(
    `select id, provider_id
       from hotel_provider_agreements
      where hotel_id = $1::uuid
        and active`,
    [hotel.id],
  );
  if (agreements.length !== 1) {
    issues.push("exactly one active hotel/provider agreement is required");
  }

  return {
    ok: issues.length === 0,
    issues,
    hotel,
    activeDestinationCount: destinations.length,
    activeAgreementCount: agreements.length,
    executingProviderId: agreements[0]?.provider_id ?? null,
  };
}

export async function promoteHotelToConfigured(
  db: ProvisionDb,
  hotelId: string,
): Promise<ProvisionedHotel> {
  const report = await validateHotelIdentity(db, hotelId);
  const hotel = report.hotel;
  if (!hotel) throw new ProvisionError("not_found", "hotel not found");
  if (isReservedHotelCode(hotel.code)) {
    throw new ProvisionError("forbidden", "seeded demo hotels cannot be provisioned", report.issues);
  }
  if (hotel.status === "live") {
    throw new ProvisionError("illegal_transition", "live hotels cannot be demoted");
  }
  if (!report.ok) {
    throw new ProvisionError("incomplete", "hotel is not ready to become configured", report.issues);
  }
  if (hotel.status === "configured") return hotel;
  const rows = await db.query<HotelRow>(
    `update hotels
        set status = 'configured'
      where id = $1::uuid
        and status = 'unconfigured'
    returning id, code, name, locality,
              btrim(iana_timezone) as iana_timezone,
              btrim(currency) as currency,
              status`,
    [hotel.id],
  );
  const row = rows[0];
  if (!row) {
    throw new ProvisionError("illegal_transition", "hotel could not be promoted to configured");
  }
  return toHotel(row);
}

export async function promoteHotelToLive(
  db: ProvisionDb,
  hotelId: string,
): Promise<ProvisionedHotel> {
  const report = await validateHotelForLive(db, hotelId);
  const hotel = report.hotel;
  if (!hotel) throw new ProvisionError("not_found", "hotel not found");
  if (isReservedHotelCode(hotel.code)) {
    throw new ProvisionError("forbidden", "seeded demo hotels cannot be provisioned", report.issues);
  }
  if (hotel.status === "unconfigured") {
    throw new ProvisionError(
      "illegal_transition",
      "unconfigured hotels cannot become live; promote to configured first",
    );
  }
  if (!report.ok) {
    throw new ProvisionError("incomplete", "hotel is not ready to become live", report.issues);
  }
  if (hotel.status === "live") return hotel;
  const rows = await db.query<HotelRow>(
    `update hotels
        set status = 'live'
      where id = $1::uuid
        and status = 'configured'
    returning id, code, name, locality,
              btrim(iana_timezone) as iana_timezone,
              btrim(currency) as currency,
              status`,
    [hotel.id],
  );
  const row = rows[0];
  if (!row) {
    throw new ProvisionError("illegal_transition", "hotel could not be promoted to live");
  }
  return toHotel(row);
}

export async function provisionHotel(
  db: ProvisionDb,
  input: ProvisionHotelInput,
): Promise<{
  hotel: ProvisionedHotel;
  provider: ProviderRecord;
  destinations: HotelDestination[];
}> {
  return db.transaction(async (tx) => {
    const created = await createHotel(tx, {
      code: input.hotel.code,
      name: input.hotel.name,
    });
    await configureHotel(tx, {
      hotelId: created.id,
      code: input.hotel.code,
      name: input.hotel.name,
      locality: input.hotel.locality,
      ianaTimezone: input.hotel.ianaTimezone,
      currency: input.hotel.currency,
    });
    const provider = await ensureProvider(tx, input.provider);
    await establishActiveAgreement(tx, {
      hotelId: created.id,
      providerId: provider.id,
    });
    const destinations: HotelDestination[] = [];
    for (const dest of input.destinations) {
      destinations.push(
        await upsertHotelDestination(tx, {
          hotelId: created.id,
          kind: dest.kind,
          name: dest.name,
          sortOrder: dest.sortOrder,
          active: dest.active,
          amountMinor: dest.amountMinor,
        }),
      );
    }
    await promoteHotelToConfigured(tx, created.id);
    if (input.goLive) {
      await promoteHotelToLive(tx, created.id);
    }
    return {
      hotel: await loadHotel(tx, created.id),
      provider,
      destinations,
    };
  });
}

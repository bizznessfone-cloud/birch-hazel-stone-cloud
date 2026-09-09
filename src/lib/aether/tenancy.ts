/**
 * CP12 organisational scope. Authentication remains requireOps().
 * Fail closed: no membership, inactive membership, or wrong class is denied.
 */
export const ACCESS_HOTEL_DESK = "hotel_desk";
export const ACCESS_PROVIDER_DISPATCHER = "provider_dispatcher";

export type AccessClass = typeof ACCESS_HOTEL_DESK | typeof ACCESS_PROVIDER_DISPATCHER;

export type OpsScope = {
  operatorId: string;
  login: string;
  sessionId: string;
  membershipId: string;
  accessClass: AccessClass;
  hotelId: string | null;
  providerId: string | null;
};

export type TenancyDb = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
};

export function isHotelDesk(scope: OpsScope): boolean {
  return scope.accessClass === ACCESS_HOTEL_DESK && Boolean(scope.hotelId);
}

export function isProviderDispatcher(scope: OpsScope): boolean {
  return scope.accessClass === ACCESS_PROVIDER_DISPATCHER && Boolean(scope.providerId);
}

export function auditOrgPayload(scope: OpsScope): Record<string, unknown> {
  return {
    membership_id: scope.membershipId,
    access_class: scope.accessClass,
    hotel_id: scope.hotelId,
    provider_id: scope.providerId,
  };
}

export async function activeExecutingProviderId(
  db: TenancyDb,
  hotelId: string,
): Promise<string | null> {
  const rows = await db.query<{ provider_id: string }>(
    `select provider_id
       from hotel_provider_agreements
      where hotel_id = $1::uuid and active
      limit 1`,
    [hotelId],
  );
  return rows[0]?.provider_id ?? null;
}

export async function grantHotelDesk(
  db: TenancyDb,
  operatorId: string,
  hotelId: string,
): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `insert into operator_memberships (operator_id, org_kind, hotel_id, access_class)
     values ($1::uuid, 'hotel', $2::uuid, 'hotel_desk')
     returning id`,
    [operatorId, hotelId],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("hotel desk membership insert failed");
  return id;
}

export async function grantProviderDispatcher(
  db: TenancyDb,
  operatorId: string,
  providerId: string,
): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `insert into operator_memberships (operator_id, org_kind, provider_id, access_class)
     values ($1::uuid, 'provider', $2::uuid, 'provider_dispatcher')
     returning id`,
    [operatorId, providerId],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("provider dispatcher membership insert failed");
  return id;
}

export async function ensureLegacyDispatcherMembership(
  db: TenancyDb,
  operatorId: string,
): Promise<string> {
  const existing = await db.query<{ id: string }>(
    `select m.id
       from operator_memberships m
       join providers p on p.id = m.provider_id
      where m.operator_id = $1::uuid
        and m.active
        and m.access_class = 'provider_dispatcher'
        and p.code = 'legacy'
      limit 1`,
    [operatorId],
  );
  if (existing[0]) return existing[0].id;
  const provider = await db.query<{ id: string }>(
    "select id from providers where code = 'legacy' limit 1",
  );
  if (!provider[0]) throw new Error("legacy provider missing");
  return grantProviderDispatcher(db, operatorId, provider[0].id);
}

export async function providerIdByCode(db: TenancyDb, code: string): Promise<string | null> {
  const rows = await db.query<{ id: string }>(
    "select id from providers where code = $1 limit 1",
    [code],
  );
  return rows[0]?.id ?? null;
}

export async function legacyDispatcherScope(
  db: TenancyDb,
  operatorId: string,
  login: string,
): Promise<OpsScope> {
  const membershipId = await ensureLegacyDispatcherMembership(db, operatorId);
  const provider = await providerIdByCode(db, "legacy");
  if (!provider) throw new Error("legacy provider missing");
  return {
    operatorId,
    login,
    sessionId: "bound",
    membershipId,
    accessClass: ACCESS_PROVIDER_DISPATCHER,
    hotelId: null,
    providerId: provider,
  };
}

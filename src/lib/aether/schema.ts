import type { ColumnType, Generated } from "kysely";

/**
 * Kysely database type. Must match migrations/.
 * occupies is trigger-maintained — application code must not write it.
 */
export interface AetherMetaTable {
  key: string;
  value: string;
  updated_at: Generated<Date>;
}

export interface HotelsTable {
  id: Generated<string>;
  code: string;
  name: string;
  created_at: Generated<Date>;
}

export interface ProvidersTable {
  id: Generated<string>;
  code: string;
  name: string;
  kind: Generated<string>;
  created_at: Generated<Date>;
}

export interface HotelProviderAgreementsTable {
  id: Generated<string>;
  hotel_id: string;
  provider_id: string;
  active: Generated<boolean>;
  created_at: Generated<Date>;
}

export interface VehiclesTable {
  id: Generated<string>;
  name: string;
  active: Generated<boolean>;
  capacity: Generated<number>;
  owned_by_hotel_id: string | null;
  owned_by_provider_id: string | null;
  operated_by_provider_id: string;
  created_at: Generated<Date>;
}

export interface DriversTable {
  id: Generated<string>;
  name: string;
  active: Generated<boolean>;
  employed_by_hotel_id: string | null;
  employed_by_provider_id: string | null;
  dispatched_by_provider_id: string;
  created_at: Generated<Date>;
}

export interface OperatorsTable {
  id: Generated<string>;
  login: string;
  password_hash: string;
  created_at: Generated<Date>;
}

export interface OperatorMembershipsTable {
  id: Generated<string>;
  operator_id: string;
  org_kind: string;
  hotel_id: string | null;
  provider_id: string | null;
  access_class: string;
  active: Generated<boolean>;
  created_at: Generated<Date>;
}

export interface SessionsTable {
  id: Generated<string>;
  operator_id: string;
  membership_id: string;
  token_hash: string;
  csrf_hash: Generated<string>;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Generated<Date>;
}

export interface BookingsTable {
  id: Generated<string>;
  hotel_id: string;
  executing_provider_id: string;
  transfer_date: string;
  pickup_time: string;
  duration_minutes: number;
  occupies: ColumnType<string, never, never>;
  vehicle_id: string | null;
  driver_id: string | null;
  cancelled_at: Date | null;
  status: Generated<string>;
  guest_name: string;
  guest_phone: string;
  guest_email: string;
  passenger_count: Generated<number>;
  luggage_count: Generated<number>;
  pickup_text: string;
  destination_text: string;
  special_requirements: string | null;
  internal_notes: string | null;
  human_reference: string;
  confirmation_token: string;
  created_at: Generated<Date>;
}

export interface AuditEventsTable {
  id: Generated<string>;
  at: Generated<Date>;
  actor_type: string;
  actor_id: string | null;
  action: string;
  booking_id: string | null;
  payload: Generated<unknown>;
}

export interface IdempotencyKeysTable {
  id: Generated<string>;
  scope: string;
  key: string;
  request_hash: string;
  booking_id: string | null;
  created_at: Generated<Date>;
}

export interface LoginAttemptsTable {
  id: Generated<string>;
  login_key: string;
  succeeded: Generated<boolean>;
  attempted_at: Generated<Date>;
}

export interface PublicBookingAttemptsTable {
  id: Generated<string>;
  client_key: string;
  attempted_at: Generated<Date>;
}

export interface AetherDatabase {
  aether_meta: AetherMetaTable;
  hotels: HotelsTable;
  providers: ProvidersTable;
  hotel_provider_agreements: HotelProviderAgreementsTable;
  vehicles: VehiclesTable;
  drivers: DriversTable;
  operators: OperatorsTable;
  operator_memberships: OperatorMembershipsTable;
  sessions: SessionsTable;
  bookings: BookingsTable;
  audit_events: AuditEventsTable;
  idempotency_keys: IdempotencyKeysTable;
  login_attempts: LoginAttemptsTable;
  public_booking_attempts: PublicBookingAttemptsTable;
}

/**
 * Closed-by-default identity checks for a future Stripe TEST run.
 * These checks do not open Checkout and do not trust a port or an
 * environment-variable name on its own.
 */
import { closeSync, openSync, readSync } from "node:fs";
import { classifyStripeSecretKey } from "./saas-commerce.server.ts";

/** Data directory of the embedded cluster verified in G.2-T2. Not a Neon endpoint. */
export const AUTHORISED_DISPOSABLE_DATA_DIRECTORY = "/tmp/s1pg/data";
/** Control file whose system identifier must match the connected session. */
export const AUTHORISED_DISPOSABLE_CONTROL_FILE = "/tmp/s1pg/data/global/pg_control";
/** Database created by the local reset harness. The admin database is not accepted. */
export const AUTHORISED_DISPOSABLE_DATABASE = "neondb";
export const AUTHORISED_DISPOSABLE_LISTEN = "127.0.0.1";

export class GuestPaymentIsolationError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "GuestPaymentIsolationError";
    this.code = code;
  }
}

type QueryDb = {
  query<T>(text: string, params?: unknown[]): Promise<T[]>;
};

export function assertGuestPaymentTestProcess(env: NodeJS.Dict<string>): void {
  if (classifyStripeSecretKey(env.STRIPE_SECRET_KEY) !== "test") {
    throw new GuestPaymentIsolationError("live_credentials_rejected");
  }
  if (env.SBG_DOMAIN_B_LIVE_CHECKOUT === "true" || env.SBG_SAAS_COMMERCE === "live") {
    throw new GuestPaymentIsolationError("live_payment_flag");
  }
}

export type DisposableDatabaseFacts = {
  dataDirectory: string | null;
  listenAddresses: string | null;
  port: string | null;
  serverAddr: string | null;
  databaseName: string | null;
  inRecovery: boolean | null;
  systemIdentifier: string | null;
};

export function readAuthorisedClusterSystemIdentifier(): bigint {
  let fd: number | null = null;
  try {
    fd = openSync(AUTHORISED_DISPOSABLE_CONTROL_FILE, "r");
    const buf = Buffer.alloc(8);
    if (readSync(fd, buf, 0, 8, 0) !== 8) throw new GuestPaymentIsolationError("database_not_authorised");
    return buf.readBigUInt64LE(0);
  } catch (err) {
    if (err instanceof GuestPaymentIsolationError) throw err;
    throw new GuestPaymentIsolationError("database_not_authorised");
  } finally {
    if (fd != null) closeSync(fd);
  }
}

export function assertDisposableDatabaseIdentity(facts: DisposableDatabaseFacts): void {
  const loopback = facts.serverAddr === "127.0.0.1" || facts.serverAddr === "127.0.0.1/32";
  let controlId: bigint;
  try {
    controlId = readAuthorisedClusterSystemIdentifier();
  } catch {
    throw new GuestPaymentIsolationError("database_not_authorised");
  }
  let sessionId: bigint;
  try {
    sessionId = BigInt(facts.systemIdentifier ?? "");
  } catch {
    throw new GuestPaymentIsolationError("database_not_authorised");
  }
  if (
    !loopback ||
    sessionId !== controlId ||
    (facts.dataDirectory != null && facts.dataDirectory !== AUTHORISED_DISPOSABLE_DATA_DIRECTORY) ||
    facts.listenAddresses !== AUTHORISED_DISPOSABLE_LISTEN ||
    facts.databaseName !== AUTHORISED_DISPOSABLE_DATABASE ||
    facts.inRecovery !== false ||
    facts.port == null ||
    !/^\d+$/.test(facts.port)
  ) {
    throw new GuestPaymentIsolationError("database_not_authorised");
  }
}

export async function assertConnectedDisposableDatabase(db: QueryDb): Promise<void> {
  let rows: Array<Omit<DisposableDatabaseFacts, "dataDirectory">>;
  try {
    rows = await db.query<Omit<DisposableDatabaseFacts, "dataDirectory">>(
      `select current_setting('listen_addresses') as "listenAddresses",
              current_setting('port') as "port",
              inet_server_addr()::text as "serverAddr",
              current_database() as "databaseName",
              pg_is_in_recovery() as "inRecovery",
              system_identifier::text as "systemIdentifier"
         from pg_control_system()`,
    );
  } catch {
    throw new GuestPaymentIsolationError("database_not_authorised");
  }
  const facts = rows[0];
  if (!facts) throw new GuestPaymentIsolationError("database_not_authorised");
  let dataDirectory: string | null = null;
  try {
    const directory = await db.query<{ dataDirectory: string }>(
      `select current_setting('data_directory') as "dataDirectory"`,
    );
    dataDirectory = directory[0]?.dataDirectory ?? null;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "42501") throw new GuestPaymentIsolationError("database_not_authorised");
  }
  assertDisposableDatabaseIdentity({ ...facts, dataDirectory });
}

export async function assertBoundPayeeIsTestMode(db: QueryDb, paymentId: string): Promise<void> {
  let rows: { livemode: boolean | null }[];
  try {
    rows = await db.query<{ livemode: boolean | null }>(
      `select c.livemode
         from public.sbg_booking_payments p
         join public.sbg_organisation_stripe_connections c
           on c.organisation_id = p.payee_organisation_id
          and c.stripe_account_id = p.payee_stripe_account_id
          and c.disconnected_at is null
        where p.id = $1::uuid`,
      [paymentId],
    );
  } catch {
    throw new GuestPaymentIsolationError("live_payee_rejected");
  }
  if (rows.length !== 1 || rows[0]?.livemode !== false) {
    throw new GuestPaymentIsolationError("live_payee_rejected");
  }
}

export function assertDistinctGuestWebhookSecret(secret: string, saasSecret: string | undefined): void {
  if (!secret || (saasSecret != null && saasSecret !== "" && secret === saasSecret)) {
    throw new GuestPaymentIsolationError("secret_unavailable");
  }
}

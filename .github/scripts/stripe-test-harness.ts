/**
 * Isolated Stripe TEST payment harness.
 * The execution gate is closed. Reaching this file does not call Stripe.
 * A later commit must change the gate before any Checkout Session can be created.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const STRIPE_TEST_EXECUTION_GATE = "closed";
const CONNECTED_ACCOUNT = "acct_1UKEFuFHnHoOWAJE";
const AMOUNT_MINOR = 4500;
const CLI_VERSION = "1.55.0";
const CLI_SHA256 = "95b028177e12d5e5537a9d62366dce852bd78e104599bdc067268fe68dad1083";
const CLI_ARCHIVE = `stripe_${CLI_VERSION}_linux_x86_64.tar.gz`;
const ADMIN_URL = "postgresql://postgres@127.0.0.1:54329/postgres";
const DATABASE_URL = "postgresql://postgres@127.0.0.1:54329/neondb";
const GATEWAY_URL = "postgresql://aether_payment_gateway@127.0.0.1:54329/neondb";
const APP_URL = "postgresql://aether_app@127.0.0.1:54329/neondb";
const RETURN_ORIGIN = "http://127.0.0.1:9";

class HarnessClosed extends Error {
  constructor() {
    super("stripe_test_execution_closed");
    this.name = "HarnessClosed";
  }
}

export function sanitiseBrowserFailure(): Error {
  return new Error("checkout_browser_failed");
}

function safeCode(err: unknown): string {
  const message = err instanceof Error ? err.message : "";
  return /^[a-z0-9_]+$/.test(message) ? message : "stripe_test_harness_failed";
}

function athensTransferDate(): string {
  const when = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Athens",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(when);
}

async function installStripeCli(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sbg-stripe-cli-"));
  const archive = join(root, CLI_ARCHIVE);
  const response = await fetch(
    `https://github.com/stripe/stripe-cli/releases/download/v${CLI_VERSION}/${CLI_ARCHIVE}`,
  );
  if (!response.ok) throw new Error("stripe_cli_download_failed");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== CLI_SHA256) {
    throw new Error("stripe_cli_checksum_mismatch");
  }
  await writeFile(archive, bytes);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-xzf", archive, "-C", root], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error("stripe_cli_extract_failed"))));
  });
  return join(root, "stripe");
}

async function applyMigrations(query: (sql: string) => Promise<void>): Promise<void> {
  const directory = new URL("../../migrations/", import.meta.url);
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of names) {
    await query(await readFile(new URL(name, directory), "utf8"));
  }
}

type QueryClient = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
};

async function connectAdmin(databaseUrl: string): Promise<QueryClient> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  return client;
}

async function createDisposableBooking(admin: QueryClient): Promise<{ token: string; bookingId: string }> {
  const booking = await import("../../src/lib/aether/booking.ts");
  type BookingDb = Parameters<typeof booking.createBooking>[0];
  const db: BookingDb = {
    query: async <T>(text: string, params?: unknown[]) => (await admin.query(text, params)).rows as T[],
    async transaction<T>(fn: (inner: BookingDb) => Promise<T>) {
      await admin.query("begin");
      const inner: BookingDb = {
        query: async <R>(text: string, params?: unknown[]) => (await admin.query(text, params)).rows as R[],
        transaction() {
          throw new Error("nested");
        },
      };
      try {
        const result = await fn(inner);
        await admin.query("commit");
        return result;
      } catch (err) {
        await admin.query("rollback");
        throw err;
      }
    },
  };
  const hotelOrg = (await admin.query<{ id: string }>(
    `insert into sbg_organisations (name, created_by_user_id, organisation_type)
     values ('SBG TEST Hotel', 'user-sbg-test', 'hotel') returning id`,
  )).rows[0]!.id;
  const hotelId = (await admin.query<{ id: string }>(
    `insert into hotels (code, name, iana_timezone, organisation_id, status, currency)
     values ('sbg-t23', 'SBG TEST Hotel', 'Europe/Athens', $1::uuid, 'live', 'EUR') returning id`,
    [hotelOrg],
  )).rows[0]!.id;
  const providerId = (await admin.query<{ id: string }>(
    `insert into providers (code, name, kind) values ('sbg-t23p', 'SBG TEST Fleet', 'in_house') returning id`,
  )).rows[0]!.id;
  await admin.query(`update providers set reservation_mode = 'capacity' where id = $1::uuid`, [providerId]);
  await admin.query(
    `insert into hotel_provider_agreements (hotel_id, provider_id, active) values ($1::uuid, $2::uuid, true)`,
    [hotelId, providerId],
  );
  const destinationId = (await admin.query<{ id: string }>(
    `insert into hotel_destinations (hotel_id, kind, name, active, amount_minor)
     values ($1::uuid, 'airport', 'Athens Airport', true, $2) returning id`,
    [hotelId, AMOUNT_MINOR],
  )).rows[0]!.id;
  const doorId = (await admin.query<{ id: string }>(
    `insert into sbg_fleet_locations (provider_id, kind, hotel_id, code, name)
     values ($1::uuid, 'hotel', $2::uuid, 'sbg-t23-door', 'Hotel door') returning id`,
    [providerId, hotelId],
  )).rows[0]!.id;
  const airportId = (await admin.query<{ id: string }>(
    `insert into sbg_fleet_locations (provider_id, kind, code, name)
     values ($1::uuid, 'airport', 'sbg-t23-ath', 'Athens Airport') returning id`,
    [providerId],
  )).rows[0]!.id;
  await admin.query(
    `insert into sbg_fleet_routes (provider_id, origin_location_id, destination_location_id, duration_minutes)
     values ($1::uuid, $2::uuid, $3::uuid, 45), ($1::uuid, $3::uuid, $2::uuid, 70)`,
    [providerId, doorId, airportId],
  );
  await admin.query(
    `insert into sbg_fleet_repositions (provider_id, from_location_id, to_location_id, duration_minutes)
     values ($1::uuid, $2::uuid, $3::uuid, 20), ($1::uuid, $3::uuid, $2::uuid, 20)`,
    [providerId, doorId, airportId],
  );
  for (let isodow = 1; isodow <= 7; isodow += 1) {
    await admin.query(
      `insert into sbg_provider_hours (provider_id, isodow, opens_local, closes_local)
       values ($1::uuid, $2, '08:00', '20:00')`,
      [providerId, isodow],
    );
  }
  await admin.query(
    `insert into vehicles (name, capacity, luggage_capacity, active, owned_by_provider_id, operated_by_provider_id)
     values ('SBG TEST Vehicle', 6, 4, true, $1::uuid, $1::uuid)`,
    [providerId],
  );
  await admin.query(
    `insert into sbg_guest_destination_bindings (hotel_destination_id, hotel_id, provider_id, fleet_location_id)
     values ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
    [destinationId, hotelId, providerId, airportId],
  );
  await admin.query(
    `insert into sbg_organisation_billing (organisation_id, status, licensed_quantity, billing_interval)
     values ($1::uuid, 'active', 1, 'month')`,
    [hotelOrg],
  );
  await admin.query(
    `insert into sbg_property_licence_allocations (organisation_id, hotel_id, allocated_by_user_id)
     values ($1::uuid, $2::uuid, 'user-sbg-test')`,
    [hotelOrg, hotelId],
  );
  await admin.query(
    `insert into sbg_organisation_stripe_connections (organisation_id, stripe_account_id, livemode)
     values ($1::uuid, $2, false)`,
    [hotelOrg, CONNECTED_ACCOUNT],
  );
  const created = await booking.createBooking(db, {
    hotelCode: "sbg-t23",
    destinationId,
    transferDate: athensTransferDate(),
    pickupTime: "10:00",
    durationMinutes: 45,
    guestName: "Ada Guest",
    guestPhone: "+302100000000",
    guestEmail: "ada@example.com",
    passengerCount: 1,
    luggageCount: 0,
    pickupText: "Hotel door",
    direction: "from_hotel",
  });
  const stored = await admin.query<{ id: string }>(
    `select id from bookings where confirmation_token = $1`,
    [created.confirmationToken],
  );
  return { token: created.confirmationToken, bookingId: stored.rows[0]!.id };
}

type BrowserPage = {
  goto(url: string, options: { timeout: number; waitUntil: "domcontentloaded" }): Promise<unknown>;
  locator(selector: string): { count(): Promise<number> };
  frameLocator(selector: string): { locator(selector: string): { fill(value: string, options: { timeout: number }): Promise<void> } };
  getByRole(role: "button", options: { name: RegExp }): { click(options: { timeout: number }): Promise<void> };
  on?(event: "console" | "request" | "response", listener: () => void): void;
  waitForURL(predicate: (url: URL) => boolean, options: { timeout: number }): Promise<void>;
};

async function assertNoChallenge(page: BrowserPage): Promise<void> {
  const challenges = await page.locator(
    'iframe[src*="hcaptcha"], iframe[src*="3ds"], iframe[title*="3D Secure" i], iframe[title*="captcha" i]',
  ).count();
  if (challenges > 0) throw new Error("checkout_challenge");
}

async function completeHostedCheckout(checkoutUrl: string): Promise<void> {
  process.env.DEBUG = "";
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage() as BrowserPage;
    page.on?.("console", () => undefined);
    page.on?.("request", () => undefined);
    page.on?.("response", () => undefined);
    try {
      await page.goto(checkoutUrl, { timeout: 30_000, waitUntil: "domcontentloaded" });
      await assertNoChallenge(page);
      const card = page.frameLocator('iframe[title*="card number" i]').locator("input");
      const expiry = page.frameLocator('iframe[title*="expir" i]').locator("input");
      const cvc = page.frameLocator('iframe[title*="CVC" i]').locator("input");
      await card.fill("4242424242424242", { timeout: 20_000 });
      await expiry.fill("1234", { timeout: 20_000 });
      await cvc.fill("123", { timeout: 20_000 });
      await assertNoChallenge(page);
      await page.getByRole("button", { name: /pay/i }).click({ timeout: 20_000 });
      await page.waitForURL((url) => url.hostname !== "checkout.stripe.com", { timeout: 60_000 });
    } catch (err) {
      if (err instanceof Error && err.message === "checkout_challenge") throw err;
      throw sanitiseBrowserFailure();
    }
  } finally {
    await browser.close();
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function forwardConnectEvents(input: {
  stripeBin: string;
  listenerPort: number;
  secretReady: (secret: string) => void;
}): Promise<{ ready: Promise<void>; assertAlive: () => void; stop: () => Promise<void> }> {
  const child = spawn(
    input.stripeBin,
    ["listen", "--forward-connect-to", `http://127.0.0.1:${input.listenerPort}`, "--events", "checkout.session.completed"],
    {
      env: { ...process.env, STRIPE_API_KEY: process.env.STRIPE_SECRET_KEY },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let secret = "";
  let readySeen = false;
  let announced = false;
  let pending = "";
  let rejectReady: (err: Error) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    rejectReady = reject;
    const watch = (chunk: Buffer) => {
      pending = (pending + chunk.toString("utf8")).slice(-8000);
      const match = pending.match(/whsec_[A-Za-z0-9]+/);
      if (match) secret = match[0];
      if (pending.includes("Ready!")) readySeen = true;
      if (!announced && secret && readySeen) {
        announced = true;
        pending = "";
        input.secretReady(secret);
        resolve();
      }
    };
    child.stdout?.on("data", watch);
    child.stderr?.on("data", watch);
    child.once("exit", () => {
      if (!announced) reject(new Error("stripe_cli_exited"));
    });
    child.once("error", () => {
      if (!announced) reject(new Error("stripe_cli_exited"));
    });
  });
  const assertAlive = () => {
    if (child.exitCode != null || child.signalCode != null) throw new Error("stripe_cli_exited");
  };
  const stop = async () => {
    if (child.exitCode != null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };
  return { ready: ready.catch((err) => { rejectReady(err); throw err; }), assertAlive, stop };
}

function assertPaidConnectEvent(event: {
  type?: string;
  account?: string;
  livemode?: boolean;
  data?: { object?: { object?: string; mode?: string; amount_total?: number; currency?: string; payment_status?: string; livemode?: boolean } };
}): void {
  const session = event.data?.object;
  if (
    event.type !== "checkout.session.completed"
    || event.account !== CONNECTED_ACCOUNT
    || event.livemode !== false
    || session?.object !== "checkout.session"
    || session.mode !== "payment"
    || session.livemode !== false
    || session.amount_total !== AMOUNT_MINOR
    || session.currency !== "eur"
    || session.payment_status !== "paid"
  ) {
    throw new Error("webhook_event_rejected");
  }
}

type ClusterIdentityFact = {
  dataDirectory: string;
  listenAddresses: string;
  port: string;
  serverAddr: string | null;
  inRecovery: boolean;
  systemIdentifier: string;
};

export function firstQueryRow<T>(result: { rows?: T[] } | null | undefined): T | undefined {
  return Array.isArray(result?.rows) ? result.rows[0] : undefined;
}

export function identityIsAuthorised(
  fact: ClusterIdentityFact | undefined,
  controlId: bigint,
  expected: { dataDirectory: string; listenAddresses: string },
): boolean {
  if (!fact) return false;
  let sessionId: bigint;
  try {
    sessionId = BigInt(fact.systemIdentifier);
  } catch {
    return false;
  }
  const loopback = fact.serverAddr === "127.0.0.1" || fact.serverAddr === "127.0.0.1/32";
  return loopback
    && sessionId === controlId
    && fact.dataDirectory === expected.dataDirectory
    && fact.listenAddresses === expected.listenAddresses
    && fact.port === "54329"
    && fact.inRecovery === false;
}

async function assertAuthorisedAdminSession(root: QueryClient): Promise<void> {
  const {
    AUTHORISED_DISPOSABLE_DATA_DIRECTORY,
    AUTHORISED_DISPOSABLE_LISTEN,
    readAuthorisedClusterSystemIdentifier,
  } = await import("../../src/lib/aether/guest-payment-test-isolation.ts");
  let fact: ClusterIdentityFact | undefined;
  try {
    const result = await root.query<ClusterIdentityFact>(
      `select current_setting('data_directory') as "dataDirectory",
              current_setting('listen_addresses') as "listenAddresses",
              current_setting('port') as "port",
              inet_server_addr()::text as "serverAddr",
              pg_is_in_recovery() as "inRecovery",
              system_identifier::text as "systemIdentifier"
         from pg_control_system()`,
    );
    fact = firstQueryRow(result);
  } catch {
    throw new Error("database_not_authorised");
  }
  if (!identityIsAuthorised(fact, readAuthorisedClusterSystemIdentifier(), {
    dataDirectory: AUTHORISED_DISPOSABLE_DATA_DIRECTORY,
    listenAddresses: AUTHORISED_DISPOSABLE_LISTEN,
  })) {
    throw new Error("database_not_authorised");
  }
}

async function resetAuthorisedDisposableDatabase(): Promise<{ root: QueryClient; database: QueryClient }> {
  const admin = new URL(ADMIN_URL);
  if (admin.protocol !== "postgresql:" || admin.hostname !== "127.0.0.1" || admin.port !== "54329" || admin.pathname !== "/postgres") {
    throw new Error("database_not_authorised");
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn("sh", [".github/scripts/bootstrap-disposable-postgres.sh", "identify"], { stdio: "inherit" });
    child.once("error", () => reject(new Error("database_not_authorised")));
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error("database_not_authorised"))));
  });
  const root = await connectAdmin(ADMIN_URL);
  try {
    await assertAuthorisedAdminSession(root);
    await root.query("drop database if exists neondb");
    await root.query("create database neondb");
    const database = await connectAdmin(DATABASE_URL);
    try {
      const { assertConnectedDisposableDatabase } = await import("../../src/lib/aether/guest-payment-test-isolation.ts");
      await assertConnectedDisposableDatabase({
        query: async <T>(text: string, params?: unknown[]) => (await database.query(text, params)).rows as T[],
      });
      return { root, database };
    } catch (err) {
      await database.end().catch(() => undefined);
      throw err;
    }
  } catch (err) {
    await root.end().catch(() => undefined);
    throw err;
  }
}

async function runAuthorisedHarness(): Promise<void> {
  const { assertGuestPaymentTestProcess } = await import("../../src/lib/aether/guest-payment-test-isolation.ts");
  assertGuestPaymentTestProcess(process.env);
  if (process.env.STRIPE_WEBHOOK_SECRET) throw new Error("saas_webhook_secret_present");
  const opened = await resetAuthorisedDisposableDatabase();
  const root = opened.root;
  const database = opened.database;
  let directory = "";
  try {
    try {
      await applyMigrations((sql) => database.query(sql).then(() => undefined));
      await database.query(
        `insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt")
         values ('user-sbg-test','SBG Test','sbg-test@example.com',true,now(),now())`,
      );
      const fixture = await createDisposableBooking(database);
      const stripeBin = await installStripeCli();
      directory = join(stripeBin, "..");
      const { startLocalGuestPaymentTestListener } = await import("../../src/lib/aether/guest-payment-test-listener.ts");
      let listener: Awaited<ReturnType<typeof startLocalGuestPaymentTestListener>> | null = null;
      let captured: { raw: string; signature: string } | null = null;
      let failure = "";
      const proxy = createServer(async (req, res) => {
        const raw = await readBody(req);
        const signature = req.headers["stripe-signature"]?.toString() ?? "";
        if (!listener) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ received: false, outcome: "listener_not_ready" }));
          return;
        }
        const forwarded = await fetch(`http://127.0.0.1:${listener.port}/`, {
          method: "POST",
          headers: { "content-type": "application/json", "stripe-signature": signature },
          body: raw,
        });
        const responseText = await forwarded.text();
        let outcome = "";
        try {
          outcome = String((JSON.parse(responseText) as { outcome?: string }).outcome ?? "");
        } catch {
          outcome = "";
        }
        if (forwarded.ok && outcome === "confirmed_paid" && !captured) {
          try {
            assertPaidConnectEvent(JSON.parse(raw) as Parameters<typeof assertPaidConnectEvent>[0]);
            captured = { raw, signature };
          } catch (err) {
            failure = err instanceof Error && err.message === "webhook_event_rejected" ? err.message : "webhook_event_rejected";
          }
        }
        res.writeHead(forwarded.status, { "content-type": "application/json" });
        res.end(responseText);
      });
      await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
      const proxyAddress = proxy.address();
      if (!proxyAddress || typeof proxyAddress === "string") throw new Error("proxy_not_local");
      let webhookSecret = "";
      const forwarding = await forwardConnectEvents({
        stripeBin,
        listenerPort: proxyAddress.port,
        secretReady: (secret) => {
          webhookSecret = secret;
        },
      });
      try {
        await Promise.race([
          forwarding.ready,
          new Promise((_, reject) => setTimeout(() => reject(new Error("webhook_secret_timeout")), 20_000)),
        ]);
        forwarding.assertAlive();
        if (!webhookSecret) throw new Error("webhook_secret_timeout");
        listener = await startLocalGuestPaymentTestListener({
          connectionString: GATEWAY_URL,
          webhookSecret,
          env: process.env,
        });
        const { startGuestPaymentForBooking } = await import("../../src/lib/aether/guest-payment-fns.ts");
        const app = await connectAdmin(APP_URL);
        let payment: { url: string; accountId: string };
        try {
          const who = await app.query<{ current_user: string }>("select current_user");
          if (who.rows[0]?.current_user !== "aether_app") throw new Error("role_not_authorised");
          const db = {
            query: async <T>(text: string, params?: unknown[]) => (await app.query(text, params)).rows as T[],
          };
          payment = await startGuestPaymentForBooking(db, fixture.token, RETURN_ORIGIN, process.env);
        } finally {
          await app.end();
        }
        if (payment.accountId !== CONNECTED_ACCOUNT) throw new Error("unexpected_payee");
        const session = await database.query<{
          session_id: string;
          account_id: string;
          amount_minor: number;
          currency: string;
        }>(
          `select p.stripe_checkout_session_id as session_id,
                  p.payee_stripe_account_id as account_id,
                  p.amount_minor,
                  p.currency
             from sbg_booking_payments p
            where p.booking_id = $1::uuid`,
          [fixture.bookingId],
        );
        const row = session.rows[0];
        if (!row || row.account_id !== CONNECTED_ACCOUNT || row.amount_minor !== AMOUNT_MINOR || row.currency !== "EUR") {
          throw new Error("checkout_authority_mismatch");
        }
        const retrieved = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(row.session_id)}`, {
          headers: {
            Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
            "Stripe-Account": CONNECTED_ACCOUNT,
          },
        });
        const body = await retrieved.json() as { livemode?: boolean; amount_total?: number; currency?: string };
        if (!retrieved.ok || body.livemode !== false || body.amount_total !== AMOUNT_MINOR || body.currency !== "eur") {
          throw new Error("checkout_not_test_mode");
        }
        await completeHostedCheckout(payment.url);
        forwarding.assertAlive();
        const confirmed = await waitForBooking(database, fixture.bookingId, forwarding.assertAlive);
        if (failure) throw new Error(failure);
        if (!captured) throw new Error("webhook_not_captured");
        assertPaidConnectEvent(JSON.parse(captured.raw) as Parameters<typeof assertPaidConnectEvent>[0]);
        const replay = await fetch(`http://127.0.0.1:${listener.port}/`, {
          method: "POST",
          headers: { "content-type": "application/json", "stripe-signature": captured.signature },
          body: captured.raw,
        });
        const replayBody = await replay.json() as { outcome?: string };
        if (replayBody.outcome !== "duplicate") throw new Error("replay_not_duplicate");
        const afterReplay = await waitForBooking(database, fixture.bookingId, forwarding.assertAlive);
        if (afterReplay.paid_count !== 1) throw new Error("replay_not_duplicate");
        console.log(JSON.stringify({
          connectedAccount: CONNECTED_ACCOUNT,
          livemode: false,
          amountMinor: afterReplay.amount_minor,
          currency: afterReplay.currency,
          bookingState: afterReplay.lifecycle_state,
          confirmations: afterReplay.paid_count,
          vehicleAssigned: afterReplay.vehicle_id != null,
          replay: "duplicate",
          eventType: "checkout.session.completed",
          eventMode: "payment",
          subscriptionCheckout: false,
          saasWebhook: false,
        }));
      } finally {
        proxy.close();
        await listener?.close();
        await forwarding.stop();
      }
    } finally {
      await database.end();
    }
  } finally {
    await root.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

async function waitForBooking(
  database: QueryClient,
  bookingId: string,
  assertAlive: () => void,
): Promise<{
  lifecycle_state: string;
  vehicle_id: string | null;
  amount_minor: number;
  currency: string;
  paid_count: number;
}> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    assertAlive();
    const rows = await database.query<{
      lifecycle_state: string;
      vehicle_id: string | null;
      amount_minor: number;
      currency: string;
      paid_count: number;
    }>(
      `select b.lifecycle_state,
              b.vehicle_id::text,
              p.amount_minor,
              p.currency,
              (select count(*)::int from sbg_booking_payments paid
                where paid.booking_id = b.id and paid.status = 'paid') as paid_count
         from bookings b
         join sbg_booking_payments p on p.booking_id = b.id
        where b.id = $1::uuid`,
      [bookingId],
    );
    const row = rows.rows[0];
    if (
      row?.lifecycle_state === "confirmed_paid"
      && row.paid_count === 1
      && row.vehicle_id
      && row.amount_minor === AMOUNT_MINOR
      && row.currency === "EUR"
    ) return row;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("payment_not_confirmed");
}

async function verifyDisposableFixture(): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (target.includes("stripe.com") || target.includes("playwright")) {
      throw new Error("stripe_call_forbidden");
    }
    return originalFetch(input, init);
  };
  let root: QueryClient | null = null;
  let database: QueryClient | null = null;
  try {
  try {
    try {
      const opened = await resetAuthorisedDisposableDatabase();
      root = opened.root;
      database = opened.database;
      await applyMigrations((sql) => database.query(sql).then(() => undefined));
      await database.query(
        `insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt")
         values ('user-sbg-test','SBG Test','sbg-test@example.com',true,now(),now())`,
      );
      const fixture = await createDisposableBooking(database);
      const held = await database.query<{ assigned: boolean; hold_open: boolean; amount_minor: number; lifecycle_state: string }>(
        `select b.vehicle_id is not null as assigned,
                b.hold_expires_at > clock_timestamp() as hold_open,
                d.amount_minor,
                b.lifecycle_state
           from bookings b
           join hotel_destinations d on d.id = b.destination_id
          where b.id = $1::uuid`,
        [fixture.bookingId],
      );
      const booking = held.rows[0];
      if (!booking?.assigned || booking.hold_open !== true || Number(booking.amount_minor) !== AMOUNT_MINOR) {
        throw new Error("fixture_not_payable");
      }
      const app = await connectAdmin(APP_URL);
      try {
        const who = await app.query<{ current_user: string }>("select current_user");
        if (who.rows[0]?.current_user !== "aether_app") throw new Error("role_not_authorised");
        const prepared = await app.query<{ payment_id: string; amount_minor: number; currency: string }>(
          `select payment_id, amount_minor, currency from public.sbg_prepare_capacity_guest_payment($1)`,
          [fixture.token],
        );
        const payment = prepared.rows[0];
        if (!payment || Number(payment.amount_minor) !== AMOUNT_MINOR || payment.currency !== "EUR") {
          throw new Error("fixture_not_payable");
        }
        const bound = await app.query<{ bound_stripe_account_id: string }>(
          `select bound_stripe_account_id from public.sbg_bind_payment_authority($1::uuid)`,
          [fixture.bookingId],
        );
        if (bound.rows[0]?.bound_stripe_account_id !== CONNECTED_ACCOUNT) throw new Error("unexpected_payee");
        const testMode = await app.query<{ test_mode: boolean }>(
          `select public.sbg_bound_payee_is_test_mode($1::uuid) as test_mode`,
          [payment.payment_id],
        );
        if (testMode.rows[0]?.test_mode !== true) throw new Error("live_payee_rejected");
        const hidden = await app.query<{ denied: boolean }>(
          `select has_table_privilege('aether_app', 'public.sbg_organisation_stripe_connections', 'select') as denied`,
        );
        if (hidden.rows[0]?.denied !== false) throw new Error("connection_table_readable");
      } finally {
        await app.end();
      }
      console.log(JSON.stringify({
        fixture: "payable",
        amountMinor: AMOUNT_MINOR,
        currency: "EUR",
        connectedAccount: CONNECTED_ACCOUNT,
        vehicleAssigned: true,
        checkoutCreated: false,
      }));
    } finally {
      await database?.end();
    }
  } finally {
    await root?.end();
  }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === "fixture-check") {
    await verifyDisposableFixture();
    return;
  }
  if (STRIPE_TEST_EXECUTION_GATE !== "open") throw new HarnessClosed();
  await runAuthorisedHarness();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(safeCode(err));
    process.exit(err instanceof HarnessClosed ? 2 : 1);
  });
}

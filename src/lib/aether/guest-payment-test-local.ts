/**
 * Local-only connections for the disposable Stripe TEST cluster.
 * Callers must already be the restricted role. This module does not set a
 * password, grant a privilege, or schedule work.
 */
import pg from "pg";
import {
  assertConnectedDisposableDatabase,
  AUTHORISED_DISPOSABLE_DATABASE,
  GuestPaymentIsolationError,
} from "./guest-payment-test-isolation.ts";

export type DisposableRole = "aether_payment_gateway" | "aether_expiry_runner";

export async function connectDisposableRole(connectionString: string, role: DisposableRole): Promise<pg.Client> {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new GuestPaymentIsolationError("database_not_authorised");
  }
  if ((url.protocol !== "postgresql:" && url.protocol !== "postgres:") || url.hostname !== "127.0.0.1") {
    throw new GuestPaymentIsolationError("database_not_authorised");
  }
  if (url.username !== role || url.password !== "") {
    throw new GuestPaymentIsolationError(url.password !== "" ? "password_not_permitted" : "role_not_authorised");
  }
  if (url.pathname !== `/${AUTHORISED_DISPOSABLE_DATABASE}` || !/^\d+$/.test(url.port)) {
    throw new GuestPaymentIsolationError("database_not_authorised");
  }
  const client = new pg.Client({
    host: "127.0.0.1",
    port: Number(url.port),
    user: role,
    database: AUTHORISED_DISPOSABLE_DATABASE,
  });
  await client.connect();
  try {
    const who = await client.query<{ current_user: string; session_user: string }>(
      "select current_user, session_user",
    );
    const row = who.rows[0];
    if (row?.current_user !== role || row.session_user !== role) {
      throw new GuestPaymentIsolationError("role_not_authorised");
    }
    await assertConnectedDisposableDatabase({
      query: async <T>(text: string, params?: unknown[]) => (await client.query(text, params)).rows as T[],
    });
    return client;
  } catch (err) {
    await client.end().catch(() => undefined);
    throw err;
  }
}

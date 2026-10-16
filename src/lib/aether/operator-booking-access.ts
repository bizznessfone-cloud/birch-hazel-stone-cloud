/** Operator booking-access boundary, not a guest booking or payment capability.
 * A property grant is necessary but never sufficient for booking access.
 * Until a separately reviewed operator-scoped booking query exists, deny.
 */
import type { Sql } from "@/lib/db";
import { readOperatorPropertyAccess } from "./operator-property-grant-read.ts";

export type OperatorBookingAccess =
  | { allowed: true }
  | { allowed: false; reason: "unauthorized" | "not_granted" | "booking_scope_unavailable" };

export async function authoriseOperatorBookingAccess(input: {
  db: Pick<Sql, "query">;
  sessionUserId: string | null | undefined;
  hotelId: string | null | undefined;
}): Promise<OperatorBookingAccess> {
  const property = await readOperatorPropertyAccess(input);
  if (!property.allowed) return property;
  // Do not route operator users through hotel-owner booking endpoints.
  // A future SQL query must separately enforce booking scope, status,
  // provider assignment and permitted fields without leaking guest PII.
  return { allowed: false, reason: "booking_scope_unavailable" };
}

/** Gate 2: session-bound operator grant lookup.
 * The caller must derive sessionUserId from the authenticated server session.
 * This read-only function never issues grants or confers hotel ownership.
 */
import type { Sql } from "@/lib/db";

export type OperatorPropertyAccessDecision =
  | { allowed: true }
  | { allowed: false; reason: "unauthorized" | "not_granted" };

export async function readOperatorPropertyAccess(input: {
  db: Pick<Sql, "query">;
  sessionUserId: string | null | undefined;
  hotelId: string | null | undefined;
}): Promise<OperatorPropertyAccessDecision> {
  if (!input.sessionUserId?.trim()) return { allowed: false, reason: "unauthorized" };
  if (!input.hotelId?.trim()) return { allowed: false, reason: "not_granted" };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.hotelId)) {
    return { allowed: false, reason: "not_granted" };
  }
  try {
    const rows = await input.db.query<{ allowed: boolean }>(
      "select public.sbg_operator_can_access_property_for_user($1, $2::uuid) as allowed",
      [input.sessionUserId, input.hotelId],
    );
    return rows.length === 1 && rows[0]?.allowed === true
      ? { allowed: true }
      : { allowed: false, reason: "not_granted" };
  } catch {
    // Missing migration, DB errors and ambiguous authority must never allow.
    return { allowed: false, reason: "not_granted" };
  }
}

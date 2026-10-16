/** Gate 2: server-side grant read. Caller identity must come from an
 * authenticated session, never from a client-supplied organisation ID.
 * Database access is deliberately unavailable until a reviewed SQL function
 * is added and granted to the application role.
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
  // Until the session-bound SQL authorisation function exists, fail closed.
  // Do not infer a grant from an operator classification, hotel code,
  // organisation membership, or any user-provided operator organisation ID.
  return { allowed: false, reason: "not_granted" };
}

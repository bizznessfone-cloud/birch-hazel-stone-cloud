/**
 * CP26C-O2 — platform Owner authorization.
 * Fail-closed grant against sbg_platform_owners. Not hotel ownership, not Ops,
 * not email comparison. Runtime SELECT only; missing table → not Owner.
 */

import type { Sql } from "@/lib/db";

export class PlatformOwnerForbiddenError extends Error {
  readonly status = 403;
  constructor(message = "Owner access required") {
    super(message);
    this.name = "PlatformOwnerForbiddenError";
  }
}

export type OwnerGateDecision =
  | { ok: true }
  | { ok: false; reason: "unauthenticated" | "forbidden" };

export function decideOwnerGate(input: {
  hasSession: boolean;
  hasGrant: boolean;
}): OwnerGateDecision {
  if (!input.hasSession) return { ok: false, reason: "unauthenticated" };
  if (!input.hasGrant) return { ok: false, reason: "forbidden" };
  return { ok: true };
}

function isMissingOwnerGrantRelation(err: unknown): boolean {
  const code =
    typeof err === "object" && err && "code" in err
      ? String((err as { code?: unknown }).code ?? "")
      : "";
  if (code === "42P01") return true;
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /sbg_platform_owners/i.test(message) && /does not exist|undefined.table|42P01/i.test(message);
}

export async function isPlatformOwner(db: Sql, userId: string): Promise<boolean> {
  const id = String(userId ?? "").trim();
  if (!id) return false;
  try {
    const rows = await db.query<{ user_id: string }>(
      `select user_id
         from sbg_platform_owners
        where user_id = $1
          and revoked_at is null
        limit 1`,
      [id],
    );
    return Boolean(rows[0]);
  } catch (err) {
    if (isMissingOwnerGrantRelation(err)) return false;
    throw err;
  }
}

export async function requirePlatformOwner(db: Sql, userId: string): Promise<void> {
  if (await isPlatformOwner(db, userId)) return;
  throw new PlatformOwnerForbiddenError();
}

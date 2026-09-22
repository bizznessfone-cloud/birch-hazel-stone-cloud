/**
 * /owner parent access probe. Unauthenticated → login redirect.
 * Session without a platform Owner grant → 403 (not an /app redirect).
 */
import { createMiddleware, createServerFn } from "@tanstack/react-start";
import { decideOwnerGate } from "@/lib/aether/owner-auth";

export type OwnerAccessDecision =
  | { ok: true; userId: string }
  | { ok: false; reason: "unauthenticated" | "forbidden" };

const optionalSessionMiddleware = createMiddleware({ type: "function" })
  .client(async ({ next }) => {
    const { getBearerToken } = await import("./client");
    return next({ sendContext: { bearerToken: getBearerToken() ?? undefined } });
  })
  .server(async ({ next, context }) => next({ context }));

export const getOwnerAccess = createServerFn({ method: "GET" })
  .middleware([optionalSessionMiddleware])
  .handler(async ({ context }): Promise<OwnerAccessDecision> => {
    const { authConfigured, getSessionUser } = await import("./verify.server");
    const { gateIdentityEnabled } = await import("./gate-identity.server");
    const { isPlatformOwner } = await import("@/lib/aether/owner-auth");
    const { getSql } = await import("@/lib/db");
    const bearerToken =
      typeof context === "object" && context && "bearerToken" in context
        ? (context as { bearerToken?: string }).bearerToken
        : undefined;
    const authEnabled = authConfigured || gateIdentityEnabled();
    const databaseConfigured = Boolean(process.env.DATABASE_URL?.trim());
    if (!authEnabled) {
      if (!databaseConfigured) return { ok: false, reason: "forbidden" };
      return { ok: false, reason: "unauthenticated" };
    }
    const user = await getSessionUser(bearerToken);
    if (!user) return { ok: false, reason: "unauthenticated" };
    let granted = false;
    try {
      const db = await getSql();
      granted = await isPlatformOwner(db, user.id);
    } catch {
      granted = false;
    }
    const gate = decideOwnerGate({ hasSession: true, hasGrant: granted });
    if (!gate.ok) return { ok: false, reason: gate.reason };
    return { ok: true, userId: user.id };
  });

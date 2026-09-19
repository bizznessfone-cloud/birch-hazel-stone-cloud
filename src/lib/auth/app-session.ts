/**
 * SaaS /app/* session probe. Never throws UnauthorizedError — route beforeLoad
 * converts a negative result into a login redirect so child loaders do not run.
 */
import { createMiddleware, createServerFn } from "@tanstack/react-start";

export type AppSessionDecision =
  | { ok: true; mode: "session" | "dev" }
  | { ok: false; mode: "unauthenticated" };

/**
 * Pure access decision for the /app parent boundary.
 * Auth-off without a database uses the local dev user. Auth-on requires a session.
 */
export function decideAppAccess(input: {
  authEnabled: boolean;
  databaseConfigured: boolean;
  hasSession: boolean;
}): AppSessionDecision {
  if (!input.authEnabled) {
    if (input.databaseConfigured) return { ok: false, mode: "unauthenticated" };
    return { ok: true, mode: "dev" };
  }
  if (!input.hasSession) return { ok: false, mode: "unauthenticated" };
  return { ok: true, mode: "session" };
}

const optionalSessionMiddleware = createMiddleware({ type: "function" })
  .client(async ({ next }) => {
    const { getBearerToken } = await import("./client");
    return next({ sendContext: { bearerToken: getBearerToken() ?? undefined } });
  })
  .server(async ({ next, context }) => next({ context }));

export const getAppSession = createServerFn({ method: "GET" })
  .middleware([optionalSessionMiddleware])
  .handler(async ({ context }): Promise<AppSessionDecision> => {
    const { authConfigured, getSessionUser } = await import("./verify.server");
    const { gateIdentityEnabled } = await import("./gate-identity.server");
    const bearerToken =
      typeof context === "object" && context && "bearerToken" in context
        ? (context as { bearerToken?: string }).bearerToken
        : undefined;
    const authEnabled = authConfigured || gateIdentityEnabled();
    const databaseConfigured = Boolean(process.env.DATABASE_URL?.trim());
    if (!authEnabled) {
      return decideAppAccess({
        authEnabled: false,
        databaseConfigured,
        hasSession: false,
      });
    }
    const user = await getSessionUser(bearerToken);
    return decideAppAccess({
      authEnabled: true,
      databaseConfigured,
      hasSession: Boolean(user),
    });
  });

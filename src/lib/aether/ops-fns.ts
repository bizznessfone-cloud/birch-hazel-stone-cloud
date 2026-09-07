/**
 * Operator auth server functions. Public guest routes must not import
 * requireOps. The session token is never returned in the JSON body.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

function fail(err: unknown): { ok: false; code: string; message: string } {
  if (err && typeof err === "object" && (err as { name?: string }).name === "OpsAuthError") {
    const code = String((err as { code: string }).code);
    const message =
      code === "invalid_credentials"
        ? "Invalid credentials."
        : code === "throttled"
          ? "Too many attempts. Try again later."
          : code === "csrf"
            ? "This request could not be verified."
            : "Please sign in.";
    return { ok: false, code, message };
  }
  return { ok: false, code: "server_error", message: "Something went wrong. Please try again." };
}

const loginInput = z.object({
  login: z.string().min(1),
  password: z.string().min(1),
});

export const opsLogin = createServerFn({ method: "POST" })
  .validator(loginInput)
  .handler(async ({ data }) => {
    try {
      const { loginOperatorFromRequest } = await import("./ops-auth.server");
      const result = await loginOperatorFromRequest(data.login, data.password);
      return { ok: true as const, login: result.login };
    } catch (err) {
      return fail(err);
    }
  });

export const opsLogout = createServerFn({ method: "POST" }).handler(async () => {
  try {
    const { logoutOperatorFromRequest } = await import("./ops-auth.server");
    await logoutOperatorFromRequest();
    return { ok: true as const };
  } catch (err) {
    return fail(err);
  }
});

/** Protected mutation used to prove the Phase 2 requireOps boundary. */
export const opsProtectedPing = createServerFn({ method: "POST" }).handler(
  async () => {
    try {
      const { requireOps } = await import("./ops-auth.server");
      const ops = await requireOps({ csrf: true });
      return { ok: true as const, login: ops.login };
    } catch (err) {
      return fail(err);
    }
  },
);

export const opsWhoAmI = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const { requireOps } = await import("./ops-auth.server");
    const ops = await requireOps({ csrf: false });
    return { ok: true as const, login: ops.login };
  } catch (err) {
    return fail(err);
  }
});

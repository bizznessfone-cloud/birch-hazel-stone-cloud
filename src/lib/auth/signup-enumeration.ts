/**
 * CP27.3b — signup enumeration boundary.
 * CP30.05E-2B — session is not created here.
 * Better Auth 1.6.30 returns 422 USER_ALREADY_EXISTS unless autoSignIn is
 * false (or email verification is required). Verification stays off.
 * autoSignIn false makes both paths 200 with token null and no session.
 * Turning autoSignIn on would also skip that generic response, so it stays
 * false. /login calls email sign-in after this response.
 * The synthetic user still includes image:null while a new user omits it,
 * so this hook rewrites only that success body to one key set.
 * Malformed, origin, CSRF, and rate-limit errors are not rewritten.
 */
import { createAuthMiddleware } from "better-auth/api";

export const emailAndPasswordAuthOptions = {
  enabled: true,
  autoSignIn: false,
} as const;

type SignUpUser = Record<string, unknown>;

export type SignUpSuccessBody = {
  token: null;
  user: {
    name: string;
    email: string;
    emailVerified: false;
    image: null;
    createdAt: string;
    updatedAt: string;
    id: string;
  };
};

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return "";
}

export function isSignUpSuccessBody(value: unknown): value is { token: unknown; user: SignUpUser } {
  if (!value || typeof value !== "object" || value instanceof Error) return false;
  const body = value as { token?: unknown; user?: unknown };
  if (!("token" in body) || !body.user || typeof body.user !== "object") return false;
  return typeof (body.user as SignUpUser).email === "string";
}

/** One public signup contract. No session token. No stored-account fields. */
export function canonicalSignUpSuccessBody(body: { user: SignUpUser }): SignUpSuccessBody {
  const user = body.user;
  return {
    token: null,
    user: {
      name: text(user.name),
      email: text(user.email),
      emailVerified: false,
      image: null,
      createdAt: text(user.createdAt),
      updatedAt: text(user.updatedAt),
      id: text(user.id),
    },
  };
}

export const signUpEnumerationAfterHook = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== "/sign-up/email") return;
  const returned = ctx.context.returned;
  if (!isSignUpSuccessBody(returned)) return;
  // createAuthMiddleware already places this return value on `response`.
  // Wrapping it again leaks `{ response: ... }` on the wire.
  return canonicalSignUpSuccessBody(returned);
});

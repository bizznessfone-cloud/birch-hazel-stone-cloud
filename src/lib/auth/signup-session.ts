/**
 * CP30.05E-2B — signup then session.
 *
 * Better Auth 1.6.30 creates a session on email signup only when autoSignIn
 * is not false. That same flag is what turns an existing email into
 * 422 USER_ALREADY_EXISTS. The generic duplicate response and a signup
 * session cookie cannot be enabled together.
 *
 * The signup endpoint therefore stays autoSignIn false: both a new email and
 * an existing email return 200, token null, and no cookie. /login then calls
 * the normal email sign-in with the password just submitted. A new account
 * signs in. An existing email signs in only when that password is already
 * the account password. Neither step creates an organisation, membership,
 * or hotel.
 */

export const PUBLIC_AUTH_ERRORS = {
  signupRejected: "Account could not be created. Check the details and try again.",
  sessionNotStarted: "We could not start a session. Sign in with your email and password.",
  signInRejected: "Email or password is not valid.",
} as const;

export type PublicAuthError = (typeof PUBLIC_AUTH_ERRORS)[keyof typeof PUBLIC_AUTH_ERRORS];

export type SignupSessionResult = { ok: true } | { ok: false; message: PublicAuthError };

type AuthCall = { error?: unknown };

export async function establishSignupSession(input: {
  signUp: () => Promise<AuthCall>;
  signIn: () => Promise<AuthCall>;
}): Promise<SignupSessionResult> {
  let created: AuthCall;
  try {
    created = await input.signUp();
  } catch {
    return { ok: false, message: PUBLIC_AUTH_ERRORS.signupRejected };
  }
  if (created.error) return { ok: false, message: PUBLIC_AUTH_ERRORS.signupRejected };

  let signedIn: AuthCall;
  try {
    signedIn = await input.signIn();
  } catch {
    return { ok: false, message: PUBLIC_AUTH_ERRORS.sessionNotStarted };
  }
  if (signedIn.error) return { ok: false, message: PUBLIC_AUTH_ERRORS.sessionNotStarted };
  return { ok: true };
}

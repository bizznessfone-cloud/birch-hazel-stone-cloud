/**
 * CP30.05E-2B — password recovery is not enabled.
 *
 * Better Auth 1.6.30 exposes the lifecycle only when
 * emailAndPassword.sendResetPassword is set:
 * POST /request-password-reset stores `reset-password:{token}` for a known
 * user (default expiry 3600s) and returns the same body for an unknown email.
 * GET /reset-password/:token redirects with the token or error=INVALID_TOKEN.
 * POST /reset-password consumes the token. revokeSessionsOnPasswordReset
 * deletes sessions when set.
 *
 * The success body says to check email. Production Resend is not configured.
 * A callback that cannot send would still produce that body. That is a fake
 * delivery success, so the callback is not registered and the route stays
 * RESET_PASSWORD_DISABLED.
 *
 * PASSWORD RECOVERY DELIVERY — BLOCKED ON EMAIL TRANSPORT.
 * Complete delivery before public self-service. Do not log or render tokens.
 */

export const PASSWORD_RECOVERY_DELIVERY = "blocked_on_email_transport" as const;

export function passwordRecoveryDeliveryAvailable(): false {
  return false;
}

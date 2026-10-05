/**
 * CP30.05E-2D-1B — native Better Auth reset plus Resend.
 *
 * Option B is accepted. Better Auth 1.6.30 stores the reset token before
 * sendResetPassword, returns one generic acknowledgement for every address,
 * and does not put a delivery failure on the HTTP response. An undelivered
 * token can remain until it expires. That is not a delivery receipt.
 *
 * The callback is registered only when RESEND_API_KEY and RESEND_FROM_EMAIL
 * are both set. Until then the route stays disabled and no token is issued.
 * The public acknowledgement, when the route is enabled, stays the same if
 * Resend accepts, rejects, or throws.
 *
 * Logs record only the outcome and provider status. They do not record the
 * token, the reset URL, the password, or the API key.
 */
import { createServerFn } from "@tanstack/react-start";
import { readTrimmedEnv, type EnvMap } from "../aether/runtime-config.ts";
import { resolveAuthPerimeter } from "./perimeter.ts";

export const PASSWORD_RESET_TOKEN_EXPIRES_IN = 3600;

export const PASSWORD_RESET_ACKNOWLEDGEMENT =
  "If an account exists for that email, password reset instructions will be sent.";

export const PASSWORD_RESET_UNAVAILABLE =
  "Password recovery is not available until email delivery is configured.";

export const PASSWORD_RESET_LINK_INVALID = "This reset link is invalid or has expired.";

export const PASSWORD_RESET_COMPLETE =
  "Your password has been updated. Sign in with the new password.";

export const PASSWORD_RESET_SUBJECT = "Reset your SCAN BOOK GO password";

export type ResetDeliveryOutcome = "accepted" | "rejected" | "failed" | "not_configured";

export type PasswordResetPayload = {
  user: { email: string };
  url: string;
  token: string;
};

export function passwordRecoveryConfigured(env: EnvMap = process.env): boolean {
  return Boolean(readTrimmedEnv("RESEND_API_KEY", env) && readTrimmedEnv("RESEND_FROM_EMAIL", env));
}

/** True only when a real sender is configured. Unset environment stays closed. */
export function passwordRecoveryDeliveryAvailable(env: EnvMap = process.env): boolean {
  return passwordRecoveryConfigured(env);
}

/**
 * Production callback is BETTER_AUTH_URL. Preview and local dev use the
 * perimeter fallback, which is not PUBLIC_APP_URL and not a request Host.
 */
export function trustedPasswordResetCallbackUrl(
  env: EnvMap = process.env,
  argv: readonly string[] = process.argv,
): string {
  const perimeter = resolveAuthPerimeter(env, argv);
  const base = typeof perimeter.baseURL === "string" ? perimeter.baseURL : perimeter.baseURL.fallback;
  return `${base.replace(/\/$/, "")}/reset-password`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "\u0026amp;")
    .replaceAll("<", "\u0026lt;")
    .replaceAll(">", "\u0026gt;")
    .replaceAll("\"", "\u0026quot;")
    .replaceAll("'", "\u0026#39;");
}

export function passwordResetMessage(url: string): { subject: string; text: string; html: string } {
  const text = [
    "SCAN BOOK GO",
    "",
    "A password reset was requested for this account.",
    "",
    `Reset your password: ${url}`,
    "",
    "This link expires in 1 hour.",
    "If you did not request this, you can ignore this email.",
  ].join("\n");
  const safeUrl = escapeHtml(url);
  const html = `<!doctype html>
<html><body style="margin:0;background:#f5f5f2;color:#171717;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px">
    <div style="background:#fff;border:1px solid #ddd;padding:28px">
      <p style="margin:0;color:#666;font-size:12px;letter-spacing:.12em;text-transform:uppercase">SCAN BOOK GO</p>
      <h1 style="margin:16px 0 8px;font-size:24px;line-height:1.2">Reset your password</h1>
      <p style="margin:0 0 20px;color:#444;line-height:1.5">A password reset was requested for this account.</p>
      <a href="${safeUrl}" style="display:block;padding:15px 18px;background:#171717;color:#fff;text-align:center;text-decoration:none;font-weight:700">Reset your password</a>
      <p style="margin:20px 0 0;color:#666;font-size:13px;line-height:1.5">This link expires in 1 hour. If you did not request this, you can ignore this email.</p>
    </div>
  </div>
</body></html>`;
  return { subject: PASSWORD_RESET_SUBJECT, text, html };
}

/** Process log only. Not a database audit table. */
export function logPasswordResetDelivery(outcome: ResetDeliveryOutcome, providerStatus: number | null): void {
  console.info(JSON.stringify({
    event: "sbg.password_reset.delivery",
    outcome,
    providerStatus,
  }));
}

export async function deliverPasswordReset(input: {
  to: string;
  url: string;
  env?: EnvMap;
  fetchImpl?: typeof fetch;
}): Promise<ResetDeliveryOutcome> {
  const env = input.env ?? process.env;
  const apiKey = readTrimmedEnv("RESEND_API_KEY", env);
  const from = readTrimmedEnv("RESEND_FROM_EMAIL", env);
  if (!apiKey || !from) {
    logPasswordResetDelivery("not_configured", null);
    return "not_configured";
  }
  const message = passwordResetMessage(input.url);
  try {
    const response = await (input.fetchImpl ?? fetch)("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
    });
    if (!response.ok) {
      logPasswordResetDelivery("rejected", response.status);
      return "rejected";
    }
    logPasswordResetDelivery("accepted", response.status);
    return "accepted";
  } catch {
    logPasswordResetDelivery("failed", null);
    return "failed";
  }
}

export async function sendPasswordResetEmail(data: PasswordResetPayload, env: EnvMap = process.env): Promise<void> {
  await deliverPasswordReset({ to: data.user.email, url: data.url, env });
}

/** Empty unless Resend is configured. Signup options stay in signup-enumeration.ts. */
export function passwordResetDeliveryOptions(env: EnvMap = process.env) {
  if (!passwordRecoveryConfigured(env)) return {};
  return {
    sendResetPassword: (data: PasswordResetPayload) => sendPasswordResetEmail(data, env),
    revokeSessionsOnPasswordReset: true as const,
    resetPasswordTokenExpiresIn: PASSWORD_RESET_TOKEN_EXPIRES_IN,
  };
}

export const getPasswordRecoveryAvailability = createServerFn({ method: "GET" }).handler(async () => {
  const available = passwordRecoveryConfigured();
  return {
    available,
    resetCallbackUrl: available ? trustedPasswordResetCallbackUrl() : null,
  };
});

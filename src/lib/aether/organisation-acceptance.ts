/**
 * CP30.05E-2C.1 — durable agreement-version token.
 * Not a boolean, not a membership role, and not a seeded legal document.
 * A later checkpoint chooses the token. This module does not record acceptance.
 */

export const AGREEMENT_VERSION_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,120}$/;

export function isAgreementVersion(value: unknown): value is string {
  return typeof value === "string" && AGREEMENT_VERSION_PATTERN.test(value);
}

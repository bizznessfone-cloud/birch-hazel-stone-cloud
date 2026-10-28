/** Customer-safe messages for first-property registration.
 * Never expose raw SQL errors, identifiers, or agreement internals.
 * Server-side checks remain authoritative regardless of the displayed message.
 */
export function foundingPropertyRegistrationMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/terms are not approved|approved agreement unavailable|agreement.required/i.test(message)) {
    return "Your agreement needs to be verified again before you can register this property. Refresh the page to check your status.";
  }
  if (/duplicate key|unique constraint|already exists|code.*taken/i.test(message)) {
    return "That booking code is already in use. Choose another code and try again.";
  }
  if (/invalid property details|invalid timezone|invalid currency/i.test(message)) {
    return "Check the property name, location, booking code, timezone and currency, then try again.";
  }
  if (/^unauthorized$|account not found/i.test(message)) {
    return "Your session could not be verified. Sign in again to continue.";
  }
  return "Property registration could not be completed. No confirmation was received. Check your workspace before trying again.";
}

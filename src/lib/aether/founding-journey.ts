/**
 * CP30.05E-2D-2D A1 — pure founding-gate decision.
 * A hotel account skips this journey. No Terms write, hotel, or Stripe decision lives here.
 */
import type { FoundingOnboardingState, FoundingOrganisationType } from "./founding-onboarding.ts";

export type FoundingGate =
  | { kind: "existing-workspace" }
  | { kind: "business-name" }
  | { kind: "classify" }
  | { kind: "terms-pending"; organisationType: FoundingOrganisationType }
  | { kind: "ambiguous" }
  | { kind: "unavailable" };

export const BUSINESS_QUESTION = "What is your business called?";
export const TYPE_QUESTION = "What best describes your business?";
export const TERMS_PENDING_TITLE = "Terms are not available yet";
export const AMBIGUOUS_MESSAGE =
  "We could not confirm one business for this account. Nothing was changed.";
export const UNAVAILABLE_MESSAGE = "We could not open your workspace. Nothing was changed.";

/**
 * Hotel accounts keep their current workspace, including when founding state is
 * missing or ambiguous. Everyone else stops at business name, type, terms, or
 * a fail-closed message. This function does not write.
 */
export function foundingGate(input: {
  hotelCount: number;
  founding: FoundingOnboardingState | null;
}): FoundingGate {
  if (!Number.isInteger(input.hotelCount) || input.hotelCount < 0) return { kind: "unavailable" };
  if (input.hotelCount > 0) return { kind: "existing-workspace" };
  const founding = input.founding;
  if (!founding) return { kind: "unavailable" };
  if (founding.status === "missing") return { kind: "business-name" };
  if (founding.status === "ambiguous") return { kind: "ambiguous" };
  if (founding.organisationType === null) return { kind: "classify" };
  return { kind: "terms-pending", organisationType: founding.organisationType };
}

export function allowsFirstPropertyCreation(hotelCount: number): boolean {
  return Number.isInteger(hotelCount) && hotelCount > 0;
}

export function foundingCustomerMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/invalid organisation name/i.test(message)) {
    return "Enter a business name using ordinary letters, numbers, and punctuation.";
  }
  if (/organisation type is already set/i.test(message)) {
    return "This business already has a type. Reload the page to continue.";
  }
  if (/ambiguous/i.test(message)) return AMBIGUOUS_MESSAGE;
  if (/^unauthorized$/i.test(message) || /account not found/i.test(message)) {
    return "Sign in to continue.";
  }
  return "That could not be saved. Nothing else was changed.";
}

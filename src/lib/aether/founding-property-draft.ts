/** Client-only first-property draft validation. No database or Terms authority. */
export type FoundingPropertyDraft = { name: string; locality: string; code: string };
export type DraftErrors = Partial<Record<keyof FoundingPropertyDraft, string>>;
export function validateFoundingPropertyDraft(draft: FoundingPropertyDraft): DraftErrors {
  const errors: DraftErrors = {};
  const name = draft.name.trim();
  const locality = draft.locality.trim();
  const code = draft.code.trim();
  if (!name || name.length > 120) errors.name = "Enter a property name (up to 120 characters).";
  if (!locality || locality.length > 160) errors.locality = "Enter a location (up to 160 characters).";
  if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(code) || code.endsWith("-")) {
    errors.code = "Use 2–32 lowercase letters, numbers or hyphens; do not end with a hyphen.";
  }
  return errors;
}

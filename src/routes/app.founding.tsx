import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { classifyFoundingOrganisationFn, readFoundingOnboardingStateFn } from "@/lib/aether/founding-onboarding-fns";
import { ensureFoundingOrganisationFn } from "@/lib/aether/founding-organisation-fns";
import {
  AMBIGUOUS_MESSAGE,
  BUSINESS_QUESTION,
  TERMS_PENDING_TITLE,
  TYPE_QUESTION,
  UNAVAILABLE_MESSAGE,
  foundingCustomerMessage,
  foundingGate,
} from "@/lib/aether/founding-journey";
import type { FoundingOrganisationType } from "@/lib/aether/founding-onboarding";
import { foundingPropertyPreviewReady, validateFoundingPropertyDraft } from "@/lib/aether/founding-property-draft";
import { getOnboardingState } from "@/lib/aether/onboarding-fns";
import { readFoundingPropertyEligibilityFn } from "@/lib/aether/founding-property-eligibility-fns";
import { createFoundingPropertyFn } from "@/lib/aether/founding-property-fns";
import { foundingPropertyRegistrationMessage } from "@/lib/aether/founding-property-message";
import type { FoundingPropertyEligibility } from "@/lib/aether/founding-property-eligibility";

export const Route = createFileRoute("/app/founding")({
  loader: async () => {
    const hotels = await getOnboardingState();
    if (!hotels.ok) return { screen: "unavailable" as const, message: UNAVAILABLE_MESSAGE };
    if (hotels.hotels.length > 0) {
      const hotelId = hotels.hotels[0]?.hotel.id;
      if (!hotelId) return { screen: "unavailable" as const, message: UNAVAILABLE_MESSAGE };
      throw redirect({ to: "/app/hotels/$hotelId", params: { hotelId } });
    }
    try {
      const founding = await readFoundingOnboardingStateFn();
      const gate = foundingGate({ hotelCount: 0, founding });
      let eligibility: FoundingPropertyEligibility = { eligible: false, reason: "unavailable" };
      if (gate.kind === "terms-pending" && gate.organisationType === "hotel") {
        try {
          eligibility = await readFoundingPropertyEligibilityFn();
        } catch {
          // Unavailable eligibility must never unlock registration.
        }
      }
      return { screen: "journey" as const, gate, eligibility };
    } catch {
      return { screen: "unavailable" as const, message: UNAVAILABLE_MESSAGE };
    }
  },
  component: FoundingJourney,
});

function FoundingJourney() {
  const data = Route.useLoaderData();
  if (data.screen === "unavailable") return <Status title="Setup is unavailable" body={data.message} />;
  if (data.gate.kind === "existing-workspace" || data.gate.kind === "unavailable") {
    return <Status title="Setup is unavailable" body={UNAVAILABLE_MESSAGE} />;
  }
  if (data.gate.kind === "ambiguous") return <Status title="We need to check this account" body={AMBIGUOUS_MESSAGE} />;
  if (data.gate.kind === "classify") return <ClassifyStep />;
  if (data.gate.kind === "terms-pending") return <TermsPending organisationType={data.gate.organisationType} eligibility={data.eligibility} />;
  return <BusinessNameStep />;
}

function BusinessNameStep() {
  const router = useRouter();
  const [businessName, setBusinessName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await ensureFoundingOrganisationFn({ data: { businessName } });
      await router.invalidate();
    } catch (err) {
      setError(foundingCustomerMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="mx-auto max-w-lg" onSubmit={(event) => void submit(event)} aria-busy={busy}>
      <FoundingProgress current={1} />
      <p className="text-xs font-medium tracking-[0.2em] text-muted uppercase">Your business</p>
      <h1 className="mt-3 text-4xl font-semibold tracking-tight">{BUSINESS_QUESTION}</h1>
      <p className="mt-4 text-sm leading-relaxed text-muted">
        Use the name customers know. A property can use the same name later.
      </p>
      <label className="mt-8 block" htmlFor="business-name">
        <span className="mb-2 block text-xs font-medium tracking-widest text-muted uppercase">Business name</span>
        <input
          id="business-name"
          name="businessName"
          autoComplete="organization"
          className="min-h-12 w-full border border-line bg-transparent px-3 outline-none focus:border-ink"
          value={businessName}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "business-name-error" : undefined}
          onChange={(event) => setBusinessName(event.target.value)}
        />
      </label>
      {error ? (
        <p id="business-name-error" role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={busy || businessName.trim().length === 0}
        className="mt-6 min-h-12 w-full bg-ink px-4 text-sm font-semibold tracking-wide text-canvas uppercase disabled:opacity-50"
      >
        {busy ? "Saving…" : "Continue"}
      </button>
    </form>
  );
}

function ClassifyStep() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function choose(organisationType: "hotel" | "transfer_operator") {
    setBusy(true);
    setError(null);
    try {
      await classifyFoundingOrganisationFn({ data: { organisationType } });
      await router.invalidate();
    } catch (err) {
      setError(foundingCustomerMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mx-auto max-w-lg" aria-busy={busy}>
      <FoundingProgress current={2} />
      <p className="text-xs font-medium tracking-[0.2em] text-muted uppercase">Your business</p>
      <h1 className="mt-3 text-4xl font-semibold tracking-tight">{TYPE_QUESTION}</h1>
      <p className="mt-4 text-sm leading-relaxed text-muted">
        This describes the business, not an individual property.
      </p>
      <div className="mt-8 grid gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void choose("hotel")}
          className="min-h-12 border border-line px-4 py-4 text-left disabled:opacity-50"
        >
          <span className="block text-base font-semibold">Hotel / Accommodation</span>
          <span className="mt-1 block text-sm text-muted">You operate a hotel or other accommodation.</span>
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void choose("transfer_operator")}
          className="min-h-12 border border-line px-4 py-4 text-left disabled:opacity-50"
        >
          <span className="block text-base font-semibold">Independent Transfer Operator</span>
          <span className="mt-1 block text-sm text-muted">You run transfers for the properties you serve.</span>
        </button>
      </div>
      {error ? (
        <p role="alert" className="mt-4 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function TermsPending({ organisationType, eligibility }: { organisationType: FoundingOrganisationType; eligibility: FoundingPropertyEligibility }) {
  const [propertyName, setPropertyName] = useState("");
  const [locality, setLocality] = useState("");
  const [propertyCode, setPropertyCode] = useState("");
  const [ianaTimezone, setIanaTimezone] = useState("");
  const [currency, setCurrency] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [registrationError, setRegistrationError] = useState<string | null>(null);
  const [createdHotelId, setCreatedHotelId] = useState<string | null>(null);
  const router = useRouter();
  async function registerProperty(event: FormEvent) {
    event.preventDefault();
    if (!eligibility.eligible || submitting || createdHotelId || !foundingPropertyPreviewReady({ name: propertyName, locality, code: propertyCode }) || !timezoneValid || !currencyValid) return;
    setSubmitting(true);
    setRegistrationError(null);
    let hotelId: string;
    try {
      const created = await createFoundingPropertyFn({
        data: { name: propertyName.trim(), locality: locality.trim(), code: propertyCode.trim(), ianaTimezone, currency },
      });
      hotelId = created.hotelId;
      // A successful server write must not be reported as failed if navigation fails.
      setCreatedHotelId(hotelId);
    } catch (error) {
      setRegistrationError(foundingPropertyRegistrationMessage(error));
      setSubmitting(false);
      return;
    }
    try {
      await router.invalidate();
      await router.navigate({ to: "/app/hotels/$hotelId", params: { hotelId } });
    } catch {
      setRegistrationError("Your property was created successfully, but the workspace could not open automatically. Use the link below to continue.");
    } finally {
      setSubmitting(false);
    }
  }
  const draft = { name: propertyName, locality, code: propertyCode };
  const errors = validateFoundingPropertyDraft(draft);
  const previewReady = foundingPropertyPreviewReady(draft);
  const timezoneValid = (() => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: ianaTimezone });
      return true;
    } catch {
      return false;
    }
  })();
  const currencyValid = /^[A-Z]{3}$/.test(currency) && Intl.supportedValuesOf("currency").includes(currency);
  const label = organisationType === "hotel" ? "Hotel / Accommodation" : "Independent Transfer Operator";
  return (
    <div className="mx-auto max-w-lg space-y-8">
      <Status
        title={eligibility.eligible ? "Agreement verified" : TERMS_PENDING_TITLE}
        body={eligibility.eligible ? "Your approved agreement has been verified. You can register your first property." : "Your business setup is saved. An approved agreement is required before registering your first property."}
        detail={`Business type: ${label}.`}
        progress={3}
      />
      {organisationType === "hotel" ? (
        <form onSubmit={(event) => void registerProperty(event)} className="border border-line bg-surface p-5" aria-labelledby="property-preview-title" aria-busy={submitting}>
          <p className="text-xs font-medium tracking-[0.2em] text-muted uppercase">{eligibility.eligible ? "Next step · Register property" : "Next step · Preview only"}</p>
          <h2 id="property-preview-title" className="mt-2 text-2xl font-semibold tracking-tight">Your first property</h2>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            {eligibility.eligible ? "Register your hotel to open its workspace." : "Preview the details needed to register your hotel. Nothing is saved or submitted. Legal agreements are being finalised; this preview is not an acceptance of any agreement."}
          </p>
          <label className="mt-6 block" htmlFor="preview-property-name">
            <span className="mb-2 block text-xs font-medium tracking-widest text-muted uppercase">Property name</span>
            <input id="preview-property-name" maxLength={120} autoComplete="off"
              className="min-h-12 w-full border border-line bg-transparent px-3"
              value={propertyName} onChange={event => setPropertyName(event.target.value)}
              placeholder="e.g. Aegean Bay Hotel" />
            {propertyName && errors.name ? <p className="mt-1 text-xs text-danger">{errors.name}</p> : null}
          </label>
          <label className="mt-4 block" htmlFor="preview-property-location">
            <span className="mb-2 block text-xs font-medium tracking-widest text-muted uppercase">Location</span>
            <input id="preview-property-location" maxLength={160} autoComplete="off"
              className="min-h-12 w-full border border-line bg-transparent px-3"
              value={locality} onChange={event => setLocality(event.target.value)}
              placeholder="e.g. Kos, Greece" />
            {locality && errors.locality ? <p className="mt-1 text-xs text-danger">{errors.locality}</p> : null}
          </label>
          <label className="mt-4 block" htmlFor="preview-property-code">
            <span className="mb-2 block text-xs font-medium tracking-widest text-muted uppercase">Booking code</span>
            <input id="preview-property-code" maxLength={32} autoComplete="off"
              className="min-h-12 w-full border border-line bg-transparent px-3"
              value={propertyCode} onChange={event => setPropertyCode(event.target.value.toLowerCase().replace(/\s+/g, "-"))}
              placeholder="e.g. aegean-bay" />
            <p className="mt-1 text-xs text-muted">This becomes part of the hotel’s booking link. Use lowercase letters, numbers and hyphens.</p>
            {propertyCode && errors.code ? <p role="alert" className="mt-1 text-xs text-danger">{errors.code}</p> : null}
          </label>
          <label className="mt-4 block" htmlFor="property-timezone">
            <span className="mb-2 block text-xs font-medium tracking-widest text-muted uppercase">Property timezone</span>
            <input id="property-timezone" required maxLength={120} autoComplete="off"
              className="min-h-12 w-full border border-line bg-transparent px-3"
              value={ianaTimezone} onChange={event => setIanaTimezone(event.target.value)}
              placeholder="e.g. Europe/Athens" />
            <p className="mt-1 text-xs text-muted">Use the property's IANA timezone, such as Europe/London.</p>
            {ianaTimezone && !timezoneValid ? <p role="alert" className="mt-1 text-xs text-danger">Enter a recognised IANA timezone, such as Europe/Athens or Europe/London.</p> : null}
          </label>
          <label className="mt-4 block" htmlFor="property-currency">
            <span className="mb-2 block text-xs font-medium tracking-widest text-muted uppercase">Property currency</span>
            <input id="property-currency" required maxLength={3} autoComplete="off"
              className="min-h-12 w-full border border-line bg-transparent px-3 uppercase"
              value={currency} onChange={event => setCurrency(event.target.value.toUpperCase())}
              placeholder="e.g. EUR" />
            <p className="mt-1 text-xs text-muted">Three-letter ISO currency code, such as EUR or GBP.</p>
            {currency && !currencyValid ? <p role="alert" className="mt-1 text-xs text-danger">Enter a recognised currency code.</p> : null}
          </label>
          <p className="mt-5 text-xs leading-relaxed text-muted" role="status">
            {!previewReady || !timezoneValid || !currencyValid
              ? "Complete the property name, location, booking code, valid timezone and currency. Nothing is saved until registration is available and you submit."
              : eligibility.eligible
                ? "All property details are valid. You can register your property."
                : "All property details are valid. Registration remains unavailable until an approved agreement has been explicitly accepted."}
          </p>
          {registrationError ? <p role="alert" className="mt-3 text-sm text-danger">{registrationError}</p> : null}
          {createdHotelId ? (
            <a className="mt-4 block text-sm font-semibold underline underline-offset-4" href={`/app/hotels/${encodeURIComponent(createdHotelId)}`}>
              Open your new property's workspace
            </a>
          ) : null}
          <button type="submit" disabled={!eligibility.eligible || !previewReady || submitting || !!createdHotelId || !timezoneValid || !currencyValid}
            className="mt-4 min-h-12 w-full bg-ink px-4 text-sm font-semibold tracking-wide text-canvas uppercase disabled:opacity-50">
            {submitting ? "Creating property…" : eligibility.eligible ? "Create property" : "Create property · Not yet available"}
          </button>
        </form>
      ) : null}
    </div>
  );
}

function Status({ title, body, detail, progress }: { title: string; body: string; detail?: string; progress?: 1 | 2 | 3 }) {
  return (
    <section className="mx-auto max-w-lg">
      {progress ? <FoundingProgress current={progress} /> : null}
      <p className="text-xs font-medium tracking-[0.2em] text-muted uppercase">Your business</p>
      <h1 className="mt-3 text-4xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-4 text-sm leading-relaxed text-muted">{body}</p>
      {detail ? <p className="mt-4 text-sm">{detail}</p> : null}
    </section>
  );
}

/** Visual progress only. Never treats provisional Terms as accepted. */
function FoundingProgress({ current }: { current: 1 | 2 | 3 }) {
  const steps = ["Business", "Business type", "Agreement"] as const;
  return (
    <nav aria-label="Account setup progress" className="mb-8">
      <ol className="grid grid-cols-3 gap-2">
        {steps.map((step, index) => {
          const number = index + 1;
          const active = number === current;
          const complete = number < current;
          return (
            <li key={step} aria-current={active ? "step" : undefined} className="min-w-0">
              <div className={`h-1 w-full ${complete || active ? "bg-ink" : "bg-line"}`} aria-hidden="true" />
              <span className={`mt-2 block text-[11px] leading-snug ${active ? "font-semibold text-ink" : "text-muted"}`}>
                {number}. {step}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="sr-only">Step {current} of 3. {steps[current - 1]}.</p>
    </nav>
  );
}

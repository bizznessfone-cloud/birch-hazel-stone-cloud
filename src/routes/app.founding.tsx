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
import { validateFoundingPropertyDraft } from "@/lib/aether/founding-property-draft";
import { getOnboardingState } from "@/lib/aether/onboarding-fns";

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
      return { screen: "journey" as const, gate: foundingGate({ hotelCount: 0, founding }) };
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
  if (data.gate.kind === "terms-pending") return <TermsPending organisationType={data.gate.organisationType} />;
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

function TermsPending({ organisationType }: { organisationType: FoundingOrganisationType }) {
  const [propertyName, setPropertyName] = useState("");
  const [locality, setLocality] = useState("");
  const [propertyCode, setPropertyCode] = useState("");
  const errors = validateFoundingPropertyDraft({ name: propertyName, locality, code: propertyCode });
  const label = organisationType === "hotel" ? "Hotel / Accommodation" : "Independent Transfer Operator";
  return (
    <div className="mx-auto max-w-lg space-y-8">
      <Status
        title={TERMS_PENDING_TITLE}
        body="Your business setup is saved. An approved agreement is required before registering your first property."
        detail={`Business type: ${label}.`}
        progress={3}
      />
      {organisationType === "hotel" ? (
        <section className="border border-line bg-surface p-5" aria-labelledby="property-preview-title">
          <p className="text-xs font-medium tracking-[0.2em] text-muted uppercase">Next step · Preview only</p>
          <h2 id="property-preview-title" className="mt-2 text-2xl font-semibold tracking-tight">Your first property</h2>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            Preview the details needed to register your hotel. Nothing is saved or submitted.
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
              value={propertyCode} onChange={event => setPropertyCode(event.target.value)}
              placeholder="e.g. aegean-bay" />
            {propertyCode && errors.code ? <p className="mt-1 text-xs text-danger">{errors.code}</p> : null}
          </label>
          <p className="mt-5 text-xs leading-relaxed text-muted" role="status">
            Preview only. Values are not retained when you leave this page.
          </p>
          <button type="button" disabled
            className="mt-4 min-h-12 w-full bg-ink px-4 text-sm font-semibold tracking-wide text-canvas uppercase opacity-50">
            Create property · Not yet available
          </button>
        </section>
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

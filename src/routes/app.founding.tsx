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
  const label = organisationType === "hotel" ? "Hotel / Accommodation" : "Independent Transfer Operator";
  return (
    <Status
      title={TERMS_PENDING_TITLE}
      body="Your account setup is saved. Terms are not yet available for acceptance, so this step cannot be completed. You will stay here until Terms are ready."
      detail={`Business type: ${label}.`}
    />
  );
}

function Status({ title, body, detail }: { title: string; body: string; detail?: string }) {
  return (
    <section className="mx-auto max-w-lg">
      <p className="text-xs font-medium tracking-[0.2em] text-muted uppercase">Your business</p>
      <h1 className="mt-3 text-4xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-4 text-sm leading-relaxed text-muted">{body}</p>
      {detail ? <p className="mt-4 text-sm">{detail}</p> : null}
    </section>
  );
}

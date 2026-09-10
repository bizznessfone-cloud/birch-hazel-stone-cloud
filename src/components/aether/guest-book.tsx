import { useMemo, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { createPublicBooking, getPublicBooking } from "@/lib/aether/booking-fns";
import {
  applyDirection,
  emptyDraft,
  placeKindLabel,
  touristMessage,
  vehicleHint,
  type Direction,
  type GuestDraft,
  type PlaceKind,
} from "@/lib/aether/guest";
import { GuestHeader } from "./guest-header";
import { HotelMark } from "./hotel-mark";
import { ThemeToggle } from "./theme-toggle";

type Step = "landing" | "find" | "journey" | "when" | "party" | "contact" | "review";

const PLACE_KINDS: PlaceKind[] = ["airport", "port", "hotel", "other"];

export function GuestBook({
  hotelCode,
  hotelName,
}: {
  hotelCode: string;
  hotelName: string;
}) {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("landing");
  const [draft, setDraft] = useState<GuestDraft>(() => emptyDraft(hotelName));
  const [lookupToken, setLookupToken] = useState("");
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [idempotencyKey] = useState(() =>
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `guest-${Date.now()}`,
  );
  const hint = useMemo(
    () => vehicleHint(draft.passengerCount, draft.luggageCount),
    [draft.passengerCount, draft.luggageCount],
  );

  function patch(partial: Partial<GuestDraft>) {
    setDraft((current) => ({ ...current, ...partial }));
  }

  async function submit() {
    setSubmitError(null);
    setSubmitting(true);
    try {
      const result = await createPublicBooking({
        data: {
          hotelCode,
          transferDate: draft.transferDate,
          pickupTime: draft.pickupTime,
          durationMinutes: draft.durationMinutes,
          guestName: draft.guestName,
          guestPhone: draft.guestPhone,
          guestEmail: draft.guestEmail,
          passengerCount: draft.passengerCount,
          luggageCount: draft.luggageCount,
          pickupText: draft.pickupText,
          destinationText: draft.destinationText,
          specialRequirements: draft.specialRequirements.trim() || null,
          idempotencyKey,
        },
      });
      if (!result.ok) {
        setSubmitError(result.message);
        return;
      }
      await navigate({
        to: "/confirmed/$token",
        params: { token: result.booking.confirmationToken },
      });
    } catch {
      setSubmitError(touristMessage("server_error"));
    } finally {
      setSubmitting(false);
    }
  }

  async function lookup() {
    setLookupError(null);
    setLookupBusy(true);
    try {
      const result = await getPublicBooking({ data: { token: lookupToken } });
      if (!result.ok) {
        setLookupError(result.message);
        return;
      }
      await navigate({
        to: "/confirmed/$token",
        params: { token: lookupToken.trim() },
      });
    } catch {
      setLookupError(touristMessage("server_error"));
    } finally {
      setLookupBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-ink">
      {step === "landing" ? (
        <Landing hotelName={hotelName} onBook={() => setStep("journey")} onFind={() => setStep("find")} />
      ) : (
        <>
          <GuestHeader hotelName={hotelName} />
          <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-5 py-6">
            {step === "find" ? (
              <FindStep
                token={lookupToken}
                error={lookupError}
                busy={lookupBusy}
                onToken={setLookupToken}
                onLookup={() => void lookup()}
                onBack={() => setStep("landing")}
              />
            ) : null}
            {step === "journey" ? (
              <JourneyStep
                hotelName={hotelName}
                draft={draft}
                onDirection={(direction) =>
                  setDraft((current) => applyDirection(current, direction, hotelName))
                }
                onKind={(placeKind) => patch({ placeKind })}
                onPickup={(pickupText) => patch({ pickupText })}
                onDestination={(destinationText) => patch({ destinationText })}
                onNext={() => setStep("when")}
                onBack={() => setStep("landing")}
              />
            ) : null}
            {step === "when" ? (
              <WhenStep
                draft={draft}
                onDate={(transferDate) => patch({ transferDate })}
                onTime={(pickupTime) => patch({ pickupTime })}
                onDuration={(durationMinutes) => patch({ durationMinutes })}
                onNext={() => setStep("party")}
                onBack={() => setStep("journey")}
              />
            ) : null}
            {step === "party" ? (
              <PartyStep
                draft={draft}
                hint={hint}
                onPassengers={(passengerCount) => patch({ passengerCount })}
                onLuggage={(luggageCount) => patch({ luggageCount })}
                onNext={() => setStep("contact")}
                onBack={() => setStep("when")}
              />
            ) : null}
            {step === "contact" ? (
              <ContactStep
                draft={draft}
                onName={(guestName) => patch({ guestName })}
                onPhone={(guestPhone) => patch({ guestPhone })}
                onEmail={(guestEmail) => patch({ guestEmail })}
                onSpecial={(specialRequirements) => patch({ specialRequirements })}
                onNext={() => setStep("review")}
                onBack={() => setStep("party")}
              />
            ) : null}
            {step === "review" ? (
              <ReviewStep
                hotelName={hotelName}
                draft={draft}
                error={submitError}
                busy={submitting}
                onSubmit={() => void submit()}
                onBack={() => setStep("contact")}
              />
            ) : null}
          </main>
        </>
      )}
    </div>
  );
}

function Landing({
  hotelName,
  onBook,
  onFind,
}: {
  hotelName: string;
  onBook: () => void;
  onFind: () => void;
}) {
  return (
    <main className="flex min-h-dvh flex-col">
      <div className="flex justify-end px-5 py-4">
        <ThemeToggle />
      </div>
      <section className="flex flex-1 flex-col items-center justify-center px-6 pb-16 text-center">
        <HotelMark name={hotelName} size="lg" />
        <h1 className="mt-8 text-3xl font-semibold tracking-tight">{hotelName}</h1>
        <p className="mt-6 text-4xl leading-none font-semibold tracking-tight">SCAN. BOOK. GO.</p>
        <p className="mt-6 max-w-sm text-base leading-relaxed text-muted">
          Private hotel transfers. Book at reception in a few steps.
        </p>
        <div className="mt-12 flex w-full max-w-sm flex-col gap-3">
          <PrimaryButton onClick={onBook}>Book transfer</PrimaryButton>
          <SecondaryButton onClick={onFind}>View my booking</SecondaryButton>
        </div>
      </section>
    </main>
  );
}

function FindStep(props: {
  token: string;
  error: string | null;
  busy: boolean;
  onToken: (value: string) => void;
  onLookup: () => void;
  onBack: () => void;
}) {
  return (
    <form
      className="flex flex-1 flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        props.onLookup();
      }}
    >
      <StepTitle title="View my booking" note="Enter the confirmation token from your booking page. A reference number is not enough." />
      <Field label="Confirmation token">
        <input
          className={inputClass}
          value={props.token}
          autoComplete="off"
          onChange={(event) => props.onToken(event.target.value)}
        />
      </Field>
      {props.error ? <ErrorText>{props.error}</ErrorText> : null}
      <Actions
        back={props.onBack}
        nextLabel={props.busy ? "Looking…" : "Find booking"}
        nextDisabled={!props.token.trim() || props.busy}
      />
    </form>
  );
}

function JourneyStep(props: {
  hotelName: string;
  draft: GuestDraft;
  onDirection: (direction: Direction) => void;
  onKind: (kind: PlaceKind) => void;
  onPickup: (value: string) => void;
  onDestination: (value: string) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const ready = props.draft.pickupText.trim() && props.draft.destinationText.trim();
  return (
    <form
      className="flex flex-1 flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) props.onNext();
      }}
    >
      <StepTitle title="Journey" note="Where should we collect you, and where should we take you?" />
      <ChoiceRow
        label="Direction"
        options={[
          { id: "from_hotel", label: `From ${props.hotelName}` },
          { id: "to_hotel", label: `To ${props.hotelName}` },
        ]}
        value={props.draft.direction}
        onChange={(id) => props.onDirection(id as Direction)}
      />
      <ChoiceRow
        label="Place type"
        options={PLACE_KINDS.map((kind) => ({ id: kind, label: placeKindLabel(kind) }))}
        value={props.draft.placeKind}
        onChange={(id) => props.onKind(id as PlaceKind)}
      />
      <Field label="Pickup">
        <input
          className={inputClass}
          value={props.draft.pickupText}
          onChange={(event) => props.onPickup(event.target.value)}
        />
      </Field>
      <Field label="Destination">
        <input
          className={inputClass}
          value={props.draft.destinationText}
          onChange={(event) => props.onDestination(event.target.value)}
        />
      </Field>
      <Actions back={props.onBack} nextDisabled={!ready} />
    </form>
  );
}

function WhenStep(props: {
  draft: GuestDraft;
  onDate: (value: string) => void;
  onTime: (value: string) => void;
  onDuration: (value: number) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const ready = props.draft.transferDate && props.draft.pickupTime && props.draft.durationMinutes >= 1;
  return (
    <form
      className="flex flex-1 flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) props.onNext();
      }}
    >
      <StepTitle title="When" note="Athens civil time. Times that do not exist, including some DST hours, cannot be booked." />
      <Field label="Date">
        <input
          type="date"
          className={inputClass}
          value={props.draft.transferDate}
          onChange={(event) => props.onDate(event.target.value)}
        />
      </Field>
      <Field label="Pickup time">
        <input
          type="time"
          className={inputClass}
          value={props.draft.pickupTime}
          onChange={(event) => props.onTime(event.target.value)}
        />
      </Field>
      <Stepper
        label="Duration (minutes)"
        value={props.draft.durationMinutes}
        min={1}
        max={1440}
        onChange={props.onDuration}
      />
      <Actions back={props.onBack} nextDisabled={!ready} />
    </form>
  );
}

function PartyStep(props: {
  draft: GuestDraft;
  hint: { title: string; note: string };
  onPassengers: (value: number) => void;
  onLuggage: (value: number) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  return (
    <form
      className="flex flex-1 flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        props.onNext();
      }}
    >
      <StepTitle title="Party" note="Tell us how many people and bags are travelling." />
      <Stepper label="Passengers" value={props.draft.passengerCount} min={1} max={20} onChange={props.onPassengers} />
      <Stepper label="Luggage" value={props.draft.luggageCount} min={0} max={20} onChange={props.onLuggage} />
      <aside className="border border-line bg-surface px-4 py-4 text-left">
        <p className="text-xs tracking-widest text-muted uppercase">Comfort guide</p>
        <p className="mt-2 text-lg font-semibold">{props.hint.title}</p>
        <p className="mt-2 text-sm leading-relaxed text-muted">{props.hint.note}</p>
      </aside>
      <Actions back={props.onBack} />
    </form>
  );
}

function ContactStep(props: {
  draft: GuestDraft;
  onName: (value: string) => void;
  onPhone: (value: string) => void;
  onEmail: (value: string) => void;
  onSpecial: (value: string) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const ready = props.draft.guestName.trim() && props.draft.guestPhone.trim() && props.draft.guestEmail.trim();
  return (
    <form
      className="flex flex-1 flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) props.onNext();
      }}
    >
      <StepTitle title="Contact" note="We use these details for the driver and the confirmation." />
      <Field label="Name">
        <input className={inputClass} value={props.draft.guestName} onChange={(event) => props.onName(event.target.value)} />
      </Field>
      <Field label="Phone">
        <input
          className={inputClass}
          type="tel"
          value={props.draft.guestPhone}
          onChange={(event) => props.onPhone(event.target.value)}
        />
      </Field>
      <Field label="Email">
        <input
          className={inputClass}
          type="email"
          value={props.draft.guestEmail}
          onChange={(event) => props.onEmail(event.target.value)}
        />
      </Field>
      <Field label="Room or flight number">
        <input
          className={inputClass}
          value={props.draft.specialRequirements}
          onChange={(event) => props.onSpecial(event.target.value)}
        />
      </Field>
      <Actions back={props.onBack} nextDisabled={!ready} />
    </form>
  );
}

function ReviewStep(props: {
  hotelName: string;
  draft: GuestDraft;
  error: string | null;
  busy: boolean;
  onSubmit: () => void;
  onBack: () => void;
}) {
  return (
    <form
      className="flex flex-1 flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      <StepTitle title="Review" note="Check the details. Price is confirmed by the hotel." />
      <dl className="divide-y divide-line border border-line">
        <ReviewRow label="Hotel" value={props.hotelName} />
        <ReviewRow label="Direction" value={props.draft.direction === "from_hotel" ? `From ${props.hotelName}` : `To ${props.hotelName}`} />
        <ReviewRow label="Pickup" value={props.draft.pickupText} />
        <ReviewRow label="Destination" value={props.draft.destinationText} />
        <ReviewRow label="When" value={`${props.draft.transferDate} · ${props.draft.pickupTime} · ${props.draft.durationMinutes} min`} />
        <ReviewRow label="Party" value={`${props.draft.passengerCount} passengers · ${props.draft.luggageCount} bags`} />
        <ReviewRow label="Guest" value={props.draft.guestName} />
        <ReviewRow label="Price" value="To be confirmed" />
      </dl>
      {props.error ? <ErrorText>{props.error}</ErrorText> : null}
      <Actions
        back={props.onBack}
        nextLabel={props.busy ? "Booking…" : "Confirm booking"}
        nextDisabled={props.busy}
      />
    </form>
  );
}

const inputClass =
  "min-h-14 w-full border border-line bg-surface px-4 text-lg text-ink outline-none focus:border-ink";

function StepTitle({ title, note }: { title: string; note: string }) {
  return (
    <div>
      <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted">{note}</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs tracking-widest text-muted uppercase">{label}</span>
      {children}
    </label>
  );
}

function ChoiceRow({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <fieldset>
      <legend className="mb-2 text-xs tracking-widest text-muted uppercase">{label}</legend>
      <div className="grid grid-cols-2 gap-2">
        {options.map((option) => {
          const active = option.id === value;
          return (
            <button
              key={option.id}
              type="button"
              className={`min-h-14 border px-3 text-sm font-medium ${active ? "border-ink bg-ink text-canvas" : "border-line bg-surface text-ink"}`}
              onClick={() => onChange(option.id)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

function Stepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <p className="mb-2 text-xs tracking-widest text-muted uppercase">{label}</p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="flex min-h-14 min-w-14 items-center justify-center border border-line text-2xl"
          onClick={() => onChange(Math.max(min, value - 1))}
          aria-label={`Decrease ${label}`}
        >
          −
        </button>
        <p className="flex-1 text-center text-3xl font-semibold tabular-nums">{value}</p>
        <button
          type="button"
          className="flex min-h-14 min-w-14 items-center justify-center border border-line text-2xl"
          onClick={() => onChange(Math.min(max, value + 1))}
          aria-label={`Increase ${label}`}
        >
          +
        </button>
      </div>
    </div>
  );
}

function Actions({
  back,
  nextLabel = "Continue",
  nextDisabled,
}: {
  back: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
}) {
  return (
    <div className="mt-auto flex flex-col gap-3 pt-4">
      <PrimaryButton type="submit" disabled={nextDisabled}>
        {nextLabel}
      </PrimaryButton>
      <SecondaryButton type="button" onClick={back}>
        Back
      </SecondaryButton>
    </div>
  );
}

function PrimaryButton({
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className="min-h-14 w-full bg-ink px-4 text-base font-semibold tracking-wide text-canvas uppercase disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function SecondaryButton({
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className="min-h-14 w-full border border-line px-4 text-base font-medium text-ink"
    >
      {children}
    </button>
  );
}

function ErrorText({ children }: { children: ReactNode }) {
  return <p className="border border-line bg-surface px-4 py-3 text-sm">{children}</p>;
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3">
      <dt className="text-xs tracking-widest text-muted uppercase">{label}</dt>
      <dd className="text-right text-sm font-medium">{value}</dd>
    </div>
  );
}

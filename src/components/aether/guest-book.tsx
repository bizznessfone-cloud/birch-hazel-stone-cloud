import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { createPublicBooking, getPublicBooking } from "@/lib/aether/booking-fns";
import {
  applyDirection,
  emptyDraft,
  formatQuotedPrice,
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
import {
  DefinitionRow,
  EmptyState,
  Field,
  GuestPrimaryButton,
  GuestSecondaryButton,
  Notice,
  StepProgress,
  guestFieldClass,
} from "./ui";

type Step = "landing" | "find" | "journey" | "when" | "party" | "contact" | "review";

const PLACE_KINDS: PlaceKind[] = ["airport", "port", "hotel", "other"];
const BOOK_STEPS = ["Journey", "When", "Party", "Contact", "Review"] as const;

type CatalogueDestination = {
  id: string;
  kind: PlaceKind;
  name: string;
  amountMinor: number;
  sortOrder: number;
};

export function GuestBook({
  hotelCode,
  hotelName,
  currency,
  destinations,
  preview = false,
}: {
  hotelCode: string;
  hotelName: string;
  currency: string;
  destinations: CatalogueDestination[];
  preview?: boolean;
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
      if (!draft.destinationId) {
        setSubmitError(touristMessage("invalid_destination"));
        return;
      }
      const result = await createPublicBooking({
        data: {
          hotelCode,
          destinationId: draft.destinationId,
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
        <Landing hotelName={hotelName} preview={preview} onBook={() => setStep("journey")} onFind={() => setStep("find")} />
      ) : (
        <>
          <GuestHeader hotelName={hotelName} />
          <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-5 py-6">
            {!preview && step === "find" ? (
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
                currency={currency}
                destinations={destinations}
                draft={draft}
                onDirection={(direction) =>
                  setDraft((current) => {
                    const selected = destinations.find((item) => item.id === current.destinationId);
                    return applyDirection(current, direction, hotelName, selected?.name);
                  })
                }
                onKind={(placeKind) =>
                  setDraft((current) => {
                    const selected = destinations.find((item) => item.id === current.destinationId);
                    if (selected && selected.kind !== placeKind) {
                      return applyDirection(
                        { ...current, placeKind, destinationId: null, destinationText: "" },
                        current.direction,
                        hotelName,
                        "",
                      );
                    }
                    return { ...current, placeKind };
                  })
                }
                onPickup={(pickupText) => patch({ pickupText })}
                onDestination={(destination) =>
                  setDraft((current) =>
                    applyDirection(
                      {
                        ...current,
                        destinationId: destination.id,
                        destinationText: destination.name,
                        placeKind: destination.kind,
                      },
                      current.direction,
                      hotelName,
                      destination.name,
                    ),
                  )
                }
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
                currency={currency}
                destinations={destinations}
                draft={draft}
                error={submitError}
                busy={submitting}
                preview={preview}
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
  preview,
  onBook,
  onFind,
}: {
  hotelName: string;
  preview: boolean;
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
        <p className="mt-8 text-xs font-medium tracking-widest text-muted uppercase">
          Private hotel transfer
        </p>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight">{hotelName}</h1>
        <p className="mt-6 text-4xl leading-none font-semibold tracking-tight">SCAN. BOOK. GO.</p>
        <p className="mt-6 max-w-sm text-base leading-relaxed text-muted">
          {preview
            ? "Preview of the guest booking experience. This preview does not create a booking."
            : "Choose a destination and price. No account needed."}
        </p>
        <div className="mt-12 flex w-full max-w-sm flex-col gap-3">
          <GuestPrimaryButton onClick={onBook}>
            {preview ? "Preview booking flow" : "Book transfer"}
          </GuestPrimaryButton>
          {!preview ? <GuestSecondaryButton onClick={onFind}>View my booking</GuestSecondaryButton> : null}
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
      <StepTitle title="View my booking" note="Open the confirmation link from your booking, or paste the confirmation token here. A booking reference is not enough." />
      <Field label="Confirmation token">
        <input
          className={guestFieldClass}
          value={props.token}
          autoComplete="off"
          onChange={(event) => props.onToken(event.target.value)}
        />
      </Field>
      {props.error ? <Notice>{props.error}</Notice> : null}
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
  currency: string;
  destinations: CatalogueDestination[];
  draft: GuestDraft;
  onDirection: (direction: Direction) => void;
  onKind: (kind: PlaceKind) => void;
  onPickup: (value: string) => void;
  onDestination: (destination: CatalogueDestination) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const choices = props.destinations
    .filter((item) => item.kind === props.draft.placeKind)
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const selected = props.destinations.find((item) => item.id === props.draft.destinationId);
  const ready = Boolean(props.draft.destinationId) && Boolean(props.draft.pickupText.trim());
  return (
    <form
      className="flex flex-1 flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) props.onNext();
      }}
    >
      <StepProgress steps={BOOK_STEPS} current="Journey" />
      <StepTitle
        title="Transfer"
        note="Select a destination. The price is this hotel’s quoted transfer rate."
      />
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
      <fieldset>
        <legend className="mb-2 text-xs tracking-widest text-muted uppercase">Destination</legend>
        {choices.length === 0 ? (
          <EmptyState title="No destinations of this type are available." />
        ) : (
          <div className="flex flex-col gap-2">
            {choices.map((item) => {
              const active = item.id === props.draft.destinationId;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`flex min-h-14 items-center justify-between border px-4 text-left text-sm font-medium ${active ? "border-ink bg-ink text-canvas" : "border-line bg-surface text-ink"}`}
                  onClick={() => props.onDestination(item)}
                >
                  <span>{item.name}</span>
                  <span className="tabular-nums">{formatQuotedPrice(props.currency, item.amountMinor)}</span>
                </button>
              );
            })}
          </div>
        )}
      </fieldset>
      <Field label="Pickup">
        <input
          className={guestFieldClass}
          value={props.draft.pickupText}
          onChange={(event) => props.onPickup(event.target.value)}
        />
      </Field>
      {selected ? (
        <p className="text-sm text-muted">
          Quoted price {formatQuotedPrice(props.currency, selected.amountMinor)}
        </p>
      ) : null}
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
      <StepProgress steps={BOOK_STEPS} current="When" />
      <StepTitle title="When" note="Use the hotel’s local date and time. If a time cannot be booked, choose another." />
      <Field label="Date">
        <input
          type="date"
          className={guestFieldClass}
          value={props.draft.transferDate}
          onChange={(event) => props.onDate(event.target.value)}
        />
      </Field>
      <Field label="Pickup time">
        <input
          type="time"
          className={guestFieldClass}
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
      <StepProgress steps={BOOK_STEPS} current="Party" />
      <StepTitle title="Party" note="How many people and bags are travelling." />
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
      <StepProgress steps={BOOK_STEPS} current="Contact" />
      <StepTitle title="Contact" note="Used for the driver and your confirmation." />
      <Field label="Name">
        <input className={guestFieldClass} value={props.draft.guestName} onChange={(event) => props.onName(event.target.value)} />
      </Field>
      <Field label="Phone">
        <input
          className={guestFieldClass}
          type="tel"
          value={props.draft.guestPhone}
          onChange={(event) => props.onPhone(event.target.value)}
        />
      </Field>
      <Field label="Email">
        <input
          className={guestFieldClass}
          type="email"
          value={props.draft.guestEmail}
          onChange={(event) => props.onEmail(event.target.value)}
        />
      </Field>
      <Field label="Room or flight number">
        <input
          className={guestFieldClass}
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
  currency: string;
  destinations: CatalogueDestination[];
  draft: GuestDraft;
  error: string | null;
  busy: boolean;
  preview?: boolean;
  onSubmit: () => void;
  onBack: () => void;
}) {
  const selected = props.destinations.find((item) => item.id === props.draft.destinationId);
  const destinationName = selected?.name ?? props.draft.destinationText;
  const priceLabel = selected
    ? formatQuotedPrice(props.currency, selected.amountMinor)
    : "To be confirmed";
  return (
    <form
      className="flex flex-1 flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      <StepProgress steps={BOOK_STEPS} current="Review" />
      <StepTitle title="Review" note="Check the details. The price is this hotel’s quoted transfer rate." />
      <dl className="divide-y divide-line border border-line bg-surface">
        <DefinitionRow label="Hotel" value={props.hotelName} />
        <DefinitionRow label="Direction" value={props.draft.direction === "from_hotel" ? `From ${props.hotelName}` : `To ${props.hotelName}`} />
        <DefinitionRow label="Pickup" value={props.draft.pickupText} />
        <DefinitionRow label="Destination" value={destinationName} />
        <DefinitionRow label="When" value={`${props.draft.transferDate} · ${props.draft.pickupTime} · ${props.draft.durationMinutes} min`} />
        <DefinitionRow label="Party" value={`${props.draft.passengerCount} passengers · ${props.draft.luggageCount} bags`} />
        <DefinitionRow label="Guest" value={props.draft.guestName} />
        <DefinitionRow label="Price" value={priceLabel} />
      </dl>
      {props.error ? <Notice>{props.error}</Notice> : null}
      {props.preview ? <Notice>This is a preview. No booking will be created.</Notice> : null}
      <Actions
        back={props.onBack}
        nextLabel={props.preview ? "Preview only" : props.busy ? "Booking…" : "Confirm booking"}
        nextDisabled={props.preview || props.busy || !props.draft.destinationId}
      />
    </form>
  );
}

function StepTitle({ title, note }: { title: string; note: string }) {
  return (
    <div>
      <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted">{note}</p>
    </div>
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
  const cols = options.length > 2 ? "grid-cols-2" : "grid-cols-2";
  return (
    <fieldset>
      <legend className="mb-2 text-xs tracking-widest text-muted uppercase">{label}</legend>
      <div className={`grid gap-2 ${cols}`}>
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
          className="flex min-h-14 min-w-14 items-center justify-center border border-line bg-surface text-2xl"
          onClick={() => onChange(Math.max(min, value - 1))}
          aria-label={`Decrease ${label}`}
        >
          −
        </button>
        <p className="flex-1 text-center text-3xl font-semibold tabular-nums">{value}</p>
        <button
          type="button"
          className="flex min-h-14 min-w-14 items-center justify-center border border-line bg-surface text-2xl"
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
      <GuestPrimaryButton type="submit" disabled={nextDisabled}>
        {nextLabel}
      </GuestPrimaryButton>
      <GuestSecondaryButton type="button" onClick={back}>
        Back
      </GuestSecondaryButton>
    </div>
  );
}

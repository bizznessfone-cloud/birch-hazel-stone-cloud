import { useMemo, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
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

type Step = "landing" | "find" | "journey" | "when" | "party" | "contact" | "review";

const PLACE_KINDS: PlaceKind[] = ["airport", "port", "hotel", "other"];

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
}: {
  hotelCode: string;
  hotelName: string;
  currency: string;
  destinations: CatalogueDestination[];
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
        search: { email: result.booking.confirmationEmailStatus },
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
                draft={draft}
                currency={currency}
                submitting={submitting}
                error={submitError}
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
    <main className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-6 text-center text-ink">
      <div className="w-full max-w-md">
        <p className="text-xs tracking-widest text-muted uppercase">{hotelName}</p>
        <h1 className="mt-5 text-4xl font-semibold tracking-tight">Book your transfer</h1>
        <p className="mt-4 text-base leading-relaxed text-muted">Simple hotel-to-destination transfers, confirmed in minutes.</p>
        <button type="button" onClick={onBook} className="mt-10 flex min-h-14 w-full items-center justify-center bg-ink px-5 text-base font-medium text-canvas">
          Book a transfer
        </button>
        <button type="button" onClick={onFind} className="mt-3 flex min-h-14 w-full items-center justify-center border border-line px-5 text-base font-medium">
          View my booking
        </button>
      </div>
    </main>
  );
}

function FindStep({
  token,
  error,
  busy,
  onToken,
  onLookup,
  onBack,
}: {
  token: string;
  error: string | null;
  busy: boolean;
  onToken: (value: string) => void;
  onLookup: () => void;
  onBack: () => void;
}) {
  return (
    <section>
      <p className="text-xs tracking-widest text-muted uppercase">Your booking</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">Open confirmation</h1>
      <p className="mt-3 text-base leading-relaxed text-muted">Use the secure confirmation link you received. A booking reference alone cannot open your booking.</p>
      <label className="mt-8 block text-xs tracking-widest text-muted uppercase" htmlFor="confirmation-token">Confirmation token</label>
      <input id="confirmation-token" value={token} onChange={(event) => onToken(event.target.value)} autoComplete="off" className="mt-2 min-h-14 w-full border border-line bg-transparent px-4 text-sm outline-none" />
      {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
      <button type="button" onClick={onLookup} disabled={busy || !token.trim()} className="mt-6 flex min-h-14 w-full items-center justify-center bg-ink px-5 text-base font-medium text-canvas disabled:opacity-40">
        {busy ? "Checking…" : "View my booking"}
      </button>
      <button type="button" onClick={onBack} className="mt-3 flex min-h-14 w-full items-center justify-center border border-line px-5 text-base font-medium">Back</button>
    </section>
  );
}

function JourneyStep({
  hotelName,
  currency,
  destinations,
  draft,
  onDirection,
  onKind,
  onPickup,
  onDestination,
  onNext,
  onBack,
}: {
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
  const filtered = destinations.filter((destination) => destination.kind === draft.placeKind);
  return (
    <section>
      <p className="text-xs tracking-widest text-muted uppercase">Journey</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">Where are you going?</h1>
      <p className="mt-3 text-base leading-relaxed text-muted">Choose your transfer direction and destination.</p>
      <div className="mt-7 grid grid-cols-2 gap-2">
        <ChoiceButton active={draft.direction === "from_hotel"} onClick={() => onDirection("from_hotel")}>From hotel</ChoiceButton>
        <ChoiceButton active={draft.direction === "to_hotel"} onClick={() => onDirection("to_hotel")}>To hotel</ChoiceButton>
      </div>
      <label className="mt-7 block text-xs tracking-widest text-muted uppercase">Destination type</label>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {PLACE_KINDS.map((kind) => <ChoiceButton key={kind} active={draft.placeKind === kind} onClick={() => onKind(kind)}>{placeKindLabel(kind)}</ChoiceButton>)}
      </div>
      <label className="mt-7 block text-xs tracking-widest text-muted uppercase" htmlFor="pickup-text">Pickup</label>
      <input id="pickup-text" value={draft.pickupText} onChange={(event) => onPickup(event.target.value)} className="mt-2 min-h-14 w-full border border-line bg-transparent px-4 text-sm outline-none" />
      <label className="mt-7 block text-xs tracking-widest text-muted uppercase">Destination</label>
      <div className="mt-2 space-y-2">
        {filtered.map((destination) => (
          <button key={destination.id} type="button" onClick={() => onDestination(destination)} className={`flex min-h-14 w-full items-center justify-between border px-4 text-left ${draft.destinationId === destination.id ? "border-ink" : "border-line"}`}>
            <span className="text-sm font-medium">{destination.name}</span>
            <span className="text-sm text-muted">{formatQuotedPrice(currency, destination.amountMinor)}</span>
          </button>
        ))}
        {!filtered.length ? <p className="border border-line px-4 py-4 text-sm text-muted">No destinations are available for this type.</p> : null}
      </div>
      <button type="button" onClick={onNext} disabled={!draft.destinationId || !draft.pickupText.trim()} className="mt-7 flex min-h-14 w-full items-center justify-center bg-ink px-5 text-base font-medium text-canvas disabled:opacity-40">Continue</button>
      <button type="button" onClick={onBack} className="mt-3 flex min-h-14 w-full items-center justify-center border border-line px-5 text-base font-medium">Back</button>
    </section>
  );
}

function WhenStep({ draft, onDate, onTime, onDuration, onNext, onBack }: { draft: GuestDraft; onDate: (value: string) => void; onTime: (value: string) => void; onDuration: (value: number) => void; onNext: () => void; onBack: () => void }) {
  return (
    <section>
      <p className="text-xs tracking-widest text-muted uppercase">When</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">When do you travel?</h1>
      <label className="mt-8 block text-xs tracking-widest text-muted uppercase" htmlFor="transfer-date">Date</label>
      <input id="transfer-date" type="date" value={draft.transferDate} onChange={(event) => onDate(event.target.value)} className="mt-2 min-h-14 w-full border border-line bg-transparent px-4 text-sm" />
      <label className="mt-6 block text-xs tracking-widest text-muted uppercase" htmlFor="pickup-time">Pickup time</label>
      <input id="pickup-time" type="time" value={draft.pickupTime} onChange={(event) => onTime(event.target.value)} className="mt-2 min-h-14 w-full border border-line bg-transparent px-4 text-sm" />
      <label className="mt-6 block text-xs tracking-widest text-muted uppercase" htmlFor="duration">Duration</label>
      <input id="duration" type="number" min={15} step={15} value={draft.durationMinutes} onChange={(event) => onDuration(Number(event.target.value))} className="mt-2 min-h-14 w-full border border-line bg-transparent px-4 text-sm" />
      <button type="button" onClick={onNext} className="mt-8 flex min-h-14 w-full items-center justify-center bg-ink px-5 text-base font-medium text-canvas">Continue</button>
      <button type="button" onClick={onBack} className="mt-3 flex min-h-14 w-full items-center justify-center border border-line px-5 text-base font-medium">Back</button>
    </section>
  );
}

function PartyStep({ draft, hint, onPassengers, onLuggage, onNext, onBack }: { draft: GuestDraft; hint: string; onPassengers: (value: number) => void; onLuggage: (value: number) => void; onNext: () => void; onBack: () => void }) {
  return (
    <section>
      <p className="text-xs tracking-widest text-muted uppercase">Party</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">How many are travelling?</h1>
      <label className="mt-8 block text-xs tracking-widest text-muted uppercase" htmlFor="passengers">Passengers</label>
      <input id="passengers" type="number" min={1} value={draft.passengerCount} onChange={(event) => onPassengers(Number(event.target.value))} className="mt-2 min-h-14 w-full border border-line bg-transparent px-4 text-sm" />
      <label className="mt-6 block text-xs tracking-widest text-muted uppercase" htmlFor="luggage">Bags</label>
      <input id="luggage" type="number" min={0} value={draft.luggageCount} onChange={(event) => onLuggage(Number(event.target.value))} className="mt-2 min-h-14 w-full border border-line bg-transparent px-4 text-sm" />
      <p className="mt-4 text-sm text-muted">{hint}</p>
      <button type="button" onClick={onNext} className="mt-8 flex min-h-14 w-full items-center justify-center bg-ink px-5 text-base font-medium text-canvas">Continue</button>
      <button type="button" onClick={onBack} className="mt-3 flex min-h-14 w-full items-center justify-center border border-line px-5 text-base font-medium">Back</button>
    </section>
  );
}

function ContactStep({ draft, onName, onPhone, onEmail, onSpecial, onNext, onBack }: { draft: GuestDraft; onName: (value: string) => void; onPhone: (value: string) => void; onEmail: (value: string) => void; onSpecial: (value: string) => void; onNext: () => void; onBack: () => void }) {
  return (
    <section>
      <p className="text-xs tracking-widest text-muted uppercase">Contact</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">Where should we send confirmation?</h1>
      <label className="mt-8 block text-xs tracking-widest text-muted uppercase" htmlFor="guest-name">Name</label>
      <input id="guest-name" value={draft.guestName} onChange={(event) => onName(event.target.value)} className="mt-2 min-h-14 w-full border border-line bg-transparent px-4 text-sm" />
      <label className="mt-6 block text-xs tracking-widest text-muted uppercase" htmlFor="guest-phone">Phone</label>
      <input id="guest-phone" type="tel" value={draft.guestPhone} onChange={(event) => onPhone(event.target.value)} className="mt-2 min-h-14 w-full border border-line bg-transparent px-4 text-sm" />
      <label className="mt-6 block text-xs tracking-widest text-muted uppercase" htmlFor="guest-email">Email</label>
      <input id="guest-email" type="email" value={draft.guestEmail} onChange={(event) => onEmail(event.target.value)} className="mt-2 min-h-14 w-full border border-line bg-transparent px-4 text-sm" />
      <label className="mt-6 block text-xs tracking-widest text-muted uppercase" htmlFor="special-requirements">Special requirements</label>
      <textarea id="special-requirements" value={draft.specialRequirements} onChange={(event) => onSpecial(event.target.value)} rows={4} className="mt-2 w-full border border-line bg-transparent px-4 py-3 text-sm" />
      <button type="button" onClick={onNext} disabled={!draft.guestName.trim() || !draft.guestPhone.trim() || !draft.guestEmail.trim()} className="mt-8 flex min-h-14 w-full items-center justify-center bg-ink px-5 text-base font-medium text-canvas disabled:opacity-40">Review booking</button>
      <button type="button" onClick={onBack} className="mt-3 flex min-h-14 w-full items-center justify-center border border-line px-5 text-base font-medium">Back</button>
    </section>
  );
}

function ReviewStep({ draft, currency, submitting, error, onSubmit, onBack }: { draft: GuestDraft; currency: string; submitting: boolean; error: string | null; onSubmit: () => void; onBack: () => void }) {
  return (
    <section>
      <p className="text-xs tracking-widest text-muted uppercase">Review</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">Confirm your transfer</h1>
      <div className="mt-8 divide-y divide-line border border-line">
        <Row label="Date" value={`${draft.transferDate} · ${draft.pickupTime}`} />
        <Row label="Pickup" value={draft.pickupText} />
        <Row label="Destination" value={draft.destinationText || "—"} />
        <Row label="Party" value={`${draft.passengerCount} passengers · ${draft.luggageCount} bags`} />
        <Row label="Guest" value={draft.guestName} />
        <Row label="Email" value={draft.guestEmail} />
        <Row label="Price" value={draft.destinationId ? currency : "—"} />
      </div>
      {error ? <p className="mt-4 text-sm text-red-700">{error}</p> : null}
      <button type="button" onClick={onSubmit} disabled={submitting} className="mt-8 flex min-h-14 w-full items-center justify-center bg-ink px-5 text-base font-medium text-canvas disabled:opacity-40">{submitting ? "Booking…" : "Confirm transfer"}</button>
      <button type="button" onClick={onBack} disabled={submitting} className="mt-3 flex min-h-14 w-full items-center justify-center border border-line px-5 text-base font-medium">Back</button>
    </section>
  );
}

function ChoiceButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" onClick={onClick} className={`min-h-12 border px-3 text-sm font-medium ${active ? "border-ink" : "border-line"}`}>{children}</button>;
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex items-start justify-between gap-4 px-4 py-3"><span className="text-xs tracking-widest text-muted uppercase">{label}</span><span className="text-right text-sm font-medium">{value}</span></div>;
}

function Button({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return <button {...props}>{children}</button>;
}

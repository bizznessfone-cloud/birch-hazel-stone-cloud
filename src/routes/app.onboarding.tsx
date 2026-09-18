import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import {
  createOnboardingDestination,
  createOnboardingHotel,
  createOnboardingService,
  getOnboardingState,
  prepareOnboardingHotel,
} from "@/lib/aether/onboarding-fns";

export const Route = createFileRoute("/app/onboarding")({
  loader: () => getOnboardingState(),
  component: Onboarding,
});

function Onboarding() {
  const result = Route.useLoaderData();
  const router = useRouter();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [locality, setLocality] = useState("");
  const [timezone, setTimezone] = useState("Europe/Athens");
  const [currency, setCurrency] = useState("EUR");
  const [serviceName, setServiceName] = useState("Hotel Transfers");
  const [destinationKind, setDestinationKind] = useState<"airport" | "port" | "hotel" | "other">("airport");
  const [destinationName, setDestinationName] = useState("");
  const [price, setPrice] = useState("");
  const [hotelId, setHotelId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!result.ok) return <p className="text-sm text-muted">{result.message}</p>;
  const current = hotelId ? result.hotels.find((x) => x.hotel.id === hotelId) : result.hotels[0];
  const activeHotelId = hotelId ?? current?.hotel.id ?? null;
  const hotel = current?.hotel ?? null;
  const service = current?.services[0] ?? null;
  const destination = current?.destinations[0] ?? null;

  async function refresh() { await router.invalidate(); }

  async function createHotel() {
    setBusy(true); setMessage(null);
    try {
      const r = await createOnboardingHotel({ data: { code, name, locality, ianaTimezone: timezone, currency } });
      if (!r.ok) { setMessage(r.message); return; }
      setHotelId(r.hotelId); await refresh();
    } finally { setBusy(false); }
  }

  async function createService() {
    if (!activeHotelId) return;
    setBusy(true); setMessage(null);
    try {
      const r = await createOnboardingService({ data: { hotelId: activeHotelId, name: serviceName } });
      if (!r.ok) { setMessage(r.message); return; }
      await refresh();
    } finally { setBusy(false); }
  }

  async function createDestination() {
    if (!activeHotelId) return;
    setBusy(true); setMessage(null);
    try {
      const amountMinor = Math.round(Number(price) * 100);
      const r = await createOnboardingDestination({ data: { hotelId: activeHotelId, kind: destinationKind, name: destinationName, amountMinor } });
      if (!r.ok) { setMessage(r.message); return; }
      await refresh();
    } finally { setBusy(false); }
  }

  async function configure() {
    if (!activeHotelId) return;
    setBusy(true); setMessage(null);
    try {
      const r = await prepareOnboardingHotel({ data: { hotelId: activeHotelId } });
      if (!r.ok) { setMessage(r.message); return; }
      await refresh();
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-8">
      <div>
        <p className="text-xs font-medium tracking-[0.2em] text-muted uppercase">Setup</p>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight">Get your hotel ready</h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
          Create the hotel, add your first transfer service, choose a destination and price, then preview the booking page.
        </p>
      </div>
      {message ? <p className="border border-line px-4 py-3 text-sm">{message}</p> : null}
      {!hotel ? (
        <section className="border border-line bg-surface p-5">
          <Step n="1" title="Hotel">
            <Field label="Hotel name" value={name} setValue={setName} placeholder="Blue Lagoon" />
            <Field label="Booking code" value={code} setValue={setCode} placeholder="blue-lagoon" />
            <Field label="City / country" value={locality} setValue={setLocality} placeholder="Kos, Greece" />
            <Field label="Timezone" value={timezone} setValue={setTimezone} placeholder="Europe/Athens" />
            <Field label="Currency" value={currency} setValue={setCurrency} placeholder="EUR" />
            <button disabled={busy || !name || !code || !locality} onClick={() => void createHotel()} className="mt-5 min-h-12 bg-ink px-4 text-sm font-semibold tracking-wide text-canvas uppercase disabled:opacity-50">{busy ? "Creating…" : "Create hotel"}</button>
          </Step>
        </section>
      ) : (
        <>
          <section className="border border-line bg-surface p-5"><Step n="1" title="Hotel"><p className="text-lg font-semibold">{hotel.name}</p><p className="mt-1 text-sm text-muted">{hotel.locality} · {hotel.iana_timezone} · {hotel.currency}</p><p className="mt-2 text-xs tracking-widest text-muted uppercase">/{hotel.public_slug}</p></Step></section>
          {!service ? <section className="border border-line bg-surface p-5"><Step n="2" title="First service"><Field label="Service name" value={serviceName} setValue={setServiceName} placeholder="Hotel Transfers" /><button disabled={busy || !serviceName} onClick={() => void createService()} className="mt-5 min-h-12 bg-ink px-4 text-sm font-semibold tracking-wide text-canvas uppercase disabled:opacity-50">{busy ? "Saving…" : "Add service"}</button></Step></section> : null}
          {!destination ? <section className="border border-line bg-surface p-5"><Step n="3" title="First destination and price"><label className="block"><span className="mb-2 block text-xs font-medium tracking-widest text-muted uppercase">Type</span><select className="min-h-12 w-full border border-line bg-transparent px-3" value={destinationKind} onChange={(e) => setDestinationKind(e.target.value as typeof destinationKind)}><option value="airport">Airport</option><option value="port">Port</option><option value="hotel">Hotel</option><option value="other">Other</option></select></label><div className="mt-4"><Field label="Destination" value={destinationName} setValue={setDestinationName} placeholder="Kos Airport" /></div><div className="mt-4"><Field label={"Price (" + hotel.currency + ")"} value={price} setValue={setPrice} placeholder="35.00" /></div><button disabled={busy || !destinationName || !price} onClick={() => void createDestination()} className="mt-5 min-h-12 bg-ink px-4 text-sm font-semibold tracking-wide text-canvas uppercase disabled:opacity-50">{busy ? "Saving…" : "Add destination"}</button></Step></section> : null}
          {service && destination ? <section className="border border-line bg-surface p-5"><Step n="4" title="Preview and QR"><p className="text-sm text-muted">Your guest booking page is ready for preview.</p><div className="mt-4 border border-line px-4 py-4"><p className="text-xs tracking-widest text-muted uppercase">QR destination</p><p className="mt-2 break-all text-sm font-medium">/book/{hotel.code}</p><p className="mt-2 text-sm text-muted">{service.name} · {destination.name} · {hotel.currency} {(Number(destination.amount_minor) / 100).toFixed(2)}</p></div><div className="mt-4 flex flex-wrap gap-3">{hotel.status === "unconfigured" ? <button disabled={busy} onClick={() => void configure()} className="min-h-12 bg-ink px-4 py-3 text-sm font-semibold tracking-wide text-canvas uppercase disabled:opacity-50">{busy ? "Preparing…" : "Prepare hotel for activation"}</button> : <p className="py-3 text-sm font-medium">Hotel is configured. Next step is plan and Stripe activation.</p>}<Link to="/app/hotels/$hotelId/preview" params={{ hotelId: activeHotelId! }} className="min-h-12 border border-line px-4 py-3 text-sm font-semibold tracking-wide uppercase">Preview</Link><Link to="/app/hotels/$hotelId/qr" params={{ hotelId: activeHotelId! }} className="min-h-12 border border-line px-4 py-3 text-sm font-semibold tracking-wide uppercase">Open QR / Print</Link></div></Step></section> : null}
        </>
      )}
    </div>
  );
}

function Step({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return <div><p className="text-xs font-medium tracking-widest text-muted uppercase">Step {n}</p><h2 className="mt-1 text-xl font-semibold">{title}</h2><div className="mt-5">{children}</div></div>;
}
function Field({ label, value, setValue, placeholder }: { label: string; value: string; setValue: (value: string) => void; placeholder: string }) {
  return <label className="mt-4 block first:mt-0"><span className="mb-2 block text-xs font-medium tracking-widest text-muted uppercase">{label}</span><input className="min-h-12 w-full border border-line bg-transparent px-3 outline-none focus:border-ink" value={value} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} /></label>;
}

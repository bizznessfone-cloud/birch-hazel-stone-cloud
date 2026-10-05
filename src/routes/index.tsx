import { createFileRoute } from "@tanstack/react-router";
import { PublicFooter, PublicHeader } from "@/components/aether/ui";
import { ThemeToggle } from "@/components/aether/theme-toggle";
import {
  DeviceFrame,
  GuestArrivalPlate,
  GuestJourneyPlate,
  PresentationQr,
} from "@/components/aether/public-stage";

const DESCRIPTION =
  "A hotel's own transfer booking page. Guests scan a QR code or open a link, book, and go. No guest account. No app.";

export const Route = createFileRoute("/")({
  component: Home,
});

const NAV = [
  { href: "#product", label: "Product" },
  { href: "#how", label: "How it works" },
  { href: "#hotels", label: "For hotels" },
] as const;

const STEPS = [
  ["SCAN.", "The guest opens the hotel's QR code or its booking link."],
  ["BOOK.", "The journey is entered on that page. No guest account. No app."],
  ["GO.", "The guest keeps a confirmation and a private link. The hotel runs the transfer."],
] as const;

const FLOW = [
  ["Hotel", "The property is the front door."],
  ["QR", "Or the hotel's booking link."],
  ["Guest", "They open it on their phone."],
  ["Booking", "The journey is captured there."],
  ["Operation", "The transfer is ready to run."],
] as const;

function NavLinks({ stacked = false }: { stacked?: boolean }) {
  return (
    <>
      {NAV.map((item) => (
        <a key={item.href} href={item.href} className={`inline-flex min-h-11 items-center px-3 text-ink ${stacked ? "text-sm" : "text-base"}`}>
          {item.label}
        </a>
      ))}
      <a
        href="#start"
        className={`inline-flex min-h-11 items-center justify-center bg-ink px-4 font-medium text-canvas ${stacked ? "mt-2 text-sm" : "text-base"}`}
      >
        Get started
      </a>
    </>
  );
}

function Home() {
  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <PublicHeader wide>
        <nav className="hidden items-center gap-1 lg:flex" aria-label="Primary">
          <NavLinks />
        </nav>
        <details className="relative lg:hidden">
          <summary className="flex min-h-11 cursor-pointer list-none items-center px-3 text-sm [&::-webkit-details-marker]:hidden">
            Menu
          </summary>
          <nav aria-label="Primary" className="absolute right-0 z-10 mt-2 flex w-56 flex-col border border-line bg-surface p-2">
            <NavLinks stacked />
          </nav>
        </details>
        <ThemeToggle />
      </PublicHeader>

      <main>
        <section id="product" className="scroll-mt-6">
          <div className="sbg-container sbg-container-wide grid items-end gap-14 py-14 md:py-20 lg:grid-cols-[minmax(0,1.15fr)_auto] lg:gap-16 lg:py-28">
            <div>
              <p className="text-2xl font-semibold tracking-tight md:text-3xl">SCAN. BOOK. GO.</p>
              <p className="sbg-label mt-8">For hotels</p>
              <h1 className="mt-4 max-w-4xl text-[clamp(3.25rem,7.4vw,6.75rem)] leading-[0.9] font-semibold tracking-tight">
                Hotel transfers. Without the friction.
              </h1>
              <p className="sbg-body mt-8 max-w-md text-muted">{DESCRIPTION}</p>
              <p className="mt-4 max-w-md text-sm leading-relaxed text-muted">
                A private transfer operator uses the same system.
              </p>
              <div className="mt-10 flex flex-col gap-3 sm:flex-row">
                <a href="#start" className="inline-flex min-h-12 items-center justify-center bg-ink px-6 text-sm font-medium text-canvas">
                  Get started
                </a>
                <a href="#how" className="inline-flex min-h-12 items-center justify-center px-6 text-sm font-medium text-ink">
                  See how it works
                </a>
              </div>
            </div>
            <div className="flex items-end justify-start gap-6 sm:gap-8 lg:justify-end">
              <div className="mb-16 hidden w-24 shrink-0 sm:block">
                <PresentationQr className="h-24 w-24 text-ink" />
                <p className="sbg-meta mt-3">Artwork only. Not a live hotel code.</p>
              </div>
              <DeviceFrame presence caption="The guest page. Shown here. It does not start a booking.">
                <GuestArrivalPlate />
              </DeviceFrame>
            </div>
            <div className="flex items-center gap-4 sm:hidden">
              <PresentationQr className="h-16 w-16 shrink-0 text-ink" />
              <p className="sbg-meta">A hotel QR, drawn as artwork. It does not open a booking.</p>
            </div>
          </div>
        </section>

        <section id="how" className="scroll-mt-6">
          <div className="sbg-container sbg-container-wide py-8 md:py-16">
            <ol>
              {STEPS.map(([word, note]) => (
                <li key={word} className="grid items-end gap-3 border-t border-line py-8 md:grid-cols-[minmax(0,1fr)_18rem] md:py-10">
                  <h2 className="text-[clamp(4.5rem,15vw,10.5rem)] leading-[0.82] font-semibold tracking-tight">{word}</h2>
                  <p className="max-w-xs pb-2 text-base leading-relaxed text-muted md:pb-4">{note}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="hotels" className="scroll-mt-6">
          <div className="sbg-container sbg-container-wide grid items-start gap-10 py-20 md:py-28 lg:grid-cols-[auto_minmax(0,1fr)] lg:gap-14">
            <DeviceFrame presence caption="The hotel's destinations, on the guest's phone.">
              <GuestJourneyPlate />
            </DeviceFrame>
            <div>
              <h2 className="max-w-xl text-[clamp(2.75rem,5vw,4.75rem)] leading-[0.95] font-semibold tracking-tight">
                A booking page that belongs to the hotel.
              </h2>
              <p className="mt-6 max-w-md text-lg leading-relaxed text-muted">
                Each hotel has its own address and QR. Guests are not sent through a marketplace.
              </p>
            </div>
          </div>
          <div className="sbg-container sbg-container-wide pb-20 md:pb-32">
            <div className="grid gap-x-16 gap-y-10 md:grid-cols-2">
              <p className="text-[clamp(2rem,4vw,3.25rem)] leading-none font-semibold tracking-tight">No guest account.</p>
              <p className="max-w-sm self-end text-base leading-relaxed text-muted">
                A guest does not register, and does not install an app, to book the transfer.
              </p>
              <p className="text-[clamp(2rem,4vw,3.25rem)] leading-none font-semibold tracking-tight">A private link.</p>
              <p className="max-w-sm self-end text-base leading-relaxed text-muted">
                The booking ends on a confirmation the guest can keep. The hotel can see it and run it.
              </p>
            </div>
          </div>
        </section>

        <section id="flow" className="scroll-mt-6">
          <div className="sbg-container sbg-container-wide py-16 md:py-28">
            <h2 className="max-w-3xl text-[clamp(2.5rem,5vw,4.5rem)] leading-[0.95] font-semibold tracking-tight">
              From the hotel to the transfer.
            </h2>
            <ol className="mt-14 grid gap-8 md:mt-20 md:grid-cols-2 lg:grid-cols-5 lg:gap-6">
              {FLOW.map(([title, note], index) => (
                <li key={title} className="border-t border-line pt-4">
                  <p className="sbg-label">{String(index + 1).padStart(2, "0")}</p>
                  <h3 className="mt-3 text-2xl font-semibold tracking-tight md:text-3xl">{title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{note}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="start" className="scroll-mt-6">
          <div className="sbg-container sbg-container-wide py-24 md:py-40">
            <p className="sbg-label">The next step</p>
            <h2 className="mt-5 max-w-4xl text-[clamp(3rem,7vw,6.25rem)] leading-[0.92] font-semibold tracking-tight">
              Activate your
              <br />
              SCAN BOOK GO system.
            </h2>
            <p className="mt-8 max-w-md text-lg leading-relaxed text-muted">
              Start taking transfer bookings with a system built around your operation. This page does not create an account.
            </p>
            <a href="#start" className="mt-10 inline-flex min-h-14 items-center justify-center bg-ink px-8 text-sm font-medium text-canvas">
              Get started
            </a>
          </div>
        </section>
      </main>

      <PublicFooter wide>
        <span>Guest bookings stay on the hotel's own link.</span>
      </PublicFooter>
    </div>
  );
}

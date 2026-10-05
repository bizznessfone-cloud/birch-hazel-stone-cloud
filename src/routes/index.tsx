import { createFileRoute } from "@tanstack/react-router";
import { Container, PublicFooter, PublicHeader, Section } from "@/components/aether/ui";
import { ThemeToggle } from "@/components/aether/theme-toggle";

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

function NavLinks({ stacked = false }: { stacked?: boolean }) {
  return (
    <>
      {NAV.map((item) => (
        <a
          key={item.href}
          href={item.href}
          className={`inline-flex min-h-11 items-center text-sm text-ink ${stacked ? "px-3" : "px-3"}`}
        >
          {item.label}
        </a>
      ))}
      <a
        href="#start"
        className={`inline-flex min-h-11 items-center justify-center bg-ink px-4 text-sm font-medium text-canvas ${stacked ? "mt-1" : ""}`}
      >
        Get started
      </a>
    </>
  );
}

function Home() {
  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <PublicHeader>
        <nav className="hidden items-center gap-1 md:flex" aria-label="Primary">
          <NavLinks />
        </nav>
        <details className="relative md:hidden">
          <summary className="flex min-h-11 cursor-pointer list-none items-center border border-line px-3 text-sm [&::-webkit-details-marker]:hidden">
            Menu
          </summary>
          <nav
            aria-label="Primary"
            className="absolute right-0 z-10 mt-2 flex w-56 flex-col border border-line bg-surface p-2"
          >
            <NavLinks stacked />
          </nav>
        </details>
        <ThemeToggle />
      </PublicHeader>

      <main>
        <Section id="product" className="scroll-mt-6">
          <Container>
            <p className="sbg-label">Hotel transfer infrastructure</p>
            <h1 className="sbg-display mt-4 max-w-3xl">Hotel transfers. Without the friction.</h1>
            <p className="sbg-body mt-6 max-w-xl text-muted">{DESCRIPTION}</p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <a
                href="#start"
                className="inline-flex min-h-12 items-center justify-center bg-ink px-5 text-sm font-medium text-canvas"
              >
                Get started
              </a>
              <a
                href="#how"
                className="inline-flex min-h-12 items-center justify-center border border-line bg-surface px-5 text-sm font-medium text-ink"
              >
                See how it works
              </a>
            </div>
          </Container>
        </Section>

        <Section id="how" className="scroll-mt-6 border-t border-line">
          <Container>
            <h2 className="sbg-title">Scan. Book. Go.</h2>
            <p className="sbg-muted mt-3 max-w-xl">Three steps. Nothing else for the guest to install.</p>
            <ol className="mt-8 grid gap-px border border-line bg-line md:grid-cols-3">
              <li className="bg-canvas p-5">
                <p className="sbg-label">01 — Scan</p>
                <h3 className="sbg-panel-title mt-3">Open the hotel's page</h3>
                <p className="sbg-muted mt-2">The guest scans the hotel's QR code or opens its booking link.</p>
              </li>
              <li className="bg-canvas p-5">
                <p className="sbg-label">02 — Book</p>
                <h3 className="sbg-panel-title mt-3">Give the journey</h3>
                <p className="sbg-muted mt-2">Pickup, destination, time, and party. No guest account.</p>
              </li>
              <li className="bg-canvas p-5">
                <p className="sbg-label">03 — Go</p>
                <h3 className="sbg-panel-title mt-3">The transfer is booked</h3>
                <p className="sbg-muted mt-2">The guest gets a confirmation and a private link. The hotel can run the transfer.</p>
              </li>
            </ol>
          </Container>
        </Section>

        <Section id="hotels" className="scroll-mt-6 border-t border-line">
          <Container>
            <h2 className="sbg-title">A booking page that belongs to the hotel.</h2>
            <ul className="mt-8 grid gap-px border border-line bg-line md:grid-cols-2">
              <li className="bg-canvas p-5">
                <h3 className="sbg-panel-title">The hotel's own entry</h3>
                <p className="sbg-muted mt-2">Each hotel has a public address and a QR code. Guests are not sent through a marketplace.</p>
              </li>
              <li className="bg-canvas p-5">
                <h3 className="sbg-panel-title">No guest account</h3>
                <p className="sbg-muted mt-2">A guest does not register, and does not download an app, to book a transfer.</p>
              </li>
              <li className="bg-canvas p-5">
                <h3 className="sbg-panel-title">A clear confirmation</h3>
                <p className="sbg-muted mt-2">The booking ends on a confirmation page with a private link the guest can keep.</p>
              </li>
              <li className="bg-canvas p-5">
                <h3 className="sbg-panel-title">One operational list</h3>
                <p className="sbg-muted mt-2">Booked transfers are there for the hotel to see, assign, and run.</p>
              </li>
            </ul>
          </Container>
        </Section>

        <Section id="flow" className="scroll-mt-6 border-t border-line">
          <Container>
            <h2 className="sbg-title">From the hotel to the transfer.</h2>
            <ol className="mt-8 border border-line">
              {[
                ["Hotel", "The property is the front door."],
                ["QR or booking link", "That address is what the guest opens."],
                ["Guest booking", "The journey is captured on the hotel's page."],
                ["Transfer operation", "The booking is ready for the hotel to carry out."],
              ].map(([title, note], index) => (
                <li key={title} className="border-b border-line px-5 py-4 last:border-b-0">
                  <p className="sbg-label">{String(index + 1).padStart(2, "0")}</p>
                  <h3 className="sbg-panel-title mt-1">{title}</h3>
                  <p className="sbg-muted mt-1">{note}</p>
                </li>
              ))}
            </ol>
          </Container>
        </Section>

        <Section id="start" className="scroll-mt-6 border-t border-line">
          <Container>
            <h2 className="sbg-title">Start with the property.</h2>
            <p className="sbg-body mt-4 max-w-xl text-muted">
              A hotel is set up directly with SCAN BOOK GO. This page does not create an account, and it does not open a guest booking.
            </p>
          </Container>
        </Section>
      </main>

      <PublicFooter>
        <span>Guest bookings stay on the hotel's own link.</span>
      </PublicFooter>
    </div>
  );
}

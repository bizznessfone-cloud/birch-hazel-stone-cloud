import { createFileRoute, Link } from "@tanstack/react-router";
import { GUEST_LOCKUP } from "@/lib/aether/constants";
import { getFoundationStatus } from "@/lib/aether/health";
import { HotelMark } from "@/components/aether/hotel-mark";
import { ThemeToggle } from "@/components/aether/theme-toggle";

export const Route = createFileRoute("/")({
  loader: () => getFoundationStatus(),
  component: Home,
});

function Home() {
  const status = Route.useLoaderData();
  const available = status.ok;

  return (
    <main className="flex min-h-dvh flex-col bg-canvas text-ink">
      <header className="flex items-center justify-between px-6 py-6 md:px-10">
        <p className="text-xs font-medium tracking-widest text-muted uppercase">
          SCAN. BOOK. GO.
        </p>
        <ThemeToggle />
      </header>

      <section className="flex flex-1 flex-col items-center justify-center px-6 pb-24 text-center">
        <HotelMark name="Scan Book Go" size="lg" />
        <p className="mt-8 text-xs font-medium tracking-widest text-muted uppercase">
          Private hotel transfers
        </p>
        <h1 className="mt-6 max-w-3xl text-5xl leading-none font-semibold tracking-tight md:text-7xl">
          {GUEST_LOCKUP}
        </h1>
        <p className="mt-8 max-w-md text-base leading-relaxed text-muted md:text-lg">
          Scan the hotel QR. Book a transfer. Go. No guest account.
        </p>
        <div className="mt-12 flex w-full max-w-sm flex-col gap-3">
          {available ? (
            <Link
              to="/book/$hotelCode"
              params={{ hotelCode: "gate" }}
              className="flex min-h-14 w-full items-center justify-center bg-ink px-4 text-base font-semibold tracking-wide text-canvas uppercase"
            >
              Book transfer
            </Link>
          ) : (
            <p className="text-sm leading-relaxed text-muted">
              Transfers are temporarily unavailable. Please try again shortly.
            </p>
          )}
          <Link
            to="/login"
            className="flex min-h-12 w-full items-center justify-center border border-line px-4 text-sm font-semibold tracking-wide uppercase"
          >
            Hotel / operator sign in
          </Link>
        </div>
      </section>

      <footer className="border-t border-line px-6 py-5 md:px-10">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4">
          <p className="text-xs tracking-widest text-muted uppercase">
            {available ? "Ready" : "Unavailable"}
          </p>
          <Link to="/ops/login" className="text-xs tracking-widest text-muted uppercase">
            Desk
          </Link>
        </div>
      </footer>
    </main>
  );
}

import { createFileRoute, Link } from "@tanstack/react-router";
import { GUEST_LOCKUP, PRODUCT_NAME } from "@/lib/aether/constants";
import { getFoundationStatus } from "@/lib/aether/health";
import { HotelMark } from "@/components/aether/hotel-mark";
import { ThemeToggle } from "@/components/aether/theme-toggle";

export const Route = createFileRoute("/")({
  loader: () => getFoundationStatus(),
  component: Home,
});

function Home() {
  const status = Route.useLoaderData();

  return (
    <main className="flex min-h-dvh flex-col bg-canvas text-ink">
      <header className="flex items-center justify-between px-6 py-6 md:px-10">
        <p className="text-xs font-medium tracking-widest text-muted uppercase">
          {PRODUCT_NAME}
        </p>
        <ThemeToggle />
      </header>

      <section className="flex flex-1 flex-col items-center justify-center px-6 pb-24 text-center">
        <HotelMark name="Gate Hotel" size="lg" />
        <p className="mt-8 text-xs font-medium tracking-widest text-muted uppercase">
          Private hotel transfers
        </p>
        <h1 className="mt-6 max-w-3xl text-5xl leading-none font-semibold tracking-tight md:text-7xl">
          {GUEST_LOCKUP}
        </h1>
        <p className="mt-8 max-w-md text-base leading-relaxed text-muted md:text-lg">
          Reception books from the hotel page. No guest account. No payment at
          this step.
        </p>
        <div className="mt-12 flex w-full max-w-sm flex-col gap-3">
          <Link
            to="/book/$hotelCode"
            params={{ hotelCode: "gate" }}
            className="flex min-h-14 w-full items-center justify-center bg-ink px-4 text-base font-semibold tracking-wide text-canvas uppercase"
          >
            Book transfer
          </Link>
          <Link
            to="/login"
            className="flex min-h-12 w-full items-center justify-center border border-line px-4 text-sm font-semibold tracking-wide uppercase"
          >
            Hotel / operator sign in
          </Link>
        </div>
      </section>

      <footer className="border-t border-line px-6 py-5 md:px-10">
        {status.ok ? (
          <dl className="mx-auto grid max-w-4xl grid-cols-2 gap-4 text-left sm:grid-cols-4">
            <StatusItem label="Database" value={status.backend} />
            <StatusItem label="Schema" value={`phase ${status.schemaPhase}`} />
            <StatusItem label="Checkpoint" value={status.checkpoint} />
            <StatusItem
              label="Kysely"
              value={status.kyselyOk ? "connected" : "failed"}
            />
          </dl>
        ) : (
          <p className="text-sm text-muted">
            Database unavailable. Foundation gate has not passed.
          </p>
        )}
      </footer>
    </main>
  );
}

function StatusItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs tracking-widest text-muted uppercase">{label}</dt>
      <dd className="mt-1 text-sm font-medium">{value}</dd>
    </div>
  );
}

import { Link, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { UserButton } from "@/lib/auth/gates";
import { ThemeToggle } from "./theme-toggle";

const NAV = [
  { to: "/owner", label: "Overview", end: true },
  { to: "/owner/hotels", label: "Hotels", end: false },
  { to: "/owner/plans", label: "Plans & Pricing", end: false },
  { to: "/owner/revenue", label: "Revenue", end: false },
  { to: "/owner/system", label: "System", end: false },
] as const;

export function OwnerShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-ink">
      <header className="border-b border-line px-4 py-3 md:px-8">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs tracking-[0.22em] text-muted uppercase">SCAN / BOOK / GO</p>
            <p className="truncate text-sm font-semibold">Owner</p>
          </div>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <UserButton />
          </div>
        </div>
        <nav className="mx-auto mt-3 flex max-w-6xl gap-1 overflow-x-auto pb-1">
          {NAV.map((item) => {
            const active = item.end
              ? pathname === "/owner" || pathname === "/owner/"
              : pathname === item.to || pathname.startsWith(`${item.to}/`);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`flex min-h-11 shrink-0 items-center px-3 text-sm font-medium ${
                  active ? "bg-ink text-canvas" : "text-ink"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 md:px-8">{children}</main>
    </div>
  );
}

export function OwnerForbiddenPage() {
  return (
    <main className="grid min-h-dvh place-items-center bg-canvas px-6 text-ink">
      <div className="max-w-md text-center">
        <p className="text-xs tracking-[0.22em] text-muted uppercase">SCAN / BOOK / GO</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">Owner access required</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          This surface is the SCAN BOOK GO Owner Control Plane. Hotel ownership and
          operations-desk membership do not grant access.
        </p>
      </div>
    </main>
  );
}

export function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="border-t border-line py-3">
      <p className="text-xs tracking-widest text-muted uppercase">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
    </div>
  );
}

export function Panel({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="border border-line bg-surface p-5">
      <h2 className="text-xs font-medium tracking-[0.18em] text-muted uppercase">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

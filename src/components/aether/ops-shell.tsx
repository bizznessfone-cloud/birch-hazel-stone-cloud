import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { opsLogout } from "@/lib/aether/ops-fns";
import { csrfHeaders } from "@/lib/aether/csrf-client";
import { GUEST_LOCKUP } from "@/lib/aether/constants";
import { ThemeToggle } from "./theme-toggle";
import {
  Notice,
  PrimaryButton,
  SecondaryButton,
  compactButtonClass,
  fieldClass,
} from "./ui";

const NAV = [
  { to: "/ops", label: "Today" },
  { to: "/ops/bookings", label: "Bookings" },
  { to: "/ops/vehicles", label: "Vehicles" },
  { to: "/ops/drivers", label: "Drivers" },
  { to: "/ops/hotels", label: "Hotels" },
] as const;

export function OpsShell({
  login,
  children,
}: {
  login: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  async function signOut() {
    await opsLogout({ headers: csrfHeaders() });
    await navigate({ to: "/ops/login" });
  }

  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-ink">
      <header className="border-b border-line px-4 py-3">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs tracking-widest text-muted uppercase">{GUEST_LOCKUP}</p>
            <p className="truncate text-sm font-semibold">Desk · {login}</p>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <button type="button" className={compactButtonClass} onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </div>
        <nav className="mx-auto mt-3 flex max-w-3xl gap-1 overflow-x-auto pb-1">
          {NAV.map((item) => {
            const active =
              item.to === "/ops" ? pathname === "/ops" : pathname.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`flex min-h-11 shrink-0 items-center px-3 text-sm font-medium ${active ? "bg-ink text-canvas" : "text-ink"}`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">{children}</main>
    </div>
  );
}

export function OpsNotice({ children }: { children: ReactNode }) {
  return <Notice>{children}</Notice>;
}

export function OpsButton({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <PrimaryButton className={className} {...props} />;
}

export function OpsSecondary({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <SecondaryButton className={className} {...props} />;
}

export const opsInputClass = fieldClass;

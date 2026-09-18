import { Outlet, createFileRoute } from "@tanstack/react-router";
import { RedirectToSignIn, UserButton } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

export const Route = createFileRoute("/app")({ component: AppShell });

function AppShell() {
  const { user, isPending } = useCurrentUserState();
  if (isPending) return <main className="grid min-h-dvh place-items-center bg-canvas text-sm text-muted">Loading…</main>;
  if (!user) return <RedirectToSignIn to="/login" />;

  return (
    <main className="min-h-dvh bg-canvas text-ink">
      <header className="flex items-center justify-between border-b border-line px-6 py-4 md:px-10">
        <a href="/app" className="text-xs font-semibold tracking-[0.22em] uppercase">SCAN / BOOK / GO</a>
        <UserButton />
      </header>
      <div className="mx-auto w-full max-w-5xl px-6 py-8 md:px-10"><Outlet /></div>
    </main>
  );
}

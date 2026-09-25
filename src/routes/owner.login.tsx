import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { authClient, authEnabled } from "@/lib/auth/client";
import { getOwnerAccess } from "@/lib/auth/owner-session";
import {
  OWNER_ACCESS_UNAVAILABLE,
  ownerEntryDecision,
  safeOwnerReturnPath,
} from "@/lib/auth/owner-login";
import { ThemeToggle } from "@/components/aether/theme-toggle";

export const Route = createFileRoute("/owner/login")({
  validateSearch: (search: Record<string, unknown>) => ({
    redirect: safeOwnerReturnPath(search.redirect),
  }),
  beforeLoad: async ({ search }) => {
    const access = await getOwnerAccess();
    if (access.ok) throw redirect({ href: search.redirect });
  },
  loader: () => getOwnerAccess(),
  component: OwnerLoginPage,
});

function OwnerLoginPage() {
  const { redirect: redirectTo } = Route.useSearch();
  const initial = Route.useLoaderData();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(
    ownerEntryDecision(initial, redirectTo).action === "deny" ? OWNER_ACCESS_UNAVAILABLE : null,
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!authEnabled) {
      setError("Sign-in is not enabled in this environment.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await authClient.signIn.email({
        email: email.trim(),
        password,
      });
      if (result.error) {
        setError("Sign-in failed.");
        return;
      }
      let access: Awaited<ReturnType<typeof getOwnerAccess>>;
      try {
        access = await getOwnerAccess();
      } catch {
        setError(OWNER_ACCESS_UNAVAILABLE);
        return;
      }
      const decision = ownerEntryDecision(access, redirectTo);
      if (decision.action !== "enter") {
        setError(OWNER_ACCESS_UNAVAILABLE);
        return;
      }
      window.location.assign(decision.path);
    } catch {
      setError("Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-dvh bg-canvas text-ink">
      <header className="flex items-center justify-between px-6 py-6 md:px-10">
        <p className="text-xs font-semibold tracking-[0.22em] uppercase">SCAN / BOOK / GO</p>
        <ThemeToggle />
      </header>
      <section className="mx-auto flex min-h-[calc(100dvh-88px)] w-full max-w-md items-center px-6 pb-16">
        <div className="w-full">
          <p className="text-xs font-medium tracking-[0.2em] text-muted uppercase">Owner</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight">Internal platform access</h1>
          <p className="mt-4 text-sm leading-relaxed text-muted">
            Sign in to the SCAN BOOK GO Owner control plane.
          </p>
          {!authEnabled ? (
            <div className="mt-8 border border-line bg-surface px-4 py-4 text-sm text-muted">
              Sign-in is not enabled in this environment.
            </div>
          ) : (
            <form className="mt-8" onSubmit={(event) => void submit(event)}>
              <label className="block">
                <span className="mb-2 block text-xs font-medium tracking-widest text-muted uppercase">
                  Email
                </span>
                <input
                  className="min-h-12 w-full border border-line bg-transparent px-3 outline-none focus:border-ink"
                  type="email"
                  required
                  autoComplete="username"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <label className="mt-4 block">
                <span className="mb-2 block text-xs font-medium tracking-widest text-muted uppercase">
                  Password
                </span>
                <input
                  className="min-h-12 w-full border border-line bg-transparent px-3 outline-none focus:border-ink"
                  type="password"
                  required
                  minLength={8}
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              {error ? (
                <p className="mt-4 border border-line px-4 py-3 text-sm" role="alert">
                  {error}
                </p>
              ) : null}
              <button
                type="submit"
                disabled={busy || !email || !password}
                className="mt-6 min-h-12 w-full bg-ink px-4 text-sm font-semibold tracking-wide text-canvas uppercase disabled:opacity-50"
              >
                {busy ? "Signing in…" : "Sign in"}
              </button>
            </form>
          )}
        </div>
      </section>
    </main>
  );
}

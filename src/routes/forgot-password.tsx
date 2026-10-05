import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { ThemeToggle } from "@/components/aether/theme-toggle";
import {
  PASSWORD_RESET_ACKNOWLEDGEMENT,
  PASSWORD_RESET_UNAVAILABLE,
  getPasswordRecoveryAvailability,
} from "@/lib/auth/password-recovery";

export const Route = createFileRoute("/forgot-password")({
  loader: () => getPasswordRecoveryAvailability(),
  component: ForgotPassword,
});

function ForgotPassword() {
  const recovery = Route.useLoaderData();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!recovery.available || !recovery.resetCallbackUrl) {
      setUnavailable(true);
      return;
    }
    setBusy(true);
    setUnavailable(false);
    try {
      const response = await fetch("/api/auth/request-password-reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          redirectTo: recovery.resetCallbackUrl,
        }),
      });
      if (response.ok) setAcknowledged(true);
      else setUnavailable(true);
    } catch {
      setUnavailable(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-dvh bg-canvas text-ink">
      <header className="flex items-center justify-between px-6 py-6 md:px-10">
        <Link to="/" className="text-xs font-semibold tracking-[0.22em] uppercase">
          SCAN / BOOK / GO
        </Link>
        <ThemeToggle />
      </header>
      <section className="mx-auto flex min-h-[calc(100dvh-88px)] w-full max-w-md items-center px-6 pb-16">
        <div className="w-full">
          <p className="text-xs font-medium tracking-[0.2em] text-muted uppercase">Password</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight">Reset your password</h1>
          {!recovery.available ? (
            <p className="mt-4 text-sm leading-relaxed text-muted">{PASSWORD_RESET_UNAVAILABLE}</p>
          ) : acknowledged ? (
            <p className="mt-4 text-sm leading-relaxed text-muted">{PASSWORD_RESET_ACKNOWLEDGEMENT}</p>
          ) : (
            <form className="mt-8" onSubmit={(event) => void submit(event)}>
              <label className="block">
                <span className="mb-2 block text-xs font-medium tracking-widest text-muted uppercase">Work email</span>
                <input
                  className="min-h-12 w-full border border-line bg-transparent px-3 outline-none focus:border-ink"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              {unavailable ? (
                <p className="mt-4 border border-line px-4 py-3 text-sm">{PASSWORD_RESET_UNAVAILABLE}</p>
              ) : null}
              <button
                type="submit"
                disabled={busy || !email}
                className="mt-6 min-h-12 w-full bg-ink px-4 text-sm font-semibold tracking-wide text-canvas uppercase disabled:opacity-50"
              >
                {busy ? "Working…" : "Continue"}
              </button>
            </form>
          )}
          <Link to="/login" className="mt-5 inline-flex min-h-11 items-center text-sm text-muted underline underline-offset-4">
            Back to sign in
          </Link>
        </div>
      </section>
    </main>
  );
}

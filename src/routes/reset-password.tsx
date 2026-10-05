import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { z } from "zod";
import { ThemeToggle } from "@/components/aether/theme-toggle";
import { PASSWORD_RESET_COMPLETE, PASSWORD_RESET_LINK_INVALID } from "@/lib/auth/password-recovery";

export const Route = createFileRoute("/reset-password")({
  validateSearch: z.object({
    token: z.string().optional(),
    error: z.string().optional(),
  }),
  component: ResetPassword,
});

function ResetPassword() {
  const search = Route.useSearch();
  const token = search.token?.trim() ?? "";
  const invalidLink = Boolean(search.error) || !token;
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [rejected, setRejected] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!token) return;
    setBusy(true);
    setRejected(false);
    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newPassword: password, token }),
      });
      if (response.ok) setDone(true);
      else setRejected(true);
    } catch {
      setRejected(true);
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
          <h1 className="mt-3 text-4xl font-semibold tracking-tight">Choose a new password</h1>
          {done ? (
            <p className="mt-4 text-sm leading-relaxed text-muted">{PASSWORD_RESET_COMPLETE}</p>
          ) : invalidLink || rejected ? (
            <p className="mt-4 text-sm leading-relaxed text-muted">{PASSWORD_RESET_LINK_INVALID}</p>
          ) : (
            <form className="mt-8" onSubmit={(event) => void submit(event)}>
              <label className="block">
                <span className="mb-2 block text-xs font-medium tracking-widest text-muted uppercase">New password</span>
                <input
                  className="min-h-12 w-full border border-line bg-transparent px-3 outline-none focus:border-ink"
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <button
                type="submit"
                disabled={busy || password.length < 8}
                className="mt-6 min-h-12 w-full bg-ink px-4 text-sm font-semibold tracking-wide text-canvas uppercase disabled:opacity-50"
              >
                {busy ? "Working…" : "Update password"}
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

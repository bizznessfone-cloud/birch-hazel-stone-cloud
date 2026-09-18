import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { authClient, authEnabled } from "@/lib/auth/client";
import { ThemeToggle } from "@/components/aether/theme-toggle";

export const Route = createFileRoute("/login")({ component: Login });

function Login() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signup" | "signin">("signup");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!authEnabled) {
      setError("Account authentication is not enabled in this environment.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result =
        mode === "signup"
          ? await authClient.signUp.email({
              name: name.trim() || "Operator",
              email: email.trim(),
              password,
            })
          : await authClient.signIn.email({
              email: email.trim(),
              password,
            });
      if (result.error) {
        setError(result.error.message ?? "Authentication failed.");
        return;
      }
      await navigate({ to: "/app" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed.");
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
          <p className="text-xs font-medium tracking-[0.2em] text-muted uppercase">
            {mode === "signup" ? "Get started" : "Welcome back"}
          </p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight">
            {mode === "signup"
              ? "Create your SCAN BOOK GO account"
              : "Sign in to SCAN BOOK GO"}
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-muted">
            {mode === "signup"
              ? "Use your work email. You can set up your hotel next."
              : "Use the email and password for your operator account."}
          </p>
          {!authEnabled ? (
            <div className="mt-8 border border-line bg-surface px-4 py-4 text-sm text-muted">
              Sign-in is disabled in this workspace.
            </div>
          ) : (
            <form className="mt-8" onSubmit={(event) => void submit(event)}>
              {mode === "signup" ? (
                <label className="block">
                  <span className="mb-2 block text-xs font-medium tracking-widest text-muted uppercase">Name</span>
                  <input className="min-h-12 w-full border border-line bg-transparent px-3 outline-none focus:border-ink" value={name} autoComplete="name" onChange={(event) => setName(event.target.value)} />
                </label>
              ) : null}
              <label className={mode === "signup" ? "mt-4 block" : "block"}>
                <span className="mb-2 block text-xs font-medium tracking-widest text-muted uppercase">Work email</span>
                <input className="min-h-12 w-full border border-line bg-transparent px-3 outline-none focus:border-ink" type="email" required value={email} autoComplete="email" onChange={(event) => setEmail(event.target.value)} />
              </label>
              <label className="mt-4 block">
                <span className="mb-2 block text-xs font-medium tracking-widest text-muted uppercase">Password</span>
                <input className="min-h-12 w-full border border-line bg-transparent px-3 outline-none focus:border-ink" type="password" required minLength={8} value={password} autoComplete={mode === "signup" ? "new-password" : "current-password"} onChange={(event) => setPassword(event.target.value)} />
              </label>
              {error ? <p className="mt-4 border border-line px-4 py-3 text-sm">{error}</p> : null}
              <button type="submit" disabled={busy || !email || !password} className="mt-6 min-h-12 w-full bg-ink px-4 text-sm font-semibold tracking-wide text-canvas uppercase disabled:opacity-50">
                {busy ? "Working…" : mode === "signup" ? "Create account" : "Sign in"}
              </button>
            </form>
          )}
          <button type="button" className="mt-5 text-sm text-muted underline underline-offset-4" onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setError(null); }}>
            {mode === "signup" ? "Already have an account? Sign in" : "Create a new account"}
          </button>
        </div>
      </section>
    </main>
  );
}

import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { opsLogin } from "@/lib/aether/ops-fns";
import { GUEST_LOCKUP } from "@/lib/aether/constants";
import { ThemeToggle } from "@/components/aether/theme-toggle";
import { Notice, PrimaryButton, fieldClass } from "@/components/aether/ui";

export const Route = createFileRoute("/ops/login")({
  component: OpsLogin,
});

function OpsLogin() {
  const navigate = useNavigate();
  const router = useRouter();
  const [login, setLogin] = useState("desk");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await opsLogin({ data: { login, password } });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      await router.invalidate();
      await navigate({ to: "/ops" });
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col bg-canvas text-ink">
      <div className="flex justify-end px-5 py-4">
        <ThemeToggle />
      </div>
      <form
        className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-5 pb-16"
        onSubmit={(event) => void submit(event)}
      >
        <p className="text-xs tracking-widest text-muted uppercase">{GUEST_LOCKUP}</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">Desk</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          Sign in to manage today’s transfers. Guests book from the hotel page.
        </p>
        <label className="mt-8 block">
          <span className="mb-2 block text-xs tracking-widest text-muted uppercase">Login</span>
          <input
            className={fieldClass}
            value={login}
            autoComplete="username"
            onChange={(event) => setLogin(event.target.value)}
          />
        </label>
        <label className="mt-4 block">
          <span className="mb-2 block text-xs tracking-widest text-muted uppercase">Password</span>
          <input
            className={fieldClass}
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error ? <div className="mt-4"><Notice>{error}</Notice></div> : null}
        <div className="mt-6">
          <PrimaryButton type="submit" disabled={busy || !login || !password} className="w-full">
            {busy ? "Signing in…" : "Sign in"}
          </PrimaryButton>
        </div>
      </form>
    </main>
  );
}

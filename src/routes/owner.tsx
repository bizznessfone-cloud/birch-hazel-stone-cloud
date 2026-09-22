import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { AppErrorComponent } from "@/lib/error-component";
import { RedirectToSignIn } from "@/lib/auth/gates";
import { getOwnerAccess } from "@/lib/auth/owner-session";
import { PlatformOwnerForbiddenError } from "@/lib/aether/owner-auth";
import { OwnerForbiddenPage, OwnerShell } from "@/components/aether/owner-shell";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

export const Route = createFileRoute("/owner")({
  beforeLoad: async () => {
    const access = await getOwnerAccess();
    if (!access.ok && access.reason === "unauthenticated") {
      throw redirect({ to: "/login" });
    }
    if (!access.ok) throw new PlatformOwnerForbiddenError();
  },
  errorComponent: (props) => {
    const { error } = props;
    const forbidden =
      error instanceof PlatformOwnerForbiddenError ||
      (error instanceof Error && error.name === "PlatformOwnerForbiddenError");
    if (forbidden) return <OwnerForbiddenPage />;
    return <AppErrorComponent {...props} />;
  },
  component: OwnerLayout,
});

function OwnerLayout() {
  const { user, isPending } = useCurrentUserState();
  if (isPending) {
    return (
      <main className="grid min-h-dvh place-items-center bg-canvas text-sm text-muted">
        Loading…
      </main>
    );
  }
  if (!user) return <RedirectToSignIn to="/login" />;

  return (
    <OwnerShell>
      <Outlet />
    </OwnerShell>
  );
}

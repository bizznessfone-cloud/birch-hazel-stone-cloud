import { Navigate, Outlet, createFileRoute, redirect, useRouterState } from "@tanstack/react-router";
import { AppErrorComponent } from "@/lib/error-component";
import { getOwnerAccess } from "@/lib/auth/owner-session";
import { isOwnerLoginPath, safeOwnerReturnPath, unauthenticatedOwnerRedirect } from "@/lib/auth/owner-login";
import { PlatformOwnerForbiddenError } from "@/lib/aether/owner-auth";
import { OwnerForbiddenPage, OwnerShell } from "@/components/aether/owner-shell";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

export const Route = createFileRoute("/owner")({
  beforeLoad: async ({ location }) => {
    if (isOwnerLoginPath(location.pathname)) return;
    const access = await getOwnerAccess();
    if (!access.ok && access.reason === "unauthenticated") {
      const next = unauthenticatedOwnerRedirect(location.pathname);
      if (next) throw redirect(next);
      throw redirect({ to: "/owner/login", search: { redirect: safeOwnerReturnPath(location.pathname) } });
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
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { user, isPending } = useCurrentUserState();
  if (isOwnerLoginPath(pathname)) return <Outlet />;
  if (isPending) {
    return (
      <main className="grid min-h-dvh place-items-center bg-canvas text-sm text-muted">
        Loading…
      </main>
    );
  }
  if (!user) {
    return <Navigate to="/owner/login" search={{ redirect: safeOwnerReturnPath(pathname) }} />;
  }

  return (
    <OwnerShell>
      <Outlet />
    </OwnerShell>
  );
}

import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { opsWhoAmI } from "@/lib/aether/ops-fns";
import { OpsShell } from "@/components/aether/ops-shell";

export const Route = createFileRoute("/ops")({
  shouldReload: true,
  pendingComponent: () => (
    <main className="flex min-h-dvh items-center justify-center bg-canvas text-ink">
      <p className="text-sm text-muted">Loading desk…</p>
    </main>
  ),
  loader: async ({ location }) => {
    const me = await opsWhoAmI();
    const isLogin = location.pathname === "/ops/login";
    if (isLogin) {
      if (me.ok) throw redirect({ to: "/ops" });
      return { public: true as const, login: "" };
    }
    if (!me.ok) throw redirect({ to: "/ops/login" });
    return { public: false as const, login: me.login };
  },
  component: OpsLayout,
});

function OpsLayout() {
  const data = Route.useLoaderData();
  if (data.public) return <Outlet />;
  return (
    <OpsShell login={data.login}>
      <Outlet />
    </OpsShell>
  );
}

import { createFileRoute, redirect } from "@tanstack/react-router";
import { readFoundingOnboardingStateFn } from "@/lib/aether/founding-onboarding-fns";
import { listOperatorWorkspacePropertiesFn } from "@/lib/aether/operator-workspace-fns";

export const Route = createFileRoute("/app/operator")({
  loader: async () => {
    const state = await readFoundingOnboardingStateFn();
    if (state.status !== "ready" || state.organisationType !== "transfer_operator") {
      throw redirect({ to: "/app/founding" });
    }
    return listOperatorWorkspacePropertiesFn();
  },
  component: OperatorWorkspace,
});

function OperatorWorkspace() {
  const { properties } = Route.useLoaderData();
  return (
    <section className="mx-auto max-w-2xl">
      <p className="text-xs font-medium tracking-[0.2em] text-muted uppercase">Independent transfer operator</p>
      <h1 className="mt-3 text-4xl font-semibold tracking-tight">Operator workspace</h1>
      <p className="mt-4 text-sm leading-relaxed text-muted">
        Activation is pending. Only properties explicitly linked to your organisation are shown.
        Property access does not authorise bookings, payments or operations.
      </p>
      <h2 className="mt-8 text-lg font-semibold">Authorised properties</h2>
      {properties.length === 0 ? (
        <p role="status" className="mt-3 text-sm text-muted">
          No authorised properties are available. A hotel must grant access before its property appears here.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-line border-y border-line">
          {properties.map(property => (
            <li key={property.hotelId} className="py-4">
              <p className="font-medium">{property.name}</p>
              <p className="mt-1 text-xs text-muted">Property grant recorded · Operational access not active</p>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-8 text-xs leading-relaxed text-muted">
        Approved agreements, provider authorisation and activation controls are still required.
        This workspace cannot access guest booking records or connected payments.
      </p>
    </section>
  );
}

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { getOnboardingState } from "@/lib/aether/onboarding-fns";
import { readFoundingOnboardingStateFn } from "@/lib/aether/founding-onboarding-fns";

export const Route = createFileRoute("/app/")({
  loader: async () => {
    const onboarding = await getOnboardingState();
    // An independent operator must never inherit a hotel-owner workspace.
    // Unknown founding state fails closed to the existing founding journey.
    let operator = false;
    if (onboarding.ok && onboarding.hotels.length === 0) {
      try {
        const founding = await readFoundingOnboardingStateFn();
        operator = founding.status === "ready" && founding.organisationType === "transfer_operator";
      } catch {
        // Missing migrations or ambiguous state cannot activate an operator.
      }
    }
    return { onboarding, operator };
  },
  component: AppHome,
});

function AppHome() {
  const { onboarding, operator } = Route.useLoaderData();
  const navigate = useNavigate();
  useEffect(() => {
    if (!onboarding.ok) return;
    const first = onboarding.hotels[0]?.hotel;
    void navigate(first
      ? { to: "/app/hotels/$hotelId", params: { hotelId: first.id }, replace: true }
      : operator
        ? { to: "/app/operator", replace: true }
        : { to: "/app/founding", replace: true });
  }, [onboarding, operator, navigate]);
  if (!onboarding.ok) return <p className="text-sm text-muted">{onboarding.message}</p>;
  return <p className="text-sm text-muted">Opening your workspace…</p>;
}

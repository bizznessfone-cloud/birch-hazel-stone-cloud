import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { getOnboardingState } from "@/lib/aether/onboarding-fns";

export const Route = createFileRoute("/app/")({
  loader: () => getOnboardingState(),
  component: AppHome,
});

function AppHome() {
  const result = Route.useLoaderData();
  const navigate = useNavigate();
  useEffect(() => {
    if (!result.ok) return;
    const first = result.hotels[0]?.hotel;
    void navigate(first
      ? { to: "/app/hotels/$hotelId", params: { hotelId: first.id }, replace: true }
      : { to: "/app/onboarding", replace: true });
  }, [result, navigate]);
  if (!result.ok) return <p className="text-sm text-muted">{result.message}</p>;
  return <p className="text-sm text-muted">Opening your workspace…</p>;
}

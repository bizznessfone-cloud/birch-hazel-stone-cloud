import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/stripe/connect/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");

        if (error) {
          return Response.redirect(new URL("/app/billing?stripe=cancelled", url.origin), 303);
        }
        if (!code || !state) {
          return new Response("Invalid Stripe Connect callback.", { status: 400 });
        }

        try {
          const { completeStripeConnect } = await import("@/lib/aether/stripe.server");
          const hotelId = await completeStripeConnect(code, state);
          return Response.redirect(
            new URL(`/app/billing?hotelId=${encodeURIComponent(hotelId)}&stripe=connected`, url.origin),
            303,
          );
        } catch {
          return Response.redirect(new URL("/app/billing?stripe=error", url.origin), 303);
        }
      },
    },
  },
});

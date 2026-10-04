import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/ready")({
  server: {
    handlers: {
      GET: async () => {
        const { getSql } = await import("@/lib/db");
        const { readinessResponse } = await import("@/lib/aether/ready");
        return readinessResponse(() => getSql());
      },
    },
  },
});

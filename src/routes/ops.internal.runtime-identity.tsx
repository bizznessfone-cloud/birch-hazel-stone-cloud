import { createFileRoute } from "@tanstack/react-router";
import { runRuntimeIdentityDiagnostic } from "@/lib/aether/runtime-identity-fns";

export const Route = createFileRoute("/ops/internal/runtime-identity")({
  server: {
    handlers: {
      GET: async () => {
        const result = await runRuntimeIdentityDiagnostic();
        const status = !result.ok && result.error === "unauthorized" ? 401 : 200;
        return Response.json(result, { status });
      },
    },
  },
});

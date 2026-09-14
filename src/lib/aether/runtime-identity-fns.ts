/**
 * Temporary CP19D Ops diagnostic server function. Guest routes must not import this.
 */
import { createServerFn } from "@tanstack/react-start";
import type { RuntimeIdentityResult } from "./runtime-identity.server";

const UNAUTHORIZED = "unauthorized";
const FAIL = "runtime identity verification failed";

function isOpsAuthError(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { name?: string }).name === "OpsAuthError");
}

export async function runRuntimeIdentityDiagnostic(): Promise<RuntimeIdentityResult> {
  try {
    const { requireOps } = await import("./ops-auth.server");
    await requireOps({ csrf: false });
  } catch (err) {
    if (isOpsAuthError(err)) return { ok: false, error: UNAUTHORIZED };
    return { ok: false, error: FAIL };
  }
  try {
    const { verifyProductionRuntimeIdentity } = await import("./runtime-identity.server");
    return await verifyProductionRuntimeIdentity();
  } catch {
    return { ok: false, error: FAIL };
  }
}

export const opsRuntimeIdentity = createServerFn({ method: "GET" }).handler(async () => {
  return runRuntimeIdentityDiagnostic();
});

/**
 * Temporary CP29.4A diagnostic. SELECT-only. No UI. Removed after measurement.
 * Fails closed unless CP294A_DIAG_SECRET matches the request header.
 */
import { timingSafeEqual } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";
import { getPgPool } from "@/lib/db";
import { neonPoolSettings } from "@/lib/aether/runtime-config";

const HEADER = "x-cp294a-diag";

function authorized(request: Request): boolean {
  const expected = process.env.CP294A_DIAG_SECRET ?? "";
  const presented = request.headers.get(HEADER) ?? "";
  if (expected.length < 32 || presented.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(presented));
}

function denied(): Response {
  return new Response(null, {
    status: 404,
    headers: { "x-robots-tag": "noindex" },
  });
}

function classify(raw: string): {
  transport: "pooler" | "direct" | "unparsed";
  host_has_pooler_marker: boolean;
  neon_region: string | null;
  endpoint_id: string | null;
  database_label: "neondb" | "other" | "unparsed";
  query_parameter_count: number;
} {
  const empty = {
    transport: "unparsed" as const,
    host_has_pooler_marker: false,
    neon_region: null,
    endpoint_id: null,
    database_label: "unparsed" as const,
    query_parameter_count: 0,
  };
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const pooler = host.includes("-pooler");
    const first = host.split(".")[0] ?? "";
    const endpoint = first.startsWith("ep-") ? first.replace(/-pooler$/, "") : null;
    const region = host.match(/\b([a-z]{2}(?:-[a-z]+)+-\d+)\b/)?.[1] ?? null;
    const db = url.pathname.replace(/^\//, "");
    return {
      transport: pooler ? "pooler" : "direct",
      host_has_pooler_marker: pooler,
      neon_region: region,
      endpoint_id: endpoint,
      database_label: db === "neondb" ? "neondb" : "other",
      query_parameter_count: [...url.searchParams.keys()].length,
    };
  } catch {
    return empty;
  }
}

function roundMs(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[index] ?? 0;
}

export const Route = createFileRoute("/api/cp294a-rtt")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!authorized(request)) return denied();
        const handlerStart = performance.now();
        try {
          const databaseUrl = process.env.DATABASE_URL ?? "";
          const transport = classify(databaseUrl);
          const settings = neonPoolSettings();
          const poolStart = performance.now();
          const pool = await getPgPool();
          const poolObjectMs = roundMs(performance.now() - poolStart);
          const totalBefore = pool.totalCount;

          const select1 = async () => {
            const started = performance.now();
            await pool.query("select 1 as ok");
            return roundMs(performance.now() - started);
          };

          const firstMs = await select1();
          const warm: number[] = [];
          for (let i = 0; i < 16; i += 1) warm.push(await select1());
          const sorted = [...warm].sort((a, b) => a - b);
          const warmMean = roundMs(warm.reduce((sum, value) => sum + value, 0) / warm.length);

          const identity = await pool.query<{
            current_user: string;
            session_user: string;
            current_database: string;
          }>(
            `select current_user as current_user,
                    session_user as session_user,
                    current_database() as current_database`,
          );
          const neon = await pool.query<{
            project_id: string | null;
            branch_id: string | null;
            endpoint_id: string | null;
          }>(
            `select current_setting('neon.project_id', true) as project_id,
                    current_setting('neon.branch_id', true) as branch_id,
                    current_setting('neon.endpoint_id', true) as endpoint_id`,
          );

          const idRow = identity.rows[0];
          const neonRow = neon.rows[0];
          return Response.json(
            {
              ok: true,
              vercel_region: process.env.VERCEL_REGION ?? null,
              deployment_id: process.env.VERCEL_DEPLOYMENT_ID ?? null,
              transport,
              identity: {
                current_user: idRow?.current_user ?? null,
                session_user: idRow?.session_user ?? null,
                current_database: idRow?.current_database ?? null,
                session_matches_current: idRow?.current_user === idRow?.session_user,
              },
              neon: {
                project_id: neonRow?.project_id ?? null,
                branch_id: neonRow?.branch_id ?? null,
                endpoint_id: neonRow?.endpoint_id ?? null,
              },
              pool: {
                max: settings.max,
                idleTimeoutMillis: settings.idleTimeoutMillis,
                connectionTimeoutMillis: settings.connectionTimeoutMillis,
                allowExitOnIdle: settings.allowExitOnIdle,
                total_before_first_query: totalBefore,
                total: pool.totalCount,
                idle: pool.idleCount,
                waiting: pool.waitingCount,
              },
              timing: {
                function_startup_before_handler: "NOT_SEPARATELY_MEASURABLE",
                pool_object_ms: poolObjectMs,
                first_select1_ms: firstMs,
                warm_select1_ms: warm,
                warm_n: warm.length,
                warm_min: sorted[0] ?? null,
                warm_p50: percentile(sorted, 50),
                warm_p95: percentile(sorted, 95),
                warm_p99: percentile(sorted, 99),
                warm_max: sorted[sorted.length - 1] ?? null,
                warm_mean: warmMean,
                p99_confidence: "low",
                total_handler_ms: roundMs(performance.now() - handlerStart),
              },
            },
            { headers: { "x-robots-tag": "noindex", "cache-control": "no-store" } },
          );
        } catch {
          return Response.json(
            { ok: false, error: "diagnostic_failed" },
            { status: 500, headers: { "x-robots-tag": "noindex", "cache-control": "no-store" } },
          );
        }
      },
    },
  },
});

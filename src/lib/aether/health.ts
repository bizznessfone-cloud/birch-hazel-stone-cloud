/**
 * Public foundation health. Intentionally unauthenticated.
 * Guest booking and the product shell stay public.
 */
import { createServerFn } from "@tanstack/react-start";
import { getDbSource, getSql } from "@/lib/db";
import { getAetherDb } from "./kysely";

export type FoundationStatus =
  | {
      ok: true;
      backend: "pglite" | "neon";
      product: string;
      schemaPhase: string;
      checkpoint: string;
      blueprint: string;
      kyselyOk: boolean;
    }
  | {
      ok: false;
      backend: "pglite" | "neon" | "unknown";
      error: string;
    };

export const getFoundationStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<FoundationStatus> => {
    try {
      const sql = await getSql();
      const rows = await sql<{ key: string; value: string }>`
        select key, value from aether_meta order by key
      `;
      const meta: Record<string, string> = {};
      for (const row of rows) meta[row.key] = row.value;

      const db = await getAetherDb();
      const productRow = await db
        .selectFrom("aether_meta")
        .select(["value"])
        .where("key", "=", "product")
        .executeTakeFirst();

      return {
        ok: true,
        backend: getDbSource(),
        product: meta.product ?? "",
        schemaPhase: meta.schema_phase ?? "",
        checkpoint: meta.checkpoint ?? "",
        blueprint: meta.blueprint ?? "",
        kyselyOk: productRow?.value === "Aether Transfer",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Database unavailable";
      return {
        ok: false,
        backend: getDbSource(),
        error: message,
      };
    }
  },
);

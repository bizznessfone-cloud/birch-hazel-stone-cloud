import { Kysely, PostgresDialect } from "kysely";
import { dbSource, getPglite, pgRuntimeRoleOptions } from "@/lib/db";
import { pgliteDialect } from "@/lib/auth/pglite-dialect";
import type { AetherDatabase } from "./schema";

const globalRef = globalThis as typeof globalThis & {
  __aetherKyselyPromise__?: Promise<Kysely<AetherDatabase>>;
};

async function createAetherDb(): Promise<Kysely<AetherDatabase>> {
  if (typeof window !== "undefined") {
    throw new Error(
      "getAetherDb() is server-only — call it from a createServerFn handler or server loader.",
    );
  }

  if (dbSource === "neon") {
    const pg = await import("pg");
    const url =
      typeof process !== "undefined" ? process.env.DATABASE_URL?.trim() : undefined;
    if (!url) {
      throw new Error("DATABASE_URL is required for the Neon Kysely dialect.");
    }
    const pool = new pg.default.Pool({
      connectionString: url,
      options: pgRuntimeRoleOptions(),
    });
    return new Kysely<AetherDatabase>({
      dialect: new PostgresDialect({ pool }),
    });
  }

  return new Kysely<AetherDatabase>({
    dialect: pgliteDialect(() => getPglite()),
  });
}

/**
 * Shared Kysely instance against the same PGLite/Neon database as getSql().
 * PGLite uses the existing embedded instance so preview data stays consistent.
 */
export function getAetherDb(): Promise<Kysely<AetherDatabase>> {
  globalRef.__aetherKyselyPromise__ ??= createAetherDb().catch((err) => {
    globalRef.__aetherKyselyPromise__ = undefined;
    throw err;
  });
  return globalRef.__aetherKyselyPromise__;
}

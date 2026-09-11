import { pendingMigrations } from "../../scripts/migration-plan.mjs";
import {
  AETHER_RUNTIME_ROLE,
  assertProductionDatabaseUrl,
  isProductionRuntime,
  neonPoolSettings,
  readTrimmedEnv,
} from "@/lib/aether/runtime-config";

export {
  AETHER_RUNTIME_ROLE,
  AETHER_APP_ROLE,
} from "@/lib/aether/runtime-config";

/** Which database backend is active. */
export type DbSource = "neon" | "pglite";

function readDatabaseUrl(): string | undefined {
  return readTrimmedEnv("DATABASE_URL");
}

/**
 * Live backend selection. Production never returns PGLite — missing
 * DATABASE_URL fails closed at getSql()/ensureDbReady(), not at module eval
 * (Vite may bundle this file with NODE_ENV=production and an empty URL).
 */
export function getDbSource(): DbSource {
  if (readDatabaseUrl()) return "neon";
  if (isProductionRuntime()) return "neon";
  return "pglite";
}

/**
 * Minimal shared SQL surface, satisfied by both Neon and PGLite. Both the
 * tagged-template and `.query()` forms resolve to an array of row objects:
 *
 *   const sql = await getSql();
 *   const rows = await sql`select * from todos where id = ${id}`; // parameterized
 *   const rows2 = await sql.query("select * from todos where id = $1", [id]);
 */
export interface Sql {
  <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<T[]>;
}

/**
 * Init state lives on globalThis as promises: dev HMR creates new instances of
 * this module, and two instances racing module-level state would open a second
 * pool or run two concurrent PGLite migration passes (whose duplicate
 * `_migrations` insert rejects — and would get memoized, poisoning every later
 * `getSql()`). A failed init clears its slot so the next call retries.
 */
const globalRef = globalThis as typeof globalThis & {
  __pgSqlPromise__?: Promise<Sql>;
  __pgPoolPromise__?: Promise<import("pg").Pool>;
  __pgliteInstance__?: Promise<import("@electric-sql/pglite").PGlite>;
  __pgliteMigrateChain__?: Promise<void>;
};

/**
 * Result-type parity: Postgres sends every value as text plus a type OID — the
 * JS value is the DRIVER's parsing choice, and pg and PGLite disagree (pg:
 * int8 -> string, date -> local-midnight Date; PGLite: int8 -> BigInt, which
 * JSON.stringify rejects, date -> UTC Date). Normalize both so preview and
 * production return identical, JSON-safe shapes:
 *   int8/bigint (incl. count(*)) -> number (past 2^53 loses precision — cast
 *                                   `::text` if you ever need huge integers)
 *   date                         -> 'YYYY-MM-DD' string
 *   interval                     -> Postgres interval text
 * numeric already comes back as a string on both (arbitrary precision).
 */
const OID_INT8 = 20;
const OID_DATE = 1082;
const OID_INTERVAL = 1186;
const identity = (v: string) => v;

type Run = <T>(text: string, params: unknown[]) => Promise<T[]>;

/** Wrap a query runner in the tagged-template + `.query()` `Sql` surface. */
function toSql(run: Run): Sql {
  const sql = (async <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]> => {
    // Rebuild with $1, $2, … placeholders so values stay parameterized.
    let text = strings[0];
    for (let i = 0; i < values.length; i += 1) text += `$${i + 1}${strings[i + 1]}`;
    return run<T>(text, values);
  }) as unknown as Sql;
  sql.query = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    run<T>(text, params);
  return sql;
}

/**
 * Shared node-postgres Pool for Neon/PostgreSQL. One pool per isolate, max 2.
 * Production authenticates as aether_app LOGIN. Do not pass a startup
 * role option — SET ROLE from a non-app login would make RESET ROLE
 * restore the owner.
 */
export async function getPgPool(): Promise<import("pg").Pool> {
  assertProductionDatabaseUrl();
  const databaseUrl = readDatabaseUrl();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the PostgreSQL pool.");
  }
  globalRef.__pgPoolPromise__ ??= (async () => {
    const { Pool, types } = await import("pg");
    types.setTypeParser(OID_INT8, Number);
    types.setTypeParser(OID_DATE, identity);
    types.setTypeParser(OID_INTERVAL, identity);
    return new Pool({
      connectionString: databaseUrl,
      ...neonPoolSettings(),
    });
  })().catch((err) => {
    globalRef.__pgPoolPromise__ = undefined;
    throw err;
  });
  return globalRef.__pgPoolPromise__;
}

function createNeonSql(): Promise<Sql> {
  globalRef.__pgSqlPromise__ ??= (async () => {
    const pool = await getPgPool();
    return toSql(async <T>(text: string, params: unknown[]) => {
      const res = await pool.query(text, params);
      return res.rows as T[];
    });
  })().catch((err) => {
    globalRef.__pgSqlPromise__ = undefined;
    throw err;
  });
  return globalRef.__pgSqlPromise__;
}

async function createPgliteSql(): Promise<Sql> {
  if (isProductionRuntime()) {
    throw new Error(
      "Aether production must not open the embedded preview database.",
    );
  }
  // Embedded Postgres, imported on demand so it never loads on the Neon path.
  // One in-memory instance per process, shared across HMR module instances, so
  // data survives source edits (it resets on dev-server restart).
  globalRef.__pgliteInstance__ ??= (async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
    const pg = new PGlite({
      // Required for Aether occupancy: composite GiST EXCLUDE
      // (vehicle_id WITH =, occupies WITH &&) needs btree_gist. Neon has it
      // as a contrib extension; preview PGLite must load the WASM bundle.
      extensions: { btree_gist },
      parsers: {
        [OID_INT8]: Number,
        [OID_DATE]: identity,
        [OID_INTERVAL]: identity,
      },
    });
    await pg.waitReady;
    try {
      // 0014 grants CONNECT on database neondb (Neon production name).
      // Create it so the same parser-safe GRANT applies on preview PGLite.
      await pg.exec("create database neondb");
    } catch {
      /* already exists on a reused preview instance */
    }
    await pg.exec(
      "create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    return pg;
  })().catch((err) => {
    globalRef.__pgliteInstance__ = undefined;
    throw err;
  });
  const pg = await globalRef.__pgliteInstance__;

  // Apply migrations/ (the single schema source) so preview matches production.
  // SQL is inlined by the bundler via import.meta.glob (no runtime fs); applied
  // files are tracked in _migrations. The glob does not descend, so the opt-in
  // auth schema under migrations/auth/ stays out. Runs once per module instance
  // — so an HMR reload after adding a migration file applies it live — with
  // passes serialized on a global chain so concurrent callers never
  // double-apply.
  const migrate = async (): Promise<void> => {
    // Migrations must run as the table owner. The live SQL surface then
    // SET ROLE aether_runtime so occupancy DDL is denied. Preview only:
    // production authenticates as aether_app LOGIN and must not SET ROLE.
    try {
      await pg.exec("reset role");
    } catch {
      /* first boot: still the superuser/owner */
    }
    const migrations = import.meta.glob("/migrations/*.sql", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;
    const doneRows = await pg.query<{ name: string }>(
      "select name from _migrations",
    );
    const done = doneRows.rows.map((r) => r.name);
    for (const { name, path } of pendingMigrations(Object.keys(migrations), done)) {
      // Apply + record atomically (parity with scripts/migrate.mjs) so a failed
      // statement can't leave a file half-applied but untracked.
      await pg.transaction(async (tx) => {
        await tx.exec(migrations[path]);
        await tx.query("insert into _migrations (name) values ($1)", [name]);
      });
    }
    const role = await pg.query<{ ok: number }>(
      "select 1 as ok from pg_roles where rolname = $1",
      [AETHER_RUNTIME_ROLE],
    );
    if (role.rows.length) {
      await pg.exec("set role aether_runtime");
    }
  };
  const pass = (globalRef.__pgliteMigrateChain__ ?? Promise.resolve())
    .catch(() => undefined) // an earlier failed pass must not wedge the chain
    .then(migrate);
  globalRef.__pgliteMigrateChain__ = pass;
  await pass;

  return toSql(async <T>(text: string, params: unknown[]) => {
    const result = await pg.query<T>(text, params);
    return result.rows;
  });
}

let sqlPromise: Promise<Sql> | null = null;

async function createSql(): Promise<Sql> {
  if (typeof window !== "undefined") {
    throw new Error(
      "@/lib/db is server-only — call getSql() from a createServerFn handler " +
        "or a server route loader, never from client code.",
    );
  }
  assertProductionDatabaseUrl();
  return readDatabaseUrl() ? createNeonSql() : createPgliteSql();
}

/**
 * Get the shared, **server-only** SQL client. Neon when `DATABASE_URL` is set,
 * otherwise the local PGLite fallback (preview only). Production without
 * DATABASE_URL fails closed. Memoized — safe to call per request.
 *
 * Schema comes from `migrations/*.sql`, auto-applied before the first query on
 * PGLite — define tables there, never inline in server functions. Production
 * schema is applied by the owner migrator, never by this runtime module.
 */
export function getSql(): Promise<Sql> {
  sqlPromise ??= createSql().catch((err) => {
    sqlPromise = null; // don't memoize failures — let the next call retry
    throw err;
  });
  return sqlPromise;
}

/**
 * The shared PGLite instance (preview only), with `migrations/*.sql` applied.
 * Lets Better Auth persist to the SAME embedded DB as app data in preview (via a
 * Kysely dialect). Throws when `DATABASE_URL` is set (that path uses Neon) and
 * in production.
 */
export async function getPglite(): Promise<import("@electric-sql/pglite").PGlite> {
  if (readDatabaseUrl() || isProductionRuntime()) {
    throw new Error("getPglite() is only available on the PGLite preview fallback");
  }
  await getSql();
  const pg = await globalRef.__pgliteInstance__;
  if (!pg) throw new Error("PGLite instance failed to initialize");
  return pg;
}

/**
 * Finish DB bootstrap before the server handles traffic.
 *
 * - **PGLite** (preview / no `DATABASE_URL`): open the in-memory DB and apply
 *   `migrations/*.sql`. Idempotent — concurrent callers share one promise.
 * - **Neon**: no-op (pool is created lazily on first query).
 * - **Production without DATABASE_URL**: fails closed.
 *
 * Vite `configureServer` awaits this at dev startup. Production must never
 * boot PGLite.
 */
export function ensureDbReady(): Promise<void> {
  assertProductionDatabaseUrl();
  if (readDatabaseUrl()) return Promise.resolve();
  return getSql().then(() => undefined);
}

// Preview-only eager start. Production never boots PGLite, including when
// NODE_ENV is inlined as "production" during `vite build` with an empty URL.
const globalBoot = globalThis as typeof globalThis & {
  __pgBootstrapPromise__?: Promise<void>;
};
if (typeof window === "undefined" && !isProductionRuntime() && !readDatabaseUrl()) {
  globalBoot.__pgBootstrapPromise__ ??= ensureDbReady().catch((err) => {
    globalBoot.__pgBootstrapPromise__ = undefined;
    console.error("[db] PGLite bootstrap failed:", err);
    throw err;
  });
}

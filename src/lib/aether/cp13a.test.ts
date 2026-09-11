/**
 * CP13A — SQL-created production LOGIN aether_app.
 * aether_runtime remains the PGLite/preview SET ROLE identity.
 * Occupancy SQL is not rewritten here.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { AETHER_APP_ROLE, AETHER_RUNTIME_ROLE } from "./runtime-role.ts";

const SQL_FILES = [
  "0002_foundation.sql",
  "0003_occupancy.sql",
  "0004_ops_auth.sql",
  "0005_time_domain.sql",
  "0006_booking_engine.sql",
  "0007_inventory.sql",
  "0008_guest_ux.sql",
  "0009_ops_desk.sql",
  "0010_hotel_white_label.sql",
  "0011_production_hardening.sql",
  "0012_cp12_tenancy.sql",
  "0013_cp12b_runtime_login.sql",
  "0014_cp13a_production_app_role.sql",
] as const;

const IMMUTABLE = {
  "0011_production_hardening.sql":
    "fbb2cd518f1f9b7795a5b4e4ec6577126218ece691ec249cee79484f9ef8a686",
  "0012_cp12_tenancy.sql":
    "b97d03c6c59dde476a5b5afa4b6b99cf71c5652c01a450f5051a565dc42151c3",
  "0013_cp12b_runtime_login.sql":
    "112995194d0933179cc5ad2ed6c29297b53c1cf371871c35f6c1a105c30775ad",
} as const;

function readMigration(name: string): string {
  return readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8");
}

function readSrc(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function openDb(): Promise<PGlite> {
  const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
  const pg = new PGlite({ extensions: { btree_gist } });
  await pg.waitReady;
  try {
    await pg.exec("create database neondb");
  } catch {
    /* already exists on a reused instance */
  }
  await pg.exec(
    "create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  for (const name of SQL_FILES) {
    await pg.exec(readMigration(name));
  }
  return pg;
}

describe("CP13A SQL-created production app role", () => {
  test("0011–0013 remain byte-identical and never mention aether_app", () => {
    for (const [name, expected] of Object.entries(IMMUTABLE)) {
      const text = readMigration(name);
      assert.equal(sha256(text), expected, name);
      assert.doesNotMatch(text, /aether_app/);
    }
  });

  test("0014 creates aether_app LOGIN without a password or neon_superuser grant", () => {
    const m14 = readMigration("0014_cp13a_production_app_role.sql");
    assert.match(m14, /create role aether_app/i);
    assert.match(m14, /login/i);
    assert.match(m14, /nosuperuser/i);
    assert.match(m14, /nocreatedb/i);
    assert.match(m14, /nocreaterole/i);
    assert.match(m14, /noreplication/i);
    assert.match(m14, /nobypassrls/i);
    assert.match(m14, /inherit/i);
    assert.match(m14, /grant connect on database postgres/i);
    assert.match(m14, /grant connect on database neondb/i);
    assert.match(m14, /create table if not exists public_booking_attempts/i);
    assert.match(m14, /create index if not exists public_booking_attempts_client_attempted_idx/i);
    assert.match(m14, /revoke update on table public_booking_attempts from aether_app/i);
    assert.match(m14, /grant select, insert, delete on table public_booking_attempts to aether_app/i);
    assert.match(m14, /revoke all on table _migrations from aether_app/i);
    assert.match(m14, /alter default privileges in schema public/i);
    assert.doesNotMatch(m14, /\$aether\$/);
    assert.doesNotMatch(m14, /\$sql\$/);
    assert.doesNotMatch(m14, /\$\$/);
    assert.doesNotMatch(m14, /^\s*do\s/im);
    assert.doesNotMatch(m14, /current_database\s*\(/);
    assert.doesNotMatch(m14, /comment on role/i);
    assert.doesNotMatch(m14, /password\s+'|identified by/i);
    assert.doesNotMatch(m14, /grant\s+neon_superuser/i);
    assert.doesNotMatch(m14, /alter role aether_runtime/i);
    assert.doesNotMatch(m14, /drop role aether_runtime/i);
    assert.doesNotMatch(m14, /alter role neondb_owner|drop role neondb_owner/i);
    assert.doesNotMatch(m14, /^\s*grant aether_app to current_user\b/im);
    assert.doesNotMatch(m14, /drop trigger|drop function aether_athens|drop constraint bookings_/i);
    assert.doesNotMatch(m14, /alter default privileges for role aether_app/i);
    assert.doesNotMatch(m14, /alter default privileges for role %I/i);
    assert.match(m14, /providers/);
    assert.match(m14, /hotel_provider_agreements/);
    assert.match(m14, /operator_memberships/);
    assert.match(m14, /public_booking_attempts/);

    const fragments = m14
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.length > 0 && !/^--/.test(part.split("\n").pop() ?? ""));
    assert.ok(fragments.length >= 10, "0014 should split into standalone statements");
    for (const fragment of fragments) {
      assert.doesNotMatch(fragment, /\$\$/);
      assert.doesNotMatch(fragment, /^\s*do\s/im);
    }
  });

  test("production identity is aether_app; preview SET ROLE remains aether_runtime", () => {
    assert.equal(AETHER_APP_ROLE, "aether_app");
    assert.equal(AETHER_RUNTIME_ROLE, "aether_runtime");

    const dbSrc = readSrc("../../lib/db.ts");
    assert.match(dbSrc, /set role aether_runtime/);
    assert.match(dbSrc, /reset role/);
    assert.doesNotMatch(dbSrc, /set role aether_app/);
    assert.doesNotMatch(dbSrc, /options:\s*`-c role=/);
    assert.match(dbSrc, /aether_app LOGIN/);

    const verifier = readFileSync(
      new URL("../../../scripts/verify-neon-production.mjs", import.meta.url),
      "utf8",
    );
    assert.match(verifier, /const RUNTIME = "aether_app"/);
    assert.match(verifier, /neon_superuser/);
    assert.match(verifier, /session_user/);
    assert.match(verifier, /rolreplication/);
    assert.match(verifier, /rolbypassrls/);
    assert.doesNotMatch(verifier, /options:\s*[`'"].*-c role=/);
    assert.doesNotMatch(verifier, /const RUNTIME = "aether_runtime"/);

    const occupancy = readMigration("0003_occupancy.sql");
    assert.match(occupancy, /bookings_occupies_before/);
    assert.match(occupancy, /aether_athens_instant/);
  });

  test("0014 applies: aether_app is least-privilege LOGIN; occupancy stays owner-owned", async () => {
    const pg = await openDb();
    const who = await pg.query<{ current_user: string }>("select current_user");
    assert.equal(who.rows[0]!.current_user, "postgres");

    const app = await pg.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
    }>(
      `select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
         from pg_roles where rolname = $1`,
      [AETHER_APP_ROLE],
    );
    assert.equal(app.rows.length, 1);
    assert.equal(app.rows[0]!.rolcanlogin, true);
    assert.equal(app.rows[0]!.rolsuper, false);
    assert.equal(app.rows[0]!.rolcreatedb, false);
    assert.equal(app.rows[0]!.rolcreaterole, false);
    assert.equal(app.rows[0]!.rolreplication, false);
    assert.equal(app.rows[0]!.rolbypassrls, false);

    const preview = await pg.query<{ rolcanlogin: boolean; rolsuper: boolean }>(
      `select rolcanlogin, rolsuper from pg_roles where rolname = $1`,
      [AETHER_RUNTIME_ROLE],
    );
    assert.equal(preview.rows.length, 1);
    assert.equal(preview.rows[0]!.rolcanlogin, true);
    assert.equal(preview.rows[0]!.rolsuper, false);

    const superMember = await pg.query<{ member: boolean }>(
      `select exists (
         select 1
           from pg_auth_members m
           join pg_roles g on g.oid = m.roleid
           join pg_roles u on u.oid = m.member
          where g.rolname = 'neon_superuser'
            and u.rolname = $1
       ) as member`,
      [AETHER_APP_ROLE],
    );
    assert.equal(superMember.rows[0]!.member, false);

    const meta = await pg.query<{ key: string; value: string }>(
      "select key, value from aether_meta",
    );
    const map = Object.fromEntries(meta.rows.map((row) => [row.key, row.value]));
    assert.equal(map.schema_phase, "13");
    assert.equal(map.checkpoint, "13a");
    assert.equal(map.production_role, AETHER_APP_ROLE);
    assert.equal(map.runtime_login, AETHER_APP_ROLE);
    assert.equal(map.runtime_role, AETHER_RUNTIME_ROLE);
    assert.equal(map.db_owner, "postgres");

    const owners = await pg.query<{ kind: string; owner: string }>(`
      select 'table' as kind, pg_get_userbyid(relowner) as owner
      from pg_class where relname = 'bookings'
      union all
      select 'function', pg_get_userbyid(proowner)
      from pg_proc where proname = 'aether_athens_instant'
      union all
      select 'extension', pg_get_userbyid(extowner)
      from pg_extension where extname = 'btree_gist'
    `);
    for (const row of owners.rows) {
      assert.equal(row.owner, "postgres", `${row.kind} owner`);
      assert.notEqual(row.owner, AETHER_APP_ROLE);
      assert.notEqual(row.owner, AETHER_RUNTIME_ROLE);
    }
    await pg.close();

    // Neon migration-preparation splits on raw semicolons. 0014 must apply
    // fragment-by-fragment with the same role semantics.
    const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
    const splitPg = new PGlite({ extensions: { btree_gist } });
    await splitPg.waitReady;
    await splitPg.exec("create database neondb");
    await splitPg.exec(
      "create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    for (const name of SQL_FILES) {
      if (name === "0014_cp13a_production_app_role.sql") continue;
      await splitPg.exec(readMigration(name));
    }
    const m14 = readMigration("0014_cp13a_production_app_role.sql");
    for (const fragment of m14.split(";")) {
      const sql = fragment.trim();
      if (!sql) continue;
      await splitPg.exec(sql);
    }
    const splitRole = await splitPg.query<{ rolcanlogin: boolean; rolsuper: boolean }>(
      `select rolcanlogin, rolsuper from pg_roles where rolname = $1`,
      [AETHER_APP_ROLE],
    );
    assert.equal(splitRole.rows.length, 1);
    assert.equal(splitRole.rows[0]!.rolcanlogin, true);
    assert.equal(splitRole.rows[0]!.rolsuper, false);
    const splitMeta = await splitPg.query<{ value: string }>(
      "select value from aether_meta where key = 'production_role'",
    );
    assert.equal(splitMeta.rows[0]!.value, AETHER_APP_ROLE);
    const splitLedger = await splitPg.query<{ ok: boolean }>(
      `select has_table_privilege($1, '_migrations', 'SELECT') as ok`,
      [AETHER_APP_ROLE],
    );
    assert.equal(splitLedger.rows[0]!.ok, false);
    await splitPg.close();
  });

  test("aether_app has production DML and is denied occupancy DDL and meta writes", async () => {
    const pg = await openDb();
    const priv = await pg.query<{
      bookings_select: boolean;
      bookings_insert: boolean;
      bookings_update: boolean;
      bookings_delete: boolean;
      bookings_truncate: boolean;
      bookings_trigger: boolean;
      bookings_references: boolean;
      meta_select: boolean;
      meta_insert: boolean;
      meta_update: boolean;
      schema_usage: boolean;
      schema_create: boolean;
      providers_dml: boolean;
      agreements_dml: boolean;
      memberships_dml: boolean;
      attempts_insert: boolean;
      attempts_update: boolean;
      attempts_delete: boolean;
      migrations_select: boolean;
      migrations_insert: boolean;
      migrations_update: boolean;
      migrations_delete: boolean;
      migrations_truncate: boolean;
      migrations_trigger: boolean;
      migrations_references: boolean;
      connect_postgres: boolean;
      connect_neondb: boolean;
    }>(
      `select
         has_table_privilege($1, 'bookings', 'SELECT') as bookings_select,
         has_table_privilege($1, 'bookings', 'INSERT') as bookings_insert,
         has_table_privilege($1, 'bookings', 'UPDATE') as bookings_update,
         has_table_privilege($1, 'bookings', 'DELETE') as bookings_delete,
         has_table_privilege($1, 'bookings', 'TRUNCATE') as bookings_truncate,
         has_table_privilege($1, 'bookings', 'TRIGGER') as bookings_trigger,
         has_table_privilege($1, 'bookings', 'REFERENCES') as bookings_references,
         has_table_privilege($1, 'aether_meta', 'SELECT') as meta_select,
         has_table_privilege($1, 'aether_meta', 'INSERT') as meta_insert,
         has_table_privilege($1, 'aether_meta', 'UPDATE') as meta_update,
         has_schema_privilege($1, 'public', 'USAGE') as schema_usage,
         has_schema_privilege($1, 'public', 'CREATE') as schema_create,
         has_table_privilege($1, 'providers', 'INSERT') as providers_dml,
         has_table_privilege($1, 'hotel_provider_agreements', 'INSERT') as agreements_dml,
         has_table_privilege($1, 'operator_memberships', 'INSERT') as memberships_dml,
         has_table_privilege($1, 'public_booking_attempts', 'INSERT') as attempts_insert,
         has_table_privilege($1, 'public_booking_attempts', 'UPDATE') as attempts_update,
         has_table_privilege($1, 'public_booking_attempts', 'DELETE') as attempts_delete,
         has_table_privilege($1, '_migrations', 'SELECT') as migrations_select,
         has_table_privilege($1, '_migrations', 'INSERT') as migrations_insert,
         has_table_privilege($1, '_migrations', 'UPDATE') as migrations_update,
         has_table_privilege($1, '_migrations', 'DELETE') as migrations_delete,
         has_table_privilege($1, '_migrations', 'TRUNCATE') as migrations_truncate,
         has_table_privilege($1, '_migrations', 'TRIGGER') as migrations_trigger,
         has_table_privilege($1, '_migrations', 'REFERENCES') as migrations_references,
         has_database_privilege($1, 'postgres', 'CONNECT') as connect_postgres,
         has_database_privilege($1, 'neondb', 'CONNECT') as connect_neondb`,
      [AETHER_APP_ROLE],
    );
    const p = priv.rows[0]!;
    assert.equal(p.bookings_select, true);
    assert.equal(p.bookings_insert, true);
    assert.equal(p.bookings_update, true);
    assert.equal(p.bookings_delete, true);
    assert.equal(p.bookings_truncate, false);
    assert.equal(p.bookings_trigger, false);
    assert.equal(p.bookings_references, false);
    assert.equal(p.meta_select, true);
    assert.equal(p.meta_insert, false);
    assert.equal(p.meta_update, false);
    assert.equal(p.schema_usage, true);
    assert.equal(p.schema_create, false);
    assert.equal(p.providers_dml, true);
    assert.equal(p.agreements_dml, true);
    assert.equal(p.memberships_dml, true);
    assert.equal(p.attempts_insert, true);
    assert.equal(p.attempts_update, false);
    assert.equal(p.attempts_delete, true);
    assert.equal(p.migrations_select, false);
    assert.equal(p.migrations_insert, false);
    assert.equal(p.migrations_update, false);
    assert.equal(p.migrations_delete, false);
    assert.equal(p.migrations_truncate, false);
    assert.equal(p.migrations_trigger, false);
    assert.equal(p.migrations_references, false);
    assert.equal(p.connect_postgres, true);
    assert.equal(p.connect_neondb, true);

    const exec = await pg.query<{ ok: boolean }>(
      `select has_function_privilege($1, 'aether_athens_instant(date, time)', 'EXECUTE') as ok`,
      [AETHER_APP_ROLE],
    );
    assert.equal(exec.rows[0]!.ok, true);

    await pg.exec(`set role ${AETHER_RUNTIME_ROLE}`);
    const previewWho = await pg.query<{ current_user: string }>("select current_user");
    assert.equal(previewWho.rows[0]!.current_user, AETHER_RUNTIME_ROLE);
    await pg.exec("reset role");
    await pg.close();
  });
});

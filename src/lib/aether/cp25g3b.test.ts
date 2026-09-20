import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { AETHER_APP_ROLE } from "./runtime-role.ts";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

const AUTH_TABLES = ["user", "session", "account", "verification"] as const;
const DML = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;
const DDL_PRIVS = ["TRUNCATE", "REFERENCES", "TRIGGER"] as const;

function errCode(err: unknown): string {
  return String((err as { code?: string })?.code ?? "");
}

test("0017 still historically revokes Better Auth table privileges", () => {
  const m17 = read("migrations/0017_cp16_runtime_privilege_hardening.sql");
  assert.match(m17, /Unused Better Auth tables/);
  assert.match(m17, /revoke all on table "user" from aether_app/);
  assert.match(m17, /revoke all on table "session" from aether_app/);
  assert.match(m17, /revoke all on table "account" from aether_app/);
  assert.match(m17, /revoke all on table "verification" from aether_app/);
});

test("0022 restores only Better Auth DML and does not grant DDL or owner inheritance", () => {
  const m22 = read("migrations/0022_cp25g3_better_auth_runtime_privileges.sql");
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

  assert.match(m22, /grant select, insert, update, delete on table "user" to aether_app/);
  assert.match(m22, /grant select, insert, update, delete on table "session" to aether_app/);
  assert.match(m22, /grant select, insert, update, delete on table "account" to aether_app/);
  assert.match(m22, /grant select, insert, update, delete on table "verification" to aether_app/);

  assert.doesNotMatch(m22, /create role/i);
  assert.doesNotMatch(m22, /grant aether_app to/i);
  assert.doesNotMatch(m22, /grant .+ to neondb_owner/i);
  assert.doesNotMatch(m22, /alter default privileges/i);
  assert.doesNotMatch(m22, /create table/i);
  assert.doesNotMatch(m22, /drop table/i);
  assert.doesNotMatch(m22, /truncate/i);
  assert.doesNotMatch(m22, /enable row level security/i);
  assert.doesNotMatch(m22, /grant .+ on table hotels/i);
  assert.doesNotMatch(m22, /grant .+ on table bookings/i);
  assert.doesNotMatch(m22, /grant .+ on table operator_memberships/i);
  assert.doesNotMatch(m22, /AETHER_DATABASE_OWNER_URL/);
  assert.doesNotMatch(m22, /BETTER_AUTH_SECRET/);
  assert.doesNotMatch(m22, /DATABASE_URL/);
  assert.doesNotMatch(pkg.scripts.build, /db:migrate/);
  assert.doesNotMatch(pkg.scripts.build, /0022_cp25g3/);
});

test("after 0017 revoke, 0022 lets aether_app DML Better Auth tables but not DDL", async () => {
  const pg = new PGlite();
  await pg.waitReady;
  await pg.exec(read("migrations/0001_auth.sql"));
  await pg.exec(`
    create role ${AETHER_APP_ROLE} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit;
    revoke create on schema public from public;
    revoke create on schema public from ${AETHER_APP_ROLE};
    grant usage on schema public to ${AETHER_APP_ROLE};
    revoke all on table "user" from ${AETHER_APP_ROLE};
    revoke all on table "session" from ${AETHER_APP_ROLE};
    revoke all on table "account" from ${AETHER_APP_ROLE};
    revoke all on table "verification" from ${AETHER_APP_ROLE};
  `);

  await pg.exec(`set role ${AETHER_APP_ROLE}`);
  try {
    await pg.exec(`insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt")
      values ('u1','n','a@example.com', false, now(), now())`);
    assert.fail("insert as aether_app should fail before 0022");
  } catch (err) {
    assert.equal(errCode(err), "42501");
  }
  await pg.exec("reset role");

  await pg.exec(read("migrations/0022_cp25g3_better_auth_runtime_privileges.sql"));

  const priv = await pg.query<{
    table_name: string;
    sel: boolean;
    ins: boolean;
    upd: boolean;
    del: boolean;
    trunc: boolean;
    refs: boolean;
    trig: boolean;
  }>(
    `select t as table_name,
            has_table_privilege($1, format('%I', t), 'SELECT') as sel,
            has_table_privilege($1, format('%I', t), 'INSERT') as ins,
            has_table_privilege($1, format('%I', t), 'UPDATE') as upd,
            has_table_privilege($1, format('%I', t), 'DELETE') as del,
            has_table_privilege($1, format('%I', t), 'TRUNCATE') as trunc,
            has_table_privilege($1, format('%I', t), 'REFERENCES') as refs,
            has_table_privilege($1, format('%I', t), 'TRIGGER') as trig
       from unnest($2::text[]) as t`,
    [AETHER_APP_ROLE, [...AUTH_TABLES]],
  );
  assert.equal(priv.rows.length, 4);
  for (const row of priv.rows) {
    assert.equal(row.sel, true, `${row.table_name} SELECT`);
    assert.equal(row.ins, true, `${row.table_name} INSERT`);
    assert.equal(row.upd, true, `${row.table_name} UPDATE`);
    assert.equal(row.del, true, `${row.table_name} DELETE`);
    assert.equal(row.trunc, false, `${row.table_name} TRUNCATE`);
    assert.equal(row.refs, false, `${row.table_name} REFERENCES`);
    assert.equal(row.trig, false, `${row.table_name} TRIGGER`);
  }

  await pg.exec(`set role ${AETHER_APP_ROLE}`);
  await pg.exec(`insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt")
    values ('u1','n','a@example.com', false, now(), now())`);
  await pg.exec(`insert into "account" ("id","accountId","providerId","userId","password","createdAt","updatedAt")
    values ('a1','u1','credential','u1','hash', now(), now())`);
  await pg.exec(`insert into "session" ("id","expiresAt","token","createdAt","updatedAt","userId")
    values ('s1', now() + interval '1 day', 'tok', now(), now(), 'u1')`);
  await pg.exec(`insert into "verification" ("id","identifier","value","expiresAt","createdAt","updatedAt")
    values ('v1','a@example.com','code', now() + interval '1 hour', now(), now())`);
  await pg.exec(`update "session" set "updatedAt" = now() where "id" = 's1'`);
  await pg.exec(`delete from "session" where "id" = 's1'`);

  try {
    await pg.exec("create table cp25g3b_pwn (id int)");
    assert.fail("aether_app must not CREATE TABLE");
  } catch (err) {
    assert.equal(errCode(err), "42501");
  }
  try {
    await pg.exec(`alter table "user" add column cp25g3b_pwn text`);
    assert.fail("aether_app must not ALTER TABLE");
  } catch (err) {
    assert.equal(errCode(err), "42501");
  }
  await pg.exec("reset role");

  void DML;
  void DDL_PRIVS;
});

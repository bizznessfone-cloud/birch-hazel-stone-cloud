import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

test("CP22 enables real operator email/password authentication", () => {
  const flag = read("src/lib/auth/email-password.ts");
  assert.match(flag, /emailAndPasswordEnabled\s*=\s*true/);

  const authRoute = read("src/routes/api/auth/$.ts");
  assert.match(authRoute, /createFileRoute\("\/api\/auth\/\$"\)/);
  assert.match(authRoute, /auth\.handler\(request\)/);

  const login = read("src/routes/login.tsx");
  assert.match(login, /authClient\.signUp\.email/);
  assert.match(login, /authClient\.signIn\.email/);
});

test("CP22 app surface is distinct from the internal Ops surface", () => {
  const app = read("src/routes/app.tsx");
  const onboarding = read("src/routes/app.onboarding.tsx");
  const preview = read("src/routes/app.hotels.$hotelId.preview.tsx");
  assert.match(app, /\/app/);
  assert.match(app, /RedirectToSignIn/);
  assert.match(onboarding, /createOnboardingHotel/);
  assert.match(onboarding, /createOnboardingService/);
  assert.match(onboarding, /createOnboardingDestination/);
  assert.match(onboarding, /Prepare hotel for activation|prepareOnboardingHotel/);
  assert.match(preview, /<GuestBook/);
  assert.match(preview, /preview/);
});

test("CP22 onboarding migration keeps provisioning DML behind narrow functions", () => {
  const migration = read("migrations/0018_cp22_saas_onboarding.sql");
  assert.match(migration, /create table if not exists app_hotel_accounts/);
  assert.match(migration, /create table if not exists hotel_services/);
  assert.match(migration, /security definer/gi);
  assert.match(migration, /sbg_create_hotel_for_user/);
  assert.match(migration, /sbg_create_service_for_user/);
  assert.match(migration, /sbg_add_destination_for_user/);
  assert.match(migration, /sbg_promote_configured_for_user/);
  assert.match(migration, /grant execute on function sbg_create_hotel_for_user/);
  assert.match(migration, /revoke all on table app_hotel_accounts from aether_app/);
  assert.match(migration, /revoke all on table hotel_services from aether_app/);
  assert.doesNotMatch(migration, /create role/i);
  assert.doesNotMatch(migration, /alter table bookings/i);
  assert.doesNotMatch(migration, /exclude/i);
});

test("Better Auth migration copy remains byte-identical to its canonical source", () => {
  assert.equal(read("migrations/0001_auth.sql"), read("migrations/auth/0001_auth.sql"));
});

test("CP22 does not repurpose the internal Ops hotel management route", () => {
  const opsHotels = read("src/routes/ops.hotels.tsx");
  assert.match(opsHotels, /opsUpsertHotel/);
  const app = read("src/routes/app.tsx");
  assert.doesNotMatch(app, /opsUpsertHotel/);
});

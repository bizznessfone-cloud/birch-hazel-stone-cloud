import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

test("CP23 adds a public hotel slug without replacing internal hotel code identity", () => {
  const migration = read("migrations/0019_cp23_public_hotel_slug.sql");
  assert.match(migration, /add column if not exists public_slug/i);
  assert.match(migration, /create unique index if not exists hotels_public_slug_uidx/i);
  assert.match(migration, /sbg_assign_public_slug/);
    assert.doesNotMatch(migration, /drop.*occup/i);
  assert.doesNotMatch(migration, /create role/i);

  const booking = read("src/lib/aether/booking.ts");
  assert.match(booking, /getPublicHotelBySlug/);
  assert.match(booking, /where public_slug = \$1/);
  assert.match(booking, /hotelCode: string/);
});

test("CP23 public route is a root-level hotel slug and keeps system paths static", () => {
  const route = read("src/routes/$hotelSlug.tsx");
  assert.match(route, /createFileRoute\("\/\$hotelSlug"\)/);
  assert.match(route, /getPublicHotelBySlug/);
  assert.match(route, /<GuestBook/);
  assert.doesNotMatch(route, //ops\//);
  assert.doesNotMatch(route, //app\//);
});

test("CP23 operator URLs and QR target the human-readable slug", () => {
  for (const path of [
    "src/routes/app.hotels.$hotelId.tsx",
    "src/routes/app.hotels.$hotelId.qr.tsx",
    "src/routes/app.onboarding.tsx",
  ]) {
    assert.match(read(path), /public_slug|publicSlug/);
    assert.doesNotMatch(read(path), /"\/book/" \+ (hotel|item\.hotel)\.code/);
  }
});

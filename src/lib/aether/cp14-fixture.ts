/**
 * Test-only CP14 live catalogue. Production provisioning is CP14.3.
 * Promotes seeded hotels so existing createBooking callers exercise the live path.
 */
import { readFileSync } from "node:fs";

const MIGRATION_0015 = readFileSync(
  new URL("../../../migrations/0015_cp14_hotel_configuration.sql", import.meta.url),
  "utf8",
);
const MIGRATION_0016 = readFileSync(
  new URL("../../../migrations/0016_cp14_hotel_timezone.sql", import.meta.url),
  "utf8",
);

export const CP14_DEFAULT_DESTINATION_NAME = "ATH";
export const CP14_DEFAULT_AMOUNT_MINOR = 4500;

type PgLike = {
  exec(sql: string): Promise<unknown>;
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export async function applyCp14LiveCatalog(pg: PgLike): Promise<Record<string, string>> {
  await pg.exec(MIGRATION_0015);
  await pg.exec(MIGRATION_0016);
  await pg.exec("update hotels set status = 'live'");
  const hotels = await pg.query<{ id: string; code: string }>("select id, code from hotels");
  const destinationIdByCode: Record<string, string> = {};
  for (const hotel of hotels.rows) {
    const existing = await pg.query<{ id: string }>(
      `select id
         from hotel_destinations
        where hotel_id = $1::uuid
          and kind = 'airport'
          and lower(btrim(name)) = $2
        limit 1`,
      [hotel.id, CP14_DEFAULT_DESTINATION_NAME.toLowerCase()],
    );
    if (existing.rows[0]) {
      destinationIdByCode[hotel.code] = existing.rows[0].id;
      continue;
    }
    const inserted = await pg.query<{ id: string }>(
      `insert into hotel_destinations (hotel_id, kind, name, sort_order, amount_minor)
       values ($1::uuid, 'airport', $2, 10, $3)
       returning id`,
      [hotel.id, CP14_DEFAULT_DESTINATION_NAME, CP14_DEFAULT_AMOUNT_MINOR],
    );
    destinationIdByCode[hotel.code] = inserted.rows[0]!.id;
  }
  return destinationIdByCode;
}

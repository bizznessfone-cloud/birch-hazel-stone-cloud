#!/usr/bin/env node
/**
 * Owner-only hotel provisioner (node-postgres, `pg`).
 *
 * Uses AETHER_DATABASE_OWNER_URL only — the same owner class as migrate.mjs.
 * DATABASE_URL is never a fallback. Missing owner URL in production fails.
 * Preview without owner URL skips (exit 0). Never SET ROLE. Never log URLs.
 *
 * Not a public route. Not an /ops command. Guest code must not import this.
 *
 * Usage:
 *   node --experimental-strip-types scripts/provision-hotel.mjs <command> [json]
 *
 * Commands: create-hotel | configure-hotel | upsert-destination |
 *           ensure-provider | establish-agreement | validate |
 *           promote-configured | promote-live | provision | grant-hotel-desk
 *
 * JSON may be an argument, stdin, or @path. `provision` goLive defaults to false.
 */
import { readFile } from "node:fs/promises";
import pg from "pg";
import { resolveMigratePlan } from "./migrate-policy.mjs";

const plan = resolveMigratePlan(process.env);
if (plan.action === "skip") {
  console.log(`[provision] ${plan.reason}`);
  process.exit(0);
}
if (plan.action === "fail") {
  console.error(`[provision] ${plan.reason}`);
  process.exit(1);
}

const ownerUrl = plan.ownerUrl;

function redact(value) {
  return String(value ?? "").replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[redacted]");
}

function usage() {
  return `owner-only hotel provisioner
commands: create-hotel | configure-hotel | upsert-destination | ensure-provider
          establish-agreement | validate | promote-configured | promote-live | provision
          grant-hotel-desk
pass JSON as the second argument, via stdin, or as @file
provision goLive defaults to false — LIVE requires an explicit goLive:true
grant-hotel-desk requires hotelId or hotelCode, and operatorId or login
the operator must already exist; existing hats are not overridden`;
}

async function readPayload(raw) {
  if (raw == null || raw === "") {
    if (process.stdin.isTTY) return {};
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8").trim();
    return text ? JSON.parse(text) : {};
  }
  if (raw.startsWith("@")) {
    const text = await readFile(raw.slice(1), "utf8");
    return JSON.parse(text);
  }
  return JSON.parse(raw);
}

function asDb(client) {
  return {
    async query(text, params = []) {
      return (await client.query(text, params)).rows;
    },
    async transaction(fn) {
      await client.query("BEGIN");
      try {
        const inner = {
          query: async (text, params = []) => (await client.query(text, params)).rows,
          transaction: async () => {
            throw new Error("nested");
          },
        };
        const result = await fn(inner);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // keep the original error if rollback fails
        }
        throw err;
      }
    },
  };
}

async function main() {
  const command = (process.argv[2] || "").trim();
  if (!command || command === "--help" || command === "-h") {
    console.log(usage());
    process.exit(command ? 0 : 1);
  }

  const payload = await readPayload(process.argv[3]);
  const {
    configureHotel,
    createHotel,
    ensureProvider,
    establishActiveAgreement,
    loadHotel,
    loadHotelByCode,
    promoteHotelToConfigured,
    promoteHotelToLive,
    provisionHotel,
    upsertHotelDestination,
    validateHotelForLive,
  } = await import("../src/lib/aether/provision.ts");
  const { normalizeLogin } = await import("../src/lib/aether/ops-auth.ts");
  const { grantHotelDesk } = await import("../src/lib/aether/tenancy.ts");

  async function resolveHotelId(db, body) {
    if (body.hotelId) {
      const hotel = await loadHotel(db, body.hotelId);
      return hotel.id;
    }
    if (body.hotelCode) {
      const hotel = await loadHotelByCode(db, body.hotelCode);
      return hotel.id;
    }
    throw new Error("hotelId or hotelCode is required");
  }

  async function resolveOperatorId(db, body) {
    if (body.operatorId) {
      const rows = await db.query("select id from operators where id = $1::uuid", [
        body.operatorId,
      ]);
      if (!rows[0]) throw new Error("operator not found");
      return rows[0].id;
    }
    const login = normalizeLogin(String(body.login ?? ""));
    if (!login) throw new Error("operatorId or login is required");
    const existing = await db.query("select id from operators where login = $1", [login]);
    if (!existing[0]) throw new Error("operator not found");
    return existing[0].id;
  }

  async function dispatch(db, op, body) {
    switch (op) {
      case "create-hotel":
        return createHotel(db, body);
      case "configure-hotel":
        return configureHotel(db, {
          hotelId: await resolveHotelId(db, body),
          code: body.code,
          name: body.name,
          locality: body.locality,
          ianaTimezone: body.ianaTimezone,
          currency: body.currency,
        });
      case "upsert-destination":
        return upsertHotelDestination(db, {
          hotelId: await resolveHotelId(db, body),
          id: body.id ?? null,
          kind: body.kind,
          name: body.name,
          sortOrder: body.sortOrder,
          active: body.active,
          amountMinor: body.amountMinor,
        });
      case "ensure-provider":
        return ensureProvider(db, body);
      case "establish-agreement":
        return establishActiveAgreement(db, {
          hotelId: await resolveHotelId(db, body),
          providerId: body.providerId,
        });
      case "validate": {
        const hotelId = await resolveHotelId(db, body);
        return validateHotelForLive(db, hotelId);
      }
      case "promote-configured":
        return promoteHotelToConfigured(db, await resolveHotelId(db, body));
      case "promote-live":
        return promoteHotelToLive(db, await resolveHotelId(db, body));
      case "provision":
        return provisionHotel(db, {
          hotel: body.hotel,
          destinations: body.destinations ?? [],
          provider: body.provider,
          goLive: body.goLive === true,
        });
      case "load":
        return body.hotelId
          ? loadHotel(db, body.hotelId)
          : loadHotelByCode(db, body.hotelCode);
      case "grant-hotel-desk": {
        const hotelId = await resolveHotelId(db, body);
        const operatorId = await resolveOperatorId(db, body);
        const hats = await db.query(
          `select id, access_class, hotel_id
             from operator_memberships
            where operator_id = $1::uuid and active`,
          [operatorId],
        );
        const same = hats.find(
          (row) => row.access_class === "hotel_desk" && row.hotel_id === hotelId,
        );
        if (same) {
          return {
            operatorId,
            membershipId: same.id,
            hotelId,
            accessClass: "hotel_desk",
            alreadyHeld: true,
          };
        }
        if (hats.length > 0) {
          throw new Error("operator already has an active membership");
        }
        const membershipId = await grantHotelDesk(db, operatorId, hotelId);
        return {
          operatorId,
          membershipId,
          hotelId,
          accessClass: "hotel_desk",
          alreadyHeld: false,
        };
      }
      default:
        throw new Error(usage());
    }
  }

  const pool = new pg.Pool({ connectionString: ownerUrl, max: 1 });
  const client = await pool.connect();
  try {
    const result = await dispatch(asDb(client), command, payload);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[provision] failed:", redact(err?.message || err));
  if (Array.isArray(err?.issues) && err.issues.length > 0) {
    for (const issue of err.issues) {
      console.error(`[provision]   - ${redact(issue)}`);
    }
  }
  if (err?.code != null) console.error(`[provision]   code: ${err.code}`);
  process.exit(1);
});

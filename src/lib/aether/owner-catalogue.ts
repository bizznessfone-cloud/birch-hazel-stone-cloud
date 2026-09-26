/**
 * CP26C-O3.3 — Owner commercial catalogue.
 * Reads sbg_saas_* only. Mutations call 0026 functions. Never Stripe, never
 * commerce mode, never hotel publication, never guest-transfer prices.
 */
import type { Sql } from "@/lib/db";
import { requirePlatformOwner } from "./owner-auth.ts";

import { HISTORICAL_PLAN_CODES, PROPERTY_LICENCE_PLAN } from "./property-licence.ts";

export const CATALOGUE_PLAN_CODES = [PROPERTY_LICENCE_PLAN, ...HISTORICAL_PLAN_CODES] as const;
export type CataloguePlanCode = (typeof CATALOGUE_PLAN_CODES)[number];

export type MappingStatus = "not_mapped" | "verified" | "replaced";

export type OwnerPriceVersion = {
  id: string;
  amountMinor: number;
  amountLabel: string;
  currency: "EUR";
  interval: "month";
  createdAt: string;
  effectiveFrom: string | null;
  retiredAt: string | null;
  purchasable: boolean;
  state: "purchasable" | "draft" | "retired";
  testMapping: MappingStatus;
  liveMapping: MappingStatus;
  liveLabel: string;
};

export type OwnerCataloguePlan = {
  code: CataloguePlanCode;
  name: string;
  description: string;
  sortOrder: number;
  active: boolean;
  currentPrice: string;
  versions: OwnerPriceVersion[];
};

export type OwnerCatalogueActivity = {
  action: string;
  label: string;
  target: string;
  at: string;
  actor: string;
};

export type OwnerCatalogue = {
  plans: OwnerCataloguePlan[];
  liveLocked: boolean;
  liveCaption: "LIVE commerce locked until CP31";
  activity: OwnerCatalogueActivity[];
};

export class CatalogueCommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CatalogueCommandError";
    this.code = code;
  }
}

const LIVE_CAPTION = "LIVE commerce locked until CP31" as const;
const CLOSED = "Catalogue change could not be saved.";

const ACTION_LABELS: Record<string, string> = {
  "catalogue.plan.created": "Plan created",
  "catalogue.plan.updated": "Plan updated",
  "catalogue.price.created": "Price created",
  "catalogue.price.activated": "Price activated",
  "catalogue.price.retired": "Price retired",
  "catalogue.stripe_mapping.created": "Stripe mapping created",
  "catalogue.stripe_mapping.replaced": "Stripe mapping replaced",
};

export function parseEurMajorToMinor(input: string):
  | { ok: true; amountMinor: number }
  | { ok: false; code: "zero" | "negative" | "malformed" | "precision" } {
  const raw = String(input ?? "").trim();
  if (!raw || /[eE+]/.test(raw) || raw.includes(",")) {
    return { ok: false, code: raw.startsWith("-") ? "negative" : "malformed" };
  }
  if (raw.startsWith("-")) return { ok: false, code: "negative" };
  const match = /^(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match) return { ok: false, code: "malformed" };
  const whole = match[1] ?? "";
  const frac = match[2] ?? "";
  if (whole.length > 1 && whole.startsWith("0")) return { ok: false, code: "malformed" };
  if (frac.length > 2) return { ok: false, code: "precision" };
  const minor = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  if (!Number.isSafeInteger(minor) || minor > 2_147_483_647) return { ok: false, code: "malformed" };
  if (minor === 0) return { ok: false, code: "zero" };
  if (minor < 0) return { ok: false, code: "negative" };
  return { ok: true, amountMinor: minor };
}

export function formatEurMinor(amountMinor: number): string {
  const minor = Math.trunc(amountMinor);
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}€${whole}.${frac}`;
}

export function liveMappingLabel(liveMappingEnabled: boolean, status: MappingStatus): string {
  const word = status === "verified" ? "Verified" : status === "replaced" ? "Replaced" : "Not mapped";
  return liveMappingEnabled ? word : `${word} / Locked`;
}

export function priceVersionState(row: { purchasable: boolean; retiredAt: string | null }): OwnerPriceVersion["state"] {
  if (row.retiredAt) return "retired";
  if (row.purchasable) return "purchasable";
  return "draft";
}

function text(value: unknown): string {
  return value == null ? "" : String(value);
}

function bool(value: unknown): boolean {
  return value === true || value === "t" || value === "true";
}

function isPlanCode(value: string): value is CataloguePlanCode {
  return (CATALOGUE_PLAN_CODES as readonly string[]).includes(value);
}

function pgCode(err: unknown): string {
  if (typeof err === "object" && err && "code" in err) return String((err as { code?: unknown }).code ?? "");
  return "";
}

export function translateCatalogueError(err: unknown): CatalogueCommandError {
  if (err instanceof CatalogueCommandError) return err;
  const code = pgCode(err);
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (code === "42501" || /not a platform owner/i.test(message)) {
    return new CatalogueCommandError("forbidden", "Owner access required.");
  }
  if (code === "P0002" || /plan not found/i.test(message)) {
    return new CatalogueCommandError("not_found", "That catalogue record was not found.");
  }
  if (/price version not found/i.test(message)) {
    return new CatalogueCommandError("not_found", "That price version was not found.");
  }
  if (/historical plan cannot receive a price version/i.test(message)) {
    return new CatalogueCommandError("inactive", "Historical plans cannot receive a price version.");
  }
  if (/plan inactive/i.test(message)) {
    return new CatalogueCommandError("inactive", "An inactive plan cannot offer a purchasable price.");
  }
  if (/already retired/i.test(message)) {
    return new CatalogueCommandError("retired", "That price version is already retired.");
  }
  if (/price version retired|retired price/i.test(message)) {
    return new CatalogueCommandError("retired", "A retired price cannot be made purchasable.");
  }
  if (code === "22023" || /invalid commercial price|invalid plan/i.test(message)) {
    return new CatalogueCommandError("invalid", "That catalogue change is not valid.");
  }
  if (code === "23505" || /duplicate key|unique constraint/i.test(message)) {
    return new CatalogueCommandError("conflict", "The catalogue changed. Reload and try again.");
  }
  return new CatalogueCommandError("closed", CLOSED);
}

function assertPlanCode(code: string): CataloguePlanCode {
  if (!isPlanCode(code)) throw new CatalogueCommandError("invalid", "Unknown plan.");
  return code;
}

function mappingStatus(rows: Array<{ status: string }>): MappingStatus {
  if (rows.some((row) => row.status === "verified")) return "verified";
  if (rows.some((row) => row.status === "replaced")) return "replaced";
  return "not_mapped";
}

export async function loadOwnerCatalogue(db: Sql): Promise<OwnerCatalogue> {
  const plans = await db.query<{
    code: string;
    name: string;
    description: string;
    sort_order: number;
    active: boolean;
  }>(
    `select code, name, description, sort_order, active
       from sbg_saas_plans
      order by sort_order, code`,
  );
  const versions = await db.query<{
    id: string;
    plan_code: string;
    currency: string;
    amount_minor: number;
    billing_interval: string;
    created_at: string;
    effective_from: string | null;
    retired_at: string | null;
    purchasable: boolean;
  }>(
    `select id::text as id,
            plan_code,
            currency,
            amount_minor,
            billing_interval,
            created_at::text as created_at,
            effective_from::text as effective_from,
            retired_at::text as retired_at,
            purchasable
       from sbg_saas_price_versions
      order by created_at desc`,
  );
  const mappings = await db.query<{
    price_version_id: string;
    environment: string;
    status: string;
  }>(
    `select price_version_id::text as price_version_id, environment, status
       from sbg_saas_stripe_mappings`,
  );
  const locks = await db.query<{ live_mapping_enabled: boolean; live_checkout_enabled: boolean }>(
    `select live_mapping_enabled, live_checkout_enabled
       from sbg_saas_commerce_locks
      where id = 1`,
  );
  const activity = await db.query<{
    action: string;
    target_type: string;
    target_id: string;
    at: string;
    actor: string;
  }>(
    `select e.action,
            e.target_type,
            e.target_id,
            e.at::text as at,
            case
              when e.actor_user_id is null then 'System'
              when u.name is not null and btrim(u.name) <> '' then u.name
              else 'Owner'
            end as actor
       from sbg_owner_audit_events e
       left join "user" u on u.id = e.actor_user_id
      where e.action like 'catalogue.%'
      order by e.at desc
      limit 24`,
  );

  const liveMappingEnabled = bool(locks[0]?.live_mapping_enabled);
  const byPlan = new Map<string, OwnerPriceVersion[]>();
  for (const row of versions) {
    const versionMappings = mappings.filter((item) => item.price_version_id === row.id);
    const testMapping = mappingStatus(versionMappings.filter((item) => item.environment === "test"));
    const liveMapping = mappingStatus(versionMappings.filter((item) => item.environment === "live"));
    const retiredAt = row.retired_at ? text(row.retired_at) : null;
    const purchasable = bool(row.purchasable);
    const view: OwnerPriceVersion = {
      id: text(row.id),
      amountMinor: Number(row.amount_minor),
      amountLabel: formatEurMinor(Number(row.amount_minor)),
      currency: "EUR",
      interval: "month",
      createdAt: text(row.created_at),
      effectiveFrom: row.effective_from ? text(row.effective_from) : null,
      retiredAt,
      purchasable,
      state: priceVersionState({ purchasable, retiredAt }),
      testMapping,
      liveMapping,
      liveLabel: liveMappingLabel(liveMappingEnabled, liveMapping),
    };
    const list = byPlan.get(row.plan_code) ?? [];
    list.push(view);
    byPlan.set(row.plan_code, list);
  }

  return {
    plans: plans.filter((plan) => isPlanCode(plan.code)).map((plan) => {
      const history = byPlan.get(plan.code) ?? [];
      const current = history.find((version) => version.purchasable);
      return {
        code: plan.code as CataloguePlanCode,
        name: text(plan.name),
        description: text(plan.description),
        sortOrder: Number(plan.sort_order),
        active: bool(plan.active),
        currentPrice: current ? formatEurMinor(current.amountMinor) : "Price not configured",
        versions: history,
      };
    }),
    liveLocked: !liveMappingEnabled && !bool(locks[0]?.live_checkout_enabled),
    liveCaption: LIVE_CAPTION,
    activity: activity.map((row) => ({
      action: text(row.action),
      label: ACTION_LABELS[text(row.action)] ?? "Catalogue event",
      target: text(row.target_id),
      at: text(row.at),
      actor: text(row.actor),
    })),
  };
}

export async function updateOwnerPlan(
  db: Sql,
  actorUserId: string,
  input: { code: string; name: string; description: string; active: boolean },
): Promise<void> {
  await requirePlatformOwner(db, actorUserId);
  const code = assertPlanCode(input.code);
  const name = String(input.name ?? "").trim();
  if (!name || name.length > 80) throw new CatalogueCommandError("invalid", "Plan name is required.");
  const description = String(input.description ?? "");
  if (description.length > 400) throw new CatalogueCommandError("invalid", "Description is too long.");
  const existing = await db.query<{ sort_order: number }>(
    `select sort_order from sbg_saas_plans where code = $1`,
    [code],
  );
  const sortOrder = existing[0]?.sort_order;
  if (sortOrder == null) throw new CatalogueCommandError("not_found", "That catalogue record was not found.");
  try {
    await db.query(
      `select sbg_catalogue_update_plan($1, $2, $3, $4, $5, $6)`,
      [actorUserId, code, name, description, sortOrder, input.active],
    );
  } catch (err) {
    throw translateCatalogueError(err);
  }
}

export async function createOwnerPriceVersion(
  db: Sql,
  actorUserId: string,
  input: { code: string; amount: string },
): Promise<{ id: string }> {
  await requirePlatformOwner(db, actorUserId);
  const code = assertPlanCode(input.code);
  const parsed = parseEurMajorToMinor(input.amount);
  if (!parsed.ok) {
    const message =
      parsed.code === "zero"
        ? "Amount must be greater than zero."
        : parsed.code === "negative"
          ? "Amount cannot be negative."
          : parsed.code === "precision"
            ? "Use at most two decimal places."
            : "Enter a valid EUR amount.";
    throw new CatalogueCommandError(parsed.code, message);
  }
  try {
    const rows = await db.query<{ id: string }>(
      `select sbg_catalogue_create_price_version($1, $2, $3::integer, 'EUR', 'month', 1::smallint)::text as id`,
      [actorUserId, code, parsed.amountMinor],
    );
    const id = rows[0]?.id;
    if (!id) throw new CatalogueCommandError("closed", CLOSED);
    return { id };
  } catch (err) {
    throw translateCatalogueError(err);
  }
}

export async function activateOwnerPriceVersion(
  db: Sql,
  actorUserId: string,
  priceVersionId: string,
): Promise<void> {
  await requirePlatformOwner(db, actorUserId);
  if (!/^[0-9a-f-]{36}$/i.test(priceVersionId)) {
    throw new CatalogueCommandError("invalid", "That price version was not found.");
  }
  try {
    await db.query(`select sbg_catalogue_activate_price_version($1, $2::uuid)`, [
      actorUserId,
      priceVersionId,
    ]);
  } catch (err) {
    throw translateCatalogueError(err);
  }
}

export async function retireOwnerPriceVersion(
  db: Sql,
  actorUserId: string,
  priceVersionId: string,
): Promise<void> {
  await requirePlatformOwner(db, actorUserId);
  if (!/^[0-9a-f-]{36}$/i.test(priceVersionId)) {
    throw new CatalogueCommandError("invalid", "That price version was not found.");
  }
  try {
    await db.query(`select sbg_catalogue_retire_price_version($1, $2::uuid)`, [
      actorUserId,
      priceVersionId,
    ]);
  } catch (err) {
    throw translateCatalogueError(err);
  }
}

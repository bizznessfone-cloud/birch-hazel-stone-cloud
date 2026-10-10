/**
 * Fixture cleanup for the A3-M36 isolated branch.
 *
 * Delete order is the migration dependency order, children before parents:
 * hotel_provider_agreements and app_hotel_accounts, then hotels, then
 * providers, then fixture approval versions, then acceptances, members,
 * organisations, and user.
 *
 * Agreements reference hotels and providers ON DELETE RESTRICT (0012).
 * Accounts reference both ON DELETE CASCADE (0018); they are still deleted
 * explicitly so a parent delete is not a cascade. Hotels reference
 * organisations ON DELETE RESTRICT (0027). Acceptances, members, and
 * organisations reference their parents ON DELETE RESTRICT (0032, 0027).
 * sbg_create_hotel_for_user inserts the hotel, provider, agreement, and
 * account. sbg_attach_hotel_to_organisation only sets hotels.organisation_id.
 *
 * Migration 0027 rejects DELETE on organisations, members, billing, and
 * licence allocations. Migration 0032 rejects DELETE on acceptances.
 * Those triggers stay enabled. One transaction covers the whole fixture
 * graph, and any refusal rolls the cleanup back so the rows stay for
 * inspection. terms-v1 is never deleted. Cascade and SET NULL are not
 * deletion strategies: an unplanned referencing row blocks the cleanup.
 */
export const MARKER = "a3m36";
export const NAME_PREFIX = "A3M36 ";
export const FIXTURE_EFFECTIVE = "a3m36-fixture-effective";
export const FIXTURE_SUPERSEDED = "a3m36-fixture-superseded";
export const FIXTURE_UNAPPROVED = "a3m36-fixture-unapproved";
export const FIXTURE_APP_DENIED = "a3m36-fixture-app-denied";
export const FIXTURE_VERSIONS = [FIXTURE_EFFECTIVE, FIXTURE_SUPERSEDED, FIXTURE_APP_DENIED];

export const CLEANUP_ORDER = [
  "hotel_provider_agreements",
  "app_hotel_accounts",
  "hotels",
  "providers",
  "sbg_approved_property_agreement_versions",
  "sbg_organisation_acceptances",
  "sbg_organisation_members",
  "sbg_organisations",
  "user",
];

export const REQUIRED_TRIGGERS = [
  "sbg_organisations_no_delete",
  "sbg_organisations_no_truncate",
  "sbg_organisation_members_no_delete",
  "sbg_organisation_members_no_truncate",
  "sbg_organisation_billing_no_delete",
  "sbg_organisation_billing_no_truncate",
  "sbg_property_licence_no_delete",
  "sbg_property_licence_no_truncate",
  "sbg_organisation_acceptances_immutable",
  "sbg_organisation_acceptances_no_truncate",
];

export const EXPECTED_EDGES = [
  { child: "hotel_provider_agreements", parent: "hotels", column: "hotel_id" },
  { child: "hotel_provider_agreements", parent: "providers", column: "provider_id" },
  { child: "app_hotel_accounts", parent: "hotels", column: "hotel_id" },
  { child: "app_hotel_accounts", parent: "user", column: "user_id" },
  { child: "hotels", parent: "sbg_organisations", column: "organisation_id" },
  { child: "sbg_organisation_members", parent: "sbg_organisations", column: "organisation_id" },
  { child: "sbg_organisation_members", parent: "user", column: "user_id" },
  { child: "sbg_organisation_acceptances", parent: "sbg_organisations", column: "organisation_id" },
  { child: "sbg_organisation_acceptances", parent: "user", column: "accepted_by_user_id" },
  { child: "sbg_organisations", parent: "user", column: "created_by_user_id" },
];

const CHILD_BEFORE_PARENT = EXPECTED_EDGES.map((edge) => [edge.child, edge.parent]);
const DELETE_ACTION = { a: "no action", r: "restrict", c: "cascade", n: "set null", d: "set default" };
const IDENT = /^[a-z_][a-z0-9_]*$/;

const FK_SQL = `-- a3m36-foreign-keys
select child_ns.nspname as child_schema,
       child.relname as child_table,
       parent.relname as parent_table,
       con.conname as constraint_name,
       con.confdeltype as delete_action,
       child_cols.cols as child_columns,
       parent_cols.cols as parent_columns
  from pg_constraint con
  join pg_class child on child.oid = con.conrelid
  join pg_class parent on parent.oid = con.confrelid
  join pg_namespace child_ns on child_ns.oid = child.relnamespace
  join pg_namespace parent_ns on parent_ns.oid = parent.relnamespace
  join lateral (
    select array_agg(att.attname order by u.ord) as cols
      from unnest(con.conkey) with ordinality as u(attnum, ord)
      join pg_attribute att on att.attrelid = con.conrelid and att.attnum = u.attnum
  ) child_cols on true
  join lateral (
    select array_agg(att.attname order by u.ord) as cols
      from unnest(con.confkey) with ordinality as u(attnum, ord)
      join pg_attribute att on att.attrelid = con.confrelid and att.attnum = u.attnum
  ) parent_cols on true
 where con.contype = 'f'
   and parent_ns.nspname = 'public'
   and child_ns.nspname not in ('pg_catalog', 'information_schema')
   and parent.relname = any($1::text[])`;

export function isMarkerUser(row) {
  const id = String(row?.id ?? "");
  const email = String(row?.email ?? "");
  const name = String(row?.name ?? "");
  return id.startsWith(`${MARKER}-`)
    && email.startsWith(`${MARKER}-proof-`)
    && email.endsWith("@invalid.scanbookgo.test")
    && name.startsWith(NAME_PREFIX);
}

export function cleanupFailure(step, err) {
  const message = String(err?.message ?? err ?? "unknown").split("\n")[0].slice(0, 240);
  const table = err?.table ? ` table ${err.table}` : "";
  const constraint = err?.constraint ? ` constraint ${err.constraint}` : "";
  const code = err?.code ? ` sqlstate ${err.code}` : "";
  return `BLOCKED — CLEANUP STOPPED AT ${step}${table}${constraint}${code}: ${message}`;
}

export function dependencyViolations(order = CLEANUP_ORDER) {
  const index = new Map(order.map((name, position) => [name, position]));
  return CHILD_BEFORE_PARENT.filter(([child, parent]) => {
    const left = index.get(child);
    const right = index.get(parent);
    return left == null || right == null || left >= right;
  }).map(([child, parent]) => `${child} before ${parent}`);
}

export function emptyGraph() {
  return {
    users: [],
    orgs: [],
    members: [],
    acceptances: [],
    hotels: [],
    providers: [],
    agreements: [],
    accounts: [],
    approvals: [],
  };
}

export function identifiedCounts(graph) {
  return {
    hotel_provider_agreements: graph?.agreements?.length ?? 0,
    app_hotel_accounts: graph?.accounts?.length ?? 0,
    hotels: graph?.hotels?.length ?? 0,
    providers: graph?.providers?.length ?? 0,
    sbg_approved_property_agreement_versions: graph?.approvals?.length ?? 0,
    sbg_organisation_acceptances: graph?.acceptances?.length ?? 0,
    sbg_organisation_members: graph?.members?.length ?? 0,
    sbg_organisations: graph?.orgs?.length ?? 0,
    user: graph?.users?.length ?? 0,
  };
}

export function graphFailures(graph) {
  const failures = [];
  const userIds = new Set((graph?.users ?? []).map((row) => row.id));
  const orgIds = new Set((graph?.orgs ?? []).map((row) => row.id));
  const hotelIds = new Set((graph?.hotels ?? []).map((row) => row.id));
  const providerIds = new Set((graph?.providers ?? []).map((row) => row.id));
  if ((graph?.users ?? []).some((row) => !isMarkerUser(row))) failures.push("BLOCKED — REFUSING TO DELETE A NON-MARKER USER");
  if ((graph?.orgs ?? []).some((row) => !String(row.name).startsWith(NAME_PREFIX) || !userIds.has(row.created_by_user_id))) {
    failures.push("BLOCKED — REFUSING TO DELETE A NON-MARKER ORGANISATION");
  }
  if ((graph?.hotels ?? []).some((row) => !String(row.name).startsWith(NAME_PREFIX) || !String(row.code).startsWith(`${MARKER}-`) || (row.organisation_id && !orgIds.has(row.organisation_id)))) {
    failures.push("BLOCKED — REFUSING TO DELETE A NON-MARKER HOTEL");
  }
  if ((graph?.providers ?? []).some((row) => !String(row.name).startsWith(NAME_PREFIX))) {
    failures.push("BLOCKED — REFUSING TO DELETE A NON-MARKER PROVIDER");
  }
  if ((graph?.members ?? []).some((row) => !orgIds.has(row.organisation_id) || !userIds.has(row.user_id))) {
    failures.push("BLOCKED — FIXTURE MEMBERSHIP CROSSES A NON-FIXTURE ROW");
  }
  if ((graph?.acceptances ?? []).some((row) => !orgIds.has(row.organisation_id) || !userIds.has(row.user_id))) {
    failures.push("BLOCKED — FIXTURE ACCEPTANCE CROSSES A NON-FIXTURE ROW");
  }
  if ((graph?.accounts ?? []).some((row) => !userIds.has(row.user_id) || !hotelIds.has(row.hotel_id))) {
    failures.push("BLOCKED — FIXTURE ACCOUNT CROSSES A NON-FIXTURE ROW");
  }
  if ((graph?.agreements ?? []).some((row) => !hotelIds.has(row.hotel_id) || !providerIds.has(row.provider_id))) {
    failures.push("BLOCKED — FIXTURE AGREEMENT CROSSES A NON-FIXTURE ROW");
  }
  if ((graph?.approvals ?? []).some((row) => row.agreement_version === "terms-v1" || !FIXTURE_VERSIONS.includes(row.agreement_version))) {
    failures.push("BLOCKED — REFUSING TO DELETE A NON-FIXTURE APPROVAL");
  }
  return [...new Set(failures)];
}

export function foreignKeyReview(catalog, graph) {
  const failures = [];
  const present = new Set();
  const residuals = [];
  const unexpected = [];
  for (const row of catalog ?? []) {
    const childColumns = [...(row.childColumns ?? [])];
    const parentColumns = [...(row.parentColumns ?? [])];
    const parentIds = idsFor(graph, row.parentTable);
    if (!parentIds.length) continue;
    if (childColumns.length !== 1 || parentColumns.length !== 1) {
      failures.push(`BLOCKED — COMPOSITE FOREIGN KEY ${row.constraint}`);
      continue;
    }
    const known = EXPECTED_EDGES.find((edge) => edge.child === row.childTable && edge.parent === row.parentTable && edge.column === childColumns[0]);
    if (known) {
      if (parentColumns[0] !== "id" || row.childSchema !== "public") failures.push(`BLOCKED — FOREIGN KEY COLUMN ${row.constraint}`);
      else {
        present.add(`${known.child}→${known.parent}`);
        residuals.push(row);
      }
    } else {
      unexpected.push(row);
    }
  }
  for (const key of requiredEdges(graph)) {
    if (!present.has(key)) failures.push(`BLOCKED — EXPECTED FOREIGN KEY ABSENT ${key}`);
  }
  return { failures: [...new Set(failures)], residuals, unexpected };
}

export function unexpectedReferenceVerdict(rows) {
  const first = rows?.[0];
  if (!first) return "";
  const action = DELETE_ACTION[first.deleteAction] ?? first.deleteAction ?? "unknown";
  return `BLOCKED — UNEXPECTED REFERENCE ${first.childTable}.${first.childColumns?.[0] ?? first.childColumn} -> ${first.parentTable} via ${first.constraint} action ${action} rows=${first.count}`;
}

function requiredEdges(graph) {
  const needed = [];
  if (graph.hotels.length) needed.push("hotel_provider_agreements→hotels", "app_hotel_accounts→hotels");
  if (graph.hotels.length && graph.orgs.length) needed.push("hotels→sbg_organisations");
  if (graph.providers.length) needed.push("hotel_provider_agreements→providers");
  if (graph.users.length) needed.push("app_hotel_accounts→user", "sbg_organisation_members→user", "sbg_organisation_acceptances→user", "sbg_organisations→user");
  if (graph.orgs.length) needed.push("sbg_organisation_members→sbg_organisations", "sbg_organisation_acceptances→sbg_organisations");
  return [...new Set(needed)];
}

function idsFor(graph, table) {
  if (table === "user") return graph.users.map((row) => row.id);
  if (table === "sbg_organisations") return graph.orgs.map((row) => row.id);
  if (table === "hotels") return graph.hotels.map((row) => row.id);
  if (table === "providers") return graph.providers.map((row) => row.id);
  if (table === "hotel_provider_agreements") return graph.agreements.map((row) => row.id);
  if (table === "sbg_organisation_members") return graph.members.map((row) => row.id);
  if (table === "sbg_organisation_acceptances") return graph.acceptances.map((row) => row.id);
  if (table === "sbg_approved_property_agreement_versions") return graph.approvals.map((row) => row.agreement_version);
  return [];
}

function zeroCounts() {
  return identifiedCounts(emptyGraph());
}

function blocked(verdict, graph, extras = {}) {
  return {
    ok: false,
    preserved: true,
    transaction: "not-started",
    verdict,
    identified: identifiedCounts(graph),
    removed: zeroCounts(),
    references: extras.references ?? [],
  };
}

function ident(name) {
  if (!IDENT.test(String(name ?? ""))) {
    const error = new Error(`unexpected catalog identifier ${name}`);
    error.table = String(name ?? "");
    throw error;
  }
  return `"${name}"`;
}

function castFor(table) {
  return table === "user" || table === "sbg_approved_property_agreement_versions" ? "text[]" : "uuid[]";
}

export async function triggerGuard(db) {
  const rows = (await db.query(
    `-- a3m36-trigger-guard
select t.tgname, t.tgenabled
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
 where not t.tgisinternal
   and n.nspname = 'public'
   and t.tgname = any($1::text[])`,
    [REQUIRED_TRIGGERS],
  )).rows;
  const missing = REQUIRED_TRIGGERS.filter((name) => !rows.some((row) => row.tgname === name && row.tgenabled === "O"));
  if (missing.length) return { ok: false, verdict: `BLOCKED — REQUIRED TRIGGER NOT ENABLED ${missing.join(",")}` };
  return { ok: true };
}

async function loadFixtureGraph(db, { userIds = [], discover = false, approvals = false }) {
  const graph = emptyGraph();
  const requested = [...userIds].map(String);
  const userSql = discover
    ? `-- a3m36-load-users
select id, name, email from public."user"
 where id like $1 or email like $2`
    : `-- a3m36-load-users
select id, name, email from public."user" where id = any($1::text[])`;
  const userParams = discover ? [`${MARKER}-%`, `${MARKER}-proof-%@invalid.scanbookgo.test`] : [requested];
  const users = requested.length || discover ? (await db.query(userSql, userParams)).rows : [];
  if (users.some((row) => !isMarkerUser(row))) return { graph, verdict: "BLOCKED — REFUSING TO DELETE A NON-MARKER USER" };
  graph.users = users.map((row) => ({ id: String(row.id), name: String(row.name), email: String(row.email) }));
  const ids = graph.users.map((row) => row.id);
  if (!ids.length && !discover && !approvals) return { graph, verdict: "" };

  const userParam = ids.length ? ids : [`${MARKER}-none`];
  const orgSql = discover
    ? `-- a3m36-load-orgs
select id::text as id, name, created_by_user_id
  from public.sbg_organisations
 where created_by_user_id = any($1::text[])
    or created_by_user_id like $2
    or name like $3`
    : `-- a3m36-load-orgs
select id::text as id, name, created_by_user_id
  from public.sbg_organisations
 where created_by_user_id = any($1::text[])`;
  const orgParams = discover ? [userParam, `${MARKER}-%`, `${NAME_PREFIX}%`] : [ids];
  if (ids.length || discover) {
    const orgs = (await db.query(orgSql, orgParams)).rows;
    const userSet = new Set(ids);
    if (orgs.some((row) => !String(row.name).startsWith(NAME_PREFIX) || !userSet.has(String(row.created_by_user_id)))) {
      return { graph, verdict: "BLOCKED — REFUSING TO DELETE A NON-MARKER ORGANISATION" };
    }
    graph.orgs = orgs.map((row) => ({ id: String(row.id), name: String(row.name), created_by_user_id: String(row.created_by_user_id) }));
  }
  const orgIds = graph.orgs.map((row) => row.id);

  const hotelSql = discover
    ? `-- a3m36-load-hotels
select h.id::text as id, h.name, h.code, h.organisation_id::text as organisation_id, a.user_id
  from public.hotels h
  left join public.app_hotel_accounts a on a.hotel_id = h.id
 where h.name like $3 or h.code like $4 or a.user_id = any($1::text[]) or h.organisation_id = any($2::uuid[])`
    : `-- a3m36-load-hotels
select h.id::text as id, h.name, h.code, h.organisation_id::text as organisation_id, a.user_id
  from public.hotels h
  left join public.app_hotel_accounts a on a.hotel_id = h.id
 where a.user_id = any($1::text[]) or h.organisation_id = any($2::uuid[])`;
  const hotelParams = discover
    ? [userParam, orgIds.length ? orgIds : ["00000000-0000-0000-0000-000000000000"], `${NAME_PREFIX}%`, `${MARKER}-%`]
    : [ids, orgIds.length ? orgIds : ["00000000-0000-0000-0000-000000000000"]];
  if (ids.length || orgIds.length || discover) {
    const hotels = classifyHotels((await db.query(hotelSql, hotelParams)).rows, new Set(ids), new Set(orgIds));
    if (hotels.verdict) return { graph, verdict: hotels.verdict };
    graph.hotels = hotels.hotels;
  }
  const hotelIds = new Set(graph.hotels.map((row) => row.id));

  if (graph.hotels.length || discover) {
    const providerSql = discover
      ? `-- a3m36-load-providers
select p.id::text as id, p.name,
       coalesce(array_agg(distinct a.hotel_id::text) filter (where a.hotel_id is not null), '{}') as hotel_ids
  from public.providers p
  left join public.hotel_provider_agreements a on a.provider_id = p.id
 where p.name like $1 or a.hotel_id = any($2::uuid[])
 group by p.id, p.name`
      : `-- a3m36-load-providers
select p.id::text as id, p.name,
       coalesce(array_agg(distinct a.hotel_id::text) filter (where a.hotel_id is not null), '{}') as hotel_ids
  from public.providers p
  join public.hotel_provider_agreements a on a.provider_id = p.id
 where a.hotel_id = any($1::uuid[])
 group by p.id, p.name`;
    const providerParams = discover
      ? [`${NAME_PREFIX}%`, graph.hotels.length ? graph.hotels.map((row) => row.id) : ["00000000-0000-0000-0000-000000000000"]]
      : [graph.hotels.length ? graph.hotels.map((row) => row.id) : ["00000000-0000-0000-0000-000000000000"]];
    if (discover || graph.hotels.length) {
      const providers = classifyProviders((await db.query(providerSql, providerParams)).rows, hotelIds);
      if (providers.verdict) return { graph, verdict: providers.verdict };
      graph.providers = providers.providers;
    }
  }
  const providerIds = new Set(graph.providers.map((row) => row.id));

  if (graph.hotels.length || graph.providers.length) {
    const agreements = classifyAgreements((await db.query(
      `-- a3m36-load-agreements
select id::text as id, hotel_id::text as hotel_id, provider_id::text as provider_id
  from public.hotel_provider_agreements
 where hotel_id = any($1::uuid[]) or provider_id = any($2::uuid[])`,
      [
        graph.hotels.length ? graph.hotels.map((row) => row.id) : ["00000000-0000-0000-0000-000000000000"],
        graph.providers.length ? graph.providers.map((row) => row.id) : ["00000000-0000-0000-0000-000000000000"],
      ],
    )).rows, hotelIds, providerIds);
    if (agreements.verdict) return { graph, verdict: agreements.verdict };
    graph.agreements = agreements.agreements;
  }

  if (ids.length || graph.hotels.length) {
    const accounts = classifyPairs((await db.query(
      `-- a3m36-load-accounts
select user_id, hotel_id::text as hotel_id
  from public.app_hotel_accounts
 where user_id = any($1::text[]) or hotel_id = any($2::uuid[])`,
      [userParam, graph.hotels.length ? graph.hotels.map((row) => row.id) : ["00000000-0000-0000-0000-000000000000"]],
    )).rows, new Set(ids), hotelIds, "user_id", "hotel_id", "BLOCKED — FIXTURE ACCOUNT CROSSES A NON-FIXTURE ROW");
    if (accounts.verdict) return { graph, verdict: accounts.verdict };
    graph.accounts = accounts.rows;
  }

  if (ids.length || orgIds.length) {
    const members = classifyPairs((await db.query(
      `-- a3m36-load-members
select id::text as id, organisation_id::text as organisation_id, user_id
  from public.sbg_organisation_members
 where user_id = any($1::text[]) or organisation_id = any($2::uuid[])`,
      [userParam, orgIds.length ? orgIds : ["00000000-0000-0000-0000-000000000000"]],
    )).rows, new Set(orgIds), new Set(ids), "organisation_id", "user_id", "BLOCKED — FIXTURE MEMBERSHIP CROSSES A NON-FIXTURE ROW");
    if (members.verdict) return { graph, verdict: members.verdict };
    graph.members = members.rows;
    const acceptances = classifyPairs((await db.query(
      `-- a3m36-load-acceptances
select id::text as id, organisation_id::text as organisation_id, accepted_by_user_id as user_id
  from public.sbg_organisation_acceptances
 where accepted_by_user_id = any($1::text[]) or organisation_id = any($2::uuid[])`,
      [userParam, orgIds.length ? orgIds : ["00000000-0000-0000-0000-000000000000"]],
    )).rows, new Set(orgIds), new Set(ids), "organisation_id", "user_id", "BLOCKED — FIXTURE ACCEPTANCE CROSSES A NON-FIXTURE ROW");
    if (acceptances.verdict) return { graph, verdict: acceptances.verdict };
    graph.acceptances = acceptances.rows;
  }

  if (approvals || discover) {
    const approvalRows = (await db.query(
      `-- a3m36-load-approvals
select agreement_version
  from public.sbg_approved_property_agreement_versions
 where agreement_version = any($1::text[])
   and agreement_version <> 'terms-v1'`,
      [FIXTURE_VERSIONS],
    )).rows;
    if (approvalRows.some((row) => !FIXTURE_VERSIONS.includes(String(row.agreement_version)))) {
      return { graph, verdict: "BLOCKED — REFUSING TO DELETE A NON-FIXTURE APPROVAL" };
    }
    graph.approvals = approvalRows.map((row) => ({ agreement_version: String(row.agreement_version) }));
  }
  return { graph, verdict: "" };
}

function classifyHotels(rows, userIds, orgIds) {
  const grouped = new Map();
  for (const row of rows) {
    const id = String(row.id);
    const current = grouped.get(id) ?? {
      id,
      name: String(row.name ?? ""),
      code: String(row.code ?? ""),
      organisation_id: row.organisation_id ? String(row.organisation_id) : null,
      users: new Set(),
    };
    if (row.user_id) current.users.add(String(row.user_id));
    grouped.set(id, current);
  }
  const hotels = [];
  for (const hotel of grouped.values()) {
    const users = [...hotel.users];
    const owned = users.length > 0 && users.every((id) => userIds.has(id));
    const orgOk = hotel.organisation_id == null || orgIds.has(hotel.organisation_id);
    if (!hotel.name.startsWith(NAME_PREFIX) || !hotel.code.startsWith(`${MARKER}-`) || !owned || !orgOk) {
      return { hotels: [], verdict: "BLOCKED — REFUSING TO DELETE A NON-MARKER HOTEL" };
    }
    hotels.push({ id: hotel.id, name: hotel.name, code: hotel.code, organisation_id: hotel.organisation_id });
  }
  return { hotels, verdict: "" };
}

function classifyProviders(rows, hotelIds) {
  const providers = [];
  for (const row of rows) {
    const links = [...(row.hotel_ids ?? [])].map(String).filter(Boolean);
    if (!String(row.name ?? "").startsWith(NAME_PREFIX) || links.some((id) => !hotelIds.has(id))) {
      return { providers: [], verdict: "BLOCKED — REFUSING TO DELETE A NON-MARKER PROVIDER" };
    }
    providers.push({ id: String(row.id), name: String(row.name) });
  }
  return { providers, verdict: "" };
}

function classifyAgreements(rows, hotelIds, providerIds) {
  const agreements = [];
  for (const row of rows) {
    const hotelId = String(row.hotel_id);
    const providerId = String(row.provider_id);
    if (!hotelIds.has(hotelId) || !providerIds.has(providerId)) {
      return { agreements: [], verdict: "BLOCKED — FIXTURE AGREEMENT CROSSES A NON-FIXTURE ROW" };
    }
    agreements.push({ id: String(row.id), hotel_id: hotelId, provider_id: providerId });
  }
  return { agreements, verdict: "" };
}

function classifyPairs(rows, leftIds, rightIds, leftKey, rightKey, verdict) {
  const out = [];
  for (const row of rows) {
    const left = String(row[leftKey]);
    const right = String(row[rightKey]);
    if (!leftIds.has(left) || !rightIds.has(right)) return { rows: [], verdict };
    const item = { ...row, [leftKey]: left, [rightKey]: right };
    if (row.id) item.id = String(row.id);
    out.push(item);
  }
  return { rows: out, verdict: "" };
}

function mapCatalog(rows) {
  return rows.map((row) => ({
    childSchema: String(row.child_schema ?? ""),
    childTable: String(row.child_table ?? ""),
    parentTable: String(row.parent_table ?? ""),
    constraint: String(row.constraint_name ?? ""),
    deleteAction: String(row.delete_action ?? ""),
    childColumns: [...(row.child_columns ?? [])].map(String),
    parentColumns: [...(row.parent_columns ?? [])].map(String),
  }));
}

async function findUnexpected(db, graph) {
  const parents = [...new Set(CLEANUP_ORDER)].filter((table) => idsFor(graph, table).length);
  if (!parents.length) return { failures: [], references: [] };
  const catalog = mapCatalog((await db.query(FK_SQL, [parents])).rows);
  const review = foreignKeyReview(catalog, graph);
  if (review.failures.length) return { failures: review.failures, references: [] };
  const references = [];
  for (const row of [...review.residuals, ...review.unexpected]) {
    const count = await residualCount(db, row, graph, review.unexpected.includes(row));
    if (count > 0) references.push({ ...row, count });
  }
  return { failures: references.length ? [unexpectedReferenceVerdict(references)] : [], references };
}

async function residualCount(db, row, graph, unexpected) {
  const parentIds = idsFor(graph, row.parentTable);
  const column = ident(row.childColumns[0]);
  const table = `${ident(row.childSchema)}.${ident(row.childTable)}`;
  const cast = castFor(row.parentTable);
  if (unexpected) {
    const sql = `-- a3m36-residual ${row.childTable} ${row.parentTable}
select count(*)::int as n from ${table} c where c.${column} = any($1::${cast})`;
    return Number((await db.query(sql, [parentIds])).rows[0].n);
  }
  const planned = plannedPredicate(row, graph);
  const sql = `-- a3m36-residual ${row.childTable} ${row.parentTable}
select count(*)::int as n from ${table} c
 where c.${column} = any($1::${cast})
   and not (${planned.sql})`;
  return Number((await db.query(sql, [parentIds, ...planned.params])).rows[0].n);
}

function plannedPredicate(row, graph) {
  if (row.childTable === "app_hotel_accounts") {
    return {
      sql: "c.user_id = any($2::text[]) and c.hotel_id = any($3::uuid[])",
      params: [graph.users.map((item) => item.id), graph.hotels.map((item) => item.id)],
    };
  }
  if (row.childTable === "hotel_provider_agreements") return { sql: "c.id = any($2::uuid[])", params: [graph.agreements.map((item) => item.id)] };
  if (row.childTable === "hotels") return { sql: "c.id = any($2::uuid[])", params: [graph.hotels.map((item) => item.id)] };
  if (row.childTable === "sbg_organisation_members") return { sql: "c.id = any($2::uuid[])", params: [graph.members.map((item) => item.id)] };
  if (row.childTable === "sbg_organisation_acceptances") return { sql: "c.id = any($2::uuid[])", params: [graph.acceptances.map((item) => item.id)] };
  if (row.childTable === "sbg_organisations") return { sql: "c.id = any($2::uuid[])", params: [graph.orgs.map((item) => item.id)] };
  return { sql: "false", params: [] };
}

function deleteStep(table, graph) {
  const nil = ["00000000-0000-0000-0000-000000000000"];
  if (table === "hotel_provider_agreements" && graph.agreements.length) {
    return {
      expect: graph.agreements.length,
      sql: `-- a3m36-delete hotel_provider_agreements
delete from public.hotel_provider_agreements
 where id = any($1::uuid[]) and hotel_id = any($2::uuid[]) and provider_id = any($3::uuid[])`,
      params: [graph.agreements.map((row) => row.id), graph.hotels.map((row) => row.id), graph.providers.map((row) => row.id)],
    };
  }
  if (table === "app_hotel_accounts" && graph.accounts.length) {
    return {
      expect: graph.accounts.length,
      sql: `-- a3m36-delete app_hotel_accounts
delete from public.app_hotel_accounts
 where user_id = any($1::text[]) and hotel_id = any($2::uuid[])`,
      params: [graph.users.map((row) => row.id), graph.hotels.map((row) => row.id)],
    };
  }
  if (table === "hotels" && graph.hotels.length) {
    return {
      expect: graph.hotels.length,
      sql: `-- a3m36-delete hotels
delete from public.hotels
 where id = any($1::uuid[])
   and name like $2
   and code like $3
   and (organisation_id is null or organisation_id = any($4::uuid[]))`,
      params: [graph.hotels.map((row) => row.id), `${NAME_PREFIX}%`, `${MARKER}-%`, graph.orgs.length ? graph.orgs.map((row) => row.id) : nil],
    };
  }
  if (table === "providers" && graph.providers.length) {
    return {
      expect: graph.providers.length,
      sql: `-- a3m36-delete providers
delete from public.providers p
 where p.id = any($1::uuid[])
   and p.name like $2
   and not exists (select 1 from public.hotel_provider_agreements a where a.provider_id = p.id)`,
      params: [graph.providers.map((row) => row.id), `${NAME_PREFIX}%`],
    };
  }
  if (table === "sbg_approved_property_agreement_versions" && graph.approvals.length) {
    return {
      expect: graph.approvals.length,
      sql: `-- a3m36-delete approvals
delete from public.sbg_approved_property_agreement_versions
 where agreement_version = any($1::text[]) and agreement_version <> 'terms-v1'`,
      params: [graph.approvals.map((row) => row.agreement_version)],
    };
  }
  if (table === "sbg_organisation_acceptances" && graph.acceptances.length) {
    return {
      expect: graph.acceptances.length,
      sql: `-- a3m36-delete acceptances
delete from public.sbg_organisation_acceptances
 where id = any($1::uuid[]) and organisation_id = any($2::uuid[]) and accepted_by_user_id = any($3::text[])`,
      params: [graph.acceptances.map((row) => row.id), graph.orgs.map((row) => row.id), graph.users.map((row) => row.id)],
    };
  }
  if (table === "sbg_organisation_members" && graph.members.length) {
    return {
      expect: graph.members.length,
      sql: `-- a3m36-delete members
delete from public.sbg_organisation_members
 where id = any($1::uuid[]) and organisation_id = any($2::uuid[]) and user_id = any($3::text[])`,
      params: [graph.members.map((row) => row.id), graph.orgs.map((row) => row.id), graph.users.map((row) => row.id)],
    };
  }
  if (table === "sbg_organisations" && graph.orgs.length) {
    return {
      expect: graph.orgs.length,
      sql: `-- a3m36-delete organisations
delete from public.sbg_organisations
 where id = any($1::uuid[]) and created_by_user_id = any($2::text[]) and name like $3`,
      params: [graph.orgs.map((row) => row.id), graph.users.map((row) => row.id), `${NAME_PREFIX}%`],
    };
  }
  if (table === "user" && graph.users.length) {
    return {
      expect: graph.users.length,
      sql: `-- a3m36-delete users
delete from public."user"
 where id = any($1::text[]) and id like $2 and name like $3 and email like $4`,
      params: [graph.users.map((row) => row.id), `${MARKER}-%`, `${NAME_PREFIX}%`, `${MARKER}-proof-%@invalid.scanbookgo.test`],
    };
  }
  return null;
}

async function lockParents(db, graph) {
  const locks = [
    [graph.users.length, `-- a3m36-lock users
select id from public."user" where id = any($1::text[]) for update`, [graph.users.map((row) => row.id)]],
    [graph.orgs.length, `-- a3m36-lock organisations
select id from public.sbg_organisations where id = any($1::uuid[]) for update`, [graph.orgs.map((row) => row.id)]],
    [graph.hotels.length, `-- a3m36-lock hotels
select id from public.hotels where id = any($1::uuid[]) for update`, [graph.hotels.map((row) => row.id)]],
    [graph.providers.length, `-- a3m36-lock providers
select id from public.providers where id = any($1::uuid[]) for update`, [graph.providers.map((row) => row.id)]],
    [graph.approvals.length, `-- a3m36-lock approvals
select agreement_version from public.sbg_approved_property_agreement_versions
 where agreement_version = any($1::text[]) for update`, [graph.approvals.map((row) => row.agreement_version)]],
  ];
  for (const [count, sql, params] of locks) {
    if (count) await db.query(sql, params);
  }
}

async function deleteGraph(db, graph) {
  const identified = identifiedCounts(graph);
  await db.query("begin");
  try {
    await lockParents(db, graph);
    const unexpected = await findUnexpected(db, graph);
    if (unexpected.failures.length) {
      const error = new Error(unexpected.failures[0]);
      error.references = unexpected.references;
      throw error;
    }
    for (const table of CLEANUP_ORDER) {
      const step = deleteStep(table, graph);
      if (!step) continue;
      const result = await db.query(step.sql, step.params);
      if (Number(result.rowCount) !== step.expect) {
        const error = new Error(`delete count ${Number(result.rowCount)} expected ${step.expect}`);
        error.table = table;
        throw error;
      }
    }
    await db.query("commit");
    return {
      ok: true,
      preserved: false,
      transaction: "committed",
      verdict: "",
      identified,
      removed: identified,
      references: [],
    };
  } catch (err) {
    try { await db.query("rollback"); } catch { /* keep the original refusal */ }
    const verdict = String(err?.message ?? "").startsWith("BLOCKED —")
      ? String(err.message)
      : cleanupFailure(err?.table || "cleanup", err);
    return {
      ok: false,
      preserved: true,
      transaction: "rolled-back",
      verdict,
      identified,
      removed: zeroCounts(),
      references: err?.references ?? [],
    };
  }
}

export async function cleanupFixtures(db, options = {}) {
  const graph = emptyGraph();
  try {
    const guards = await triggerGuard(db);
    if (!guards.ok) return blocked(guards.verdict, graph);
    const loaded = await loadFixtureGraph(db, options);
    if (loaded.verdict) return blocked(loaded.verdict, loaded.graph);
    const failures = graphFailures(loaded.graph);
    if (failures.length) return blocked(failures[0], loaded.graph);
    const counts = identifiedCounts(loaded.graph);
    if (!Object.values(counts).some((count) => count > 0)) {
      return { ok: true, preserved: true, transaction: "not-started", verdict: "", identified: counts, removed: zeroCounts(), references: [] };
    }
    const unexpected = await findUnexpected(db, loaded.graph);
    if (unexpected.failures.length) return blocked(unexpected.failures[0], loaded.graph, { references: unexpected.references });
    return await deleteGraph(db, loaded.graph);
  } catch (err) {
    try { await db.query("rollback"); } catch { /* no open cleanup transaction */ }
    return blocked(cleanupFailure("cleanup", err), graph);
  }
}

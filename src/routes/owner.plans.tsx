import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  activateOwnerPriceFn,
  createOwnerPriceFn,
  getOwnerPlansFn,
  retireOwnerPriceFn,
  updateOwnerPlanFn,
} from "@/lib/aether/owner-fns";
import type { OwnerCataloguePlan } from "@/lib/aether/owner-catalogue";

export const Route = createFileRoute("/owner/plans")({
  loader: () => getOwnerPlansFn(),
  component: OwnerPlansPage,
});

function mappingWord(status: "not_mapped" | "verified" | "replaced"): string {
  if (status === "verified") return "Verified";
  if (status === "replaced") return "Replaced";
  return "Not mapped";
}

function stateWord(state: "purchasable" | "draft" | "retired"): string {
  if (state === "purchasable") return "Current offer";
  if (state === "retired") return "Retired";
  return "Draft";
}

function formatWhen(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function OwnerPlansPage() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const [selected, setSelected] = useState(
    data.plans.find((item) => item.code === "property_licence")?.code ?? data.plans[0]?.code ?? "property_licence",
  );
  const plan = data.plans.find((item) => item.code === selected) ?? data.plans[0] ?? null;
  const [name, setName] = useState(plan?.name ?? "");
  const [description, setDescription] = useState(plan?.description ?? "");
  const [active, setActive] = useState(plan?.active ?? true);
  const [amount, setAmount] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | { kind: "activate" | "retire"; id: string }>(null);

  useEffect(() => {
    if (!plan) return;
    setName(plan.name);
    setDescription(plan.description);
    setActive(plan.active);
    setAmount("");
    setConfirm(null);
  }, [plan?.code, plan?.name, plan?.description, plan?.active]);

  async function reload() {
    await router.invalidate();
  }

  async function savePlan() {
    if (!plan) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await updateOwnerPlanFn({
        data: { code: plan.code, name, description, active },
      });
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      setMessage("Plan details saved.");
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function createPrice() {
    if (!plan) return;
    setBusy(true);
    setMessage(null);
    try {
      if (plan.code !== "property_licence") return;
      const result = await createOwnerPriceFn({ data: { code: plan.code, amount } });
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      setAmount("");
      setMessage("Draft price version created. It is not the current offer until you activate it.");
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function confirmVersion() {
    if (!confirm) return;
    setBusy(true);
    setMessage(null);
    try {
      const result =
        confirm.kind === "activate"
          ? await activateOwnerPriceFn({ data: { priceVersionId: confirm.id } })
          : await retireOwnerPriceFn({ data: { priceVersionId: confirm.id } });
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      setConfirm(null);
      setMessage(
        confirm.kind === "activate"
          ? "This version is now the catalogue offer. Stripe, Checkout, subscriptions, and hotel publication are unchanged."
          : "Future purchase of this version is retired. History is kept.",
      );
      await reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <header>
        <p className="text-xs font-medium tracking-[0.2em] text-muted uppercase">Catalogue</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Plans & Pricing</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
          The sellable SCAN BOOK GO product is the property licence. Historical plans remain visible and
          are not the current offer. Guest transfer prices stay on the hotel.
        </p>
        <p className="mt-3 text-sm font-medium">LIVE commerce locked until CP31</p>
      </header>

      <div className="grid gap-px bg-line md:grid-cols-3">
        {data.plans.map((item) => {
          const current = item.versions.find((version) => version.purchasable);
          const testLabel = current ? mappingWord(current.testMapping) : "Not mapped";
          const liveLabel = current
            ? current.liveLabel
            : data.liveLocked
              ? "Not mapped / Locked"
              : "Not mapped";
          return (
            <button
              key={item.code}
              type="button"
              onClick={() => setSelected(item.code)}
              className={`bg-surface p-6 text-left ${item.code === plan?.code ? "outline outline-1 outline-ink" : ""}`}
            >
              <p className="text-xs tracking-widest text-muted uppercase">{item.code}</p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight">{item.name}</h2>
              <p className="mt-2 text-sm text-muted">{item.description || "No description"}</p>
              <p className="mt-4 text-sm">{item.active ? "Active" : "Inactive"}</p>
              <p className="mt-4 text-sm text-muted">{item.currentPrice}</p>
              {item.versions.length === 0 ? (
                <p className="mt-1 text-sm text-muted">No price version has been created for this plan yet.</p>
              ) : (
                <p className="mt-1 text-sm text-muted">{current ? "Current offer" : "No current offer"}</p>
              )}
              <p className="mt-3 text-sm text-muted">Currency EUR · Interval month</p>
              <p className="text-sm text-muted">TEST {testLabel}</p>
              <p className="text-sm text-muted">LIVE {liveLabel}</p>
            </button>
          );
        })}
      </div>

      {plan ? (
        <PlanEditor
          plan={plan}
          name={name}
          description={description}
          active={active}
          amount={amount}
          busy={busy}
          confirm={confirm}
          onName={setName}
          onDescription={setDescription}
          onActive={setActive}
          onAmount={setAmount}
          onSave={() => void savePlan()}
          onCreate={() => void createPrice()}
          onAsk={setConfirm}
          onConfirm={() => void confirmVersion()}
        />
      ) : null}

      {message ? <p className="text-sm">{message}</p> : null}

      <section className="border border-line bg-surface p-5">
        <h2 className="text-xs font-medium tracking-[0.18em] text-muted uppercase">Catalogue activity</h2>
        {data.activity.length === 0 ? (
          <p className="mt-3 text-sm text-muted">No catalogue activity yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {data.activity.map((event, index) => (
              <li key={`${event.at}-${event.action}-${index}`} className="grid gap-1 py-3 sm:grid-cols-[10rem_1fr_8rem]">
                <p className="text-sm font-medium">{event.label}</p>
                <p className="text-sm text-muted">
                  {event.target} · {event.actor}
                </p>
                <p className="text-sm text-muted sm:text-right">{formatWhen(event.at)}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function PlanEditor({
  plan,
  name,
  description,
  active,
  amount,
  busy,
  confirm,
  onName,
  onDescription,
  onActive,
  onAmount,
  onSave,
  onCreate,
  onAsk,
  onConfirm,
}: {
  plan: OwnerCataloguePlan;
  name: string;
  description: string;
  active: boolean;
  amount: string;
  busy: boolean;
  confirm: null | { kind: "activate" | "retire"; id: string };
  onName: (value: string) => void;
  onDescription: (value: string) => void;
  onActive: (value: boolean) => void;
  onAmount: (value: string) => void;
  onSave: () => void;
  onCreate: () => void;
  onAsk: (value: null | { kind: "activate" | "retire"; id: string }) => void;
  onConfirm: () => void;
}) {
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,18rem)_1fr]">
      <section className="space-y-4 border border-line bg-surface p-5">
        <h2 className="text-xs font-medium tracking-[0.18em] text-muted uppercase">Plan details</h2>
        <label className="block text-sm">
          Name
          <input
            value={name}
            onChange={(event) => onName(event.target.value)}
            className="mt-1 w-full border border-line bg-canvas px-3 py-2"
          />
        </label>
        <p className="text-sm text-muted">Code {plan.code} is permanent.</p>
        <label className="block text-sm">
          Description
          <textarea
            value={description}
            onChange={(event) => onDescription(event.target.value)}
            rows={3}
            className="mt-1 w-full border border-line bg-canvas px-3 py-2"
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={active} onChange={(event) => onActive(event.target.checked)} />
          Active
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={onSave}
          className="min-h-11 bg-ink px-4 text-sm font-medium text-canvas disabled:opacity-50"
        >
          Save plan
        </button>

        <h2 className="pt-2 text-xs font-medium tracking-[0.18em] text-muted uppercase">New price version</h2>
        {plan.code === "property_licence" ? (
          <>
            <p className="text-sm text-muted">EUR, billed monthly. Creating a version does not activate it.</p>
            <label className="block text-sm">
              Amount
              <input
                inputMode="decimal"
                value={amount}
                onChange={(event) => onAmount(event.target.value)}
                placeholder="EUR"
                className="mt-1 w-full border border-line bg-canvas px-3 py-2"
              />
            </label>
            <button
              type="button"
              disabled={busy}
              onClick={onCreate}
              className="min-h-11 border border-ink px-4 text-sm font-medium disabled:opacity-50"
            >
              Create price version
            </button>
          </>
        ) : (
          <p className="text-sm text-muted">
            Historical plan. Not the current offer. New price versions are not available.
          </p>
        )}
      </section>

      <section className="border border-line bg-surface p-5">
        <h2 className="text-xs font-medium tracking-[0.18em] text-muted uppercase">Price history</h2>
        <p className="mt-2 text-sm text-muted">
          Current price: {plan.currentPrice}. Activation chooses the SCAN BOOK GO offer. It does not
          create a Stripe Price, enable Checkout, change a subscription, publish a hotel, or turn on LIVE commerce.
        </p>
        {plan.versions.length === 0 ? (
          <p className="mt-6 text-sm">
            Price not configured. No price version has been created for this plan yet.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-line">
            {plan.versions.map((version) => (
              <li key={version.id} className="py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-lg font-semibold tabular-nums">
                    {version.amountLabel}
                    <span className="ml-2 text-sm font-normal text-muted">EUR / month</span>
                  </p>
                  <p className="text-xs tracking-widest text-muted uppercase">{stateWord(version.state)}</p>
                </div>
                <dl className="mt-2 grid gap-1 text-sm text-muted sm:grid-cols-2">
                  <div>Created {formatWhen(version.createdAt)}</div>
                  <div>Effective {formatWhen(version.effectiveFrom)}</div>
                  <div>TEST {mappingWord(version.testMapping)}</div>
                  <div>LIVE {version.liveLabel}</div>
                </dl>
                <div className="mt-3 flex flex-wrap gap-2">
                  {version.state === "draft" ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onAsk({ kind: "activate", id: version.id })}
                      className="min-h-11 border border-ink px-3 text-sm"
                    >
                      Activate
                    </button>
                  ) : null}
                  {version.state !== "retired" ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onAsk({ kind: "retire", id: version.id })}
                      className="min-h-11 border border-line px-3 text-sm"
                    >
                      Retire
                    </button>
                  ) : null}
                </div>
                {confirm?.id === version.id ? (
                  <div className="mt-3 border border-line p-3">
                    <p className="text-sm">
                      {confirm.kind === "activate"
                        ? "Make this the only purchasable version of this plan?"
                        : "Retire this version for future purchase? History stays."}
                    </p>
                    <div className="mt-3 flex gap-2">
                      <button type="button" disabled={busy} onClick={onConfirm} className="min-h-11 bg-ink px-3 text-sm text-canvas">
                        Confirm
                      </button>
                      <button type="button" disabled={busy} onClick={() => onAsk(null)} className="min-h-11 px-3 text-sm">
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

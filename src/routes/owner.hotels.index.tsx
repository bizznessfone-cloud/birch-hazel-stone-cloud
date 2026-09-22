import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { z } from "zod";
import { getOwnerHotelsFn } from "@/lib/aether/owner-fns";
import { fieldClass } from "@/components/aether/ui";

const searchSchema = z.object({
  q: z.string().optional().catch(""),
  status: z.string().optional().catch(""),
});

export const Route = createFileRoute("/owner/hotels/")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({ q: search.q ?? "", status: search.status ?? "" }),
  loader: ({ deps }) => getOwnerHotelsFn({ data: deps }),
  component: OwnerHotelsPage,
});

function OwnerHotelsPage() {
  const hotels = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/owner/hotels/" });
  const [q, setQ] = useState(search.q ?? "");

  function onSearch(event: FormEvent) {
    event.preventDefault();
    void navigate({
      search: { q: q.trim() || undefined, status: search.status || undefined },
    });
  }

  function setStatus(status: string) {
    void navigate({
      search: { q: search.q || undefined, status: status || undefined },
    });
  }

  return (
    <div className="space-y-8">
      <header>
        <p className="text-xs font-medium tracking-[0.2em] text-muted uppercase">Registry</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Hotels</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
          Operator-owned hotels only. Seeded demo properties without an owner are not SaaS customers.
        </p>
      </header>

      <form className="flex flex-col gap-3 sm:flex-row" onSubmit={onSearch}>
        <input
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder="Search name, code, slug, email"
          className={`${fieldClass} sm:max-w-md`}
          aria-label="Search hotels"
        />
        <button
          type="submit"
          className="inline-flex min-h-12 items-center justify-center bg-ink px-5 text-sm font-semibold tracking-wide text-canvas uppercase"
        >
          Search
        </button>
      </form>

      <div className="flex flex-wrap gap-1">
        {[
          { value: "", label: "All" },
          { value: "unconfigured", label: "Unconfigured" },
          { value: "configured", label: "Configured" },
          { value: "live", label: "Live" },
        ].map((item) => {
          const active = (search.status ?? "") === item.value;
          return (
            <button
              key={item.value || "all"}
              type="button"
              onClick={() => setStatus(item.value)}
              className={`min-h-11 px-3 text-sm ${active ? "bg-ink text-canvas" : "border border-line text-ink"}`}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      {hotels.length === 0 ? (
        <p className="text-sm text-muted">No matching SaaS hotels.</p>
      ) : (
        <div className="overflow-x-auto border border-line bg-surface">
          <table className="w-full min-w-[64rem] text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs tracking-widest text-muted uppercase">
                <th className="px-4 py-3 font-medium">Hotel</th>
                <th className="px-4 py-3 font-medium">Code</th>
                <th className="px-4 py-3 font-medium">Slug</th>
                <th className="px-4 py-3 font-medium">Operator</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Subscription</th>
                <th className="px-4 py-3 font-medium">Signed up</th>
              </tr>
            </thead>
            <tbody>
              {hotels.map((hotel) => (
                <tr key={hotel.id} className="border-b border-line last:border-b-0">
                  <td className="px-4 py-3">
                    <Link
                      to="/owner/hotels/$hotelId"
                      params={{ hotelId: hotel.id }}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {hotel.name}
                    </Link>
                    <p className="text-xs text-muted">{hotel.locality}</p>
                  </td>
                  <td className="px-4 py-3 tabular-nums">{hotel.code}</td>
                  <td className="px-4 py-3">{hotel.publicSlug || "—"}</td>
                  <td className="px-4 py-3">
                    {hotel.operatorEmail}
                    {hotel.ownerCount > 1 ? (
                      <span className="text-muted"> · {hotel.ownerCount}</span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">{hotel.status}</td>
                  <td className="px-4 py-3">
                    {hotel.billingStatus ?? "none"}
                    {hotel.stripePriceId ? (
                      <p className="text-xs text-muted">{hotel.stripePriceId}</p>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-muted tabular-nums">{hotel.ownedAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

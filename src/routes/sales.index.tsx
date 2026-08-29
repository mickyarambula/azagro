import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { StatusPill } from "@/components/erp";
import { routeLabel, stateLabel, termLabel } from "@/components/order-form";
import { useAccess } from "@/lib/access";
import { listOrders } from "@/lib/erp/orders";
import { exportCsv } from "@/lib/export-csv";
import { fmtDate, moneyIn } from "@/lib/utils";

type Tab = "todos" | "draft" | "confirmed" | "done";

export const Route = createFileRoute("/sales/")({
  validateSearch: (s: Record<string, unknown>): { tab: Tab; q: string } => ({
    tab: s.tab === "draft" || s.tab === "confirmed" || s.tab === "done" ? s.tab : "todos",
    q: typeof s.q === "string" ? s.q : "",
  }),
  component: List,
});

function List() {
  const { tab, q } = Route.useSearch();
  const navigate = useNavigate({ from: "/sales/" });
  const { can } = useAccess();
  const canEdit = can("sales", "edit");
  const [rows, setRows] = useState<Awaited<ReturnType<typeof listOrders>>>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listOrders()
      .then(setRows)
      .catch((e) => setError(e instanceof Error ? e.message : "Error"));
  }, []);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (tab !== "todos" && r.state !== tab) return false;
      if (!term) return true;
      return [r.name, r.partner, r.group_name, r.oc_cliente, r.currency].join(" ").toLowerCase().includes(term);
    });
  }, [rows, tab, q]);

  const nDraft = rows.filter((r) => r.state === "draft").length;
  const nConf = rows.filter((r) => r.state === "confirmed").length;
  const nDone = rows.filter((r) => r.state === "done").length;

  return (
    <div className="p-5">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <p className="text-sm text-muted">El plazo, la moneda y el circuito se pactan en cada pedido.</p>
        {canEdit && (
          <Link to="/sales/nuevo" className="erp-btn-primary grid place-items-center">
            Nuevo pedido
          </Link>
        )}
      </div>

      <div className="mb-4 grid gap-2 sm:grid-cols-4">
        <Stat label="Todos" value={String(rows.length)} />
        <Stat label="Borradores" value={String(nDraft)} />
        <Stat label="Por entregar" value={String(nConf)} />
        <Stat label="Entregados" value={String(nDone)} />
      </div>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border-b border-line">
        <div className="flex">
          {(
            [
              ["todos", `Todos (${rows.length})`],
              ["draft", `Borrador (${nDraft})`],
              ["confirmed", `Confirmado (${nConf})`],
              ["done", `Entregado (${nDone})`],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" className="erp-tab" data-on={tab === id} onClick={() => navigate({ search: { tab: id, q } })}>
              {label}
            </button>
          ))}
        </div>
        <label className="relative mb-1 block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <input
            className="erp-input w-56 pl-8 md:w-72"
            placeholder="Buscar folio, cliente, OC…"
            value={q}
            onChange={(e) => navigate({ search: { tab, q: e.target.value } })}
          />
        </label>
      </div>

      {error && <p className="mb-3 text-sm text-danger">{error}</p>}

      {filtered.length === 0 ? (
        <div className="erp-card px-6 py-16 text-center">
          <p className="font-medium">No hay pedidos</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted">
            Crea pedidos y notifica al cliente. El plazo de esta operación se pacta aquí.
          </p>
          {canEdit && (
            <Link to="/sales/nuevo" className="erp-btn-primary mt-4 inline-grid place-items-center">
              Nuevo pedido
            </Link>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto erp-card">
          <table className="w-full min-w-[860px] text-left text-[13px]">
            <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-3 font-medium">Folio</th>
                <th className="px-3 py-3 font-medium">Fecha</th>
                <th className="px-3 py-3 font-medium">Cliente</th>
                <th className="px-3 py-3 font-medium">Plazo</th>
                <th className="px-3 py-3 font-medium">Circuito</th>
                <th className="px-3 py-3 font-medium">Estado</th>
                <th className="px-4 py-3 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr
                  key={r.id}
                  className="erp-row cursor-pointer border-t border-line"
                  onClick={() => navigate({ to: "/sales/$orderId", params: { orderId: String(r.id) } })}
                >
                  <td className="px-4 py-3 font-medium">{r.name}</td>
                  <td className="px-3 py-3 text-muted">{fmtDate(r.date)}</td>
                  <td className="px-3 py-3">
                    <div>{r.partner}</div>
                    {r.oc_cliente ? <div className="text-xs text-muted">OC {r.oc_cliente}</div> : null}
                  </td>
                  <td className="px-3 py-3">
                    {termLabel(r.term_kind, r.invoice_days, r.credit_days)}
                    <div className="text-xs text-muted">{r.currency}</div>
                  </td>
                  <td className="px-3 py-3">{routeLabel(r.route_kind)}</td>
                  <td className="px-3 py-3">
                    <StatusPill tone={r.state === "done" ? "ok" : r.state === "confirmed" ? "warn" : "muted"}>
                      {stateLabel(r.state)}
                    </StatusPill>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{moneyIn(r.total, r.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="erp-card px-3 py-2.5">
      <p className="text-[11px] uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Field, FinanceNav, StatusPill } from "@/components/erp";
import { getCompanyPnl, listDealPnl } from "@/lib/erp/reports";
import { exportCsv } from "@/lib/export-csv";
import { money, todayISO } from "@/lib/utils";

export const Route = createFileRoute("/reportes")({ component: Page });

function monthStart() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function Page() {
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(todayISO);
  const [pnl, setPnl] = useState<Awaited<ReturnType<typeof getCompanyPnl>> | null>(null);
  const [deals, setDeals] = useState<Awaited<ReturnType<typeof listDealPnl>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const [c, d] = await Promise.all([getCompanyPnl({ data: { from, to } }), listDealPnl({ data: { from, to } })]);
      setPnl(c);
      setDeals(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    }
  }
  useEffect(() => {
    void load();
  }, [from, to]);

  return (
    <AppShell>
      <FinanceNav current="reportes" />
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Utilidad</h1>
          <p className="text-sm text-muted">
            P&L del periodo y margen por pedido. Costo de mercancía toma el precio de la OC ligada; si no hay OC, el costo del catálogo.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Desde">
            <input className="erp-input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="Hasta">
            <input className="erp-input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
      </div>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}

      {pnl && (
        <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Kpi label="Ventas facturadas" value={money(pnl.revenue)} hint={`${pnl.salesN} facturas producto`} />
          <Kpi label="Compras (CxP del periodo)" value={money(pnl.purchases)} />
          <Kpi label="Flete / sobre pedido" value={money(pnl.freight)} />
          <Kpi label="Utilidad bruta" value={money(pnl.gross)} />
          <Kpi label="Gastos operativos" value={money(pnl.operativo)} />
          <Kpi label="Gastos financieros" value={money(pnl.financiero)} />
          <Kpi label="Mora facturada" value={money(pnl.mora)} />
          <Kpi label="Resultado" value={money(pnl.net)} />
        </div>
      )}
      {pnl && (
        <p className="mb-5 text-[13px] text-muted">
          Cobrado {money(pnl.collected)} · Pagado a proveedores {money(pnl.paidOut)}. La mora no está en el precio; entra como ingreso de intereses.
        </p>
      )}

      <div className="mb-3 flex justify-end">
        <button
          type="button"
          className="erp-btn"
          onClick={() =>
            exportCsv(
              "utilidad-azagro",
              ["Pedido", "Fecha", "Cliente", "Estado", "Venta", "Costo", "Flete", "Línea", "Margen", "%"],
              (deals?.deals ?? []).map((d) => [d.name, d.date, d.partner, d.state, d.revenue, d.cogs, d.freight, d.finance, d.margin, d.marginPct]),
            )
          }
        >
          Exportar Excel
        </button>
      </div>
      <div className="overflow-x-auto erp-card">
        <table className="w-full min-w-[820px] text-left text-[13px]">
          <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3 font-medium">Pedido</th>
              <th className="px-3 py-3 font-medium">Cliente</th>
              <th className="px-3 py-3 font-medium">Fecha</th>
              <th className="px-3 py-3 font-medium">Estado</th>
              <th className="px-3 py-3 text-right font-medium">Venta</th>
              <th className="px-3 py-3 text-right font-medium">Costo</th>
              <th className="px-3 py-3 text-right font-medium">Flete</th>
              <th className="px-3 py-3 text-right font-medium">Línea (info)</th>
              <th className="px-4 py-3 text-right font-medium">Margen</th>
            </tr>
          </thead>
          <tbody>
            {(deals?.deals ?? []).map((d) => (
              <tr key={d.id} className="border-t border-line">
                <td className="px-4 py-3 font-medium">
                  <Link to="/sales/$orderId" params={{ orderId: String(d.id) }} className="hover:underline">
                    {d.name}
                  </Link>
                </td>
                <td className="px-3 py-3">{d.partner}</td>
                <td className="px-3 py-3 tabular-nums">{d.date}</td>
                <td className="px-3 py-3">
                  <StatusPill tone={d.state === "done" ? "ok" : d.state === "confirmed" ? "warn" : "muted"}>{d.state}</StatusPill>
                </td>
                <td className="px-3 py-3 text-right tabular-nums">{money(d.revenue)}</td>
                <td className="px-3 py-3 text-right tabular-nums">{money(d.cogs)}</td>
                <td className="px-3 py-3 text-right tabular-nums">{money(d.freight)}</td>
                <td className="px-3 py-3 text-right tabular-nums text-muted">{money(d.finance)}</td>
                <td className="px-4 py-3 text-right tabular-nums font-medium">
                  {money(d.margin)}
                  <span className="ml-1 text-[11px] text-muted">{d.marginPct.toFixed(1)}%</span>
                </td>
              </tr>
            ))}
            {deals && deals.deals.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-12 text-center text-sm text-muted">
                  Sin pedidos en el periodo.
                </td>
              </tr>
            )}
          </tbody>
          {deals && deals.deals.length > 0 && (
            <tfoot>
              <tr className="border-t border-line font-semibold">
                <td className="px-4 py-3" colSpan={4}>
                  Total
                </td>
                <td className="px-3 py-3 text-right tabular-nums">{money(deals.totals.revenue)}</td>
                <td className="px-3 py-3 text-right tabular-nums">{money(deals.totals.cogs)}</td>
                <td className="px-3 py-3 text-right tabular-nums">{money(deals.totals.freight)}</td>
                <td className="px-3 py-3 text-right tabular-nums">{money(deals.totals.finance)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{money(deals.totals.margin)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </AppShell>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <article className="erp-card p-4">
      <p className="text-[11px] uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
      {hint ? <p className="mt-1 text-[12px] text-muted">{hint}</p> : null}
    </article>
  );
}

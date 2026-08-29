import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { FinanceNav, StatusPill } from "@/components/erp";
import { listInvoices } from "@/lib/azagro";
import { exactClock } from "@/lib/erp/credit";
import { money, num } from "@/lib/utils";

export const Route = createFileRoute("/cadena")({ component: Page });

function Page() {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof listInvoices>>>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listInvoices({ data: { kind: "all" } })
      .then(setRows)
      .catch((e) => setError(e instanceof Error ? e.message : "Error"));
  }, []);

  const ar = rows.filter((r) => r.kind === "customer" && r.state !== "paid");
  const ap = rows.filter((r) => r.kind === "supplier" && r.state !== "paid");
  const arDue = ar.filter((r) => r.days_overdue > 0).reduce((s, r) => s + num(r.residual), 0);
  const arOpen = ar.reduce((s, r) => s + num(r.residual), 0);
  const apDue = ap.filter((r) => r.days_overdue > 0).reduce((s, r) => s + num(r.residual), 0);
  const apSoon = ap.filter((r) => r.days_overdue <= 0).reduce((s, r) => s + num(r.residual), 0);
  const gap = apDue + apSoon - (arOpen - arDue);

  const byPartner = useMemo(() => {
    const map = new Map<string, { ar: number; ap: number; arOver: number; apOver: number }>();
    for (const r of rows) {
      if (r.state === "paid") continue;
      const cur = map.get(r.partner) ?? { ar: 0, ap: 0, arOver: 0, apOver: 0 };
      const amt = num(r.residual);
      if (r.kind === "customer") {
        cur.ar += amt;
        if (r.days_overdue > 0) cur.arOver += amt;
      } else {
        cur.ap += amt;
        if (r.days_overdue > 0) cur.apOver += amt;
      }
      map.set(r.partner, cur);
    }
    return [...map.entries()].sort((a, b) => b[1].ar + b[1].ap - (a[1].ar + a[1].ap));
  }, [rows]);

  return (
    <AppShell>
      <FinanceNav current="cadena" />
      <div className="mb-4">
        <h1 className="text-xl font-semibold">Cadena de crédito</h1>
        <p className="text-sm text-muted">
          Nos dan crédito y nosotros lo damos. Relojes en <strong>días calendario exactos</strong>. Si el cliente no paga, la línea del proveedor igual vence.
        </p>
      </div>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}

      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Nos deben (vencido)" value={money(arDue)} warn={arDue > 0} />
        <Kpi label="Nos deben (vigente)" value={money(arOpen - arDue)} />
        <Kpi label="Debemos (vencido)" value={money(apDue)} warn={apDue > 0} />
        <Kpi label="Debemos (por vencer)" value={money(apSoon)} />
      </div>
      <p className="mb-5 text-[13px] text-muted">
        Presión de caja si cobramos tarde y pagamos a tiempo:{" "}
        <strong className={gap > 0 ? "text-warn" : "text-ok"}>{money(Math.max(gap, 0))}</strong> a cubrir con banco u otro cobro.
      </p>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Col title="Clientes — nos deben" rows={ar} kind="customer" />
        <Col title="Proveedores — debemos" rows={ap} kind="supplier" />
      </div>

      <h2 className="mb-2 text-sm font-semibold">Por contraparte</h2>
      <div className="overflow-x-auto erp-card">
        <table className="w-full min-w-[640px] text-left text-[13px]">
          <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3 font-medium">Partner</th>
              <th className="px-3 py-3 text-right font-medium">Nos deben</th>
              <th className="px-3 py-3 text-right font-medium">Vencido cobro</th>
              <th className="px-3 py-3 text-right font-medium">Debemos</th>
              <th className="px-3 py-3 text-right font-medium">Vencido pago</th>
            </tr>
          </thead>
          <tbody>
            {byPartner.map(([name, v]) => (
              <tr key={name} className="border-t border-line">
                <td className="px-4 py-3 font-medium">{name}</td>
                <td className="px-3 py-3 text-right tabular-nums">{money(v.ar)}</td>
                <td className={`px-3 py-3 text-right tabular-nums ${v.arOver ? "text-warn" : "text-muted"}`}>{money(v.arOver)}</td>
                <td className="px-3 py-3 text-right tabular-nums">{money(v.ap)}</td>
                <td className={`px-3 py-3 text-right tabular-nums ${v.apOver ? "text-danger" : "text-muted"}`}>{money(v.apOver)}</td>
              </tr>
            ))}
            {byPartner.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-sm text-muted">
                  Sin saldos abiertos. Aparecen al facturar ventas y recibir compras a crédito.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </AppShell>
  );
}

function Kpi({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <article className="erp-card p-4">
      <p className="text-[11px] uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-1 text-lg font-semibold tabular-nums ${warn ? "text-warn" : ""}`}>{value}</p>
    </article>
  );
}

function Col({
  title,
  rows,
  kind,
}: {
  title: string;
  rows: Awaited<ReturnType<typeof listInvoices>>;
  kind: "customer" | "supplier";
}) {
  return (
    <div className="erp-card overflow-hidden">
      <p className="border-b border-line px-4 py-3 text-sm font-semibold">{title}</p>
      <ul>
        {rows.slice(0, 12).map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-2 border-t border-line px-4 py-2.5 text-[13px]">
            <div>
              <Link
                to="/partners/$partnerId"
                params={{ partnerId: String(r.partner_id) }}
                search={{ tab: kind === "supplier" ? "proveedores" : "clientes", q: "" }}
                className="font-medium hover:underline"
              >
                {r.partner}
              </Link>
              <p className="text-[11px] text-muted">
                {r.name} · vence {r.due_date} · {r.state === "paid" ? "pagada" : exactClock(r.due_date).label}
              </p>
            </div>
            <div className="text-right">
              <p className="tabular-nums">{money(r.residual)}</p>
              <StatusPill tone={r.days_overdue > 0 ? "danger" : exactClock(r.due_date).status === "today" ? "warn" : "ok"}>
                {exactClock(r.due_date).label}
              </StatusPill>
            </div>
          </li>
        ))}
        {rows.length === 0 && <li className="px-4 py-8 text-center text-sm text-muted">Nada abierto</li>}
      </ul>
    </div>
  );
}

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { FinanceNav, StatusPill } from "@/components/erp";
import { listInvoices } from "@/lib/azagro";
import { getAlertDigest, sendDueAlerts, sendPartnerReminders } from "@/lib/erp/alerts";
import { getSettings } from "@/lib/erp/ops";
import { getUpcomingDue } from "@/lib/erp/reports";
import { exactClock, validateDueDates } from "@/lib/erp/credit";
import { dateDMY, money, moneyIn, num, todayMx } from "@/lib/utils";

export const Route = createFileRoute("/vencimientos")({ component: Page });

const BUCKETS = [
  { id: "overdue", label: "Vencido" },
  { id: "today", label: "Hoy" },
  { id: "7", label: "1–7 días" },
  { id: "15", label: "8–15 días" },
  { id: "30", label: "16–30 días" },
  { id: "later", label: "Más de 30" },
] as const;

function bucketOf(due: string, asOf: string) {
  const c = exactClock(due, asOf);
  if (c.status === "overdue") return "overdue";
  if (c.days === 0) return "today";
  if (c.days <= 7) return "7";
  if (c.days <= 15) return "15";
  if (c.days <= 30) return "30";
  return "later";
}

function Page() {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof listInvoices>>>([]);
  const [alerts, setAlerts] = useState({ cxc: 7, cxp: 7 });
  const [lado, setLado] = useState<"all" | "customer" | "supplier">("all");
  const [porMes, setPorMes] = useState<Awaited<ReturnType<typeof getUpcomingDue>> | null>(null);
  const asOf = todayMx();

  useEffect(() => {
    void listInvoices({ data: { kind: "all" } }).then(setRows);
    void getSettings()
      .then((s) => setAlerts({ cxc: s.alertDaysCxc ?? 7, cxp: s.alertDaysCxp ?? 7 }))
      .catch(() => undefined);
    void getUpcomingDue().then(setPorMes).catch(() => undefined);
  }, []);

  const open = useMemo(
    () =>
      rows
        .filter((r) => r.state !== "paid")
        .filter((r) => (lado === "all" ? true : r.kind === lado))
        .map((r) => {
          const clock = exactClock(r.due_date, asOf);
          const warnDays = r.kind === "supplier" ? alerts.cxp : alerts.cxc;
          const alert = clock.status === "overdue" || clock.status === "today" || clock.days <= warnDays;
          return { ...r, clock, bucket: bucketOf(r.due_date, asOf), alert, warnDays };
        })
        .sort((a, b) => a.due_date.localeCompare(b.due_date)),
    [rows, lado, alerts, asOf],
  );

  return (
    <AppShell>
      <FinanceNav current="vencimientos" />
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Tabla de vencimientos</h1>
          <p className="mt-0.5 text-sm text-muted">
            Días exactos de calendario. Alerta CxC a {alerts.cxc} d y CxP a {alerts.cxp} d (Ajustes → Empresa).
          </p>
        </div>
        <div className="flex gap-2">
          <select className="erp-input" value={lado} onChange={(e) => setLado(e.target.value as typeof lado)}>
            <option value="all">Cobrar y pagar</option>
            <option value="customer">Solo por cobrar</option>
            <option value="supplier">Solo por pagar</option>
          </select>
          <button
            type="button"
            className="erp-btn"
            onClick={async () => {
              const d = await sendDueAlerts();
              if (d.sent === "mailto" && d.mailto) window.location.href = d.mailto;
              else window.alert(d.notice);
            }}
          >
            Aviso interno
          </button>
          <button
            type="button"
            className="erp-btn-primary"
            onClick={async () => {
              const d = await sendPartnerReminders();
              window.alert(d.notice);
            }}
          >
            Recordatorios a clientes
          </button>
        </div>
      </div>

      <div className="mb-4 grid gap-2 sm:grid-cols-3 xl:grid-cols-6">
        {BUCKETS.map((b) => {
          const n = open.filter((r) => r.bucket === b.id);
          const amt = n.reduce((s, r) => s + num(r.residual), 0);
          return (
            <article key={b.id} className="erp-card p-3">
              <p className="text-[11px] uppercase tracking-wide text-muted">{b.label}</p>
              <p className="mt-1 text-lg font-semibold tabular-nums">{n.length}</p>
              <p className="text-[12px] text-muted">{money(amt)}</p>
            </article>
          );
        })}
      </div>

      <div className="overflow-x-auto erp-card">
        <table className="w-full min-w-[860px] text-left text-[13px]">
          <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3 font-medium">Vence</th>
              <th className="px-3 py-3 font-medium">Reloj</th>
              <th className="px-3 py-3 font-medium">Lado</th>
              <th className="px-3 py-3 font-medium">Socio</th>
              <th className="px-3 py-3 font-medium">Folio</th>
              <th className="px-4 py-3 text-right font-medium">Saldo</th>
            </tr>
          </thead>
          <tbody>
            {open.map((r) => (
              <tr key={r.id} className="border-t border-line">
                <td className="px-4 py-3 tabular-nums">
                  {dateDMY(r.due_date)}
                  {validateDueDates({ issue: r.date, due: r.due_date, days: r.credit_days || undefined, allowPast: true }).errors[0] ? (
                    <p className="text-[11px] text-danger">Emisión posterior al vencimiento</p>
                  ) : null}
                </td>
                <td className="px-3 py-3">
                  <StatusPill tone={r.clock.status === "overdue" ? "danger" : r.alert ? "warn" : "muted"}>
                    {r.clock.label}
                  </StatusPill>
                </td>
                <td className="px-3 py-3">{r.kind === "supplier" ? "Por pagar" : "Por cobrar"}</td>
                <td className="px-3 py-3">{r.partner}</td>
                <td className="px-3 py-3">
                  <Link
                    to="/credit"
                    search={{ lado: r.kind === "supplier" ? "pagar" : "cobrar" }}
                    className="font-medium hover:underline"
                  >
                    {r.name}
                  </Link>
                </td>
                <td className="px-4 py-3 text-right tabular-nums">{moneyIn(r.residual, r.currency)}</td>
              </tr>
            ))}
            {open.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-sm text-muted">
                  Nada abierto. Al entregar PV-0001 debe aparecer FV-0001 aquí (por cobrar) y las FP de las OC (por pagar).
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {porMes && (porMes.meses.length > 0 || porMes.vencido.n > 0) && (
        <div className="mt-6">
          <h2 className="text-base font-semibold">Saldos por vencer por mes (plazo financiero)</h2>
          <p className="mt-0.5 text-sm text-muted">
            Base de la propuesta de pago: cuánto capital llega a su plazo financiero cada mes, y el interés que
            correría por mes de 30 días si no se paga (cargo × TIIE del vencimiento + {(porMes.spread * 100).toFixed(2)}% × 30/360).
          </p>
          {porMes.sinTiie > 0 && (
            <p className="mt-2 rounded-md border border-danger bg-cream px-3 py-2 text-[12px] text-danger">
              {porMes.sinTiie} factura(s) sin TIIE en la tabla para su vencimiento: su interés aparece en 0 porque no se calcula ni se estima. Captura la TIIE en Ajustes → Tabla TIIE.
            </p>
          )}
          <div className="mt-3 overflow-x-auto erp-card">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-3 font-medium">Mes</th>
                  <th className="px-3 py-3 text-right font-medium">Facturas</th>
                  <th className="px-3 py-3 text-right font-medium">Saldo</th>
                  <th className="px-3 py-3 text-right font-medium">De docs. USD</th>
                  <th className="px-4 py-3 text-right font-medium">Interés por mes si no se paga</th>
                </tr>
              </thead>
              <tbody>
                {porMes.vencido.n > 0 && (
                  <tr className="border-t border-line bg-warn/10">
                    <td className="px-4 py-3 font-medium">Ya vencido</td>
                    <td className="px-3 py-3 text-right tabular-nums">{porMes.vencido.n}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{money(porMes.vencido.saldo)}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{money(porMes.vencido.saldoUsdDocs)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{money(porMes.vencido.interesMensual)}</td>
                  </tr>
                )}
                {porMes.meses.map((m) => (
                  <tr key={m.month} className="border-t border-line">
                    <td className="px-4 py-3 font-medium">{m.month}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{m.n}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{money(m.saldo)}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{money(m.saldoUsdDocs)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted">{money(m.interesMensual)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </AppShell>
  );
}

import { createFileRoute, Link, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { FinanceNav, StatusPill } from "@/components/erp";
import { Expediente } from "@/components/expediente";
import { SendButton } from "@/components/send-doc";
import { getDealTrail } from "@/lib/erp/deal";
import { listInvoices, registerPayment } from "@/lib/azagro";
import { invoiceLiveMora, listBanks, getSettings } from "@/lib/erp/ops";
import { computeMora, exactClock, explainInterest, nearestRate, validateDueDates } from "@/lib/erp/credit";
import { letterhead, logoSrc, printHtml } from "@/lib/print-doc";
import { dateDMY, money, moneyIn, num, todayISO } from "@/lib/utils";

export const Route = createFileRoute("/credit")({
  validateSearch: (raw: Record<string, unknown>) => ({
    lado: raw.lado === "pagar" || raw.lado === "todos" ? raw.lado : "cobrar",
  }),
  component: Page,
});

function Page() {
  const { lado } = useSearch({ from: "/credit" });
  const kind = lado === "pagar" ? "supplier" : lado === "todos" ? "all" : "customer";
  const [status, setStatus] = useState<"all" | "open" | "overdue" | "paid">("all");
  const [rows, setRows] = useState<Awaited<ReturnType<typeof listInvoices>>>([]);
  const [pay, setPay] = useState<{ id: number; amount: number; bankId: number; memo: string; date: string } | null>(null);
  const [settings, setSettings] = useState<Awaited<ReturnType<typeof getSettings>> | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [banks, setBanks] = useState<Array<{ id: number; name: string; opening: string; movement: string; currency: string }>>([]);

  async function load() {
    const [inv, b, s] = await Promise.all([
      listInvoices({ data: { kind } }),
      listBanks().catch(() => null),
      getSettings().catch(() => null),
    ]);
    setRows(inv);
    if (b) setBanks(b.banks);
    if (s) setSettings(s);
  }
  useEffect(() => {
    void load();
  }, [kind]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (status === "paid") return r.state === "paid";
      if (status === "open") return r.state !== "paid";
      if (status === "overdue") return r.state !== "paid" && r.days_overdue > 0;
      return true;
    });
  }, [rows, status]);

  const kpis = useMemo(() => {
    const open = rows.filter((r) => r.state !== "paid");
    const total = rows.reduce((s, r) => s + num(r.amount), 0);
    const balance = open.reduce((s, r) => s + num(r.residual), 0);
    const paid = rows.reduce((s, r) => s + Math.max(0, num(r.amount) - num(r.residual)), 0);
    const cash = rows.filter((r) => (r.credit_days ?? 0) === 0).reduce((s, r) => s + num(r.amount), 0);
    const terms = rows.filter((r) => (r.credit_days ?? 0) > 0).reduce((s, r) => s + num(r.amount), 0);
    return { total, balance, paid, cash, terms };
  }, [rows]);

  return (
    <AppShell>
      <FinanceNav current={lado === "pagar" ? "pagar" : "cobrar"} />
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{lado === "pagar" ? "Cuentas por pagar" : "Cuentas por cobrar"}</h1>
          <p className="mt-0.5 text-sm text-muted">
            {lado === "pagar"
              ? "Lo que Azagro debe a proveedores. El vencimiento nace de la OC / factura de compra."
              : "Lo que los clientes deben a Azagro. Reloj en días exactos desde el vencimiento."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <select className="erp-input" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="all">Todos los estatus</option>
            <option value="open">Abiertas</option>
            <option value="overdue">Vencidas</option>
            <option value="paid">Pagadas</option>
          </select>
          <button type="button" className="erp-btn-primary" onClick={() => filtered[0] && setPay({ id: filtered[0].id, amount: num(filtered[0].residual), bankId: banks[0]?.id ?? 0, memo: "", date: todayISO() })}>
            Registrar {lado === "pagar" ? "pago" : "cobro"}
          </button>
        </div>
      </div>

      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      {msg && <p className="mb-3 text-sm text-ok">{msg}</p>}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Kpi label="Total facturado" value={money(kpis.total)} />
        <Kpi label="Saldo" value={money(kpis.balance)} />
        <Kpi label="Pagado" value={money(kpis.paid)} />
        <Kpi label="Contado" value={money(kpis.cash)} />
        <Kpi label="A crédito" value={money(kpis.terms)} />
      </div>

      <div className="overflow-x-auto erp-card">
        <table className="w-full min-w-[980px] text-left text-[13px]">
          <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3 font-medium">Folio</th>
              <th className="px-3 py-3 font-medium">Tipo</th>
              <th className="px-3 py-3 font-medium">Partner</th>
              <th className="px-3 py-3 font-medium">Emisión</th>
              <th className="px-3 py-3 font-medium">Vence</th>
              <th className="px-3 py-3 font-medium">Plazo</th>
              <th className="px-3 py-3 text-right font-medium">Total</th>
              <th className="px-3 py-3 text-right font-medium">Pagado</th>
              <th className="px-3 py-3 text-right font-medium">Saldo</th>
              <th className="px-3 py-3 font-medium">Estatus</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const paid = Math.max(0, num(r.amount) - num(r.residual));
              const overdue = r.state !== "paid" && r.days_overdue > 0;
              const clock = exactClock(r.due_date);
              const cur = r.currency === "USD" ? "USD" : "MXN";
              const terms = (r.credit_days ?? 0) === 0 ? "Contado" : `${r.credit_days} d exactos`;
              return (
                <tr key={r.id} className="border-t border-line">
                  <td className="px-4 py-3 font-medium">{r.name}</td>
                  <td className="px-3 py-3 text-muted">{r.kind === "customer" ? "Cliente" : "Proveedor"}</td>
                  <td className="px-3 py-3">
                    <Link to="/partners/$partnerId" params={{ partnerId: String(r.partner_id) }} search={{ tab: r.kind === "supplier" ? "proveedores" : "clientes", q: "" }} className="hover:underline">
                      {r.partner}
                    </Link>
                  </td>
                  <td className="px-3 py-3 tabular-nums">{dateDMY(r.date)}</td>
                  <td className="px-3 py-3">
                    <p className="tabular-nums">{dateDMY(r.due_date)}</p>
                    {r.state !== "paid" ? <p className="text-[11px] text-muted">{clock.label}</p> : null}
                    {validateDueDates({ issue: r.date, due: r.due_date, days: r.credit_days || undefined, allowPast: true }).errors[0] ? (
                      <p className="text-[11px] text-danger">Fecha inválida</p>
                    ) : null}
                  </td>
                  <td className="px-3 py-3">{terms}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{moneyIn(r.amount, cur)}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{moneyIn(paid, cur)}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{moneyIn(r.residual, cur)}</td>
                  <td className="px-3 py-3">
                    <StatusPill tone={r.state === "paid" ? "ok" : overdue ? "danger" : clock.status === "today" ? "warn" : "ok"}>
                      {r.state === "paid" ? "Pagada" : clock.label}
                    </StatusPill>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-2">
                      {r.kind === "customer" && overdue && (
                        <button
                          type="button"
                          className="erp-btn h-8 text-[12px]"
                          onClick={async () => {
                            try {
                              const res = await invoiceLiveMora({ data: { invoiceId: r.id } });
                              setMsg(
                                res.name
                                  ? `Factura de intereses ${res.name} · ${res.formula || ""}`
                                  : "Mora facturada aparte, no se mete al producto",
                              );
                              await load();
                            } catch (e) {
                              setMsg(e instanceof Error ? e.message : "Error");
                            }
                          }}
                        >
                          Mora
                        </button>
                      )}
                      {r.state !== "paid" && (
                        <>
                          <button type="button" className="erp-btn h-8 text-[12px]" onClick={() => setPay({ id: r.id, amount: num(r.residual), bankId: banks[0]?.id ?? 0, memo: "", date: todayISO() })}>
                            Pago
                          </button>
                          <button
                            type="button"
                            className="erp-btn h-8 text-[12px]"
                            onClick={async () => {
                              try {
                                const { sendPaymentReminder } = await import("@/lib/erp/alerts");
                                const d = await sendPaymentReminder({ data: { invoiceId: r.id } });
                                if (d.sent === "mailto" && d.mailto) window.location.href = d.mailto;
                                else setMsg(d.notice);
                              } catch (e) {
                                setError(e instanceof Error ? e.message : "Error");
                              }
                            }}
                          >
                            Recordatorio
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        className="erp-btn h-8 text-[12px]"
                        onClick={() =>
                          void (async () => {
                            const trail = await getDealTrail({ data: { kind: "invoice", id: r.id } })
                              .then((d) => d.line)
                              .catch(() => "");
                            printHtml(
                            r.name,
                            letterhead({
                              logoSrc: logoSrc(),
                              legalName: "AZ INSUMOS AGRICOLAS SA DE CV",
                              title: r.kind === "customer" ? "Factura" : "Factura de proveedor",
                              number: r.name,
                              partyLabel: r.kind === "customer" ? "Cliente" : "Proveedor",
                              party: r.partner,
                              meta: [`Emisión ${r.date}`, `Vence ${r.due_date}`, cur, trail ? `Expediente ${trail}` : r.origin].filter(Boolean),
                              rows: [{ left: r.origin || r.name, qty: "1", unit: moneyIn(r.amount, cur), amount: moneyIn(r.amount, cur) }],
                              total: moneyIn(r.residual, cur) + " saldo",
                            }),
                            {
                              title: r.kind === "customer" ? "Factura" : "Factura de proveedor",
                              number: r.name,
                              party: r.partner,
                              partnerId: r.partner_id,
                              email: r.partner_email,
                              phone: r.partner_phone,
                              extra: trail ? `Expediente: ${trail}` : undefined,
                            },
                          );
                          })()
                        }
                      >
                        Documento
                      </button>
                      <SendButton
                        title={r.kind === "customer" ? "Factura" : "Cuenta por pagar"}
                        number={r.name}
                        party={r.partner}
                        partnerId={r.partner_id}
                        email={r.partner_email}
                        phone={r.partner_phone}
                        amount={num(r.amount)}
                        total={num(r.residual)}
                        currency={cur}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={11} className="px-4 py-12 text-center text-sm text-muted">
                  Aún no hay facturas. Se generan al entregar un pedido.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {pay && (
        <form
          className="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            setMsg(null);
            try {
              if (!pay.bankId) throw new Error("Elige la cuenta de banco");
              const r = await registerPayment({
                data: { invoiceId: pay.id, amount: pay.amount, bankId: pay.bankId, memo: pay.memo, date: pay.date },
              });
              setPay(null);
              const extra = r.mora ? ` Mora ${r.mora} (${money(r.moraCharge)})${r.moraFormula ? ` · ${r.moraFormula}` : ""}.` : "";
              setMsg(`Aplicado ${money(r.applied)} en ${r.bank}. Saldo factura ${money(r.residual)}. Caja ${money(r.cashAfter)}.${extra}`);
              await load();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Error");
            }
          }}
        >
          <div className="w-full max-w-md erp-card p-5" onClick={(e) => e.stopPropagation()}>
            <p className="text-base font-semibold">{lado === "pagar" ? "Registrar pago" : "Registrar cobro"}</p>
            <Expediente kind="invoice" id={pay.id} />
            <p className="mt-1 text-[12px] text-muted">
              {lado === "pagar" ? "Sale de la cuenta. Si no hay saldo, primero cobra o pon saldo inicial en Bancos." : "Entra a la cuenta y baja el saldo del cliente."}
            </p>
            {(() => {
              const inv = rows.find((r) => r.id === pay.id);
              if (!inv || inv.kind !== "customer") return null;
              const tiieTable = (settings?.tiie ?? []).map((t) => ({ date: t.date, rate: Number(t.rate) }));
              const tiie = nearestRate(tiieTable, inv.due_date, settings?.defaultTiie ?? 0.0706);
              const mora = computeMora({
                capital: num(inv.residual),
                dueDate: inv.due_date,
                asOf: pay.date || todayISO(),
                tiieAtDue: tiie,
                spread: settings?.collectionSpread ?? 0.09,
                fegaRate: settings?.fegaRate ?? 0.0304,
                fegaAlreadyCharged: false,
              });
              const exp = explainInterest({
                capital: num(inv.residual),
                days: mora.daysOverdue,
                tiie,
                spread: settings?.collectionSpread ?? 0.09,
                interest: mora.interest,
                fega: mora.fega,
                fegaRate: settings?.fegaRate,
                currency: inv.currency,
                dueDate: inv.due_date,
                residual: num(inv.residual),
              });
              return (
                <div className="mt-2 text-[12px] text-muted">
                  <p>Vence {dateDMY(inv.due_date)} · {exactClock(inv.due_date, pay.date).label}.</p>
                  <p className="mt-1 font-mono text-[12px] text-ink">{exp.short}</p>
                  <ul className="mt-1 space-y-0.5">
                    {exp.lines.map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                </div>
              );
            })()}
            <label className="mt-3 grid gap-1 text-[11px] font-medium uppercase tracking-wide text-muted">
              Fecha
              <input
                type="date"
                className="erp-input"
                value={pay.date || todayISO()}
                onChange={(e) => setPay({ ...pay, date: e.target.value })}
              />
            </label>
            <label className="mt-3 grid gap-1 text-[11px] font-medium uppercase tracking-wide text-muted">
              Cuenta
              <select
                className="erp-input"
                value={pay.bankId}
                onChange={(e) => setPay({ ...pay, bankId: Number(e.target.value) })}
              >
                <option value={0}>Elegir cuenta…</option>
                {banks.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} · {money(Number(b.opening) + Number(b.movement))}
                  </option>
                ))}
              </select>
            </label>
            <label className="mt-3 grid gap-1 text-[11px] font-medium uppercase tracking-wide text-muted">
              Importe
              <input
                type="number"
                min={0.01}
                step="0.01"
                className="erp-input w-full"
                value={pay.amount}
                onChange={(e) => setPay({ ...pay, amount: Number(e.target.value) })}
              />
            </label>
            <label className="mt-3 grid gap-1 text-[11px] font-medium uppercase tracking-wide text-muted">
              Referencia
              <input className="erp-input" value={pay.memo} onChange={(e) => setPay({ ...pay, memo: e.target.value })} placeholder="Transferencia, cheque…" />
            </label>
            <div className="mt-4 flex gap-2">
              <button type="button" className="erp-btn flex-1" onClick={() => setPay(null)}>
                Cancelar
              </button>
              <button className="erp-btn-primary flex-1">Aplicar</button>
            </div>
          </div>
        </form>
      )}
    </AppShell>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="erp-card px-4 py-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

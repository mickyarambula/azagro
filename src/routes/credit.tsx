import { createFileRoute, Link, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { FinanceNav, StatusPill } from "@/components/erp";
import { Expediente } from "@/components/expediente";
import { SendButton } from "@/components/send-doc";
import { getDealTrail } from "@/lib/erp/deal";
import { listInvoices, registerPayment } from "@/lib/azagro";
import { invoiceLiveMora, listBanks, getSettings } from "@/lib/erp/ops";
import { chargeRates, chargesCaptured, computeMora, exactClock, explainInterest, missingChargesMessage, missingRateMessage, nearestRate, noMoraMessage, policyChargesInterest, validateDueDates } from "@/lib/erp/credit";
import { letterhead, logoSrc, printHtml } from "@/lib/print-doc";
import { expedienteFor, fxAdjustmentNote, interestInvoiceFallback, invoiceLineLabel, invoicePaperTitle } from "@/lib/erp/doc-text";
import { dateDMY, money, moneyIn, num, todayMx } from "@/lib/utils";

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
  const [pay, setPay] = useState<{
    id: number;
    amount: number;
    bankId: number;
    memo: string;
    date: string;
    fxPaid?: number;
    fxTreatment?: "utilidad" | "ajuste";
  } | null>(null);
  const [settings, setSettings] = useState<Awaited<ReturnType<typeof getSettings>> | null>(null);
  // Ajustes incompletos: se muestra el aviso tal cual; no hay números de respaldo.
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [banks, setBanks] = useState<Array<{ id: number; name: string; opening: string; movement: string; currency: string }>>([]);

  async function load() {
    const [inv, b, s] = await Promise.all([
      listInvoices({ data: { kind } }),
      listBanks().catch(() => null),
      getSettings().catch((e: unknown) => {
        setSettingsError(e instanceof Error ? e.message : "No se pudieron leer los Ajustes");
        return null;
      }),
    ]);
    setRows(inv);
    if (b) setBanks(b.banks);
    if (s) {
      setSettings(s);
      setSettingsError(null);
    }
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
          <button type="button" className="erp-btn-primary" onClick={() => filtered[0] && setPay({ id: filtered[0].id, amount: num(filtered[0].residual), bankId: banks[0]?.id ?? 0, memo: "", date: todayMx() })}>
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
                          <button type="button" className="erp-btn h-8 text-[12px]" onClick={() => setPay({ id: r.id, amount: num(r.residual), bankId: banks[0]?.id ?? 0, memo: "", date: todayMx() })}>
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
                            // Papel que sale de la empresa: la referencia interna
                            // (origen, cadena de folios) se traduce o se filtra
                            // según quién lo recibe (src/lib/erp/doc-text.ts).
                            const audience = r.kind === "customer" ? "cliente" : "proveedor";
                            const paperTitle = invoicePaperTitle(r.kind, r.inv_class);
                            const expediente = expedienteFor(trail, audience);
                            printHtml(
                            r.name,
                            letterhead({
                              logoSrc: logoSrc(),
                              legalName: "AZ INSUMOS AGRICOLAS SA DE CV",
                              title: paperTitle,
                              number: r.name,
                              partyLabel: r.kind === "customer" ? "Cliente" : "Proveedor",
                              party: r.partner,
                              meta: [`Emisión ${r.date}`, `Vence ${r.due_date}`, cur, expediente].filter(Boolean),
                              rows: [
                                {
                                  left: invoiceLineLabel({ name: r.name, origin: r.origin, invClass: r.inv_class }),
                                  qty: "1",
                                  unit: moneyIn(r.amount, cur),
                                  amount: moneyIn(r.amount, cur),
                                },
                              ],
                              totalLabel: "Saldo",
                              total: moneyIn(r.residual, cur),
                              // La factura de intereses explica su cuenta con la
                              // fórmula y las cifras que se facturaron ese día.
                              notes:
                                r.inv_class === "interest"
                                  ? r.calc_client || interestInvoiceFallback({ currency: cur, intPart: num(r.int_part), fegaPart: num(r.fega_part) })
                                  : r.inv_class === "fx"
                                    ? fxAdjustmentNote(r.calc)
                                    : undefined,
                            }),
                            {
                              title: paperTitle,
                              number: r.name,
                              party: r.partner,
                              partnerId: r.partner_id,
                              email: r.partner_email,
                              phone: r.partner_phone,
                              extra: expediente || undefined,
                            },
                          );
                          })()
                        }
                      >
                        Documento
                      </button>
                      <SendButton
                        title={r.kind === "customer" ? invoicePaperTitle(r.kind, r.inv_class) : "Cuenta por pagar"}
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
                data: {
                  invoiceId: pay.id,
                  amount: pay.amount,
                  bankId: pay.bankId,
                  memo: pay.memo,
                  date: pay.date,
                  fxPaid: pay.fxPaid || undefined,
                  fxTreatment: pay.fxTreatment,
                },
              });
              setPay(null);
              const extra = r.mora ? ` Mora ${r.mora} (${money(r.moraCharge)})${r.moraFormula ? ` · ${r.moraFormula}` : ""}.` : "";
              const desc = r.discount > 0 ? ` Pronto pago: se bonificaron ${money(r.discount)} y la factura quedó saldada.` : "";
              const fx = r.fxNote ? ` Diferencial TC: ${r.fxNote}.` : "";
              setMsg(`Aplicado ${money(r.applied)} en ${r.bank}. Saldo factura ${money(r.residual)}. Caja ${money(r.cashAfter)}.${extra}${desc}${fx}`);
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
              if (!settings) {
                return <p className="mt-2 text-[12px] text-danger">{settingsError ?? "Ajustes no disponibles: la mora no se puede calcular."}</p>;
              }
              // TIIE del vencimiento: renglón de la tabla, con fecha. Sin
              // renglón no se calcula ni se estima.
              // «Sin mora» apaga el interés del documento: ni TIIE ni FI.
              const cobraInteres = policyChargesInterest(inv.policy_code);
              const polDoc = settings.policies.find((x) => x.code === inv.policy_code) ?? null;
              if (!cobraInteres) {
                return (
                  <div className="mt-2 text-[12px] text-muted">
                    <p>Vence {dateDMY(inv.due_date)} · {exactClock(inv.due_date, pay.date).label}.</p>
                    <p className="mt-1">{noMoraMessage(polDoc?.name)}</p>
                  </div>
                );
              }
              const tiieTable = settings.tiie.map((t) => ({ date: t.date, rate: Number(t.rate) }));
              const pick = nearestRate(tiieTable, inv.due_date);
              if (!pick) {
                return (
                  <div className="mt-2 text-[12px] text-muted">
                    <p>Vence {dateDMY(inv.due_date)} · {exactClock(inv.due_date, pay.date).label}.</p>
                    <p className="mt-1 text-danger">{missingRateMessage(inv.due_date, `mora de ${inv.name}`)}</p>
                  </div>
                );
              }
              // Comisión y FEGA según la política del documento: los
              // porcentajes son los de Ajustes, la política dice cuál mitad se
              // cobra. Sin capturar, la FI se detiene: aquí se avisa antes.
              const cp = polDoc;
              const cobra = chargesCaptured(cp) ? { commission: cp.commission, fega: cp.fega } : null;
              const tasas = cobra
                ? chargeRates(settings.fegaRate, settings.commissionRate, cobra)
                : { fegaRate: 0, commissionRate: 0, fegaOnlyRate: 0 };
              const mora = computeMora({
                capital: num(inv.residual),
                dueDate: inv.due_date,
                asOf: pay.date || todayMx(),
                tiieAtDue: pick.rate,
                spread: settings.collectionSpread,
                fegaRate: tasas.fegaRate,
                fegaAlreadyCharged: false,
              });
              const exp = explainInterest({
                capital: num(inv.residual),
                days: mora.daysOverdue,
                tiie: pick.rate,
                tiieDate: pick.date,
                spread: settings.collectionSpread,
                interest: mora.interest,
                fega: mora.fega,
                fegaRate: tasas.fegaRate,
                commissionRate: tasas.commissionRate,
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
                  {cobra ? (
                    <p className="mt-1">
                      Política {cp!.name}: comisión {cobra.commission ? "sí" : "no"} · FEGA {cobra.fega ? "sí" : "no"}.
                    </p>
                  ) : mora.daysOverdue > 0 ? (
                    <p className="mt-1 text-danger">{missingChargesMessage(inv.policy_code || "(sin política)", cp?.name)}</p>
                  ) : null}
                </div>
              );
            })()}
            <label className="mt-3 grid gap-1 text-[11px] font-medium uppercase tracking-wide text-muted">
              Fecha
              <input
                type="date"
                className="erp-input"
                value={pay.date || todayMx()}
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
              Importe (pesos depositados)
              <input
                type="number"
                min={0.01}
                step="0.01"
                className="erp-input w-full"
                value={pay.amount}
                onChange={(e) => setPay({ ...pay, amount: Number(e.target.value) })}
              />
            </label>
            {rows.find((r) => r.id === pay.id)?.currency === "USD" && (
              <>
                <label className="mt-3 grid gap-1 text-[11px] font-medium uppercase tracking-wide text-muted">
                  TC del pago (obligatorio: factura en dólares)
                  <input
                    type="number"
                    min={0.0001}
                    step="0.0001"
                    className="erp-input w-full"
                    value={pay.fxPaid ?? ""}
                    onChange={(e) => setPay({ ...pay, fxPaid: Number(e.target.value) })}
                    placeholder="p. ej. 18.60"
                  />
                </label>
                <div className="mt-2 grid gap-1 text-[11px] font-medium uppercase tracking-wide text-muted">
                  Diferencial contra el TC pactado
                  <div className="flex gap-3 text-[13px] normal-case tracking-normal">
                    <label className="flex items-center gap-1.5">
                      <input
                        type="radio"
                        name="fxTreatment"
                        checked={(pay.fxTreatment ?? "utilidad") === "utilidad"}
                        onChange={() => setPay({ ...pay, fxTreatment: "utilidad" })}
                      />
                      Dejarlo como utilidad/pérdida
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input
                        type="radio"
                        name="fxTreatment"
                        checked={pay.fxTreatment === "ajuste"}
                        onChange={() => setPay({ ...pay, fxTreatment: "ajuste" })}
                      />
                      Ajustar al pactado (por cobrar / devolver)
                    </label>
                  </div>
                </div>
              </>
            )}
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

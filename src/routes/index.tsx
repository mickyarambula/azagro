import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { getDashboard } from "@/lib/azagro";
import { getFxPosition } from "@/lib/erp/fx-position-query";
import { getCompanyPnl, getUpcomingDue, getUpcomingPayable } from "@/lib/erp/reports";
import { useAccess } from "@/lib/access";
import { canSeeCosts, canSeeMargins } from "@/lib/erp/acl";
import { prevPath } from "@/lib/trail";
import { money, todayMx, moneyIn } from "@/lib/utils";

export const Route = createFileRoute("/")({ component: Home });

function monthStart() {
  return `${todayMx().slice(0, 7)}-01`;
}

/**
 * Rediseño del inicio (16-sep-2026, `DISENO-INVESTIGACION.md`). El dueño lo
 * describió dos veces: "el inicio no es un tablero" y "está horrible y no
 * dice nada esencial". Principio: un tablero contesta "¿qué me va a doler
 * hoy?", en este orden — cuánto tengo, cuánto me deben y qué tan vencido,
 * qué se está atorando, si alcanza para lo que viene. Las 13 tarjetas de
 * atajo (el menú ya las tiene, con favoritos por persona) y el diagrama de
 * flujo (manual, vive en /ayuda) se van de la primera pantalla.
 */
type Item = { key: string; label: string; hint?: string; money: number | null; count: number; to: string; search?: Record<string, string>; tone: "danger" | "warn" | "muted" };

function Home() {
  return (
    <AppShell>
      <InicioBody />
    </AppShell>
  );
}

/**
 * Aparte de `Home` a propósito (mismo patrón que `CloseShortPurchaseButton`
 * en purchases.tsx): `Home` renderiza el `AppShell`, y `useAccess()` solo
 * tiene contexto DENTRO de él — llamarlo en `Home` siempre daba el valor por
 * omisión (rol vacío, sin permisos), y por eso la Caja/Por cobrar/Por pagar/
 * Inventario nunca aparecían, con cualquier usuario. Defecto real, ya
 * existía en el inicio viejo (verificado); se corrige de una vez aquí.
 */
function InicioBody() {
  const access = useAccess();
  const [data, setData] = useState<Awaited<ReturnType<typeof getDashboard>> | null>(null);
  const [fx, setFx] = useState<Awaited<ReturnType<typeof getFxPosition>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resume, setResume] = useState<string | null>(null);
  const [due, setDue] = useState<Awaited<ReturnType<typeof getUpcomingDue>> | null>(null);
  const [payable, setPayable] = useState<Awaited<ReturnType<typeof getUpcomingPayable>> | null>(null);
  const [pnl, setPnl] = useState<Awaited<ReturnType<typeof getCompanyPnl>> | null>(null);

  const seeCredit = access.can("credit");
  const seeBanks = access.can("banks");
  const seeStockValue = canSeeCosts(access.role);
  const seeMonth = seeCredit && canSeeMargins(access.role);
  // Operativo, no dinero: lo ven ventas, compras y almacén por igual (cada
  // uno ve sus módulos — ownOnly ya filtra "so" del lado del vendedor).
  const seeSales = access.can("sales");
  const seePurchases = access.can("purchases");

  useEffect(() => {
    getDashboard()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Error"));
    const prev = prevPath();
    if (prev && prev !== "/" && !prev.startsWith("/login")) setResume(prev);
  }, []);

  useEffect(() => {
    if (!seeCredit) return;
    void Promise.all([getUpcomingDue(), getUpcomingPayable()])
      .then(([d, p]) => {
        setDue(d);
        setPayable(p);
      })
      .catch(() => undefined);
  }, [seeCredit]);

  // BLOQUE A.2: la exposición en dólares, del mismo lugar que la pantalla de
  // Posición cambiaria (nunca una segunda fórmula que diga otro número).
  useEffect(() => {
    if (!seeBanks) return;
    void getFxPosition()
      .then(setFx)
      .catch(() => undefined);
  }, [seeBanks]);

  useEffect(() => {
    if (!seeMonth) return;
    getCompanyPnl({ data: { from: monthStart(), to: todayMx() } })
      .then(setPnl)
      .catch(() => undefined);
  }, [seeMonth]);

  const agingOrder = ["Por vencer", "1-30", "31-60", "61+"];

  // La bandeja: solo lo que tiene número mayor a cero, ordenado por dinero en
  // riesgo primero (el conteo solo, después). Cada renglón lleva a donde se
  // resuelve, no solo lo nombra.
  const items: Item[] = data
    ? ([
        seeCredit && data.overdueN > 0
          ? { key: "overdue", label: `${data.overdueN} factura${data.overdueN === 1 ? "" : "s"} vencida${data.overdueN === 1 ? "" : "s"}`, money: data.arOverdue, count: data.overdueN, to: "/credit", search: { lado: "cobrar" }, tone: "danger" as const }
          : null,
        seeCredit && data.creditExceededN > 0
          ? {
              key: "credit-exceeded",
              label: `${data.creditExceededN} cliente${data.creditExceededN === 1 ? "" : "s"} pasado${data.creditExceededN === 1 ? "" : "s"} de su límite de crédito`,
              money: data.creditExceededAmount,
              count: data.creditExceededN,
              to: "/partners",
              search: { tab: "clientes", q: "" },
              tone: "danger" as const,
            }
          : null,
        seeCredit && data.deliveredNotInvoicedN > 0
          ? {
              key: "delivered-not-invoiced",
              label: `${data.deliveredNotInvoicedN} partida${data.deliveredNotInvoicedN === 1 ? "" : "s"} entregada${data.deliveredNotInvoicedN === 1 ? "" : "s"} sin facturar`,
              hint: "Mercancía que ya salió y todavía no se ha facturado (normal en bodega propia; es dinero parado)",
              money: data.deliveredNotInvoicedAmount,
              count: data.deliveredNotInvoicedN,
              to: "/inventory",
              tone: "warn" as const,
            }
          : null,
        data.confirmedNotDeliveredN > 0
          ? {
              key: "confirmed-not-delivered",
              label: `${data.confirmedNotDeliveredN} pedido${data.confirmedNotDeliveredN === 1 ? "" : "s"} confirmado${data.confirmedNotDeliveredN === 1 ? "" : "s"} sin entregar del todo`,
              hint: data.confirmedNotDeliveredOldestDays > 0 ? `El más viejo lleva ${data.confirmedNotDeliveredOldestDays} día${data.confirmedNotDeliveredOldestDays === 1 ? "" : "s"}` : undefined,
              money: null,
              count: data.confirmedNotDeliveredN,
              to: "/sales",
              search: { tab: "confirmed", q: "" },
              tone: "warn" as const,
            }
          : null,
        seeCredit && data.fpSinRecibir > 0
          ? {
              key: "fp-sin-recibir",
              label: `${data.fpSinRecibir} factura${data.fpSinRecibir === 1 ? "" : "s"} de proveedor de mercancía que todavía no llega`,
              hint: "Nacieron antes: hoy la deuda nace al recibir. Se limpian solas al recibir la orden o al cancelarla.",
              money: null,
              count: data.fpSinRecibir,
              to: "/credit",
              search: { lado: "pagar" },
              tone: "warn" as const,
            }
          : null,
        seeCredit && data.ncSinTimbrar > 0
          ? {
              key: "nc-sin-timbrar",
              label: `${data.ncSinTimbrar} nota${data.ncSinTimbrar === 1 ? "" : "s"} de crédito de una reversa sin timbrar`,
              hint: "Para el SAT esa venta sigue viva: hay que timbrarla en Compaq y capturar aquí su folio fiscal.",
              money: null,
              count: data.ncSinTimbrar,
              to: "/credit",
              search: { lado: "cobrar" },
              tone: "danger" as const,
            }
          : null,
        seeCredit && data.ncPendientesSat > 0
          ? {
              key: "nc-pendientes-sat",
              label: `${data.ncPendientesSat} nota${data.ncPendientesSat === 1 ? "" : "s"} de crédito revertida${data.ncPendientesSat === 1 ? "" : "s"} pendiente${data.ncPendientesSat === 1 ? "" : "s"} de cancelar en el SAT`,
              hint: "Para el SAT esa devolución sigue viva: hay que cancelar el CFDI en Compaq y capturar aquí la fecha.",
              money: null,
              count: data.ncPendientesSat,
              to: "/credit",
              search: { lado: "cobrar" },
              tone: "danger" as const,
            }
          : null,
        data.lowStock > 0
          ? {
              key: "low-stock",
              label: `${data.lowStock} producto${data.lowStock === 1 ? "" : "s"} bajo mínimo`,
              hint: data.lowStockList.slice(0, 3).map((p) => p.name).join(" · ") || undefined,
              money: null,
              count: data.lowStock,
              to: "/inventory",
              tone: "muted" as const,
            }
          : null,
        data.orphanCustomers > 0
          ? {
              key: "orphan",
              label: `${data.orphanCustomers} cliente${data.orphanCustomers === 1 ? "" : "s"} sin vendedor asignado`,
              hint: "Cualquiera con cartera propia los ve y los toca por igual.",
              money: null,
              count: data.orphanCustomers,
              to: "/partners",
              search: { tab: "clientes", q: "" },
              tone: "warn" as const,
            }
          : null,
      ] as (Item | null)[])
        .filter((x): x is Item => x !== null)
        .sort((a, b) => (b.money ?? -1) - (a.money ?? -1) || b.count - a.count)
    : [];

  // Los meses de "cobrar" y "pagar" combinados: vencido primero, luego cada
  // mes en el que hay algo por cualquiera de los dos lados.
  const months = due || payable
    ? (() => {
        const map = new Map<string, { month: string; cobrar: number; pagar: number }>();
        for (const b of due?.meses ?? []) map.set(b.month, { month: b.month, cobrar: b.saldo, pagar: map.get(b.month)?.pagar ?? 0 });
        for (const b of payable?.meses ?? []) map.set(b.month, { month: b.month, cobrar: map.get(b.month)?.cobrar ?? 0, pagar: b.saldo });
        return [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
      })()
    : [];
  const vencidoCobrar = due?.vencido.saldo ?? 0;
  const vencidoPagar = payable?.vencido.saldo ?? 0;

  return (
      <div className="p-5">
        <h1 className="text-[22px] font-semibold tracking-tight">Inicio</h1>
        <p className="mt-0.5 text-sm text-muted">Lo que hoy necesita tu atención, en dinero.</p>
        {resume ? (
          <a href={resume} className="mt-3 inline-flex min-h-10 items-center rounded-md border border-accent/30 bg-brand-soft px-3 text-sm font-medium text-forest">
            Seguir donde te quedaste
          </a>
        ) : null}

        {error && <p className="mt-4 text-sm text-danger">{error}</p>}

        {(seeCredit || seeBanks || seeStockValue) && (
          <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {seeBanks && (
              <Kpi
                label="Caja"
                value={data ? money(data.cash) : "—"}
                hint={data?.cashUsd ? `Pesos · ${moneyIn(data.cashUsd, "USD")} en la cuenta en dólares` : "Saldos bancarios en pesos"}
              />
            )}
            {seeCredit && (
              <Kpi
                label="Por cobrar"
                value={data ? money(data.ar) : "—"}
                hint={`${data?.arOverdue ? `${money(data.arOverdue)} vencido` : "Al corriente"}${data?.arUsd ? ` · ${moneyIn(data.arUsd, "USD")} en dólares` : ""}`}
                hintTone={data?.arOverdue ? "danger" : undefined}
              />
            )}
            {seeCredit && (
              <Kpi
                label="Por pagar"
                value={data ? money(data.ap) : "—"}
                hint={`${data?.payableWeek ? `${money(data.payableWeek)} vence en 7 días` : "Nada vence esta semana"}${data?.apUsd ? ` · ${moneyIn(data.apUsd, "USD")} en dólares` : ""}`}
                hintTone={data?.payableWeek ? "warn" : undefined}
              />
            )}
            {seeBanks && (
              <Kpi
                label="Exposición neta USD"
                value={fx ? moneyIn(fx.posicion.netoUsd, "USD") : "—"}
                hint={
                  fx
                    ? `${fx.fxToday ? `Dólar de hoy ${fx.fxToday.rate}` : "Sin dólar de hoy"} · ${
                        fx.verResultado ? `${money(fx.posicion.netoUsd)} por cada peso que se mueva` : "posición en dólares"
                      }`
                    : undefined
                }
                hintTone={fx && fx.posicion.netoUsd < 0 ? "warn" : undefined}
              />
            )}
            {seeStockValue && (
              <Kpi
                label="Inventario Azagro"
                value={data ? money(data.stockOwn) : "—"}
                hint={data ? `Proveedor ${money(data.stockSupplier)} · tránsito ${money(data.stockTransit)}` : undefined}
              />
            )}
          </div>
        )}

        <div className="mt-6 erp-card p-4">
          <h2 className="text-[13px] font-semibold">Requiere tu atención</h2>
          <ul className="mt-3 space-y-2">
            {items.map((it) => (
              <Link
                key={it.key}
                to={it.to as "/"}
                search={(it.search ?? undefined) as never}
                className={`flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm ${
                  it.tone === "danger" ? "border-danger bg-cream text-danger" : it.tone === "warn" ? "border-warn bg-cream text-warn" : "border-line bg-cream text-ink"
                }`}
              >
                <span>
                  {it.label}
                  {it.hint ? <span className="block text-[12px] font-normal opacity-80">{it.hint}</span> : null}
                </span>
                <span className="flex shrink-0 items-center gap-2 font-medium">
                  {it.money != null && <span className="tabular-nums">{money(it.money)}</span>}
                  <span className="underline decoration-dotted">Ver</span>
                </span>
              </Link>
            ))}
            {data && items.length === 0 && <li className="text-sm text-muted">Nada pendiente por hoy.</li>}
          </ul>
        </div>

        {seeCredit && (due || payable) && (
          <div className="mt-4 erp-card p-4">
            <h2 className="text-[13px] font-semibold">Flujo de caja próximo</h2>
            <p className="mt-1 text-[12px] text-muted">Lo que llega a su plazo mes por mes, del lado del cliente y del lado del proveedor.</p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[420px] text-left text-[13px]">
                <thead className="text-[11px] uppercase tracking-wide text-muted">
                  <tr>
                    <th className="py-1 font-medium">Mes</th>
                    <th className="py-1 text-right font-medium">Por cobrar</th>
                    <th className="py-1 text-right font-medium">Por pagar</th>
                  </tr>
                </thead>
                <tbody>
                  {(vencidoCobrar > 0 || vencidoPagar > 0) && (
                    <tr className="border-t border-line text-danger">
                      <td className="py-1.5 font-medium">Vencido</td>
                      <td className="py-1.5 text-right tabular-nums">{money(vencidoCobrar)}</td>
                      <td className="py-1.5 text-right tabular-nums">{money(vencidoPagar)}</td>
                    </tr>
                  )}
                  {months.map((m) => (
                    <tr key={m.month} className="border-t border-line">
                      <td className="py-1.5">{m.month}</td>
                      <td className="py-1.5 text-right tabular-nums">{money(m.cobrar)}</td>
                      <td className="py-1.5 text-right tabular-nums">{money(m.pagar)}</td>
                    </tr>
                  ))}
                  {months.length === 0 && vencidoCobrar === 0 && vencidoPagar === 0 && (
                    <tr>
                      <td colSpan={3} className="py-4 text-center text-muted">
                        Sin facturas abiertas con plazo.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="mt-4 grid gap-3 lg:grid-cols-3">
          {(seeSales || seePurchases) && (
            <div className="erp-card p-4">
              <div className="flex items-center justify-between">
                <h3 className="text-[13px] font-semibold">Cola operativa</h3>
                <Link to="/sales" search={{ tab: "confirmed", q: "" }} className="text-[12px] font-medium text-accent">
                  Pedidos
                </Link>
              </div>
              <ul className="mt-3 space-y-2 text-sm">
                {seeSales && (
                  <li className="flex justify-between">
                    <span className="text-muted">Ventas por entregar</span>
                    <span className="tabular-nums">{data?.pendingSo ?? "—"}</span>
                  </li>
                )}
                {seePurchases && (
                  <li className="flex justify-between">
                    <span className="text-muted">Compras por recibir</span>
                    <span className="tabular-nums">{data?.pendingPo ?? "—"}</span>
                  </li>
                )}
              </ul>
            </div>
          )}
          {seeMonth && pnl && (
            <div className="erp-card p-4">
              <div className="flex items-center justify-between">
                <h3 className="text-[13px] font-semibold">El mes</h3>
                <Link to="/reportes" className="text-[12px] font-medium text-accent">
                  Utilidad
                </Link>
              </div>
              <ul className="mt-3 space-y-2 text-sm">
                <li className="flex justify-between">
                  <span className="text-muted">Ventas ({pnl.salesN})</span>
                  <span className="tabular-nums">{money(pnl.revenue)}</span>
                </li>
                <li className="flex justify-between">
                  <span className="text-muted">Utilidad neta</span>
                  <span className="tabular-nums">{money(pnl.net)}</span>
                </li>
                <li className="flex justify-between">
                  <span className="text-muted">Cobrado</span>
                  <span className="tabular-nums">{money(pnl.collected)}</span>
                </li>
              </ul>
            </div>
          )}
          {seeCredit && (
            <div className="erp-card p-4">
              <div className="flex items-center justify-between">
                <h3 className="text-[13px] font-semibold">Antigüedad CxC</h3>
                <Link to="/credit" search={{ lado: "cobrar" }} className="text-[12px] font-medium text-accent">
                  Por cobrar
                </Link>
              </div>
              <ul className="mt-3 space-y-2 text-sm">
                {agingOrder.map((b) => {
                  const amt = data?.aging.find((a) => a.bucket === b)?.amount ?? 0;
                  return (
                    <li key={b} className="flex justify-between">
                      <span className="text-muted">{b}</span>
                      <span className="tabular-nums">{money(amt)}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </div>
  );
}

function Kpi({ label, value, hint, hintTone }: { label: string; value: string; hint?: string; hintTone?: "danger" | "warn" }) {
  return (
    <div className="erp-card px-4 py-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className={`mt-1 text-[12px] ${hintTone === "danger" ? "font-medium text-danger" : hintTone === "warn" ? "font-medium text-warn" : "text-muted"}`}>{hint}</p> : null}
    </div>
  );
}

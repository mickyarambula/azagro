import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { FinanceNav, StatusPill } from "@/components/erp";
import { MoneyField } from "@/components/fields";
import { getFxPosition } from "@/lib/erp/fx-position-query";
import { sensitivity } from "@/lib/erp/fx-position";
import { exportCsv } from "@/lib/export-csv";
import { dateDMY, humanError, money, moneyIn } from "@/lib/utils";

export const Route = createFileRoute("/posicion")({ component: Page });

type Datos = Awaited<ReturnType<typeof getFxPosition>>;

const ESTADO_LABEL: Record<string, string> = {
  "dinamica-2": "Cubierto · tipo de cambio pactado en las dos puntas",
  natural: "Cubierto · las dos puntas en dólares",
  "venta-pactada": "Venta al tipo de cambio pactado",
  "abierto-compra": "Abierto del lado compra",
  "abierto-venta": "Abierto del lado venta",
  "abierto-ambos": "Abierto por los dos lados",
  "sin-exposicion": "Sin exposición",
};

const KIND_LABEL: Record<string, string> = { FV: "Factura al cliente", FP: "Factura del proveedor", PV: "Pedido sin facturar", OC: "Orden sin recibir" };

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "ok" | "warn" | "danger" }) {
  return (
    <div className="erp-card p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : tone === "ok" ? "text-ok" : ""}`}>{value}</p>
      {hint ? <p className="mt-1 text-[12px] text-muted">{hint}</p> : null}
    </div>
  );
}

function Page() {
  const [d, setD] = useState<Datos | null>(null);
  const [error, setError] = useState<string | null>(null);
  // El escenario lo escribe la persona: es un supuesto suyo, no un número de
  // negocio del sistema (no se lee de Ajustes ni decide nada guardado).
  const [delta, setDelta] = useState(1);

  useEffect(() => {
    void getFxPosition()
      .then(setD)
      .catch((e) => setError(humanError(e)));
  }, []);

  const conMonto = useMemo(() => (d ? d.cubetas.filter((c) => c.cxc || c.cxp || c.ventaComprometida || c.compraComprometida) : []), [d]);

  return (
    <AppShell>
      <FinanceNav current="posicion" />
      <div className="mb-3">
        <h1 className="text-lg font-semibold">Posición cambiaria</h1>
        <p className="text-[13px] text-muted">
          Cuánto se debe y cuánto deben en dólares, a qué tipo de cambio se pactó cada documento, y qué pasa si el dólar se mueve.
        </p>
      </div>
      {error ? <p className="mb-3 text-[13px] text-danger">{error}</p> : null}
      {!d ? (
        <p className="text-[13px] text-muted">Cargando…</p>
      ) : (
        <>
          {/* --- El tipo de cambio de hoy: sin renglón no se inventa ninguno (regla 9). --- */}
          {d.fxToday ? (
            <p className="mb-3 text-[13px] text-muted">
              Corte {dateDMY(d.asOf)} · dólar de hoy <span className="font-semibold text-ink">{d.fxToday.rate}</span> (tabla {dateDMY(d.fxToday.date)}).
            </p>
          ) : (
            <p className="mb-3 text-[13px] text-warn">
              Corte {dateDMY(d.asOf)} · <span className="font-semibold">sin tipo de cambio de hoy en la tabla</span>: los dólares y los tipos de cambio pactados se
              siguen viendo, pero no se puede decir cuánto valen en pesos. Captúralo en Ajustes → Tipo de cambio.
            </p>
          )}

          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi label="Nos deben en dólares" value={moneyIn(d.posicion.activosUsd, "USD")} hint="Facturas del cliente y pedidos sin facturar" />
            <Kpi label="Debemos en dólares" value={moneyIn(d.posicion.pasivosUsd, "USD")} hint="Facturas del proveedor y órdenes sin recibir" />
            <Kpi label="Dólares en caja" value={moneyIn(d.posicion.cajaUsd, "USD")} hint={d.caja.avgFx ? `TC promedio ${d.caja.avgFx} · ${money(d.caja.avgFx * d.caja.tracked)} en pesos` : "Sin costo en pesos conocido"} />
            <Kpi
              label="Posición neta"
              value={moneyIn(d.posicion.netoUsd, "USD")}
              hint={d.posicion.netoUsd >= 0 ? "Nos deben más de lo que debemos: si el dólar sube, se gana" : "Debemos más de lo que nos deben: si el dólar sube, se pierde"}
              tone={d.posicion.netoUsd >= 0 ? "ok" : "danger"}
            />
          </div>

          {/* --- Pregunta 3: cuánto se gana o se pierde si el dólar se mueve --- */}
          {d.verResultado ? (
            <div className="mb-4 erp-card p-4">
              <p className="text-sm font-semibold">Si el dólar se mueve</p>
              <div className="mt-2 flex flex-wrap items-center gap-3 text-[13px]">
                <label className="flex items-center gap-2">
                  <span className="text-muted">Movimiento supuesto (pesos por dólar)</span>
                  <MoneyField value={delta} onChange={setDelta} />
                </label>
                <span className="text-muted">
                  Sobre la posición neta de {moneyIn(d.posicion.netoUsd, "USD")}:
                </span>
                <span className={`text-lg font-semibold tabular-nums ${sensitivity(d.posicion.netoUsd, delta) < 0 ? "text-danger" : "text-ok"}`}>
                  {money(sensitivity(d.posicion.netoUsd, delta))}
                </span>
              </div>
              <p className="mt-2 text-[12px] text-muted">
                Es una simulación tuya: el movimiento que escribes no se guarda ni sale de esta pantalla. Una cuenta por cobrar en dólares gana cuando el dólar sube;
                una por pagar pierde.
              </p>
              {d.revaluacion && d.revaluacion.totalMxn != null ? (
                <p className="mt-2 text-[13px]">
                  <span className="font-semibold">Al dólar de hoy</span>, lo vivo vale{" "}
                  <span className={`font-semibold tabular-nums ${d.revaluacion.totalMxn < 0 ? "text-danger" : "text-ok"}`}>{money(d.revaluacion.totalMxn)}</span>{" "}
                  más o menos de lo que quedó registrado a su tipo de cambio pactado ({money(d.revaluacion.docsMxn ?? 0)} de los documentos y{" "}
                  {money(d.revaluacion.cajaMxn ?? 0)} de los dólares en caja). Todavía no está realizado: pasa a serlo cuando se cobre o se pague.
                </p>
              ) : (
                <p className="mt-2 text-[12px] text-warn">Sin tipo de cambio de hoy no se calcula cuánto vale hoy lo vivo.</p>
              )}
            </div>
          ) : null}

          {/* --- Pregunta 1 y 4: cubetas y cobertura --- */}
          <div className="mb-4 overflow-x-auto erp-card">
            <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-3">
              <p className="text-sm font-semibold">Por vencimiento</p>
              <p className="text-[12px] text-muted">
                Cubetas de tesorería, hasta 150 días: son distintas a propósito de las de Vencimientos, que es cobranza a 30 días.
              </p>
            </div>
            <table className="mt-2 w-full min-w-[900px] text-left text-[13px]">
              <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Cubeta</th>
                  <th className="px-3 py-2 text-right font-medium">Nos deben</th>
                  <th className="px-3 py-2 text-right font-medium">Venta comprometida</th>
                  <th className="px-3 py-2 text-right font-medium">Debemos</th>
                  <th className="px-3 py-2 text-right font-medium">Compra comprometida</th>
                  <th className="px-3 py-2 text-right font-medium">Neto</th>
                  <th className="px-3 py-2 text-right font-medium">Cubierto con dólares</th>
                  <th className="px-3 py-2 text-right font-medium">Abierto</th>
                </tr>
              </thead>
              <tbody>
                {conMonto.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-6 text-center text-muted">
                      Sin documentos vivos en dólares. Aparecen al cotizar, pedir, facturar o comprar en dólares.
                    </td>
                  </tr>
                ) : (
                  conMonto.map((c) => (
                    <tr key={c.bucket} className="border-t border-line">
                      <td className="px-4 py-2 font-medium">{c.label}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{c.cxc ? moneyIn(c.cxc, "USD") : "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted">{c.ventaComprometida ? moneyIn(c.ventaComprometida, "USD") : "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{c.cxp ? moneyIn(c.cxp, "USD") : "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted">{c.compraComprometida ? moneyIn(c.compraComprometida, "USD") : "—"}</td>
                      <td className={`px-3 py-2 text-right tabular-nums font-semibold ${c.neto < 0 ? "text-danger" : ""}`}>{moneyIn(c.neto, "USD")}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-ok">{c.cubiertoCaja ? moneyIn(c.cubiertoCaja, "USD") : "—"}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${c.abiertoCompra > 0.009 ? "text-warn" : ""}`}>{c.abiertoCompra ? moneyIn(c.abiertoCompra, "USD") : "—"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            <p className="px-4 pb-3 pt-2 text-[12px] text-muted">
              «Cubierto con dólares» es la dinámica 1: los dólares que hay en caja se apartan contra lo que se debe, de lo que vence antes a lo que vence después. Los
              dólares del banco son una bolsa sola: no se puede decir cuáles se compraron para cuál orden, así que la cobertura se mide a nivel empresa, no por pedido.
            </p>
          </div>

          {/* --- Pregunta 4, por deal: la dinámica 2 sí se deriva --- */}
          {d.deals.length ? (
            <div className="mb-4 overflow-x-auto erp-card">
              <p className="px-4 pt-3 text-sm font-semibold">Por negocio</p>
              <table className="mt-2 w-full min-w-[760px] text-left text-[13px]">
                <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-4 py-2 font-medium">Pedido</th>
                    <th className="px-3 py-2 font-medium">Cliente</th>
                    <th className="px-3 py-2 font-medium">Compra</th>
                    <th className="px-3 py-2 font-medium">Venta</th>
                    <th className="px-3 py-2 text-right font-medium">Abierto</th>
                    <th className="px-3 py-2 font-medium">Cobertura</th>
                  </tr>
                </thead>
                <tbody>
                  {d.deals.map((x) => (
                    <tr key={x.soName} className="border-t border-line">
                      <td className="px-4 py-2 font-medium">{x.soName}</td>
                      <td className="px-3 py-2">{x.partner}</td>
                      <td className="px-3 py-2 text-muted">
                        {x.buyCurrency}
                        {x.buyFx ? ` · TC ${x.buyFx}` : ""}
                      </td>
                      <td className="px-3 py-2 text-muted">
                        {x.saleCurrency}
                        {x.saleFx ? ` · TC ${x.saleFx}` : ""}
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums ${x.usdAbierto > 0.009 ? "text-warn" : ""}`}>{x.usdAbierto ? moneyIn(x.usdAbierto, "USD") : "—"}</td>
                      <td className="px-3 py-2">
                        <StatusPill tone={x.estado.startsWith("abierto") ? "warn" : x.estado === "venta-pactada" ? "muted" : "ok"}>{ESTADO_LABEL[x.estado] ?? x.estado}</StatusPill>
                        <span className="ml-2 text-[12px] text-muted">{x.motivo}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {/* --- Pregunta 2: el TC pactado de cada documento vivo contra el de hoy --- */}
          <div className="mb-4 overflow-x-auto erp-card">
            <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-3">
              <p className="text-sm font-semibold">Documento por documento</p>
              <button type="button" className="erp-btn h-8 text-[12px]" onClick={() => exportCsv("posicion-cambiaria", ["Documento", "Socio", "Lado", "USD abierto", "TC pactado", "Vence", "En pesos al pactado", "En pesos hoy"], d.documentos.map((x) => [x.name, x.partner, x.side, x.usd, x.fxAgreed ?? "sin TC", x.due ?? "sin fecha", x.fxAgreed ? x.usd * x.fxAgreed : "", d.fxToday && x.fxAgreed ? x.usd * d.fxToday.rate : ""]))}>
                Exportar Excel
              </button>
            </div>
            <table className="mt-2 w-full min-w-[900px] text-left text-[13px]">
              <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Documento</th>
                  <th className="px-3 py-2 font-medium">Socio</th>
                  <th className="px-3 py-2 text-right font-medium">USD abierto</th>
                  <th className="px-3 py-2 text-right font-medium">TC pactado</th>
                  <th className="px-3 py-2 font-medium">Vence</th>
                  <th className="px-3 py-2 text-right font-medium">En pesos al pactado</th>
                  <th className="px-3 py-2 text-right font-medium">En pesos al dólar de hoy</th>
                  <th className="px-3 py-2 text-right font-medium">Diferencia</th>
                </tr>
              </thead>
              <tbody>
                {d.documentos.map((x) => {
                  const alPactado = x.fxAgreed ? x.usd * x.fxAgreed : null;
                  const aHoy = d.fxToday && x.fxAgreed ? x.usd * d.fxToday.rate : null;
                  const dif = alPactado != null && aHoy != null ? aHoy - alPactado : null;
                  return (
                    <tr key={`${x.kind}-${x.name}`} className="border-t border-line">
                      <td className="px-4 py-2">
                        <span className="font-medium">{x.name}</span>
                        <span className="ml-2 text-[11px] text-muted">{KIND_LABEL[x.kind]}</span>
                      </td>
                      <td className="px-3 py-2">{x.partner}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${x.side === "pagar" ? "text-danger" : ""}`}>
                        {x.side === "pagar" ? "−" : ""}
                        {moneyIn(x.usd, "USD")}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{x.fxAgreed ?? <span className="text-warn">sin TC</span>}</td>
                      <td className="px-3 py-2">{x.due ? dateDMY(x.due) : <span className="text-muted">sin fecha</span>}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{alPactado != null ? money(alPactado) : "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{aHoy != null ? money(aHoy) : "—"}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${dif != null && dif < 0 ? "text-danger" : dif != null && dif > 0 ? "text-ok" : ""}`}>
                        {dif != null ? money(dif) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* --- Decisión 85: los documentos en dólares sin TC pactado, con su motivo --- */}
          {d.sinTcPactado.n > 0 ? (
            <div className="mb-4 rounded-md border border-warn bg-cream px-4 py-3 text-[13px]">
              <p className="font-semibold text-warn">
                {d.sinTcPactado.n} documento(s) en dólares sin tipo de cambio pactado ·{" "}
                {moneyIn(d.sinTcPactado.docs.reduce((s, x) => s + x.usd, 0), "USD")} sin valuar
              </p>
              <p className="mt-1 text-muted">
                No entran en ningún total en pesos de esta pantalla: sin el tipo de cambio con el que se pactaron no se puede decir cuánto valen. Son documentos que
                nacieron antes de que el sistema exigiera el tipo de cambio. Corregirlos no es capturar un campo: hay que revertir la recepción de esa orden, corregir
                el tipo de cambio y volver a recibir.
              </p>
              <ul className="mt-2 list-inside list-disc text-muted">
                {d.sinTcPactado.docs.map((x) => (
                  <li key={`sintc-${x.kind}-${x.name}`}>
                    {x.name} · {x.partner} · {moneyIn(x.usd, "USD")}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {d.caja.sinTc > 0.009 ? (
            <p className="mb-4 text-[12px] text-warn">
              {moneyIn(d.caja.sinTc, "USD")} de los dólares en caja entraron sin tipo de cambio (saldo inicial del corte): cuentan en la exposición, pero no tienen
              costo en pesos con qué compararse.
            </p>
          ) : null}
        </>
      )}
    </AppShell>
  );
}

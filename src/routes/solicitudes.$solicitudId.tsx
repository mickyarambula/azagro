import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { BackBar, HeadBox, StatusPill } from "@/components/erp";
import { MoneyField, QtyField } from "@/components/fields";
import { OpsPipeline } from "@/components/pipeline";
import { SendButton } from "@/components/send-doc";
import { getSettings } from "@/lib/erp/ops";
import { saveRfqBid } from "@/lib/erp/rfq";
import { annualRate, priceSale } from "@/lib/erp/pricing";
import { applyCheapest, deleteRequest, getRequest, listRequests, pickVendor, quoteFromRequest, saveLineFreight, saveLineMargin, sendVendorRfq, updateRequest } from "@/lib/erp/requests";
import { destText, RequestFields, type RequestDraft } from "@/components/request-form";
import { Expediente } from "@/components/expediente";
import { listDeliveryPoints } from "@/lib/erp/locations";
import { money, num, qty, humanError } from "@/lib/utils";

export const Route = createFileRoute("/solicitudes/$solicitudId")({ component: Page });

const MODE_LABEL: Record<string, string> = {
  campo: "Puesta en campo",
  bodega: "En bodega",
  pickup: "El cliente recolecta",
};

function Page() {
  const { solicitudId } = Route.useParams();
  const navigate = useNavigate();
  const id = Number(solicitudId);
  const [data, setData] = useState<Awaited<ReturnType<typeof getRequest>> | null>(null);
  const [lookups, setLookups] = useState<Awaited<ReturnType<typeof listRequests>> | null>(null);
  const [destinos, setDestinos] = useState<Array<{ id: number; name: string; address: string }>>([]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<RequestDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [targets, setTargets] = useState<Record<string, boolean>>({});
  const [tiiePct, setTiiePct] = useState(0);
  const [spreadPct, setSpreadPct] = useState(0);
  const [commissionPct, setCommissionPct] = useState(1);
  const [days, setDays] = useState(0);
  const [currency, setCurrency] = useState<"USD" | "MXN">("USD");
  const [fxRate, setFxRate] = useState(18);
  const [busy, setBusy] = useState(false);

  async function load() {
    const d = await getRequest({ data: { id } });
    setData(d);
    const next: Record<string, boolean> = {};
    if (d.rfq?.targets.length) {
      for (const t of d.rfq.targets) next[`${t.product_id}:${t.partner_id}`] = true;
    } else {
      for (const line of d.lines) {
        const linked = d.links.filter((l) => l.product_id === line.product_id);
        const use = linked.length ? linked : d.suppliers.map((s) => ({ partner_id: s.id, product_id: line.product_id }));
        for (const l of use) next[`${line.product_id}:${l.partner_id}`] = linked.length > 0;
      }
    }
    setTargets(next);
    if (!d.request.quote_id) {
      setDraft({
        partnerId: String(d.request.partner_id),
        mode: (["campo", "bodega", "pickup"].includes(d.request.delivery_mode)
          ? d.request.delivery_mode
          : "campo") as RequestDraft["mode"],
        locationId: d.request.location_id ? String(d.request.location_id) : "",
        lines: d.lines.map((l) => ({ productId: l.product_id, qty: num(l.qty), uom: l.uom })),
      });
    }
  }

  useEffect(() => {
    void load().catch((e) => setError(e instanceof Error ? e.message : "Error"));
    void listRequests()
      .then(setLookups)
      .catch(() => undefined);
    void listDeliveryPoints()
      .then((loc) => setDestinos(loc.rows))
      .catch(() => undefined);
    void getSettings()
      .then((s) => {
        const latest = s.tiie[0];
        setTiiePct(Number(((latest ? Number(latest.rate) : s.defaultTiie) * 100).toFixed(2)));
        // El spread del precio es el de COSTO (circuito hermana), no el de línea.
        setSpreadPct(Number((s.asrSpread * 100).toFixed(2)));
        setCommissionPct(Number((s.asrCommission * 100).toFixed(2)));
      })
      .catch(() => undefined);
  }, [id]);

  const rate = annualRate(tiiePct / 100, spreadPct / 100);

  const bidOf = (partnerId: number, productId: number) => {
    const b = data?.rfq?.bids.find((x) => x.partner_id === partnerId && x.product_id === productId);
    return b ? num(b.unit_price) : 0;
  };

  const invitedIds = useMemo(() => {
    const s = new Set<number>();
    for (const [k, on] of Object.entries(targets)) if (on) s.add(Number(k.split(":")[1]));
    return [...s];
  }, [targets]);

  if (!data) {
    return <p className="text-sm text-muted">{error ?? "Cargando la solicitud…"}</p>;
  }

  const { request, lines, suppliers } = data;
  const deliveryNote = `${MODE_LABEL[request.delivery_mode] ?? request.delivery_mode}${request.delivery_to ? ` · ${request.delivery_to}` : ""}`;

  return (
    <>
      <OpsPipeline current="solicitud" />
      <BackBar to="/solicitudes" label="Todas las solicitudes" />
      <Expediente kind="request" id={id} />
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">
            {request.name}{" "}
            <StatusPill tone={request.state === "quoted" ? "ok" : request.state === "rfq" ? "warn" : "muted"}>
              {request.state === "quoted" ? "Cotizada al cliente" : request.state === "rfq" ? "Con proveedores" : "Abierta"}
            </StatusPill>
          </h1>
          <p className="mt-1 text-sm text-muted">
            Cliente: <strong>{request.partner}</strong> · {deliveryNote}
          </p>
          <p className="mt-0.5 text-[12px] text-muted">El proveedor nunca ve el nombre del cliente. El cliente nunca ve el nombre del proveedor.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!request.quote_id && (
            <>
              <button
                type="button"
                className="erp-btn"
                onClick={() => setEditing((v) => !v)}
              >
                {editing ? "Cerrar corrección" : "Corregir"}
              </button>
              <button
                type="button"
                className="erp-btn text-danger"
                disabled={busy}
                onClick={async () => {
                  if (!window.confirm(`¿Borrar ${request.name}?`)) return;
                  setBusy(true);
                  setError(null);
                  try {
                    await deleteRequest({ data: { id } });
                    await navigate({ to: "/solicitudes" });
                  } catch (e) {
                    setError(humanError(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Borrar
              </button>
            </>
          )}
        </div>
      </div>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      {msg && <p className="mb-3 text-sm text-ok">{msg}</p>}

      {editing && draft && lookups && !request.quote_id ? (
        <form
          className="mb-6"
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = draft.lines.filter((l) => l.productId && l.qty > 0);
            if (!draft.partnerId || !ok.length) {
              setError("Cliente y al menos un producto");
              return;
            }
            setBusy(true);
            setError(null);
            try {
              await updateRequest({
                data: {
                  id,
                  partnerId: Number(draft.partnerId),
                  deliveryMode: draft.mode,
                  deliveryTo: destText(destinos, draft.locationId),
                  locationId: draft.locationId ? Number(draft.locationId) : undefined,
                  lines: ok,
                },
              });
              setMsg("Solicitud corregida");
              setEditing(false);
              await load();
            } catch (e) {
              setError(humanError(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <RequestFields
            draft={draft}
            setDraft={setDraft}
            customers={lookups.customers}
            products={lookups.products}
            destinos={destinos}
            setDestinos={setDestinos}
          />
          <div className="mt-3 flex gap-2">
            <button type="button" className="erp-btn" onClick={() => setEditing(false)}>
              Cancelar
            </button>
            <button className="erp-btn-primary" disabled={busy}>
              Guardar corrección
            </button>
          </div>
        </form>
      ) : null}

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold">1. Lo que pidió</h2>
        <div className="overflow-x-auto erp-card">
          <table className="w-full min-w-[640px] text-left text-[13px]">
            <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">Producto</th>
                <th className="px-3 py-2.5 text-right font-medium">Cant.</th>
                <th className="px-3 py-2.5 font-medium">UoM</th>
                <th className="px-3 py-2.5 text-right font-medium">Azagro</th>
                <th className="px-3 py-2.5 text-right font-medium">En proveedor</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const short = num(l.qty) > num(l.on_hand_own) + 0.0001;
                return (
                  <tr key={l.id} className="border-t border-line">
                    <td className="px-4 py-2.5">
                      <span className="font-medium">{l.product}</span>
                      <span className="ml-2 font-mono text-[11px] text-muted">{l.code}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{qty(l.qty)}</td>
                    <td className="px-3 py-2.5">{l.uom}</td>
                    <td className={`px-3 py-2.5 text-right tabular-nums ${short ? "text-warn" : "text-ok"}`}>
                      {qty(l.on_hand_own)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted">{qty(l.on_hand_supplier)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mb-6">
        <h2 className="mb-1 text-sm font-semibold">2. A quién se pide cotización (interno)</h2>
        <p className="mb-3 text-[13px] text-muted">
          Marca producto × proveedor. No todos atienden todo. Se manda a cada uno solo lo suyo, con las condiciones de entrega, sin el nombre del cliente.
        </p>
        <div className="overflow-x-auto erp-card">
          <table className="w-full min-w-[720px] text-left text-[13px]">
            <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">Producto</th>
                {suppliers.map((s) => (
                  <th key={s.id} className="px-3 py-2.5 text-center font-medium">{s.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id} className="border-t border-line">
                  <td className="px-4 py-2.5">{l.code}</td>
                  {suppliers.map((s) => {
                    const k = `${l.product_id}:${s.id}`;
                    return (
                      <td key={s.id} className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={!!targets[k]}
                          onChange={(e) => setTargets((t) => ({ ...t, [k]: e.target.checked }))}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="erp-btn-primary"
            disabled={busy || invitedIds.length === 0}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const list = Object.entries(targets)
                  .filter(([, on]) => on)
                  .map(([k]) => {
                    const [productId, supplierId] = k.split(":").map(Number);
                    return { productId: productId!, supplierId: supplierId! };
                  });
                const r = await sendVendorRfq({ data: { requestId: id, targets: list } });
                setMsg(`Lista ${r.name} lista para enviar a proveedores`);
                await load();
              } catch (e) {
                setError(humanError(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Armar lista a proveedores
          </button>
        </div>

        {data.rfq && (
          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {suppliers
              .filter((s) => invitedIds.includes(s.id) || data.rfq?.targets.some((t) => t.partner_id === s.id))
              .map((s) => {
                const his = lines.filter((l) => data.rfq!.targets.some((t) => t.partner_id === s.id && t.product_id === l.product_id) || targets[`${l.product_id}:${s.id}`]);
                return (
                  <div key={s.id} className="erp-card p-3">
                    <p className="text-sm font-semibold">{s.name}</p>
                    <p className="text-[11px] text-muted">No incluye al cliente</p>
                    <div className="mt-2">
                      <SendButton
                        label={`Enviar a ${s.name}`}
                        title="Solicitud de cotización"
                        number={data.rfq!.name}
                        party={s.name}
                        partnerId={s.id}
                        email={s.email}
                        phone={s.phone}
                        extra={`Condiciones de entrega: ${deliveryNote}\nCotizar precio por unidad. Responder a Azagro.`}
                        lines={his.map((l) => ({ qty: num(l.qty), uom: l.uom, name: `${l.code} ${l.product}` }))}
                      />
                    </div>
                  </div>
                );
              })}
          </div>
        )}
      </section>

      <section className="mb-6">
        <h2 className="mb-1 text-sm font-semibold">3. Comparativa (interno)</h2>
        <p className="mb-3 text-[13px] text-muted">
          Escribe el precio que te cotizó cada proveedor, debajo de su nombre. El recuadro marcado es el ganador. El recomendado es el más barato; si eliges otro (crédito, servicio), se respeta.
        </p>
        {data.rfq ? (
          <button
            type="button"
            className="erp-btn mb-3"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await applyCheapest({ data: { requestId: id } });
                setMsg("Ganador por precio aplicado. Puedes cambiarlo.");
                await load();
              } catch (e) {
                setError(humanError(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Usar el más barato en todas
          </button>
        ) : null}
        {!data.rfq ? (
          <p className="text-sm text-muted">Primero arma la lista a proveedores.</p>
        ) : (
          <div className="overflow-x-auto erp-card">
            {(() => {
              const invited = suppliers.filter((s) => data.rfq!.targets.some((t) => t.partner_id === s.id));
              return (
                <table className="w-full text-left text-[13px]" style={{ minWidth: 160 + invited.length * 160 + 120 }}>
                  <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
                    <tr>
                      <th className="w-40 px-4 py-2.5 font-medium">Producto</th>
                      {invited.map((s) => (
                        <th key={s.id} className="w-40 px-3 py-2.5 text-right font-medium">{s.name}</th>
                      ))}
                      <th className="w-[7.5rem] px-3 py-2.5 text-right font-medium">Flete / UoM</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => (
                      <tr key={l.id} className="border-t border-line align-top">
                        <td className="px-4 py-2">
                          <p className="font-medium">{l.code}</p>
                          <p className="text-[11px] text-muted">{qty(l.qty)} {l.uom}</p>
                          {l.supplier_id ? (
                            <p className="mt-1 text-[11px] text-ok">
                              Ganador: {suppliers.find((s) => s.id === l.supplier_id)?.name}
                            </p>
                          ) : (
                            <p className="mt-1 text-[11px] text-warn">Sin ganador</p>
                          )}
                        </td>
                        {invited.map((s) => {
                          const asked = data.rfq!.targets.some((t) => t.partner_id === s.id && t.product_id === l.product_id);
                          const win = l.supplier_id === s.id;
                          const price = bidOf(s.id, l.product_id);
                          return (
                            <td key={s.id} className={`px-3 py-2 ${win ? "bg-brand-soft" : ""}`}>
                              {asked ? (
                                <div className="flex flex-col items-end gap-1">
                                  <MoneyField
                                    className="w-full max-w-[9rem]"
                                    placeholder="precio"
                                    value={price}
                                    onCommit={(n) => {
                                      void saveRfqBid({ data: { rfqId: data.rfq!.id, partnerId: s.id, productId: l.product_id, unitPrice: n } })
                                        .then(load)
                                        .catch((e) => setError(humanError(e)));
                                    }}
                                  />
                                  <button
                                    type="button"
                                    className={win ? "text-[11px] font-semibold text-ok" : "text-[11px] text-accent hover:underline"}
                                    disabled={busy}
                                    onClick={() => {
                                      if (!price) {
                                        setError("Escribe el precio de ese proveedor antes de marcarlo ganador.");
                                        return;
                                      }
                                      void pickVendor({ data: { requestId: id, productId: l.product_id, supplierId: s.id, unitPrice: price } })
                                        .then(load)
                                        .catch((e) => setError(humanError(e)));
                                    }}
                                  >
                                    {win ? "Ganador" : "Usar este"}
                                  </button>
                                </div>
                              ) : (
                                <span className="block text-right text-muted">—</span>
                              )}
                            </td>
                          );
                        })}
                        <td className="px-3 py-2">
                          <MoneyField
                            className="w-full"
                            placeholder="0"
                            value={num(l.freight)}
                            onCommit={(n) => {
                              void saveLineFreight({ data: { requestId: id, productId: l.product_id, freight: n } })
                                .then(load)
                                .catch((e) => setError(humanError(e)));
                            }}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              );
            })()}
          </div>
        )}
      </section>

      <section className="mb-6">
        <h2 className="mb-1 text-sm font-semibold">4. Cotización al cliente (lo que sí ve el cliente)</h2>
        <p className="mb-3 text-[13px] text-muted">Azagro vende. No aparece quién nos cotizó. TIIE y spread van separados; la tasa es la suma.</p>
        <div className="mb-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <HeadBox label="Moneda">
            <select className="erp-input w-full border-0 bg-transparent px-0" value={currency} onChange={(e) => setCurrency(e.target.value as "USD" | "MXN")}>
              <option value="USD">USD</option>
              <option value="MXN">MXN</option>
            </select>
          </HeadBox>
          {currency === "USD" ? (
            <HeadBox label="TC">
              <MoneyField className="w-full border-0 bg-transparent px-0" value={fxRate} onChange={setFxRate} />
            </HeadBox>
          ) : null}
          <HeadBox label="Plazo días">
            <QtyField className="w-full border-0 bg-transparent px-0" value={days} onChange={setDays} />
          </HeadBox>
          <HeadBox label="TIIE %">
            <QtyField className="w-full border-0 bg-transparent px-0" value={tiiePct} onChange={setTiiePct} />
          </HeadBox>
          <HeadBox label="Spread costo %">
            <QtyField className="w-full border-0 bg-transparent px-0" value={spreadPct} onChange={setSpreadPct} />
          </HeadBox>
          <HeadBox label="Comisión %">
            <QtyField className="w-full border-0 bg-transparent px-0" value={commissionPct} onChange={setCommissionPct} />
          </HeadBox>
        </div>
        <p className="mb-3 text-[13px] text-muted">
          Precio = costo + margen + <strong>financiamiento encima</strong> (comisión {commissionPct.toFixed(2)}% + Capa 1: TIIE {tiiePct.toFixed(2)}% + spread costo {spreadPct.toFixed(2)}% = {(rate * 100).toFixed(2)}% × {days} d / 360).
          {days === 0 ? " Contado: sin financiamiento, precio = costo + margen." : " El cliente paga el financiamiento dentro del precio; Azagro no lo absorbe."} El 9% de mora NO va aquí: es factura de intereses al vencimiento.
        </p>
        <div className="overflow-x-auto erp-card">
          <table className="w-full min-w-[980px] text-left text-[13px]">
            <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">Producto</th>
                <th className="px-3 py-2.5 text-right font-medium">Costo</th>
                <th className="px-3 py-2.5 font-medium">Margen</th>
                <th className="px-3 py-2.5 text-right font-medium">Valor</th>
                <th className="px-3 py-2.5 text-right font-medium">Equivale</th>
                <th className="px-3 py-2.5 text-right font-medium">Financiero /u</th>
                <th className="px-3 py-2.5 text-right font-medium">Precio / UoM</th>
                <th className="px-3 py-2.5 text-right font-medium">Importe</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const mode = (l.margin_mode === "nominal" ? "nominal" : "pct") as "pct" | "nominal";
                const calc = priceSale({
                  cost: num(l.cost),
                  freight: num(l.freight),
                  other: 0,
                  days,
                  tiie: tiiePct / 100,
                  costSpread: spreadPct / 100,
                  commissionRate: commissionPct / 100,
                  marginMode: mode,
                  marginPct: num(l.margin_pct) || 12,
                  marginNominal: num(l.margin_nominal),
                  qty: num(l.qty),
                });
                return (
                  <tr key={l.id} className="border-t border-line">
                    <td className="px-4 py-2.5">
                      {l.product}
                      <span className="ml-2 text-[11px] text-muted">{qty(l.qty)} {l.uom}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {num(l.cost) > 0 ? money(num(l.cost)) : <span className="text-warn">Sin costo</span>}
                      {num(l.freight) > 0 ? <span className="block text-[11px] text-muted">+ flete {money(num(l.freight))}</span> : null}
                    </td>
                    <td className="px-3 py-2">
                      <select
                        className="erp-input"
                        value={mode}
                        onChange={(e) => {
                          const marginMode = e.target.value as "pct" | "nominal";
                          void saveLineMargin({
                            data: {
                              requestId: id,
                              productId: l.product_id,
                              marginMode,
                              marginPct: num(l.margin_pct) || 12,
                              marginNominal: num(l.margin_nominal) || calc.marginUnit,
                            },
                          }).then(load);
                        }}
                      >
                        <option value="pct">% margen</option>
                        <option value="nominal">$ por {l.uom}</option>
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      {mode === "pct" ? (
                        <QtyField
                          value={num(l.margin_pct) || 12}
                          onCommit={(n) => {
                            void saveLineMargin({
                              data: { requestId: id, productId: l.product_id, marginMode: "pct", marginPct: n, marginNominal: 0 },
                            }).then(load);
                          }}
                        />
                      ) : (
                        <MoneyField
                          value={num(l.margin_nominal)}
                          onCommit={(n) => {
                            void saveLineMargin({
                              data: { requestId: id, productId: l.product_id, marginMode: "nominal", marginPct: 0, marginNominal: n },
                            }).then(load);
                          }}
                        />
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right text-[12px] text-muted tabular-nums">
                      {mode === "pct" ? `${money(calc.marginUnit)} / ${l.uom} · total ${money(calc.margin)}` : `${calc.marginPct.toFixed(1)}% · total ${money(calc.margin)}`}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {calc.financeUnit > 0.009 ? (
                        <>
                          {money(calc.financeUnit)}
                          <span className="block text-[11px] text-muted">
                            com {money(calc.commissionUnit)} + C1 {money(calc.layer1Unit)}
                          </span>
                        </>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {money(calc.priceUnit)}
                      <span className="block text-[11px] text-muted">
                        costo {money(calc.landedUnit)} + margen {money(calc.marginUnit)}{calc.financeUnit > 0.009 ? ` + fin ${money(calc.financeUnit)}` : ""}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right font-medium tabular-nums">{money(calc.price)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex justify-end">
          {request.quote_id ? (
            <Link to="/quotes" className="erp-btn-primary grid place-items-center">
              Ya existe {request.quote_name ?? "cotización"} — ver documento
            </Link>
          ) : (
          <button
            type="button"
            className="erp-btn-primary"
            disabled={busy || lines.some((l) => num(l.cost) <= 0)}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const r = await quoteFromRequest({
                  data: {
                    requestId: id,
                    currency,
                    fxRate: currency === "MXN" ? 1 : fxRate,
                    tiie: tiiePct / 100,
                    spread: spreadPct / 100,
                    creditDays: days,
                    send: true,
                  },
                });
                setMsg(`Cotización ${r.name} lista para el cliente (sin proveedores)`);
                await load();
              } catch (e) {
                setError(humanError(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Crear y enviar cotización al cliente
          </button>
          )}
        </div>
        {request.quote_id ? (
          <p className="mt-2 text-right text-[13px]">
            <Link to="/quotes" className="font-semibold text-accent">
              Abrir {request.quote_name ?? "cotización"} →
            </Link>
          </p>
        ) : null}
      </section>
    </>
  );
}

import { salePriceShown } from "@/lib/erp/fx";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { OrderFields, stateLabel, type OrderDraft, type OrderLookups } from "@/components/order-form";
import { inheritCircuit } from "@/lib/erp/circuits";
import { OFFER_LABEL, SIN_MARGEN, marginText } from "@/lib/erp/margins";
import { BackBar, StatusPill } from "@/components/erp";
import { Expediente } from "@/components/expediente";
import { DocFiles } from "@/components/doc-files";
import { SendButton } from "@/components/send-doc";
import { useAccess } from "@/lib/access";
import { closeShortSale, deliverSale, invoiceDelivery, listDeliveryEvents, receivePurchase, returnProposal, returnSale } from "@/lib/azagro";
import { CloseShortButton } from "@/components/close-short";
import { PartialQtyDialog } from "@/components/partial-qty-dialog";
import { cancelOrder, changeOrderTerm, getDealPnl, getOrder, markReceived, orderLookups, saveGuia, saveOrder } from "@/lib/erp/orders";
import { CancelButton, CancelChainButton, DeliveryReversalButton, ReturnReversalButton } from "@/components/cancel-doc";
import { returnReversalPreview, reverseReturn } from "@/lib/erp/return-reversal";
import { deliveryEventReversalPreview, deliveryReversalPreview, reverseDelivery, reverseDeliveryEvent } from "@/lib/erp/delivery-reversal";
import { cancelChainPreview, cancelSalesOrderChain } from "@/lib/erp/cancel";
import { duesPreview } from "@/components/order-form";
import { QtyField } from "@/components/fields";
import { validateDueDates } from "@/lib/erp/credit";
import { SignPad } from "@/components/sign-pad";
import { letterhead, logoSrc, printHtml, guiaSheet } from "@/lib/print-doc";
import { expedienteFor } from "@/lib/erp/doc-text";
import { dateDMY, fmtDate, money, moneyIn, num, qty } from "@/lib/utils";

export const Route = createFileRoute("/sales/$orderId")({
  component: Ficha,
});

function Ficha() {
  const { orderId } = Route.useParams();
  const navigate = useNavigate();
  const id = Number(orderId);
  const { can, role } = useAccess();
  const isAdmin = role === "admin";
  const canEdit = can("sales", "edit");
  // Paso 3 (Decisión 48): entregar es mover mercancía — deliver (edit lo incluye).
  const canDeliver = can("sales", "deliver");
  // Recibir una OC ligada al pedido es acción de compras/almacén
  // (receivePurchase exige purchases:edit): no mostrar el botón a quien va a
  // truenar al hacer clic.
  const canReceive = can("purchases", "deliver");
  const [lookups, setLookups] = useState<OrderLookups | null>(null);
  const [form, setForm] = useState<OrderDraft | null>(null);
  const [state, setState] = useState("draft");
  const [cancelledAt, setCancelledAt] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [closedShort, setClosedShort] = useState<{ at: string | null; reason: string }>({ at: null, reason: "" });
  const [invoices, setInvoices] = useState<Array<{ id: number; name: string; due_date: string; residual: string; state: string; reverses_id: number | null }>>([]);
  const [purchases, setPurchases] = useState<
    Array<{ id: number; name: string; partner: string; state: string; total: string; fulfill_kind: string }>
  >([]);
  const [receivedAt, setReceivedAt] = useState<string | null>(null);
  const [pnl, setPnl] = useState<Awaited<ReturnType<typeof getDealPnl>> | null>(null);
  const [events, setEvents] = useState<Awaited<ReturnType<typeof listDeliveryEvents>>>([]);
  const [guia, setGuia] = useState({
    fletero: "",
    placas: "",
    chofer: "",
    vehicleBrand: "",
    mode: "azagro" as "campo" | "pickup" | "azagro" | "proveedor",
  });
  const [origen, setOrigen] = useState("");
  const [sign, setSign] = useState("");
  const [signName, setSignName] = useState("");
  const [obs, setObs] = useState("");
  const [printGuia, setPrintGuia] = useState(false);
  const [trail, setTrail] = useState("");
  const [sold, setSold] = useState<Array<{ id: number; product_id: number; code: string; name: string; qty: string; qty_delivered: string; qty_returned: string; qty_closed_short?: string; unit_price: string; uom: string }>>([]);
  const [retQty, setRetQty] = useState<Record<number, number>>({});
  const [retReason, setRetReason] = useState("");
  // BLOQUE DE PARCIALES, paso 5 (Decisión 52): con dos o más facturas vivas,
  // a cuál abona la devolución. El sistema propone la factura donde viajó el
  // producto (`returnProposal`); la persona confirma o cambia; si viajó en
  // más de una, se pregunta. null = todavía no eligió.
  const [retFv, setRetFv] = useState<number | null>(null);
  const [retProposal, setRetProposal] = useState<Awaited<ReturnType<typeof returnProposal>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [overrideCredit, setOverrideCredit] = useState(false);
  // Origen del pedido (cotización): plazo y precio heredados, por partida.
  const [origin, setOrigin] = useState<Awaited<ReturnType<typeof getOrder>>["origin"]>(null);
  const [originLines, setOriginLines] = useState<Awaited<ReturnType<typeof getOrder>>["lines"]>([]);
  const [changeTerm, setChangeTerm] = useState(false);
  const [newDays, setNewDays] = useState(0);
  // Circuito de financiamiento guardado (etiqueta de solo lectura, paso 1).
  const [circuit, setCircuit] = useState<string | null | undefined>(undefined);
  // Elección manual del administrador esta sesión (paso 2), solo para un
  // pedido DIRECTO. null = sin tocar: se sigue proponiendo con la regla.
  const [circuitOverride, setCircuitOverride] = useState<"CONTADO" | "ASR" | null>(null);

  async function load() {
    const [d, l, p, ev] = await Promise.all([
      getOrder({ data: { id } }),
      orderLookups(),
      getDealPnl({ data: { soId: id } }).catch(() => null),
      listDeliveryEvents({ data: { soId: id } }).catch(() => []),
    ]);
    const o = d.order;
    setLookups(l);
    setPnl(p);
    setState(o.state);
    setCancelledAt(o.cancelled_at);
    setCancelReason(o.cancel_reason || "");
    setClosedShort({ at: o.closed_short_at ?? null, reason: o.closed_short_reason || "" });
    setInvoices(d.invoices);
    setPurchases(d.purchases ?? []);
    // Precio de la partida en la moneda del pedido (guardado en pesos, Decisión 82): así la tabla
    // de devolución enseña dólares con el mismo `moneyIn(num(l.unit_price), form.currency)` de siempre.
    const curO = o.currency === "USD" ? "USD" : "MXN";
    d.lines = d.lines.map((ln) => ({ ...ln, unit_price: String(salePriceShown(ln.unit_price, curO, o.fx_rate)) }));
    setSold(d.lines);
    setEvents(ev);
    setOrigin(d.origin);
    setCircuitOverride(null);
    setOriginLines(d.lines);
    setChangeTerm(false);
    setNewDays(o.credit_days);
    setCircuit(o.circuit_code);
    setRetQty((cur) => {
      const next = { ...cur };
      for (const l of d.lines) {
        if (next[l.product_id] == null) next[l.product_id] = 0;
      }
      return next;
    });
    setReceivedAt(o.received_at);
    setGuia({
      fletero: o.fletero || "",
      placas: o.placas || "",
      chofer: o.chofer || "",
      vehicleBrand: o.vehicle_brand || "",
      mode: (["campo", "pickup", "azagro", "proveedor"].includes(o.ship_mode) ? o.ship_mode : "azagro") as typeof guia.mode,
    });
    setOrigen(o.location_name || l.locations.find((x) => x.id === o.location_id)?.name || "");
    setSign(o.guia_sign || "");
    setSignName(o.guia_sign_name || "");
    setObs(o.guia_obs || "");
    setForm({
      name: o.name,
      partnerId: o.partner_id,
      date: o.date.slice(0, 10),
      ocCliente: o.oc_cliente,
      termKind: (["contado", "credit_days", "date", "harvest"].includes(o.term_kind) ? o.term_kind : "credit_days") as OrderDraft["termKind"],
      invoiceDays: o.invoice_days,
      creditDays: o.credit_days,
      invoiceDue: (o.invoice_due ?? o.date).slice(0, 10),
      creditDue: (o.credit_due ?? o.invoice_due ?? o.date).slice(0, 10),
      currency: o.currency === "USD" ? "USD" : "MXN",
      fxRate: num(o.fx_rate),
      routeKind: (["own", "supplier", "asr"].includes(o.route_kind) ? o.route_kind : "own") as OrderDraft["routeKind"],
      asrPartnerId: o.asr_partner_id,
      locationId: o.location_id,
      policyCode: o.policy_code || "",
      priceMode: (["cash", "financed", "custom"].includes(o.price_mode) ? o.price_mode : "custom") as OrderDraft["priceMode"],
      deliveryTo: o.delivery_to,
      notes: o.notes,
      lines: d.lines.map((ln) => ({
        productId: ln.product_id,
        qty: num(ln.qty),
        // Ya en la moneda del pedido: d.lines se convirtió arriba, una sola vez (Decisión 82).
        unitPrice: num(ln.unit_price),
        uom: ln.uom,
      })),
    });
  }

  const liveFvs = invoices.filter((i) => i.name.startsWith("FV-") && i.state !== "reversed" && !i.reverses_id);
  useEffect(() => {
    if (liveFvs.length < 2) { setRetProposal(null); return; }
    // Las casillas van por partida (l.id); la factura a la que abona se decide
    // por producto (Decisión 52): dos partidas del mismo producto se suman antes
    // de preguntar cuál factura cubre todo — no se evalúan por separado.
    const porProducto = new Map<number, number>();
    for (const l of sold) {
      const q = retQty[l.id] ?? 0;
      if (q > 0) porProducto.set(l.product_id, (porProducto.get(l.product_id) ?? 0) + q);
    }
    const lines = [...porProducto].map(([productId, qty]) => ({ productId, qty }));
    let alive = true;
    void returnProposal({ data: { soId: id, lines } })
      .then((r) => { if (!alive) return; setRetProposal(r); setRetFv((cur) => (cur != null && r.invoices.some((i) => i.id === cur) ? cur : r.proposedId)); })
      .catch(() => { if (alive) setRetProposal(null); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, liveFvs.length, JSON.stringify(retQty)]);
  useEffect(() => {
    void load().catch((e) => setError(e instanceof Error ? e.message : "Error"));
  }, [id]);

  const locked = state !== "draft";
  const editable = canEdit && state === "draft";

  async function persist(confirm: boolean) {
    if (!form) return;
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const dues = duesPreview(form);
      if (dues) {
        const chk = validateDueDates({
          issue: form.date,
          due: dues.creditDue,
          invoiceDue: dues.invoiceDue,
          days: form.termKind === "credit_days" ? dues.creditDays : undefined,
          allowPast: true,
        });
        if (!chk.ok) {
          setError(chk.errors[0] ?? "Revisa las fechas de vencimiento");
          return;
        }
      }
      await saveOrder({ data: { ...form, id, confirm, overrideCredit, circuitCode: circuitOverride ?? undefined } });
      setMsg(confirm ? "Pedido confirmado" : "Guardado");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar");
    } finally {
      setBusy(false);
    }
  }

  async function applyTerm() {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const r = await changeOrderTerm({ data: { id, creditDays: newDays } });
      setMsg(
        r.creditDays > 0
          ? `Plazo cambiado a ${r.creditDays} d. Precios rehechos con el financiamiento a ese plazo; total ${money(r.total)}. Quedó en bitácora.`
          : `Pedido pasado a contado: precios de contado de la cotización; total ${money(r.total)}. Quedó en bitácora.`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cambiar el plazo");
    } finally {
      setBusy(false);
    }
  }

  // Paso 3: entregar (cantidad por partida, o todo lo pendiente). En bodega
  // propia NO factura (Decisión 47): la FV se emite por entrega, abajo. En
  // directo/brokeraje sí, en el mismo acto (Decisión 29).
  async function deliverLines(recvLines?: Array<{ lineId: number; qty: number }>) {
    setError(null);
    setMsg(null);
    const r = await deliverSale({ data: recvLines ? { soId: id, lines: recvLines } : { soId: id } });
    setMsg(
      r.fv
        ? `Entregado y facturado (${r.fv}) — directo, en el mismo acto.`
        : `Entregado (${r.eventRef})${r.done ? ", pedido completo" : ", queda pendiente"} — falta facturar esta entrega.`,
    );
    await load();
  }

  async function invoiceEvent(eventRef: string) {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const r = await invoiceDelivery({ data: { soId: id, eventRef } });
      setMsg(`${r.fv} emitida por la entrega ${eventRef}: su plazo corre desde la fecha de esa entrega.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo facturar");
    } finally {
      setBusy(false);
    }
  }

  if (!form || !lookups) {
    return <p className="text-sm text-muted">{error ?? "Cargando ficha…"}</p>;
  }

  return (
    <form
      className="p-5"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (editable) void persist(false);
      }}
    >
      <BackBar to="/sales" label="Pedidos de venta" search={{ tab: "todos", q: "" }} />
      <Expediente kind="sale" id={id} onLine={setTrail} />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          {form.name}
          <span className="erp-chip">{state === "confirmed" && sold.some((l) => num(l.qty_delivered) > 0.0001) ? "Entregado parcial" : state === "done" && closedShort.at ? "Entregado (cerrado corto)" : stateLabel(state)}</span>
        </h1>
        <div className="flex flex-wrap gap-2">
          <Link to="/sales" search={{ tab: "todos", q: "" }} className="erp-btn grid place-items-center">
            Pedidos
          </Link>
          {editable && (
            <>
              <button className="erp-btn" disabled={busy} type="submit">
                Guardar
              </button>
              <button className="erp-btn-primary" disabled={busy} type="button" onClick={() => void persist(true)}>
                Confirmar
              </button>
              <CancelButton
                title="el pedido"
                number={form.name}
                summary={[
                  `Cliente: ${lookups?.customers.find((c) => c.id === form.partnerId)?.name || ""}`,
                  `Total: ${moneyIn(form.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0), form.currency)}`,
                  ...sold.map((l) => `${l.code} ${l.name} ×${l.qty} ${l.uom}`),
                ]}
                onConfirm={(reason) => cancelOrder({ data: { soId: id, reason } })}
                onDone={() => navigate({ to: "/sales", search: { tab: "todos", q: "" } })}
              />
            </>
          )}
          {canDeliver && state === "confirmed" && (
            <PartialQtyDialog
              primary
              buttonLabel={form.routeKind !== "own" ? "Entregar y facturar (directo)" : "Entregar"}
              title={`Entregar ${form.name}`}
              hint={
                form.routeKind !== "own"
                  ? canEdit
                    ? "Directo / brokeraje: no pasa por bodega Azagro. Cada entrega nace con su factura y con la deuda al proveedor, en el mismo acto."
                    : "Directo / brokeraje: entregar factura al cliente en el mismo acto (Decisión 29), así que hace falta permiso para facturar (editar en Ventas). Pide que alguien con ese permiso confirme la entrega."
                  : "Cantidad por partida. Deja en 0 la que todavía no sale. La factura de esta entrega se emite después, desde el panel de entregas."
              }
              allLabel="Entregar todo lo pendiente"
              confirmLabel="Entregar lo capturado"
              busyLabel="Entregando…"
              disabled={busy || (form.routeKind !== "own" && !canEdit)}
              pending={sold
                .filter((l) => num(l.qty) - num(l.qty_delivered) > 0.0001 + num(l.qty_closed_short ?? 0))
                .map((l) => ({ lineId: l.id, product: `${l.code} ${l.name}`, uom: l.uom, pending: num(l.qty) - num(l.qty_delivered) - num(l.qty_closed_short ?? 0) }))}
              onConfirm={deliverLines}
            />
          )}
          {canEdit && state === "confirmed" && (
            <>
              <CancelChainButton
                title="el pedido"
                number={form.name}
                label="Cancelar pedido"
                load={() => cancelChainPreview({ data: { kind: "sale", id } })}
                onConfirm={(reason) => cancelSalesOrderChain({ data: { soId: id, reason } })}
                onDone={() => navigate({ to: "/sales", search: { tab: "todos", q: "" } })}
              />
            </>
          )}
          {(role === "admin" || role === "gerencia") && state === "confirmed" && sold.some((l) => num(l.qty_delivered) > 0.0001) && sold.some((l) => num(l.qty) - num(l.qty_delivered) > 0.0001 + num(l.qty_closed_short ?? 0)) && (
            <CloseShortButton
              kind="sale"
              title="el pedido"
              number={form.name}
              pending={sold
                .filter((l) => num(l.qty) - num(l.qty_delivered) > 0.0001 + num(l.qty_closed_short ?? 0))
                .map((l) => ({ product: `${l.code} ${l.name}`, uom: l.uom, pending: num(l.qty) - num(l.qty_delivered) - num(l.qty_closed_short ?? 0) }))}
              onConfirm={(reason) => closeShortSale({ data: { soId: id, reason } })}
              onDone={load}
            />
          )}
          {canEdit && state === "done" && (
            <DeliveryReversalButton
              soName={form.name}
              load={() => deliveryReversalPreview({ data: { soId: id } })}
              onConfirm={(reason) => reverseDelivery({ data: { soId: id, reason } })}
              onDone={load}
            />
          )}
          {canEdit && state === "done" && !receivedAt && (
            <button
              className="erp-btn-primary"
              disabled={busy}
              type="button"
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await markReceived({ data: { soId: id } });
                  setMsg("Cliente recibió en destino");
                  await load();
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Error");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Marcar recibido
            </button>
          )}
          {receivedAt ? <span className="erp-chip">Recibido {receivedAt}</span> : null}
          <button className="erp-btn" type="button" onClick={() => setPrintGuia(true)}>
            Guía de carga
          </button>
          <button
            type="button"
            className="erp-btn"
            onClick={() =>
              printHtml(
                form.name,
                letterhead({
                  logoSrc: logoSrc(),
                  legalName: "AZ INSUMOS AGRICOLAS SA DE CV",
                  title: "Pedido de venta",
                  number: form.name,
                  partyLabel: "Cliente",
                  party: lookups.customers.find((c) => c.id === form.partnerId)?.name || "",
                  meta: [
                    form.currency === "USD" ? `USD · dólar pactado ${form.fxRate}` : "MXN",
                    form.termKind === "contado" ? "Contado" : `Crédito ${form.creditDays} d`,
                    form.deliveryTo ? `Entrega ${form.deliveryTo}` : "",
                  ],
                  rows: form.lines.map((ln) => {
                    const prod = lookups.products.find((p) => p.id === ln.productId);
                    return {
                      left: prod ? `${prod.code} — ${prod.name}` : String(ln.productId),
                      qty: `${ln.qty} ${ln.uom}`,
                      unit: moneyIn(ln.unitPrice, form.currency),
                      amount: moneyIn(ln.qty * ln.unitPrice, form.currency),
                    };
                  }),
                  total: moneyIn(form.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0), form.currency),
                }),
                {
                  module: "sales",
                  title: "Pedido de venta",
                  number: form.name,
                  party: lookups.customers.find((c) => c.id === form.partnerId)?.name || "",
                  partnerId: form.partnerId,
                },
              )
            }
          >
            Documento
          </button>
          <SendButton
            module="sales"
            title="Pedido de venta"
            number={form.name}
            party={lookups.customers.find((c) => c.id === form.partnerId)?.name || ""}
            partnerId={form.partnerId}
            total={form.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0)}
            currency={form.currency}
            fxRate={form.fxRate}
            extra={[form.deliveryTo ? `Entrega: ${form.deliveryTo}` : "", expedienteFor(trail, "cliente")].filter(Boolean).join("\n")}
            lines={form.lines.map((ln) => {
              const prod = lookups.products.find((p) => p.id === ln.productId);
              return { qty: ln.qty, uom: ln.uom, name: prod ? `${prod.code} ${prod.name}` : String(ln.productId), unitPrice: ln.unitPrice };
            })}
          />
        </div>
      </div>
      {events.length > 0 && (
        <div className="mb-3 erp-card p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Entregas</p>
          <ul className="mt-1 divide-y divide-line text-[13px]">
            {events.map((e) => {
              // BLOQUE DE PARCIALES, paso 4, mitad B: revertir UNA entrega, no
              // el pedido completo. El botón de siempre (arriba, "Revertir
              // entrega") ya cubre el único caso que no necesita esto: un solo
              // evento, el pedido ya `done` y la entrega FACTURADA (ese camino
              // exige factura viva). En todo lo demás — 2+ eventos, pedido
              // todavía pendiente, o entrega sin facturar (Decisión 47) — solo
              // este botón llega. (Paso 7: un pedido entregado sin facturar no
              // tenía cómo revertirse; candado sin salida, cerrado aquí.)
              const showRevert = canEdit && !e.reversed && (events.length > 1 || state !== "done" || !e.fv);
              return (
                <li key={e.eventRef} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                  <span>
                    <span className="font-medium">{e.eventRef}</span> · {e.date} ·{" "}
                    {e.lines.map((l) => `${l.code} ${l.qty} ${l.uom}`).join(", ")}
                    {e.reversed ? <span className="ml-2 text-muted">revertida</span> : null}
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    {e.fv ? (
                      <span className="erp-chip">{e.fv}</span>
                    ) : e.reversed ? null : canEdit && form.routeKind === "own" ? (
                      <button type="button" className="erp-btn h-8 text-[12px]" disabled={busy} onClick={() => void invoiceEvent(e.eventRef)}>
                        Facturar esta entrega
                      </button>
                    ) : (
                      <span className="text-[12px] text-warn">Sin facturar</span>
                    )}
                    {showRevert ? (
                      <DeliveryReversalButton
                        soName={form.name}
                        label={`Revertir ${e.eventRef}`}
                        load={() => deliveryEventReversalPreview({ data: { soId: id, eventRef: e.eventRef } })}
                        onConfirm={(reason) => reverseDeliveryEvent({ data: { soId: id, eventRef: e.eventRef, reason } })}
                        onDone={load}
                      />
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {state === "cancelled" ? (
        <p className="mb-3 rounded-md border border-line bg-cream px-3 py-2 text-[12px] text-ink-soft">
          Cancelado{cancelledAt ? ` el ${cancelledAt.slice(0, 10)}` : ""}
          {cancelReason ? ` · Motivo: ${cancelReason}` : ""}
        </p>
      ) : null}
      {closedShort.at ? (
        <p className="mb-3 rounded-md border border-line bg-cream px-3 py-2 text-[12px] text-ink-soft">
          Cerrado corto el {closedShort.at.slice(0, 10)}: lo pendiente ya no va a salir; lo entregado y facturado queda como está.
          {closedShort.reason ? ` · Motivo: ${closedShort.reason}` : ""}
        </p>
      ) : null}
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      {role === "admin" && error?.includes("límite de crédito") && (
        <label className="mb-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={overrideCredit}
            onChange={(e) => setOverrideCredit(e.target.checked)}
          />
          Autorizo exceder el límite de crédito (queda en bitácora)
        </label>
      )}
      {msg && <p className="mb-3 text-sm text-ok">{msg}</p>}
      <OrderFields
        form={form}
        setForm={setForm}
        lookups={lookups}
        locked={locked}
        circuit={
          circuit === undefined
            ? undefined
            : {
                value: circuitOverride ?? inheritCircuit(circuit, form.creditDays),
                editable: !origin && isAdmin && editable,
                onChange: (code) => setCircuitOverride(code),
              }
        }
        inherited={
          origin
            ? {
                quoteName: origin.quote_name,
                requestName: origin.request_name,
                days: form.creditDays,
                offer: origin.accepted_offer === "cash" || origin.accepted_offer === "credit" ? origin.accepted_offer : null,
                onChange: editable ? () => setChangeTerm((v) => !v) : undefined,
                // La partida nueva se captura en la cotización (revisión), no aquí.
                onAddLine: editable ? () => void navigate({ to: "/quotes", search: { ver: origin.quote_id } }) : undefined,
              }
            : null
        }
      />
      {origin && changeTerm && editable && (
        <div className="mt-4 erp-card border-warn p-4">
          <h2 className="text-sm font-semibold">Cambiar el plazo de {form.name}</h2>
          <p className="mt-1 text-[12px] text-muted">
            El precio de cada partida se armó con el plazo de {origin.quote_name} ({origin.credit_days} d). Con otro plazo ese precio ya no
            corresponde: se rehace partida por partida con la misma fórmula (costo puesto + margen crédito + financiamiento a los días nuevos,
            con la TIIE y el spread de la cotización). A 0 días queda el precio de contado. El vencimiento de factura y el plazo financiero se
            recalculan y todo queda en bitácora, anterior → nuevo.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-[12px] font-medium uppercase tracking-wide text-muted">
              Días de crédito nuevos
              <input
                className="erp-input w-32"
                type="number"
                min={0}
                value={newDays}
                onChange={(e) => setNewDays(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
              />
            </label>
            <button type="button" className="erp-btn-primary" disabled={busy || newDays === form.creditDays} onClick={() => void applyTerm()}>
              Aplicar plazo y rehacer precios
            </button>
            <button type="button" className="erp-btn" disabled={busy} onClick={() => setChangeTerm(false)}>
              Cancelar
            </button>
          </div>
        </div>
      )}
      {origin && originLines.some((l) => l.origin) && (
        <div className="mt-4 overflow-x-auto erp-card">
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 pt-3">
            <h2 className="text-sm font-semibold">Heredado de {origin.quote_name}</h2>
            <p className="text-[12px] text-muted">
              Precio {OFFER_LABEL[origin.accepted_offer === "cash" ? "cash" : "credit"]}
              {origin.accepted_offer !== "cash" && form.creditDays > 0 ? ` a ${form.creditDays} d` : ""}
              {origin.request_name ? ` · ${origin.request_name} → ${origin.quote_name} → ${form.name}` : ` · ${origin.quote_name} → ${form.name}`}
            </p>
          </div>
          <table className="w-full min-w-[720px] text-left text-[13px]">
            <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Producto</th>
                <th className="px-3 py-2 text-right font-medium">Precio cotizado</th>
                <th className="px-3 py-2 text-right font-medium">Precio pedido</th>
                <th className="px-3 py-2 text-right font-medium">Costo puesto</th>
                <th className="px-3 py-2 text-right font-medium">Financiamiento</th>
                <th className="px-3 py-2 text-right font-medium">Utilidad u.</th>
                <th className="px-3 py-2 text-right font-medium">Margen (s/ precio)</th>
              </tr>
            </thead>
            <tbody>
              {originLines.map((l) => {
                const o = l.origin;
                if (!o) return null;
                // Precio, costo puesto y financiamiento en la moneda del pedido (guardados en pesos).
                const shO = (n: number | string) => salePriceShown(n, form.currency, form.fxRate);
                // l.unit_price ya viene convertido (d.lines, arriba); lo del origen (cotización) sigue en pesos.
                const unit = num(l.unit_price);
                const quoted = shO(o.quoted_price);
                const landedO = o.landed != null ? shO(o.landed) : null;
                const finO = shO(o.fin_unit);
                const util = landedO != null ? unit - landedO - finO : null;
                return (
                  <tr key={l.product_id} className="border-t border-line">
                    <td className="px-3 py-2">
                      <span className="font-medium">{l.name}</span>
                      <span className="ml-2 font-mono text-[11px] text-muted">{l.code}</span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{moneyIn(quoted, form.currency)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {moneyIn(unit, form.currency)}
                      {Math.abs(unit - quoted) > 0.009 ? <span className="ml-1 text-[11px] text-warn">≠ cotizado</span> : null}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{landedO != null ? moneyIn(landedO, form.currency) : "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{o.which === "credit" ? moneyIn(finO, form.currency) : "—"}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${util != null && util < 0 ? "text-danger" : ""}`}>
                      {util != null ? moneyIn(util, form.currency) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {o.margin ? (
                        <>
                          {o.margin.mode === "nominal" ? `${moneyIn(shO(o.margin.nominal), form.currency)} fijo` : marginText(o.margin)}
                          {o.margin.source === "migracion" ? <span className="block text-[11px] text-muted">de la migración</span> : null}
                        </>
                      ) : (
                        <span className="text-warn">{SIN_MARGEN}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {pnl && (
        <div className="mt-4">
          {pnl.multi ? (
            <div className="mb-3 overflow-x-auto erp-card">
              <p className="px-3 pt-2 text-[12px] text-muted">
                Este pedido tiene {pnl.invoices.length} factura{pnl.invoices.length === 1 ? "" : "s"}: la utilidad de abajo es la suma factura por factura — cada una con sus propios
                días, su propia TIIE y solo lo que salió en esa entrega (Decisión 61). Gastos y mora del pedido, una sola vez.
                {pnl.uninvoiced.length ? ` Sin facturar todavía (fuera del cálculo): ${pnl.uninvoiced.map((u) => `${u.code} ${u.qty} ${u.uom}`).join(", ")}.` : ""}
              </p>
              <table className="w-full min-w-[720px] text-left text-[12px]">
                <thead className="text-[11px] uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-3 py-1 font-medium">Factura</th>
                    <th className="px-3 py-1 font-medium">Emitida</th>
                    <th className="px-3 py-1 text-right font-medium">Días</th>
                    <th className="px-3 py-1 text-right font-medium">TIIE</th>
                    <th className="px-3 py-1 text-right font-medium">{pnl.financingBase === "costo_margen" ? "A Santa Rosa" : "Venta"}</th>
                    <th className="px-3 py-1 text-right font-medium">Costo fin.</th>
                    <th className="px-3 py-1 text-right font-medium">Cobrado</th>
                    <th className="px-3 py-1 text-right font-medium">Utilidad</th>
                  </tr>
                </thead>
                <tbody>
                  {pnl.invoices.map((i) => (
                    <tr key={i.id} className="border-t border-line">
                      <td className="px-3 py-1 font-medium">{i.name}{i.eventRef ? <span className="ml-1 text-muted">· {i.eventRef}</span> : null}</td>
                      <td className="px-3 py-1">{i.date}</td>
                      <td className="px-3 py-1 text-right tabular-nums">{i.financialDays}{i.daysExceeded > 0 ? ` +${i.daysExceeded} exc.` : ""}</td>
                      <td className="px-3 py-1 text-right tabular-nums">{i.tiieIssue != null ? pctDe(i.tiieIssue) : "—"}</td>
                      <td className="px-3 py-1 text-right tabular-nums">{money(i.revenue)}</td>
                      <td className="px-3 py-1 text-right tabular-nums">{money(pnl.financingBase === "costo_margen" ? i.financierFinance : i.finance)}</td>
                      <td className="px-3 py-1 text-right tabular-nums">{money(i.amount - i.residual)} / {money(i.amount)}</td>
                      <td className={`px-3 py-1 text-right tabular-nums ${i.netProfit < 0 ? "text-danger" : ""}`}>{money(i.netProfit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            <PnlKpi
              label={pnl.financingBase === "costo_margen" ? "Factura a Santa Rosa" : "Venta"}
              value={money(pnl.revenue)}
              hint={pnl.financingBase === "costo_margen" ? `Costo + margen (lo que Santa Rosa desembolsa). Precio al cliente ${money(pnl.clientPrice)}.` : undefined}
            />
            <PnlKpi label="Costo mercancía" value={money(pnl.cogs)} hint="OC, si no cotización, si no catálogo" />
            <PnlKpi label="Flete / sobre pedido" value={money(pnl.freight)} />
            <PnlKpi
              label="Margen operación"
              value={money(pnl.margin)}
              hint={pnl.financingBase === "costo_margen" ? `${pnl.marginPct.toFixed(1)}% sobre la factura a Santa Rosa` : `${pnl.marginPct.toFixed(1)}% sobre venta`}
            />
            <PnlKpi
              label={pnl.financingBase === "costo_margen" ? "Financiamiento de Santa Rosa" : "Costo financiero"}
              value={money(pnl.financingBase === "costo_margen" ? pnl.financierFinance : pnl.finance)}
              hint={
                pnl.financingBase === "costo_margen"
                  ? `Base: la factura de Azagro a Santa Rosa ${money(pnl.disbursed)} (costo + margen), por ${pnl.financialDays} d. Lo paga el cliente a Santa Rosa; no es costo de Azagro. ${
                      pnl.lineCost != null && pnl.protection != null && pnl.costRate != null && pnl.collectionRate != null
                        ? `Desglose: costo real de la línea ${money(pnl.lineCost)} (tasa de costo ${pctDe(pnl.costRate)} + spread ${pctDe(pnl.spread)}) + protección ${money(pnl.protection)} (${pctDe(pnl.collectionRate - pnl.costRate)} de diferencia entre la tasa de cobro y la de costo).`
                        : "Sin tasa de costo congelada: la protección no se estima."
                    }`
                  : pnl.tiieIssue == null
                    ? `Sin TIIE en la tabla para la emisión (${pnl.tiieDate ?? "sin fecha"}): el costo financiero no se calcula ni se estima.`
                    : `Base: el costo puesto ${money(pnl.financeBase)} (mercancía + flete) × (1 + comisión del circuito), la misma que el precio. Comisión ${money(pnl.commission)} + Capa 1 (${pnl.financialDays} d del pedido) ${money(pnl.layer1)} + Capa 2 (${pnl.daysExceeded} d exc.) ${money(pnl.layer2)}. Una sola tasa (TIIE ${pctDe(pnl.tiieIssue)} + spread ${pctDe(pnl.spread)}): el costo real es este mismo, protección ${money(0)}.`
              }
            />
            <PnlKpi
              label="Utilidad final"
              value={money(pnl.netProfit)}
              hint={`${pnl.netProfitPct.toFixed(1)}% · ≈ el margen elegido: el financiamiento cobrado en el precio se netea contra el pagado. Solo restan de verdad la Capa 2 y el pronto pago; la mora suma.`}
            />
          </div>
          {pnl.excluded.n > 0 && (
            <p className="mt-2 rounded-md border border-warn bg-cream px-3 py-2 text-[12px] text-warn">
              {pnl.excluded.n} partida(s) fuera del cálculo de utilidad (venta {money(pnl.excluded.venta)}): {pnl.excluded.motivos.join("; ")}. No se les inventa costo ni tasa; los totales de arriba solo suman las partidas con dato.
            </p>
          )}
          {(pnl.mora > 0 || pnl.discount > 0 || pnl.fxIncome !== 0 || pnl.fxSpread !== 0) && (
            <p className="mt-2 text-[12px] text-muted">
              {pnl.mora > 0 ? `Mora facturada: ${money(pnl.mora)} (entra como ingreso). ` : ""}
              {pnl.discount > 0 ? `Descuento pronto pago: ${money(pnl.discount)}. ` : ""}
              {pnl.fxIncome !== 0 ? `Diferencial cambiario: ${money(pnl.fxIncome)}. ` : ""}
              {pnl.fxSpread !== 0 ? `De ese margen, ${money(pnl.fxSpread)} viene del tipo de cambio: el pactado con el cliente contra el de la orden al proveedor.` : ""}
            </p>
          )}
          <div className="mt-3 overflow-x-auto erp-card">
            <table className="w-full min-w-[860px] text-left text-[13px]">
              <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Producto</th>
                  <th className="px-3 py-2 text-right font-medium">Cant.</th>
                  <th className="px-3 py-2 text-right font-medium">P. venta</th>
                  <th className="px-3 py-2 text-right font-medium">Costo u.</th>
                  <th className="px-3 py-2 font-medium">Fuente</th>
                  <th className="px-3 py-2 text-right font-medium">Flete</th>
                  <th className="px-3 py-2 text-right font-medium">Margen</th>
                </tr>
              </thead>
              <tbody>
                {pnl.lines.map((l) => (
                  <tr key={l.productId} className={`border-t border-line ${l.excluded ? "text-warn" : ""}`}>
                    <td className="px-3 py-2">
                      <span className="font-medium">{l.name}</span>
                      <span className="ml-2 font-mono text-[11px] text-muted">{l.code}</span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{l.qty} {l.uom}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(l.sale)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{l.excluded ? "—" : money(l.costUnit)}</td>
                    <td className="px-3 py-2 text-muted">{l.excluded ? `excluida: ${l.excludeReason}` : l.costSource}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{l.excluded ? "—" : money(l.freight)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {l.excluded ? "—" : money(l.margin)}
                      {l.excluded ? null : <span className="ml-1 text-[11px] text-muted">{l.marginPct.toFixed(1)}%</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pnl.expenses.length > 0 && (
            <ul className="mt-2 text-[13px] text-muted">
              {pnl.expenses.map((e) => (
                <li key={e.id}>
                  Gasto {e.class}: {e.name} · {money(e.amount)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {purchases.length > 0 && (
        <div className="mt-4 erp-card p-4">
          <h2 className="mb-2 text-sm font-semibold">Órdenes de compra de esta operación</h2>
          <p className="mb-2 text-[12px] text-muted">Interno. El cliente no ve al proveedor. Inventario se recibe; directo va en camino.</p>
          <ul className="text-sm">
            {purchases.map((po) => (
              <li key={po.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-line py-2 first:border-0">
                <span>
                  {po.name} · {po.partner} · {money(po.total)}
                  <span className="ml-2">
                    <StatusPill tone={po.state === "done" ? "ok" : po.state === "cancelled" ? "muted" : "warn"}>
                      {po.fulfill_kind === "direct"
                        ? "Directo"
                        : po.state === "done"
                          ? "Recibida"
                          : po.state === "cancelled"
                            ? "Cancelada"
                            : "Por recibir"}
                    </StatusPill>
                  </span>
                </span>
                {canDeliver && canReceive && po.state !== "done" && po.state !== "cancelled" && po.fulfill_kind !== "direct" && (
                  <button
                    type="button"
                    className="erp-btn h-8 text-[12px]"
                    onClick={async () => {
                      try {
                        await receivePurchase({ data: { poId: po.id } });
                        setMsg(`${po.name} recibida`);
                        await load();
                      } catch (err) {
                        setError(err instanceof Error ? err.message : "Error");
                      }
                    }}
                  >
                    Recibir
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {invoices.length > 0 && (
        <div className="mt-4 erp-card p-4">
          <h2 className="mb-2 text-sm font-semibold">Facturas de este pedido</h2>
          <ul className="text-sm">
            {invoices.map((inv) => (
              <li key={inv.id} className="flex justify-between border-t border-line py-2 first:border-0">
                <span>
                  {inv.name} · vence {fmtDate(inv.due_date)}
                </span>
                <span className="flex items-center gap-2 tabular-nums">
                  {moneyIn(salePriceShown(inv.residual, form.currency, form.fxRate), form.currency)} · {inv.state}
                  {canEdit && inv.name.startsWith("NC-") && !inv.reverses_id && inv.state !== "reversed" ? (
                    <ReturnReversalButton
                      ncName={inv.name}
                      load={() => returnReversalPreview({ data: { ncId: inv.id } })}
                      onConfirm={(reason) => reverseReturn({ data: { ncId: inv.id, reason } })}
                      onDone={load}
                    />
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {canEdit && (state === "done" || state === "confirmed") && sold.some((l) => num(l.qty_delivered) - num(l.qty_returned) > 0.0001) && (
        <div className="mt-4 erp-card p-4">
          <h2 className="mb-1 text-sm font-semibold">Devolución del cliente</h2>
          <p className="mb-3 text-[12px] text-muted">
            La mercancía vuelve a la bodega de este pedido (kardex DEV). Se emite nota de crédito y baja el saldo de la FV si sigue abierta.
            Pedido directo: no hay movimiento en bodega Azagro, solo la NC.
            {state === "confirmed" ? " El pedido sigue por entregar: se devuelve solo lo ya entregado." : ""}
          </p>
          <table className="w-full min-w-[520px] text-left text-[13px]">
            <thead className="text-[11px] uppercase tracking-wide text-muted">
              <tr>
                <th className="py-1 font-medium">Producto</th>
                <th className="py-1 text-right font-medium">Entregado</th>
                <th className="py-1 text-right font-medium">Ya devuelto</th>
                <th className="py-1 text-right font-medium">A devolver</th>
              </tr>
            </thead>
            <tbody>
              {sold.map((l) => {
                const max = Math.max(0, num(l.qty_delivered) - num(l.qty_returned));
                return (
                  <tr key={l.id} className="border-t border-line">
                    <td className="py-2">
                      <span className="font-medium">{l.name}</span>
                      <span className="ml-2 font-mono text-[11px] text-muted">{l.code}</span>
                      <span className="ml-2 text-[11px] text-muted">{moneyIn(num(l.unit_price), form.currency)}</span>
                    </td>
                    <td className="py-2 text-right tabular-nums">{qty(l.qty_delivered)} {l.uom}</td>
                    <td className="py-2 text-right tabular-nums">{qty(l.qty_returned)}</td>
                    <td className="py-2 text-right">
                      <QtyField
                        value={retQty[l.id] ?? 0}
                        onChange={(n) => setRetQty((p) => ({ ...p, [l.id]: Math.min(max, Math.max(0, n)) }))}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {liveFvs.length > 1 ? (
            <label className="mt-3 grid gap-1 text-[12px] font-medium uppercase tracking-wide text-muted">
              Abonar a la factura
              <select className="erp-input" value={retFv ?? ""} onChange={(e) => setRetFv(e.target.value ? Number(e.target.value) : null)}>
                <option value="">— elige —</option>
                {(retProposal?.invoices ?? liveFvs.map((i) => ({ id: i.id, name: i.name, date: "", residual: num(i.residual), eventRef: null as string | null, lines: [] as Array<{ productId: number; available: number }> }))).map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                    {i.eventRef ? ` · ${i.eventRef}` : ""}
                    {` · ${i.residual > 0.009 ? `saldo ${moneyIn(salePriceShown(i.residual, form.currency, form.fxRate), form.currency)}` : "pagada: el crédito quedaría abierto, no bajaría saldo"}`}
                    {retProposal ? ` · por devolver ${i.lines.map((l) => { const p = sold.find((x) => x.product_id === l.productId); return `${p?.code ?? l.productId} ${l.available}`; }).join(", ") || "nada"}` : ""}
                    {retProposal?.proposedId === i.id ? " · propuesta: aquí viajó lo que se devuelve" : ""}
                  </option>
                ))}
              </select>
              <span className="normal-case tracking-normal">
                {retProposal?.note
                  ? retProposal.note
                  : retProposal?.proposedId != null
                    ? "El sistema propone la factura donde viajó el producto (Decisión 52); puedes cambiarla."
                    : "Indica cuánto se devuelve y el sistema propone la factura donde viajó."}
              </span>
            </label>
          ) : null}
          <label className="mt-3 grid gap-1 text-[12px] font-medium uppercase tracking-wide text-muted">
            Motivo
            <input className="erp-input" value={retReason} onChange={(e) => setRetReason(e.target.value)} placeholder="Daño, error de surtido, no ocupó…" />
          </label>
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              className="erp-btn"
              disabled={busy}
              onClick={async () => {
                const lines = sold
                  .map((l) => ({ lineId: l.id, qty: retQty[l.id] ?? 0 }))
                  .filter((l) => l.qty > 0);
                if (!lines.length) {
                  setError("Indica cuánto se devuelve en al menos una partida");
                  return;
                }
                if (liveFvs.length > 1 && retFv == null) {
                  setError("Este pedido tiene varias facturas: elige a cuál abona la devolución.");
                  return;
                }
                setBusy(true);
                setError(null);
                try {
                  const r = await returnSale({ data: { soId: id, reason: retReason, lines, fvId: liveFvs.length > 1 ? (retFv ?? undefined) : undefined } });
                  const stock = r.direct ? "Sin movimiento de kardex (pedido directo)." : `Kardex ${r.refs.join(", ")}.`;
                  const cobro = r.applied
                    ? `Se abonó ${moneyIn(salePriceShown(r.applied, form.currency, form.fxRate), form.currency)} a ${r.fv ?? "la factura"}.`
                    : r.leftover
                      ? `${r.fv ? `${r.fv} ya estaba pagada` : "No hay factura viva a la que abonar"}. Queda crédito ${r.nc} por ${moneyIn(salePriceShown(r.leftover, form.currency, form.fxRate), form.currency)}.`
                      : "";
                  // Decisión 9 + Decisión 20: con qué costo entró cada partida
                  // y cómo quedó el promedio, con el número. Y si no se
                  // encontró la salida, se dice completo — no se disimula.
                  const costo = (r.costs ?? [])
                    .map((c) => {
                      const p = sold.find((s) => s.product_id === c.productId);
                      const nombre = p ? `${p.code}` : `#${c.productId}`;
                      const promedio = `promedio ${money(c.avgBefore)} → ${money(c.avgAfter)}`;
                      return c.found
                        ? `${nombre}: entró al costo con el que salió (${money(c.unitCost)}); ${promedio}.`
                        : `${nombre}: NO encontré con qué costo salió de ${form.name}; entró al promedio de hoy (${money(c.unitCost)}); ${promedio}.`;
                    })
                    .join(" ");
                  setMsg(`Devolución ${r.nc}. ${stock} ${cobro} ${costo}`.trim());
                  setRetQty({});
                  setRetReason("");
                  setRetFv(null);
                  await load();
                } catch (err) {
                  setError(err instanceof Error ? err.message : "No se pudo devolver");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Registrar devolución
            </button>
          </div>
        </div>
      )}
      <DocFiles kind="sale" entityId={id} />
      {printGuia && form && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-4 print:static print:bg-transparent print:p-0">
          <div className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-xl border border-line bg-cream p-6 shadow-xl print:max-h-none print:w-full print:max-w-none print:rounded-none print:border-0 print:shadow-none">
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold tracking-[0.16em] text-forest">AZ INSUMOS AGRICOLAS SA DE CV</p>
                <h2 className="mt-1 text-lg font-semibold">Guía de carga</h2>
              </div>
              <div className="text-right">
                <p className="text-[11px] uppercase tracking-wide text-muted">Folio</p>
                <p className="text-lg font-semibold">{form.name}</p>
              </div>
            </div>
            <p className="mt-1 text-sm text-muted">El fletero presenta este papel en la entrega. Recibe lleva la firma de quien recibe.</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 print:hidden">
              <label className="text-[11px] uppercase tracking-wide text-muted">
                Tipo de entrega
                <select className="erp-input mt-1 w-full" value={guia.mode} onChange={(e) => setGuia({ ...guia, mode: e.target.value as typeof guia.mode })}>
                  <option value="campo">Entrega en campo</option>
                  <option value="pickup">Cliente recolecta</option>
                  <option value="azagro">Azagro entrega</option>
                  <option value="proveedor">Entrega el proveedor</option>
                </select>
              </label>
              <label className="text-[11px] uppercase tracking-wide text-muted">
                Línea fletera
                <input className="erp-input mt-1 w-full" value={guia.fletero} onChange={(e) => setGuia({ ...guia, fletero: e.target.value })} />
              </label>
              <label className="text-[11px] uppercase tracking-wide text-muted">
                Chofer
                <input className="erp-input mt-1 w-full" value={guia.chofer} onChange={(e) => setGuia({ ...guia, chofer: e.target.value })} />
              </label>
              <label className="text-[11px] uppercase tracking-wide text-muted">
                Marca de carro
                <input className="erp-input mt-1 w-full" value={guia.vehicleBrand} onChange={(e) => setGuia({ ...guia, vehicleBrand: e.target.value })} />
              </label>
              <label className="text-[11px] uppercase tracking-wide text-muted">
                Placas
                <input className="erp-input mt-1 w-full" value={guia.placas} onChange={(e) => setGuia({ ...guia, placas: e.target.value })} />
              </label>
              <label className="text-[11px] uppercase tracking-wide text-muted">
                Origen
                <input className="erp-input mt-1 w-full" value={origen} onChange={(e) => setOrigen(e.target.value)} />
              </label>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
              <div>
                <dt className="text-[11px] uppercase text-muted">Fecha</dt>
                <dd className="font-medium">{dateDMY(form.date)}</dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase text-muted">Línea fletera</dt>
                <dd className="font-medium">{guia.fletero || "—"}</dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase text-muted">Cliente</dt>
                <dd className="font-medium">{lookups.customers.find((c) => c.id === form.partnerId)?.name || "—"}</dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase text-muted">Chofer</dt>
                <dd className="font-medium">{guia.chofer || "—"}</dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase text-muted">Origen</dt>
                <dd className="font-medium">{origen || "—"}</dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase text-muted">Marca de carro</dt>
                <dd className="font-medium">{guia.vehicleBrand || "—"}</dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase text-muted">Placas</dt>
                <dd className="font-medium">{guia.placas || "—"}</dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase text-muted">Destino</dt>
                <dd className="font-medium">{form.deliveryTo || "—"}</dd>
              </div>
            </dl>
            <table className="mt-4 w-full text-left text-sm">
              <thead className="text-[11px] uppercase text-muted">
                <tr>
                  <th className="py-1">Producto</th>
                  <th className="py-1 text-right">Cantidad</th>
                  <th className="py-1 text-right">Unidad</th>
                </tr>
              </thead>
              <tbody>
                {form.lines.map((ln, i) => {
                  const prod = lookups?.products.find((p) => p.id === ln.productId);
                  return (
                    <tr key={i} className="border-t border-line">
                      <td className="py-2">{prod ? `${prod.code} — ${prod.name}` : ln.productId}</td>
                      <td className="py-2 text-right tabular-nums">{qty(ln.qty)}</td>
                      <td className="py-2 text-right">{ln.uom}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-6 text-[12px] text-muted">Recibí de conformidad la mercancía en las cantidades indicadas.</p>
            <div className="mt-4 print:hidden">
              <label className="text-[11px] uppercase tracking-wide text-muted">
                Observaciones
                <textarea className="erp-input mt-1 w-full" rows={2} value={obs} onChange={(e) => setObs(e.target.value)} placeholder="Faltante, sello, condición…" />
              </label>
              <label className="mt-3 block text-[11px] uppercase tracking-wide text-muted">
                Quién recibe
                <input className="erp-input mt-1 w-full" value={signName} onChange={(e) => setSignName(e.target.value)} placeholder="Nombre de quien firma" />
              </label>
              <p className="mt-3 text-[11px] uppercase tracking-wide text-muted">Firma de quien recibe</p>
              <SignPad value={sign} onChange={setSign} />
            </div>
            {sign ? (
              <div className="mt-3">
                <p className="text-[11px] uppercase text-muted">Recibe · {signName || "Firma"}</p>
                <img src={sign} alt="Firma" className="mt-1 h-16 border border-line bg-white" />
              </div>
            ) : (
              <p className="mt-8 text-sm">Recibe: _____________________________</p>
            )}
            <div className="mt-5 flex justify-end gap-2 print:hidden">
              <button type="button" className="erp-btn" onClick={() => setPrintGuia(false)}>Cerrar</button>
              <button
                type="button"
                className="erp-btn-primary"
                onClick={async () => {
                  await saveGuia({
                    data: {
                      soId: id,
                      fletero: guia.fletero,
                      placas: guia.placas,
                      chofer: guia.chofer,
                      vehicleBrand: guia.vehicleBrand,
                      shipMode: guia.mode,
                      signature: sign,
                      signedName: signName,
                      observaciones: obs,
                    },
                  }).catch(() => null);
                  const cliente = lookups.customers.find((c) => c.id === form.partnerId)?.name || "";
                  printHtml(
                    `Guia ${form.name}`,
                    guiaSheet({
                      logoSrc: logoSrc(),
                      legalName: "AZ INSUMOS AGRICOLAS SA DE CV",
                      folio: form.name,
                      fecha: dateDMY(form.date),
                      cliente,
                      lineaFletera: guia.fletero,
                      chofer: guia.chofer,
                      marca: guia.vehicleBrand,
                      placas: guia.placas,
                      origen,
                      destino: form.deliveryTo,
                      // La guía ya lleva su folio; el fletero no ve la cadena de folios.
                      rows: form.lines.map((ln) => {
                        const prod = lookups?.products.find((p) => p.id === ln.productId);
                        return {
                          product: prod ? `${prod.code} — ${prod.name}` : String(ln.productId),
                          qty: qty(ln.qty),
                          uom: ln.uom,
                        };
                      }),
                      signature: sign,
                      signedName: signName,
                      observaciones: obs,
                    }),
                    {
                      module: "sales",
                      title: "Guía de carga",
                      number: form.name,
                      party: cliente,
                      partnerId: form.partnerId,
                      extra: [guia.fletero, guia.chofer, guia.vehicleBrand, guia.placas].filter(Boolean).join(" · "),
                    },
                  );
                }}
              >
                Imprimir / PDF
              </button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}

/** "6.90 %" a partir de una fracción (0.069). Solo texto de tarjeta. */
function pctDe(fraction: number) {
  return `${(fraction * 100).toFixed(2)} %`;
}

function PnlKpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <article className="erp-card p-4">
      <p className="text-[11px] uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
      {hint ? <p className="mt-1 text-[11px] leading-snug text-muted">{hint}</p> : null}
    </article>
  );
}

import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Plus, Trash2 } from "lucide-react";
import { Fragment, useEffect, useState, type FormEvent } from "react";
import { AppShell } from "@/components/app-shell";
import { HeadBox, StatusPill } from "@/components/erp";
import { OpsPipeline } from "@/components/pipeline";
import { MoneyField, QtyField, UomSelect } from "@/components/fields";
import { SearchSelect, asOpts } from "@/components/search-select";
import { SendButton } from "@/components/send-doc";
import { Expediente } from "@/components/expediente";
import { addDays } from "@/lib/erp/credit";
import { getDealTrail } from "@/lib/erp/deal";
import { OFFER_LABEL } from "@/lib/erp/margins";
import { createQuote, decideQuote, getSettings, listQuotes, reviseQuote } from "@/lib/erp/ops";
import { creditFromCash, type FinanceBase } from "@/lib/erp/pricing";
import { letterhead, logoSrc, printHtml } from "@/lib/print-doc";
import { listInventory } from "@/lib/azagro";
import { exportCsv } from "@/lib/export-csv";
import { dateDMY, humanError, moneyIn, num, qty, todayMx } from "@/lib/utils";

export const Route = createFileRoute("/quotes")({
  // ?ver=<id> abre esa cotización al entrar (ligas desde la solicitud y el pedido).
  validateSearch: (s: Record<string, unknown>): { ver?: number } => ({
    ver: typeof s.ver === "number" ? s.ver : typeof s.ver === "string" && s.ver ? Number(s.ver) : undefined,
  }),
  component: Page,
});

/** fin = base del financiamiento que manda el servidor (calculada con el costo real, igual para todos los roles). */
type Line = { productId: number; qty: number; cashPrice: number; creditPrice: number; uom: string; fin: FinanceBase };
const SIN_FIN: FinanceBase = { commission: 0, interestYear: 0 };
type Offer = "cash" | "credit" | "both";

function offerLabel(o: string) {
  return o === "cash" ? "Contado" : o === "credit" ? "Crédito" : "Contado y crédito";
}

function round4(n: number) {
  return Math.round(n * 10000) / 10000;
}

/**
 * Una columna de precio (contado o crédito) con captura inversa: se escribe el
 * precio, la utilidad o el margen %, y las otras dos se despejan al momento.
 *   utilidad = precio − costo puesto − financiamiento (0 al contado)
 *   margen % = utilidad / costo puesto
 * Sin costo visible (rol sin costos o partida sin costo) solo se captura el precio.
 * Utilidad negativa: se pinta en rojo y se avisa, no se bloquea.
 */
function OfferCells({
  price,
  landed,
  fin,
  cur,
  editable,
  onPrice,
}: {
  price: number;
  landed: number;
  fin: number;
  cur: string;
  editable: boolean;
  onPrice: (p: number) => void;
}) {
  const hasCost = landed > 0.009;
  const util = price - landed - fin;
  const pct = hasCost ? (util / landed) * 100 : 0;
  const neg = hasCost && util < -0.009;
  const tone = neg ? "text-danger" : "text-ok";
  return (
    <>
      <td className="py-1.5 text-right">
        {editable ? <MoneyField value={price} onChange={(p) => onPrice(round4(p))} /> : <span className="tabular-nums">{moneyIn(price, cur)}</span>}
      </td>
      <td className={`py-1.5 text-right tabular-nums ${tone}`}>
        {!hasCost ? (
          "—"
        ) : editable ? (
          <MoneyField className={`w-24 ${neg ? "text-danger" : ""}`} value={round4(util)} onChange={(u) => onPrice(round4(landed + fin + u))} />
        ) : (
          moneyIn(util, cur)
        )}
      </td>
      <td className={`py-1.5 text-right tabular-nums ${neg ? "text-danger" : ""}`}>
        {!hasCost ? (
          "—"
        ) : editable ? (
          <QtyField className={`w-20 ${neg ? "text-danger" : ""}`} value={Math.round(pct * 100) / 100} onChange={(m) => onPrice(round4(landed + fin + (landed * m) / 100))} />
        ) : (
          `${pct.toFixed(1)}%`
        )}
      </td>
    </>
  );
}

function Page() {
  const navigate = useNavigate();
  const [data, setData] = useState<Awaited<ReturnType<typeof listQuotes>> | null>(null);
  const [locs, setLocs] = useState<Array<{ id: number; name: string }>>([]);
  const [partnerId, setPartnerId] = useState(0);
  const [currency, setCurrency] = useState<"USD" | "MXN">("USD");
  const [fxRate, setFxRate] = useState(18);
  const [validUntil, setValidUntil] = useState(() => addDays(todayMx(), 15));
  const [priceOffer, setPriceOffer] = useState<Offer>("both");
  const [creditDays, setCreditDays] = useState(90);
  const [tiie, setTiie] = useState(0.0706);
  const [spread, setSpread] = useState(0.04);
  const [deliveryTo, setDeliveryTo] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [viewId, setViewId] = useState<number | null>(null);
  const [take, setTake] = useState<Record<number, number>>({});
  const [revPrices, setRevPrices] = useState<Record<number, { cash: number; credit: number; qty: number }>>({});
  const [locationId, setLocationId] = useState(0);
  const [fulfillKind, setFulfillKind] = useState<"inventory" | "direct">("inventory");

  // El financiamiento lo calcula el servidor sobre el costo real (línea.fin):
  // el precio a crédito es el mismo para cualquier rol, vea o no el costo.
  function syncCredit(ls: Line[], days = creditDays) {
    return ls.map((l) => ({ ...l, creditPrice: creditFromCash({ cash: l.cashPrice, fin: l.fin, days }) }));
  }

  async function load() {
    const [d, s] = await Promise.all([listQuotes(), getSettings().catch(() => null)]);
    setData(d);
    setPartnerId(d.customers[0]?.id ?? 0);
    if (s) {
      setCreditDays(s.creditDays || 90);
      setTiie(s.defaultTiie || 0.0706);
      setSpread(s.asrSpread);
    }
    const inv = await listInventory();
    setLocs(inv.locations.filter((l) => l.loc_type === "internal" || l.loc_type === "supplier"));
    setLocationId((id) => id || inv.locations.find((l) => l.loc_type === "internal")?.id || inv.locations[0]?.id || 0);
    if (lines.length === 0 && d.products[0]) {
      const p = d.products[0];
      const cash = Number(p.list_price);
      const days = s?.creditDays || 90;
      setLines([{ productId: p.id, qty: 1, cashPrice: cash, fin: p.fin, creditPrice: creditFromCash({ cash, fin: p.fin, days }), uom: p.uom || "TM" }]);
    }
  }
  useEffect(() => {
    void load().catch((e) => setError(humanError(e)));
  }, []);

  /** Abre (o cierra) el panel de un folio y deja listos los precios/cantidades para revisar o aceptar. */
  function openQuote(id: number | null, qlines: NonNullable<typeof data>["lines"]) {
    setViewId(id);
    if (!id) return;
    const next: Record<number, number> = {};
    const prices: Record<number, { cash: number; credit: number; qty: number }> = {};
    for (const l of qlines) {
      next[l.product_id] = Number(l.qty);
      prices[l.product_id] = { cash: Number(l.cash_price), credit: Number(l.credit_price), qty: Number(l.qty) };
    }
    setTake(next);
    setRevPrices(prices);
  }

  // Llegó con ?ver=<id> (liga desde la solicitud o el pedido): abrir ese folio al cargar.
  const { ver } = Route.useSearch();
  useEffect(() => {
    if (!data || !ver || viewId === ver) return;
    if (!data.quotes.some((q) => q.id === ver)) return;
    openQuote(ver, (data.lines ?? []).filter((l) => l.quote_id === ver));
  }, [data, ver]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (validUntil < todayMx()) {
        throw new Error(`La vigencia ya venció (${validUntil}). Elige hoy o una fecha posterior.`);
      }
      const priced = lines.filter((l) => l.productId && l.qty > 0);
      await createQuote({
        data: {
          partnerId,
          currency,
          fxRate,
          validUntil,
          deliveryTo,
          tiie,
          spread,
          creditDays: priceOffer === "cash" ? 0 : creditDays,
          priceOffer,
          lines: priced.map((l) => ({
            productId: l.productId,
            qty: l.qty,
            unitPrice: priceOffer === "cash" ? l.cashPrice : l.creditPrice || l.cashPrice,
            cashPrice: l.cashPrice,
            creditPrice: l.creditPrice,
            uom: l.uom,
          })),
        },
      });
      const p = data?.products[0];
      const cash = Number(p?.list_price ?? 0);
      setLines(p ? [{ productId: p.id, qty: 1, cashPrice: cash, fin: p.fin, creditPrice: creditFromCash({ cash, fin: p.fin, days: creditDays }), uom: p.uom || "TM" }] : []);
      await load();
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  }

  // A crédito cada partida necesita costo (kardex o de referencia): sin él el
  // financiamiento sale en cero y el servidor no deja guardar.
  const sinCosto = priceOffer !== "cash" && creditDays > 0;
  const cashTotal = lines.reduce((s, l) => s + l.qty * l.cashPrice, 0);
  const creditTotal = lines.reduce((s, l) => s + l.qty * l.creditPrice, 0);

  async function printQuote(qrow: NonNullable<typeof data>["quotes"][number], qlines: NonNullable<typeof data>["lines"]) {
    const offer = qrow.price_offer || "both";
    const rev = Number(qrow.revision) > 1 ? ` Rev. ${qrow.revision}` : "";
    const cur = qrow.currency;
    const both = offer === "both";
    const trail = await getDealTrail({ data: { kind: "quote", id: qrow.id } })
      .then((d) => d.line)
      .catch(() => "");
    const cashTot = qlines.reduce((s, l) => s + Number(l.qty) * Number(l.cash_price), 0);
    const credTot = qlines.reduce((s, l) => s + Number(l.qty) * Number(l.credit_price), 0);
    printHtml(
      qrow.name,
      letterhead({
        logoSrc: logoSrc(),
        legalName: "AZ INSUMOS AGRICOLAS SA DE CV",
        title: "Cotización",
        number: `${qrow.name}${rev}`,
        partyLabel: "Cliente",
        party: qrow.partner,
        meta: [
          `Fecha ${qrow.date}`,
          `Vigencia ${qrow.valid_until}`,
          cur === "USD" ? `USD · dólar pactado ${Number(qrow.fx_rate)}` : "MXN",
          offerLabel(offer),
          offer !== "cash" && qrow.credit_days ? `Crédito ${qrow.credit_days} d` : "",
          trail ? `Expediente ${trail}` : "",
        ],
        headers: both
          ? ["Producto", "Cant.", "P. contado", "Imp. contado", "P. crédito", "Imp. crédito"]
          : ["Producto", "Cant.", "P. unitario", "Importe"],
        rows: qlines.map((l) => {
          const cash = Number(l.cash_price);
          const credit = Number(l.credit_price);
          const unit = offer === "cash" ? cash : credit;
          if (both) {
            return {
              cells: [
                l.product,
                `${qty(l.qty)} ${l.uom}`,
                moneyIn(cash, cur),
                moneyIn(Number(l.qty) * cash, cur),
                moneyIn(credit, cur),
                moneyIn(Number(l.qty) * credit, cur),
              ],
            };
          }
          return {
            left: l.product,
            qty: `${qty(l.qty)} ${l.uom}`,
            unit: moneyIn(unit, cur),
            amount: moneyIn(Number(l.qty) * unit, cur),
          };
        }),
        total: both
          ? `Contado ${moneyIn(cashTot, cur)}  ·  Crédito ${moneyIn(credTot, cur)}`
          : moneyIn(offer === "cash" ? cashTot : credTot, cur),
        compact: both,
        notes: [
          qrow.notes,
          qrow.delivery_to ? `Entrega: ${qrow.delivery_to}` : "",
          both ? `Precio de contado y a crédito ${qrow.credit_days} d (financiamiento incluido). Mora no entra aquí.` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      }),
      {
        title: "Cotización",
        number: `${qrow.name}${rev}`,
        party: qrow.partner,
        partnerId: qrow.partner_id,
        email: data?.customers.find((c) => c.name === qrow.partner)?.email,
        phone: data?.customers.find((c) => c.name === qrow.partner)?.phone,
      },
    );
  }

  return (
    <AppShell>
      <OpsPipeline current="cotizar" />
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}

      <p className="mb-3 text-sm text-muted">
        Lo normal: <Link to="/solicitudes" className="font-semibold text-accent">Solicitud → proveedores → cotización</Link>. Se puede mandar precio de contado, a crédito, o ambos. Si el cliente pide otro precio, se renegocia (Rev. 2, 3…).
      </p>
      <details className="mb-6">
        <summary className="cursor-pointer text-sm font-semibold">Alta manual (sin solicitud)</summary>
      <form onSubmit={submit} className="mt-3">
        <div className="grid gap-3 lg:grid-cols-6">
          <HeadBox label="Cliente">
            <SearchSelect
              bare
              value={partnerId ? String(partnerId) : ""}
              options={asOpts(data?.customers, (c) => c.id, (c) => c.name)}
              onChange={(v) => setPartnerId(Number(v))}
              placeholder="Buscar cliente…"
            />
          </HeadBox>
          <HeadBox label="Moneda">
            <select className="erp-input w-full border-0 bg-transparent px-0" value={currency} onChange={(e) => setCurrency(e.target.value as "USD" | "MXN")}>
              <option value="USD">USD</option>
              <option value="MXN">MXN</option>
            </select>
          </HeadBox>
          {currency === "USD" ? (
          <HeadBox label="Dólar pactado">
            <MoneyField className="w-full border-0 bg-transparent px-0" value={fxRate} onChange={setFxRate} />
          </HeadBox>
          ) : null}
          <HeadBox label="Vigencia">
            <input className="erp-input w-full border-0 bg-transparent px-0" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
          </HeadBox>
          <HeadBox label="Precios">
            <div className="flex flex-wrap gap-1">
              {(["cash", "credit", "both"] as const).map((o) => (
                <button
                  key={o}
                  type="button"
                  className={priceOffer === o ? "erp-btn-primary h-8 text-[12px]" : "erp-btn h-8 text-[12px]"}
                  onClick={() => setPriceOffer(o)}
                >
                  {offerLabel(o)}
                </button>
              ))}
            </div>
          </HeadBox>
          {priceOffer !== "cash" ? (
            <HeadBox label="Días crédito">
              <input
                className="erp-input w-full border-0 bg-transparent px-0"
                inputMode="numeric"
                value={creditDays}
                onChange={(e) => {
                  const d = Number(e.target.value) || 0;
                  setCreditDays(d);
                  setLines((ls) => syncCredit(ls, d));
                }}
              />
            </HeadBox>
          ) : null}
          <HeadBox label="Totales">
            {priceOffer !== "credit" ? <p className="text-sm tabular-nums">Contado {moneyIn(cashTotal, currency)}</p> : null}
            {priceOffer !== "cash" ? <p className="text-sm font-semibold tabular-nums">Crédito {moneyIn(creditTotal, currency)}</p> : null}
          </HeadBox>
        </div>
        <div className="mt-3 grid gap-3 lg:grid-cols-3">
          <HeadBox label="Entrega">
            <input className="erp-input w-full border-0 bg-transparent px-0" value={deliveryTo} onChange={(e) => setDeliveryTo(e.target.value)} placeholder="Campo, bodega…" />
          </HeadBox>
        </div>

        <button
          type="button"
          className="erp-btn-primary mt-3"
          onClick={() => {
            const p = data?.products[0];
            const cash = Number(p?.list_price ?? 0);
            const f = p?.fin ?? SIN_FIN;
            setLines((ls) => [...ls, { productId: p?.id ?? 0, qty: 1, cashPrice: cash, fin: f, creditPrice: creditFromCash({ cash, fin: f, days: creditDays }), uom: p?.uom || "TM" }]);
          }}
        >
          <Plus className="mr-1 inline size-3.5" />
          Agregar partida
        </button>

        <div className="mt-3 overflow-x-auto erp-card">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2.5 font-medium">Producto</th>
                <th className="px-3 py-2.5 font-medium">UoM</th>
                <th className="px-3 py-2.5 text-right font-medium">Cant.</th>
                {priceOffer !== "credit" ? <th className="px-3 py-2.5 text-right font-medium">P. contado</th> : null}
                {priceOffer !== "cash" ? <th className="px-3 py-2.5 text-right font-medium">P. crédito</th> : null}
                <th className="px-3 py-2.5 text-right font-medium">Importe</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, i) => {
                const p = data?.products.find((x) => x.id === line.productId);
                const imp = priceOffer === "cash" ? line.qty * line.cashPrice : line.qty * line.creditPrice;
                return (
                  <tr key={i} className="border-t border-line">
                    <td className="px-3 py-2">
                      <SearchSelect
                        value={line.productId ? String(line.productId) : ""}
                        options={asOpts(data?.products, (prod) => prod.id, (prod) => `${prod.code} — ${prod.name}`)}
                        placeholder="Buscar producto…"
                        onChange={(v) => {
                          const id = Number(v);
                          const prod = data?.products.find((x) => x.id === id);
                          const cash = Number(prod?.list_price ?? line.cashPrice);
                          const f = prod?.fin ?? SIN_FIN;
                          setLines((ls) => ls.map((x, j) => (j === i ? { ...x, productId: id, uom: prod?.uom || x.uom, cashPrice: cash, fin: f, creditPrice: creditFromCash({ cash, fin: f, days: creditDays }) } : x)));
                        }}
                      />
                      {/* El servidor rechaza guardar esto a crédito: se avisa antes de capturar todo. */}
                      {sinCosto && p?.cost_source === "ninguno" ? (
                        <p className="mt-1 text-[11px] text-warn">Sin costo: pide a administración el costo de referencia, o cotiza de contado.</p>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      <UomSelect value={line.uom || p?.uom || "TM"} extra={p?.uom} onChange={(uom) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, uom } : x)))} />
                    </td>
                    <td className="px-3 py-2">
                      <QtyField value={line.qty} onChange={(q) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, qty: q } : x)))} />
                    </td>
                    {priceOffer !== "credit" ? (
                    <td className="px-3 py-2">
                      <MoneyField
                        value={line.cashPrice}
                        onChange={(cashPrice) =>
                          setLines((ls) => ls.map((x, j) => (j === i ? { ...x, cashPrice, creditPrice: creditFromCash({ cash: cashPrice, fin: x.fin, days: creditDays }) } : x)))
                        }
                      />
                    </td>
                    ) : null}
                    {priceOffer !== "cash" ? (
                    <td className="px-3 py-2">
                      <MoneyField
                        value={line.creditPrice}
                        onChange={(creditPrice) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, creditPrice } : x)))}
                      />
                    </td>
                    ) : null}
                    <td className="px-3 py-2 text-right tabular-nums">{moneyIn(imp, currency)}</td>
                    <td className="px-2 py-2">
                      {lines.length > 1 && (
                        <button type="button" className="grid size-8 place-items-center text-muted hover:text-danger" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                          <Trash2 className="size-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex justify-end">
          <button className="erp-btn-primary" disabled={busy || !lines.length}>Guardar cotización</button>
        </div>
      </form>
      </details>

      <div className="mb-3 flex justify-end">
        <button
          type="button"
          className="erp-btn"
          onClick={() =>
            exportCsv(
              "cotizaciones-azagro",
              ["Folio", "Rev", "Cliente", "Oferta", "Moneda", "TC", "Estado", "Total"],
              (data?.quotes ?? []).map((q) => [q.name, q.revision, q.partner, offerLabel(q.price_offer), q.currency, q.fx_rate, q.state, q.total]),
            )
          }
        >
          Exportar Excel
        </button>
      </div>

      <div className="overflow-x-auto erp-card">
        <table className="w-full min-w-[720px] text-left text-[13px]">
          <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3 font-medium">Folio</th>
              <th className="px-3 py-3 font-medium">Cliente</th>
              <th className="px-3 py-3 font-medium">Oferta</th>
              <th className="px-3 py-3 font-medium">Moneda</th>
              <th className="px-3 py-3 font-medium">Estado</th>
              <th className="px-3 py-3 text-right font-medium">Total</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {data?.quotes.map((qrow) => {
              const cust = data.customers.find((c) => c.name === qrow.partner);
              const qlines = (data.lines ?? []).filter((l) => l.quote_id === qrow.id);
              const open = viewId === qrow.id;
              const closed = qrow.state === "accepted" || qrow.state === "rejected" || qrow.state === "partial";
              const cur = qrow.currency;
              const both = (qrow.price_offer || "both") === "both";
              const expired = !closed && qrow.valid_until < todayMx();
              return (
                <Fragment key={qrow.id}>
                <tr className="border-t border-line">
                  <td className="px-4 py-3 font-medium">
                    {qrow.name}
                    {Number(qrow.revision) > 1 ? <span className="ml-1 text-[11px] text-muted">Rev. {qrow.revision}</span> : null}
                  </td>
                  <td className="px-3 py-3">{qrow.partner}</td>
                  <td className="px-3 py-3">{offerLabel(qrow.price_offer)}{qrow.credit_days && qrow.price_offer !== "cash" ? ` · ${qrow.credit_days} d` : ""}</td>
                  <td className="px-3 py-3">{cur === "USD" ? `USD · dólar pactado ${Number(qrow.fx_rate)}` : "MXN"}</td>
                  <td className="px-3 py-3">
                    <StatusPill tone={qrow.state === "accepted" || qrow.state === "partial" ? "ok" : qrow.state === "rejected" ? "danger" : expired ? "warn" : "muted"}>
                      {qrow.state === "accepted" ? "Aceptada" : qrow.state === "partial" ? "Parcial" : qrow.state === "rejected" ? "Rechazada" : expired ? "Vigencia vencida" : "Vigente"}
                    </StatusPill>
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">{moneyIn(qrow.total, cur)}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-2">
                      <button type="button" className="erp-btn h-8 text-[12px]" onClick={() => void printQuote(qrow, qlines)}>
                        Documento
                      </button>
                      <SendButton
                        title="Cotización"
                        number={`${qrow.name}${Number(qrow.revision) > 1 ? ` Rev. ${qrow.revision}` : ""}`}
                        party={qrow.partner}
                        partnerId={qrow.partner_id}
                        email={cust?.email}
                        phone={cust?.phone}
                        total={Number(qrow.total)}
                        currency={cur}
                        fxRate={Number(qrow.fx_rate)}
                        extra={[
                          qrow.delivery_to ? `Entrega: ${qrow.delivery_to}` : "",
                          offerLabel(qrow.price_offer),
                          both
                            ? `Contado ${moneyIn(qlines.reduce((s, l) => s + Number(l.qty) * Number(l.cash_price), 0), cur)} · Crédito ${moneyIn(qlines.reduce((s, l) => s + Number(l.qty) * Number(l.credit_price), 0), cur)}`
                            : "",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                        lines={qlines.map((l) => ({
                          qty: Number(l.qty),
                          uom: l.uom,
                          name: l.product,
                          unitPrice: Number(l.unit_price),
                          amount: Number(l.qty) * Number(l.unit_price),
                        }))}
                      />
                      <button
                        type="button"
                        className="erp-btn h-8 text-[12px]"
                        onClick={() => openQuote(open ? null : qrow.id, qlines)}
                      >
                        {open ? "Cerrar" : "Ver"}
                      </button>
                    </div>
                  </td>
                </tr>
                {open && (
                  <tr className="border-t border-line bg-paper">
                    <td colSpan={7} className="px-4 py-4">
                      <Expediente kind="quote" id={qrow.id} />
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold">Documento al cliente</p>
                        <span className="erp-chip">Revisión {qrow.revision}</span>
                        {qrow.accepted_offer === "cash" || qrow.accepted_offer === "credit" ? (
                          <span className="erp-chip border-ok">El cliente aceptó el precio de {OFFER_LABEL[qrow.accepted_offer]}</span>
                        ) : null}
                        {qrow.request_name || qrow.order_name ? (
                          <span className="text-[12px] text-muted">
                            {qrow.request_name ? `${qrow.request_name} → ` : ""}
                            {qrow.name}
                            {qrow.order_name && qrow.order_id ? (
                              <>
                                {" → "}
                                <Link to="/sales/$orderId" params={{ orderId: String(qrow.order_id) }} className="font-medium text-accent hover:underline">
                                  {qrow.order_name}
                                </Link>
                              </>
                            ) : null}
                          </span>
                        ) : null}
                      </div>
                      <p className="mb-3 text-[12px] text-muted">
                        {both ? "Van los dos precios: contado y crédito, cada uno con su propio margen." : offerLabel(qrow.price_offer) + "."}{" "}
                        {cur === "USD" ? `Dólar pactado ${Number(qrow.fx_rate)} MXN.` : "Moneda MXN."} Al cliente solo le llega el precio: no ve proveedor, costo ni margen.
                        {!closed
                          ? " Escribe el precio, la utilidad o el margen % de cualquiera de las dos columnas y lo demás se despeja solo; al guardar queda como siguiente revisión y el margen guardado de la partida se recalcula."
                          : ""}
                      </p>
                      {/* Precio · costo · utilidad · margen en una sola tabla. Captura inversa: cualquiera de los tres
                          campos de una columna mueve a los otros dos. Contado y crédito son independientes: mover uno
                          no toca el otro (cada columna guarda su propio margen). */}
                      <div className="mb-4 overflow-x-auto">
                        <table className="w-full min-w-[980px] text-left text-[13px]">
                          <thead className="text-[11px] uppercase tracking-wide text-muted">
                            <tr className="border-b border-line">
                              <th className="py-1 font-medium" colSpan={3} />
                              {both || qrow.price_offer === "cash" ? (
                                <th className="py-1 text-center font-semibold" colSpan={3}>
                                  Contado
                                </th>
                              ) : null}
                              {both || qrow.price_offer === "credit" ? (
                                <th className="py-1 text-center font-semibold" colSpan={4}>
                                  Crédito {qrow.credit_days} d
                                </th>
                              ) : null}
                              <th className="py-1 font-medium" colSpan={2} />
                            </tr>
                            <tr>
                              <th className="py-1 font-medium">Producto</th>
                              <th className="py-1 text-right font-medium">Cant.</th>
                              <th className="py-1 text-right font-medium">Costo puesto</th>
                              {both || qrow.price_offer === "cash" ? (
                                <>
                                  <th className="py-1 text-right font-medium">Precio</th>
                                  <th className="py-1 text-right font-medium">Utilidad /u</th>
                                  <th className="py-1 text-right font-medium">Margen %</th>
                                </>
                              ) : null}
                              {both || qrow.price_offer === "credit" ? (
                                <>
                                  <th className="py-1 text-right font-medium">Financ. /u</th>
                                  <th className="py-1 text-right font-medium">Precio</th>
                                  <th className="py-1 text-right font-medium">Utilidad /u</th>
                                  <th className="py-1 text-right font-medium">Margen %</th>
                                </>
                              ) : null}
                              <th className="py-1 text-right font-medium">Importe</th>
                              <th className="py-1 text-right font-medium">Stock</th>
                            </tr>
                          </thead>
                          <tbody>
                            {qlines.map((l) => {
                              const rp = revPrices[l.product_id] ?? { cash: Number(l.cash_price), credit: Number(l.credit_price), qty: Number(l.qty) };
                              const cost = num(l.cost);
                              const freight = num(l.freight);
                              const landed = cost + freight;
                              const fin = num(l.fin_unit);
                              const short = Number(l.qty) > Number(l.on_hand_own) + 0.0001;
                              const setPrice = (which: "cash" | "credit", p: number) =>
                                setRevPrices((prev) => ({ ...prev, [l.product_id]: { ...(prev[l.product_id] ?? rp), [which]: p } }));
                              return (
                                <tr key={l.id} className="border-t border-line/60">
                                  <td className="py-1.5">{l.product}</td>
                                  <td className="py-1.5 text-right tabular-nums">{qty(l.qty)} {l.uom}</td>
                                  <td className="py-1.5 text-right tabular-nums">
                                    {landed > 0.009 ? (
                                      <span title={freight > 0.009 ? `costo ${moneyIn(cost, cur)} + flete ${moneyIn(freight, cur)}` : undefined}>{moneyIn(landed, cur)}</span>
                                    ) : (
                                      <span className="text-muted">—</span>
                                    )}
                                  </td>
                                  {both || qrow.price_offer === "cash" ? (
                                    <OfferCells price={rp.cash} landed={landed} fin={0} cur={cur} editable={!closed} onPrice={(p) => setPrice("cash", p)} />
                                  ) : null}
                                  {both || qrow.price_offer === "credit" ? (
                                    <>
                                      <td className="py-1.5 text-right tabular-nums text-muted">{fin > 0.009 ? moneyIn(fin, cur) : "—"}</td>
                                      <OfferCells price={rp.credit} landed={landed} fin={fin} cur={cur} editable={!closed} onPrice={(p) => setPrice("credit", p)} />
                                    </>
                                  ) : null}
                                  <td className="py-1.5 text-right tabular-nums">
                                    {qrow.price_offer === "credit" ? (
                                      moneyIn(Number(l.qty) * rp.credit, cur)
                                    ) : (
                                      <>
                                        {moneyIn(Number(l.qty) * rp.cash, cur)}
                                        {both ? <div className="text-[11px] text-muted">crédito {moneyIn(Number(l.qty) * rp.credit, cur)}</div> : null}
                                      </>
                                    )}
                                  </td>
                                  <td className={`py-1.5 text-right text-[12px] tabular-nums ${short ? "text-warn" : "text-muted"}`}>
                                    casa {qty(l.on_hand_own)} · prov {qty(l.on_hand_supplier)}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      {(() => {
                        // Aviso, no candado: se puede guardar con utilidad negativa, pero que se vea.
                        const rojas = qlines
                          .map((l) => {
                            const rp = revPrices[l.product_id] ?? { cash: Number(l.cash_price), credit: Number(l.credit_price), qty: Number(l.qty) };
                            const landed = num(l.cost) + num(l.freight);
                            if (landed <= 0.009) return null;
                            const cashNeg = (both || qrow.price_offer === "cash") && rp.cash - landed < -0.009;
                            const creditNeg = (both || qrow.price_offer === "credit") && rp.credit - landed - num(l.fin_unit) < -0.009;
                            if (!cashNeg && !creditNeg) return null;
                            return `${l.product} (${[cashNeg ? "contado" : "", creditNeg ? "crédito" : ""].filter(Boolean).join(" y ")})`;
                          })
                          .filter(Boolean);
                        return rojas.length ? (
                          <p className="mb-3 rounded-md border border-danger bg-cream px-3 py-2 text-[12px] text-danger">
                            Utilidad negativa: el precio no cubre el costo puesto{both || qrow.price_offer === "credit" ? " más el financiamiento" : ""} en {rojas.join(", ")}. Se puede guardar
                            así, pero revísalo.
                          </p>
                        ) : null;
                      })()}
                      {!closed && (() => {
                        const priceDirty = qlines.some((l) => {
                          const rp = revPrices[l.product_id];
                          if (!rp) return false;
                          return Math.abs(rp.cash - Number(l.cash_price)) > 0.009 || Math.abs(rp.credit - Number(l.credit_price)) > 0.009;
                        });
                        return (
                          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-cream px-3 py-2">
                            <p className="text-[12px]">
                              {priceDirty ? (
                                <span className="font-medium text-warn">Cambiaste precios — todavía no se guardan.</span>
                              ) : (
                                <span className="text-muted">Sin cambios de precio.</span>
                              )}{" "}
                              Al guardar, la Revisión {qrow.revision} con estos precios de hoy queda en la bitácora, y el
                              documento pasa a la Revisión {qrow.revision + 1}.
                            </p>
                            <button
                              type="button"
                              className="erp-btn-primary h-9 shrink-0 text-[12px]"
                              disabled={!priceDirty}
                              onClick={() =>
                                reviseQuote({
                                  data: {
                                    quoteId: qrow.id,
                                    priceOffer: (qrow.price_offer as Offer) || "both",
                                    creditDays: qrow.credit_days,
                                    lines: qlines.map((l) => {
                                      const rp = revPrices[l.product_id];
                                      return {
                                        productId: l.product_id,
                                        qty: rp?.qty ?? Number(l.qty),
                                        cashPrice: rp?.cash ?? Number(l.cash_price),
                                        creditPrice: rp?.credit ?? Number(l.credit_price),
                                      };
                                    }),
                                  },
                                })
                                  .then(() => {
                                    setError(null);
                                    return load();
                                  })
                                  .catch((e) => setError(humanError(e)))
                              }
                            >
                              Guardar como Revisión {qrow.revision + 1}
                            </button>
                          </div>
                        );
                      })()}
                      <p className="mb-2 text-sm font-semibold">¿Qué respondió el cliente?</p>
                      <p className="mb-3 text-[12px] text-muted">
                        Si aceptó, se abre el pedido. Si cotizaste ambos precios, indica si aceptó de contado o a crédito. Mora no entra aquí: corre del vencimiento al día de pago.
                      </p>
                      <table className="w-full text-left text-[13px]">
                        <thead className="text-[11px] uppercase tracking-wide text-muted">
                          <tr>
                            <th className="py-1 font-medium">Producto</th>
                            <th className="py-1 text-right font-medium">Cotizado</th>
                            <th className="py-1 text-right font-medium">Toneladas que aceptó</th>
                          </tr>
                        </thead>
                        <tbody>
                          {qlines.map((l) => (
                            <tr key={l.id}>
                              <td className="py-1.5">{l.product}</td>
                              <td className="py-1.5 text-right tabular-nums">{qty(l.qty)} {l.uom}</td>
                              <td className="py-1.5 text-right">
                                <input
                                  className="erp-input h-8 w-24 text-right"
                                  inputMode="decimal"
                                  disabled={closed}
                                  value={take[l.product_id] ?? Number(l.qty)}
                                  onChange={(e) => setTake((t) => ({ ...t, [l.product_id]: Number(e.target.value) || 0 }))}
                                />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {!closed && (
                        <div className="mt-3 flex flex-wrap items-end gap-2">
                          <label className="text-[12px] text-muted">
                            Tipo de operación
                            <div className="mt-1 flex gap-1">
                              <button type="button" className={fulfillKind === "inventory" ? "erp-btn-primary h-8 text-[12px]" : "erp-btn h-8 text-[12px]"} onClick={() => setFulfillKind("inventory")}>
                                Inventario
                              </button>
                              <button type="button" className={fulfillKind === "direct" ? "erp-btn-primary h-8 text-[12px]" : "erp-btn h-8 text-[12px]"} onClick={() => setFulfillKind("direct")}>
                                Directo / brokeraje
                              </button>
                            </div>
                          </label>
                          <label className="text-[12px] text-muted">
                            {fulfillKind === "direct" ? "Bodega / referencia" : "Bodega de recepción"}
                            <select className="erp-input mt-1" value={locationId} onChange={(e) => setLocationId(Number(e.target.value))}>
                              {locs.length === 0 ? <option value={0}>Sin bodegas</option> : null}
                              {locs.map((l) => (
                                <option key={l.id} value={l.id}>{l.name}</option>
                              ))}
                            </select>
                          </label>
                          <button
                            type="button"
                            className="erp-btn"
                            disabled={busy}
                            onClick={() =>
                              decideQuote({ data: { quoteId: qrow.id, decision: "reject" } })
                                .then(() => { setViewId(null); return load(); })
                                .catch((e) => setError(humanError(e)))
                            }
                          >
                            Cliente rechazó
                          </button>
                          {expired ? (
                            <p className="text-[12px] text-warn">
                              Vigencia vencida ({dateDMY(qrow.valid_until)}). Renegocia o emite otra cotización. No se puede aceptar.
                            </p>
                          ) : (
                            <>
                          <button
                            type="button"
                            className="erp-btn"
                            disabled={busy}
                            onClick={() => {
                              const loc = locationId || locs[0]?.id || 0;
                              if (!loc) {
                                setError("Elige la bodega de surtido");
                                return;
                              }
                              setBusy(true);
                              setError(null);
                              decideQuote({
                                data: {
                                  quoteId: qrow.id,
                                  decision: "partial",
                                  locationId: loc,
                                  fulfillKind,
                                  acceptOffer: both ? "credit" : qrow.price_offer === "cash" ? "cash" : "credit",
                                  lines: qlines.map((l) => ({ productId: l.product_id, qty: take[l.product_id] ?? 0 })),
                                },
                              })
                                .then((r) => navigate({ to: "/sales/$orderId", params: { orderId: String(r.soId) } }))
                                .catch((e) => setError(humanError(e)))
                                .finally(() => setBusy(false));
                            }}
                          >
                            Aceptó solo estas toneladas → pedido
                          </button>
                          {(both || qrow.price_offer === "cash") && (
                            <button
                              type="button"
                              className={both ? "erp-btn" : "erp-btn-primary"}
                              disabled={busy}
                              onClick={() => {
                                const loc = locationId || locs[0]?.id || 0;
                                if (!loc) {
                                  setError("Elige la bodega de surtido");
                                  return;
                                }
                                setBusy(true);
                                setError(null);
                                decideQuote({ data: { quoteId: qrow.id, decision: "accept", locationId: loc, fulfillKind, acceptOffer: "cash" } })
                                  .then((r) => navigate({ to: "/sales/$orderId", params: { orderId: String(r.soId) } }))
                                  .catch((e) => setError(humanError(e)))
                                  .finally(() => setBusy(false));
                              }}
                            >
                              {busy ? "Abriendo pedido…" : both ? "Aceptó de contado → pedido" : "Cliente aceptó → pedido"}
                            </button>
                          )}
                          {(both || qrow.price_offer === "credit") && (
                            <button
                              type="button"
                              className="erp-btn-primary"
                              disabled={busy}
                              onClick={() => {
                                const loc = locationId || locs[0]?.id || 0;
                                if (!loc) {
                                  setError("Elige la bodega de surtido");
                                  return;
                                }
                                setBusy(true);
                                setError(null);
                                decideQuote({ data: { quoteId: qrow.id, decision: "accept", locationId: loc, fulfillKind, acceptOffer: "credit" } })
                                  .then((r) => navigate({ to: "/sales/$orderId", params: { orderId: String(r.soId) } }))
                                  .catch((e) => setError(humanError(e)))
                                  .finally(() => setBusy(false));
                              }}
                            >
                              {busy ? "Abriendo pedido…" : both ? "Aceptó a crédito → pedido" : "Cliente aceptó → pedido"}
                            </button>
                          )}
                            </>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}
            {data && data.quotes.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted">Aún no hay cotizaciones.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </AppShell>
  );
}



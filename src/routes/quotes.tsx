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
import { addDays, missingRateMessage, nearestRate } from "@/lib/erp/credit";
import { getDealTrail } from "@/lib/erp/deal";
import { marginFromPrice, OFFER_LABEL, type MarginMode } from "@/lib/erp/margins";
import { ladderFor, termLabel, type LadderStep } from "@/lib/erp/ladder";
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
 *   margen % = utilidad / precio                        (sobre el precio de venta)
 *   precio   = (costo puesto + financiamiento) ÷ (1 − margen %)
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
  const pct = hasCost && price > 0 ? (util / price) * 100 : 0;
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
          <QtyField
            className={`w-20 ${neg ? "text-danger" : ""}`}
            value={Math.round(pct * 100) / 100}
            // Con 100% el precio sería infinito: se ignora hasta que escriban un % válido.
            onChange={(m) => (m < 100 ? onPrice(round4((landed + fin) / (1 - m / 100))) : undefined)}
          />
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
  // Ningún número de negocio nace aquí: plazo y spread vienen de Ajustes,
  // la TIIE y el tipo de cambio de sus tablas (con fecha). 0 = todavía no
  // hay dato, y el servidor no deja guardar sin él.
  const [fxRate, setFxRate] = useState(0);
  const [fxFrom, setFxFrom] = useState<string | null>(null);
  const [validUntil, setValidUntil] = useState(() => addDays(todayMx(), 15));
  const [priceOffer, setPriceOffer] = useState<Offer>("both");
  const [creditDays, setCreditDays] = useState(0);
  const [tiie, setTiie] = useState(0);
  const [tiieFrom, setTiieFrom] = useState<string | null>(null);
  const [spread, setSpread] = useState(0);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [deliveryTo, setDeliveryTo] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [viewId, setViewId] = useState<number | null>(null);
  const [take, setTake] = useState<Record<number, number>>({});
  const [revPrices, setRevPrices] = useState<Record<number, { cash: number; credit: number; qty: number }>>({});
  /** Plazo acordado que se está editando en el panel abierto (null = el de la cotización). */
  const [revDays, setRevDays] = useState<number | null>(null);
  /** Partidas que se están agregando a la cotización abierta (punto C3): entran al guardar la revisión. */
  const [addLines, setAddLines] = useState<Array<{ productId: number; qty: number }>>([]);
  const [locationId, setLocationId] = useState(0);
  const [fulfillKind, setFulfillKind] = useState<"inventory" | "direct">("inventory");

  // El financiamiento lo calcula el servidor sobre el costo real (línea.fin):
  // el precio a crédito es el mismo para cualquier rol, vea o no el costo.
  function syncCredit(ls: Line[], days = creditDays) {
    return ls.map((l) => ({ ...l, creditPrice: creditFromCash({ cash: l.cashPrice, fin: l.fin, days }) }));
  }

  /**
   * Escalera de plazos de una partida de la cotización abierta. El
   * financiamiento por columna lo mandó el servidor (costo real, TIIE/spread
   * de la COT). Si el costo se ve, la escalera sigue en vivo el margen que se
   * despeja del precio capturado (contado → columna de contado; crédito →
   * todas las columnas a plazo). Sin costo visible se muestra la escalera que
   * calculó el servidor con los márgenes guardados (se pone al día al guardar).
   */
  function ladderOfLine(l: NonNullable<typeof data>["lines"][number], rp: { cash: number; credit: number }, agreed: number): LadderStep[] {
    const landed = num(l.cost) + num(l.freight);
    const finAt = (d: number) => l.ladder.find((st) => st.days === d)?.finance ?? 0;
    if (landed > 0.009) {
      const cashMode: MarginMode = l.margin_cash_mode === "nominal" ? "nominal" : "pct";
      const creditMode: MarginMode = l.margin_credit_mode === "nominal" ? "nominal" : "pct";
      return ladderFor({
        terms: data?.terms ?? [],
        agreed,
        landed,
        marginCash: marginFromPrice({ price: rp.cash, landed, finance: 0, mode: cashMode }),
        marginCredit: marginFromPrice({ price: rp.credit, landed, finance: finAt(agreed), mode: creditMode }),
        financeAt: finAt,
      });
    }
    return l.ladder.map((st) => ({
      ...st,
      agreed: st.days === agreed,
      price: st.days === 0 ? rp.cash : st.days === agreed ? rp.credit : st.price,
    }));
  }

  async function load() {
    const d = await listQuotes();
    setData(d);
    setPartnerId(d.customers[0]?.id ?? 0);
    // Ajustes incompletos = no se cotiza a mano; el error se muestra tal cual.
    const s = await getSettings().catch((e: unknown) => {
      setSettingsError(humanError(e));
      return null;
    });
    if (s) {
      setSettingsError(null);
      setCreditDays(s.creditDays);
      setSpread(s.asrSpread);
      const fx = nearestRate(s.fx.map((r) => ({ date: r.date, rate: Number(r.usd_mxn) })), todayMx());
      setFxRate(fx?.rate ?? 0);
      setFxFrom(fx?.date ?? null);
    }
    setTiie(d.tiieToday?.rate ?? 0);
    setTiieFrom(d.tiieToday?.date ?? null);
    const inv = await listInventory();
    setLocs(inv.locations.filter((l) => l.loc_type === "internal" || l.loc_type === "supplier"));
    setLocationId((id) => id || inv.locations.find((l) => l.loc_type === "internal")?.id || inv.locations[0]?.id || 0);
    if (lines.length === 0 && d.products[0] && s) {
      const p = d.products[0];
      const cash = Number(p.list_price);
      const days = s.creditDays;
      const f = p.fin ?? SIN_FIN;
      setLines([{ productId: p.id, qty: 1, cashPrice: cash, fin: f, creditPrice: creditFromCash({ cash, fin: f, days }), uom: p.uom || "TM" }]);
    }
  }
  useEffect(() => {
    void load().catch((e) => setError(humanError(e)));
  }, []);

  /** Abre (o cierra) el panel de un folio y deja listos los precios/cantidades para revisar o aceptar. */
  function openQuote(id: number | null, qlines: NonNullable<typeof data>["lines"]) {
    setViewId(id);
    setAddLines([]);
    setRevDays(null);
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
      if (settingsError) throw new Error(settingsError);
      if (currency === "USD" && !(fxRate > 0)) {
        throw new Error("Sin tipo de cambio: la tabla está vacía. Captúralo en Ajustes → Tipo de cambio o escribe el pactado.");
      }
      if (priceOffer !== "cash" && creditDays > 0 && !(tiie > 0)) throw new Error(missingRateMessage(todayMx(), "cotización a crédito"));
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
      const f = p?.fin ?? SIN_FIN;
      setLines(p ? [{ productId: p.id, qty: 1, cashPrice: cash, fin: f, creditPrice: creditFromCash({ cash, fin: f, days: creditDays }), uom: p.uom || "TM" }] : []);
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

  /**
   * Papel que sale al cliente: SOLO dos precios, el de contado y el del plazo
   * acordado (quotes.credit_days). La escalera de plazos es interna y no sale.
   * Si el plazo acordado cambia (revisión), credit_price ya trae la columna
   * que corresponde y el documento se regenera con ella.
   */
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
      {msg && <p className="mb-3 text-sm text-ok">{msg}</p>}

      <p className="mb-3 text-sm text-muted">
        Lo normal: <Link to="/solicitudes" className="font-semibold text-accent">Solicitud → proveedores → cotización</Link>. Se puede mandar precio de contado, a crédito, o ambos. Si el cliente pide otro precio, se renegocia (Rev. 2, 3…).
      </p>
      <details className="mb-6">
        <summary className="cursor-pointer text-sm font-semibold">Alta manual (sin solicitud)</summary>
      {settingsError ? <p className="mt-3 text-sm text-danger">Ajustes no disponibles: {settingsError}</p> : null}
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
          <HeadBox label={fxFrom ? `Dólar pactado (tabla ${fxFrom})` : "Dólar pactado (sin tabla)"}>
            <MoneyField className="w-full border-0 bg-transparent px-0" value={fxRate} onChange={setFxRate} />
            {!fxFrom ? <p className="text-[11px] text-danger">Sin tipo de cambio en la tabla: captúralo en Ajustes o escribe el pactado.</p> : null}
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
          {priceOffer !== "cash" ? (
            <HeadBox label="Financiamiento">
              {tiieFrom ? (
                <p className="text-[12px] tabular-nums">
                  TIIE {(tiie * 100).toFixed(2)}% (tabla, {tiieFrom}) + spread ASR {(spread * 100).toFixed(2)}% (Ajustes)
                </p>
              ) : (
                <p className="text-[11px] text-danger">{missingRateMessage(todayMx(), "cotización a crédito")}</p>
              )}
            </HeadBox>
          ) : null}
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
              // Aceptada pero con el pedido todavía en borrador: se puede
              // revisar (es donde se agrega una partida a ese pedido). Con el
              // pedido confirmado, no: se levanta un pedido nuevo.
              const borrador = Boolean(qrow.order_id) && qrow.order_state === "draft";
              const revisable = qrow.state !== "rejected" && (!closed || borrador);
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
                {open && (() => {
                  // Plazo acordado en edición: manda sobre el de la cotización hasta guardar.
                  const agreedDays = revDays ?? qrow.credit_days;
                  const ladderDays = (qlines[0]?.ladder ?? []).map((st) => st.days).filter((d) => d > 0);
                  const finAt = (l: (typeof qlines)[number], d: number) => l.ladder.find((st) => st.days === d)?.finance ?? 0;
                  const rpOf = (l: (typeof qlines)[number]) => revPrices[l.product_id] ?? { cash: Number(l.cash_price), credit: Number(l.credit_price), qty: Number(l.qty) };
                  /** Cambiar el plazo acordado: el precio a crédito de cada partida pasa a la columna de la escalera de ese plazo. */
                  const changeDays = (d: number) => {
                    setRevPrices((prev) => {
                      const next = { ...prev };
                      for (const l of qlines) {
                        const rp = prev[l.product_id] ?? rpOf(l);
                        const st = ladderOfLine(l, rp, agreedDays).find((x) => x.days === d);
                        if (st?.price != null) next[l.product_id] = { ...rp, credit: st.price };
                      }
                      return next;
                    });
                    setRevDays(d);
                  };
                  return (
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
                        {both ? `Al cliente le van dos precios: contado y crédito a ${agreedDays} d, cada uno con su propio margen (sobre el precio de venta).` : offerLabel(qrow.price_offer) + "."}{" "}
                        {cur === "USD" ? `Dólar pactado ${Number(qrow.fx_rate)} MXN.` : "Moneda MXN."} Al cliente solo le llega el precio: no ve proveedor, costo, margen ni la escalera.
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
                                  Crédito {agreedDays} d
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
                              const rp = rpOf(l);
                              const cost = num(l.cost);
                              const freight = num(l.freight);
                              const landed = cost + freight;
                              // Financiamiento de la columna del plazo acordado (el guardado si es el de la COT).
                              const fin = agreedDays > 0 ? finAt(l, agreedDays) : 0;
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
                                    <OfferCells price={rp.cash} landed={landed} fin={0} cur={cur} editable={revisable} onPrice={(p) => setPrice("cash", p)} />
                                  ) : null}
                                  {both || qrow.price_offer === "credit" ? (
                                    <>
                                      <td className="py-1.5 text-right tabular-nums text-muted">{fin > 0.009 ? moneyIn(fin, cur) : "—"}</td>
                                      <OfferCells price={rp.credit} landed={landed} fin={fin} cur={cur} editable={revisable} onPrice={(p) => setPrice("credit", p)} />
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
                            {/* Partidas que se están agregando: el costo, el margen y el financiamiento
                                los resuelve el servidor al guardar la revisión, así que aquí solo se
                                captura el precio (el de crédito se arma con la base que mandó el servidor). */}
                            {open
                              ? addLines.map((al, i) => {
                                  const prod = data.products.find((p) => p.id === al.productId);
                                  const rp = revPrices[al.productId] ?? { cash: 0, credit: 0, qty: al.qty };
                                  const setPrice = (which: "cash" | "credit", p: number) =>
                                    setRevPrices((prev) => {
                                      const base = { ...(prev[al.productId] ?? rp), [which]: p };
                                      const credit =
                                        which === "cash" && prod ? creditFromCash({ cash: p, fin: prod.fin ?? SIN_FIN, days: qrow.credit_days }) : base.credit;
                                      return { ...prev, [al.productId]: { ...base, credit, qty: al.qty } };
                                    });
                                  return (
                                    <tr key={`add-${i}`} className="border-t border-line/60 bg-brand-soft/40">
                                      <td className="py-1.5">
                                        <div className="flex items-center gap-2">
                                          <SearchSelect
                                            value={al.productId ? String(al.productId) : ""}
                                            options={asOpts(data.products, (p) => p.id, (p) => `${p.code} — ${p.name}`)}
                                            onChange={(v) => setAddLines((ls) => ls.map((x, j) => (j === i ? { ...x, productId: Number(v) } : x)))}
                                            placeholder="Producto…"
                                          />
                                          <button
                                            type="button"
                                            className="erp-btn h-8 px-2 text-[12px]"
                                            onClick={() => setAddLines((ls) => ls.filter((_, j) => j !== i))}
                                          >
                                            <Trash2 className="size-3.5" />
                                          </button>
                                        </div>
                                      </td>
                                      <td className="py-1.5 text-right">
                                        <QtyField
                                          className="w-20"
                                          value={al.qty}
                                          onChange={(n) => setAddLines((ls) => ls.map((x, j) => (j === i ? { ...x, qty: n } : x)))}
                                        />
                                      </td>
                                      <td className="py-1.5 text-right text-[12px] text-muted">al guardar</td>
                                      {both || qrow.price_offer === "cash" ? (
                                        <OfferCells price={rp.cash} landed={0} fin={0} cur={cur} editable onPrice={(p) => setPrice("cash", p)} />
                                      ) : null}
                                      {both || qrow.price_offer === "credit" ? (
                                        <>
                                          <td className="py-1.5 text-right text-[12px] text-muted">al guardar</td>
                                          <OfferCells price={rp.credit} landed={0} fin={0} cur={cur} editable onPrice={(p) => setPrice("credit", p)} />
                                        </>
                                      ) : null}
                                      <td className="py-1.5 text-right tabular-nums">
                                        {moneyIn(al.qty * (qrow.price_offer === "credit" ? rp.credit : rp.cash), cur)}
                                      </td>
                                      <td className="py-1.5 text-right text-[12px] text-muted">—</td>
                                    </tr>
                                  );
                                })
                              : null}
                          </tbody>
                        </table>
                      </div>
                      {/* Escalera de plazos: herramienta interna para decidir. Una columna por plazo de
                          Ajustes (más el acordado), con precio, financiamiento y utilidad. NO sale al
                          cliente: el documento lleva solo contado y el plazo acordado. */}
                      {qrow.price_offer !== "cash" && qlines.length ? (
                        <div className="mb-4 rounded-md border border-line bg-cream/60 px-3 py-2">
                          <div className="mb-2 flex flex-wrap items-center gap-3">
                            <p className="text-[12px] font-semibold">Escalera de plazos (interna, no sale al cliente)</p>
                            <label className="flex items-center gap-2 text-[12px] text-muted">
                              Plazo acordado
                              {revisable ? (
                                <select className="erp-input h-8" value={agreedDays} onChange={(e) => changeDays(Number(e.target.value))}>
                                  {[...new Set([...ladderDays, qrow.credit_days].filter((d) => d > 0))]
                                    .sort((a, b) => a - b)
                                    .map((d) => (
                                      <option key={d} value={d}>
                                        {termLabel(d)}
                                      </option>
                                    ))}
                                </select>
                              ) : (
                                <span className="font-semibold text-ink">{termLabel(agreedDays)}</span>
                              )}
                            </label>
                            {revDays != null && revDays !== qrow.credit_days ? (
                              <span className="text-[12px] text-warn">
                                Plazo {qrow.credit_days} d → {revDays} d: el precio a crédito tomó la columna de {revDays} d. Al guardar, el documento sale con ese plazo.
                              </span>
                            ) : null}
                          </div>
                          <div className="overflow-x-auto">
                            <table className="w-full text-left text-[12px]">
                              <thead className="text-[11px] uppercase tracking-wide text-muted">
                                <tr>
                                  <th className="py-1 font-medium">Producto</th>
                                  {ladderOfLine(qlines[0]!, rpOf(qlines[0]!), agreedDays).map((st) => (
                                    <th key={st.days} className={`py-1 text-right font-medium ${st.agreed || st.days === 0 ? "text-ink" : ""}`}>
                                      {termLabel(st.days)}
                                      {st.agreed ? <span className="block text-[10px] normal-case tracking-normal text-accent">acordado</span> : null}
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {qlines.map((l) => (
                                  <tr key={`ladder-${l.id}`} className="border-t border-line/60">
                                    <td className="py-1.5">{l.product}</td>
                                    {ladderOfLine(l, rpOf(l), agreedDays).map((st) => (
                                      <td key={st.days} className={`py-1.5 text-right tabular-nums ${st.agreed ? "bg-brand-soft/40" : ""}`}>
                                        {st.price != null ? (
                                          <>
                                            <span className={`${st.agreed || st.days === 0 ? "font-semibold" : ""} ${(st.utility ?? 0) < -0.009 ? "text-danger" : ""}`}>
                                              {moneyIn(st.price, cur)}
                                            </span>
                                            <span className="block text-[11px] text-muted">
                                              {st.days > 0 ? `fin ${moneyIn(st.finance, cur)}` : "sin financiamiento"}
                                              {st.utility != null && st.pct != null ? ` · util ${moneyIn(st.utility, cur)} (${st.pct.toFixed(1)}%)` : ""}
                                            </span>
                                          </>
                                        ) : (
                                          <span className="text-muted">—</span>
                                        )}
                                      </td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      ) : null}
                      {revisable ? (
                        <div className="mb-4 flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            className="erp-btn h-8 text-[12px]"
                            onClick={() => setAddLines((ls) => [...ls, { productId: data.products[0]?.id ?? 0, qty: 1 }])}
                          >
                            <Plus className="mr-1 inline size-3.5" />
                            Agregar partida
                          </button>
                          <span className="text-[12px] text-muted">
                            Entra al guardar la revisión: ahí pasa por costo, margen y financiamiento
                            {borrador && qrow.order_name ? `, y ${qrow.order_name} se actualiza solo` : ""}.
                          </span>
                        </div>
                      ) : null}
                      {(() => {
                        // Aviso, no candado: se puede guardar con utilidad negativa, pero que se vea.
                        const rojas = qlines
                          .map((l) => {
                            const rp = rpOf(l);
                            const landed = num(l.cost) + num(l.freight);
                            if (landed <= 0.009) return null;
                            const cashNeg = (both || qrow.price_offer === "cash") && rp.cash - landed < -0.009;
                            const creditNeg = (both || qrow.price_offer === "credit") && rp.credit - landed - (agreedDays > 0 ? finAt(l, agreedDays) : 0) < -0.009;
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
                      {revisable && (() => {
                        const priceDirty = qlines.some((l) => {
                          const rp = revPrices[l.product_id];
                          if (!rp) return false;
                          return Math.abs(rp.cash - Number(l.cash_price)) > 0.009 || Math.abs(rp.credit - Number(l.credit_price)) > 0.009;
                        });
                        // Una partida nueva cuenta como cambio en cuanto tiene producto y cantidad.
                        const nuevas = addLines.filter((a) => a.productId && a.qty > 0 && !qlines.some((l) => l.product_id === a.productId));
                        const daysDirty = revDays != null && revDays !== qrow.credit_days;
                        const dirty = priceDirty || nuevas.length > 0 || daysDirty;
                        return (
                          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-cream px-3 py-2">
                            <p className="text-[12px]">
                              {dirty ? (
                                <span className="font-medium text-warn">
                                  {nuevas.length
                                    ? `${nuevas.length} partida(s) nueva(s) y precios sin guardar.`
                                    : daysDirty && !priceDirty
                                      ? `Cambiaste el plazo acordado a ${agreedDays} d — todavía no se guarda.`
                                      : "Cambiaste precios — todavía no se guardan."}
                                </span>
                              ) : (
                                <span className="text-muted">Sin cambios de precio.</span>
                              )}{" "}
                              Al guardar, la Revisión {qrow.revision} con estos precios de hoy queda en la bitácora, y el
                              documento pasa a la Revisión {qrow.revision + 1}.
                              {borrador && qrow.order_name ? ` ${qrow.order_name} (borrador) se pone al día con esta revisión.` : ""}
                            </p>
                            <button
                              type="button"
                              className="erp-btn-primary h-9 shrink-0 text-[12px]"
                              disabled={!dirty}
                              onClick={() =>
                                reviseQuote({
                                  data: {
                                    quoteId: qrow.id,
                                    priceOffer: (qrow.price_offer as Offer) || "both",
                                    creditDays: agreedDays,
                                    lines: [
                                      ...qlines.map((l) => {
                                        const rp = revPrices[l.product_id];
                                        return {
                                          productId: l.product_id,
                                          qty: rp?.qty ?? Number(l.qty),
                                          cashPrice: rp?.cash ?? Number(l.cash_price),
                                          creditPrice: rp?.credit ?? Number(l.credit_price),
                                        };
                                      }),
                                      ...nuevas.map((a) => ({
                                        productId: a.productId,
                                        qty: a.qty,
                                        cashPrice: revPrices[a.productId]?.cash ?? 0,
                                        creditPrice: revPrices[a.productId]?.credit ?? 0,
                                      })),
                                    ],
                                  },
                                })
                                  .then((r) => {
                                    setError(null);
                                    setAddLines([]);
                                    setRevDays(null);
                                    if (r.orders.length) setMsg(`Revisión ${r.revision} guardada · ${r.orders.join(", ")} actualizado`);
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
                  );
                })()}
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



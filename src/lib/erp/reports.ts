import { createServerFn } from "@tanstack/react-start";
import { isUsdFx, poCostToMxn } from "@/lib/erp/fx";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { activeMember, assertCan, canSeeMargins } from "@/lib/erp/acl";
import { dateDMY, todayMx } from "@/lib/utils";
import { purchaseFxOfDeal } from "@/lib/erp/deal-supplier";
import { fxCostOfPeriod } from "@/lib/erp/fx-cost-query";
import { mergeDealPnl } from "@/lib/erp/parciales";
import { daysBetween, earlyPayBonus, financeCost, nearestRate } from "@/lib/erp/credit";
import { policy } from "@/lib/erp/ops";
import { ensureRefCost, resolveCost } from "@/lib/erp/cost";
import { circuitTerms, financingCircuit, fundingTableOf, nearestFunding, readCircuits } from "@/lib/erp/circuits";
import { docRate, usesFundingTable } from "@/lib/erp/doc-rate";
import { linealMarginFromPrice, type FinancingBase } from "@/lib/erp/pricing";
import { YEAR_DAYS } from "@/lib/erp/rules";

type Sql = Awaited<ReturnType<typeof getSql>>;

async function cid(sql: Sql, userId: string) {
  const rows = await sql<{ company_id: number }>`select company_id from members where user_id = ${userId} and status = 'active' limit 1`;
  if (!rows[0]) throw new Error("Sin empresa");
  return rows[0].company_id;
}

/** Días excedidos de la FV (o 0 si no hay): se necesita antes de decidir si hace falta la comisión. */
function daysExceededPreview(fv: { credit_due: string | null; due_date: string; paid_date: string | null } | undefined, today: string) {
  if (!fv) return 0;
  const end = fv.paid_date && fv.paid_date < today ? fv.paid_date : today;
  return Math.max(0, daysBetween(fv.credit_due || fv.due_date, end));
}

type DealFvRow = {
  date: string;
  due_date: string;
  credit_due: string | null;
  paid_date: string | null;
  amount: string;
  residual: string;
  fx_result: string;
  params_snap: string;
  credit_days: number;
};

export async function computeDealPnl(sql: Sql, companyId: number, soId: number) {
  // Aquí corrían SIETE `alter table ... add column if not exists` — y el
  // Panorama llama a esta función hasta 500 veces por carga: tres mil
  // quinientas sentencias de esquema para dibujar una tabla. Las siete
  // columnas están declaradas en migraciones (0003, 0009, 0010 y 0045), que
  // es donde vive el esquema desde el 18-sep-2026.
  //
  // La factura de venta manda: su fecha de emisión fija la TIIE de costo, y
  // sus fechas de pago/plazo financiero fijan la Capa 2 y el pronto pago.
  const fv = await sql<DealFvRow>`
    select date::text, due_date::text, credit_due::text, paid_date::text,
      amount::text, residual::text, coalesce(fx_result,0)::text as fx_result,
      coalesce(params_snap,'') as params_snap, coalesce(credit_days,0)::int as credit_days
    from invoices
    where company_id = ${companyId} and order_id = ${soId} and kind = 'customer' and name like 'FV-%'
      and state <> 'reversed'
    order by id desc limit 1
  `;
  // BLOQUE DE PARCIALES, paso 5 (Decisiones 46, 54, 61): con dos o más
  // facturas vivas — o una sola factura que no cubre el pedido (entrega
  // parcial con evento) — la utilidad se calcula FACTURA POR FACTURA, cada una
  // con sus propios días, su propia TIIE y su propia base (solo lo que salió
  // en esa entrega), y se suma. El camino de una sola entrega (arriba, la
  // consulta de la última FV) queda intacto, byte a byte.
  const fvsAll = await sql<DealFvRow & { id: number; name: string; event_ref: string | null }>`
    select id, name, event_ref, date::text, due_date::text, credit_due::text, paid_date::text,
      amount::text, residual::text, coalesce(fx_result,0)::text as fx_result,
      coalesce(params_snap,'') as params_snap, coalesce(credit_days,0)::int as credit_days
    from invoices
    where company_id = ${companyId} and order_id = ${soId} and kind = 'customer' and name like 'FV-%'
      and reverses_id is null and state <> 'reversed'
    order by id
  `;
  let multi = fvsAll.length > 1;
  if (!multi && fvsAll.length === 1 && fvsAll[0]!.event_ref != null) {
    const q = await sql<{ ordered: string; invoiced: string }>`
      select (select coalesce(sum(qty),0) from sales_lines where so_id = ${soId})::text as ordered,
        (select coalesce(sum(il.qty),0) from invoice_lines il where il.invoice_id = ${fvsAll[0]!.id})::text as invoiced
    `;
    multi = Number(q[0]?.invoiced ?? 0) < Number(q[0]?.ordered ?? 0) - 0.0001;
  }
  if (multi) return computeDealPnlMulti(sql, companyId, soId, fvsAll);
  const core = await dealPnlCore(sql, companyId, soId, { fv: fv[0], orderLevel: true });
  return { ...core, multi: false as const, invoices: [] as DealPnlInvoice[], uninvoiced: [] as DealPnlUninvoiced[] };
}

export type DealPnlInvoice = {
  id: number;
  name: string;
  eventRef: string | null;
  date: string;
  amount: number;
  residual: number;
  paidDate: string | null;
  financialDays: number;
  daysExceeded: number;
  tiieIssue: number | null;
  revenue: number;
  cogs: number;
  finance: number;
  financierFinance: number;
  discount: number;
  netProfit: number;
};
export type DealPnlUninvoiced = { productId: number; code: string; name: string; uom: string; qty: number };

/**
 * Paso 5: la utilidad de un pedido con N facturas = Σ (utilidad de cada
 * factura, calculada con el motor de siempre sobre lo que ESA factura
 * facturó, con sus propios días y su propia TIIE — Decisión 61) + gastos y
 * mora del pedido, una sola vez. Lo entregado sin facturar y lo pendiente
 * quedan fuera y se reportan aparte, no se fingen.
 */
async function computeDealPnlMulti(
  sql: Sql,
  companyId: number,
  soId: number,
  fvs: Array<DealFvRow & { id: number; name: string; event_ref: string | null }>,
) {
  const parts: Array<{ fv: (typeof fvs)[number]; pnl: Awaited<ReturnType<typeof dealPnlCore>> }> = [];
  for (const f of fvs) {
    const ils = await sql<{ product_id: number; qty: string }>`
      select product_id, sum(qty)::text as qty from invoice_lines where invoice_id = ${f.id} and product_id is not null group by product_id
    `;
    const qtyByProduct = new Map(ils.map((x) => [x.product_id, Number(x.qty)]));
    parts.push({ fv: f, pnl: await dealPnlCore(sql, companyId, soId, { fv: f, qtyByProduct, orderLevel: false }) });
  }
  const expenses = await orderExpenses(sql, companyId, soId);
  const { mora, moraPendiente } = await orderMora(sql, companyId, soId);
  // Decisión 87: del pedido, una sola vez — igual que los gastos y la mora.
  const compraFx = await purchaseFxOfDeal(sql, companyId, soId);
  const pend = await sql<{ product_id: number; code: string; name: string; uom: string; ordered: string; closed_short: string; invoiced: string }>`
    select sl.product_id, p.code, p.name, coalesce(sl.uom, p.uom) as uom, sum(sl.qty)::text as ordered,
      sum(coalesce(sl.qty_closed_short, 0))::text as closed_short,
      (select coalesce(sum(il.qty),0) from invoice_lines il join invoices i on i.id = il.invoice_id
        where i.company_id = ${companyId} and i.order_id = ${soId} and i.kind = 'customer' and i.name like 'FV-%'
          and i.reverses_id is null and i.state <> 'reversed' and il.product_id = sl.product_id)::text as invoiced
    from sales_lines sl join products p on p.id = sl.product_id
    where sl.so_id = ${soId}
    group by sl.product_id, p.code, p.name, sl.uom, p.uom
    order by min(sl.id)
  `;
  const uninvoiced: DealPnlUninvoiced[] = pend
    // Paso 7: lo cerrado corto ya nunca se va a facturar — no es "sin facturar todavía".
    .map((r) => ({ productId: r.product_id, code: r.code, name: r.name, uom: r.uom, qty: Math.round((Number(r.ordered) - Number(r.closed_short) - Number(r.invoiced)) * 10000) / 10000 }))
    .filter((r) => r.qty > 0.0001);
  return mergeDealPnl(
    parts.map((x) => ({
      invoice: { id: x.fv.id, name: x.fv.name, eventRef: x.fv.event_ref, date: x.fv.date, amount: Number(x.fv.amount), residual: Number(x.fv.residual), paidDate: x.fv.paid_date },
      pnl: x.pnl,
    })),
    { expenses, mora, moraPendiente, uninvoiced, fxCompra: compraFx.fxCompra, compraLigada: compraFx.ligado },
  );
}

async function orderExpenses(sql: Sql, companyId: number, soId: number) {
  let expenses: Array<{ id: number; name: string; class: string; amount: number }> = [];
  try {
    const exp = await sql<{ id: number; name: string; class: string; amount: string }>`
      select id, name, class, amount::text from expenses where company_id = ${companyId} and so_id = ${soId} order by id
    `;
    expenses = exp.map((e) => ({ id: e.id, name: e.name, class: e.class, amount: Number(e.amount) }));
  } catch {
    expenses = [];
  }
  return expenses;
}

async function orderMora(sql: Sql, companyId: number, soId: number) {
  let mora = 0;
  let moraPendiente = 0;
  try {
    const mi = await sql<{ a: string; r: string }>`
      select coalesce(sum(amount),0)::text as a, coalesce(sum(residual),0)::text as r from invoices
      where company_id = ${companyId} and order_id = ${soId} and inv_class = 'interest'
        and state <> 'reversed' and reverses_id is null
    `;
    mora = Number(mi[0]?.a ?? 0);
    moraPendiente = Number(mi[0]?.r ?? 0);
  } catch {
    mora = 0;
    moraPendiente = 0;
  }
  return { mora, moraPendiente };
}

/** El motor de siempre, para UNA factura (o ninguna: proyección del pedido). `qtyByProduct` = lo que facturó ESA factura; sin él, el pedido completo. */
async function dealPnlCore(
  sql: Sql,
  companyId: number,
  soId: number,
  opts: { fv: DealFvRow | undefined; qtyByProduct?: Map<number, number>; orderLevel: boolean },
) {
  const so = await sql<{
    name: string;
    currency: string;
    date: string;
    credit_days: number;
    quote_id: number | null;
    circuit_code: string | null;
    fx_rate: string;
    q_commission: string | null;
    q_cost_rate: string | null;
    q_collection_rate: string | null;
  }>`
    select so.name, so.currency, so.date::text, coalesce(so.credit_days,0)::int as credit_days, so.quote_id, so.circuit_code,
      coalesce(so.fx_rate,1)::text as fx_rate,
      (select q.commission_rate::text from quotes q where q.id = so.quote_id) as q_commission,
      (select q.cost_rate::text from quotes q where q.id = so.quote_id) as q_cost_rate,
      (select q.collection_rate::text from quotes q where q.id = so.quote_id) as q_collection_rate
    from sales_orders so where so.id = ${soId} and so.company_id = ${companyId}
  `;
  if (!so[0]) throw new Error("Pedido no encontrado");
  const pol = await policy(sql, companyId);
  const fv: DealFvRow[] = opts.fv ? [opts.fv] : [];
  const today = todayMx();
  const issueDate = fv[0]?.date ?? so[0].date;
  // Si la factura guardó su foto de parámetros al emitirse, la utilidad se
  // calcula con ESOS valores: cambiar Ajustes o la tabla TIIE después no
  // reescribe la historia de operaciones ya facturadas.
  let snap: {
    tiieIssue?: number;
    tiieDate?: string;
    costSpread?: number;
    commissionRate?: number | null;
    financialDays?: number;
    earlyPayDays?: number;
    circuit?: string | null;
    financingBase?: FinancingBase | null;
    costRate?: number | null;
    collectionRate?: number | null;
  } = {};
  try {
    if (fv[0]?.params_snap) snap = JSON.parse(fv[0].params_snap) as typeof snap;
  } catch {
    snap = {};
  }
  const tiieRows = await sql<{ date: string; rate: string }>`
    select date::text, rate::text from tiie_rates where company_id = ${companyId} order by date
  `;
  // TIIE de emisión: la de la foto de la factura o, si no hay foto, el
  // renglón de la tabla vigente a la emisión. Sin renglón NO se inventa: si
  // el pedido la necesita (crédito, días excedidos o pronto pago) queda fuera
  // del cálculo, marcado con el motivo.
  // El circuito del documento se resuelve ANTES que la tasa: decide de qué
  // tabla sale (Decisión 5, `doc-rate.ts`). Con foto de la factura no hace
  // falta —ahí ya viene congelada la que se usó—, pero sin foto el respaldo
  // tiene que ir a la tabla correcta y no a la TIIE por costumbre.
  const circuitOfDoc = snap.circuit ?? so[0].circuit_code;
  const baseOfDoc: FinancingBase = snap.financingBase ?? (financingCircuit(circuitOfDoc) === "SANTA_ROSA" ? "costo_margen" : "costo_comision");
  const tiiePick = snap.tiieIssue != null
    ? { rate: snap.tiieIssue, date: snap.tiieDate ?? issueDate }
    : docRate({
        base: baseOfDoc,
        which: "cobro",
        tiie: nearestRate(tiieRows.map((r) => ({ date: r.date, rate: Number(r.rate) })), issueDate),
        // Solo se va a la tabla de tasas si al documento le toca. El Panorama
        // llama a este cálculo hasta 500 veces por carga: una consulta que no
        // se va a usar, 500 veces, es la clase de cosa que la Decisión 89
        // acababa de limpiar.
        funding: usesFundingTable(baseOfDoc) ? nearestFunding(await fundingTableOf(sql, companyId), issueDate) : null,
      });
  const costSpread = snap.costSpread ?? pol.asrSpread;
  // Los días financiados son los de ESTE pedido (los mismos que se cobraron
  // dentro del precio), no un plazo fijo. Al contado no hay circuito.
  const financialDays = snap.financialDays ?? (fv[0] ? fv[0].credit_days : so[0].credit_days);
  // Paso 3: comisión y base son DEL CIRCUITO. Orden: la foto de la factura;
  // si no, lo congelado en la cotización; si no, el catálogo del circuito que
  // financia. Solo se resuelve si hace falta (crédito o días excedidos): un
  // pedido de contado no se detiene por un catálogo incompleto.
  const circuitCode = circuitOfDoc;
  const financingBase: FinancingBase = baseOfDoc;
  let commissionRate = snap.commissionRate ?? (so[0].q_commission != null ? Number(so[0].q_commission) : null);
  if (commissionRate == null && (financialDays > 0 || daysExceededPreview(fv[0], today) > 0)) {
    commissionRate = (await circuitTerms(sql, companyId, circuitCode)).commissionRate;
  }
  const commissionOrZero = commissionRate ?? 0;
  // Paso 4: las DOS tasas del lineal (Decisión 1), congeladas en la factura o,
  // si no, en la cotización. Nunca se inventan: si faltan, la protección
  // queda "sin dato", no en cero. La tasa de cobro entró al precio; la de
  // costo es lo que de verdad cuesta la línea; la protección es la diferencia.
  const costRate = snap.costRate ?? (so[0].q_cost_rate != null ? Number(so[0].q_cost_rate) : null);
  const collectionRate = snap.collectionRate ?? (so[0].q_collection_rate != null ? Number(so[0].q_collection_rate) : null);
  const exceededEnd = fv[0]?.paid_date && fv[0].paid_date < today ? fv[0].paid_date : today;
  const daysExceeded = fv[0]
    ? Math.max(0, daysBetween(fv[0].credit_due || fv[0].due_date, exceededEnd))
    : 0;
  const earlyPayDays = snap.earlyPayDays ?? pol.earlyPayDays;
  const earlyPaid = Boolean(fv[0]?.paid_date) && daysBetween(fv[0]!.date, fv[0]!.paid_date!) < earlyPayDays;
  const needsTiie = financialDays > 0 || daysExceeded > 0 || earlyPaid;
  const sinTiie = needsTiie && tiiePick == null;
  const tiieIssue = tiiePick?.rate ?? null;
  const sinTiieMotivo = sinTiie ? `sin TIIE en la tabla para ${dateDMY(issueDate)} (emisión)` : null;
  await ensureRefCost(sql);
  const raw = await sql<{
    product_id: number;
    code: string;
    name: string;
    qty: string;
    uom: string;
    unit_price: string;
    catalog_cost: string;
    ref_cost: string;
    po_cost: string | null;
    po_currency: string | null;
    po_fx: string | null;
    quote_cost: string | null;
    quote_freight: string;
    quote_other: string;
    quote_disbursed: string | null;
  }>`
    select sl.product_id, p.code, p.name, sl.qty::text, coalesce(sl.uom, p.uom) as uom, sl.unit_price::text,
      p.cost::text as catalog_cost,
      coalesce(p.ref_cost,0)::text as ref_cost,
      (
        select pl.unit_price::text from purchase_lines pl
        join purchase_orders po on po.id = pl.po_id
        where po.so_id = sl.so_id and pl.product_id = sl.product_id
        order by pl.id desc limit 1
      ) as po_cost,
      (
        select coalesce(po.currency,'MXN') from purchase_lines pl
        join purchase_orders po on po.id = pl.po_id
        where po.so_id = sl.so_id and pl.product_id = sl.product_id
        order by pl.id desc limit 1
      ) as po_currency,
      (
        select po.fx_rate::text from purchase_lines pl
        join purchase_orders po on po.id = pl.po_id
        where po.so_id = sl.so_id and pl.product_id = sl.product_id
        order by pl.id desc limit 1
      ) as po_fx,
      ql.cost::text as quote_cost,
      coalesce(ql.freight,0)::text as quote_freight,
      coalesce(ql.other_cost,0)::text as quote_other,
      ql.disbursed_unit::text as quote_disbursed
    from sales_lines sl
    join products p on p.id = sl.product_id
    left join quote_lines ql on ql.quote_id = ${so[0].quote_id} and ql.product_id = sl.product_id
    where sl.so_id = ${soId}
    order by sl.id
  `;
  const lines = raw.map((l) => {
    // Paso 5: por factura, la cantidad es lo que ESA factura facturó (0 si
    // este producto no viajó en ella); por pedido, la partida completa.
    const qty = opts.qtyByProduct ? (opts.qtyByProduct.get(l.product_id) ?? 0) : Number(l.qty);
    const saleUnit = Number(l.unit_price);
    // Decisión 76: el costo de la OC entra en pesos (USD × TC de la OC). Una OC en
    // dólares sin TC real no se resta contra pesos: la partida se excluye con motivo.
    const poCost = poCostToMxn({ unitPrice: l.po_cost, currency: l.po_currency, fx: l.po_fx });
    const poSinTc = l.po_cost != null && poCost == null;
    const quoteCost = l.quote_cost != null ? Number(l.quote_cost) : null;
    // El costo real manda: OC del proveedor, luego el de la cotización. Si no
    // hay ninguno, el del catálogo con el orden único (kardex → referencia).
    // Un 0 en la cotización es "no se capturó", igual que en Cotizaciones.
    const catalogo = resolveCost({ avgCost: l.catalog_cost, refCost: l.ref_cost });
    const quoteReal = quoteCost != null && quoteCost > 0 ? quoteCost : null;
    const sinCosto = poCost == null && quoteReal == null && catalogo.source === "ninguno";
    const costUnit = poCost ?? quoteReal ?? catalogo.cost;
    const costSource = poCost != null ? "OC" : quoteReal != null ? "cotización" : sinCosto ? "sin costo" : catalogo.source === "referencia" ? "referencia" : "catálogo";
    // Una partida sin costo NO entra a la utilidad (entraría como 100% de
    // ganancia). Queda etiquetada y aparte, con su motivo.
    const excludeReason =
      sinTiieMotivo ?? (poSinTc ? "OC en dólares sin tipo de cambio (captúralo en Compras)" : sinCosto ? "sin costo (ni OC, ni cotización, ni kardex, ni referencia)" : null);
    const excluded = excludeReason != null;
    const freightUnit = Number(l.quote_freight);
    const otherUnit = Number(l.quote_other);
    const sale = qty * saleUnit;
    const cogs = excluded ? 0 : qty * costUnit;
    const freight = excluded ? 0 : qty * freightUnit;
    const other = excluded ? 0 : qty * otherUnit;
    // COSTO PUESTO: el flete se prorratea al costo del producto y ese es el
    // costo total del que sale todo. Es la MISMA base que usó el precio
    // (pricing.ts: landedUnit = costo + flete + otros), así que el
    // financiamiento que se le cobró al cliente y el que se calcula aquí son
    // el mismo número. Antes esta base era solo la mercancía y la tarjeta
    // quedaba corta por el financiamiento del flete.
    const landed = cogs + freight + other;
    // Spread cambiario del deal (MODELO-NEGOCIO.md § 11.7): con OC y pedido en
    // dólares, lo que el margen trae por la diferencia entre el TC pactado con el
    // cliente y el TC del proveedor. Informativo: ya vive dentro de venta − costo.
    const fxSpread =
      !excluded && l.po_currency === "USD" && poCost != null && so[0].currency === "USD" && isUsdFx(so[0].fx_rate)
        ? Math.round(qty * Number(l.po_cost) * (Number(so[0].fx_rate) - Number(l.po_fx)) * 100) / 100
        : 0;
    // Costo financiero del circuito hermana: comisión + Capa 1 con los días
    // de crédito del pedido (los mismos cobrados al cliente en el precio) +
    // Capa 2 (días excedidos, no previstos). Al contado no hay circuito.
    const asr = financingBase === "costo_comision";
    const fin =
      asr && !excluded && tiieIssue != null && (financialDays > 0 || daysExceeded > 0)
        ? financeCost({
            supplierCost: financialDays > 0 ? landed : 0,
            saleCapital: sale,
            commissionRate: commissionOrZero,
            costSpread,
            tiieAtIssue: tiieIssue,
            financialDays: Math.max(0, financialDays),
            daysExceeded,
          })
        : { commission: 0, layer1: 0, layer2: 0, total: 0 };
    const finance = fin.total;
    // LINEAL: Azagro le factura a Santa Rosa costo + margen (lo desembolsado,
    // congelado por partida al cotizar) y Santa Rosa le agrega al cliente el
    // financiamiento. La venta de Azagro es esa factura; el financiamiento es
    // de Santa Rosa, no un costo de Azagro. Así la partición queda como en
    // DISENO § 5 (margen 6,951.87 · financiamiento 4,924.24), no como la del
    // motor ASR (320.08 mal atribuidos).
    let disbursed = 0;
    if (!asr && !excluded) {
      const perUnit =
        l.quote_disbursed != null
          ? Number(l.quote_disbursed)
          : financialDays > 0 && tiieIssue != null
            ? linealMarginFromPrice({ price: saleUnit, landed: costUnit + freightUnit + otherUnit, rate: tiieIssue + costSpread, days: financialDays, mode: "pct" }).disbursed
            : saleUnit;
      disbursed = qty * perUnit;
    }
    const financierFinance = !asr && !excluded ? Math.round((sale - disbursed) * 100) / 100 : 0;
    // Paso 4: LA PROTECCIÓN SE VE POR SEPARADO. Lineal: costo real de la línea
    // = lo desembolsado × (tasa de costo + spread) × días / 360; protección =
    // lo que se le cobró al cliente − ese costo (0.15 puntos en DISENO § 5:
    // 66.84 de 4,924.24). Sin tasa de costo congelada no se estima: null.
    // ASR: una sola tasa, el costo financiero ES el costo real, protección 0.
    let lineCost: number | null = asr ? finance : null;
    let protection: number | null = asr ? 0 : null;
    if (!asr && !excluded && financialDays > 0 && costRate != null) {
      lineCost = Math.round(((disbursed * (costRate + costSpread) * financialDays) / YEAR_DAYS) * 100) / 100;
      protection = Math.round((financierFinance - lineCost) * 100) / 100;
    } else if (!asr && !excluded && financialDays <= 0) {
      lineCost = 0;
      protection = 0;
    }
    const revenueLine = asr ? sale : excluded ? 0 : disbursed;
    const margin = excluded ? 0 : revenueLine - cogs - freight - other;
    return {
      productId: l.product_id,
      code: l.code,
      name: l.name,
      qty,
      uom: l.uom,
      saleUnit,
      sale,
      costUnit: excluded ? 0 : costUnit,
      costSource,
      cogs,
      freightUnit,
      freight,
      other,
      landed,
      finance,
      commission: fin.commission,
      layer1: fin.layer1,
      layer2: fin.layer2,
      margin,
      marginPct: !excluded && revenueLine > 0 ? (margin / revenueLine) * 100 : 0,
      /** Lineal: factura de Azagro a Santa Rosa (costo + margen). ASR: 0. */
      disbursed,
      /** Lineal: lo que Santa Rosa le cobra al cliente por financiar (venta − factura a Santa Rosa). ASR: 0. */
      financierFinance,
      /** Costo real de la línea (tasa de costo). ASR: = finance. Lineal sin tasa de costo congelada: null. */
      lineCost,
      /** Protección = cobrado al cliente − costo real. ASR: 0. Lineal sin tasa de costo: null. */
      protection,
      revenueLine,
      fxSpread,
      excluded,
      excludeReason,
    };
  });
  const included = lines.filter((l) => !l.excluded);
  const excludedLines = lines.filter((l) => l.excluded);
  const excluded = {
    n: excludedLines.length,
    venta: excludedLines.reduce((s, l) => s + l.sale, 0),
    motivos: [...new Set(excludedLines.map((l) => l.excludeReason!))],
  };
  const expenses = opts.orderLevel ? await orderExpenses(sql, companyId, soId) : [];
  const expPedido = expenses.filter((e) => e.class === "pedido").reduce((s, e) => s + e.amount, 0);
  const expOther = expenses.filter((e) => e.class !== "pedido").reduce((s, e) => s + e.amount, 0);
  const { mora, moraPendiente } = opts.orderLevel ? await orderMora(sql, companyId, soId) : { mora: 0, moraPendiente: 0 };
  // DECISIÓN 87 — el diferencial de la COMPRA entra a la utilidad del pedido.
  // Es del pedido entero, como los gastos y la mora: se lee una sola vez y no
  // se reparte entre facturas de venta. Va en campo PROPIO, nunca sumado a
  // `fxIncome`: el Panorama agrega `d.fxIncome` por razón social del CLIENTE
  // (:815), y meterlo ahí haría aparecer una pérdida del proveedor como «Dif.
  // TC» de un cliente que no tuvo nada que ver.
  const compraFx = opts.orderLevel
    ? await purchaseFxOfDeal(sql, companyId, soId)
    : { ligado: false, fxCompra: 0, facturas: [] as Awaited<ReturnType<typeof purchaseFxOfDeal>>["facturas"] };
  // Solo las partidas con costo (y con TIIE cuando hace falta) entran al
  // cálculo; las excluidas se reportan aparte.
  // ASR: la venta es al cliente. Lineal: la venta de Azagro es la factura a
  // Santa Rosa (costo + margen); el precio al cliente se reporta aparte.
  const revenue = included.reduce((s, l) => s + l.revenueLine, 0);
  const clientPrice = included.reduce((s, l) => s + l.sale, 0);
  const disbursed = included.reduce((s, l) => s + l.disbursed, 0);
  const financierFinance = Math.round(included.reduce((s, l) => s + l.financierFinance, 0) * 100) / 100;
  // Paso 4: costo real de la línea y protección, sumados. Si alguna partida
  // del lineal no tiene tasa de costo congelada, el total queda "sin dato".
  const protectionKnown = included.every((l) => l.lineCost != null && l.protection != null);
  const lineCost = protectionKnown ? Math.round(included.reduce((s, l) => s + (l.lineCost ?? 0), 0) * 100) / 100 : null;
  const protection = protectionKnown ? Math.round(included.reduce((s, l) => s + (l.protection ?? 0), 0) * 100) / 100 : null;
  const cogs = included.reduce((s, l) => s + l.cogs, 0);
  const freightQuote = included.reduce((s, l) => s + l.freight, 0);
  const otherQuote = included.reduce((s, l) => s + l.other, 0);
  const commission = included.reduce((s, l) => s + l.commission, 0);
  const layer1 = included.reduce((s, l) => s + l.layer1, 0);
  const layer2 = included.reduce((s, l) => s + l.layer2, 0);
  const finance = commission + layer1 + layer2;
  // Base sobre la que corrió el costo financiero: costo puesto (mercancía +
  // flete + otros), la misma que el precio le cobró al cliente.
  const financeBase = included.reduce((s, l) => s + l.landed, 0);
  const freight = freightQuote + expPedido;
  // Descuento por pronto pago: si la factura se liquidó antes del umbral,
  // se bonifican los días hasta el plazo financiero a la tasa de costo.
  // La tasa de COSTO del documento (N1, Decisión 5): en ASR es la TIIE —ese
  // circuito solo tiene una—, en lineal es la columna de costo congelada, NO
  // la de cobro, que lleva la protección adentro y estimaría de más. Es la
  // misma que aplica `applyInvoicePayment` al perdonar de verdad.
  const bonoRate = usesFundingTable(financingBase) ? costRate : tiieIssue;
  const bono = fv[0]?.paid_date && bonoRate != null && !sinTiie
    ? earlyPayBonus({
        cargo: Number(fv[0].amount),
        issueDate: fv[0].date,
        payDate: fv[0].paid_date,
        thresholdDays: earlyPayDays,
        financialDays,
        tiieAtIssue: bonoRate,
        costSpread,
      })
    : { applies: false, bonus: 0, days: 0, lived: 0, rate: 0 };
  const discount = bono.applies ? bono.bonus : 0;
  // Diferencial cambiario que se decidió dejar como utilidad/pérdida al
  // cobrar (fx_result). Lo que se convirtió en documento ATC es cartera, no
  // utilidad — igual que el Excel.
  const fxIncome = fv[0] ? Number(fv[0].fx_result) : 0;
  const fxSpread = Math.round(included.reduce((s, l) => s + l.fxSpread, 0) * 100) / 100;
  const fxCompra = compraFx.fxCompra;
  const margin = revenue - cogs - freight - otherQuote - expOther;
  // Utilidad real de la operación, como el Excel:
  // + venta + mora + diferencial cambiario
  // − costo proveedor − comisión − Capa 1 − Capa 2 − descuento pronto pago.
  // Los DOS diferenciales realizados, cada uno con su signo ya puesto
  // (MODELO-NEGOCIO § 11.7): el del cobro al cliente y el del pago al
  // proveedor. Decisión 87.
  const netProfit = margin + mora + fxIncome + fxCompra - finance - discount;
  // Las cuatro visiones de la hoja PANORAMA:
  // devengada (todo) · realizada (sin la mora aún no cobrada) ·
  // en caja (solo facturas 100% cobradas) · proporcional (parte pagada).
  const fvAmount = fv[0] ? Number(fv[0].amount) : 0;
  const fvResidual = fv[0] ? Number(fv[0].residual) : 0;
  const paidRatio = fvAmount > 0 ? Math.min(1, Math.max(0, (fvAmount - fvResidual) / fvAmount)) : 0;
  const fullyPaid = Boolean(fv[0]) && fvResidual <= 0.009;
  const utilidadDevengada = netProfit;
  const utilidadRealizada = netProfit - moraPendiente;
  const utilidadCaja = fullyPaid ? utilidadRealizada : 0;
  const utilidadProporcional = netProfit * paidRatio;
  return {
    name: so[0].name,
    currency: so[0].currency,
    creditDays: so[0].credit_days,
    // Paso 3: por dónde corrió el financiamiento y su partición.
    circuit: circuitCode,
    financingBase,
    clientPrice,
    disbursed,
    financierFinance,
    commissionRate,
    costRate,
    collectionRate,
    spread: costSpread,
    // Paso 4: el costo financiero desglosado. ASR: lineCost = finance, protección 0.
    lineCost,
    protection,
    financeRate: tiieIssue != null ? tiieIssue + costSpread : null,
    tiieIssue,
    tiieDate: tiiePick?.date ?? null,
    financialDays,
    daysExceeded,
    lines,
    excluded,
    expenses,
    revenue,
    cogs,
    freight,
    freightQuote,
    expPedido,
    other: otherQuote + expOther,
    commission,
    layer1,
    layer2,
    finance,
    financeBase,
    discount,
    fxIncome,
    fxCompra,
    // Si el pedido no tiene compra ligada, `fxCompra` es 0 pero NO porque no
    // haya diferencial: porque no hay forma de saber cuál le toca. La pantalla
    // lo dice con esas palabras; un cero mudo sería mentir.
    compraLigada: compraFx.ligado,
    fpsDelPedido: compraFx.facturas,
    fxSpread,
    margin,
    marginPct: revenue > 0 ? (margin / revenue) * 100 : 0,
    marginAfterFinance: netProfit,
    netProfit,
    netProfitPct: revenue > 0 ? (netProfit / revenue) * 100 : 0,
    mora,
    moraPendiente,
    moraCobrada: mora - moraPendiente,
    paidRatio,
    fullyPaid,
    utilidadDevengada,
    utilidadRealizada,
    utilidadCaja,
    utilidadProporcional,
  };
}

export const listDealPnl = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ from: z.string().optional(), to: z.string().optional() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const me = await assertCan(sql, context.userId, "credit", "view");
    if (!canSeeMargins(me.role)) throw new Error("Sin permiso para ver márgenes");
    const own = await activeMember(sql, context.userId);
    const companyId = await cid(sql, context.userId);
    const from = (data.from || "2000-01-01").slice(0, 10);
    const to = (data.to || "2099-12-31").slice(0, 10);
    const orders = await sql<{
      id: number;
      name: string;
      date: string;
      state: string;
      partner: string;
      currency: string;
    }>`
      select s.id, s.name, s.date::text, s.state, p.name as partner, s.currency
      from sales_orders s
      join partners p on p.id = s.partner_id
      where s.company_id = ${companyId} and s.date between ${from} and ${to}
        and (${own.own_only} = false or p.seller_id = ${context.userId} or p.seller_id is null)
      order by s.date desc, s.id desc
      limit 200
    `;
    const deals = [];
    for (const o of orders) {
      const d = await computeDealPnl(sql, companyId, o.id);
      deals.push({
        id: o.id,
        name: o.name,
        date: o.date,
        state: o.state,
        partner: o.partner,
        currency: o.currency,
        revenue: d.revenue,
        cogs: d.cogs,
        freight: d.freight,
        finance: d.finance,
        // Paso 4: por dónde corrió y el costo financiero desglosado.
        circuit: d.circuit,
        financingBase: d.financingBase,
        clientPrice: d.clientPrice,
        financierFinance: d.financierFinance,
        lineCost: d.lineCost,
        protection: d.protection,
        margin: d.margin,
        marginPct: d.marginPct,
        // Decisión 87: la utilidad final lleva el diferencial del pago al
        // proveedor, así que el Excel tiene que traerlo como columna o no
        // cuadra con la utilidad que enseña al lado.
        fxCompra: d.fxCompra ?? 0,
        netProfit: d.netProfit,
        netProfitPct: d.netProfitPct,
        excluidas: d.excluded.n,
        ventaExcluida: d.excluded.venta,
        motivos: d.excluded.motivos,
      });
    }
    const totals = deals.reduce(
      (s, d) => ({
        revenue: s.revenue + d.revenue,
        cogs: s.cogs + d.cogs,
        freight: s.freight + d.freight,
        finance: s.finance + d.finance,
        financierFinance: s.financierFinance + d.financierFinance,
        // null se propaga: un total con una partida sin tasa de costo no se inventa.
        lineCost: s.lineCost == null || d.lineCost == null ? null : s.lineCost + d.lineCost,
        protection: s.protection == null || d.protection == null ? null : s.protection + d.protection,
        margin: s.margin + d.margin,
        netProfit: s.netProfit + d.netProfit,
        excluidas: s.excluidas + d.excluidas,
        ventaExcluida: s.ventaExcluida + d.ventaExcluida,
      }),
      {
        revenue: 0,
        cogs: 0,
        freight: 0,
        finance: 0,
        financierFinance: 0,
        lineCost: 0 as number | null,
        protection: 0 as number | null,
        margin: 0,
        netProfit: 0,
        excluidas: 0,
        ventaExcluida: 0,
      },
    );
    // Cuántas partidas quedaron fuera y por qué (suma por motivo).
    const motivos = new Map<string, number>();
    for (const d of deals) for (const m of d.motivos) motivos.set(m, (motivos.get(m) ?? 0) + 1);
    return { from, to, deals, totals, excluidas: { n: totals.excluidas, venta: totals.ventaExcluida, motivos: [...motivos.entries()].map(([motivo, pedidos]) => ({ motivo, pedidos })) } };
  });

export const getCompanyPnl = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ from: z.string(), to: z.string() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const me = await assertCan(sql, context.userId, "credit", "view");
    if (!canSeeMargins(me.role)) throw new Error("Sin permiso para ver márgenes");
    const companyId = await cid(sql, context.userId);
    const from = data.from.slice(0, 10);
    const to = data.to.slice(0, 10);

    const sales = await sql<{ n: number; amount: string }>`
      -- El importe suma TODO lo del lado cliente (una nota de crédito resta,
      -- que es lo correcto), pero el CONTEO es de facturas: una NC no es una
      -- venta más. Antes «3 facturas producto» podían ser dos ventas y una
      -- devolución (19-sep-2026).
      --
      -- Se excluye por el prefijo de la NC, no se incluye por el de la FV: las
      -- facturas del corte Compaq traen SU folio de Compaq, no uno FV-, y
      -- filtrar por FV las habria dejado de contar sin que nadie lo pidiera.
      select count(*) filter (where name not like 'NC-%')::int as n, coalesce(sum(amount),0)::text as amount
      from invoices
      where company_id = ${companyId} and kind = 'customer' and coalesce(inv_class,'product') = 'product'
        and state <> 'reversed' and reverses_id is null
        and date between ${from} and ${to}
    `;
    const mora = await sql<{ amount: string }>`
      select coalesce(sum(amount),0)::text as amount
      from invoices
      where company_id = ${companyId} and kind = 'customer' and inv_class = 'interest'
        and state <> 'reversed' and reverses_id is null
        and date between ${from} and ${to}
    `;
    const purchases = await sql<{ amount: string }>`
      select coalesce(sum(amount),0)::text as amount
      from invoices
      where company_id = ${companyId} and kind = 'supplier'
        and state <> 'reversed'
        and date between ${from} and ${to}
        and coalesce(inv_class,'product') <> 'fx'
    `;
    let expOp = 0;
    let expPedido = 0;
    let expFin = 0;
    try {
      const exp = await sql<{ class: string; amount: string }>`
        select class, coalesce(sum(amount),0)::text as amount
        from expenses
        where company_id = ${companyId} and date between ${from} and ${to}
        group by class
      `;
      for (const r of exp) {
        if (r.class === "pedido") expPedido = Number(r.amount);
        else if (r.class === "financiero") expFin = Number(r.amount);
        else expOp = Number(r.amount);
      }
    } catch {
      /* empty */
    }
    const collections = await sql<{ amount: string }>`
      select coalesce(sum(amount),0)::text as amount
      from payments
      where company_id = ${companyId} and kind = 'inbound' and date between ${from} and ${to}
    `;
    const payouts = await sql<{ amount: string }>`
      select coalesce(sum(amount),0)::text as amount
      from payments
      where company_id = ${companyId} and kind = 'outbound' and date between ${from} and ${to}
    `;
    const revenue = Number(sales[0]?.amount ?? 0);
    const cogs = Number(purchases[0]?.amount ?? 0);
    const moraIn = Number(mora[0]?.amount ?? 0);
    // DECISIÓN 92 — el movimiento del dólar es resultado del periodo, y faltaba.
    // Entra solo lo ABSORBIDO: lo que se convirtió en documento de ajuste sigue
    // siendo cartera, no pérdida (la regla del Excel, la misma que aplica
    // `dealPnlCore` del lado cliente). Sale del MISMO lugar que la pantalla:
    // nunca dos cuentas del mismo hecho.
    const fx = await fxCostOfPeriod(sql, companyId, from, to);
    const gross = revenue - cogs - expPedido;
    const operating = gross - expOp;
    const net = operating - expFin + moraIn + fx.absorbido;
    return {
      from,
      to,
      salesN: sales[0]?.n ?? 0,
      revenue,
      purchases: cogs,
      freight: expPedido,
      operativo: expOp,
      financiero: expFin,
      mora: moraIn,
      fxAbsorbido: fx.absorbido,
      fxEnAjuste: fx.enAjuste,
      fxTotal: fx.total,
      gross,
      operating,
      net,
      collected: Number(collections[0]?.amount ?? 0),
      paidOut: Number(payouts[0]?.amount ?? 0),
    };
  });

/**
 * PANORAMA — estado de resultados por razón social y consolidado del grupo,
 * como las hojas EDO_RESULTADOS_RS y PANORAMA del Excel: P&L por cliente,
 * cobranza de capital e intereses, ajustes de TC pendientes y las cuatro
 * visiones de utilidad (devengada / realizada / en caja / proporcional).
 */
// El Panorama vive debajo del «Desde / Hasta» de Reportes y hasta el 19-sep-2026
// lo ignoraba: cambiabas las fechas y la tabla no se movía, porque tomaba los
// últimos 500 pedidos sin mirar el rango. El mismo molde que su vecina
// `listDealPnl`: rango opcional, y sin él todo (para el que lo llame sin fechas).
export const getPanorama = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ from: z.string().optional(), to: z.string().optional() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const me = await assertCan(sql, context.userId, "credit", "view");
    if (!canSeeMargins(me.role)) throw new Error("Sin permiso para ver márgenes");
    const own = await activeMember(sql, context.userId);
    const companyId = await cid(sql, context.userId);
    const from = (data.from || "2000-01-01").slice(0, 10);
    const to = (data.to || "2099-12-31").slice(0, 10);
    const orders = await sql<{ id: number; partner: string; group_name: string }>`
      select s.id, p.name as partner, coalesce(p.group_name, '') as group_name
      from sales_orders s
      join partners p on p.id = s.partner_id
      where s.company_id = ${companyId} and s.date between ${from} and ${to}
        and (${own.own_only} = false or p.seller_id = ${context.userId} or p.seller_id is null)
      order by s.id desc
      limit 500
    `;
    type Row = {
      partner: string;
      group: string;
      venta: number;
      mora: number;
      fx: number;
      /** Decisión 87: el diferencial del PAGO al proveedor, en columna propia. */
      fxCompra: number;
      costo: number;
      comision: number;
      capa1: number;
      capa2: number;
      descuento: number;
      /** Paso 4 — lineal: financiamiento de Santa Rosa (lo paga el cliente) y su protección. ASR: 0. */
      financiamientoSR: number;
      proteccion: number | null;
      utilidad: number;
      realizada: number;
      caja: number;
      proporcional: number;
      excluidas: number;
      ventaExcluida: number;
    };
    const byPartner = new Map<string, Row>();
    const motivos = new Map<string, number>();
    for (const o of orders) {
      const d = await computeDealPnl(sql, companyId, o.id);
      const r = byPartner.get(o.partner) ?? {
        partner: o.partner,
        group: o.group_name,
        venta: 0, mora: 0, fx: 0, fxCompra: 0, costo: 0, comision: 0, capa1: 0, capa2: 0,
        descuento: 0, financiamientoSR: 0, proteccion: 0, utilidad: 0, realizada: 0, caja: 0, proporcional: 0,
        excluidas: 0, ventaExcluida: 0,
      };
      r.excluidas += d.excluded.n;
      r.ventaExcluida += d.excluded.venta;
      for (const m of d.excluded.motivos) motivos.set(m, (motivos.get(m) ?? 0) + 1);
      r.venta += d.revenue;
      r.mora += d.mora;
      r.fx += d.fxIncome;
      // Decisión 87: columna PROPIA. `r.fx` agrega por razón social del CLIENTE;
      // si el del proveedor se sumara ahí, la tabla enseñaría una pérdida de
      // compra como diferencial de un cliente que no tuvo nada que ver — y la
      // utilidad dejaría de cuadrar con las columnas que la explican.
      r.fxCompra += d.fxCompra ?? 0;
      r.costo += d.cogs;
      r.comision += d.commission;
      r.capa1 += d.layer1;
      r.capa2 += d.layer2;
      r.descuento += d.discount;
      r.financiamientoSR += d.financierFinance;
      r.proteccion = r.proteccion == null || d.protection == null ? null : r.proteccion + d.protection;
      r.utilidad += d.utilidadDevengada;
      r.realizada += d.utilidadRealizada;
      r.caja += d.utilidadCaja;
      r.proporcional += d.utilidadProporcional;
      byPartner.set(o.partner, r);
    }
    const porRazon = [...byPartner.values()]
      .filter((r) => r.venta !== 0 || r.mora !== 0 || r.excluidas !== 0)
      .sort((a, b) => b.venta - a.venta);
    const sum = (f: (r: Row) => number) => porRazon.reduce((s, r) => s + f(r), 0);
    const totales = {
      venta: sum((r) => r.venta),
      mora: sum((r) => r.mora),
      fx: sum((r) => r.fx),
      fxCompra: sum((r) => r.fxCompra),
      costo: sum((r) => r.costo),
      comision: sum((r) => r.comision),
      capa1: sum((r) => r.capa1),
      capa2: sum((r) => r.capa2),
      descuento: sum((r) => r.descuento),
      financiamientoSR: sum((r) => r.financiamientoSR),
      proteccion: porRazon.some((r) => r.proteccion == null) ? null : sum((r) => r.proteccion ?? 0),
      utilidad: sum((r) => r.utilidad),
      realizada: sum((r) => r.realizada),
      caja: sum((r) => r.caja),
      proporcional: sum((r) => r.proporcional),
      excluidas: sum((r) => r.excluidas),
      ventaExcluida: sum((r) => r.ventaExcluida),
    };
    const excluidas = {
      n: totales.excluidas,
      venta: totales.ventaExcluida,
      motivos: [...motivos.entries()].map(([motivo, pedidos]) => ({ motivo, pedidos })),
    };

    // Cobranza (capital, mora y ajustes de TC) — sobre facturas reales.
    const cap = await sql<{ facturado: string; pendiente: string }>`
      select coalesce(sum(amount),0)::text as facturado, coalesce(sum(residual),0)::text as pendiente
      from invoices
      where company_id = ${companyId} and kind = 'customer' and coalesce(inv_class,'product') = 'product' and amount > 0
        and state <> 'reversed'
    `;
    const morat = await sql<{ total: string; pendiente: string }>`
      select coalesce(sum(amount),0)::text as total, coalesce(sum(residual),0)::text as pendiente
      from invoices
      where company_id = ${companyId} and kind = 'customer' and inv_class = 'interest'
        and state <> 'reversed' and reverses_id is null
    `;
    const fxDocs = await sql<{ por_cobrar: string; por_devolver: string }>`
      select
        coalesce(sum(case when residual > 0 then residual else 0 end),0)::text as por_cobrar,
        coalesce(sum(case when residual < 0 then -residual else 0 end),0)::text as por_devolver
      from invoices
      where company_id = ${companyId} and kind = 'customer' and inv_class = 'fx' and state = 'open'
    `;
    const capitalFacturado = Number(cap[0]?.facturado ?? 0);
    const capitalPendiente = Number(cap[0]?.pendiente ?? 0);
    const moraTotal = Number(morat[0]?.total ?? 0);
    const moraPend = Number(morat[0]?.pendiente ?? 0);
    const fxPorCobrar = Number(fxDocs[0]?.por_cobrar ?? 0);
    const fxPorDevolver = Number(fxDocs[0]?.por_devolver ?? 0);
    return {
      porRazon,
      totales,
      excluidas,
      cobranza: {
        capitalFacturado,
        capitalPagado: capitalFacturado - capitalPendiente,
        capitalPendiente,
        moraTotal,
        moraCobrada: moraTotal - moraPend,
        moraPendiente: moraPend,
        fxPorCobrar,
        fxPorDevolver,
        granTotalPorCobrar: capitalPendiente + moraPend + fxPorCobrar,
      },
    };
  });

/**
 * Saldos por vencer por mes futuro (base de la propuesta de pago): cuánto
 * capital llega a su plazo financiero cada mes y cuánto interés correría por
 * mes de 30 días si no se paga.
 */
export const getUpcomingDue = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    await assertCan(sql, context.userId, "credit", "view");
    const own = await activeMember(sql, context.userId);
    const companyId = await cid(sql, context.userId);
    const pol = await policy(sql, companyId);
    const tiieRows = await sql<{ date: string; rate: string }>`
      select date::text, rate::text from tiie_rates where company_id = ${companyId} order by date
    `;
    const tiieTable = tiieRows.map((r) => ({ date: r.date, rate: Number(r.rate) }));
    // Cada factura se estima con la tabla de la que salió su precio (Decisión
    // 5, `doc-rate.ts`): ASR con la TIIE, lineal con la columna de COBRO.
    const fundingTable = await fundingTableOf(sql, companyId);
    const baseOf = new Map((await readCircuits(sql, companyId)).map((c) => [c.code as string, c.financingBase as string | null]));
    const open = await sql<{
      amount: string;
      residual: string;
      currency: string;
      due_date: string;
      credit_due: string | null;
      inv_class: string;
      circuit_code: string | null;
    }>`
      select i.amount::text, i.residual::text, coalesce(i.currency,'MXN') as currency, i.due_date::text, i.credit_due::text,
        coalesce(i.inv_class,'product') as inv_class, i.circuit_code
      from invoices i
      join partners p on p.id = i.partner_id
      -- Los AJUSTES POR TC entran (19-sep-2026): son dinero que de verdad va a
      -- entrar, y dejarlos fuera hacía que «lo que viene» dijera de menos. Su
      -- gemela del lado proveedor siempre los contó, así que además las dos
      -- caras decían cosas distintas del mismo hecho. Lo que NO hacen es
      -- generar interés: un ajuste no tiene plazo financiero que correr, y por
      -- eso se saltan la estimación de abajo en vez de estimarles una.
      where i.company_id = ${companyId} and i.kind = 'customer'
        and coalesce(i.inv_class,'product') in ('product','fx')
        and i.state = 'open' and i.residual > 0.009 and i.amount > 0
        and (${own.own_only} = false or p.seller_id = ${context.userId} or p.seller_id is null)
    `;
    const today = todayMx();
    type Bucket = { month: string; n: number; saldo: number; saldoMxnDocs: number; saldoUsdDocs: number; interesMensual: number };
    const buckets = new Map<string, Bucket>();
    const vencido: Bucket = { month: "vencido", n: 0, saldo: 0, saldoMxnDocs: 0, saldoUsdDocs: 0, interesMensual: 0 };
    // Facturas cuyo plazo no tiene TIIE en la tabla: el saldo sí cuenta, el
    // interés no se estima (se reporta cuántas quedaron sin estimar).
    let sinTiie = 0;
    for (const inv of open) {
      const moraDue = inv.credit_due || inv.due_date;
      const saldo = Number(inv.residual);
      // Un ajuste por TC no tiene plazo financiero: entra al saldo pero no
      // estima interés, y tampoco cuenta como «sin TIIE» (no le falta un dato,
      // es que no aplica).
      const esAjuste = inv.inv_class === "fx";
      const pick = esAjuste
        ? null
        : docRate({
            base: baseOf.get(inv.circuit_code ?? "") ?? null,
            which: "cobro",
            tiie: nearestRate(tiieTable, moraDue),
            funding: nearestFunding(fundingTable, moraDue),
          });
      if (!pick && !esAjuste) sinTiie += 1;
      const rate = pick ? pick.rate + pol.collectionSpread : 0;
      // El interés corre sobre el CARGO original una vez vencido el plazo; el
      // "× 30 / 360" es la unidad del reporte (interés de un mes de 30 días).
      const interesMensual = pick ? (Number(inv.amount) * rate * 30) / 360 : 0;
      const target = moraDue < today ? vencido : (() => {
        const key = moraDue.slice(0, 7);
        const b = buckets.get(key) ?? { month: key, n: 0, saldo: 0, saldoMxnDocs: 0, saldoUsdDocs: 0, interesMensual: 0 };
        buckets.set(key, b);
        return b;
      })();
      target.n += 1;
      target.saldo += saldo;
      if (inv.currency === "USD") target.saldoUsdDocs += saldo;
      else target.saldoMxnDocs += saldo;
      target.interesMensual += interesMensual;
    }
    const meses = [...buckets.values()].sort((a, b) => a.month.localeCompare(b.month));
    return { vencido, meses, spread: pol.collectionSpread, sinTiie };
  });

/**
 * El mismo bucketing por mes de `getUpcomingDue`, para lo que Azagro le debe
 * al proveedor. Sin interés (Azagro no paga mora a proveedor en este
 * sistema): solo capital por vencer, agrupado por el mes de `due_date`. Para
 * el inicio (bloque "próximos meses"), no para cartera detallada.
 */
export const getUpcomingPayable = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    await assertCan(sql, context.userId, "credit", "view");
    const companyId = await cid(sql, context.userId);
    // El filtro era `residual > 0.009` y dejaba fuera la MITAD de los ajustes
    // por tipo de cambio del proveedor: el ATC nace con `-fxDiff`, así que si a
    // Azagro le sobró pagar nace NEGATIVO («POR COBRAR AL PROVEEDOR») y no lo
    // sumaba ningún total del sistema — dinero a favor que no se veía en
    // ninguna pantalla. Ahora entra restando lo que se le debe a ese proveedor,
    // que es lo que de verdad va a salir del banco (18-sep-2026).
    //
    // Los ajustes por TC SÍ cuentan aquí, y desde el 19-sep-2026 también en
    // `getUpcomingDue`: las dos caras dicen lo mismo del mismo hecho.
    const open = await sql<{ residual: string; due_date: string }>`
      select residual::text, due_date::text from invoices
      where company_id = ${companyId} and kind = 'supplier' and state = 'open' and abs(residual) > 0.009
    `;
    const today = todayMx();
    type Bucket = { month: string; n: number; saldo: number };
    const buckets = new Map<string, Bucket>();
    const vencido: Bucket = { month: "vencido", n: 0, saldo: 0 };
    for (const inv of open) {
      const saldo = Number(inv.residual);
      const target = inv.due_date < today ? vencido : (() => {
        const key = inv.due_date.slice(0, 7);
        const b = buckets.get(key) ?? { month: key, n: 0, saldo: 0 };
        buckets.set(key, b);
        return b;
      })();
      target.n += 1;
      target.saldo += saldo;
    }
    const meses = [...buckets.values()].sort((a, b) => a.month.localeCompare(b.month));
    return { vencido, meses };
  });

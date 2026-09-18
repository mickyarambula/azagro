/**
 * BLOQUE DE PARCIALES, paso 0(a) (PARCIALES.md § 5, patrón A6 de
 * PATRONES-DISENO.md): el cuadre. Si el sistema recibe/entrega cien unidades,
 * tiene que poder decir dónde quedaron las cien — cada unidad cae en
 * exactamente una casilla.
 *
 * Funciones puras, sin acceso a base: las cantidades ya vienen sumadas por
 * SQL (Σ movimientos vivos por producto/bodega, Σ renglones de FV vivas por
 * pedido/producto) — esto solo verifica la identidad. `cerradaCorta` es la
 * casilla que nace en el paso 7 (hoy siempre 0, nadie la escribe todavía):
 * queda en la firma para que el día que exista no haya que tocar esta
 * función, solo dejar de pasar 0.
 */

export type PurchaseLineRecon = { qty: number; qtyReceived: number; cerradaCorta?: number };
export type PurchaseLineGap = {
  qty: number;
  recibida: number;
  pendiente: number;
  cerradaCorta: number;
  /** qty − (recibida + pendiente + cerradaCorta). Debe ser 0. */
  gap: number;
};

export function reconcilePurchaseLine(l: PurchaseLineRecon): PurchaseLineGap {
  const cerradaCorta = l.cerradaCorta ?? 0;
  const pendiente = Math.max(0, l.qty - l.qtyReceived - cerradaCorta);
  const gap = l.qty - (l.qtyReceived + pendiente + cerradaCorta);
  return { qty: l.qty, recibida: l.qtyReceived, pendiente, cerradaCorta, gap };
}

export type SalesLineRecon = {
  qty: number;
  qtyDelivered: number;
  qtyReturned: number;
  invoicedQty: number;
  cerradaCorta?: number;
};
export type SalesLineGap = {
  qty: number;
  entregadaViva: number;
  facturadaViva: number;
  devuelta: number;
  pendiente: number;
  cerradaCorta: number;
  /** qty − (entregadaViva + pendiente + cerradaCorta). Debe ser 0. */
  gap: number;
  /** entregadaViva − facturadaViva, como dato. */
  facturaGap: number;
  /**
   * Paso 3 (Decisión 47): lo entregado y todavía no facturado. Es un estado
   * NORMAL — se puede entregar sin facturar —, se reporta, no se acusa.
   */
  porFacturar: number;
  /** Facturado MÁS de lo entregado: facturar sin entregar, lo que la Decisión 47 prohíbe. Esto sí es violación. */
  overInvoiced: boolean;
};

export function reconcileSalesLine(l: SalesLineRecon): SalesLineGap {
  const cerradaCorta = l.cerradaCorta ?? 0;
  const entregadaViva = l.qtyDelivered;
  const pendiente = Math.max(0, l.qty - entregadaViva - cerradaCorta);
  const gap = l.qty - (entregadaViva + pendiente + cerradaCorta);
  const facturaGap = entregadaViva - l.invoicedQty;
  const porFacturar = Math.max(0, facturaGap);
  const overInvoiced = facturaGap < -0.0001;
  return { qty: l.qty, entregadaViva, facturadaViva: l.invoicedQty, devuelta: l.qtyReturned, pendiente, cerradaCorta, gap, facturaGap, porFacturar, overInvoiced };
}

/**
 * El "sql" mínimo que hace falta aquí: solo el tag de plantilla parametrizado
 * (`sql\`select … ${x}\``), igual al que expone `src/lib/db.ts` — tipado
 * localmente, sin importar de ahí, para que este archivo se pueda correr
 * también con `node --test` importándolo por ruta relativa (sin bundler, sin
 * alias `@/`), igual que las pruebas de PGlite.
 */
type SqlTag = <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T[]>;

export type PurchaseLineGapRow = PurchaseLineGap & { poId: number; poName: string; productCode: string; productName: string };

/** Panel del cuadre (§ 5): solo las partidas de OC abiertas cuyo gap no da 0. Hoy: siempre vacío. */
export async function purchaseLineGaps(sql: SqlTag, companyId: number): Promise<PurchaseLineGapRow[]> {
  const rows = await sql<{
    id: number;
    po_id: number;
    po_name: string;
    product_code: string;
    product_name: string;
    qty: string;
    qty_received: string;
    qty_closed_short: string;
  }>`
    select pl.id, pl.po_id, po.name as po_name, p.code as product_code, p.name as product_name,
      pl.qty::text, pl.qty_received::text, coalesce(pl.qty_closed_short, 0)::text as qty_closed_short
    from purchase_lines pl
    join purchase_orders po on po.id = pl.po_id
    join products p on p.id = pl.product_id
    where po.company_id = ${companyId} and po.state not in ('cancelled')
  `;
  const out: PurchaseLineGapRow[] = [];
  for (const r of rows) {
    // Paso 7: lo cerrado corto es parte de la identidad (§ 5), no pendiente.
    const g = reconcilePurchaseLine({ qty: Number(r.qty), qtyReceived: Number(r.qty_received), cerradaCorta: Number(r.qty_closed_short) });
    if (Math.abs(g.gap) > 0.0001) {
      out.push({ ...g, poId: r.po_id, poName: r.po_name, productCode: r.product_code, productName: r.product_name });
    }
  }
  return out;
}

export type SalesLineGapRow = SalesLineGap & { soId: number; soName: string; productCode: string; productName: string; unitPrice: number };

/**
 * Panel del cuadre (§ 5). `gaps` = violaciones: cantidad sin clasificar
 * (gap ≠ 0) o facturado más de lo entregado (Decisión 47). `porFacturar` =
 * partidas entregadas y todavía sin facturar — informativo, no error.
 */
export async function salesLineGaps(sql: SqlTag, companyId: number): Promise<{ gaps: SalesLineGapRow[]; porFacturar: SalesLineGapRow[] }> {
  // invoices.order_id hoy solo nace en runtime (deliverSale, azagro.ts) — una
  // empresa que nunca entregó nada puede no tenerla todavía. Idempotente.
  await sql`alter table invoices add column if not exists order_id integer`;
  const rows = await sql<{
    id: number;
    so_id: number;
    so_name: string;
    product_code: string;
    product_name: string;
    qty: string;
    qty_delivered: string;
    qty_returned: string;
    qty_closed_short: string;
    invoiced_qty: string;
    unit_price: string;
  }>`
    select sl.id, sl.so_id, so.name as so_name, p.code as product_code, p.name as product_name,
      sl.qty::text, sl.qty_delivered::text, coalesce(sl.qty_returned, 0)::text as qty_returned,
      coalesce(sl.qty_closed_short, 0)::text as qty_closed_short, sl.unit_price::text as unit_price,
      coalesce((
        select sum(il.qty) from invoice_lines il
        join invoices i on i.id = il.invoice_id
        where i.order_id = sl.so_id and i.state <> 'reversed' and i.reverses_id is null
          and il.product_id = sl.product_id
      ), 0)::text as invoiced_qty
    from sales_lines sl
    join sales_orders so on so.id = sl.so_id
    join products p on p.id = sl.product_id
    where so.company_id = ${companyId} and so.state in ('confirmed', 'done')
  `;
  const gaps: SalesLineGapRow[] = [];
  const porFacturar: SalesLineGapRow[] = [];
  for (const r of rows) {
    const g = reconcileSalesLine({
      qty: Number(r.qty),
      qtyDelivered: Number(r.qty_delivered),
      qtyReturned: Number(r.qty_returned),
      invoicedQty: Number(r.invoiced_qty),
      cerradaCorta: Number(r.qty_closed_short),
    });
    const row = { ...g, soId: r.so_id, soName: r.so_name, productCode: r.product_code, productName: r.product_name, unitPrice: Number(r.unit_price) };
    if (Math.abs(g.gap) > 0.0001 || g.overInvoiced) gaps.push(row);
    else if (g.porFacturar > 0.0001) porFacturar.push(row);
  }
  return { gaps, porFacturar };
}

/**
 * BLOQUE DE PARCIALES, paso 4: repartir la cantidad de una entrega revertida
 * entre las partidas de ese producto. `stock_moves` guarda producto, no
 * partida; y un pedido puede llevar el mismo producto en dos partidas. Se
 * resta partida por partida, en orden, sin pasar de lo entregado en cada
 * una: la suma restada es exactamente la del evento (o lo que había, si
 * hubo una inconsistencia previa — `sobrante` lo dice, y va a bitácora).
 */
export function repartirReversa(
  lines: Array<{ id: number; delivered: number }>,
  qty: number,
): { restas: Array<{ id: number; qty: number }>; sobrante: number } {
  const restas: Array<{ id: number; qty: number }> = [];
  let resto = Math.max(0, qty);
  for (const l of lines) {
    if (resto <= 0.0001) break;
    const take = Math.min(resto, Math.max(0, l.delivered));
    if (take > 0.0001) {
      restas.push({ id: l.id, qty: Math.round(take * 10000) / 10000 });
      resto = Math.round((resto - take) * 10000) / 10000;
    }
  }
  return { restas, sobrante: resto };
}

/**
 * BLOQUE DE PARCIALES, paso 5 (Decisión 61): sumar la utilidad de un pedido
 * con N facturas a partir de la utilidad de cada factura, calculada aparte
 * por el motor de siempre (cada una con sus propios días, su propia TIIE y su
 * propia base). Pura: recibe las partes ya calculadas y los datos del pedido
 * (gastos y mora, que van una sola vez) y devuelve el mismo objeto que da el
 * motor para una factura, más el desglose por factura y lo que sigue sin
 * facturar. Nada aquí lee tasas ni tablas: solo suma y reparte.
 */
export type PnlLine = {
  productId: number;
  code: string;
  name: string;
  qty: number;
  uom: string;
  saleUnit: number;
  sale: number;
  costUnit: number;
  costSource: string;
  cogs: number;
  freightUnit: number;
  freight: number;
  other: number;
  landed: number;
  finance: number;
  commission: number;
  layer1: number;
  layer2: number;
  margin: number;
  marginPct: number;
  disbursed: number;
  financierFinance: number;
  lineCost: number | null;
  protection: number | null;
  revenueLine: number;
  excluded: boolean;
  excludeReason: string | null;
  /** Spread cambiario del deal (§ 11.7), informativo. */
  fxSpread?: number;
};

export type PnlPart = {
  invoice: { id: number; name: string; eventRef: string | null; date: string; amount: number; residual: number; paidDate: string | null };
  pnl: {
    name: string;
    currency: string;
    creditDays: number;
    circuit: string | null;
    financingBase: string;
    clientPrice: number;
    disbursed: number;
    financierFinance: number;
    commissionRate: number | null;
    costRate: number | null;
    collectionRate: number | null;
    spread: number;
    lineCost: number | null;
    protection: number | null;
    financeRate: number | null;
    tiieIssue: number | null;
    tiieDate: string | null;
    financialDays: number;
    daysExceeded: number;
    lines: PnlLine[];
    revenue: number;
    cogs: number;
    freightQuote: number;
    other: number;
    commission: number;
    layer1: number;
    layer2: number;
    finance: number;
    financeBase: number;
    discount: number;
    fxIncome: number;
    fxSpread?: number;
  };
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const sum = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);
const sumOrNull = <T,>(xs: T[], f: (x: T) => number | null) => (xs.some((x) => f(x) == null) ? null : r2(sum(xs, (x) => f(x) ?? 0)));

export function mergeDealPnl(
  parts: PnlPart[],
  order: {
    expenses: Array<{ id: number; name: string; class: string; amount: number }>;
    mora: number;
    moraPendiente: number;
    uninvoiced: Array<{ productId: number; code: string; name: string; uom: string; qty: number }>;
  },
) {
  if (!parts.length) throw new Error("mergeDealPnl: sin facturas");
  const last = parts[parts.length - 1]!.pnl;
  // Partidas: una por producto, sumando lo de cada factura; los unitarios,
  // ponderados por cantidad. Un producto que ninguna factura llevó no aparece
  // (queda en `uninvoiced`).
  const byProduct = new Map<number, PnlLine[]>();
  for (const p of parts) for (const l of p.pnl.lines) if (l.qty > 0.0000001) byProduct.set(l.productId, [...(byProduct.get(l.productId) ?? []), l]);
  const lines: PnlLine[] = [...byProduct.entries()].map(([productId, ls]) => {
    const first = ls[0]!;
    const excludedLs = ls.filter((l) => l.excluded);
    const excluded = excludedLs.length > 0;
    const qty = sum(ls, (l) => l.qty);
    const sale = sum(ls, (l) => l.sale);
    const cogs = sum(ls, (l) => l.cogs);
    const freight = sum(ls, (l) => l.freight);
    const other = sum(ls, (l) => l.other);
    const revenueLine = sum(ls, (l) => l.revenueLine);
    const margin = sum(ls, (l) => l.margin);
    const included = ls.filter((l) => !l.excluded);
    const inclQty = sum(included, (l) => l.qty);
    return {
      productId,
      code: first.code,
      name: first.name,
      qty,
      uom: first.uom,
      saleUnit: qty > 0 ? sale / qty : first.saleUnit,
      sale,
      costUnit: excluded ? 0 : inclQty > 0 ? cogs / inclQty : 0,
      costSource: (included[0] ?? first).costSource,
      cogs,
      freightUnit: inclQty > 0 ? freight / inclQty : first.freightUnit,
      freight,
      other,
      landed: sum(ls, (l) => l.landed),
      finance: sum(ls, (l) => l.finance),
      commission: sum(ls, (l) => l.commission),
      layer1: sum(ls, (l) => l.layer1),
      layer2: sum(ls, (l) => l.layer2),
      margin,
      marginPct: !excluded && revenueLine > 0 ? (margin / revenueLine) * 100 : 0,
      disbursed: sum(ls, (l) => l.disbursed),
      financierFinance: r2(sum(ls, (l) => l.financierFinance)),
      lineCost: sumOrNull(ls, (l) => l.lineCost),
      protection: sumOrNull(ls, (l) => l.protection),
      revenueLine,
      fxSpread: r2(sum(ls, (l) => l.fxSpread ?? 0)),
      excluded,
      excludeReason: excluded ? [...new Set(excludedLs.map((l) => l.excludeReason ?? ""))].filter(Boolean).join("; ") || null : null,
    };
  });
  const included = lines.filter((l) => !l.excluded);
  const excludedLines = lines.filter((l) => l.excluded);
  const excluded = { n: excludedLines.length, venta: sum(excludedLines, (l) => l.sale), motivos: [...new Set(excludedLines.map((l) => l.excludeReason!))] };
  const expPedido = sum(order.expenses.filter((e) => e.class === "pedido"), (e) => e.amount);
  const expOther = sum(order.expenses.filter((e) => e.class !== "pedido"), (e) => e.amount);
  const revenue = sum(included, (l) => l.revenueLine);
  const clientPrice = sum(included, (l) => l.sale);
  const disbursed = sum(included, (l) => l.disbursed);
  const financierFinance = r2(sum(included, (l) => l.financierFinance));
  const lineCost = sumOrNull(included, (l) => l.lineCost);
  const protection = sumOrNull(included, (l) => l.protection);
  const cogs = sum(included, (l) => l.cogs);
  const freightQuote = sum(included, (l) => l.freight);
  const otherQuote = sum(included, (l) => l.other);
  const commission = sum(included, (l) => l.commission);
  const layer1 = sum(included, (l) => l.layer1);
  const layer2 = sum(included, (l) => l.layer2);
  const finance = commission + layer1 + layer2;
  const financeBase = sum(included, (l) => l.landed);
  const freight = freightQuote + expPedido;
  // Pronto pago y diferencial cambiario: los de cada factura, sumados.
  const discount = sum(parts, (p) => p.pnl.discount);
  const fxIncome = sum(parts, (p) => p.pnl.fxIncome);
  const fxSpread = r2(sum(parts, (p) => p.pnl.fxSpread ?? 0));
  const margin = revenue - cogs - freight - otherQuote - expOther;
  const netProfit = margin + order.mora + fxIncome - finance - discount;
  // Cuánto se ha cobrado: TODAS las facturas, no solo la última.
  const fvAmount = sum(parts, (p) => p.invoice.amount);
  const fvResidual = sum(parts, (p) => p.invoice.residual);
  const paidRatio = fvAmount > 0 ? Math.min(1, Math.max(0, (fvAmount - fvResidual) / fvAmount)) : 0;
  const fullyPaid = parts.every((p) => p.invoice.residual <= 0.009);
  const utilidadDevengada = netProfit;
  const utilidadRealizada = netProfit - order.moraPendiente;
  const utilidadCaja = fullyPaid ? utilidadRealizada : 0;
  const utilidadProporcional = netProfit * paidRatio;
  const invoices = parts.map((p) => ({
    ...p.invoice,
    financialDays: p.pnl.financialDays,
    daysExceeded: p.pnl.daysExceeded,
    tiieIssue: p.pnl.tiieIssue,
    revenue: p.pnl.revenue,
    cogs: p.pnl.cogs,
    finance: p.pnl.finance,
    financierFinance: p.pnl.financierFinance,
    discount: p.pnl.discount,
    // La utilidad de ESTA factura, sin gastos ni mora del pedido (van una vez, abajo).
    netProfit: r2(p.pnl.revenue - p.pnl.cogs - p.pnl.freightQuote - p.pnl.other + p.pnl.fxIncome - p.pnl.finance - p.pnl.discount),
  }));
  return {
    name: last.name,
    currency: last.currency,
    creditDays: last.creditDays,
    circuit: last.circuit,
    financingBase: last.financingBase,
    clientPrice,
    disbursed,
    financierFinance,
    commissionRate: last.commissionRate,
    costRate: last.costRate,
    collectionRate: last.collectionRate,
    spread: last.spread,
    lineCost,
    protection,
    financeRate: last.financeRate,
    tiieIssue: last.tiieIssue,
    tiieDate: last.tiieDate,
    financialDays: last.financialDays,
    daysExceeded: last.daysExceeded,
    lines,
    excluded,
    expenses: order.expenses,
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
    fxSpread,
    margin,
    marginPct: revenue > 0 ? (margin / revenue) * 100 : 0,
    marginAfterFinance: netProfit,
    netProfit,
    netProfitPct: revenue > 0 ? (netProfit / revenue) * 100 : 0,
    mora: order.mora,
    moraPendiente: order.moraPendiente,
    moraCobrada: order.mora - order.moraPendiente,
    paidRatio,
    fullyPaid,
    utilidadDevengada,
    utilidadRealizada,
    utilidadCaja,
    utilidadProporcional,
    multi: true as const,
    invoices,
    uninvoiced: order.uninvoiced,
  };
}

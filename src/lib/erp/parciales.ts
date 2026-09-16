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
  }>`
    select pl.id, pl.po_id, po.name as po_name, p.code as product_code, p.name as product_name,
      pl.qty::text, pl.qty_received::text
    from purchase_lines pl
    join purchase_orders po on po.id = pl.po_id
    join products p on p.id = pl.product_id
    where po.company_id = ${companyId} and po.state not in ('cancelled')
  `;
  const out: PurchaseLineGapRow[] = [];
  for (const r of rows) {
    const g = reconcilePurchaseLine({ qty: Number(r.qty), qtyReceived: Number(r.qty_received) });
    if (Math.abs(g.gap) > 0.0001) {
      out.push({ ...g, poId: r.po_id, poName: r.po_name, productCode: r.product_code, productName: r.product_name });
    }
  }
  return out;
}

export type SalesLineGapRow = SalesLineGap & { soId: number; soName: string; productCode: string; productName: string };

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
    invoiced_qty: string;
  }>`
    select sl.id, sl.so_id, so.name as so_name, p.code as product_code, p.name as product_name,
      sl.qty::text, sl.qty_delivered::text, coalesce(sl.qty_returned, 0)::text as qty_returned,
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
    });
    const row = { ...g, soId: r.so_id, soName: r.so_name, productCode: r.product_code, productName: r.product_name };
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

/**
 * LA COMPRA DE UN PEDIDO — un solo lugar donde se pregunta «¿qué le compré a
 * mis proveedores para este pedido, y qué facturas nacieron de ahí?».
 *
 * El recorrido es siempre el mismo y estaba copiado a mano en cinco lugares,
 * cada uno con un filtro de estado distinto: `fx-position-query.ts`,
 * `delivery-reversal.ts` (dos veces), `deal.ts` y `cancel.ts`. Una sexta copia
 * con un sexto criterio era el riesgo real de este bloque.
 *
 *   pedido de venta  →  `purchase_orders.so_id`  →  `purchase_orders.name`
 *                    →  `invoices.origin`  (amarre por TEXTO, como la D42)
 *
 * El amarre por texto es llave de verdad: el folio de la orden es único por
 * empresa (`purchase_orders_folio_uq`, migración 0015) y desde la 0045 hay
 * índice por donde caminarlo (`inv_origin_idx`). La factura del proveedor NO
 * guarda `order_id`: nace con el folio de su orden en `origin` y, desde el
 * bloque de parciales, con el folio de su recepción en `event_ref`.
 *
 * `so_id` solo lo escribe `decideQuote`: una orden de compra levantada a mano
 * o nacida de una cotización a proveedores para inventario NO está ligada a
 * ningún pedido. Eso no es un defecto que tape esta función — es un hecho del
 * negocio, y quien lea de aquí tiene que decir en pantalla qué quedó fuera.
 */
import { getSql } from "@/lib/db";

type Sql = Awaited<ReturnType<typeof getSql>>;

export type DealSupplierInvoice = {
  /** Folio de la factura del proveedor (FP-000N). */
  name: string;
  /** Folio de la orden de compra de la que nació. */
  poName: string;
  partner: string;
  /** Importe en pesos, al TC declarado en la orden. */
  amount: number;
  /** Lo que falta por pagar, en pesos. */
  residual: number;
  /** Importe en dólares, si la orden fue en dólares. */
  amountFx: number | null;
  currency: string;
  /** TC pactado con el proveedor. Null si la orden no fue en dólares. */
  fxAgreed: number | null;
  /**
   * Diferencial cambiario YA REALIZADO de esta factura: lo que costó de más
   * (negativo) o de menos (positivo) pagarla en pesos a un TC distinto del
   * pactado. Lo escribe `applyInvoicePayment` con el signo ya puesto del lado
   * proveedor (`fxResultDeltaFor`), así que se suma tal cual.
   */
  fxResult: number;
  state: string;
};

/**
 * Las facturas VIVAS del proveedor que cuelgan de este pedido. «Vivas» = ni
 * revertidas ni contrarias de una revertida, el mismo criterio que usa
 * `cancel.ts` al buscar por `origin`; no se depende del candado de otro módulo
 * para que un número no se cuente dos veces.
 *
 * Los predicados van en un orden a propósito distinto del de `reports.ts`: ahí
 * una prueba cuenta las apariciones de una frase literal para vigilar que
 * ningún lector cuente una revertida, y esta consulta no debe alterar ese
 * conteo sin querer.
 */
export async function supplierInvoicesOfDeal(sql: Sql, companyId: number, soId: number): Promise<DealSupplierInvoice[]> {
  const rows = await sql<{
    name: string;
    po_name: string;
    partner: string;
    amount: string;
    residual: string;
    amount_fx: string | null;
    currency: string;
    fx_agreed: string | null;
    fx_result: string;
    state: string;
  }>`
    select i.name, po.name as po_name, p.name as partner, i.amount::text, i.residual::text,
      i.amount_fx::text, coalesce(i.currency,'MXN') as currency, i.fx_agreed::text,
      coalesce(i.fx_result,0)::text as fx_result, i.state
    from invoices i
    join purchase_orders po on po.name = i.origin and po.company_id = i.company_id
    join partners p on p.id = i.partner_id
    where i.company_id = ${companyId}
      and po.so_id = ${soId}
      and po.state <> 'cancelled'
      and i.kind = 'supplier'
      and coalesce(i.inv_class,'product') = 'product'
      and i.reverses_id is null
      and i.state <> 'reversed'
    order by i.id
  `;
  return rows.map((r) => ({
    name: r.name,
    poName: r.po_name,
    partner: r.partner,
    amount: Number(r.amount),
    residual: Number(r.residual),
    amountFx: r.amount_fx == null ? null : Number(r.amount_fx),
    currency: r.currency,
    fxAgreed: r.fx_agreed == null ? null : Number(r.fx_agreed),
    fxResult: Number(r.fx_result),
    state: r.state,
  }));
}

/**
 * ¿Este pedido tiene alguna compra ligada? Contesta la pregunta que decide si
 * el diferencial de la compra se puede imputar al pedido o no, y por eso se
 * pregunta por la ORDEN, no por la factura: una orden confirmada y todavía sin
 * recibir ya liga al pedido aunque no haya nacido ninguna factura.
 */
export async function dealHasPurchase(sql: Sql, companyId: number, soId: number): Promise<boolean> {
  const rows = await sql<{ n: number }>`
    select count(*)::int as n from purchase_orders
    where company_id = ${companyId} and so_id = ${soId} and state <> 'cancelled'
  `;
  return Number(rows[0]?.n ?? 0) > 0;
}

/**
 * EL DIFERENCIAL DE LA COMPRA, para el P&L del pedido (Decisión 87).
 *
 * Suma el `fx_result` de las facturas vivas del proveedor de este pedido. Es
 * un número que YA existe y ya tiene su signo: lo escribe el cobro/pago, aquí
 * solo se lee. Nunca se calcula un diferencial nuevo.
 *
 * Devuelve además `ligado`: si el pedido no tiene ninguna compra ligada, el
 * número es 0 pero **no porque no haya diferencial** — porque no hay forma de
 * saber cuál le toca. La pantalla tiene que decirlo con esas palabras, nunca
 * enseñar un cero mudo.
 */
export async function purchaseFxOfDeal(sql: Sql, companyId: number, soId: number) {
  const ligado = await dealHasPurchase(sql, companyId, soId);
  if (!ligado) return { ligado: false, fxCompra: 0, facturas: [] as DealSupplierInvoice[] };
  const facturas = await supplierInvoicesOfDeal(sql, companyId, soId);
  const fxCompra = Math.round(facturas.reduce((s, f) => s + f.fxResult, 0) * 100) / 100;
  return { ligado: true, fxCompra, facturas };
}

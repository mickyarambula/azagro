import type { Sql } from "@/lib/db";

/**
 * Moneda y tipo de cambio en la cadena de compra (Decisiones 76-81, 17-sep-2026,
 * MODELO-NEGOCIO.md § 11). Todo lo que convierte vive aquí y corre ANTES de
 * entrar a pricing.ts / cost.ts / stock.ts: el motor sigue recibiendo números
 * puros en pesos y no cambia de firma.
 *
 * Convención mientras L4a siga abierta: el costo de una partida de solicitud o
 * cotización (`cost`) está SIEMPRE en pesos — la unidad en que hoy viven los
 * precios y el kardex —; `cost_currency` y `cost_fx` dicen en qué moneda lo dio
 * el proveedor y con qué TC USD→MXN se convirtió. La OC guarda su `unit_price`
 * en SU moneda con SU `fx_rate` (el del proveedor, Decisión 78), y la FP nace
 * como la FV: pesos al TC de la OC, con el original en `amount_fx` (Decisión 79).
 */
export type Currency = "MXN" | "USD";
export type FxRow = { date: string; rate: number };

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

/** Un TC USD→MXN real es mayor que 1: el 1 es el default del esquema, nunca un tipo de cambio. */
export function isUsdFx(fx: number | string | null | undefined) {
  const n = Number(fx);
  return Number.isFinite(n) && n > 1;
}

export function missingFxMessage(what: string) {
  return `Sin tipo de cambio para ${what}. Captúralo: la pantalla lo propone de la tabla (Ajustes → Tipo de cambio) y se puede corregir; sin renglón en la tabla no se guarda nada en dólares.`;
}

/** La tabla de TC de la empresa, ordenada por fecha. */
export async function loadFxTable(sql: Sql, companyId: number): Promise<FxRow[]> {
  const rows = await sql<{ date: string; usd_mxn: string }>`
    select date::text, usd_mxn::text from fx_rates where company_id = ${companyId} order by date
  `;
  return rows.map((r) => ({ date: r.date, rate: Number(r.usd_mxn) }));
}

/** TC de la tabla vigente en una fecha: el renglón más reciente con fecha ≤ asOf, o null (nunca un respaldo). */
export function fxAt(table: FxRow[], asOf: string): FxRow | null {
  const t = asOf.slice(0, 10);
  let pick: FxRow | null = null;
  for (const row of [...table].sort((a, b) => a.date.localeCompare(b.date))) {
    if (row.date <= t) pick = row;
    else break;
  }
  return pick;
}

/**
 * Decisión 76: un costo dado por el proveedor en `currency`, a pesos. En MXN es
 * el mismo número; en USD exige el TC (el de la tabla a la fecha, enseñado y
 * editable) y sin él se detiene.
 */
export function costToMxn(i: { cost: number; currency: Currency | string; fx?: number | string | null; what: string }) {
  if (i.currency === "USD") {
    if (!isUsdFx(i.fx)) throw new Error(missingFxMessage(i.what));
    return { mxn: r4(i.cost * Number(i.fx)), currency: "USD" as Currency, fx: Number(i.fx) };
  }
  return { mxn: r4(i.cost), currency: "MXN" as Currency, fx: null as number | null };
}

/** El costo en pesos de vuelta a la moneda del proveedor (la OC que nace de una solicitud, Decisión 78). */
export function mxnToCostCurrency(i: { mxn: number; currency: Currency | string; fx?: number | string | null; what: string }) {
  if (i.currency === "USD") {
    if (!isUsdFx(i.fx)) throw new Error(missingFxMessage(i.what));
    return r4(i.mxn / Number(i.fx));
  }
  return r4(i.mxn);
}

/**
 * Decisión 79: la FP nace con el molde de la FV y del corte — `amount` en pesos
 * al TC de la OC, `amount_fx` en la moneda de la OC, `fx_agreed` = ese TC. En
 * MXN `amount_fx` queda en 0, como en la FV.
 */
export function supplierInvoiceAmounts(i: { total: number | string; currency: string; fx: number | string | null | undefined; poName: string }) {
  const total = r2(Number(i.total) || 0);
  if (i.currency === "USD") {
    if (!isUsdFx(i.fx)) {
      throw new Error(
        `${i.poName} está en dólares sin tipo de cambio: la deuda con el proveedor no puede nacer en pesos. ` +
          `Captura el TC de la orden en Compras (columna TC) y vuelve a recibir (o a entregar, si es directa).`,
      );
    }
    const fx = Number(i.fx);
    return { amount: r2(total * fx), amountFx: total, fxAgreed: fx, currency: "USD" as Currency };
  }
  return { amount: total, amountFx: 0, fxAgreed: 1, currency: "MXN" as Currency };
}

/**
 * El costo de una partida de OC en pesos, para el P&L: USD × TC de la OC. Una OC
 * en dólares sin TC real no se convierte a nada — regresa null y el P&L excluye
 * la partida con motivo, en vez de restar dólares contra pesos.
 */
export function poCostToMxn(i: { unitPrice: number | string | null | undefined; currency: string | null | undefined; fx: number | string | null | undefined }) {
  if (i.unitPrice == null) return null;
  const unit = Number(i.unitPrice);
  if ((i.currency ?? "MXN") !== "USD") return unit;
  return isUsdFx(i.fx) ? r4(unit * Number(i.fx)) : null;
}

/** Cómo se enseña un importe de factura por fila: en USD lo pactado en dólares (`amount_fx`), en MXN los pesos. */
export function invoiceShown(i: {
  amount: number | string;
  residual: number | string;
  currency: string;
  amountFx: number | string | null | undefined;
  fxAgreed: number | string | null | undefined;
}) {
  const amount = Number(i.amount);
  const residual = Number(i.residual);
  if (i.currency === "USD" && isUsdFx(i.fxAgreed) && Number(i.amountFx) > 0) {
    const fx = Number(i.fxAgreed);
    return { amount: Number(i.amountFx), residual: r2(residual / fx), paid: r2((amount - residual) / fx), currency: "USD" as Currency, fx };
  }
  return { amount, residual, paid: r2(amount - residual), currency: (i.currency === "USD" ? "USD" : "MXN") as Currency, fx: null as number | null };
}

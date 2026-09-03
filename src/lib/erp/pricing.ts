import { financeCost } from "@/lib/erp/credit";
import { marginUnit as marginUnitOf } from "@/lib/erp/margins";
import { YEAR_DAYS } from "@/lib/erp/rules";

/**
 * Precio Azagro — el costo financiero NO lo absorbe Azagro: se le pasa al
 * cliente dentro del precio. Orden del cálculo (hojas de cotización reales de
 * la dirección, 3-sep-2026):
 *
 *   1. Costo de mercancía puesto (costo + flete + otros).
 *   2. Financiamiento, por unidad, SUMADO AL COSTO:
 *        costo × comisión ASR (1%, una sola vez)
 *      + costo × 1.01 × (TIIE vigente al cotizar + spread ASR 4%) × días / 360
 *      con los días de crédito de ESTE pedido (no 150 fijos). El 1.01 es la
 *      columna AN del Excel DIF_TC: la línea adelanta costo + comisión.
 *   3. Margen elegido por el usuario, SOBRE EL PRECIO DE VENTA:
 *        precio = (costo puesto + financiamiento) ÷ (1 − margen %)
 *        precio =  costo puesto + financiamiento + margen $   (monto fijo)
 *
 * Al contado (0 días) no hay circuito de financiamiento: precio = costo ÷
 * (1 − margen) y el financiamiento es $0, comisión incluida.
 * El 9% de mora NO va aquí: es factura de intereses al vencimiento.
 */

export type PriceInput = {
  cost: number;
  freight: number;
  other: number;
  days: number;
  tiie: number;
  costSpread: number;
  commissionRate: number;
  marginMode: "pct" | "nominal";
  marginPct: number;
  marginNominal: number;
  qty: number;
};

export type PriceResult = {
  landedUnit: number;
  marginUnit: number;
  commissionUnit: number;
  layer1Unit: number;
  financeUnit: number;
  priceUnit: number;
  marginPct: number;
  marginNominal: number;
  landed: number;
  margin: number;
  finance: number;
  price: number;
  rate: number;
};

export function priceSale(i: PriceInput): PriceResult {
  const qty = i.qty || 0;
  const landedUnit = Math.max(0, i.cost) + Math.max(0, i.freight) + Math.max(0, i.other);
  const fin =
    i.days > 0
      ? financeCost({
          supplierCost: landedUnit,
          saleCapital: 0,
          commissionRate: Math.max(0, i.commissionRate),
          costSpread: Math.max(0, i.costSpread),
          tiieAtIssue: Math.max(0, i.tiie),
          financialDays: i.days,
          daysExceeded: 0,
        })
      : { rate: Math.max(0, i.tiie) + Math.max(0, i.costSpread), commission: 0, layer1: 0, layer2: 0, total: 0 };
  const financeUnit = fin.commission + fin.layer1;
  // Margen SOBRE EL PRECIO, aplicado después de sumar el financiamiento al
  // costo (margins.ts es la fórmula única; aquí solo se arma el desglose).
  const marginUnit =
    i.marginMode === "nominal"
      ? Math.max(0, i.marginNominal)
      : marginUnitOf({ mode: "pct", pct: Math.max(0, i.marginPct), nominal: 0 }, landedUnit, financeUnit);
  const priceUnit = landedUnit + financeUnit + marginUnit;
  return {
    landedUnit,
    marginUnit,
    commissionUnit: fin.commission,
    layer1Unit: fin.layer1,
    financeUnit,
    priceUnit,
    marginPct: priceUnit > 0 ? (marginUnit / priceUnit) * 100 : 0,
    marginNominal: marginUnit,
    landed: landedUnit * qty,
    margin: marginUnit * qty,
    finance: financeUnit * qty,
    price: priceUnit * qty,
    rate: fin.rate,
  };
}

/** Tasa anual de la Capa 1: TIIE + spread ASR (spread de costo). */
export function annualRate(tiie: number, costSpread: number) {
  return Math.max(0, tiie) + Math.max(0, costSpread);
}

/**
 * Financiamiento por unidad que va DENTRO del precio (misma fórmula que
 * priceSale, para quien ya tiene el costo y solo necesita el cargo):
 *   costo × comisión + costo × (1 + comisión) × (TIIE + spread ASR) × días / 360.
 * Contado (0 días) → 0, comisión incluida.
 */
export function financeUnit(i: { cost: number; days: number; tiie: number; costSpread: number; commissionRate: number }) {
  if (i.days <= 0) return 0;
  const fin = financeCost({
    supplierCost: Math.max(0, i.cost),
    saleCapital: 0,
    commissionRate: Math.max(0, i.commissionRate),
    costSpread: Math.max(0, i.costSpread),
    tiieAtIssue: Math.max(0, i.tiie),
    financialDays: i.days,
    daysExceeded: 0,
  });
  return fin.commission + fin.layer1;
}

/**
 * Base del financiamiento de un producto, calculada en el SERVIDOR con el
 * costo real. Sirve para que la pantalla arme el precio a crédito sin
 * recibir nunca el costo: quién cotiza no cambia el precio, solo cambia lo
 * que se le muestra.
 *   commission   = costo × comisión ASR, en pesos (una sola vez).
 *   interestYear = costo × (1 + comisión) × (TIIE + spread ASR), en pesos:
 *                  el interés de un año. Por eso financeFor divide /360.
 * financeFor(financeBase(x), d) da exactamente lo mismo que
 * financeUnit({ ...x, days: d }) — hay prueba que lo verifica.
 */
export type FinanceBase = { commission: number; interestYear: number };

export function financeBase(i: { cost: number; tiie: number; costSpread: number; commissionRate: number }): FinanceBase {
  const cost = Math.max(0, i.cost);
  const commissionRate = Math.max(0, i.commissionRate);
  const rate = Math.max(0, i.tiie) + Math.max(0, i.costSpread);
  return {
    commission: Math.round(cost * commissionRate * 100) / 100,
    interestYear: cost * (1 + commissionRate) * rate,
  };
}

/** Financiamiento por unidad a partir de la base. Contado (0 días) → 0. */
export function financeFor(base: FinanceBase, days: number) {
  if (days <= 0) return 0;
  return base.commission + Math.round(((base.interestYear * days) / YEAR_DAYS) * 100) / 100;
}

/**
 * Precio a crédito a partir del de contado (cotización directa, sin
 * solicitud): contado + financiamiento sobre el COSTO, igual para todos los
 * roles. Es la vía del margen en monto fijo: la misma utilidad en pesos que
 * dejó el precio de contado (por eso createQuote guarda esos márgenes como
 * $ fijo). Un producto sin costo capturado no genera financiamiento (crédito =
 * contado): es un hueco de datos, no de fórmula.
 */
export function creditFromCash(i: { cash: number; fin: FinanceBase; days: number }) {
  const cash = Math.max(0, i.cash);
  if (i.days <= 0) return cash;
  return Math.round((cash + financeFor(i.fin, i.days)) * 10000) / 10000;
}

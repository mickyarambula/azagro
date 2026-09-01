import { financeCost } from "@/lib/erp/credit";
import { YEAR_DAYS } from "@/lib/erp/rules";

/**
 * Precio Azagro — el costo financiero NO lo absorbe Azagro: se le pasa al
 * cliente dentro del precio. Orden del cálculo (regla del dueño):
 *
 *   1. Costo de mercancía puesto (costo + flete + otros).
 *   2. Margen elegido por el usuario (sobre ese costo).
 *   3. Financiamiento ENCIMA: comisión + Capa 1 con los días de crédito de
 *      ESTE pedido (no 150 fijos), a TIIE + spread de costo. Se reparte por
 *      unidad y se suma al precio.
 *
 * Al contado (0 días) no hay circuito de financiamiento: precio = costo + margen.
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
  let marginUnit: number;
  if (i.marginMode === "nominal") {
    marginUnit = Math.max(0, i.marginNominal);
  } else {
    marginUnit = landedUnit * (Math.max(0, i.marginPct) / 100);
  }
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
  const priceUnit = landedUnit + marginUnit + financeUnit;
  return {
    landedUnit,
    marginUnit,
    commissionUnit: fin.commission,
    layer1Unit: fin.layer1,
    financeUnit,
    priceUnit,
    marginPct: landedUnit > 0 ? (marginUnit / landedUnit) * 100 : 0,
    marginNominal: marginUnit,
    landed: landedUnit * qty,
    margin: marginUnit * qty,
    finance: financeUnit * qty,
    price: priceUnit * qty,
    rate: fin.rate,
  };
}

export function annualRate(tiie: number, financeSpread: number) {
  return Math.max(0, tiie) + Math.max(0, financeSpread);
}

/** Precio a crédito a partir del de contado: TIIE + spread, días/360. */
export function creditFromCash(cash: number, days: number, annual: number) {
  const c = Math.max(0, cash);
  if (days <= 0) return c;
  return Math.round(c * (1 + Math.max(0, annual) * (days / YEAR_DAYS)) * 10000) / 10000;
}

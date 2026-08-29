import { YEAR_DAYS } from "@/lib/erp/rules";

/** Precio Azagro: costo puesto + costo de la LÍNEA (TIIE + 4.5%), sin mora.
 *  El 9% + FEGA no entra aquí: es factura de intereses al vencimiento, no del producto.
 *  Días de crédito: calendario exacto. Factor: días / 360.
 */

export type PriceInput = {
  cost: number;
  freight: number;
  other: number;
  days: number;
  annualRate: number;
  marginMode: "pct" | "nominal";
  marginPct: number;
  marginNominal: number;
  qty: number;
};

export type PriceResult = {
  landedUnit: number;
  financeUnit: number;
  totalCostUnit: number;
  priceUnit: number;
  marginUnit: number;
  marginPct: number;
  marginNominal: number;
  landed: number;
  finance: number;
  totalCost: number;
  price: number;
  margin: number;
};

export function priceSale(i: PriceInput): PriceResult {
  const qty = i.qty || 0;
  const landedUnit = Math.max(0, i.cost) + Math.max(0, i.freight) + Math.max(0, i.other);
  const financeUnit = i.days > 0 ? landedUnit * Math.max(0, i.annualRate) * (i.days / YEAR_DAYS) : 0;
  const totalCostUnit = landedUnit + financeUnit;
  let priceUnit: number;
  let marginUnit: number;
  if (i.marginMode === "nominal") {
    marginUnit = Math.max(0, i.marginNominal);
    priceUnit = totalCostUnit + marginUnit;
  } else {
    priceUnit = totalCostUnit * (1 + Math.max(0, i.marginPct) / 100);
    marginUnit = priceUnit - totalCostUnit;
  }
  const marginPct = totalCostUnit > 0 ? (marginUnit / totalCostUnit) * 100 : 0;
  return {
    landedUnit,
    financeUnit,
    totalCostUnit,
    priceUnit,
    marginUnit,
    marginPct,
    marginNominal: marginUnit,
    landed: landedUnit * qty,
    finance: financeUnit * qty,
    totalCost: totalCostUnit * qty,
    price: priceUnit * qty,
    margin: marginUnit * qty,
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

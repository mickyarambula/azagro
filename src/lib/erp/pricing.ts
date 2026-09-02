import { financeCost } from "@/lib/erp/credit";

/**
 * Precio Azagro — el costo financiero NO lo absorbe Azagro: se le pasa al
 * cliente dentro del precio. Orden del cálculo (regla del dueño):
 *
 *   1. Costo de mercancía puesto (costo + flete + otros).
 *   2. Margen elegido por el usuario (sobre ese costo).
 *   3. Financiamiento ENCIMA, por unidad:
 *        costo × comisión ASR (1%, una sola vez)
 *      + costo × (TIIE vigente al cotizar + spread ASR 4%) × días / 360
 *      con los días de crédito de ESTE pedido (no 150 fijos).
 *
 * Al contado (0 días) no hay circuito de financiamiento: precio = costo +
 * margen y el financiamiento es $0, comisión incluida.
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

/** Tasa anual de la Capa 1: TIIE + spread ASR (spread de costo). */
export function annualRate(tiie: number, costSpread: number) {
  return Math.max(0, tiie) + Math.max(0, costSpread);
}

/**
 * Financiamiento por unidad que va DENTRO del precio (misma fórmula que
 * priceSale, para quien ya tiene el costo y solo necesita el cargo):
 *   costo × comisión + costo × (TIIE + spread ASR) × días / 360.
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
 * Precio a crédito a partir del de contado (cotización directa, sin
 * solicitud): contado + financiamiento sobre el COSTO. Si no se conoce el
 * costo (0), el financiamiento se calcula sobre el precio de contado, que es
 * la opción conservadora: nunca cobra de menos.
 */
export function creditFromCash(i: { cash: number; cost: number; days: number; tiie: number; costSpread: number; commissionRate: number }) {
  const cash = Math.max(0, i.cash);
  if (i.days <= 0) return cash;
  const base = i.cost > 0 ? i.cost : cash;
  return Math.round((cash + financeUnit({ ...i, cost: base })) * 10000) / 10000;
}

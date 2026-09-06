import { financeCost } from "@/lib/erp/credit";
import { marginUnit as marginUnitOf, type MarginMode, type MarginSpec } from "@/lib/erp/margins";
import { YEAR_DAYS } from "@/lib/erp/rules";

/**
 * Base del financiamiento: PARÁMETRO DEL CIRCUITO (Decisión 4, 5-sep-2026).
 * Es lo que el financiador realmente desembolsa:
 *   "costo_comision" — doble facturación (ASR): costo puesto × (1 + comisión).
 *                      Es exactamente el motor de siempre (columna AN del
 *                      Excel). NO se toca: todo lo que corre por ASR sale
 *                      idéntico al centavo.
 *   "costo_margen"   — lineal (Línea Santa Rosa): costo puesto + margen, la
 *                      factura de Azagro a Santa Rosa. Sin comisión ni × 1.01
 *                      (Decisión 6). El margen se entiende SOBRE ESA FACTURA,
 *                      no sobre el precio al cliente.
 * El motor la RECIBE (paso 3): pricing.ts no lee el catálogo ni la base.
 */
export type FinancingBase = "costo_comision" | "costo_margen";

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
  /** La tasa que entra al precio: TIIE de la tabla (ASR) o tasa de cobro (lineal). */
  tiie: number;
  costSpread: number;
  /** Comisión de apertura DEL CIRCUITO (congelada en la cotización). En el lineal es 0. */
  commissionRate: number;
  /** Sobre qué corre el financiamiento: parámetro del circuito. Obligatorio: nadie decide por omisión. */
  financingBase: FinancingBase;
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
  /** ASR: margen como % del precio al cliente. Lineal: como % de la factura a Santa Rosa (lo desembolsado). */
  marginPct: number;
  marginNominal: number;
  /** Lo que el financiador desembolsa por unidad (ASR: costo × (1 + comisión); lineal: costo + margen). 0 al contado. */
  disbursedUnit: number;
  landed: number;
  margin: number;
  finance: number;
  price: number;
  rate: number;
};

export function priceSale(i: PriceInput): PriceResult {
  if (i.financingBase === "costo_margen") return priceSaleLineal(i);
  // Circuito de doble facturación (ASR): el motor de siempre, sin tocar.
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
    // Lo que ASR adelanta: costo + comisión (la base de la Capa 1). Al contado nada.
    disbursedUnit: i.days > 0 ? landedUnit * (1 + Math.max(0, i.commissionRate)) : 0,
    landed: landedUnit * qty,
    margin: marginUnit * qty,
    finance: financeUnit * qty,
    price: priceUnit * qty,
    rate: fin.rate,
  };
}

// ---------------------------------------------------------------------------
// CAMINO LINEAL (Línea Santa Rosa). DISENO_FINANCIAMIENTO.md § 5, recalculado
// el 5-sep-2026 con las Decisiones 1, 4 y 6:
//
//   Azagro paga al proveedor                 100,000.00   (costo puesto)
//   Azagro factura a Santa Rosa              106,951.87   margen 6,951.87 (6.5 % DE ESTA FACTURA)
//   Santa Rosa agrega el costo financiero      4,924.24   (tasa de cobro 7.05 % + spread 4.00 %) × 150/360, sobre 106,951.87
//   Santa Rosa factura al cliente            111,876.11
//
// Lo que se financia es lo que Santa Rosa desembolsa: costo + margen. Sin
// comisión de apertura, sin × 1.01. El margen % es sobre la factura de Azagro
// a Santa Rosa (lo desembolsado), no sobre el precio al cliente; con margen en
// $ fijo la factura es costo + monto. Por eso con % el precio al cliente
// coincide con el motor ASR pero la partición no (320.08 que el ASR le
// atribuye a Azagro aquí son financiamiento de Santa Rosa), y con $ fijo el
// motor ASR cobraba 320.08 de menos (ESTADO.md § 3.d). Estas funciones son
// NUEVAS: no reescriben las de arriba.
// ---------------------------------------------------------------------------

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** Lo que Santa Rosa desembolsa por unidad: costo puesto + margen (el margen % es de esta cifra). */
export function linealDisbursedUnit(landed: number, margin: MarginSpec) {
  return Math.max(0, landed) + marginUnitOf(margin, Math.max(0, landed), 0);
}

/** Costo financiero por unidad del lineal: lo desembolsado × (tasa de cobro + spread) × días / 360. Contado → 0. */
export function linealFinanceUnit(i: { disbursed: number; rate: number; days: number }) {
  if (i.days <= 0) return 0;
  return round2((Math.max(0, i.disbursed) * Math.max(0, i.rate) * Math.max(0, i.days)) / YEAR_DAYS);
}

/**
 * Directo (lineal): margen → factura a Santa Rosa → financiamiento → precio al cliente.
 *   disbursed = costo puesto + margen       (% → costo ÷ (1 − margen); $ → costo + monto)
 *   finance   = disbursed × tasa × días / 360
 *   price     = disbursed + finance
 */
export function linealPriceFromMargin(i: { landed: number; margin: MarginSpec; rate: number; days: number }) {
  const disbursed = round4(linealDisbursedUnit(i.landed, i.margin));
  const finance = linealFinanceUnit({ disbursed, rate: i.rate, days: i.days });
  return { disbursed, finance, price: round4(disbursed + finance) };
}

/**
 * Inverso (lineal): del precio al cliente se despeja la factura a Santa Rosa
 * y de ahí el margen. price = disbursed × (1 + k) con k = tasa × días / 360:
 *   disbursed = price ÷ (1 + k) · utilidad = disbursed − costo puesto ·
 *   margen % = utilidad / disbursed × 100 (sobre la factura, no sobre el precio).
 */
export function linealMarginFromPrice(i: { price: number; landed: number; rate: number; days: number; mode: MarginMode }): MarginSpec & { disbursed: number; finance: number } {
  const k = i.days > 0 ? (Math.max(0, i.rate) * i.days) / YEAR_DAYS : 0;
  const disbursed = round4(Math.max(0, i.price) / (1 + k));
  const nominal = round4(disbursed - Math.max(0, i.landed));
  const pct = disbursed > 0 ? round4((nominal / disbursed) * 100) : 0;
  return { mode: i.mode, pct, nominal, disbursed, finance: round4(Math.max(0, i.price) - disbursed) };
}

/** Precio a crédito del lineal a partir del de contado (cotización directa): contado = costo + margen = lo desembolsado. */
export function creditFromCashLineal(i: { cash: number; rate: number; days: number }) {
  const cash = Math.max(0, i.cash);
  if (i.days <= 0) return cash;
  return round4(cash + linealFinanceUnit({ disbursed: cash, rate: i.rate, days: i.days }));
}

function priceSaleLineal(i: PriceInput): PriceResult {
  const qty = i.qty || 0;
  const landedUnit = Math.max(0, i.cost) + Math.max(0, i.freight) + Math.max(0, i.other);
  const rate = Math.max(0, i.tiie) + Math.max(0, i.costSpread);
  const margin: MarginSpec =
    i.marginMode === "nominal"
      ? { mode: "nominal", pct: 0, nominal: Math.max(0, i.marginNominal) }
      : { mode: "pct", pct: Math.max(0, i.marginPct), nominal: 0 };
  const marginUnit = marginUnitOf(margin, landedUnit, 0);
  const disbursedUnit = i.days > 0 ? landedUnit + marginUnit : 0;
  const financeUnit = linealFinanceUnit({ disbursed: landedUnit + marginUnit, rate, days: i.days });
  const priceUnit = landedUnit + marginUnit + financeUnit;
  const invoice = landedUnit + marginUnit;
  return {
    landedUnit,
    marginUnit,
    commissionUnit: 0,
    layer1Unit: financeUnit,
    financeUnit,
    priceUnit,
    marginPct: invoice > 0 ? (marginUnit / invoice) * 100 : 0,
    marginNominal: marginUnit,
    disbursedUnit,
    landed: landedUnit * qty,
    margin: marginUnit * qty,
    finance: financeUnit * qty,
    price: priceUnit * qty,
    rate,
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

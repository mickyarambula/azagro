import { marginValid, marginUnit, priceFromMargin, type MarginSpec } from "@/lib/erp/margins";
import { linealFinanceUnit, type FinancingBase } from "@/lib/erp/pricing";

/**
 * Escalera de plazos (herramienta interna para decidir). La hoja real de
 * cotización de la dirección tiene seis columnas de precio: contado, 30, 60,
 * 90, 120 y 150 días. Aquí se arma esa escalera por partida:
 *
 *   * Los plazos se leen de Ajustes (company_settings.quote_terms, lista
 *     editable; la migración 0020 la siembra con 0/30/60/90/120/150).
 *   * Siguen siendo dos márgenes: el de contado aplica a la columna de
 *     contado (0 días) y el de crédito a TODAS las columnas a plazo.
 *   * Cada columna trae precio, financiamiento y utilidad, con la fórmula de
 *     margins.ts: precio = (costo puesto + financiamiento) ÷ (1 − margen).
 *
 * Al cliente NO le llega la escalera: el documento lleva solo dos precios, el
 * de contado y el del plazo acordado (quotes.credit_days). Cambiar el plazo
 * acordado toma la columna que corresponda.
 */

/** Cómo se guarda la lista en Ajustes: "0, 30, 60, 90, 120, 150". */
export function parseTerms(text: string | null | undefined): number[] | null {
  if (text == null) return null;
  const parts = String(text)
    .split(/[,\s;/]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    nums.push(Number(p));
  }
  return [...new Set(nums)].sort((a, b) => a - b);
}

export function formatTerms(terms: number[]) {
  return terms.join(", ");
}

/** Etiqueta de columna: "Contado" o "30 d". */
export function termLabel(days: number) {
  return days <= 0 ? "Contado" : `${days} d`;
}

/**
 * Columnas de la escalera: la lista de Ajustes más el plazo acordado si no
 * está en ella (un plazo de 45 días se ve aunque la escalera vaya de 30 en
 * 30). Contado (0) siempre va: es el otro precio que sale al cliente.
 */
export function ladderTerms(terms: number[], agreed: number) {
  const all = new Set<number>([0, ...terms.filter((t) => t >= 0)]);
  if (agreed > 0) all.add(agreed);
  return [...all].sort((a, b) => a - b);
}

export type LadderStep = {
  days: number;
  /** Financiamiento por unidad dentro del precio de esa columna (0 al contado). */
  finance: number;
  /** Precio por unidad, o null si la columna no tiene margen capturado (o no es válido). */
  price: number | null;
  /** Utilidad por unidad = precio − costo puesto − financiamiento. */
  utility: number | null;
  /** Utilidad como % del precio (el margen). */
  pct: number | null;
  agreed: boolean;
};

/**
 * La escalera de una partida. `financeAt(días)` es el financiamiento por
 * unidad de esa columna (lo calcula quien tiene el costo real: el servidor, o
 * la pantalla de la solicitud que sí ve costos).
 *
 * La escalera RECIBE la base del circuito (paso 3): con "costo_comision"
 * (ASR, o sin decir nada) es exactamente la de siempre; con "costo_margen"
 * (lineal) cada columna a plazo financia costo + margen a la tasa anual de
 * `rateAt(días)` y el % es sobre la factura a Santa Rosa. No lee el catálogo.
 */
export function ladderFor(i: {
  terms: number[];
  agreed: number;
  landed: number;
  marginCash: MarginSpec | null;
  marginCredit: MarginSpec | null;
  financeAt: (days: number) => number;
  financingBase?: FinancingBase;
  /** Solo lineal: tasa anual que entra al precio (tasa de cobro + spread de línea) para esa columna. */
  rateAt?: (days: number) => number;
}): LadderStep[] {
  if (i.financingBase === "costo_margen") return ladderForLineal(i);
  return ladderTerms(i.terms, i.agreed).map((days) => {
    const margin = days <= 0 ? i.marginCash : i.marginCredit;
    const finance = days <= 0 ? 0 : Math.max(0, i.financeAt(days));
    if (!marginValid(margin)) return { days, finance, price: null, utility: null, pct: null, agreed: days === i.agreed };
    const price = priceFromMargin({ landed: i.landed, finance, margin });
    const utility = Math.round((price - i.landed - finance) * 10000) / 10000;
    return {
      days,
      finance,
      price,
      utility,
      pct: price > 0 ? Math.round((utility / price) * 100 * 10000) / 10000 : null,
      agreed: days === i.agreed,
    };
  });
}

/**
 * Escalera del lineal: la factura a Santa Rosa (costo + margen) es la misma en
 * todas las columnas a plazo; lo que cambia es el financiamiento que Santa
 * Rosa le agrega al cliente. Contado: costo + margen contado, sin financiar.
 */
function ladderForLineal(i: Parameters<typeof ladderFor>[0]): LadderStep[] {
  const round4 = (n: number) => Math.round(n * 10000) / 10000;
  return ladderTerms(i.terms, i.agreed).map((days) => {
    const margin = days <= 0 ? i.marginCash : i.marginCredit;
    if (!marginValid(margin)) return { days, finance: 0, price: null, utility: null, pct: null, agreed: days === i.agreed };
    const disbursed = round4(i.landed + marginUnit(margin, i.landed, 0));
    const finance = days <= 0 ? 0 : linealFinanceUnit({ disbursed, rate: i.rateAt ? i.rateAt(days) : 0, days });
    const price = round4(disbursed + finance);
    const utility = round4(price - i.landed - finance);
    return {
      days,
      finance,
      price,
      utility,
      pct: disbursed > 0 ? round4((utility / disbursed) * 100) : null,
      agreed: days === i.agreed,
    };
  });
}

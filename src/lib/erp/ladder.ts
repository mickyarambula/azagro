import { marginValid, priceFromMargin, type MarginSpec } from "@/lib/erp/margins";

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
 */
export function ladderFor(i: {
  terms: number[];
  agreed: number;
  landed: number;
  marginCash: MarginSpec | null;
  marginCredit: MarginSpec | null;
  financeAt: (days: number) => number;
}): LadderStep[] {
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

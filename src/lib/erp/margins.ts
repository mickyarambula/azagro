/**
 * Dos márgenes por partida: uno para el precio de contado y otro para el de
 * crédito. Son independientes: cambiar uno no mueve el otro.
 *
 *   precio contado = costo puesto + margen contado          (sin financiamiento)
 *   precio crédito = costo puesto + margen crédito + financiamiento
 *
 * El financiamiento se calcula en pricing.ts (no cambia). Aquí solo vive lo
 * que hace falta para ir en los dos sentidos:
 *   * directo: margen → precio (la solicitud captura el margen).
 *   * inverso: precio → margen (la cotización captura el precio final y el
 *     margen guardado se recalcula). Una utilidad negativa se guarda tal cual:
 *     se avisa, no se bloquea.
 */

export type MarginMode = "pct" | "nominal";
export type MarginSpec = { mode: MarginMode; pct: number; nominal: number };
export type Offer = "cash" | "credit";

export const OFFER_LABEL: Record<Offer, string> = { cash: "contado", credit: "crédito" };

/** Fila con las columnas nuevas (margin_cash_* / margin_credit_*) y, opcionalmente, el margen único viejo. */
export type MarginRow = {
  margin_cash_mode?: string | null;
  margin_cash_pct?: string | number | null;
  margin_cash_nominal?: string | number | null;
  margin_credit_mode?: string | null;
  margin_credit_pct?: string | number | null;
  margin_credit_nominal?: string | number | null;
  margin_mode?: string | null;
  margin_pct?: string | number | null;
  margin_nominal?: string | number | null;
};

function n(v: string | number | null | undefined) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

/**
 * Margen guardado de una columna. Si la partida todavía no tiene el margen
 * nuevo (fila anterior a la migración 0017), cae al margen único viejo; si
 * tampoco hay, 12% (el valor por omisión de siempre en la solicitud).
 * `legacy: true` en la respuesta avisa que el dato viene del margen viejo.
 */
export function marginOf(row: MarginRow, which: Offer): MarginSpec & { legacy: boolean } {
  const mode = which === "cash" ? row.margin_cash_mode : row.margin_credit_mode;
  if (mode === "pct" || mode === "nominal") {
    return {
      mode,
      pct: n(which === "cash" ? row.margin_cash_pct : row.margin_credit_pct),
      nominal: n(which === "cash" ? row.margin_cash_nominal : row.margin_credit_nominal),
      legacy: false,
    };
  }
  if (row.margin_mode === "pct" || row.margin_mode === "nominal") {
    return { mode: row.margin_mode, pct: n(row.margin_pct), nominal: n(row.margin_nominal), legacy: true };
  }
  return { mode: "pct", pct: row.margin_pct == null ? 12 : n(row.margin_pct), nominal: n(row.margin_nominal), legacy: true };
}

/** Margen por unidad en pesos según el modo. No recorta negativos: lo que se capturó es lo que vale. */
export function marginUnit(m: MarginSpec, landed: number) {
  return m.mode === "nominal" ? m.nominal : (landed * m.pct) / 100;
}

/** Directo: precio final por unidad = costo puesto + margen + financiamiento (0 al contado). */
export function priceFromMargin(i: { landed: number; finance: number; margin: MarginSpec }) {
  return Math.round((i.landed + marginUnit(i.margin, i.landed) + Math.max(0, i.finance)) * 10000) / 10000;
}

/**
 * Inverso: del precio final se despejan utilidad y margen %.
 *   utilidad = precio − costo puesto − financiamiento
 *   margen % = utilidad / costo puesto × 100
 * Se conserva el modo que ya tenía la partida; los dos valores quedan
 * consistentes entre sí.
 */
export function marginFromPrice(i: { price: number; landed: number; finance: number; mode: MarginMode }): MarginSpec {
  const nominal = Math.round((i.price - i.landed - Math.max(0, i.finance)) * 10000) / 10000;
  const pct = i.landed > 0 ? Math.round(((nominal / i.landed) * 100) * 10000) / 10000 : 0;
  return { mode: i.mode, pct, nominal };
}

/** Texto de bitácora: "$1500" o "12%". */
export function marginText(m: MarginSpec) {
  return m.mode === "nominal" ? `$${Number(m.nominal)}` : `${Number(m.pct)}%`;
}

/** Los dos valores en sincronía para guardar: si el modo es %, el $ se deriva, y al revés. */
export function normalizeMargin(m: MarginSpec, landed: number): MarginSpec {
  if (m.mode === "nominal") {
    return { mode: "nominal", nominal: m.nominal, pct: landed > 0 ? Math.round(((m.nominal / landed) * 100) * 10000) / 10000 : 0 };
  }
  return { mode: "pct", pct: m.pct, nominal: Math.round(((landed * m.pct) / 100) * 10000) / 10000 };
}

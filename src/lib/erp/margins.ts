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
 *
 * NO HAY MARGEN POR OMISIÓN. Una partida sin margen capturado devuelve `null`
 * y toda la pantalla dice "sin margen": inventar un 12% (o un 0%) es decidir
 * la utilidad por el dueño y hace que los reportes muestren ganancias que
 * nadie eligió. Mismo criterio que el costo: sin dato, no hay número.
 */

export type MarginMode = "pct" | "nominal";
export type MarginSpec = { mode: MarginMode; pct: number; nominal: number };
export type Offer = "cash" | "credit";

export const OFFER_LABEL: Record<Offer, string> = { cash: "contado", credit: "crédito" };

/** Texto único para la partida sin margen capturado. */
export const SIN_MARGEN = "Sin margen";

/**
 * De dónde salió el margen guardado:
 *   "captura"   — alguien lo escribió (el margen, o el precio del que se despejó).
 *   "migracion" — lo copió la migración 0018 desde el margen único anterior.
 * Nulo en filas anteriores a 0018 que nunca se volvieron a guardar.
 */
export type MarginSource = "captura" | "migracion";

/** Fila con las columnas nuevas (margin_cash_* / margin_credit_*) y, opcionalmente, el margen único viejo. */
export type MarginRow = {
  margin_cash_mode?: string | null;
  margin_cash_pct?: string | number | null;
  margin_cash_nominal?: string | number | null;
  margin_cash_source?: string | null;
  margin_credit_mode?: string | null;
  margin_credit_pct?: string | number | null;
  margin_credit_nominal?: string | number | null;
  margin_credit_source?: string | null;
  margin_mode?: string | null;
  margin_pct?: string | number | null;
  margin_nominal?: string | number | null;
};

export type StoredMargin = MarginSpec & { legacy: boolean; source: MarginSource | null };

function n(v: string | number | null | undefined) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function source(v: string | null | undefined): MarginSource | null {
  return v === "captura" || v === "migracion" ? v : null;
}

/**
 * Margen guardado de una columna, o `null` si la partida no tiene margen.
 * Nulo NO es cero: es "nadie lo ha capturado todavía".
 *
 * Orden: 1) columna nueva (margin_cash_* / margin_credit_*); 2) margen único
 * anterior a la migración 0017, si de verdad trae un número guardado (marcado
 * `legacy`); 3) sin margen.
 */
export function marginOf(row: MarginRow, which: Offer): StoredMargin | null {
  const mode = which === "cash" ? row.margin_cash_mode : row.margin_credit_mode;
  const pct = which === "cash" ? row.margin_cash_pct : row.margin_credit_pct;
  const nominal = which === "cash" ? row.margin_cash_nominal : row.margin_credit_nominal;
  if ((mode === "pct" || mode === "nominal") && (pct != null || nominal != null)) {
    return {
      mode,
      pct: n(pct),
      nominal: n(nominal),
      legacy: false,
      source: source(which === "cash" ? row.margin_cash_source : row.margin_credit_source),
    };
  }
  if ((row.margin_mode === "pct" || row.margin_mode === "nominal") && (row.margin_pct != null || row.margin_nominal != null)) {
    return { mode: row.margin_mode, pct: n(row.margin_pct), nominal: n(row.margin_nominal), legacy: true, source: null };
  }
  return null;
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

/** Texto de bitácora: "$1500" o "12%". Sin margen capturado, lo dice. */
export function marginText(m: MarginSpec | null) {
  if (!m) return SIN_MARGEN.toLowerCase();
  return m.mode === "nominal" ? `$${Number(m.nominal)}` : `${Number(m.pct)}%`;
}

/** Los dos valores en sincronía para guardar: si el modo es %, el $ se deriva, y al revés. */
export function normalizeMargin(m: MarginSpec, landed: number): MarginSpec {
  if (m.mode === "nominal") {
    return { mode: "nominal", nominal: m.nominal, pct: landed > 0 ? Math.round(((m.nominal / landed) * 100) * 10000) / 10000 : 0 };
  }
  return { mode: "pct", pct: m.pct, nominal: Math.round(((landed * m.pct) / 100) * 10000) / 10000 };
}

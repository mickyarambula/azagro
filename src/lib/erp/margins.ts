/**
 * Dos márgenes por partida: uno para el precio de contado y otro para el de
 * crédito. Son independientes: cambiar uno no mueve el otro.
 *
 * EL MARGEN ES SOBRE EL PRECIO DE VENTA, no un recargo sobre el costo (hojas
 * de cotización reales de la dirección, 3-sep-2026: 14,420 ÷ (1 − 0.065) =
 * 15,422.46 exacto; un 6.5% sobre costo daría 15,357). Y el financiamiento se
 * suma al costo ANTES de aplicar el margen:
 *
 *   precio = (costo puesto + financiamiento) ÷ (1 − margen %)
 *   precio =  costo puesto + financiamiento + margen $        (monto fijo)
 *
 * De contado el financiamiento es 0. La utilidad en pesos es la misma por las
 * dos vías: utilidad = precio − costo puesto − financiamiento, y ese monto es
 * exactamente margen % del precio.
 *
 * Caso de prueba del dueño: costo puesto 10,000, TIIE 6.9%, 150 días, margen
 * crédito 6.5% → financiamiento 558.71, precio (10,000 + 558.71) ÷ 0.935 =
 * 11,292.74, utilidad 734.03 = 6.5% del precio. Contado con 5%: 10,000 ÷
 * 0.95 = 10,526.32.
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

function round4(x: number) {
  return Math.round(x * 10000) / 10000;
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

/**
 * Un margen % sobre el precio tiene que ser menor que 100: con 100% el precio
 * sería infinito (se divide entre 1 − margen). No es un número de negocio, es
 * el límite de la fórmula. Un margen negativo sí es válido (vender con pérdida
 * a propósito: se avisa, no se bloquea).
 */
export function marginValid(m: MarginSpec | null): m is MarginSpec {
  return m != null && (m.mode === "nominal" || m.pct < 100);
}

export function marginInvalidMessage(m: MarginSpec) {
  return `Margen ${Number(m.pct)}% sobre el precio: tiene que ser menor a 100%.`;
}

/**
 * Margen por unidad en pesos según el modo. Con margen %, es la utilidad que
 * deja precio = (costo puesto + financiamiento) ÷ (1 − margen): base ×
 * margen / (100 − margen). No recorta negativos: lo que se capturó es lo que vale.
 */
export function marginUnit(m: MarginSpec, landed: number, finance = 0) {
  if (m.mode === "nominal") return m.nominal;
  if (!marginValid(m)) throw new Error(marginInvalidMessage(m));
  const base = landed + Math.max(0, finance);
  return (base * m.pct) / (100 - m.pct);
}

/**
 * Directo: precio final por unidad.
 *   %  → (costo puesto + financiamiento) ÷ (1 − margen)
 *   $  →  costo puesto + financiamiento + monto
 * Financiamiento 0 al contado.
 */
export function priceFromMargin(i: { landed: number; finance: number; margin: MarginSpec }) {
  const fin = Math.max(0, i.finance);
  return round4(i.landed + fin + marginUnit(i.margin, i.landed, fin));
}

/**
 * Inverso: del precio final se despejan utilidad y margen %.
 *   utilidad = precio − costo puesto − financiamiento
 *   margen % = utilidad / precio × 100          (sobre el precio de venta)
 * Se conserva el modo que ya tenía la partida; los dos valores quedan
 * consistentes entre sí, y priceFromMargin(marginFromPrice(p)) = p.
 */
export function marginFromPrice(i: { price: number; landed: number; finance: number; mode: MarginMode }): MarginSpec {
  const nominal = round4(i.price - i.landed - Math.max(0, i.finance));
  const pct = i.price > 0 ? round4((nominal / i.price) * 100) : 0;
  return { mode: i.mode, pct, nominal };
}

/** Texto de bitácora: "$1500" o "12%". Sin margen capturado, lo dice. */
export function marginText(m: MarginSpec | null) {
  if (!m) return SIN_MARGEN.toLowerCase();
  return m.mode === "nominal" ? `$${Number(m.nominal)}` : `${Number(m.pct)}%`;
}

/**
 * Los dos valores en sincronía para guardar: si el modo es %, el $ se deriva,
 * y al revés. Como el % es sobre el precio, hace falta el financiamiento de
 * esa columna (0 al contado) para que el $ y el % describan el mismo precio.
 */
export function normalizeMargin(m: MarginSpec, landed: number, finance = 0): MarginSpec {
  const fin = Math.max(0, finance);
  if (m.mode === "nominal") {
    const price = landed + fin + m.nominal;
    return { mode: "nominal", nominal: m.nominal, pct: price > 0 ? round4((m.nominal / price) * 100) : 0 };
  }
  return { mode: "pct", pct: m.pct, nominal: round4(marginUnit(m, landed, fin)) };
}

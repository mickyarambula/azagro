/**
 * CÓMO SE REPARTE EL COSTO DE UN VIAJE ENTRE LOS PRODUCTOS QUE TRAJO
 * (Decisiones 100 y 101, pieza 2 — 21-sep-2026).
 *
 * El criterio, decidido con el dueño el 21-sep: **un costo compartido se
 * reparte según lo que lo causó**, y lo que hace que un camión cueste lo que
 * cuesta es el **peso** — un camión de insumos agrícolas topa con su límite de
 * toneladas mucho antes de llenarse de bulto. Una tonelada de urea y una de
 * foliar caro le cuestan al fletero exactamente lo mismo.
 *
 * **Nunca por importe.** Es el atajo del contador y sesga justo donde duele:
 * en un camión de 20 toneladas de urea ($160,000) y 1 de foliar ($60,000) con
 * $21,000 de flete, por peso cada uno carga $1,000 por tonelada; por importe
 * la urea carga $764 y el foliar $5,727 — casi seis veces el flete que causó.
 * La urea es el producto de volumen y margen delgado: creer que cuesta 2.6 %
 * menos de lo que cuesta es cotizar por debajo de lo que se puede, y al mismo
 * tiempo el producto bueno parece peor negocio del que es. El número existe
 * para decidir; sesgado, hace decidir al revés.
 *
 * **Antes de repartir: si se puede saber a quién le toca, no se reparte.** Una
 * sola partida se lleva el viaje completo. Repartir es lo que se hace cuando
 * NO se puede rastrear, no la primera opción.
 *
 * Sin imports a propósito: la prueba lo carga directo.
 */

export type TripLine = {
  /** `sales_lines`/`purchase_lines`.id — la partida, nunca el producto (grupo D). */
  lineId: number;
  qty: number;
  /** Unidad de la partida. Vacía cuenta como DESCONOCIDA, no como «la misma». */
  uom: string;
  /** Kilos que pesa UNA unidad. null = sin capturar (regla 9). */
  unitWeight: number | null;
};

export type TripSplit = {
  perLine: Array<{ lineId: number; unit: number; amount: number }>;
  /** Lo que no alcanzó a repartirse por el redondeo. Siempre |residual| < 0.01. */
  residual: number;
  /** Con qué se repartió, para poder decirlo en pantalla y en bitácora. */
  basis: "unica" | "cantidad" | "peso" | "sin-costo";
};

/** Por qué NO se pudo repartir. Nunca se cae a otra base: sería inventar. */
export type TripSplitStop = { stop: string };

const r4 = (n: number) => Math.round(n * 10000) / 10000;
const r2 = (n: number) => Math.round(n * 100) / 100;

export function isStop<T extends object>(x: T | TripSplitStop): x is TripSplitStop {
  return (x as TripSplitStop).stop !== undefined;
}

/**
 * LA BASE CON LA QUE SE REPARTE (Decisión 101) — una sola, para el reparto
 * dentro de un camión y para el reparto ENTRE camiones.
 *
 * Tenerla en dos lados fue el error de la primera versión: el reparto entre
 * partidas iba por peso y el reparto entre recepciones sumaba cantidades
 * crudas. Con 10 toneladas de urea y 1,000 litros de foliar, eso le cargaba al
 * camión de urea $207.92 de $21,000 cuando le tocaban $19,090.91 — $18,883 mal
 * asignados y el precio de la urea $2,221 por tonelada por debajo del real.
 */
export function splitBasis(lines: TripLine[]): { base: number[]; basis: "cantidad" | "peso" } | TripSplitStop {
  const uoms = new Set(lines.map((l) => (l.uom ?? "").trim().toUpperCase()));
  // Una unidad VACÍA no cuenta como «la misma»: son dos huecos.
  if (uoms.size === 1 && !uoms.has("")) return { base: lines.map((l) => l.qty), basis: "cantidad" };
  const sinPeso = lines.filter((l) => !(l.unitWeight != null && l.unitWeight > 0));
  if (sinPeso.length) {
    return {
      stop:
        `Este viaje trae unidades distintas (${[...uoms].filter(Boolean).join(", ") || "sin unidad"}) y no se pueden sumar entre sí. ` +
        `Captura cuánto pesa una unidad de ${sinPeso.length === 1 ? "el producto que falta" : `los ${sinPeso.length} productos que faltan`}, o reparte el flete a mano.`,
    };
  }
  return { base: lines.map((l) => l.qty * Number(l.unitWeight)), basis: "peso" };
}

/**
 * QUÉ PARTE DEL FLETE DE LA ORDEN LE TOCA A ESTA RECEPCIÓN (Decisión 101).
 *
 * Misma base que el reparto dentro del camión: por peso, porque el peso es lo
 * que consume el camión; con todo en la misma unidad, por cantidad, que ES por
 * peso; con unidades mezcladas y sin peso capturado, **se detiene**.
 */
export function tripShare(i: { now: TripLine[]; order: TripLine[] }): { frac: number; basis: "cantidad" | "peso" } | TripSplitStop {
  const vivas = i.order.filter((l) => l.qty > 0);
  if (!vivas.length) return { frac: 1, basis: "cantidad" };
  const bOrder = splitBasis(vivas);
  if (isStop(bOrder)) return bOrder;
  const total = bOrder.base.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return { frac: 1, basis: bOrder.basis };
  const ahora = i.now.filter((l) => l.qty > 0);
  if (!ahora.length) return { frac: 0, basis: bOrder.basis };
  const bNow = splitBasis(ahora);
  if (isStop(bNow)) return bNow;
  // La base de lo que llega se mide con la MISMA vara que la de la orden: si
  // la orden se mide por peso, lo que llega también, o la fracción compararía
  // kilos contra unidades.
  const base = bOrder.basis === "peso" ? ahora.map((l) => l.qty * Number(l.unitWeight ?? 0)) : ahora.map((l) => l.qty);
  if (bOrder.basis === "peso" && ahora.some((l) => !(l.unitWeight != null && l.unitWeight > 0))) {
    return splitBasis([...vivas, ...ahora]) as TripSplitStop;
  }
  return { frac: Math.min(1, base.reduce((a, b) => a + b, 0) / total), basis: bOrder.basis };
}

export function splitTripCost(i: { total: number; lines: TripLine[] }): TripSplit | TripSplitStop {
  const lines = i.lines.filter((l) => l.qty > 0);
  if (!lines.length) return { stop: "El viaje no trajo ninguna partida con cantidad: no hay entre qué repartir." };

  const total = r2(i.total);
  // Sin costo de viaje no se reparte nada, y el camino de siempre no cambia
  // ni un centavo. Es el caso que la prueba del motor congelado fija.
  if (total <= 0.0001) {
    return { perLine: lines.map((l) => ({ lineId: l.lineId, unit: 0, amount: 0 })), residual: 0, basis: "sin-costo" };
  }

  // Una sola partida: se le ASIGNA completo. No hay reparto que hacer.
  if (lines.length === 1) {
    const l = lines[0]!;
    return { perLine: [{ lineId: l.lineId, unit: r4(total / l.qty), amount: total }], residual: 0, basis: "unica" };
  }

  // La MISMA base que usa el reparto entre camiones: una sola regla.
  const b = splitBasis(lines);
  if (isStop(b)) return b;
  const base = b.base;
  const basis: TripSplit["basis"] = b.basis;

  const suma = base.reduce((s, b) => s + b, 0);
  if (!(suma > 0)) return { stop: "La base del reparto salió en cero: no hay cantidad ni peso con qué repartir." };

  // Se reparte por importe y de ahí sale el unitario, no al revés: el unitario
  // va a 4 decimales (así lo guarda el kardex) y redondearlo primero perdería
  // centavos que después no cuadran contra lo que se le pagó al fletero.
  const perLine = lines.map((l, k) => {
    const amount = r2((total * base[k]!) / suma);
    return { lineId: l.lineId, unit: r4(amount / l.qty), amount };
  });

  // El redondeo sobra o falta unos centavos. Se cargan a la partida de mayor
  // base —la que más camión ocupó— y lo que aún no cuadre se devuelve para que
  // la pantalla lo diga en vez de tragárselo.
  let repartido = r2(perLine.reduce((s, p) => s + p.amount, 0));
  const diff = r2(total - repartido);
  if (Math.abs(diff) > 0.0001) {
    let mayor = 0;
    for (let k = 1; k < base.length; k++) if (base[k]! > base[mayor]!) mayor = k;
    perLine[mayor]!.amount = r2(perLine[mayor]!.amount + diff);
    perLine[mayor]!.unit = r4(perLine[mayor]!.amount / lines[mayor]!.qty);
    repartido = r2(perLine.reduce((s, p) => s + p.amount, 0));
  }
  return { perLine, residual: r2(total - repartido), basis };
}

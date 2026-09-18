/**
 * BLOQUE A.2 — LA POSICIÓN CAMBIARIA (Decisiones 83-86, MODELO-NEGOCIO.md § 11.6).
 *
 * Contesta las cuatro preguntas del dueño sobre el dólar:
 *   1. Cuánto se debe y cuánto deben en dólares, por cubeta de vencimiento.
 *   2. A qué TC se pactó cada documento vivo, y cuál es el TC de hoy.
 *   3. Cuánto se gana o se pierde si el dólar se mueve X pesos.
 *   4. Qué parte está cubierta por las dos dinámicas y qué parte está abierta.
 *
 * Todo se calcula EN VIVO, sin columna "exposición" y sin migración: las
 * facturas, los pedidos y los movimientos de banco son la verdad (mismo
 * patrón que `creditExposure`, Decisión 51, y que el kardex, regla 2).
 *
 * Este archivo es PURO: recibe números y devuelve números, sin tocar la base.
 * La consulta que lo alimenta vive en `fx-position-query.ts`.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Días entre dos fechas, misma aritmética que `daysBetween` (credit.ts). Este
 * archivo es PURO y no importa nada: así la prueba puede cargarlo directo y
 * fijar los números, igual que `parciales.ts`. Es aritmética de calendario, no
 * una regla de negocio — la regla del tipo de cambio («un TC real es > 1»)
 * vive en UN solo lugar, `isUsdFx` (fx.ts), y se aplica en la frontera: quien
 * llama entrega `fxAgreed` ya en null cuando no hay TC pactado.
 */
function diasEntre(from: string, to: string) {
  const a = Date.parse(from.slice(0, 10) + "T00:00:00");
  const b = Date.parse(to.slice(0, 10) + "T00:00:00");
  return Math.round((b - a) / 86400000);
}

// ---------------------------------------------------------------------------
// Cubetas
// ---------------------------------------------------------------------------

/**
 * Las cubetas son de TESORERÍA, no de cobranza: contestan «qué día necesito
 * esos dólares y qué día me llegan», y por eso se paran en la fecha de cobro o
 * pago convenida (`due_date`), la misma de los dos lados — nunca el plazo
 * financiero de la mora, que solo existe del lado cliente y dejaría las dos
 * puntas de una misma cobertura en cubetas distintas (Decisión 83).
 *
 * Son DISTINTAS a propósito de las de `/vencimientos` (cobranza a 30 días):
 * esta mira hasta 150 días, que es el plazo financiero real del negocio.
 *
 * «Sin fecha» no es un descuido: una orden de compra no tiene ninguna fecha de
 * vencimiento en la base — solo el día en que se capturó — y no se le inventa
 * una (regla 9). Su monto en dólares se enseña, pero en su propia casilla.
 */
export const FX_BUCKETS = ["vencido", "hoy", "1-30", "31-60", "61-90", "91-150", "+150", "sin-fecha"] as const;
export type FxBucket = (typeof FX_BUCKETS)[number];

export const FX_BUCKET_LABEL: Record<FxBucket, string> = {
  vencido: "Vencido",
  hoy: "Hoy",
  "1-30": "1-30 días",
  "31-60": "31-60 días",
  "61-90": "61-90 días",
  "91-150": "91-150 días",
  "+150": "Más de 150 días",
  "sin-fecha": "Sin fecha",
};

/** En qué cubeta cae una fecha de vencimiento, vista desde el corte. */
export function bucketFor(due: string | null | undefined, asOf: string): FxBucket {
  if (!due) return "sin-fecha";
  const dias = diasEntre(asOf, due);
  if (dias < 0) return "vencido";
  if (dias === 0) return "hoy";
  if (dias <= 30) return "1-30";
  if (dias <= 60) return "31-60";
  if (dias <= 90) return "61-90";
  if (dias <= 150) return "91-150";
  return "+150";
}

// ---------------------------------------------------------------------------
// Los documentos que forman la posición
// ---------------------------------------------------------------------------

export type FxSide = "cobrar" | "pagar";

/**
 * Un renglón de exposición. `usd` es siempre lo ABIERTO en dólares (positivo):
 * de una factura, su saldo; de lo comprometido, lo que todavía no se factura.
 * `fxAgreed` null = documento en dólares SIN TC pactado (Decisión 85): cuenta
 * como dólares, pero NO se valúa en pesos ni entra a ningún total en pesos.
 */
export type FxDoc = {
  kind: "FV" | "FP" | "PV" | "OC";
  name: string;
  partner: string;
  side: FxSide;
  /** true = comprometido (pedido u orden sin facturar); false = factura viva. */
  committed: boolean;
  usd: number;
  fxAgreed: number | null;
  due: string | null;
  /** Folio del pedido al que pertenece, si lo tiene: con eso se clasifica la cobertura por deal. */
  deal?: string | null;
};

export type FxCash = {
  /** Dólares en caja, todos. */
  usd: number;
  /** La parte con costo conocido y su TC promedio (`usdCashAverage`). */
  tracked: number;
  sinTc: number;
  avgFx: number | null;
};

// ---------------------------------------------------------------------------
// Pregunta 1 — cuánto se debe y deben, por cubeta
// ---------------------------------------------------------------------------

export type BucketRow = {
  bucket: FxBucket;
  label: string;
  /** Facturas vivas del cliente, en dólares. */
  cxc: number;
  /** Facturas vivas del proveedor, en dólares. */
  cxp: number;
  /** Pedidos confirmados o entregados sin facturar, en dólares. */
  ventaComprometida: number;
  /** Órdenes confirmadas sin recibir, en dólares. */
  compraComprometida: number;
  /** (cxc + venta comprometida) − (cxp + compra comprometida). */
  neto: number;
  /** Documentos sin TC pactado que caen en esta cubeta (no valuables). */
  sinTcUsd: number;
};

/** Reparte los documentos en sus cubetas. Los que no tienen TC pactado suman aparte. */
export function bucketize(docs: FxDoc[], asOf: string): BucketRow[] {
  const vacio = () =>
    ({ cxc: 0, cxp: 0, ventaComprometida: 0, compraComprometida: 0, sinTcUsd: 0 }) as Omit<BucketRow, "bucket" | "label" | "neto">;
  const mapa = new Map<FxBucket, ReturnType<typeof vacio>>();
  for (const b of FX_BUCKETS) mapa.set(b, vacio());

  for (const d of docs) {
    const fila = mapa.get(bucketFor(d.due, asOf))!;
    // Decisión 85: sin TC pactado no se sabe siquiera si ese número son pesos
    // o dólares, así que el documento se cuenta APARTE y no entra a ningún
    // total que después se multiplique por un tipo de cambio — ni a la
    // posición neta, ni a la sensibilidad, ni a la cobertura. La pantalla lo
    // enseña con su nombre, su socio y su importe, y dice cómo se corrige.
    if (d.fxAgreed == null) {
      fila.sinTcUsd += d.usd;
      continue;
    }
    if (d.side === "cobrar") {
      if (d.committed) fila.ventaComprometida += d.usd;
      else fila.cxc += d.usd;
    } else {
      if (d.committed) fila.compraComprometida += d.usd;
      else fila.cxp += d.usd;
    }
  }

  return FX_BUCKETS.map((bucket) => {
    const f = mapa.get(bucket)!;
    const neto = f.cxc + f.ventaComprometida - (f.cxp + f.compraComprometida);
    return {
      bucket,
      label: FX_BUCKET_LABEL[bucket],
      cxc: r2(f.cxc),
      cxp: r2(f.cxp),
      ventaComprometida: r2(f.ventaComprometida),
      compraComprometida: r2(f.compraComprometida),
      neto: r2(neto),
      sinTcUsd: r2(f.sinTcUsd),
    };
  });
}

// ---------------------------------------------------------------------------
// Pregunta 4 — qué está cubierto por la dinámica 1 (y qué queda abierto)
// ---------------------------------------------------------------------------

export type CoverageRow = BucketRow & {
  /** Lo que se debe en dólares en esta cubeta (facturas de proveedor + órdenes). */
  debeUsd: number;
  /** Dólares de caja apartados para esta cubeta, por orden de vencimiento. */
  cubiertoCaja: number;
  /** Lo que se debe y NO alcanzan a cubrir los dólares en caja. */
  abiertoCompra: number;
};

/**
 * DINÁMICA 1 — «comprar dólares para pagarle al proveedor» (Decisión 84).
 *
 * Los dólares en caja son un pozo común (comprados + cobrados), a promedio
 * móvil y SIN lotes: la compra de dólares nace sin liga a ninguna orden, así
 * que no existe forma honesta de decir «estos dólares son los que compré para
 * aquella orden». Por eso la cobertura se deriva a nivel EMPRESA y por cubeta:
 * los dólares disponibles se apartan contra lo que se debe, de lo que vence
 * antes a lo que vence después. Lo que sobra sin cubrir es exposición abierta
 * del lado compra.
 *
 * «Sin fecha» se aparta al final: no se sabe cuándo se necesita ese dinero.
 */
export function coverageByBucket(rows: BucketRow[], cashUsd: number): CoverageRow[] {
  let disponible = Math.max(0, cashUsd);
  const orden: FxBucket[] = ["vencido", "hoy", "1-30", "31-60", "61-90", "91-150", "+150", "sin-fecha"];
  const porBucket = new Map(rows.map((r) => [r.bucket, r]));
  const salida: CoverageRow[] = [];
  for (const b of orden) {
    const r = porBucket.get(b);
    if (!r) continue;
    const debeUsd = r2(r.cxp + r.compraComprometida);
    const cubierto = r2(Math.min(disponible, debeUsd));
    disponible = r2(disponible - cubierto);
    salida.push({ ...r, debeUsd, cubiertoCaja: cubierto, abiertoCompra: r2(debeUsd - cubierto) });
  }
  // Devuelve en el orden canónico de FX_BUCKETS, no en el de reparto.
  return FX_BUCKETS.map((b) => salida.find((r) => r.bucket === b)!).filter(Boolean);
}

/**
 * DINÁMICA 2 — «TC pactado en las dos puntas» (Decisión 84), por deal.
 *
 * Se compara la moneda y el TC de la compra contra los de la venta:
 *   - compra en pesos al TC del proveedor + venta en dólares con pactado
 *     → CUBIERTO: las dos patas quedan fijas en pesos y el margen no depende
 *       del mercado mientras el cliente honre el pactado (y si no, el ATC lo
 *       captura — ya construido).
 *   - las dos puntas en dólares → lo que se aparea es cobertura natural; lo
 *     que sobra de un lado queda abierto por ese lado.
 *   - venta en pesos con costo en dólares → ABIERTO lado compra (el caso de
 *     la pregunta 8.2-4, que sigue abierta como decisión de negocio).
 *   - venta en dólares SIN TC pactado → ABIERTO lado venta.
 */
export type DealFx = {
  soName: string;
  partner: string;
  saleCurrency: string;
  saleFx: number | null;
  buyCurrency: string;
  buyFx: number | null;
  /** USD abierto del lado venta (FV vivas + lo comprometido del pedido). */
  saleUsd: number;
  /** USD abierto del lado compra (FP vivas + lo comprometido de sus órdenes). */
  buyUsd: number;
  /**
   * ¿Hay alguna orden de compra ligada a este pedido? Una OC de inventario no
   * lleva `so_id`, así que un pedido puede no tener compra ligada: entonces NO
   * se puede decir «cubierto por la dinámica 2», porque no hay una compra en
   * pesos que fije el costo — simplemente no se sabe con qué se surtió.
   */
  hasBuy: boolean;
};

export type DealEstado = "sin-exposicion" | "dinamica-2" | "natural" | "venta-pactada" | "abierto-compra" | "abierto-venta" | "abierto-ambos";

export type DealClass = {
  estado: DealEstado;
  motivo: string;
  /** USD que quedan expuestos en este deal (0 si está cubierto). */
  usdAbierto: number;
  /** USD apareados entre las dos puntas (cobertura natural). */
  usdApareado: number;
};

export function classifyDeal(d: DealFx): DealClass {
  const ventaUsd = d.saleCurrency === "USD" ? Math.max(0, d.saleUsd) : 0;
  const compraUsd = d.buyCurrency === "USD" ? Math.max(0, d.buyUsd) : 0;
  const ventaPactada = d.saleCurrency === "USD" && d.saleFx != null;
  const compraPesos = d.buyCurrency !== "USD";

  if (ventaUsd < 0.005 && compraUsd < 0.005) {
    return { estado: "sin-exposicion", motivo: "Ninguna punta en dólares.", usdAbierto: 0, usdApareado: 0 };
  }

  // Venta en dólares sin TC pactado: no se sabe a cuánto se va a cobrar.
  if (ventaUsd >= 0.005 && !ventaPactada) {
    const abierto = r2(ventaUsd + compraUsd);
    return {
      estado: compraUsd >= 0.005 ? "abierto-ambos" : "abierto-venta",
      motivo: "La venta está en dólares y no tiene tipo de cambio pactado.",
      usdAbierto: abierto,
      usdApareado: 0,
    };
  }

  // Dinámica 2: se le paga al proveedor en pesos y se le factura al cliente en
  // dólares al pactado. Las dos patas quedan fijas; no hay dólares expuestos.
  // Exige que EXISTA una compra ligada: sin ella no hay «dos patas» que fijar.
  if (compraPesos && ventaPactada && d.hasBuy) {
    return {
      estado: "dinamica-2",
      motivo: "Compra en pesos al tipo de cambio del proveedor y venta en dólares al pactado: las dos patas quedan fijas.",
      usdAbierto: 0,
      usdApareado: 0,
    };
  }

  // Venta en dólares al pactado, sin ninguna compra ligada a este pedido (se
  // surtió de inventario, por ejemplo). El precio al cliente está fijo, pero
  // este pedido no dice con qué se compró: la exposición de esa compra, si la
  // hubo, vive a nivel empresa.
  if (ventaPactada && !d.hasBuy) {
    return {
      estado: "venta-pactada",
      motivo: "Venta en dólares con tipo de cambio pactado. No hay una compra ligada a este pedido: si se surtió de inventario comprado en dólares, esa exposición se ve arriba, por cubeta.",
      usdAbierto: 0,
      usdApareado: 0,
    };
  }

  // Venta en pesos con costo en dólares: todo el costo queda expuesto.
  if (d.saleCurrency !== "USD" && compraUsd >= 0.005) {
    return {
      estado: "abierto-compra",
      motivo: "Se compra en dólares y se vende en pesos: el costo se mueve con el dólar y el precio no.",
      usdAbierto: r2(compraUsd),
      usdApareado: 0,
    };
  }

  // Las dos puntas en dólares: lo que se aparea es cobertura natural.
  const apareado = r2(Math.min(ventaUsd, compraUsd));
  const sobraVenta = r2(ventaUsd - apareado);
  const sobraCompra = r2(compraUsd - apareado);
  if (sobraVenta < 0.005 && sobraCompra < 0.005) {
    return { estado: "natural", motivo: "Las dos puntas en dólares y por el mismo monto: se aparean.", usdAbierto: 0, usdApareado: apareado };
  }
  return {
    estado: sobraCompra >= 0.005 ? "abierto-compra" : "abierto-venta",
    motivo:
      sobraCompra >= 0.005
        ? "Las dos puntas en dólares, pero se debe más de lo que se va a cobrar."
        : "Las dos puntas en dólares, pero se va a cobrar más de lo que se debe.",
    usdAbierto: r2(Math.max(sobraVenta, sobraCompra)),
    usdApareado: apareado,
  };
}

// ---------------------------------------------------------------------------
// Preguntas 2 y 3 — el TC de cada documento, la sensibilidad y la revaluación
// ---------------------------------------------------------------------------

export type Position = {
  /** Dólares que nos deben (facturas + venta comprometida). */
  activosUsd: number;
  /** Dólares que debemos (facturas + compra comprometida). */
  pasivosUsd: number;
  /** Dólares en caja. */
  cajaUsd: number;
  /** (activos + caja) − pasivos. Positivo = ganamos si el dólar sube. */
  netoUsd: number;
  /** Dólares que no se pueden valuar porque su documento no tiene TC pactado.
   *  NO están dentro de `activosUsd`/`pasivosUsd`/`netoUsd` (Decisión 85). */
  sinTcUsd: number;
};

export function netPosition(rows: BucketRow[], cash: FxCash): Position {
  const activos = rows.reduce((s, r) => s + r.cxc + r.ventaComprometida, 0);
  const pasivos = rows.reduce((s, r) => s + r.cxp + r.compraComprometida, 0);
  const sinTc = rows.reduce((s, r) => s + r.sinTcUsd, 0);
  const caja = Math.max(0, cash.usd);
  return {
    activosUsd: r2(activos),
    pasivosUsd: r2(pasivos),
    cajaUsd: r2(caja),
    netoUsd: r2(activos + caja - pasivos),
    sinTcUsd: r2(sinTc),
  };
}

/**
 * PREGUNTA 3, primera mitad — «cuánto se gana o se pierde si el dólar se mueve
 * X pesos». Es aritmética de una línea y el signo es lo único que importa:
 * una cuenta por COBRAR en dólares gana cuando el dólar sube; una por PAGAR
 * pierde. Como el neto ya es activos − pasivos, el resultado es neto × X.
 *
 * `X` lo escribe la persona: es un supuesto suyo, no un número de negocio del
 * sistema (no se lee de Ajustes ni decide nada guardado).
 */
export function sensitivity(netoUsd: number, deltaMxn: number) {
  return r2(netoUsd * deltaMxn);
}

/**
 * PREGUNTA 3, segunda mitad — la REVALUACIÓN de lo vivo al TC de hoy: cuántos
 * pesos vale hoy lo que se contabilizó al TC pactado de cada documento. Es un
 * hecho, no un supuesto, y no está realizado todavía.
 *
 * Un documento sin TC pactado NO se valúa (Decisión 85): se cuenta aparte.
 * Los dólares en caja se revalúan contra su costo a promedio móvil, y solo la
 * parte con costo conocido (`tracked`).
 */
export function revaluation(docs: FxDoc[], cash: FxCash, fxToday: number | null) {
  if (fxToday == null) {
    return { docsMxn: null, cajaMxn: null, totalMxn: null, sinTcUsd: r2(docs.filter((d) => d.fxAgreed == null).reduce((s, d) => s + d.usd, 0)) };
  }
  const hoy = Number(fxToday);
  let docsMxn = 0;
  let sinTc = 0;
  for (const d of docs) {
    if (d.fxAgreed == null) {
      sinTc += d.usd;
      continue;
    }
    const signo = d.side === "cobrar" ? 1 : -1;
    docsMxn += signo * d.usd * (hoy - d.fxAgreed);
  }
  const cajaMxn = cash.avgFx != null ? cash.tracked * (hoy - cash.avgFx) : 0;
  return { docsMxn: r2(docsMxn), cajaMxn: r2(cajaMxn), totalMxn: r2(docsMxn + cajaMxn), sinTcUsd: r2(sinTc) };
}

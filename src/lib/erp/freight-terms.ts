/**
 * EL FLETE AL CLIENTE SE DECLARA, O EL DOCUMENTO NO NACE (Decisión 102).
 *
 * La regla del dueño, 20-sep-2026: «el flete no se estima, debes tener
 * conocimiento del costo para poder cotizar porque si no puede variar
 * negativamente y afectar el margen».
 *
 * Hasta hoy el campo nacía en CERO y nadie tenía que decir de dónde salía ese
 * cero. El precio se armaba sin flete, el margen se veía completo, y el camión
 * llegaba igual de caro. Es el mismo patrón que ya se corrigió dos veces:
 * **vacío no es cero** —el plazo del proveedor (Decisión 67) y la política de
 * cobro (Decisión 69)—, y las dos veces la corrección fue la misma: el
 * documento no nace sin el dato, y un cero se teclea a propósito.
 *
 * Las dos salidas existen porque hay casos donde de verdad no se cobra flete,
 * y un candado sin salida es peor que el bug que tapa: **el cliente lo recoge**
 * en bodega, o **viene puesto por el proveedor** (brokeraje con precio a
 * destino). Las dos son cero, pero dichas, y quedan guardadas — no se
 * confunden con «se nos olvidó».
 *
 * De qué flete habla esto: del de LLEVÁRSELA AL CLIENTE (Decisión 100(b)). El
 * de traerla vive dentro del costo de la mercancía desde la pieza 2.
 *
 * Sin imports a propósito: la prueba lo carga directo.
 */

export const FREIGHT_MODES = ["cobrado", "recoge", "proveedor"] as const;
export type FreightMode = (typeof FREIGHT_MODES)[number];

/** Lo que se le enseña a la persona, en su idioma. */
export const FREIGHT_MODE_LABEL: Record<FreightMode, string> = {
  cobrado: "Se le cobra al cliente",
  recoge: "El cliente lo recoge",
  proveedor: "Lo pone el proveedor",
};

/** Los dos modos que significan CERO a propósito. */
export function isDeclaredZero(mode: string | null | undefined): boolean {
  return mode === "recoge" || mode === "proveedor";
}

/**
 * CUÁNTO FLETE VALE ESA PARTIDA, de verdad. Los dos modos que significan cero
 * a propósito valen cero **sin borrar el importe capturado**: si alguien
 * cambia a «lo recoge» y después vuelve a «se le cobra», su número sigue ahí.
 * Antes el selector escribía 0 encima, y un flete de $3,000 se perdía con dos
 * clics.
 *
 * Y es la MISMA regla que usa `freightDeclared`: un importe > 0 vale, con
 * etiqueta o sin ella. Tenerlas distintas dejaba una partida aceptada por una
 * mitad del sistema e ignorada por la otra — $3,000 por unidad fuera del costo
 * puesto, que es justo lo que la regla 8 prohíbe.
 */
export function effectiveFreight(mode: string | null | undefined, freight: number | null | undefined) {
  if (isDeclaredZero(mode)) return 0;
  return Math.max(0, Number(freight ?? 0));
}

/** ¿Esta partida dice algo sobre su flete, o está en blanco? */
export function freightSpoken(mode: string | null | undefined, freight: number | null | undefined) {
  return Boolean(mode) || Number(freight ?? 0) > 0.0001;
}

export type FreightLine = {
  /** Para poder nombrar la partida en el mensaje. */
  label: string;
  freight: number | null | undefined;
  mode: string | null | undefined;
};

/**
 * Una partida está declarada si dice CÓMO se resolvió el flete. Con
 * `cobrado`, además tiene que traer un importe mayor a cero: «se le cobra» y
 * cero es una contradicción, y es exactamente el cero por omisión que esta
 * regla viene a matar.
 */
export function freightDeclared(l: FreightLine): boolean {
  if (isDeclaredZero(l.mode)) return true;
  // UN IMPORTE ES LA DECLARACIÓN. Si hay flete capturado, «se le cobra» no es
  // una suposición: es lo que ese número significa. Exigir además la etiqueta
  // dejaba cotizaciones imposibles de aceptar —duplicar una traía el importe
  // sin modo— y sin pantalla donde arreglarlas.
  if (Number(l.freight ?? 0) > 0.0001) return true;
  // Lo que NO se puede: decir que se cobra y dejar el importe en cero. Ése es
  // justo el cero por omisión que esta regla viene a matar.
  return false;
}

/**
 * La regla única del nacimiento. La llaman los CUATRO caminos por los que
 * puede nacer una venta — aceptar una cotización, guardar un pedido, la venta
 * directa y la conversión de una orden de compra del cliente —, igual que
 * `assertSaleTerms` con la política de cobro.
 *
 * `legacy` (verdadero) deja pasar lo que nació antes de esta pieza: una
 * partida sin modo Y sin importe es un documento viejo, no uno que se está
 * creando mal. Lo ya capturado no se toca (migraciones 0039 y 0040).
 */
export function assertFreightDeclared(lines: FreightLine[], opts?: { legacy?: boolean }) {
  const faltan: string[] = [];
  const enCero: string[] = [];
  for (const l of lines) {
    if (freightDeclared(l)) continue;
    // Documento viejo: ni modo ni importe. Se deja pasar a propósito.
    if (opts?.legacy && !l.mode && !(Number(l.freight ?? 0) > 0.0001)) continue;
    if (l.mode === "cobrado") enCero.push(l.label);
    else faltan.push(l.label);
  }
  if (enCero.length) {
    throw new Error(
      `Dice que el flete se le cobra al cliente pero el importe está en cero: ${enCero.join(", ")}. ` +
      `Captura cuánto, o cambia a «${FREIGHT_MODE_LABEL.recoge}» o «${FREIGHT_MODE_LABEL.proveedor}».`,
    );
  }
  if (faltan.length) {
    throw new Error(
      `Falta decir qué pasa con el flete de ${faltan.length === 1 ? "esta partida" : "estas partidas"}: ${faltan.join(", ")}. ` +
      `Las opciones son «${FREIGHT_MODE_LABEL.cobrado}» con su importe, «${FREIGHT_MODE_LABEL.recoge}» o «${FREIGHT_MODE_LABEL.proveedor}». ` +
      `Un cero sin decir por qué no se distingue de un flete que se olvidó, y el precio saldría sin él.`,
    );
  }
}

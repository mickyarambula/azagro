/**
 * LA EXPOSICIÓN AL DÓLAR DE UNA COTIZACIÓN EN PESOS (Decisión 90).
 *
 * El caso: el proveedor cotiza en dólares y Azagro le cotiza al cliente en
 * pesos. El precio al cliente queda congelado el día uno; la deuda con el
 * proveedor sigue siendo en dólares hasta que se le pague, treinta o cien días
 * después. Lo que se mueva el dólar en ese tramo sale entero del margen.
 *
 * **Quién lo absorbe ya está decidido: Azagro, nunca el cliente** — la
 * exposición no nace de la venta, nace de haber decidido deberle dólares al
 * proveedor a crédito, y en esa decisión el cliente no participa. Lo que hace
 * este módulo es que la persona que cotiza lo vea ANTES de comprometer el
 * precio, con números que ya existen.
 *
 * **Aquí no se pronostica nada.** No hay un «dólar esperado» ni un colchón
 * sugerido: el costo financiero se puede meter solo en el precio porque hay
 * una tasa y hay días, pero dónde va a estar el dólar en un mes no lo sabe
 * nadie. Meterlo a la fórmula construiría el precio y el margen reportado
 * sobre una adivinanza, y encarecería también las cotizaciones que sí se iban
 * a cubrir. Lo único que se dice es la aritmética: cuántos dólares se deben y
 * cuánto se mueve la utilidad por cada peso. El colchón, si se quiere, lo pone
 * la persona a mano subiendo el margen o el tipo de cambio.
 *
 * Sin imports a propósito: la prueba lo carga directo.
 */

export type ExposureLine = {
  qty: number;
  /** Costo de la mercancía por unidad, YA en pesos (así vive en el documento). */
  costMxn: number;
  /** Moneda en que el proveedor lo cotizó. */
  costCurrency: string | null;
  /** Tipo de cambio con el que se convirtió a pesos. */
  costFx: number | null;
};

export type FxExposure = {
  /**
   * Hay algo que avisar: el costo viene en dólares y la venta se cotiza en
   * pesos. Con la venta en dólares el riesgo es del cliente (Decisión 2) y
   * aquí no hay nada que decir.
   */
  aplica: boolean;
  /** Dólares de costo que quedan expuestos. */
  usd: number;
  /**
   * Pesos de utilidad que se mueven por cada peso que se mueva el dólar. Es el
   * mismo número que `usd`: cada dólar que se debe cuesta un peso más por cada
   * peso que suba. Se nombra aparte porque en pantalla son dos cosas distintas.
   */
  porPeso: number;
  /** El TC con el que se convirtió, si todas las partidas comparten uno. */
  tc: number | null;
  /** Cuántas partidas traen costo en dólares. */
  n: number;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Un TC sirve para dividir solo si es un tipo de cambio de verdad. */
function usable(fx: number | null | undefined) {
  return fx != null && Number(fx) > 1;
}

export function quoteFxExposure(lines: ExposureLine[], saleCurrency: string): FxExposure {
  const vacia: FxExposure = { aplica: false, usd: 0, porPeso: 0, tc: null, n: 0 };
  // Venta en dólares: el riesgo viaja con el precio y es del cliente (D2).
  if (saleCurrency !== "MXN") return vacia;
  const enUsd = lines.filter((l) => l.costCurrency === "USD" && usable(l.costFx) && l.qty > 0 && l.costMxn > 0);
  if (!enUsd.length) return vacia;
  // El costo vive en pesos y guarda con qué TC llegó ahí: los dólares se
  // recuperan dividiendo. Nunca se vuelve a convertir con el TC de hoy — lo
  // que se debe son los dólares que se pactaron.
  const usd = enUsd.reduce((s, l) => s + (l.costMxn / Number(l.costFx)) * l.qty, 0);
  const tcs = [...new Set(enUsd.map((l) => Number(l.costFx)))];
  return {
    aplica: usd > 0.009,
    usd: r2(usd),
    porPeso: r2(usd),
    tc: tcs.length === 1 ? tcs[0]! : null,
    n: enUsd.length,
  };
}

/**
 * La utilidad esperada después de que el dólar se mueva `deltaMxn` pesos.
 * `delta` positivo = el dólar sube = la deuda cuesta más = la utilidad baja.
 * No se guarda ni sale de la pantalla: es una cuenta que la persona hace para
 * decidir, no un número del documento.
 */
export function utilityAfterFxMove(utilidadMxn: number, usd: number, deltaMxn: number) {
  return r2(utilidadMxn - usd * deltaMxn);
}

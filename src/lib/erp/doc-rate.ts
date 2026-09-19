/**
 * LA TASA DE UN DOCUMENTO — qué renglón le toca a cada documento, según el
 * circuito que lo financió (Decisiones 1 y 5, construido el 19-sep-2026).
 *
 * El problema que cierra: la tabla de dos columnas (tasa de costo / tasa de
 * cobro, `funding_rates`, migración 0024) se construyó y el motor de PRECIOS
 * del circuito lineal ya la lee (`priceRateFor`). La MORA no: seguía leyendo
 * `tiie_rates` para todos los circuitos. Y las dos tablas se capturan por
 * separado en Ajustes, sin nada que las amarre, así que el precio y la mora
 * del MISMO documento podían correr con dos tasas distintas sin que nadie se
 * enterara.
 *
 * La regla, en una frase: **un documento se mide siempre con la tabla de la
 * que salió su precio.**
 *
 *   · Doble facturación (ASR) → `tiie_rates`. Ahí solo hay una tasa, y es la
 *     que entró al precio; para ese documento esa TIEE ES la tasa de cobro y
 *     también la de costo. No es un atajo: es que ese circuito nunca tuvo dos.
 *   · Lineal (Línea Santa Rosa) → `funding_rates`, dos columnas de verdad:
 *     lo que se le COBRA al cliente (mora, interés) usa la tasa de **cobro**;
 *     lo que mide COSTO (pronto pago, costo financiero) usa la de **costo**.
 *     Decisión 5: «lo que mide costo usa la tasa de costo; lo que se le cobra
 *     al cliente usa la tasa de cobro; la mora es algo que se le cobra al
 *     cliente, así que usa la tasa de cobro, sin excepción».
 *
 * **Aquí no se elige renglón por fecha.** El llamador ya caminó su tabla
 * (`nearestRate` para la TIIE, `nearestFunding` para las tasas) y entrega los
 * dos candidatos; esta función solo dice cuál de los dos le toca al documento.
 * Se parte así a propósito: el paseo por fecha vive en un solo lugar
 * (`credit.ts`, donde una prueba fija su firma), y la regla de circuito vive
 * aquí, pura y con números en sus pruebas.
 *
 * **Y no hay respaldo.** Si la tabla que le toca al documento no cubre la
 * fecha, la respuesta es null y el llamador se detiene o marca la fila —
 * nunca se cae a la otra tabla, que es justo el número equivocado
 * (`CLAUDE.md` regla 9).
 *
 * Sin imports a propósito: la prueba lo carga directo.
 */

/** Lo que se le va a preguntar a la tasa. */
export type RateUse = "cobro" | "costo";

export type DocRatePick = {
  rate: number;
  /** Fecha del renglón que se usó, para poder explicarlo. */
  date: string;
  /** De qué tabla salió: se enseña y se guarda en la foto de la factura. */
  source: "tiie" | "tasas";
};

export type TiieCandidate = { rate: number; date: string } | null;
export type FundingCandidate = { costRate: number; collectionRate: number; date: string } | null;

/** El circuito lineal es el único con base «costo + margen» (`pricing.ts`). */
export function usesFundingTable(base: string | null | undefined) {
  return base === "costo_margen";
}

export function docRate(input: {
  /** `financingBase` del circuito del documento. */
  base: string | null | undefined;
  which: RateUse;
  tiie: TiieCandidate;
  funding: FundingCandidate;
}): DocRatePick | null {
  if (usesFundingTable(input.base)) {
    const f = input.funding;
    if (!f) return null;
    return { rate: input.which === "costo" ? f.costRate : f.collectionRate, date: f.date, source: "tasas" };
  }
  const t = input.tiie;
  if (!t) return null;
  return { rate: t.rate, date: t.date, source: "tiie" };
}

/**
 * De qué tabla hay que capturar el renglón que falta. El mensaje tiene que
 * mandar a la pantalla correcta: decirle «captura la TIIE» a quien opera en
 * lineal lo manda a llenar una tabla que su documento no lee.
 */
export function rateTableName(base: string | null | undefined) {
  return usesFundingTable(base) ? "Tabla de tasas (costo / cobro)" : "Tabla TIIE";
}

/**
 * Tapa los IMPORTES de un detalle de bitácora, no el renglón entero.
 *
 * Tapar el detalle completo escondía cosas que administración sí necesita y
 * que no son dinero: el motivo obligatorio de una cancelación, y la liga
 * «Recepción RCP/0001 · nace FP-0001 por pagar», que es su trabajo.
 *
 * Se tapa **todo número** que no venga pegado a un folio. Eso tapa de más —se
 * van también cantidades y tipos de cambio—, y es a propósito: de los dos
 * modos de equivocarse, publicar un costo que la regla 10 esconde es el que no
 * se puede deshacer. Los detalles los escriben veinte lugares con formatos
 * distintos; un costo de $85 sin decimales se colaba por una regla más fina.
 *
 * En su propio módulo y sin imports, para que la prueba la CORRA con textos
 * reales: verificar una máscara leyendo su código es justo cómo se cuelan los
 * casos (la primera versión tapaba «500 → 520» y dejaba pasar «85 → 72»).
 */
export function maskAmounts(detail: string) {
  return detail.replace(/(?<![/\-\w])-?\d[\d,]*(\.\d+)?(?![\w/-])/g, "—");
}

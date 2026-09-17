import type { Sql } from "@/lib/db";

/**
 * Folio de documento por serie (grupo C de la auditoría, 17-sep-2026).
 *
 * FV, FP, NC, FI, ATC y PAG se numeraban con `count(*) + 1` sobre su tabla,
 * cada sitio con un filtro distinto (la FI contaba TODAS las facturas; la FV
 * las de cliente, NC/FI/ATC incluidas), y dos peticiones simultáneas podían
 * leer el mismo conteo — el índice único de la 0015 era el único respaldo.
 *
 * Ahora es la misma sentencia que `nextRef` (kardex, 0033): un `insert … on
 * conflict … do update … returning` sobre `folio_counters`, una fila por
 * (empresa, serie). Dos peticiones de la misma serie toman el candado de fila
 * una a la vez y nunca se llevan el mismo número. El +1 vive dentro de la
 * transacción del documento: si esa transacción se revierte, el +1 se
 * revierte con ella y el siguiente documento reutiliza el número —
 * autocorregible, como el count(*) de antes, sin perder folios.
 *
 * Formato `SERIE-NNNN`, el de siempre. La 0041 siembra cada serie desde el
 * máximo real de los nombres que ya existen: nada se renumera.
 */
export type DocSeries = "FV" | "FP" | "NC" | "FI" | "ATC" | "PAG";

export async function nextDocFolio(sql: Sql, companyId: number, series: DocSeries) {
  const rows = await sql<{ last_number: number }>`
    insert into folio_counters (company_id, series, last_number)
    values (${companyId}, ${series}, 1)
    on conflict (company_id, series) do update set last_number = folio_counters.last_number + 1
    returning last_number
  `;
  return `${series}-${String(rows[0]!.last_number).padStart(4, "0")}`;
}

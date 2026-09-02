import type { getSql } from "@/lib/db";

type Sql = Awaited<ReturnType<typeof getSql>>;

/**
 * Candado de la solicitud: en cuanto genera cotización, se congela.
 *
 * Costo, proveedor ganador, flete, márgenes y plazo ya viven en la cotización
 * (y de ahí pasan al pedido). Si se siguieran cambiando en la solicitud
 * quedarían dos verdades distintas. El mensaje nombra el folio para que quien
 * lo vea sepa a dónde ir: los cambios se hacen desde la cotización, con una
 * revisión antes de que el cliente acepte.
 */
export function requestLockedMessage(quoteName: string | null) {
  return `Esta solicitud ya generó ${quoteName ?? "una cotización"}. Los cambios se hacen desde la cotización (revisión antes de aceptar).`;
}

export async function assertRequestOpen(sql: Sql, companyId: number, requestId: number) {
  const r = await sql<{ quote_id: number | null; quote_name: string | null }>`
    select r.quote_id, (select name from quotes where id = r.quote_id) as quote_name
    from customer_requests r
    where r.id = ${requestId} and r.company_id = ${companyId}
  `;
  if (!r[0]) throw new Error("Solicitud no encontrada");
  if (r[0].quote_id) throw new Error(requestLockedMessage(r[0].quote_name));
}

/** Mismo candado visto desde la lista a proveedores (SC): si su solicitud ya cotizó, las ofertas no se mueven. */
export async function assertRfqOpen(sql: Sql, rfqId: number) {
  const r = await sql<{ quote_name: string | null }>`
    select (select name from quotes where id = r.quote_id) as quote_name
    from customer_requests r
    where r.rfq_id = ${rfqId} and r.quote_id is not null
    limit 1
  `;
  if (r[0]) throw new Error(requestLockedMessage(r[0].quote_name));
}

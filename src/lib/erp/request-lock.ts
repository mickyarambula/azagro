import type { getSql } from "@/lib/db";
import { todayMx } from "@/lib/utils";

type Sql = Awaited<ReturnType<typeof getSql>>;

/**
 * Candado de la solicitud: en cuanto genera cotización, se congela.
 *
 * Costo, proveedor ganador, flete, márgenes y plazo ya viven en la cotización
 * (y de ahí pasan al pedido). Si se siguieran cambiando en la solicitud
 * quedarían dos verdades distintas. El mensaje nombra el folio para que quien
 * lo vea sepa a dónde ir: los cambios se hacen desde la cotización, con una
 * revisión antes de que el cliente acepte.
 *
 * La cotización vinculada puede morir sin que nadie la cierre: rechazada, o
 * vencida sin que nadie la haya decidido. En esos dos casos el candado se
 * libera solo — la solicitud vuelve a estar abierta para cotizar de nuevo
 * (Sesión de recotizar, hallazgo 4, SESIÓN D, 7-sep-2026). Una cotización
 * ACEPTADA (o parcial: ya generó pedido para parte de la partida) nunca
 * libera nada, pase lo que pase con su vigencia — ya es un pedido, y un
 * pedido no se recotiza.
 */
export function requestLockedMessage(quoteName: string | null) {
  return `Esta solicitud ya generó ${quoteName ?? "una cotización"}. Los cambios se hacen desde la cotización (revisión antes de aceptar).`;
}

/**
 * true si la cotización sigue viva (bloquea): "draft"/"sent" y vigente, o ya
 * se convirtió en pedido ("accepted"/"partial", sin importar la vigencia).
 * false si es un callejón sin salida: "rejected", o "draft"/"sent" ya vencida
 * sin que nadie la haya decidido — ahí el candado se libera.
 */
export function quoteStillBlocks(state: string, validUntil: string, today: string): boolean {
  if (state === "accepted" || state === "partial") return true;
  if (state === "rejected") return false;
  // draft / sent
  return validUntil >= today;
}

export async function assertRequestOpen(sql: Sql, companyId: number, requestId: number) {
  const r = await sql<{ quote_id: number | null; quote_name: string | null; quote_state: string | null; quote_valid_until: string | null }>`
    select r.quote_id, q.name as quote_name, q.state as quote_state, q.valid_until::text as quote_valid_until
    from customer_requests r
    left join quotes q on q.id = r.quote_id
    where r.id = ${requestId} and r.company_id = ${companyId}
  `;
  if (!r[0]) throw new Error("Solicitud no encontrada");
  if (r[0].quote_id && r[0].quote_state != null && quoteStillBlocks(r[0].quote_state, r[0].quote_valid_until ?? "", todayMx())) {
    throw new Error(requestLockedMessage(r[0].quote_name));
  }
}

/** Mismo candado visto desde la lista a proveedores (SC): si su solicitud ya cotizó de verdad, las ofertas no se mueven. */
export async function assertRfqOpen(sql: Sql, rfqId: number) {
  const r = await sql<{ quote_name: string | null; quote_state: string | null; quote_valid_until: string | null }>`
    select q.name as quote_name, q.state as quote_state, q.valid_until::text as quote_valid_until
    from customer_requests r
    join quotes q on q.id = r.quote_id
    where r.rfq_id = ${rfqId} and r.quote_id is not null
    limit 1
  `;
  if (r[0] && quoteStillBlocks(r[0].quote_state ?? "", r[0].quote_valid_until ?? "", todayMx())) {
    throw new Error(requestLockedMessage(r[0].quote_name));
  }
}

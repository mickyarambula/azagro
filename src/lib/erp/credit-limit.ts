import type { Sql } from "@/lib/db";

/**
 * BLOQUE DE PARCIALES, paso 6 (Decisión 51): el límite de crédito se APARTA
 * al confirmar el pedido y se convierte en deuda real conforme se factura
 * cada entrega. Lo que ocupa la línea de un cliente son dos cosas:
 *
 *   - lo facturado y todavía no cobrado (saldo de sus facturas abiertas), y
 *   - lo apartado: pedidos confirmados a crédito que todavía no se han
 *     facturado del todo — de cada uno, su total menos lo que ya salió en
 *     facturas vivas (con el paso 3 un pedido factura por entrega, así que
 *     un pedido a medias tiene parte facturada y parte apartada).
 *
 * Se calcula en vivo, sin columna "reservado": las facturas y los pedidos
 * son la verdad, y un número guardado aparte se desincroniza (misma razón
 * por la que la existencia no es una columna, regla 2). Un solo lugar para
 * la regla: `saveOrder` y `createSale` leen de aquí.
 */
export type CreditExposure = { limit: number; invoiced: number; reserved: number; used: number };

/** La aritmética, pura: ¿cabe este pedido? */
export function creditRoom(x: { limit: number; invoiced: number; reserved: number; order: number }) {
  const used = Math.round((x.invoiced + x.reserved) * 100) / 100;
  const after = Math.round((used + x.order) * 100) / 100;
  // Sin límite capturado (0) no se limita: igual que siempre.
  const exceeds = x.limit > 0 && after > x.limit;
  return { used, after, exceeds, room: x.limit > 0 ? Math.round((x.limit - used) * 100) / 100 : null };
}

/** Lo que ya ocupa la línea de un cliente. `excludeSoId`: el pedido que se está confirmando, si ya existía como borrador. */
export async function creditExposure(sql: Sql, companyId: number, partnerId: number, opts: { excludeSoId?: number | null } = {}): Promise<CreditExposure> {
  const partner = await sql<{ credit_limit: string }>`
    select credit_limit::text from partners where id = ${partnerId} and company_id = ${companyId}
  `;
  const exclude = opts.excludeSoId ?? 0;
  // Facturado: el saldo de sus facturas abiertas (la consulta de siempre). Si
  // se está re-guardando un pedido ya confirmado, sus facturas se quedan
  // fuera: su total entra completo como "pedido" y contaría dos veces.
  const ar = await sql<{ ar: string }>`
    select coalesce(sum(residual),0)::text as ar from invoices
    where company_id = ${companyId} and partner_id = ${partnerId} and kind = 'customer' and state = 'open'
      and (${exclude} = 0 or order_id is distinct from ${exclude})
  `;
  // Apartado: pedidos a crédito confirmados O entregados (Decisión 47: en
  // bodega propia entregar no factura, y el pedido pasa a `done` al terminar
  // de entregar — sigue apartando hasta que se facture), menos lo ya
  // facturado de cada uno (facturas vivas del pedido) y menos lo CERRADO
  // CORTO (paso 7, decisión del dueño 16-sep-2026: lo que ya nunca va a
  // salir ni facturarse deja de ocupar línea — un pedido cerrado no sigue
  // restando crédito para siempre). Nunca negativo por pedido: uno ya
  // facturado del todo aporta 0 solo.
  const res = await sql<{ reserved: string }>`
    select coalesce(sum(greatest(0, so.total - coalesce((
      select sum(i.amount) from invoices i
      where i.company_id = so.company_id and i.order_id = so.id and i.kind = 'customer' and i.name like 'FV-%'
        and i.reverses_id is null and i.state <> 'reversed'
    ), 0) - coalesce((
      select sum(coalesce(sl.qty_closed_short, 0) * sl.unit_price) from sales_lines sl where sl.so_id = so.id
    ), 0))), 0)::text as reserved
    from sales_orders so
    where so.company_id = ${companyId} and so.partner_id = ${partnerId} and so.state in ('confirmed', 'done')
      and coalesce(so.term_kind,'credit_days') <> 'contado'
      and so.id <> ${exclude}
  `;
  const limit = Number(partner[0]?.credit_limit ?? 0);
  const invoiced = Number(ar[0]?.ar ?? 0);
  const reserved = Number(res[0]?.reserved ?? 0);
  return { limit, invoiced, reserved, used: Math.round((invoiced + reserved) * 100) / 100 };
}

/** El texto de bitácora y de pantalla, uno solo para los dos caminos. */
export function creditDetail(x: CreditExposure, order: number) {
  return `Límite ${x.limit.toFixed(0)} · saldo ${x.invoiced.toFixed(0)} · apartado en pedidos ${x.reserved.toFixed(0)} · pedido ${order.toFixed(0)}`;
}
export function creditExceededMessage(x: CreditExposure) {
  return `Supera el límite de crédito (${x.limit.toFixed(0)}). Saldo facturado ${x.invoiced.toFixed(0)} + apartado en pedidos confirmados sin facturar ${x.reserved.toFixed(0)} = ${x.used.toFixed(0)}. Un administrador puede autorizar el exceso.`;
}

/**
 * Para el inicio (bandeja de atención): cuántos clientes están hoy por
 * ENCIMA de su línea de crédito, y por cuánto en total. Misma cuenta que
 * `creditExposure` (facturado + apartado, cerrado corto ya no aparta —
 * Decisión 62), pero en un solo viaje a la base para todos los clientes con
 * límite capturado, en vez de uno por cliente.
 */
export async function creditExceededSummary(sql: Sql, companyId: number): Promise<{ n: number; amount: number }> {
  const rows = await sql<{ n: number; amount: string }>`
    select count(*)::int as n, coalesce(sum(used - credit_limit), 0)::text as amount
    from (
      select p.credit_limit,
        coalesce(ar.ar, 0) + coalesce(res.reserved, 0) as used
      from partners p
      left join lateral (
        select sum(residual) as ar from invoices
        where company_id = p.company_id and partner_id = p.id and kind = 'customer' and state = 'open'
      ) ar on true
      left join lateral (
        select sum(greatest(0, so.total - coalesce((
          select sum(i.amount) from invoices i
          where i.company_id = so.company_id and i.order_id = so.id and i.kind = 'customer' and i.name like 'FV-%'
            and i.reverses_id is null and i.state <> 'reversed'
        ), 0) - coalesce((
          select sum(coalesce(sl.qty_closed_short, 0) * sl.unit_price) from sales_lines sl where sl.so_id = so.id
        ), 0))) as reserved
        from sales_orders so
        where so.company_id = p.company_id and so.partner_id = p.id and so.state in ('confirmed', 'done')
          and coalesce(so.term_kind,'credit_days') <> 'contado'
      ) res on true
      where p.company_id = ${companyId} and p.is_customer = true and p.credit_limit > 0
    ) x
    where used > credit_limit
  `;
  return { n: rows[0]?.n ?? 0, amount: Number(rows[0]?.amount ?? 0) };
}

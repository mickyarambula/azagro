/**
 * LO QUE COSTÓ TRAER UN VIAJE (Decisión 100, 21-sep-2026).
 *
 * El dueño lo dijo así: comprando para inventario se pagan **dos** fletes —uno
 * para traerla, otro para llevársela al cliente— y «en ocasiones también se
 * pagan cargadores, para descarga y carga». De ahí el concepto: lo que cuesta
 * **traerla** —flete de entrada MÁS maniobras— es costo de la mercancía; lo
 * que cuesta **llevársela** es costo del pedido y vive donde ya vive.
 *
 * Esta pieza SOLO CAPTURA Y ENSEÑA. No mueve un peso de ningún precio, costo
 * ni utilidad: meterlo al costo del inventario es la pieza siguiente, y va
 * junto con el apagador del doble conteo en el mismo cambio. Separarlos
 * dejaría al sistema cobrando de más mientras tanto, porque la cotización toma
 * el costo del inventario y le vuelve a sumar el flete (`ops.ts`).
 *
 * La llave es el folio del evento de recepción (`RCP/000N`), que ya se mina en
 * cada recepción desde el bloque de parciales: una orden puede llegar en tres
 * camiones y cada camión cuesta lo suyo. Amarre por texto, como la Decisión 42.
 *
 * Quién lo captura: quien **ve costos de compra** (compras, gerencia,
 * administrador — regla 10). El almacén recibe pero no ve costos, así que no
 * se le pide; el número se conoce antes del viaje (se negocia con el fletero)
 * y se puede capturar después de recibir, por quien le toca.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { activeMember, assertCan, canSeeCosts } from "@/lib/erp/acl";
import { writeAudit } from "@/lib/erp/audit";

type Sql = Awaited<ReturnType<typeof getSql>>;

async function companyOf(sql: Sql, userId: string) {
  const m = await activeMember(sql, userId);
  if (!m) throw new Error("Sin empresa");
  return m;
}

const SIN_COSTOS = "Lo que costó el viaje lo captura quien ve los costos de compra (compras, gerencia o administrador)";

/**
 * Los viajes de una orden de compra: un renglón por evento de recepción, con
 * lo que costó traerlo si ya se capturó. Un evento revertido se marca — su
 * mercancía regresó, pero el dinero del fletero ya salió (Decisión 38:
 * revertir no es devolver), así que el costo NO se borra solo.
 */
export const listTripCosts = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ poIds: z.array(z.number()).max(200) }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const m = await companyOf(sql, context.userId);
    await assertCan(sql, context.userId, "purchases", "view");
    // El costo de un viaje es costo de compra: quien no lo ve, no lo recibe.
    // Lista VACÍA, no un cero enmascarado — ése fue el defecto de ayer.
    if (!canSeeCosts(m.role)) return { puedeVer: false as const, trips: [] };
    if (!data.poIds.length) return { puedeVer: true as const, trips: [] };
    // Toda la lista de una vez: la pantalla enseña N órdenes y una llamada por
    // orden serían N viajes al servidor y N barridos de gastos por carga.
    const trips = await sql<{
      po_id: number;
      event_ref: string;
      date: string;
      reversed: boolean;
      freight: string | null;
      handling: string | null;
      partner: string | null;
      notes: string;
    }>`
      select e.po_id, e.event_ref, min(e.day)::text as date, bool_and(e.reversed) as reversed,
        t.freight::text as freight, t.handling::text as handling, p.name as partner,
        coalesce(t.notes, '') as notes
      from (
        select po.id as po_id, m.event_ref, m.date as day,
          exists (select 1 from stock_moves r where r.reverses_id = m.id) as reversed
        from stock_moves m
        join purchase_orders po on po.company_id = m.company_id and po.name = m.origin
        where m.company_id = ${m.company_id} and po.id = any(${data.poIds})
          and m.event_ref is not null and m.move_type = 'receipt'
      ) e
      left join trip_costs t on t.company_id = ${m.company_id} and t.event_ref = e.event_ref
      left join partners p on p.id = t.partner_id
      group by e.po_id, e.event_ref, t.freight, t.handling, p.name, t.notes
      order by min(e.day), e.event_ref
    `;
    // Lo PAGADO del mismo viaje, para poder compararlo con lo comprometido
    // (la forma de la Decisión 99). Todavía no manda sobre nada: esta pieza
    // no toca ningún costo. Acotado a los viajes de estas órdenes.
    const refs = [...new Set(trips.map((t) => t.event_ref))];
    const pagados = refs.length
      ? await sql<{ event_ref: string; amount: string; n: number }>`
          select event_ref, coalesce(sum(amount),0)::text as amount, count(*)::int as n
          from expenses
          where company_id = ${m.company_id} and event_ref = any(${refs})
          group by event_ref
        `
      : [];
    const pagado = new Map(pagados.map((r) => [r.event_ref, { amount: Number(r.amount), n: r.n }]));
    return {
      puedeVer: true as const,
      trips: trips.map((t) => ({
        poId: t.po_id,
        eventRef: t.event_ref,
        date: t.date,
        reversed: t.reversed,
        // null = sin capturar. Vacío NO es cero: un viaje sin flete capturado
        // no es un viaje gratis (Decisiones 64 y 67).
        freight: t.freight == null ? null : Number(t.freight),
        handling: t.handling == null ? null : Number(t.handling),
        partner: t.partner,
        notes: t.notes,
        paid: pagado.get(t.event_ref)?.amount ?? 0,
        paidN: pagado.get(t.event_ref)?.n ?? 0,
      })),
    };
  });

/**
 * Capturar (o corregir) lo que costó traer un viaje. `null` en un importe
 * significa «sin capturar» y se distingue de un cero capturado a propósito,
 * que es lo que se teclea cuando el proveedor lo trajo sin cobrar el flete.
 */
export const saveTripCost = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      poId: z.number(),
      eventRef: z.string().min(1),
      freight: z.number().nonnegative().nullable(),
      handling: z.number().nonnegative().nullable(),
      partnerId: z.number().optional(),
      notes: z.string().optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const m = await companyOf(sql, context.userId);
    await assertCan(sql, context.userId, "purchases", "edit");
    // Lo que se enmascara no se escribe (CLAUDE.md § 10): el permiso de VER un
    // costo y el de guardarlo son el mismo, o la máscara se vuelve un borrador.
    if (!canSeeCosts(m.role)) throw new Error(SIN_COSTOS);
    const po = await sql<{ id: number; name: string }>`
      select id, name from purchase_orders where id = ${data.poId} and company_id = ${m.company_id}
    `;
    if (!po[0]) throw new Error("Orden de compra no encontrada");
    // El viaje tiene que existir de verdad: un folio inventado dejaría un
    // costo colgando de nada.
    const existe = await sql<{ n: number }>`
      select count(*)::int as n from stock_moves
      where company_id = ${m.company_id} and origin = ${po[0].name}
        and event_ref = ${data.eventRef} and move_type = 'receipt'
    `;
    if (!existe[0]?.n) throw new Error(`La recepción ${data.eventRef} no pertenece a ${po[0].name}`);
    const antes = await sql<{ freight: string | null; handling: string | null }>`
      select freight::text as freight, handling::text as handling from trip_costs
      where company_id = ${m.company_id} and event_ref = ${data.eventRef}
    `;
    await sql`
      insert into trip_costs (company_id, event_ref, po_id, partner_id, freight, handling, notes, created_by)
      values (${m.company_id}, ${data.eventRef}, ${po[0].id}, ${data.partnerId ?? null},
        ${data.freight}, ${data.handling}, ${data.notes ?? null}, ${context.userId})
      on conflict (company_id, event_ref) do update set
        po_id = excluded.po_id,
        -- Lo que esta puerta NO manda se CONSERVA. La pantalla de hoy no
        -- captura fletero ni nota; si mañana otra sí, un guardado desde aquí
        -- los habría borrado sin que nadie lo pidiera.
        partner_id = coalesce(excluded.partner_id, trip_costs.partner_id),
        notes = coalesce(excluded.notes, trip_costs.notes),
        freight = excluded.freight, handling = excluded.handling
    `;
    const num = (v: string | null | undefined) => (v == null ? "sin capturar" : Number(v).toFixed(2));
    await writeAudit(sql, {
      companyId: m.company_id,
      userId: context.userId,
      action: antes[0] ? "costo-de-viaje-corregido" : "costo-de-viaje",
      entity: "purchase_order",
      entityId: po[0].id,
      name: `${po[0].name} · ${data.eventRef}`,
      detail: `flete ${num(antes[0]?.freight)} → ${num(data.freight == null ? null : String(data.freight))} · maniobras ${num(antes[0]?.handling)} → ${num(data.handling == null ? null : String(data.handling))}`,
    });
    return { ok: true as const };
  });

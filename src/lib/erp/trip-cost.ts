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
    if (!canSeeCosts(m.role)) return { puedeVer: false as const, trips: [], planned: [] };
    if (!data.poIds.length) return { puedeVer: true as const, trips: [], planned: [] };
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
      capitalized: boolean;
    }>`
      select e.po_id, e.event_ref, min(e.day)::text as date, bool_and(e.reversed) as reversed,
        t.freight::text as freight, t.handling::text as handling, p.name as partner,
        coalesce(t.notes, '') as notes, (t.capitalized_at is not null) as capitalized
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
      group by e.po_id, e.event_ref, t.freight, t.handling, p.name, t.notes, t.capitalized_at
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
    // Lo PLANEADO por orden: es lo que la recepción va a tomar, y sin ello
    // recibir se detiene (Decisión 101). La pantalla lo pide antes de que
    // llegue el camión.
    const planned = await sql<{ id: number; name: string; planned_freight: string | null; planned_handling: string | null }>`
      select id, name, planned_freight::text as planned_freight, planned_handling::text as planned_handling
      from purchase_orders where company_id = ${m.company_id} and id = any(${data.poIds})
    `;
    return {
      puedeVer: true as const,
      planned: planned.map((p) => ({
        poId: p.id,
        name: p.name,
        freight: p.planned_freight == null ? null : Number(p.planned_freight),
        handling: p.planned_handling == null ? null : Number(p.planned_handling),
      })),
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
        // Ya entró al costo de la mercancía: no se puede corregir (el promedio
        // no se recalcula hacia atrás). La pantalla ofrece la salida real.
        capitalized: t.capitalized === true,
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
/**
 * LO QUE SE ESPERA PAGAR POR TRAER ESTA ORDEN (Decisión 101).
 *
 * Se captura ANTES de recibir, por quien ve costos. De ahí lo toma la
 * recepción y entra al costo de la mercancía en el acto — después ya no
 * puede, porque el promedio del inventario no se corrige hacia atrás.
 *
 * Los dos importes juntos, y un cero se teclea a propósito cuando el proveedor
 * la trae sin cobrar flete: vacío no es cero.
 */
export const savePlannedTrip = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ poId: z.number(), freight: z.number().nonnegative(), handling: z.number().nonnegative() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const m = await companyOf(sql, context.userId);
    await assertCan(sql, context.userId, "purchases", "edit");
    if (!canSeeCosts(m.role)) throw new Error(SIN_COSTOS);
    const po = await sql<{ id: number; name: string; state: string; planned_freight: string | null; planned_handling: string | null }>`
      select id, name, state, planned_freight::text as planned_freight, planned_handling::text as planned_handling
      from purchase_orders where id = ${data.poId} and company_id = ${m.company_id}
    `;
    if (!po[0]) throw new Error("Orden de compra no encontrada");
    if (po[0].state === "cancelled") throw new Error(`${po[0].name} está cancelada.`);
    // Subir lo planeado a media orden es inocuo (la siguiente recepción toma
    // menos). BAJARLO por debajo de lo que ya entró al costo, no: deja flete
    // fantasma dentro del inventario y el promedio no se corrige hacia atrás.
    const ya = await sql<{ f: string; h: string }>`
      select coalesce(sum(coalesce(t.freight,0)),0)::text as f, coalesce(sum(coalesce(t.handling,0)),0)::text as h
      from trip_costs t
      where t.company_id = ${m.company_id} and t.po_id = ${data.poId} and t.capitalized_at is not null
        and exists (
          select 1 from stock_moves mv
          where mv.company_id = t.company_id and mv.event_ref = t.event_ref and mv.move_type = 'receipt'
            and not exists (select 1 from stock_moves r where r.reverses_id = mv.id)
        )
    `;
    const capF = Number(ya[0]?.f ?? 0);
    const capH = Number(ya[0]?.h ?? 0);
    if (data.freight + 0.0001 < capF || data.handling + 0.0001 < capH) {
      throw new Error(
        `De ${po[0].name} ya entraron al costo de la mercancía ${(capF + capH).toFixed(2)} de viaje ` +
        `(flete ${capF.toFixed(2)} + maniobras ${capH.toFixed(2)}). No se puede planear menos que eso: ` +
        `ese costo ya está dentro del inventario y el promedio no se recalcula hacia atrás. Si está mal, revierte la recepción.`,
      );
    }
    await sql`
      update purchase_orders set planned_freight = ${data.freight}, planned_handling = ${data.handling}
      where id = ${data.poId} and company_id = ${m.company_id}
    `;
    const num = (v: string | null) => (v == null ? "sin capturar" : Number(v).toFixed(2));
    await writeAudit(sql, {
      companyId: m.company_id,
      userId: context.userId,
      action: po[0].planned_freight == null ? "costo-de-viaje-planeado" : "costo-de-viaje-planeado-corregido",
      entity: "purchase_order",
      entityId: po[0].id,
      name: po[0].name,
      detail: `flete ${num(po[0].planned_freight)} → ${data.freight.toFixed(2)} · maniobras ${num(po[0].planned_handling)} → ${data.handling.toFixed(2)}`,
    });
    return { ok: true as const };
  });

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
    const antes = await sql<{ freight: string | null; handling: string | null; capitalized_at: string | null }>`
      select freight::text as freight, handling::text as handling, capitalized_at::text as capitalized_at
      from trip_costs where company_id = ${m.company_id} and event_ref = ${data.eventRef}
    `;
    // Decisión 101: lo que YA entró al costo de la mercancía no se corrige
    // aquí. El promedio del inventario no se recalcula hacia atrás, así que
    // cambiar el número dejaría el viaje diciendo una cosa y el costo otra —
    // peor que no poder cambiarlo. La salida es revertir la recepción.
    if (antes[0]?.capitalized_at) {
      throw new Error(
        `${data.eventRef} ya entró al costo de la mercancía: ese número no se puede cambiar sin recalcular el inventario hacia atrás. ` +
        `Si está mal, revierte la recepción y vuelve a recibirla con el costo correcto.`,
      );
    }
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

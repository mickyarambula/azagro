import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql, type Sql } from "@/lib/db";
import { activeMember, assertCan, canSeeCosts } from "@/lib/erp/acl";
import { maskAmounts } from "@/lib/erp/audit-mask";

async function cid(sql: Sql, userId: string) {
  const rows = await sql<{ company_id: number }>`select company_id from members where user_id = ${userId} and status = 'active' limit 1`;
  if (!rows[0]) throw new Error("Sin empresa");
  return rows[0].company_id;
}

export async function ensureAudit(sql: Sql) {
  await sql.query(`
    create table if not exists audit_log (
      id serial primary key,
      company_id integer not null references companies(id) on delete cascade,
      user_id text not null default '',
      action text not null,
      entity text not null,
      entity_id integer,
      name text not null default '',
      detail text not null default '',
      created_at timestamptz not null default now()
    )
  `);
}

export async function writeAudit(
  sql: Sql,
  opts: {
    companyId: number;
    userId: string;
    action: string;
    entity: string;
    entityId?: number | null;
    name?: string;
    detail?: string;
  },
) {
  await ensureAudit(sql);
  await sql`
    insert into audit_log (company_id, user_id, action, entity, entity_id, name, detail)
    values (
      ${opts.companyId}, ${opts.userId}, ${opts.action}, ${opts.entity},
      ${opts.entityId ?? null}, ${opts.name ?? ""}, ${opts.detail ?? ""}
    )
  `;
}

/**
 * Acciones cuyo DETALLE lleva un costo de compra. Quien no puede ver esos
 * costos (regla 10) ve el renglón —quién, qué y cuándo— pero no el importe.
 * Si se agrega una acción que imprima un costo de compra y no se pone aquí, el
 * número se sale por la bitácora sin que nadie lo note.
 */
const COSTO_DE_COMPRA = new Set([
  // El costo del viaje (Decisiones 100 y 101).
  "costo-de-viaje",
  "costo-de-viaje-corregido",
  "costo-de-viaje-planeado",
  "costo-de-viaje-planeado-corregido",
  "recibir",
  "flete-de-solicitud",
  // Las que ya imprimían un costo de compra desde antes. Estaban abiertas y se
  // cierran aquí: la lista solo sirve si está completa.
  "elegir-proveedor",            // «costo 4500 → 4200», el precio del proveedor
  "precio-producto",             // «costo 500 → 520» y el de referencia
  "crear-oc",                    // el total de la orden de compra
  "cancelar-oc",
  "revertir-fp",
  "revertir-recepcion",          // «promedio 9357.1429», que ya incluye el flete
  "devolucion-sin-costo-origen", // «entró al promedio de hoy 520.0000»
  "devolver",                    // «costo de salida 520.0000», que ya trae el flete adentro
]);

export const listAudit = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z
      .object({
        q: z.string().optional(),
        action: z.string().optional(),
        userId: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
      })
      .optional(),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    await assertCan(sql, context.userId, "settings", "view");
    await ensureAudit(sql);
    const me = await activeMember(sql, context.userId);
    const verCostos = canSeeCosts(me.role);
    const q = (data?.q ?? "").trim();
    const action = (data?.action ?? "").trim();
    const userId = (data?.userId ?? "").trim();
    const from = (data?.from ?? "").slice(0, 10);
    const to = (data?.to ?? "").slice(0, 10);
    // null (no cadena vacía concatenada) para que Postgres no intente castear
    // "T00:00:00" a timestamptz cuando no hay filtro de fecha.
    const fromTs = from ? `${from}T00:00:00` : null;
    const toTs = to ? `${to}T23:59:59` : null;
    const limit = data?.limit ?? 100;
    const offset = data?.offset ?? 0;
    const rows = await sql<{
      id: number;
      user_id: string;
      who: string;
      action: string;
      entity: string;
      entity_id: number | null;
      name: string;
      detail: string;
      created_at: string;
    }>`
      select a.id, a.user_id,
        coalesce(nullif(m.display_name,''), nullif(m.email,''), a.user_id) as who,
        a.action, a.entity, a.entity_id, a.name, a.detail,
        to_char(a.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
      from audit_log a
      left join members m on m.user_id = a.user_id and m.company_id = a.company_id
      where a.company_id = ${companyId}
        and (${q} = '' or a.name ilike ${"%" + q + "%"} or (
          -- El buscador no puede ser un oráculo del número que la máscara
          -- esconde: quien no ve costos tecleaba el importe y veía si el
          -- renglón aparecía. Para esas acciones, solo se busca por nombre.
          a.detail ilike ${"%" + q + "%"} and (${verCostos} or not (a.action = any(${[...COSTO_DE_COMPRA]})))
        ))
        and (${action} = '' or a.action = ${action})
        and (${userId} = '' or a.user_id = ${userId})
        and (${fromTs}::timestamptz is null or a.created_at >= ${fromTs}::timestamptz)
        and (${toTs}::timestamptz is null or a.created_at <= ${toTs}::timestamptz)
      order by a.id desc
      limit ${limit} offset ${offset}
    `;
    const actions = await sql<{ action: string }>`
      select distinct action from audit_log where company_id = ${companyId} order by action
    `;
    const users = await sql<{ user_id: string; who: string }>`
      select m.user_id, coalesce(nullif(m.display_name,''), nullif(m.email,''), m.user_id) as who
      from members m where m.company_id = ${companyId} order by who
    `;
    // EL MISMO NÚMERO QUE UNA PUERTA ESCONDE, LA OTRA NO LO PUBLICA (regla 10,
    // 21-sep-2026). La bitácora pide `settings:view`, que la plantilla de
    // administración tiene — pero administración NO ve costos de compra. Sin
    // esta máscara, el costo de un viaje enmascarado en Compras se leía
    // completo aquí, con su importe.
    // Se tapa el IMPORTE, no el renglón. Tapar el detalle completo escondía
    // cosas que administración sí necesita y que no son un costo: el motivo
    // obligatorio de una cancelación, y la liga «Recepción RCP/0001 · nace
    // FP-0001 por pagar», que es su trabajo. Los importes se imprimen siempre
    // con decimales (`toFixed`), los folios nunca: por ahí se distinguen.
    const visibles = verCostos
      ? rows
      : rows.map((r) => (COSTO_DE_COMPRA.has(r.action) ? { ...r, detail: maskAmounts(r.detail) } : r));
    return { rows: visibles, actions: actions.map((a) => a.action), users, limit, offset };
  });

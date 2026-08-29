import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { assertCan } from "@/lib/erp/acl";

type Sql = Awaited<ReturnType<typeof getSql>>;
async function cid(sql: Sql, userId: string) {
  const rows = await sql<{ company_id: number }>`select company_id from members where user_id = ${userId} limit 1`;
  if (!rows[0]) throw new Error("Sin empresa");
  return rows[0].company_id;
}

export const listDeliveryPoints = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    const rows = await sql<{ id: number; name: string; address: string; partner_id: number | null; partner_name: string | null }>`
      select l.id, l.name, coalesce(l.address,'') as address, l.partner_id, pt.name as partner_name
      from locations l
      left join partners pt on pt.id = l.partner_id
      where l.company_id = ${companyId} and l.loc_type = 'customer'
      order by l.name
    `;
    return { rows };
  });

export const LOC_TYPES = [
  { id: "internal", label: "Bodega Azagro" },
  { id: "supplier", label: "Bodega de proveedor" },
  { id: "transit", label: "En tránsito" },
  { id: "customer", label: "Punto de entrega" },
] as const;

export const saveLocation = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      id: z.number().optional(),
      name: z.string().min(2),
      code: z.string().optional().default(""),
      locType: z.enum(["internal", "supplier", "transit", "customer"]),
      partnerId: z.number().optional(),
      address: z.string().optional().default(""),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    if (data.locType === "customer") {
      try {
        await assertCan(sql, context.userId, "partners", "edit");
      } catch {
        await assertCan(sql, context.userId, "inventory", "edit");
      }
    } else {
      await assertCan(sql, context.userId, "inventory", "edit");
    }
    const prefix = data.locType === "supplier" ? "PROV" : data.locType === "customer" ? "ENT" : data.locType === "transit" ? "TRA" : "BOD";
    let code = (data.code || "").trim().toUpperCase();
    if (!code) {
      const n = await sql<{ c: number }>`select count(*)::int as c from locations where company_id = ${companyId}`;
      code = `${prefix}-${String((n[0]?.c ?? 0) + 1).padStart(3, "0")}`;
    }
    if (data.id) {
      await sql`
        update locations set name = ${data.name}, loc_type = ${data.locType},
          partner_id = ${data.partnerId ?? null}, address = ${data.address ?? ""}
        where id = ${data.id} and company_id = ${companyId}
      `;
      return { id: data.id, code };
    }
    const row = await sql<{ id: number }>`
      insert into locations (company_id, code, name, loc_type, partner_id, address)
      values (${companyId}, ${code}, ${data.name}, ${data.locType}, ${data.partnerId ?? null}, ${data.address ?? ""})
      returning id
    `;
    return { id: row[0]!.id, code };
  });

export const deleteLocation = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ id: z.number() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    const loc = await sql<{ loc_type: string }>`select loc_type from locations where id = ${data.id} and company_id = ${companyId}`;
    if (loc[0]?.loc_type === "customer") {
      try {
        await assertCan(sql, context.userId, "partners", "edit");
      } catch {
        await assertCan(sql, context.userId, "inventory", "edit");
      }
    } else {
      await assertCan(sql, context.userId, "inventory", "edit");
    }
    const qty = await sql<{ q: string }>`
      select coalesce(sum(quantity),0)::text as q from stock_quants where company_id = ${companyId} and location_id = ${data.id}
    `;
    if (Number(qty[0]?.q) > 0.0001) throw new Error("No se puede borrar: hay existencia. Trasládala antes.");
    const internals = await sql<{ c: number }>`
      select count(*)::int as c from locations where company_id = ${companyId} and loc_type = 'internal' and id <> ${data.id}
    `;
    if (loc[0]?.loc_type === "internal" && (internals[0]?.c ?? 0) < 1) throw new Error("Debe quedar al menos una bodega Azagro");
    await sql`delete from locations where id = ${data.id} and company_id = ${companyId}`;
    return { ok: true };
  });

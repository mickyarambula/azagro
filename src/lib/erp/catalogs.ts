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

export const listLookups = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    const uoms = await sql<{ id: number; code: string; name: string }>`
      select id, code, name from uoms where company_id = ${companyId} order by code
    `;
    const kinds = await sql<{ id: number; code: string; name: string }>`
      select id, code, name from product_kinds where company_id = ${companyId} order by code
    `;
    const groups = await sql<{ id: number; code: string; name: string }>`
      select id, code, name from partner_groups where company_id = ${companyId} order by name
    `;
    return { uoms, kinds, groups };
  });

export const saveLookup = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      kind: z.enum(["uom", "product_kind", "partner_group"]),
      code: z.string().min(1).max(24),
      name: z.string().min(1).max(80),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    const mod = data.kind === "partner_group" ? "partners" : "products";
    await assertCan(sql, context.userId, mod, "edit");
    const code = data.code.trim().toUpperCase();
    const name = data.name.trim();
    if (data.kind === "uom") {
      await sql`
        insert into uoms (company_id, code, name) values (${companyId}, ${code}, ${name})
        on conflict (company_id, code) do update set name = excluded.name
      `;
    } else if (data.kind === "product_kind") {
      await sql`
        insert into product_kinds (company_id, code, name) values (${companyId}, ${code}, ${name})
        on conflict (company_id, code) do update set name = excluded.name
      `;
    } else {
      await sql`
        insert into partner_groups (company_id, code, name) values (${companyId}, ${code}, ${name})
        on conflict (company_id, code) do update set name = excluded.name
      `;
    }
    return { ok: true, code };
  });

export const resyncCompaq = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    await assertCan(sql, context.userId, "settings", "edit");
    const companyId = await cid(sql, context.userId);
    const { syncCompaqCatalogs } = await import("@/lib/erp/compaq");
    return syncCompaqCatalogs(sql, companyId, true);
  });

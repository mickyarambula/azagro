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

async function ensure(sql: Sql) {
  await sql.query(`
    create table if not exists partner_products (
      id serial primary key,
      company_id integer not null references companies(id) on delete cascade,
      partner_id integer not null references partners(id) on delete cascade,
      product_id integer not null references products(id) on delete cascade,
      kind text not null default 'sell',
      unit_price numeric(14,4) not null default 0,
      notes text not null default '',
      unique (company_id, partner_id, product_id, kind)
    )
  `);
}

export const listPartnerProducts = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ partnerId: z.number().optional(), productId: z.number().optional() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    await ensure(sql);
    const rows = await sql<{
      id: number;
      partner_id: number;
      partner: string;
      product_id: number;
      product: string;
      code: string;
      kind: string;
      unit_price: string;
      notes: string;
    }>`
      select pp.id, pp.partner_id, pt.name as partner, pp.product_id, pr.name as product, pr.code,
        pp.kind, pp.unit_price::text, pp.notes
      from partner_products pp
      join partners pt on pt.id = pp.partner_id
      join products pr on pr.id = pp.product_id
      where pp.company_id = ${companyId}
        and (${data.partnerId ?? 0} = 0 or pp.partner_id = ${data.partnerId ?? 0})
        and (${data.productId ?? 0} = 0 or pp.product_id = ${data.productId ?? 0})
      order by pt.name, pr.code
    `;
    const products = await sql<{ id: number; code: string; name: string; list_price: string; cost: string; uom: string }>`
      select id, code, name, list_price::text, cost::text, uom from products where company_id = ${companyId} order by code
    `;
    const partners = await sql<{ id: number; name: string; is_customer: boolean; is_supplier: boolean }>`
      select id, name, is_customer, is_supplier from partners where company_id = ${companyId} order by name
    `;
    return { rows, products, partners };
  });

export const savePartnerProduct = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      partnerId: z.number(),
      productId: z.number(),
      kind: z.enum(["sell", "buy"]),
      unitPrice: z.number().nonnegative(),
      notes: z.string().optional().default(""),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await assertCan(sql, context.userId, "partners", "edit");
    const companyId = await cid(sql, context.userId);
    await ensure(sql);
    await sql`
      insert into partner_products (company_id, partner_id, product_id, kind, unit_price, notes)
      values (${companyId}, ${data.partnerId}, ${data.productId}, ${data.kind}, ${data.unitPrice}, ${data.notes ?? ""})
      on conflict (company_id, partner_id, product_id, kind)
      do update set unit_price = excluded.unit_price, notes = excluded.notes
    `;
    return { ok: true };
  });

export const deletePartnerProduct = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ id: z.number() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await assertCan(sql, context.userId, "partners", "edit");
    const companyId = await cid(sql, context.userId);
    await sql`delete from partner_products where id = ${data.id} and company_id = ${companyId}`;
    return { ok: true };
  });

export type TradeKind = "sell" | "buy";

/** Al vender o comprar, el maestro se llena solo: producto, destino y rol cliente/proveedor. */
export async function rememberTrade(
  sql: Sql,
  opts: {
    companyId: number;
    partnerId: number;
    kind: TradeKind;
    products?: Array<{ productId: number; unitPrice?: number }>;
    locationId?: number | null;
  },
) {
  if (!opts.partnerId || !opts.companyId) return;
  await ensure(sql);
  if (opts.kind === "sell") {
    await sql`
      update partners set is_customer = true
      where id = ${opts.partnerId} and company_id = ${opts.companyId} and is_customer = false
    `;
  } else {
    await sql`
      update partners set is_supplier = true
      where id = ${opts.partnerId} and company_id = ${opts.companyId} and is_supplier = false
    `;
  }
  for (const p of opts.products ?? []) {
    if (!p.productId) continue;
    const price = Number(p.unitPrice) || 0;
    await sql`
      insert into partner_products (company_id, partner_id, product_id, kind, unit_price, notes)
      values (${opts.companyId}, ${opts.partnerId}, ${p.productId}, ${opts.kind}, ${price}, '')
      on conflict (company_id, partner_id, product_id, kind)
      do update set unit_price = case
        when excluded.unit_price > 0 then excluded.unit_price
        else partner_products.unit_price
      end
    `;
  }
  if (opts.locationId) {
    const locType = opts.kind === "sell" ? "customer" : "supplier";
    await sql`
      update locations
      set partner_id = ${opts.partnerId}
      where id = ${opts.locationId}
        and company_id = ${opts.companyId}
        and loc_type = ${locType}
        and partner_id is null
    `;
  }
}

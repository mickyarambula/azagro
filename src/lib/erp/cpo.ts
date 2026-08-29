import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { assertCan } from "@/lib/erp/acl";
import { rememberTrade } from "@/lib/erp/links";

type Sql = Awaited<ReturnType<typeof getSql>>;

async function cid(sql: Sql, userId: string) {
  const rows = await sql<{ company_id: number }>`
    select company_id from members where user_id = ${userId} limit 1
  `;
  if (!rows[0]) throw new Error("Sin empresa");
  return rows[0].company_id;
}

async function ensure(sql: Sql) {
  await sql`
    create table if not exists customer_pos (
      id serial primary key,
      company_id integer not null references companies(id) on delete cascade,
      partner_id integer not null references partners(id),
      name text not null,
      customer_po_number text not null default '',
      po_date date not null default current_date,
      currency text not null default 'USD',
      fx_rate numeric(12,6) not null default 1,
      notes text not null default '',
      status text not null default 'open',
      so_id integer references sales_orders(id),
      total numeric(14,2) not null default 0,
      created_at timestamptz not null default now()
    )
  `;
  await sql`
    create table if not exists customer_po_lines (
      id serial primary key,
      cpo_id integer not null references customer_pos(id) on delete cascade,
      product_id integer not null references products(id),
      qty numeric(14,4) not null,
      uom text not null default '',
      unit_price numeric(14,4) not null default 0
    )
  `;
}

export const listCustomerPOs = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    await ensure(sql);
    const pos = await sql<{
      id: number;
      name: string;
      customer_po_number: string;
      partner: string;
      partner_id: number;
      po_date: string;
      currency: string;
      status: string;
      so_id: number | null;
      so_name: string | null;
      total: string;
    }>`
      select c.id, c.name, c.customer_po_number, p.name as partner, c.partner_id, c.po_date::text,
        c.currency, c.status, c.so_id, so.name as so_name, c.total::text
      from customer_pos c
      join partners p on p.id = c.partner_id
      left join sales_orders so on so.id = c.so_id
      where c.company_id = ${companyId}
      order by c.id desc
    `;
    const lines = await sql<{
      cpo_id: number;
      product: string;
      qty: string;
      uom: string;
      unit_price: string;
    }>`
      select l.cpo_id, pr.code as product, l.qty::text, l.uom, l.unit_price::text
      from customer_po_lines l
      join products pr on pr.id = l.product_id
      join customer_pos c on c.id = l.cpo_id
      where c.company_id = ${companyId}
    `;
    const customers = await sql<{ id: number; name: string }>`
      select id, name from partners where company_id = ${companyId} and is_customer = true order by name
    `;
    const products = await sql<{ id: number; code: string; name: string; uom: string; list_price: string }>`
      select id, code, name, uom, list_price::text from products where company_id = ${companyId} order by code
    `;
    return { pos, lines, customers, products };
  });

export const createCustomerPO = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      partnerId: z.number(),
      customerPoNumber: z.string().min(1),
      poDate: z.string(),
      currency: z.enum(["MXN", "USD"]),
      notes: z.string().optional().default(""),
      lines: z
        .array(
          z.object({
            productId: z.number(),
            qty: z.number().positive(),
            uom: z.string(),
            unitPrice: z.number().nonnegative(),
          }),
        )
        .min(1),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    await assertCan(sql, context.userId, "sales", "edit");
    await ensure(sql);
    const n = await sql<{ c: number }>`select count(*)::int as c from customer_pos where company_id = ${companyId}`;
    const name = `OC-CL-${String((n[0]?.c ?? 0) + 1).padStart(4, "0")}`;
    const total = data.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0);
    const row = await sql<{ id: number }>`
      insert into customer_pos (company_id, partner_id, name, customer_po_number, po_date, currency, notes, total)
      values (${companyId}, ${data.partnerId}, ${name}, ${data.customerPoNumber}, ${data.poDate}, ${data.currency}, ${data.notes ?? ""}, ${total})
      returning id
    `;
    for (const line of data.lines) {
      await sql`
        insert into customer_po_lines (cpo_id, product_id, qty, uom, unit_price)
        values (${row[0]!.id}, ${line.productId}, ${line.qty}, ${line.uom}, ${line.unitPrice})
      `;
    }
    await rememberTrade(sql, {
      companyId,
      partnerId: data.partnerId,
      kind: "sell",
      products: data.lines.map((l) => ({ productId: l.productId, unitPrice: l.unitPrice })),
    });
    return { id: row[0]!.id, name };
  });

export const convertCustomerPO = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ cpoId: z.number(), locationId: z.number() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    await assertCan(sql, context.userId, "sales", "edit");
    const cpo = await sql<{
      id: number;
      partner_id: number;
      customer_po_number: string;
      currency: string;
      status: string;
      notes: string;
    }>`
      select id, partner_id, customer_po_number, currency, status, notes
      from customer_pos where id = ${data.cpoId} and company_id = ${companyId}
    `;
    if (!cpo[0]) throw new Error("OC no encontrada");
    if (cpo[0].status === "converted") throw new Error("Ya está convertida");
    const lines = await sql<{ product_id: number; qty: string; uom: string; unit_price: string }>`
      select product_id, qty::text, uom, unit_price::text from customer_po_lines where cpo_id = ${cpo[0].id}
    `;
    const n = await sql<{ c: number }>`select count(*)::int as c from sales_orders where company_id = ${companyId}`;
    const name = `PV-${String((n[0]?.c ?? 0) + 1).padStart(4, "0")}`;
    const total = lines.reduce((s, l) => s + Number(l.qty) * Number(l.unit_price), 0);
    const so = await sql<{ id: number }>`
      insert into sales_orders (
        company_id, name, partner_id, date, state, location_id, notes, total,
        currency, fx_rate, delivery_to, owner_id,
        term_kind, invoice_days, credit_days, route_kind, policy_code, oc_cliente, price_mode
      ) values (
        ${companyId}, ${name}, ${cpo[0].partner_id}, current_date, 'draft', ${data.locationId},
        ${cpo[0].notes}, ${total}, ${cpo[0].currency}, 1, '', ${context.userId},
        'credit_days', 0, 0, 'own', 'NONE', ${cpo[0].customer_po_number}, 'custom'
      )
      returning id
    `;
    for (const line of lines) {
      const qty = Number(line.qty);
      const price = Number(line.unit_price);
      const uom = line.uom;
      await sql`
        insert into sales_lines (so_id, product_id, qty, unit_price, uom)
        values (${so[0]!.id}, ${line.product_id}, ${qty}, ${price}, ${uom})
      `;
    }
    await rememberTrade(sql, {
      companyId,
      partnerId: cpo[0].partner_id,
      kind: "sell",
      products: lines.map((l) => ({ productId: l.product_id, unitPrice: Number(l.unit_price) })),
      locationId: data.locationId,
    });
    await sql`update customer_pos set status = 'converted', so_id = ${so[0]!.id} where id = ${cpo[0].id}`;
    return { soId: so[0]!.id, name };
  });

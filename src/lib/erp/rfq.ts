import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { assertCan } from "@/lib/erp/acl";
import { rememberTrade } from "@/lib/erp/links";

type Sql = Awaited<ReturnType<typeof getSql>>;
async function cid(sql: Sql, userId: string) {
  const rows = await sql<{ company_id: number }>`select company_id from members where user_id = ${userId} limit 1`;
  if (!rows[0]) throw new Error("Sin empresa");
  return rows[0].company_id;
}

async function ensure(sql: Sql) {
  await sql.query(`
    create table if not exists vendor_rfqs (
      id serial primary key,
      company_id integer not null references companies(id) on delete cascade,
      name text not null,
      quote_id integer references quotes(id) on delete set null,
      notes text not null default '',
      state text not null default 'open',
      created_at timestamptz not null default now()
    )
  `);
  await sql.query(`alter table vendor_rfqs add column if not exists request_id integer`);
  await sql.query(`alter table vendor_rfqs add column if not exists purpose text not null default 'sale'`);
  await sql.query(`alter table vendor_rfqs add column if not exists location_id integer`);
  await sql.query(`alter table vendor_rfqs add column if not exists currency text not null default 'MXN'`);
  await sql.query(`
    create table if not exists vendor_rfq_suppliers (
      rfq_id integer not null references vendor_rfqs(id) on delete cascade,
      partner_id integer not null references partners(id) on delete cascade,
      primary key (rfq_id, partner_id)
    )
  `);
  await sql.query(`
    create table if not exists vendor_rfq_lines (
      id serial primary key,
      rfq_id integer not null references vendor_rfqs(id) on delete cascade,
      product_id integer not null references products(id),
      qty numeric(14,3) not null,
      uom text not null default ''
    )
  `);
  await sql.query(`
    create table if not exists vendor_rfq_bids (
      id serial primary key,
      rfq_id integer not null references vendor_rfqs(id) on delete cascade,
      partner_id integer not null references partners(id),
      product_id integer not null references products(id),
      unit_price numeric(14,4) not null default 0,
      unique (rfq_id, partner_id, product_id)
    )
  `);
}

export const listRfqs = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    await ensure(sql);
    const rfqs = await sql<{
      id: number;
      name: string;
      state: string;
      notes: string;
      quote_id: number | null;
      purpose: string;
    }>`
      select id, name, state, notes, quote_id, coalesce(purpose,'sale') as purpose
      from vendor_rfqs where company_id = ${companyId} order by id desc
    `;
    const suppliers = await sql<{ id: number; name: string; email: string; phone: string }>`
      select id, name, coalesce(email,'') as email, coalesce(phone,'') as phone
      from partners where company_id = ${companyId} and is_supplier = true order by name
    `;
    const products = await sql<{ id: number; code: string; name: string; uom: string; cost: string }>`
      select id, code, name, uom, cost::text from products where company_id = ${companyId} order by code
    `;
    const locations = await sql<{ id: number; name: string; loc_type: string }>`
      select id, name, loc_type from locations
      where company_id = ${companyId} and loc_type in ('internal','supplier','transit')
      order by loc_type, name
    `;
    return { rfqs, suppliers, products, locations };
  });

export const getRfq = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ id: z.number() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    await ensure(sql);
    const head = await sql<{
      id: number;
      name: string;
      state: string;
      notes: string;
      quote_id: number | null;
      purpose: string;
      location_id: number | null;
      location_name: string | null;
      currency: string;
    }>`
      select r.id, r.name, r.state, r.notes, r.quote_id, coalesce(r.purpose,'sale') as purpose,
        r.location_id, l.name as location_name, coalesce(r.currency,'MXN') as currency
      from vendor_rfqs r
      left join locations l on l.id = r.location_id
      where r.id = ${data.id} and r.company_id = ${companyId}
    `;
    if (!head[0]) throw new Error("Solicitud no encontrada");
    const lines = await sql<{ product_id: number; product: string; code: string; qty: string; uom: string }>`
      select l.product_id, p.name as product, p.code, l.qty::text, l.uom
      from vendor_rfq_lines l join products p on p.id = l.product_id
      where l.rfq_id = ${data.id}
    `;
    const invited = await sql<{ id: number; name: string; email: string; phone: string }>`
      select p.id, p.name, coalesce(p.email,'') as email, coalesce(p.phone,'') as phone
      from vendor_rfq_suppliers s join partners p on p.id = s.partner_id
      where s.rfq_id = ${data.id}
    `;
    const bids = await sql<{ partner_id: number; product_id: number; unit_price: string }>`
      select partner_id, product_id, unit_price::text from vendor_rfq_bids where rfq_id = ${data.id}
    `;
    return { rfq: head[0], lines, invited, bids };
  });

export const createRfq = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      quoteId: z.number().optional(),
      notes: z.string().optional().default(""),
      purpose: z.enum(["sale", "stock"]).optional().default("sale"),
      locationId: z.number().optional(),
      currency: z.enum(["MXN", "USD"]).optional().default("MXN"),
      supplierIds: z.array(z.number()).min(1),
      lines: z.array(z.object({ productId: z.number(), qty: z.number().positive(), uom: z.string() })).min(1),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await assertCan(sql, context.userId, "purchases", "edit");
    const companyId = await cid(sql, context.userId);
    await ensure(sql);
    const n = await sql<{ c: number }>`select count(*)::int as c from vendor_rfqs where company_id = ${companyId}`;
    const name = `SC-${String((n[0]?.c ?? 0) + 1).padStart(4, "0")}`;
    const row = await sql<{ id: number }>`
      insert into vendor_rfqs (company_id, name, quote_id, notes, state, purpose, location_id, currency)
      values (
        ${companyId}, ${name}, ${data.quoteId ?? null}, ${data.notes ?? ""}, 'open',
        ${data.purpose ?? "sale"}, ${data.locationId ?? null}, ${data.currency ?? "MXN"}
      )
      returning id
    `;
    const id = row[0]!.id;
    for (const sid of data.supplierIds) {
      await sql`insert into vendor_rfq_suppliers (rfq_id, partner_id) values (${id}, ${sid}) on conflict do nothing`;
    }
    for (const line of data.lines) {
      await sql`insert into vendor_rfq_lines (rfq_id, product_id, qty, uom) values (${id}, ${line.productId}, ${line.qty}, ${line.uom})`;
    }
    for (const sid of data.supplierIds) {
      await rememberTrade(sql, {
        companyId,
        partnerId: sid,
        kind: "buy",
        products: data.lines.map((l) => ({ productId: l.productId })),
      });
    }
    return { id, name };
  });

export const saveRfqBid = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ rfqId: z.number(), partnerId: z.number(), productId: z.number(), unitPrice: z.number().nonnegative() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await assertCan(sql, context.userId, "purchases", "edit");
    await ensure(sql);
    await sql`
      insert into vendor_rfq_bids (rfq_id, partner_id, product_id, unit_price)
      values (${data.rfqId}, ${data.partnerId}, ${data.productId}, ${data.unitPrice})
      on conflict (rfq_id, partner_id, product_id) do update set unit_price = excluded.unit_price
    `;
    const co = await sql<{ company_id: number }>`select company_id from vendor_rfqs where id = ${data.rfqId}`;
    if (co[0]) {
      await rememberTrade(sql, {
        companyId: co[0].company_id,
        partnerId: data.partnerId,
        kind: "buy",
        products: [{ productId: data.productId, unitPrice: data.unitPrice }],
      });
    }
    return { ok: true };
  });

export const applyRfqWinners = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ rfqId: z.number(), winners: z.array(z.object({ productId: z.number(), unitPrice: z.number(), partnerId: z.number() })) }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    const rfq = await sql<{
      quote_id: number | null;
      purpose: string;
      location_id: number | null;
      name: string;
      notes: string;
      currency: string;
      state: string;
    }>`
      select quote_id, coalesce(purpose,'sale') as purpose, location_id, name, notes,
        coalesce(currency,'MXN') as currency, state
      from vendor_rfqs where id = ${data.rfqId} and company_id = ${companyId}
    `;
    if (!rfq[0]) throw new Error("Solicitud no encontrada");
    const stock = rfq[0].purpose === "stock";
    await assertCan(sql, context.userId, stock ? "purchases" : "quotes", "edit");
    if (rfq[0].state === "awarded" && stock) {
      throw new Error("Ya se emitieron las órdenes de compra.");
    }
    const quoteId = rfq[0].quote_id;
    if (quoteId) {
      for (const w of data.winners) {
        await sql`update quote_lines set cost = ${w.unitPrice} where quote_id = ${quoteId} and product_id = ${w.productId}`;
      }
    }
    const bySup = new Map<number, Array<{ productId: number; unitPrice: number }>>();
    for (const w of data.winners) {
      const list = bySup.get(w.partnerId) ?? [];
      list.push({ productId: w.productId, unitPrice: w.unitPrice });
      bySup.set(w.partnerId, list);
    }
    for (const [partnerId, products] of bySup) {
      await rememberTrade(sql, { companyId, partnerId, kind: "buy", products });
    }

    const pos: string[] = [];
    if (stock) {
      const loc = rfq[0].location_id
        ? [{ id: rfq[0].location_id }]
        : await sql<{ id: number }>`
            select id from locations
            where company_id = ${companyId} and loc_type = 'internal'
            order by id limit 1
          `;
      if (!loc[0]) throw new Error("Elige la bodega donde se va a recibir.");
      const rfqLines = await sql<{ product_id: number; qty: string; uom: string }>`
        select product_id, qty::text, uom from vendor_rfq_lines where rfq_id = ${data.rfqId}
      `;
      await sql`alter table purchase_orders add column if not exists fulfill_kind text not null default 'inventory'`;
      await sql`alter table purchase_orders add column if not exists rfq_id integer`;
      await sql`alter table purchase_lines add column if not exists uom text not null default ''`;
      await sql`alter table purchase_lines add column if not exists deliver_to text not null default ''`;
      for (const [supplierId, wins] of bySup) {
        const lines = wins
          .map((w) => {
            const src = rfqLines.find((l) => l.product_id === w.productId);
            if (!src) return null;
            return { productId: w.productId, qty: Number(src.qty), unitPrice: w.unitPrice, uom: src.uom };
          })
          .filter((x): x is { productId: number; qty: number; unitPrice: number; uom: string } => !!x);
        if (!lines.length) continue;
        const poN = await sql<{ c: number }>`select count(*)::int as c from purchase_orders where company_id = ${companyId}`;
        const poName = `OC-${String((poN[0]?.c ?? 0) + 1).padStart(4, "0")}`;
        const total = lines.reduce((s, l) => s + l.qty * l.unitPrice, 0);
        const po = await sql<{ id: number }>`
          insert into purchase_orders (company_id, name, partner_id, state, location_id, notes, total, currency, fx_rate, fulfill_kind, rfq_id)
          values (
            ${companyId}, ${poName}, ${supplierId}, 'confirmed', ${loc[0].id},
            ${`Desde ${rfq[0].name} · inventario`}, ${total}, ${rfq[0].currency}, 1, 'inventory', ${data.rfqId}
          )
          returning id
        `;
        for (const line of lines) {
          await sql`
            insert into purchase_lines (po_id, product_id, qty, unit_price, uom, deliver_to)
            values (${po[0]!.id}, ${line.productId}, ${line.qty}, ${line.unitPrice}, ${line.uom}, '')
          `;
        }
        await rememberTrade(sql, {
          companyId,
          partnerId: supplierId,
          kind: "buy",
          products: lines.map((l) => ({ productId: l.productId, unitPrice: l.unitPrice })),
          locationId: loc[0].id,
        });
        const daysPay = await sql<{ payment_days: number }>`
          select coalesce(payment_days,0) as payment_days from partners where id = ${supplierId}
        `;
        const due = new Date();
        due.setDate(due.getDate() + (daysPay[0]?.payment_days ?? 0));
        const ic = await sql<{ c: number }>`select count(*)::int as c from invoices where company_id = ${companyId} and kind = 'supplier'`;
        const iname = `FP-${String((ic[0]?.c ?? 0) + 1).padStart(4, "0")}`;
        await sql`
          insert into invoices (company_id, kind, name, partner_id, due_date, state, amount, residual, origin, currency)
          values (${companyId}, 'supplier', ${iname}, ${supplierId}, ${due.toISOString().slice(0, 10)}, 'open', ${total}, ${total}, ${poName}, ${rfq[0].currency})
        `;
        pos.push(poName);
      }
    }

    await sql`update vendor_rfqs set state = 'awarded' where id = ${data.rfqId}`;
    return { quoteId: quoteId ?? 0, pos };
  });

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { activeMember, assertCan, canSeeCosts, canSeeMargins } from "@/lib/erp/acl";
import { writeAudit } from "@/lib/erp/audit";
import { addDays, missingRateMessage } from "@/lib/erp/credit";
import { todayMx } from "@/lib/utils";
import { priceSale } from "@/lib/erp/pricing";
import { policy } from "@/lib/erp/ops";
import { rememberTrade } from "@/lib/erp/links";
import { marginOf, marginText, normalizeMargin, OFFER_LABEL } from "@/lib/erp/margins";
import { assertRequestOpen } from "@/lib/erp/request-lock";

type Sql = Awaited<ReturnType<typeof getSql>>;
async function cid(sql: Sql, userId: string) {
  const rows = await sql<{ company_id: number }>`select company_id from members where user_id = ${userId} and status = 'active' limit 1`;
  if (!rows[0]) throw new Error("Sin empresa");
  return rows[0].company_id;
}

export const DELIVERY_MODES = [
  { id: "campo", label: "Puesta en campo" },
  { id: "bodega", label: "En bodega" },
  { id: "pickup", label: "El cliente recolecta" },
] as const;

async function ensure(sql: Sql) {
  await sql.query(`
    create table if not exists customer_requests (
      id serial primary key,
      company_id integer not null references companies(id) on delete cascade,
      name text not null,
      partner_id integer not null references partners(id),
      date date not null default current_date,
      delivery_mode text not null default 'campo',
      delivery_to text not null default '',
      notes text not null default '',
      state text not null default 'open',
      quote_id integer,
      rfq_id integer
    )
  `);
  await sql.query(`alter table customer_requests add column if not exists location_id integer`);
  await sql.query(`alter table quotes add column if not exists owner_id text`);
  await sql.query(`
    create table if not exists customer_request_lines (
      id serial primary key,
      request_id integer not null references customer_requests(id) on delete cascade,
      product_id integer not null references products(id),
      qty numeric(14,3) not null,
      uom text not null default '',
      cost numeric(14,4) not null default 0,
      freight numeric(14,4) not null default 0,
      supplier_id integer references partners(id)
    )
  `);
  // Margen único anterior (previo a 0017). Sin default y sin NOT NULL: una
  // partida nueva nace SIN margen y la pantalla lo dice. Ya no existe el 12%
  // por omisión (migración 0018).
  await sql.query(`alter table customer_request_lines add column if not exists margin_mode text`);
  await sql.query(`alter table customer_request_lines add column if not exists margin_pct numeric(8,4)`);
  await sql.query(`alter table customer_request_lines add column if not exists margin_nominal numeric(14,4)`);
  await sql.query(`alter table customer_request_lines add column if not exists pick_reason text not null default ''`);
  // Migración 0017 (dos precios): plazo/moneda/TC de la solicitud y margen
  // contado / crédito por partida. Nulo = nadie lo ha capturado.
  // 0018: margin_*_source dice si el número lo escribió alguien ('captura') o
  // lo copió la migración desde el margen viejo ('migracion').
  await sql.query(`alter table customer_requests add column if not exists credit_days integer`);
  await sql.query(`alter table customer_requests add column if not exists currency text`);
  await sql.query(`alter table customer_requests add column if not exists fx_rate numeric(12,4)`);
  for (const col of ["cash", "credit"]) {
    await sql.query(`alter table customer_request_lines add column if not exists margin_${col}_mode text`);
    await sql.query(`alter table customer_request_lines add column if not exists margin_${col}_pct numeric(8,4)`);
    await sql.query(`alter table customer_request_lines add column if not exists margin_${col}_nominal numeric(14,4)`);
    await sql.query(`alter table customer_request_lines add column if not exists margin_${col}_source text`);
    await sql.query(`alter table quote_lines add column if not exists margin_${col}_mode text`);
    await sql.query(`alter table quote_lines add column if not exists margin_${col}_pct numeric(8,4)`);
    await sql.query(`alter table quote_lines add column if not exists margin_${col}_nominal numeric(14,4)`);
    await sql.query(`alter table quote_lines add column if not exists margin_${col}_source text`);
  }
  await sql.query(`alter table quote_lines add column if not exists finance_unit numeric(14,4)`);
  await sql.query(`alter table quotes add column if not exists accepted_offer text`);
  await sql.query(`alter table sales_orders add column if not exists accepted_offer text`);
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
  await sql.query(`
    create table if not exists vendor_rfq_targets (
      rfq_id integer not null references vendor_rfqs(id) on delete cascade,
      product_id integer not null,
      partner_id integer not null references partners(id),
      primary key (rfq_id, product_id, partner_id)
    )
  `);
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

export const listRequests = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    const me = await activeMember(sql, context.userId);
    if (me.acl.quotes === "none") throw new Error("Sin permiso para ver este módulo");
    await ensure(sql);
    const rows = await sql<{
      id: number;
      name: string;
      partner: string;
      date: string;
      delivery_mode: string;
      state: string;
      lines: number;
    }>`
      select r.id, r.name, p.name as partner, r.date::text, r.delivery_mode, r.state,
        (select count(*)::int from customer_request_lines l where l.request_id = r.id) as lines
      from customer_requests r
      join partners p on p.id = r.partner_id
      where r.company_id = ${companyId}
      order by r.id desc
    `;
    const customers = await sql<{ id: number; code: string; name: string }>`
      select id, code, name from partners where company_id = ${companyId} and is_customer = true order by code, name
    `;
    const products = await sql<{ id: number; code: string; name: string; uom: string; cost: string }>`
      select id, code, name, uom, cost::text from products where company_id = ${companyId} order by code
    `;
    if (!canSeeCosts(me.role)) {
      return { rows, customers, products: products.map((p) => ({ ...p, cost: "0" })) };
    }
    return { rows, customers, products };
  });

export const getRequest = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ id: z.number() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    const me = await activeMember(sql, context.userId);
    if (me.acl.quotes === "none") throw new Error("Sin permiso para ver este módulo");
    await ensure(sql);
    const head = await sql<{
      id: number;
      name: string;
      partner_id: number;
      partner: string;
      date: string;
      delivery_mode: string;
      delivery_to: string;
      notes: string;
      state: string;
      quote_id: number | null;
      rfq_id: number | null;
      quote_name: string | null;
      location_id: number | null;
      credit_days: number | null;
      currency: string | null;
      fx_rate: string | null;
    }>`
      select r.id, r.name, r.partner_id, p.name as partner, r.date::text, r.delivery_mode, r.delivery_to,
        r.notes, r.state, r.quote_id, r.rfq_id,
        (select name from quotes where id = r.quote_id) as quote_name,
        r.location_id, r.credit_days, r.currency, r.fx_rate::text
      from customer_requests r
      join partners p on p.id = r.partner_id
      where r.id = ${data.id} and r.company_id = ${companyId}
    `;
    if (!head[0]) throw new Error("Solicitud no encontrada");
    // Si ya generó cotización, la solicitud se muestra bloqueada con la cadena
    // completa: COT → PV (los pedidos que salieron de esa cotización).
    let quote: { id: number; name: string; state: string; credit_days: number; currency: string; fx_rate: string; price_offer: string; accepted_offer: string | null } | null = null;
    let orders: Array<{ id: number; name: string; state: string }> = [];
    if (head[0].quote_id) {
      const qs = await sql<{ id: number; name: string; state: string; credit_days: number; currency: string; fx_rate: string; price_offer: string; accepted_offer: string | null }>`
        select id, name, state, coalesce(credit_days,0)::int as credit_days, currency, fx_rate::text,
          coalesce(price_offer,'both') as price_offer, accepted_offer
        from quotes where id = ${head[0].quote_id} and company_id = ${companyId}
      `;
      quote = qs[0] ?? null;
      orders = await sql<{ id: number; name: string; state: string }>`
        select id, name, state from sales_orders where quote_id = ${head[0].quote_id} and company_id = ${companyId} order by id
      `;
    }
    const lines = await sql<{
      id: number;
      product_id: number;
      code: string;
      product: string;
      qty: string;
      uom: string;
      cost: string;
      freight: string;
      supplier_id: number | null;
      on_hand: string;
      on_hand_own: string;
      on_hand_supplier: string;
      margin_mode: string | null;
      margin_pct: string | null;
      margin_nominal: string | null;
      pick_reason: string;
      margin_cash_mode: string | null;
      margin_cash_pct: string | null;
      margin_cash_nominal: string | null;
      margin_cash_source: string | null;
      margin_credit_mode: string | null;
      margin_credit_pct: string | null;
      margin_credit_nominal: string | null;
      margin_credit_source: string | null;
    }>`
      select l.id, l.product_id, pr.code, pr.name as product, l.qty::text, l.uom, l.cost::text, l.freight::text,
        l.supplier_id,
        coalesce((select sum(quantity) from stock_quants q where q.product_id = l.product_id),0)::text as on_hand,
        coalesce((select sum(q.quantity) from stock_quants q join locations lo on lo.id = q.location_id where q.product_id = l.product_id and lo.loc_type = 'internal'),0)::text as on_hand_own,
        coalesce((select sum(q.quantity) from stock_quants q join locations lo on lo.id = q.location_id where q.product_id = l.product_id and lo.loc_type = 'supplier'),0)::text as on_hand_supplier,
        l.margin_mode, l.margin_pct::text as margin_pct,
        l.margin_nominal::text as margin_nominal, coalesce(l.pick_reason,'') as pick_reason,
        l.margin_cash_mode, l.margin_cash_pct::text as margin_cash_pct, l.margin_cash_nominal::text as margin_cash_nominal,
        l.margin_cash_source,
        l.margin_credit_mode, l.margin_credit_pct::text as margin_credit_pct, l.margin_credit_nominal::text as margin_credit_nominal,
        l.margin_credit_source
      from customer_request_lines l
      join products pr on pr.id = l.product_id
      where l.request_id = ${data.id}
      order by l.id
    `;
    const suppliers = await sql<{ id: number; name: string; email: string; phone: string; payment_days: number }>`
      select id, name, coalesce(email,'') as email, coalesce(phone,'') as phone, payment_days
      from partners where company_id = ${companyId} and is_supplier = true order by name
    `;
    const links = await sql<{ partner_id: number; product_id: number }>`
      select partner_id, product_id from partner_products
      where company_id = ${companyId} and kind = 'buy'
    `;
    let rfq: {
      id: number;
      name: string;
      targets: Array<{ product_id: number; partner_id: number }>;
      bids: Array<{ partner_id: number; product_id: number; unit_price: string }>;
    } | null = null;
    if (head[0].rfq_id) {
      const r = await sql<{ id: number; name: string }>`select id, name from vendor_rfqs where id = ${head[0].rfq_id}`;
      const targets = await sql<{ product_id: number; partner_id: number }>`
        select product_id, partner_id from vendor_rfq_targets where rfq_id = ${head[0].rfq_id}
      `;
      const bids = await sql<{ partner_id: number; product_id: number; unit_price: string }>`
        select partner_id, product_id, unit_price::text from vendor_rfq_bids where rfq_id = ${head[0].rfq_id}
      `;
      if (r[0]) rfq = { id: r[0].id, name: r[0].name, targets, bids };
    }
    // Costos por proveedor, fletes y márgenes: solo quien puede verlos.
    if (!canSeeCosts(me.role)) {
      const maskedLines = lines.map((l) => ({
        ...l,
        cost: "0",
        freight: "0",
        margin_pct: null,
        margin_nominal: null,
        margin_cash_pct: null,
        margin_cash_nominal: null,
        margin_credit_pct: null,
        margin_credit_nominal: null,
      }));
      const maskedRfq = rfq ? { ...rfq, bids: rfq.bids.map((b) => ({ ...b, unit_price: "0" })) } : null;
      return { request: head[0], lines: maskedLines, suppliers, links, rfq: maskedRfq, quote, orders };
    }
    return { request: head[0], lines, suppliers, links, rfq, quote, orders };
  });

/**
 * Plazo, moneda y tipo de cambio de la solicitud. Se guardan al salir del
 * campo (onCommit), con bitácora anterior → nuevo. Antes vivían solo en la
 * pantalla (useState) y se perdían al volver: por eso el plazo capturado
 * desaparecía. Con cotización ya generada no se tocan: se leen de la
 * cotización.
 */
export const saveRequestTerms = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      id: z.number(),
      creditDays: z.number().int().nonnegative().optional(),
      currency: z.enum(["MXN", "USD"]).optional(),
      fxRate: z.number().nonnegative().optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await assertCan(sql, context.userId, "quotes", "edit");
    const companyId = await cid(sql, context.userId);
    await ensure(sql);
    await assertRequestOpen(sql, companyId, data.id);
    const before = await sql<{ name: string; credit_days: number | null; currency: string | null; fx_rate: string | null }>`
      select name, credit_days, currency, fx_rate::text from customer_requests where id = ${data.id} and company_id = ${companyId}
    `;
    if (!before[0]) throw new Error("Solicitud no encontrada");
    const cambios: string[] = [];
    if (data.creditDays !== undefined && data.creditDays !== (before[0].credit_days ?? 0)) {
      cambios.push(`plazo ${before[0].credit_days ?? 0} → ${data.creditDays} d`);
    }
    if (data.currency !== undefined && data.currency !== (before[0].currency ?? "")) {
      cambios.push(`moneda ${before[0].currency ?? "—"} → ${data.currency}`);
    }
    if (data.fxRate !== undefined && data.fxRate !== Number(before[0].fx_rate ?? 0)) {
      cambios.push(`TC ${Number(before[0].fx_rate ?? 0)} → ${data.fxRate}`);
    }
    await sql`
      update customer_requests
      set credit_days = coalesce(${data.creditDays ?? null}, credit_days),
        currency = coalesce(${data.currency ?? null}, currency),
        fx_rate = coalesce(${data.fxRate ?? null}, fx_rate)
      where id = ${data.id} and company_id = ${companyId}
    `;
    if (cambios.length) {
      await writeAudit(sql, {
        companyId,
        userId: context.userId,
        action: "plazo-solicitud",
        entity: "request",
        entityId: data.id,
        name: before[0].name,
        detail: cambios.join(" · "),
      });
    }
    return { ok: true };
  });

export const createRequest = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      partnerId: z.number(),
      deliveryMode: z.enum(["campo", "bodega", "pickup"]),
      deliveryTo: z.string().optional().default(""),
      locationId: z.number().optional(),
      notes: z.string().optional().default(""),
      lines: z.array(z.object({ productId: z.number(), qty: z.number().positive(), uom: z.string() })).min(1),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await assertCan(sql, context.userId, "quotes", "edit");
    const companyId = await cid(sql, context.userId);
    await ensure(sql);
    const n = await sql<{ c: number }>`select count(*)::int as c from customer_requests where company_id = ${companyId}`;
    const name = `SOL-${String((n[0]?.c ?? 0) + 1).padStart(4, "0")}`;
    const row = await sql<{ id: number }>`
      insert into customer_requests (company_id, name, partner_id, date, delivery_mode, delivery_to, notes, state, location_id)
      values (${companyId}, ${name}, ${data.partnerId}, ${todayMx()}, ${data.deliveryMode}, ${data.deliveryTo ?? ""}, ${data.notes ?? ""}, 'open', ${data.locationId ?? null})
      returning id
    `;
    for (const line of data.lines) {
      await sql`
        insert into customer_request_lines (request_id, product_id, qty, uom)
        values (${row[0]!.id}, ${line.productId}, ${line.qty}, ${line.uom})
      `;
    }
    await rememberTrade(sql, {
      companyId,
      partnerId: data.partnerId,
      kind: "sell",
      products: data.lines.map((l) => ({ productId: l.productId })),
      locationId: data.locationId ?? null,
    });
    await writeAudit(sql, {
      companyId,
      userId: context.userId,
      action: "crear-solicitud",
      entity: "request",
      entityId: row[0]!.id,
      name,
      detail: `${data.lines.length} partidas · entrega ${data.deliveryMode}`,
    });
    return { id: row[0]!.id, name };
  });

export const updateRequest = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      id: z.number(),
      partnerId: z.number(),
      deliveryMode: z.enum(["campo", "bodega", "pickup"]),
      deliveryTo: z.string().optional().default(""),
      locationId: z.number().optional(),
      notes: z.string().optional().default(""),
      lines: z.array(z.object({ productId: z.number(), qty: z.number().positive(), uom: z.string() })).min(1),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await assertCan(sql, context.userId, "quotes", "edit");
    const companyId = await cid(sql, context.userId);
    await ensure(sql);
    const req = await sql<{ id: number; quote_id: number | null; rfq_id: number | null; state: string }>`
      select id, quote_id, rfq_id, state from customer_requests where id = ${data.id} and company_id = ${companyId}
    `;
    if (!req[0]) throw new Error("Solicitud no encontrada");
    if (req[0].quote_id) {
      throw new Error("Ya tiene cotización. Corrige la cotización, no la solicitud.");
    }
    await sql`
      update customer_requests
      set partner_id = ${data.partnerId}, delivery_mode = ${data.deliveryMode},
        delivery_to = ${data.deliveryTo ?? ""}, notes = ${data.notes ?? ""},
        location_id = ${data.locationId ?? null}
      where id = ${data.id} and company_id = ${companyId}
    `;
    await sql`delete from customer_request_lines where request_id = ${data.id}`;
    for (const line of data.lines) {
      await sql`
        insert into customer_request_lines (request_id, product_id, qty, uom)
        values (${data.id}, ${line.productId}, ${line.qty}, ${line.uom})
      `;
    }
    if (req[0].rfq_id) {
      await sql`delete from vendor_rfq_lines where rfq_id = ${req[0].rfq_id}`;
      for (const line of data.lines) {
        await sql`
          insert into vendor_rfq_lines (rfq_id, product_id, qty, uom)
          values (${req[0].rfq_id}, ${line.productId}, ${line.qty}, ${line.uom})
        `;
      }
    }
    await rememberTrade(sql, {
      companyId,
      partnerId: data.partnerId,
      kind: "sell",
      products: data.lines.map((l) => ({ productId: l.productId })),
      locationId: data.locationId ?? null,
    });
    await writeAudit(sql, {
      companyId,
      userId: context.userId,
      action: "editar-solicitud",
      entity: "request",
      entityId: data.id,
      detail: `${data.lines.length} partidas`,
    });
    return { id: data.id };
  });

export const deleteRequest = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ id: z.number() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await assertCan(sql, context.userId, "quotes", "edit");
    const companyId = await cid(sql, context.userId);
    await ensure(sql);
    const req = await sql<{ id: number; quote_id: number | null; rfq_id: number | null; name: string }>`
      select id, quote_id, rfq_id, name from customer_requests where id = ${data.id} and company_id = ${companyId}
    `;
    if (!req[0]) throw new Error("Solicitud no encontrada");
    if (req[0].quote_id) {
      throw new Error("Ya tiene cotización. No se borra; ábrela en Cotizaciones.");
    }
    // Es el único borrado duro del sistema: el contenido completo queda
    // escrito en la bitácora antes de desaparecer.
    const head = await sql<{ partner: string; delivery_mode: string; notes: string }>`
      select p.name as partner, r.delivery_mode, coalesce(r.notes,'') as notes
      from customer_requests r join partners p on p.id = r.partner_id
      where r.id = ${data.id}
    `;
    const contenido = await sql<{ code: string; qty: string; uom: string; cost: string; supplier: string | null; margin_pct: string }>`
      select p.code, l.qty::text, coalesce(l.uom, p.uom) as uom, coalesce(l.cost,0)::text as cost,
        s.name as supplier, coalesce(l.margin_pct,0)::text as margin_pct
      from customer_request_lines l
      join products p on p.id = l.product_id
      left join partners s on s.id = l.supplier_id
      where l.request_id = ${data.id}
      order by l.id
    `;
    if (req[0].rfq_id) {
      await sql`delete from vendor_rfqs where id = ${req[0].rfq_id} and company_id = ${companyId}`;
    }
    await sql`delete from customer_requests where id = ${data.id} and company_id = ${companyId}`;
    const partidas = contenido
      .map((l) => `${l.code} ×${Number(l.qty)} ${l.uom}${Number(l.cost) ? ` costo ${Number(l.cost)}` : ""}${l.supplier ? ` prov ${l.supplier}` : ""}${Number(l.margin_pct) ? ` margen ${Number(l.margin_pct)}%` : ""}`)
      .join(" · ");
    await writeAudit(sql, {
      companyId,
      userId: context.userId,
      action: "borrar-solicitud",
      entity: "request",
      entityId: data.id,
      name: req[0].name,
      detail: `${head[0]?.partner ?? ""} · entrega ${head[0]?.delivery_mode ?? ""}${head[0]?.notes ? ` · notas: ${head[0].notes}` : ""} · ${contenido.length} partidas: ${partidas}`.slice(0, 900),
    });
    return { ok: true, name: req[0].name };
  });

export const sendVendorRfq = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      requestId: z.number(),
      targets: z.array(z.object({ productId: z.number(), supplierId: z.number() })).min(1),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await assertCan(sql, context.userId, "purchases", "edit");
    const companyId = await cid(sql, context.userId);
    await ensure(sql);
    await assertRequestOpen(sql, companyId, data.requestId);
    const req = await sql<{ id: number; name: string; delivery_mode: string; delivery_to: string; rfq_id: number | null }>`
      select id, name, delivery_mode, delivery_to, rfq_id from customer_requests
      where id = ${data.requestId} and company_id = ${companyId}
    `;
    if (!req[0]) throw new Error("Solicitud no encontrada");
    const lines = await sql<{ product_id: number; qty: string; uom: string }>`
      select product_id, qty::text, uom from customer_request_lines where request_id = ${data.requestId}
    `;
    let rfqId = req[0].rfq_id;
    if (!rfqId) {
      const n = await sql<{ c: number }>`select count(*)::int as c from vendor_rfqs where company_id = ${companyId}`;
      const name = `SC-${String((n[0]?.c ?? 0) + 1).padStart(4, "0")}`;
      const mode = req[0].delivery_mode === "campo" ? "Puesta en campo" : req[0].delivery_mode === "pickup" ? "Recolección" : "En bodega";
      const notes = `${mode}${req[0].delivery_to ? ` · ${req[0].delivery_to}` : ""}`;
      const row = await sql<{ id: number }>`
        insert into vendor_rfqs (company_id, name, request_id, notes, state)
        values (${companyId}, ${name}, ${data.requestId}, ${notes}, 'open')
        returning id
      `;
      rfqId = row[0]!.id;
      for (const line of lines) {
        await sql`insert into vendor_rfq_lines (rfq_id, product_id, qty, uom) values (${rfqId}, ${line.product_id}, ${Number(line.qty)}, ${line.uom})`;
      }
      await sql`update customer_requests set rfq_id = ${rfqId}, state = 'rfq' where id = ${data.requestId}`;
    }
    await sql`delete from vendor_rfq_targets where rfq_id = ${rfqId}`;
    const invited = new Set<number>();
    for (const t of data.targets) {
      await sql`
        insert into vendor_rfq_targets (rfq_id, product_id, partner_id)
        values (${rfqId}, ${t.productId}, ${t.supplierId})
        on conflict do nothing
      `;
      invited.add(t.supplierId);
    }
    for (const sid of invited) {
      await sql`insert into vendor_rfq_suppliers (rfq_id, partner_id) values (${rfqId}, ${sid}) on conflict do nothing`;
    }
    const bySup = new Map<number, number[]>();
    for (const t of data.targets) {
      const list = bySup.get(t.supplierId) ?? [];
      list.push(t.productId);
      bySup.set(t.supplierId, list);
    }
    for (const [supplierId, productIds] of bySup) {
      await rememberTrade(sql, {
        companyId,
        partnerId: supplierId,
        kind: "buy",
        products: productIds.map((productId) => ({ productId })),
      });
    }
    return { rfqId, name: (await sql<{ name: string }>`select name from vendor_rfqs where id = ${rfqId}`)[0]!.name };
  });

export const pickVendor = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ requestId: z.number(), productId: z.number(), supplierId: z.number(), unitPrice: z.number() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await assertCan(sql, context.userId, "purchases", "edit");
    const companyId = await cid(sql, context.userId);
    await assertRequestOpen(sql, companyId, data.requestId);
    const before = await sql<{ cost: string; supplier_id: number | null; name: string; code: string }>`
      select l.cost::text, l.supplier_id, r.name, p.code
      from customer_request_lines l
      join customer_requests r on r.id = l.request_id
      join products p on p.id = l.product_id
      where l.request_id = ${data.requestId} and l.product_id = ${data.productId} and r.company_id = ${companyId}
    `;
    await sql`
      update customer_request_lines set cost = ${data.unitPrice}, supplier_id = ${data.supplierId}
      where request_id = ${data.requestId} and product_id = ${data.productId}
        and request_id in (select id from customer_requests where company_id = ${companyId})
    `;
    await rememberTrade(sql, {
      companyId,
      partnerId: data.supplierId,
      kind: "buy",
      products: [{ productId: data.productId, unitPrice: data.unitPrice }],
    });
    if (before[0]) {
      await writeAudit(sql, {
        companyId,
        userId: context.userId,
        action: "elegir-proveedor",
        entity: "request",
        entityId: data.requestId,
        name: before[0].name,
        detail: `${before[0].code}: proveedor ${before[0].supplier_id ?? "—"} → ${data.supplierId} · costo ${Number(before[0].cost)} → ${data.unitPrice}`,
      });
    }
    return { ok: true };
  });

/**
 * Margen de UNA columna (contado o crédito) de una partida. Son
 * independientes: guardar el de contado no toca el de crédito ni al revés.
 * Se llama al salir del campo (onCommit), nunca por tecla; bitácora solo si
 * cambió, con "margen contado" / "margen crédito" y anterior → nuevo.
 */
export const saveLineMargin = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      requestId: z.number(),
      productId: z.number(),
      which: z.enum(["cash", "credit"]),
      marginMode: z.enum(["pct", "nominal"]),
      marginPct: z.number(),
      marginNominal: z.number(),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    const me = await activeMember(sql, context.userId);
    if (me.acl.quotes !== "edit" || !canSeeMargins(me.role)) {
      throw new Error("Sin permiso para cambiar márgenes");
    }
    await ensure(sql);
    await assertRequestOpen(sql, companyId, data.requestId);
    const before = await sql<{
      margin_mode: string | null;
      margin_pct: string | null;
      margin_nominal: string | null;
      margin_cash_mode: string | null;
      margin_cash_pct: string | null;
      margin_cash_nominal: string | null;
      margin_credit_mode: string | null;
      margin_credit_pct: string | null;
      margin_credit_nominal: string | null;
      name: string;
      code: string;
    }>`
      select l.margin_mode, l.margin_pct::text as margin_pct,
        l.margin_nominal::text as margin_nominal,
        l.margin_cash_mode, l.margin_cash_pct::text as margin_cash_pct, l.margin_cash_nominal::text as margin_cash_nominal,
        l.margin_credit_mode, l.margin_credit_pct::text as margin_credit_pct, l.margin_credit_nominal::text as margin_credit_nominal,
        r.name, p.code
      from customer_request_lines l
      join customer_requests r on r.id = l.request_id
      join products p on p.id = l.product_id
      where l.request_id = ${data.requestId} and l.product_id = ${data.productId} and r.company_id = ${companyId}
    `;
    if (!before[0]) throw new Error("Partida no encontrada");
    const nuevoSpec = { mode: data.marginMode, pct: data.marginPct, nominal: data.marginNominal };
    // Lo capturó una persona: queda marcado 'captura' para distinguirlo del
    // margen que copió la migración 0018.
    if (data.which === "cash") {
      await sql`
        update customer_request_lines
        set margin_cash_mode = ${data.marginMode}, margin_cash_pct = ${data.marginPct}, margin_cash_nominal = ${data.marginNominal},
            margin_cash_source = 'captura'
        where request_id = ${data.requestId} and product_id = ${data.productId}
      `;
    } else {
      await sql`
        update customer_request_lines
        set margin_credit_mode = ${data.marginMode}, margin_credit_pct = ${data.marginPct}, margin_credit_nominal = ${data.marginNominal},
            margin_credit_source = 'captura'
        where request_id = ${data.requestId} and product_id = ${data.productId}
      `;
    }
    const old = marginText(marginOf(before[0], data.which));
    const nuevo = marginText(nuevoSpec);
    const etiqueta = OFFER_LABEL[data.which];
    if (old !== nuevo) {
      await writeAudit(sql, {
        companyId,
        userId: context.userId,
        action: "margen",
        entity: "request",
        entityId: data.requestId,
        name: before[0].name,
        detail: `${before[0].code}: margen ${etiqueta} ${old} → ${nuevo}`,
      });
    }
    return { ok: true };
  });

export const applyCheapest = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ requestId: z.number() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await assertCan(sql, context.userId, "purchases", "edit");
    const companyId = await cid(sql, context.userId);
    await assertRequestOpen(sql, companyId, data.requestId);
    const req = await sql<{ rfq_id: number | null }>`
      select rfq_id from customer_requests where id = ${data.requestId} and company_id = ${companyId}
    `;
    if (!req[0]?.rfq_id) throw new Error("Primero arma la lista a proveedores");
    const bids = await sql<{ product_id: number; partner_id: number; unit_price: string }>`
      select product_id, partner_id, unit_price::text from vendor_rfq_bids
      where rfq_id = ${req[0].rfq_id} and unit_price > 0
    `;
    const best = new Map<number, { partner_id: number; unit_price: number }>();
    for (const b of bids) {
      const price = Number(b.unit_price);
      const cur = best.get(b.product_id);
      if (!cur || price < cur.unit_price) best.set(b.product_id, { partner_id: b.partner_id, unit_price: price });
    }
    for (const [productId, w] of best) {
      await sql`
        update customer_request_lines
        set cost = ${w.unit_price}, supplier_id = ${w.partner_id}, pick_reason = 'precio'
        where request_id = ${data.requestId} and product_id = ${productId}
      `;
    }
    if (best.size > 0) {
      await writeAudit(sql, {
        companyId,
        userId: context.userId,
        action: "elegir-proveedor",
        entity: "request",
        entityId: data.requestId,
        detail: `Automático (más barato): ${best.size} partidas asignadas al mejor postor del RFQ`,
      });
    }
    return { ok: true, n: best.size };
  });

export const saveLineFreight = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ requestId: z.number(), productId: z.number(), freight: z.number().nonnegative() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    await assertCan(sql, context.userId, "purchases", "edit");
    await assertRequestOpen(sql, companyId, data.requestId);
    await sql`
      update customer_request_lines set freight = ${data.freight}
      where request_id = ${data.requestId} and product_id = ${data.productId}
        and request_id in (select id from customer_requests where company_id = ${companyId})
    `;
    return { ok: true };
  });

export const quoteFromRequest = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      requestId: z.number(),
      currency: z.enum(["MXN", "USD"]),
      fxRate: z.number().nonnegative(),
      tiie: z.number().nonnegative(),
      spread: z.number().nonnegative(),
      creditDays: z.number().int().nonnegative(),
      send: z.boolean().optional().default(true),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await assertCan(sql, context.userId, "quotes", "edit");
    const companyId = await cid(sql, context.userId);
    // Nunca se inventa un número: en dólares hace falta tipo de cambio y a
    // crédito hace falta la TIIE de la tabla (la pantalla la propone con fecha).
    if (data.currency === "USD" && !(data.fxRate > 0)) {
      throw new Error("Sin tipo de cambio: la tabla de tipo de cambio está vacía y no se capturó uno. Captúralo en Ajustes → Tipo de cambio antes de cotizar en dólares.");
    }
    if (data.creditDays > 0 && !(data.tiie > 0)) throw new Error(missingRateMessage(todayMx(), "cotización a crédito"));
    const req = await sql<{ id: number; name: string; partner_id: number; delivery_to: string; delivery_mode: string; quote_id: number | null }>`
      select id, name, partner_id, delivery_to, delivery_mode, quote_id from customer_requests
      where id = ${data.requestId} and company_id = ${companyId}
    `;
    if (!req[0]) throw new Error("Solicitud no encontrada");
    if (req[0].quote_id) {
      const ex = await sql<{ name: string }>`select name from quotes where id = ${req[0].quote_id}`;
      throw new Error(`Esta solicitud ya tiene ${ex[0]?.name ?? "una cotización"}. Ábrela en Cotizaciones; no se duplica.`);
    }
    await ensure(sql);
    const lines = await sql<{
      product_id: number;
      code: string;
      qty: string;
      uom: string;
      cost: string;
      freight: string;
      margin_mode: string | null;
      margin_pct: string | null;
      margin_nominal: string | null;
      margin_cash_mode: string | null;
      margin_cash_pct: string | null;
      margin_cash_nominal: string | null;
      margin_credit_mode: string | null;
      margin_credit_pct: string | null;
      margin_credit_nominal: string | null;
    }>`
      select l.product_id, p.code, l.qty::text, l.uom, l.cost::text, l.freight::text,
        l.margin_mode, l.margin_pct::text as margin_pct,
        l.margin_nominal::text as margin_nominal,
        l.margin_cash_mode, l.margin_cash_pct::text as margin_cash_pct, l.margin_cash_nominal::text as margin_cash_nominal,
        l.margin_credit_mode, l.margin_credit_pct::text as margin_credit_pct, l.margin_credit_nominal::text as margin_credit_nominal
      from customer_request_lines l join products p on p.id = l.product_id
      where l.request_id = ${data.requestId}
      order by l.id
    `;
    if (!lines.length) throw new Error("Sin partidas");
    // Sin margen no hay precio: el sistema no inventa uno. Se dice qué partida
    // y qué columna falta, y se cotiza cuando estén capturadas.
    const sinMargen = lines
      .flatMap((l) => {
        const falta: string[] = [];
        if (!marginOf(l, "cash")) falta.push(OFFER_LABEL.cash);
        if (data.creditDays > 0 && !marginOf(l, "credit")) falta.push(OFFER_LABEL.credit);
        return falta.length ? [`${l.code} (${falta.join(" y ")})`] : [];
      });
    if (sinMargen.length) {
      throw new Error(`Captura el margen antes de cotizar: ${sinMargen.join(", ")}.`);
    }
    // Dos precios, dos márgenes: contado = costo puesto + margen contado (sin
    // financiamiento); crédito = costo puesto + margen crédito + financiamiento
    // DENTRO del precio (comisión + Capa 1 con los días de este pedido, misma
    // fórmula de siempre). La comisión sale de Ajustes.
    const pol = await policy(sql, companyId);
    const priced = lines.map((l) => {
      // Ya se validó arriba: contado siempre tiene margen, y crédito lo tiene
      // siempre que la cotización lleve plazo. A 0 días no hay precio a crédito.
      const mCash = marginOf(l, "cash")!;
      const mCredit = marginOf(l, "credit");
      const cashCalc = priceSale({
        cost: Number(l.cost),
        freight: Number(l.freight),
        other: 0,
        days: 0,
        tiie: Math.max(0, data.tiie),
        costSpread: Math.max(0, data.spread),
        commissionRate: pol.asrCommission,
        marginMode: mCash.mode,
        marginPct: mCash.pct,
        marginNominal: mCash.nominal,
        qty: Number(l.qty),
      });
      const creditCalc = mCredit
        ? priceSale({
            cost: Number(l.cost),
            freight: Number(l.freight),
            other: 0,
            days: data.creditDays,
            tiie: Math.max(0, data.tiie),
            costSpread: Math.max(0, data.spread),
            commissionRate: pol.asrCommission,
            marginMode: mCredit.mode,
            marginPct: mCredit.pct,
            marginNominal: mCredit.nominal,
            qty: Number(l.qty),
          })
        : null;
      const cash = Number(cashCalc.priceUnit.toFixed(4));
      const credit = creditCalc ? Number(creditCalc.priceUnit.toFixed(4)) : 0;
      const unitPrice = data.creditDays > 0 ? credit : cash;
      const landed = cashCalc.landedUnit;
      return {
        productId: l.product_id,
        qty: Number(l.qty),
        uom: l.uom,
        cost: Number(l.cost),
        freight: Number(l.freight),
        cash,
        credit,
        unitPrice,
        // Los dos márgenes quedan escritos en la cotización con % y $ en
        // sincronía, y el financiamiento por unidad que quedó dentro del crédito.
        marginCash: normalizeMargin({ mode: mCash.mode, pct: mCash.pct, nominal: mCash.nominal }, landed),
        marginCredit: mCredit ? normalizeMargin({ mode: mCredit.mode, pct: mCredit.pct, nominal: mCredit.nominal }, landed) : null,
        financeUnit: creditCalc ? Number(creditCalc.financeUnit.toFixed(4)) : 0,
      };
    });
    const total = priced.reduce((s, l) => s + l.qty * l.unitPrice, 0);
    const n = await sql<{ c: number }>`select count(*)::int as c from quotes where company_id = ${companyId}`;
    const name = `COT-${String((n[0]?.c ?? 0) + 1).padStart(4, "0")}`;
    const today = todayMx();
    const until = addDays(today, 15);
    const mode = req[0].delivery_mode === "campo" ? "Puesta en campo" : req[0].delivery_mode === "pickup" ? "Recolección del cliente" : "Entrega en bodega";
    const notes = `${mode}${req[0].delivery_to ? ` · ${req[0].delivery_to}` : ""}${data.creditDays ? ` · contado y crédito ${data.creditDays} d` : " · contado"}`;
    const offer = data.creditDays > 0 ? "both" : "cash";
    await sql`alter table quotes add column if not exists owner_id text`;
    await sql`alter table quotes add column if not exists tiie numeric(8,6) not null default 0`;
    await sql`alter table quotes add column if not exists spread numeric(8,6) not null default 0`;
    await sql`alter table quotes add column if not exists credit_days integer not null default 0`;
    await sql`alter table quotes add column if not exists price_offer text not null default 'both'`;
    await sql`alter table quote_lines add column if not exists cost numeric(14,4) not null default 0`;
    await sql`alter table quote_lines add column if not exists freight numeric(14,4) not null default 0`;
    await sql`alter table quote_lines add column if not exists cash_price numeric(14,4) not null default 0`;
    await sql`alter table quote_lines add column if not exists credit_price numeric(14,4) not null default 0`;
    await sql`alter table quotes add column if not exists request_id integer`;
    const q = await sql<{ id: number }>`
      insert into quotes (company_id, name, partner_id, date, valid_until, currency, fx_rate, state, notes, delivery_to, total, owner_id, tiie, spread, credit_days, price_offer, request_id)
      values (${companyId}, ${name}, ${req[0].partner_id}, ${today}, ${until}, ${data.currency}, ${data.fxRate},
        ${data.send ? "sent" : "draft"}, ${notes}, ${req[0].delivery_to}, ${total}, ${context.userId}, ${data.tiie}, ${data.spread}, ${data.creditDays}, ${offer}, ${data.requestId})
      returning id
    `;
    for (const line of priced) {
      await sql`
        insert into quote_lines (quote_id, product_id, qty, unit_price, uom, cost, freight, cash_price, credit_price,
          margin_cash_mode, margin_cash_pct, margin_cash_nominal, margin_cash_source,
          margin_credit_mode, margin_credit_pct, margin_credit_nominal, margin_credit_source, finance_unit)
        values (${q[0]!.id}, ${line.productId}, ${line.qty}, ${line.unitPrice}, ${line.uom}, ${line.cost}, ${line.freight}, ${line.cash}, ${line.credit},
          ${line.marginCash.mode}, ${line.marginCash.pct}, ${line.marginCash.nominal}, 'captura',
          ${line.marginCredit?.mode ?? null}, ${line.marginCredit?.pct ?? null}, ${line.marginCredit?.nominal ?? null},
          ${line.marginCredit ? "captura" : null}, ${line.financeUnit})
      `;
    }
    // La solicitud queda con el plazo/moneda/TC con que se cotizó y se
    // congela: de aquí en adelante los cambios se hacen en la cotización.
    await sql`
      update customer_requests
      set quote_id = ${q[0]!.id}, state = 'quoted',
        credit_days = ${data.creditDays}, currency = ${data.currency}, fx_rate = ${data.fxRate}
      where id = ${data.requestId}
    `;
    await writeAudit(sql, {
      companyId,
      userId: context.userId,
      action: "crear-cotizacion",
      entity: "quote",
      entityId: q[0]!.id,
      name,
      detail: `Desde ${req[0].name} · ${priced.length} partidas · ${data.creditDays > 0 ? `contado y crédito ${data.creditDays} d` : "solo contado"} · total ${total.toFixed(2)} ${data.currency}`,
    });
    return { id: q[0]!.id, name };
  });

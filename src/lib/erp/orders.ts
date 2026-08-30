import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { assertCan, canSeeMargins } from "@/lib/erp/acl";
import { writeAudit } from "@/lib/erp/audit";
import { computeDues } from "@/lib/erp/order-terms";
import { computeDealPnl } from "@/lib/erp/reports";
import { assertDueOk, validateDueDates } from "@/lib/erp/credit";
import { rememberTrade } from "@/lib/erp/links";

type Sql = Awaited<ReturnType<typeof getSql>>;

async function cid(sql: Sql, userId: string) {
  const rows = await sql<{ company_id: number }>`select company_id from members where user_id = ${userId} and status = 'active' limit 1`;
  if (!rows[0]) throw new Error("Sin empresa");
  return rows[0].company_id;
}

async function nextOrderName(sql: Sql, companyId: number) {
  const n = await sql<{ c: number }>`select count(*)::int as c from sales_orders where company_id = ${companyId}`;
  return `PV-${String((n[0]?.c ?? 0) + 1).padStart(4, "0")}`;
}

const orderSchema = z.object({
  id: z.number().optional(),
  name: z.string().optional().default(""),
  partnerId: z.number(),
  date: z.string(),
  confirm: z.boolean().optional().default(false),
  overrideCredit: z.boolean().optional().default(false),
  locationId: z.number(),
  notes: z.string().optional().default(""),
  currency: z.enum(["MXN", "USD"]),
  fxRate: z.number(),
  deliveryTo: z.string().optional().default(""),
  termKind: z.enum(["contado", "credit_days", "date", "harvest"]),
  invoiceDays: z.number(),
  creditDays: z.number(),
  invoiceDue: z.string().optional().default(""),
  creditDue: z.string().optional().default(""),
  routeKind: z.enum(["own", "supplier", "asr"]),
  asrPartnerId: z.number().nullable().optional(),
  policyCode: z.string(),
  ocCliente: z.string().optional().default(""),
  priceMode: z.enum(["cash", "financed", "custom"]),
  lines: z.array(z.object({ productId: z.number(), qty: z.number().positive(), unitPrice: z.number().nonnegative(), uom: z.string().optional().default("") })).min(1),
});

export const orderLookups = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    await assertCan(sql, context.userId, "sales", "view");
    const customers = await sql<{
      id: number;
      code: string;
      name: string;
      group_name: string;
      payment_days: number;
      credit_limit: string;
    }>`
      select id, code, name, group_name, payment_days, credit_limit::text
      from partners where company_id = ${companyId} and is_customer = true order by name
    `;
    const asr = await sql<{ id: number; name: string }>`
      select id, name from partners
      where company_id = ${companyId} and (partner_kind = 'finance' or code = 'ASR' or name ilike '%santa rosa%')
      order by name
    `;
    const products = await sql<{ id: number; code: string; name: string; uom: string; list_price: string; product_type: string }>`
      select id, code, name, uom, list_price::text, product_type from products where company_id = ${companyId} order by code
    `;
    const locations = await sql<{ id: number; name: string; loc_type: string }>`
      select id, name, loc_type from locations where company_id = ${companyId} order by name
    `;
    const policies = await sql<{ code: string; name: string }>`
      select code, name from credit_policies where company_id = ${companyId} order by code
    `;
    const fx = await sql<{ usd_mxn: string }>`
      select usd_mxn::text from fx_rates where company_id = ${companyId} order by date desc limit 1
    `;
    return {
      customers,
      asr,
      products,
      locations,
      policies,
      fxRate: Number(fx[0]?.usd_mxn ?? 18),
      nextName: await nextOrderName(sql, companyId),
    };
  });

export const listOrders = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    await assertCan(sql, context.userId, "sales", "view");
    return sql<{
      id: number;
      name: string;
      date: string;
      partner: string;
      group_name: string;
      state: string;
      total: string;
      currency: string;
      oc_cliente: string;
      term_kind: string;
      invoice_days: number;
      credit_days: number;
      route_kind: string;
    }>`
      select so.id, so.name, so.date::text, pt.name as partner, pt.group_name, so.state,
        so.total::text, so.currency, so.oc_cliente, so.term_kind, so.invoice_days, so.credit_days, so.route_kind
      from sales_orders so
      join partners pt on pt.id = so.partner_id
      where so.company_id = ${companyId}
      order by so.id desc
    `;
  });

export const getOrder = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ id: z.number() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    await assertCan(sql, context.userId, "sales", "view");
    await sql`alter table sales_orders add column if not exists fletero text not null default ''`;
    await sql`alter table sales_orders add column if not exists placas text not null default ''`;
    await sql`alter table sales_orders add column if not exists chofer text not null default ''`;
    await sql`alter table sales_orders add column if not exists vehicle_brand text not null default ''`;
    await sql`alter table sales_orders add column if not exists ship_mode text not null default 'azagro'`;
    await sql`alter table sales_orders add column if not exists received_at date`;
    await sql`alter table sales_orders add column if not exists guia_sign text not null default ''`;
    await sql`alter table sales_orders add column if not exists guia_sign_name text not null default ''`;
    await sql`alter table sales_orders add column if not exists guia_sign_at timestamptz`;
    await sql`alter table sales_orders add column if not exists guia_obs text not null default ''`;
    await sql`alter table purchase_orders add column if not exists so_id integer`;
    await sql`alter table purchase_orders add column if not exists fulfill_kind text not null default 'inventory'`;
    await sql`alter table sales_lines add column if not exists qty_returned numeric(14,3) not null default 0`;
    const rows = await sql<{
      id: number;
      name: string;
      partner_id: number;
      date: string;
      state: string;
      location_id: number;
      notes: string;
      total: string;
      currency: string;
      fx_rate: string;
      delivery_to: string;
      term_kind: string;
      invoice_days: number;
      credit_days: number;
      invoice_due: string | null;
      credit_due: string | null;
      route_kind: string;
      asr_partner_id: number | null;
      policy_code: string;
      oc_cliente: string;
      price_mode: string;
      fletero: string;
      placas: string;
      chofer: string;
      vehicle_brand: string;
      ship_mode: string;
      received_at: string | null;
      guia_sign: string;
      guia_sign_name: string;
      guia_obs: string;
    }>`
      select id, name, partner_id, date::text, state, location_id, notes, total::text, currency, fx_rate::text,
        delivery_to, term_kind, invoice_days, credit_days, invoice_due::text, credit_due::text,
        route_kind, asr_partner_id, policy_code, oc_cliente, price_mode,
        coalesce(fletero,'') as fletero, coalesce(placas,'') as placas,
        coalesce(chofer,'') as chofer, coalesce(vehicle_brand,'') as vehicle_brand,
        coalesce(ship_mode,'azagro') as ship_mode,
        received_at::text,
        coalesce(guia_sign,'') as guia_sign,
        coalesce(guia_sign_name,'') as guia_sign_name,
        coalesce(guia_obs,'') as guia_obs
      from sales_orders where id = ${data.id} and company_id = ${companyId}
    `;
    if (!rows[0]) throw new Error("Pedido no encontrado");
    const loc = await sql<{ name: string }>`
      select name from locations where id = ${rows[0].location_id} and company_id = ${companyId}
    `;
    const lines = await sql<{
      id: number;
      product_id: number;
      qty: string;
      qty_delivered: string;
      qty_returned: string;
      unit_price: string;
      uom: string;
      code: string;
      name: string;
    }>`
      select sl.id, sl.product_id, sl.qty::text, coalesce(sl.qty_delivered,0)::text as qty_delivered,
        coalesce(sl.qty_returned,0)::text as qty_returned, sl.unit_price::text, sl.uom, p.code, p.name
      from sales_lines sl
      join products p on p.id = sl.product_id
      where sl.so_id = ${data.id}
      order by sl.id
    `;
    const invoices = await sql<{ id: number; name: string; due_date: string; residual: string; state: string }>`
      select id, name, due_date::text, residual::text, state
      from invoices where company_id = ${companyId} and order_id = ${data.id}
      order by id
    `;
    const purchases = await sql<{
      id: number;
      name: string;
      partner: string;
      state: string;
      total: string;
      fulfill_kind: string;
    }>`
      select po.id, po.name, p.name as partner, po.state, po.total::text, coalesce(po.fulfill_kind,'inventory') as fulfill_kind
      from purchase_orders po
      join partners p on p.id = po.partner_id
      where po.company_id = ${companyId} and po.so_id = ${data.id}
      order by po.id
    `;
    return { order: { ...rows[0], location_name: loc[0]?.name ?? "" }, lines, invoices, purchases };
  });

export const saveOrder = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(orderSchema)
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    const member = await assertCan(sql, context.userId, "sales", "edit");

    const dues = computeDues(data);
    assertDueOk(
      validateDueDates({
        issue: data.date,
        due: dues.creditDue,
        invoiceDue: dues.invoiceDue,
        days: data.termKind === "credit_days" ? dues.creditDays : undefined,
        allowPast: true,
      }),
    );
    const total = data.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0);
    const asrId = data.routeKind === "asr" ? data.asrPartnerId ?? null : null;
    if (data.routeKind === "asr" && !asrId) throw new Error("El circuito ASR necesita la contraparte (Santa Rosa / ASR)");

    if (data.confirm && data.termKind !== "contado") {
      const partner = await sql<{ credit_limit: string }>`
        select credit_limit::text from partners where id = ${data.partnerId} and company_id = ${companyId}
      `;
      const ar = await sql<{ ar: string }>`
        select coalesce(sum(residual),0)::text as ar from invoices
        where partner_id = ${data.partnerId} and kind = 'customer' and state = 'open'
      `;
      const limit = Number(partner[0]?.credit_limit ?? 0);
      const used = Number(ar[0]?.ar ?? 0);
      if (limit > 0 && used + total > limit) {
        // Solo un administrador puede autorizar exceder el límite, y queda en bitácora.
        if (!(data.overrideCredit && member.role === "admin")) {
          throw new Error(
            `Supera el límite de crédito (${limit.toFixed(0)}). Saldo actual ${used.toFixed(0)}. Un administrador puede autorizar el exceso.`,
          );
        }
        await writeAudit(sql, {
          companyId,
          userId: context.userId,
          action: "autorizar-credito",
          entity: "partner",
          entityId: data.partnerId,
          detail: `Límite ${limit.toFixed(0)} · saldo ${used.toFixed(0)} · pedido ${total.toFixed(0)}`,
        });
      }
    }

    let id = data.id;
    let name = (data.name ?? "").trim().toUpperCase();
    const state = data.confirm ? "confirmed" : "draft";

    if (id) {
      const current = await sql<{ state: string; name: string }>`
        select state, name from sales_orders where id = ${id} and company_id = ${companyId}
      `;
      if (!current[0]) throw new Error("Pedido no encontrado");
      if (current[0].state !== "draft" && current[0].state !== "confirmed") {
        throw new Error("Este pedido ya no se puede editar");
      }
      if (current[0].state === "confirmed" && !data.confirm) {
        throw new Error("Pedido confirmado: no vuelve a borrador");
      }
      if (!name) name = current[0].name;
      await sql`
        update sales_orders set
          name = ${name},
          partner_id = ${data.partnerId},
          date = ${data.date},
          location_id = ${data.locationId},
          notes = ${data.notes ?? ""},
          total = ${total},
          currency = ${data.currency},
          fx_rate = ${data.fxRate},
          delivery_to = ${data.deliveryTo ?? ""},
          term_kind = ${data.termKind},
          invoice_days = ${dues.invoiceDays},
          credit_days = ${dues.creditDays},
          invoice_due = ${dues.invoiceDue},
          credit_due = ${dues.creditDue},
          route_kind = ${data.routeKind},
          asr_partner_id = ${asrId},
          policy_code = ${data.policyCode},
          oc_cliente = ${data.ocCliente ?? ""},
          price_mode = ${data.priceMode},
          state = ${data.confirm ? "confirmed" : current[0].state}
        where id = ${id} and company_id = ${companyId}
      `;
      await sql`delete from sales_lines where so_id = ${id}`;
    } else {
      if (!name) name = await nextOrderName(sql, companyId);
      const row = await sql<{ id: number }>`
        insert into sales_orders (
          company_id, name, partner_id, date, state, location_id, notes, total,
          currency, fx_rate, delivery_to, owner_id,
          term_kind, invoice_days, credit_days, invoice_due, credit_due,
          route_kind, asr_partner_id, policy_code, oc_cliente, price_mode
        )
        values (
          ${companyId}, ${name}, ${data.partnerId}, ${data.date}, ${state}, ${data.locationId},
          ${data.notes ?? ""}, ${total}, ${data.currency}, ${data.fxRate}, ${data.deliveryTo ?? ""},
          ${context.userId}, ${data.termKind}, ${dues.invoiceDays}, ${dues.creditDays},
          ${dues.invoiceDue}, ${dues.creditDue}, ${data.routeKind}, ${asrId}, ${data.policyCode},
          ${data.ocCliente ?? ""}, ${data.priceMode}
        )
        returning id
      `;
      id = row[0]!.id;
    }

    for (const line of data.lines) {
      await sql`
        insert into sales_lines (so_id, product_id, qty, unit_price, uom)
        values (${id}, ${line.productId}, ${line.qty}, ${line.unitPrice}, ${line.uom ?? ""})
      `;
    }
    await rememberTrade(sql, {
      companyId,
      partnerId: data.partnerId,
      kind: "sell",
      products: data.lines.map((l) => ({ productId: l.productId, unitPrice: l.unitPrice })),
      locationId: data.locationId,
    });
    return { id, name, state: data.confirm ? "confirmed" : "draft" };
  });

export const nextOrderCode = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    await assertCan(sql, context.userId, "sales", "view");
    return { code: await nextOrderName(sql, companyId) };
  });

export const getDealPnl = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ soId: z.number() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    // La utilidad del expediente (costo vs venta) es información de márgenes.
    const me = await assertCan(sql, context.userId, "sales", "view");
    if (!canSeeMargins(me.role)) throw new Error("Sin permiso para ver márgenes");
    return computeDealPnl(sql, companyId, data.soId);
  });

export const saveGuia = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      soId: z.number(),
      fletero: z.string().optional().default(""),
      placas: z.string().optional().default(""),
      chofer: z.string().optional().default(""),
      vehicleBrand: z.string().optional().default(""),
      shipMode: z.enum(["campo", "pickup", "azagro", "proveedor"]),
      signature: z.string().optional().default(""),
      signedName: z.string().optional().default(""),
      observaciones: z.string().optional().default(""),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    await assertCan(sql, context.userId, "sales", "edit");
    await sql`alter table sales_orders add column if not exists fletero text not null default ''`;
    await sql`alter table sales_orders add column if not exists placas text not null default ''`;
    await sql`alter table sales_orders add column if not exists chofer text not null default ''`;
    await sql`alter table sales_orders add column if not exists vehicle_brand text not null default ''`;
    await sql`alter table sales_orders add column if not exists ship_mode text not null default 'azagro'`;
    await sql`alter table sales_orders add column if not exists guia_sign text not null default ''`;
    await sql`alter table sales_orders add column if not exists guia_sign_name text not null default ''`;
    await sql`alter table sales_orders add column if not exists guia_sign_at timestamptz`;
    await sql`alter table sales_orders add column if not exists guia_obs text not null default ''`;
    const sign = (data.signature ?? "").slice(0, 400_000);
    await sql`
      update sales_orders
      set fletero = ${data.fletero ?? ""}, placas = ${data.placas ?? ""},
          chofer = ${data.chofer ?? ""}, vehicle_brand = ${data.vehicleBrand ?? ""},
          ship_mode = ${data.shipMode},
          guia_sign = ${sign},
          guia_sign_name = ${data.signedName ?? ""},
          guia_sign_at = ${sign ? new Date().toISOString() : null},
          guia_obs = ${data.observaciones ?? ""}
      where id = ${data.soId} and company_id = ${companyId}
    `;
    return { ok: true };
  });

export const markReceived = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ soId: z.number() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    await assertCan(sql, context.userId, "sales", "edit");
    await sql`alter table sales_orders add column if not exists received_at date`;
    const so = await sql<{ state: string }>`
      select state from sales_orders where id = ${data.soId} and company_id = ${companyId}
    `;
    if (!so[0]) throw new Error("Pedido no encontrado");
    if (so[0].state !== "done") throw new Error("Primero entrega y factura. Luego se marca recibido en destino.");
    await sql`
      update sales_orders set received_at = current_date
      where id = ${data.soId} and company_id = ${companyId}
    `;
    return { ok: true };
  });

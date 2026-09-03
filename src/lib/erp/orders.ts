import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { activeMember, assertCan, canSeeCosts, canSeeMargins } from "@/lib/erp/acl";
import { writeAudit } from "@/lib/erp/audit";
import { todayMx } from "@/lib/utils";
import { computeDues } from "@/lib/erp/order-terms";
import { computeDealPnl } from "@/lib/erp/reports";
import { assertDueOk, validateDueDates } from "@/lib/erp/credit";
import { rememberTrade } from "@/lib/erp/links";
import { policy } from "@/lib/erp/ops";
import { financeUnit } from "@/lib/erp/pricing";
import { marginOf, priceFromMargin, type Offer } from "@/lib/erp/margins";

type Sql = Awaited<ReturnType<typeof getSql>>;

/** Columnas de la migración 0017 que el pedido lee de su cotización de origen (bases anteriores). */
async function ensureQuoteOrigin(sql: Sql) {
  for (const col of ["cash", "credit"]) {
    await sql.query(`alter table quote_lines add column if not exists margin_${col}_mode text`);
    await sql.query(`alter table quote_lines add column if not exists margin_${col}_pct numeric(8,4)`);
    await sql.query(`alter table quote_lines add column if not exists margin_${col}_nominal numeric(14,4)`);
    await sql.query(`alter table quote_lines add column if not exists margin_${col}_source text`);
  }
  await sql`alter table quote_lines add column if not exists finance_unit numeric(14,4)`;
  await sql`alter table quote_lines add column if not exists cost numeric(14,4) not null default 0`;
  await sql`alter table quote_lines add column if not exists freight numeric(14,4) not null default 0`;
  await sql`alter table quote_lines add column if not exists cash_price numeric(14,4) not null default 0`;
  await sql`alter table quote_lines add column if not exists credit_price numeric(14,4) not null default 0`;
  await sql`alter table quotes add column if not exists accepted_offer text`;
  await sql`alter table sales_orders add column if not exists accepted_offer text`;
}

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
  fxRate: z.number().nonnegative(),
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
    // Tipo de cambio propuesto: el renglón más reciente de la tabla, con su
    // fecha, para que la pantalla diga de cuándo es. Tabla vacía = null y un
    // pedido en dólares no se guarda hasta capturar uno.
    const fx = await sql<{ usd_mxn: string; date: string }>`
      select usd_mxn::text, date::text from fx_rates where company_id = ${companyId} order by date desc limit 1
    `;
    // Plazos de Ajustes (factura / crédito): si faltan, policy() se detiene
    // con "Ajustes incompletos".
    const pol = await policy(sql, companyId);
    return {
      customers,
      asr,
      products,
      locations,
      policies,
      fx: fx[0] ? { rate: Number(fx[0].usd_mxn), date: fx[0].date } : null,
      terms: { invoiceDays: pol.invoiceDays, creditDays: pol.creditDays },
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
    await ensureQuoteOrigin(sql);
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
      quote_id: number | null;
      accepted_offer: string | null;
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
        coalesce(guia_obs,'') as guia_obs,
        quote_id, accepted_offer
      from sales_orders where id = ${data.id} and company_id = ${companyId}
    `;
    if (!rows[0]) throw new Error("Pedido no encontrado");
    const quoteId = rows[0].quote_id ?? 0;
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
    // Origen del pedido: si vino de una cotización, el plazo, la oferta aceptada
    // y (por partida) costo, margen y financiamiento se leen de ahí. No se
    // copian a sales_lines: guardar el pedido las vuelve a insertar y se
    // perderían; la cotización es la fuente y sigue viva.
    const quote = await sql<{
      id: number;
      name: string;
      credit_days: number;
      price_offer: string;
      accepted_offer: string | null;
      tiie: string;
      spread: string;
      request_name: string | null;
    }>`
      select q.id, q.name, coalesce(q.credit_days,0)::int as credit_days, coalesce(q.price_offer,'both') as price_offer,
        q.accepted_offer, coalesce(q.tiie,0)::text as tiie, coalesce(q.spread,0)::text as spread,
        (select name from customer_requests r where r.quote_id = q.id limit 1) as request_name
      from quotes q where q.id = ${quoteId} and q.company_id = ${companyId}
    `;
    const quoteLines = quote[0]
      ? await sql<{
          product_id: number;
          cost: string;
          freight: string;
          cash_price: string;
          credit_price: string;
          finance_unit: string | null;
          margin_cash_mode: string | null;
          margin_cash_pct: string | null;
          margin_cash_nominal: string | null;
          margin_cash_source: string | null;
          margin_credit_mode: string | null;
          margin_credit_pct: string | null;
          margin_credit_nominal: string | null;
          margin_credit_source: string | null;
        }>`
          select ql.product_id, coalesce(ql.cost,0)::text as cost, coalesce(ql.freight,0)::text as freight,
            coalesce(nullif(ql.cash_price,0), ql.unit_price)::text as cash_price,
            coalesce(nullif(ql.credit_price,0), ql.unit_price)::text as credit_price,
            ql.finance_unit::text as finance_unit,
            ql.margin_cash_mode, ql.margin_cash_pct::text as margin_cash_pct, ql.margin_cash_nominal::text as margin_cash_nominal,
            ql.margin_cash_source,
            ql.margin_credit_mode, ql.margin_credit_pct::text as margin_credit_pct, ql.margin_credit_nominal::text as margin_credit_nominal,
            ql.margin_credit_source
          from quote_lines ql where ql.quote_id = ${quote[0].id}
        `
      : [];
    const me = await activeMember(sql, context.userId);
    const showCosts = canSeeCosts(me.role);
    const showMargins = canSeeMargins(me.role);
    const origin = quote[0]
      ? {
          quote_id: quote[0].id,
          quote_name: quote[0].name,
          request_name: quote[0].request_name,
          credit_days: quote[0].credit_days,
          price_offer: quote[0].price_offer,
          accepted_offer: rows[0].accepted_offer ?? quote[0].accepted_offer,
          tiie: Number(quote[0].tiie),
          spread: Number(quote[0].spread),
        }
      : null;
    const linesWithOrigin = lines.map((l) => {
      const ql = quoteLines.find((x) => x.product_id === l.product_id);
      if (!ql) return { ...l, origin: null };
      const which: Offer = origin?.accepted_offer === "cash" ? "cash" : "credit";
      const landed = Number(ql.cost) + Number(ql.freight);
      const m = marginOf(ql, which);
      return {
        ...l,
        origin: {
          which,
          landed: showCosts ? landed : null,
          fin_unit: which === "credit" ? Number(ql.finance_unit ?? 0) : 0,
          quoted_price: Number(which === "cash" ? ql.cash_price : ql.credit_price),
          // Sin margen guardado va null y la pantalla dice "sin margen": no se
          // inventa uno. `source` distingue el capturado del que copió la 0018.
          margin: showMargins && m && !m.legacy ? { mode: m.mode, pct: m.pct, nominal: m.nominal, source: m.source } : null,
        },
      };
    });
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
    return { order: { ...rows[0], location_name: loc[0]?.name ?? "" }, lines: linesWithOrigin, invoices, purchases, origin };
  });

/**
 * Cambiar el plazo de un pedido que vino de cotización. Es una acción aparte
 * de "guardar" porque el precio a crédito se armó con el plazo de la
 * cotización: con otro plazo ese precio ya no corresponde. Aquí se rehace
 * partida por partida con la misma fórmula (costo puesto + margen crédito +
 * financiamiento a los días nuevos, con la TIIE y el spread de la cotización)
 * y todo queda en bitácora: plazo, precios y total, anterior → nuevo.
 * Solo en borrador: un pedido confirmado ya tiene compras y fechas encadenadas.
 */
export const changeOrderTerm = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ id: z.number(), creditDays: z.number().int().nonnegative() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    await assertCan(sql, context.userId, "sales", "edit");
    await ensureQuoteOrigin(sql);
    const so = await sql<{
      id: number;
      name: string;
      state: string;
      date: string;
      quote_id: number | null;
      credit_days: number;
      invoice_days: number;
      invoice_due: string | null;
      credit_due: string | null;
      total: string;
      accepted_offer: string | null;
    }>`
      select id, name, state, date::text, quote_id, coalesce(credit_days,0)::int as credit_days,
        coalesce(invoice_days,0)::int as invoice_days, invoice_due::text, credit_due::text, total::text, accepted_offer
      from sales_orders where id = ${data.id} and company_id = ${companyId}
    `;
    if (!so[0]) throw new Error("Pedido no encontrado");
    if (!so[0].quote_id) throw new Error("Este pedido no viene de una cotización: el plazo se cambia al guardar.");
    if (so[0].state !== "draft") throw new Error("Pedido confirmado: el plazo ya no se cambia. Si es un error, cancélalo y captura uno nuevo.");
    if (data.creditDays === so[0].credit_days) throw new Error("Sin cambios: el plazo es el mismo.");
    const q = await sql<{ name: string; tiie: string; spread: string; credit_days: number }>`
      select name, coalesce(tiie,0)::text as tiie, coalesce(spread,0)::text as spread, coalesce(credit_days,0)::int as credit_days
      from quotes where id = ${so[0].quote_id} and company_id = ${companyId}
    `;
    if (!q[0]) throw new Error("Cotización de origen no encontrada");
    const pol = await policy(sql, companyId);
    const lines = await sql<{
      id: number;
      product_id: number;
      code: string;
      qty: string;
      unit_price: string;
      cost: string;
      freight: string;
      cash_price: string;
      credit_price: string;
      margin_cash_mode: string | null;
      margin_cash_pct: string | null;
      margin_cash_nominal: string | null;
      margin_credit_mode: string | null;
      margin_credit_pct: string | null;
      margin_credit_nominal: string | null;
    }>`
      select sl.id, sl.product_id, p.code, sl.qty::text, sl.unit_price::text,
        coalesce(ql.cost,0)::text as cost, coalesce(ql.freight,0)::text as freight,
        coalesce(nullif(ql.cash_price,0), ql.unit_price)::text as cash_price,
        coalesce(nullif(ql.credit_price,0), ql.unit_price)::text as credit_price,
        ql.margin_cash_mode, ql.margin_cash_pct::text as margin_cash_pct, ql.margin_cash_nominal::text as margin_cash_nominal,
        ql.margin_credit_mode, ql.margin_credit_pct::text as margin_credit_pct, ql.margin_credit_nominal::text as margin_credit_nominal
      from sales_lines sl
      join products p on p.id = sl.product_id
      left join quote_lines ql on ql.quote_id = ${so[0].quote_id} and ql.product_id = sl.product_id
      where sl.so_id = ${so[0].id}
      order by sl.id
    `;
    const days = data.creditDays;
    const cambios: string[] = [`plazo ${so[0].credit_days} → ${days} d`];
    let total = 0;
    const nuevos: Array<{ id: number; price: number }> = [];
    for (const l of lines) {
      const landed = Number(l.cost) + Number(l.freight);
      const mCredit = marginOf(l, "credit");
      let price: number;
      if (days <= 0) {
        // De contado: precio de contado de la cotización (costo + margen contado).
        price = Number(l.cash_price);
      } else if (landed > 0.0001 && mCredit) {
        const fin = financeUnit({ cost: landed, days, tiie: Number(q[0].tiie), costSpread: Number(q[0].spread), commissionRate: pol.asrCommission });
        price = priceFromMargin({ landed, finance: fin, margin: mCredit });
      } else {
        // Sin costo o sin margen guardado no hay con qué rehacer el precio: se
        // conserva tal cual y se dice por qué en la bitácora. No se inventa un
        // margen para poder recalcular.
        price = Number(l.unit_price);
        cambios.push(`${l.code} ${landed > 0.0001 ? "sin margen" : "sin costo"}: precio sin recalcular`);
      }
      price = Math.round(price * 10000) / 10000;
      if (Math.abs(price - Number(l.unit_price)) > 0.009) cambios.push(`${l.code} precio ${Number(l.unit_price)} → ${price}`);
      nuevos.push({ id: l.id, price });
      total += Number(l.qty) * price;
    }
    const termKind = days > 0 ? "credit_days" : "contado";
    const invoiceDays = days > 0 ? Math.min(pol.invoiceDays, days) : 0;
    const dues = computeDues({ date: so[0].date, termKind, invoiceDays, creditDays: days });
    if (Math.abs(Number(so[0].total) - total) > 0.009) cambios.push(`total ${Number(so[0].total)} → ${Math.round(total * 100) / 100}`);
    if ((so[0].invoice_due ?? "") !== dues.invoiceDue) cambios.push(`vencimiento ${so[0].invoice_due ?? "—"} → ${dues.invoiceDue}`);
    if ((so[0].credit_due ?? "") !== dues.creditDue) cambios.push(`plazo financiero ${so[0].credit_due ?? "—"} → ${dues.creditDue}`);
    for (const n of nuevos) {
      await sql`update sales_lines set unit_price = ${n.price} where id = ${n.id}`;
    }
    await sql`
      update sales_orders set
        term_kind = ${termKind},
        invoice_days = ${dues.invoiceDays},
        credit_days = ${dues.creditDays},
        invoice_due = ${dues.invoiceDue},
        credit_due = ${dues.creditDue},
        price_mode = ${days > 0 ? "financed" : "cash"},
        total = ${total}
      where id = ${so[0].id} and company_id = ${companyId}
    `;
    await writeAudit(sql, {
      companyId,
      userId: context.userId,
      action: "cambiar-plazo-pedido",
      entity: "sale",
      entityId: so[0].id,
      name: so[0].name,
      detail: `Desde ${q[0].name} (${q[0].credit_days} d) · ${cambios.join(" · ")}`,
    });
    return { id: so[0].id, name: so[0].name, creditDays: days, total };
  });

export const saveOrder = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(orderSchema)
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    const member = await assertCan(sql, context.userId, "sales", "edit");

    // Un pedido en dólares necesita tipo de cambio real (tabla o capturado).
    if (data.currency === "USD" && !(data.fxRate > 0)) {
      throw new Error("Sin tipo de cambio: la tabla de tipo de cambio está vacía y no se capturó uno. Captúralo en Ajustes → Tipo de cambio antes de guardar un pedido en dólares.");
    }
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
          // El rechazo también deja rastro: quién intentó y con qué números.
          await writeAudit(sql, {
            companyId,
            userId: context.userId,
            action: "rechazado-credito",
            entity: "partner",
            entityId: data.partnerId,
            detail: `Límite ${limit.toFixed(0)} · saldo ${used.toFixed(0)} · pedido ${total.toFixed(0)}`,
          });
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

    let auditEdit: { detail: string; folio: string } | null = null;
    if (id) {
      const current = await sql<{
        state: string;
        name: string;
        partner_id: number;
        date: string;
        total: string;
        currency: string;
        fx_rate: string;
        credit_due: string | null;
        invoice_due: string | null;
        delivery_to: string;
      }>`
        select state, name, partner_id, date::text, total::text, currency, fx_rate::text,
          credit_due::text, invoice_due::text, coalesce(delivery_to,'') as delivery_to
        from sales_orders where id = ${id} and company_id = ${companyId}
      `;
      if (!current[0]) throw new Error("Pedido no encontrado");
      if (current[0].state !== "draft" && current[0].state !== "confirmed") {
        throw new Error("Este pedido ya no se puede editar");
      }
      if (current[0].state === "confirmed" && !data.confirm) {
        throw new Error("Pedido confirmado: no vuelve a borrador");
      }
      // Decisión de negocio: tras confirmar, cliente y moneda quedan fijos
      // (cambiarlos rompe la cadena con la cotización y el TC pactado).
      // Precios y fechas siguen editables, con rastro en bitácora.
      if (current[0].state === "confirmed") {
        if (current[0].partner_id !== data.partnerId) {
          throw new Error("Pedido confirmado: el cliente no se cambia. Si es un error, cancélalo y captura uno nuevo.");
        }
        if (current[0].currency !== data.currency) {
          throw new Error("Pedido confirmado: la moneda no se cambia. Si es un error, cancélalo y captura uno nuevo.");
        }
      }
      if (!name) name = current[0].name;
      // El pedido NO se congela, pero cada cambio queda con anterior → nuevo
      // (crítico para pedidos ya confirmados: nadie mueve precios sin rastro).
      const oldLines = await sql<{ product_id: number; code: string; qty: string; unit_price: string }>`
        select sl.product_id, p.code, sl.qty::text, sl.unit_price::text
        from sales_lines sl join products p on p.id = sl.product_id
        where sl.so_id = ${id}
      `;
      const cambios: string[] = [];
      if (current[0].partner_id !== data.partnerId) cambios.push(`cliente ${current[0].partner_id} → ${data.partnerId}`);
      if (current[0].date !== data.date) cambios.push(`fecha ${current[0].date} → ${data.date}`);
      if (Math.abs(Number(current[0].total) - total) > 0.009) cambios.push(`total ${Number(current[0].total)} → ${total}`);
      if (current[0].currency !== data.currency) cambios.push(`moneda ${current[0].currency} → ${data.currency}`);
      if (Number(current[0].fx_rate) !== data.fxRate) cambios.push(`TC ${Number(current[0].fx_rate)} → ${data.fxRate}`);
      if ((current[0].credit_due ?? "") !== dues.creditDue) cambios.push(`plazo financiero ${current[0].credit_due ?? "—"} → ${dues.creditDue}`);
      if ((current[0].invoice_due ?? "") !== dues.invoiceDue) cambios.push(`vencimiento ${current[0].invoice_due ?? "—"} → ${dues.invoiceDue}`);
      for (const nl of data.lines) {
        const ol = oldLines.find((o) => o.product_id === nl.productId);
        if (!ol) {
          cambios.push(`+ partida producto ${nl.productId} (${nl.qty} × ${nl.unitPrice})`);
          continue;
        }
        if (Number(ol.qty) !== nl.qty) cambios.push(`${ol.code} cant ${Number(ol.qty)} → ${nl.qty}`);
        if (Number(ol.unit_price) !== nl.unitPrice) cambios.push(`${ol.code} precio ${Number(ol.unit_price)} → ${nl.unitPrice}`);
      }
      for (const ol of oldLines) {
        if (!data.lines.some((nl) => nl.productId === ol.product_id)) cambios.push(`− partida ${ol.code}`);
      }
      const nextState = data.confirm ? "confirmed" : current[0].state;
      if (current[0].state !== nextState) cambios.push(`estado ${current[0].state} → ${nextState}`);
      if (cambios.length) {
        auditEdit = {
          folio: name,
          detail: `${current[0].state === "confirmed" ? "CONFIRMADO · " : ""}${cambios.join(" · ")}`,
        };
      }
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
    if (auditEdit) {
      await writeAudit(sql, {
        companyId,
        userId: context.userId,
        action: "editar-pedido",
        entity: "sale",
        entityId: id,
        name: auditEdit.folio,
        detail: auditEdit.detail,
      });
    } else if (!data.id) {
      await writeAudit(sql, {
        companyId,
        userId: context.userId,
        action: "crear-pedido",
        entity: "sale",
        entityId: id,
        name,
        detail: `Total ${total.toFixed(2)} ${data.currency} · ${data.lines.length} partidas${data.confirm ? " · confirmado" : ""}`,
      });
    }
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
      update sales_orders set received_at = ${todayMx()}::date
      where id = ${data.soId} and company_id = ${companyId}
    `;
    return { ok: true };
  });

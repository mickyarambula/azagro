import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { assertCan } from "@/lib/erp/acl";
import { DEFAULT_POLICY } from "@/lib/erp/credit";
import { YEAR_DAYS } from "@/lib/erp/rules";

type Sql = Awaited<ReturnType<typeof getSql>>;

async function cid(sql: Sql, userId: string) {
  const rows = await sql<{ company_id: number }>`select company_id from members where user_id = ${userId} limit 1`;
  if (!rows[0]) throw new Error("Sin empresa");
  return rows[0].company_id;
}

export async function computeDealPnl(sql: Sql, companyId: number, soId: number) {
  await sql`alter table purchase_orders add column if not exists so_id integer`;
  await sql`alter table sales_orders add column if not exists quote_id integer`;
  await sql`alter table company_settings add column if not exists finance_spread numeric(8,4) not null default 0.045`;
  await sql`alter table quote_lines add column if not exists cost numeric(14,4) not null default 0`;
  await sql`alter table quote_lines add column if not exists freight numeric(14,4) not null default 0`;
  await sql`alter table quote_lines add column if not exists other_cost numeric(14,4) not null default 0`;
  const so = await sql<{
    name: string;
    currency: string;
    credit_days: number;
    quote_id: number | null;
  }>`
    select name, currency, coalesce(credit_days,0)::int as credit_days, quote_id
    from sales_orders where id = ${soId} and company_id = ${companyId}
  `;
  if (!so[0]) throw new Error("Pedido no encontrado");
  const pol = await sql<{ finance_spread: string; default_tiie: string }>`
    select coalesce(finance_spread, 0.045)::text as finance_spread, coalesce(default_tiie, 0.0706)::text as default_tiie
    from company_settings where company_id = ${companyId}
  `;
  const financeRate = Number(pol[0]?.default_tiie ?? DEFAULT_POLICY.defaultTiie) + Number(pol[0]?.finance_spread ?? DEFAULT_POLICY.financeSpread);
  const days = so[0].credit_days;
  const raw = await sql<{
    product_id: number;
    code: string;
    name: string;
    qty: string;
    uom: string;
    unit_price: string;
    catalog_cost: string;
    po_cost: string | null;
    quote_cost: string | null;
    quote_freight: string;
    quote_other: string;
  }>`
    select sl.product_id, p.code, p.name, sl.qty::text, coalesce(sl.uom, p.uom) as uom, sl.unit_price::text,
      p.cost::text as catalog_cost,
      (
        select pl.unit_price::text from purchase_lines pl
        join purchase_orders po on po.id = pl.po_id
        where po.so_id = sl.so_id and pl.product_id = sl.product_id
        order by pl.id desc limit 1
      ) as po_cost,
      ql.cost::text as quote_cost,
      coalesce(ql.freight,0)::text as quote_freight,
      coalesce(ql.other_cost,0)::text as quote_other
    from sales_lines sl
    join products p on p.id = sl.product_id
    left join quote_lines ql on ql.quote_id = ${so[0].quote_id} and ql.product_id = sl.product_id
    where sl.so_id = ${soId}
    order by sl.id
  `;
  const lines = raw.map((l) => {
    const qty = Number(l.qty);
    const saleUnit = Number(l.unit_price);
    const poCost = l.po_cost != null ? Number(l.po_cost) : null;
    const quoteCost = l.quote_cost != null ? Number(l.quote_cost) : null;
    const catalog = Number(l.catalog_cost);
    const costUnit = poCost ?? quoteCost ?? catalog;
    const costSource = poCost != null ? "OC" : quoteCost != null ? "cotización" : "catálogo";
    const freightUnit = Number(l.quote_freight);
    const otherUnit = Number(l.quote_other);
    const sale = qty * saleUnit;
    const cogs = qty * costUnit;
    const freight = qty * freightUnit;
    const other = qty * otherUnit;
    const finance = days > 0 ? (cogs * financeRate * days) / YEAR_DAYS : 0;
    const margin = sale - cogs - freight - other;
    return {
      productId: l.product_id,
      code: l.code,
      name: l.name,
      qty,
      uom: l.uom,
      saleUnit,
      sale,
      costUnit,
      costSource,
      cogs,
      freightUnit,
      freight,
      other,
      finance,
      margin,
      marginPct: sale > 0 ? (margin / sale) * 100 : 0,
    };
  });
  let expenses: Array<{ id: number; name: string; class: string; amount: number }> = [];
  try {
    const exp = await sql<{ id: number; name: string; class: string; amount: string }>`
      select id, name, class, amount::text from expenses where company_id = ${companyId} and so_id = ${soId} order by id
    `;
    expenses = exp.map((e) => ({ id: e.id, name: e.name, class: e.class, amount: Number(e.amount) }));
  } catch {
    expenses = [];
  }
  const expPedido = expenses.filter((e) => e.class === "pedido").reduce((s, e) => s + e.amount, 0);
  const expOther = expenses.filter((e) => e.class !== "pedido").reduce((s, e) => s + e.amount, 0);
  let mora = 0;
  try {
    const mi = await sql<{ a: string }>`
      select coalesce(sum(amount),0)::text as a from invoices
      where company_id = ${companyId} and order_id = ${soId} and inv_class = 'interest'
    `;
    mora = Number(mi[0]?.a ?? 0);
  } catch {
    mora = 0;
  }
  const revenue = lines.reduce((s, l) => s + l.sale, 0);
  const cogs = lines.reduce((s, l) => s + l.cogs, 0);
  const freightQuote = lines.reduce((s, l) => s + l.freight, 0);
  const otherQuote = lines.reduce((s, l) => s + l.other, 0);
  const finance = lines.reduce((s, l) => s + l.finance, 0);
  const freight = freightQuote + expPedido;
  const margin = revenue - cogs - freight - otherQuote - expOther;
  return {
    name: so[0].name,
    currency: so[0].currency,
    creditDays: days,
    financeRate,
    lines,
    expenses,
    revenue,
    cogs,
    freight,
    freightQuote,
    expPedido,
    other: otherQuote + expOther,
    finance,
    margin,
    marginPct: revenue > 0 ? (margin / revenue) * 100 : 0,
    marginAfterFinance: margin - finance,
    mora,
  };
}

export const listDealPnl = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ from: z.string().optional(), to: z.string().optional() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await assertCan(sql, context.userId, "credit", "view");
    const companyId = await cid(sql, context.userId);
    const from = (data.from || "2000-01-01").slice(0, 10);
    const to = (data.to || "2099-12-31").slice(0, 10);
    await sql`alter table purchase_orders add column if not exists so_id integer`;
    const orders = await sql<{
      id: number;
      name: string;
      date: string;
      state: string;
      partner: string;
      currency: string;
    }>`
      select s.id, s.name, s.date::text, s.state, p.name as partner, s.currency
      from sales_orders s
      join partners p on p.id = s.partner_id
      where s.company_id = ${companyId} and s.date between ${from} and ${to}
      order by s.date desc, s.id desc
      limit 200
    `;
    const deals = [];
    for (const o of orders) {
      const d = await computeDealPnl(sql, companyId, o.id);
      deals.push({
        id: o.id,
        name: o.name,
        date: o.date,
        state: o.state,
        partner: o.partner,
        currency: o.currency,
        revenue: d.revenue,
        cogs: d.cogs,
        freight: d.freight,
        finance: d.finance,
        margin: d.margin,
        marginPct: d.marginPct,
      });
    }
    const totals = deals.reduce(
      (s, d) => ({
        revenue: s.revenue + d.revenue,
        cogs: s.cogs + d.cogs,
        freight: s.freight + d.freight,
        finance: s.finance + d.finance,
        margin: s.margin + d.margin,
      }),
      { revenue: 0, cogs: 0, freight: 0, finance: 0, margin: 0 },
    );
    return { from, to, deals, totals };
  });

export const getCompanyPnl = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ from: z.string(), to: z.string() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await assertCan(sql, context.userId, "credit", "view");
    const companyId = await cid(sql, context.userId);
    const from = data.from.slice(0, 10);
    const to = data.to.slice(0, 10);
    await sql`alter table invoices add column if not exists inv_class text not null default 'product'`;

    const sales = await sql<{ n: number; amount: string }>`
      select count(*)::int as n, coalesce(sum(amount),0)::text as amount
      from invoices
      where company_id = ${companyId} and kind = 'customer' and coalesce(inv_class,'product') = 'product'
        and date between ${from} and ${to}
    `;
    const mora = await sql<{ amount: string }>`
      select coalesce(sum(amount),0)::text as amount
      from invoices
      where company_id = ${companyId} and kind = 'customer' and inv_class = 'interest'
        and date between ${from} and ${to}
    `;
    const purchases = await sql<{ amount: string }>`
      select coalesce(sum(amount),0)::text as amount
      from invoices
      where company_id = ${companyId} and kind = 'supplier'
        and date between ${from} and ${to}
    `;
    let expOp = 0;
    let expPedido = 0;
    let expFin = 0;
    try {
      const exp = await sql<{ class: string; amount: string }>`
        select class, coalesce(sum(amount),0)::text as amount
        from expenses
        where company_id = ${companyId} and date between ${from} and ${to}
        group by class
      `;
      for (const r of exp) {
        if (r.class === "pedido") expPedido = Number(r.amount);
        else if (r.class === "financiero") expFin = Number(r.amount);
        else expOp = Number(r.amount);
      }
    } catch {
      /* empty */
    }
    const collections = await sql<{ amount: string }>`
      select coalesce(sum(amount),0)::text as amount
      from payments
      where company_id = ${companyId} and kind = 'inbound' and date between ${from} and ${to}
    `;
    const payouts = await sql<{ amount: string }>`
      select coalesce(sum(amount),0)::text as amount
      from payments
      where company_id = ${companyId} and kind = 'outbound' and date between ${from} and ${to}
    `;
    const revenue = Number(sales[0]?.amount ?? 0);
    const cogs = Number(purchases[0]?.amount ?? 0);
    const moraIn = Number(mora[0]?.amount ?? 0);
    const gross = revenue - cogs - expPedido;
    const operating = gross - expOp;
    const net = operating - expFin + moraIn;
    return {
      from,
      to,
      salesN: sales[0]?.n ?? 0,
      revenue,
      purchases: cogs,
      freight: expPedido,
      operativo: expOp,
      financiero: expFin,
      mora: moraIn,
      gross,
      operating,
      net,
      collected: Number(collections[0]?.amount ?? 0),
      paidOut: Number(payouts[0]?.amount ?? 0),
    };
  });

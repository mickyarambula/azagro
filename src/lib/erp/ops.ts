import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { computeMora, computeStatementLine, DEFAULT_POLICY, explainInterest, fxDifferential, nearestRate, splitDocName, splitFegaBundle, validateDueDates } from "@/lib/erp/credit";
import { computeDues } from "@/lib/erp/order-terms";
import { assertCan } from "@/lib/erp/acl";
import { dateDMY } from "@/lib/utils";
import { rememberTrade } from "@/lib/erp/links";
import { refreshInvoiceResidual } from "@/lib/erp/stock";

type Sql = Awaited<ReturnType<typeof getSql>>;

async function companyOf(sql: Sql, userId: string) {
  const rows = await sql<{ company_id: number }>`
    select company_id from members where user_id = ${userId} limit 1
  `;
  if (!rows[0]) throw new Error("Sin empresa");
  return rows[0].company_id;
}

async function policy(sql: Sql, companyId: number) {
  await sql`alter table company_settings add column if not exists finance_spread numeric(8,4) not null default 0.045`;
  await sql`alter table company_settings add column if not exists alert_days_cxc integer not null default 7`;
  await sql`alter table company_settings add column if not exists alert_days_cxp integer not null default 7`;
  await sql`alter table company_settings add column if not exists alert_email text not null default ''`;
  await sql`alter table company_settings add column if not exists alert_email_on boolean not null default true`;
  await sql`alter table company_settings add column if not exists resend_key text not null default ''`;
  const rows = await sql<{
    credit_days: number;
    invoice_days: number;
    fega_rate: string;
    collection_spread: string;
    finance_spread: string;
    default_tiie: string;
    legal_name: string;
    rfc: string;
    asr_commission: string;
    asr_spread: string;
    email_from: string;
    phone: string;
    alert_days_cxc: number;
    alert_days_cxp: number;
    alert_email: string;
    alert_email_on: boolean;
    resend_key: string;
  }>`
    select credit_days, invoice_days, fega_rate::text, collection_spread::text, finance_spread::text, default_tiie::text,
      legal_name, rfc, asr_commission::text, asr_spread::text, email_from, phone,
      coalesce(alert_days_cxc,7)::int as alert_days_cxc, coalesce(alert_days_cxp,7)::int as alert_days_cxp,
      coalesce(alert_email,'') as alert_email, coalesce(alert_email_on,true) as alert_email_on,
      coalesce(resend_key,'') as resend_key
    from company_settings where company_id = ${companyId}
  `;
  const r = rows[0];
  if (!r) {
    return {
      ...DEFAULT_POLICY,
      legalName: "AZ INSUMOS AGRICOLAS SA DE CV",
      rfc: "",
      asrCommission: 0.01,
      asrSpread: 0.04,
      emailFrom: "",
      phone: "",
      alertDaysCxc: 7,
      alertDaysCxp: 7,
      alertEmail: "",
      alertEmailOn: true,
      mailReady: false,
    };
  }
  return {
    creditDays: r.credit_days,
    invoiceDays: r.invoice_days,
    fegaRate: Number(r.fega_rate),
    commissionRate: DEFAULT_POLICY.commissionRate,
    collectionSpread: Number(r.collection_spread),
    financeSpread: Number(r.finance_spread || 0.045),
    defaultTiie: Number(r.default_tiie),
    legalName: r.legal_name,
    rfc: r.rfc,
    asrCommission: Number(r.asr_commission),
    asrSpread: Number(r.asr_spread),
    emailFrom: r.email_from,
    phone: r.phone,
    alertDaysCxc: r.alert_days_cxc,
    alertDaysCxp: r.alert_days_cxp,
    alertEmail: r.alert_email,
    alertEmailOn: r.alert_email_on,
    mailReady: Boolean(process.env.RESEND_API_KEY) || (r.resend_key || "").length > 8,
  };
}

export const getSettings = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    const p = await policy(sql, cid);
    const tiie = await sql<{ date: string; rate: string }>`
      select date::text, rate::text from tiie_rates where company_id = ${cid} order by date desc limit 24
    `;
    const fx = await sql<{ date: string; usd_mxn: string }>`
      select date::text, usd_mxn::text from fx_rates where company_id = ${cid} order by date desc limit 24
    `;
    return { ...p, tiie, fx };
  });

export const saveSettings = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      legalName: z.string(),
      rfc: z.string(),
      creditDays: z.number().int().positive(),
      invoiceDays: z.number().int().positive(),
      fegaRate: z.number(),
      collectionSpread: z.number(),
      financeSpread: z.number(),
      defaultTiie: z.number(),
      asrCommission: z.number(),
      asrSpread: z.number(),
      emailFrom: z.string(),
      phone: z.string(),
      alertDaysCxc: z.number().int().min(0).max(120).optional(),
      alertDaysCxp: z.number().int().min(0).max(120).optional(),
      alertEmail: z.string().optional(),
      alertEmailOn: z.boolean().optional(),
      resendKey: z.string().optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    await assertCan(sql, context.userId, "settings", "edit");
    await sql`alter table company_settings add column if not exists finance_spread numeric(8,4) not null default 0.045`;
    await sql`alter table company_settings add column if not exists alert_days_cxc integer not null default 7`;
    await sql`alter table company_settings add column if not exists alert_days_cxp integer not null default 7`;
    await sql`alter table company_settings add column if not exists alert_email text not null default ''`;
    await sql`alter table company_settings add column if not exists alert_email_on boolean not null default true`;
    await sql`alter table company_settings add column if not exists resend_key text not null default ''`;
    await sql`
      insert into company_settings (
        company_id, legal_name, rfc, credit_days, invoice_days, fega_rate,
        collection_spread, finance_spread, default_tiie, asr_commission, asr_spread, email_from, phone,
        alert_days_cxc, alert_days_cxp, alert_email, alert_email_on
      )
      values (
        ${cid}, ${data.legalName}, ${data.rfc}, ${data.creditDays}, ${data.invoiceDays}, ${data.fegaRate},
        ${data.collectionSpread}, ${data.financeSpread}, ${data.defaultTiie}, ${data.asrCommission}, ${data.asrSpread},
        ${data.emailFrom}, ${data.phone}, ${data.alertDaysCxc ?? 7}, ${data.alertDaysCxp ?? 7},
        ${data.alertEmail ?? ""}, ${data.alertEmailOn ?? true}
      )
      on conflict (company_id) do update set
        legal_name = excluded.legal_name,
        rfc = excluded.rfc,
        credit_days = excluded.credit_days,
        invoice_days = excluded.invoice_days,
        fega_rate = excluded.fega_rate,
        collection_spread = excluded.collection_spread,
        finance_spread = excluded.finance_spread,
        default_tiie = excluded.default_tiie,
        asr_commission = excluded.asr_commission,
        asr_spread = excluded.asr_spread,
        email_from = excluded.email_from,
        phone = excluded.phone,
        alert_days_cxc = excluded.alert_days_cxc,
        alert_days_cxp = excluded.alert_days_cxp,
        alert_email = excluded.alert_email,
        alert_email_on = excluded.alert_email_on
    `;
    const key = (data.resendKey || "").trim();
    if (key.length > 8) {
      await sql`update company_settings set resend_key = ${key} where company_id = ${cid}`;
    }
    return { ok: true };
  });

export const saveTiie = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ date: z.string(), rate: z.number().positive() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    await sql`
      insert into tiie_rates (company_id, date, rate)
      values (${cid}, ${data.date}, ${data.rate})
      on conflict (company_id, date) do update set rate = excluded.rate
    `;
    return { ok: true };
  });

export const saveFx = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ date: z.string(), usdMxn: z.number().positive() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    await sql`
      insert into fx_rates (company_id, date, usd_mxn)
      values (${cid}, ${data.date}, ${data.usdMxn})
      on conflict (company_id, date) do update set usd_mxn = excluded.usd_mxn
    `;
    return { ok: true };
  });

export const listContacts = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ partnerId: z.number() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    return sql<{
      id: number;
      name: string;
      role: string;
      email: string;
      phone: string;
      is_billing: boolean;
    }>`
      select id, name, role, email, phone, is_billing
      from partner_contacts
      where company_id = ${cid} and partner_id = ${data.partnerId}
      order by is_billing desc, id
    `;
  });

export const saveContact = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      id: z.number().optional(),
      partnerId: z.number(),
      name: z.string().min(1),
      role: z.string().optional().default(""),
      email: z.string().optional().default(""),
      phone: z.string().optional().default(""),
      isBilling: z.boolean().optional().default(false),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    if (data.id) {
      await sql`
        update partner_contacts set name=${data.name}, role=${data.role ?? ""}, email=${data.email ?? ""},
          phone=${data.phone ?? ""}, is_billing=${data.isBilling ?? false}
        where id = ${data.id} and company_id = ${cid}
      `;
      return { id: data.id };
    }
    const row = await sql<{ id: number }>`
      insert into partner_contacts (company_id, partner_id, name, role, email, phone, is_billing)
      values (${cid}, ${data.partnerId}, ${data.name}, ${data.role ?? ""}, ${data.email ?? ""}, ${data.phone ?? ""}, ${data.isBilling ?? false})
      returning id
    `;
    return { id: row[0]!.id };
  });

export const listQuotes = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    await sql`alter table quote_lines add column if not exists uom text not null default ''`;
    await sql`alter table quotes add column if not exists price_offer text not null default 'both'`;
    await sql`alter table quotes add column if not exists revision integer not null default 1`;
    await sql`alter table quote_lines add column if not exists cash_price numeric(14,4) not null default 0`;
    await sql`alter table quote_lines add column if not exists credit_price numeric(14,4) not null default 0`;
    await sql`alter table quote_lines add column if not exists cost numeric(14,4) not null default 0`;
    await sql`alter table quote_lines add column if not exists freight numeric(14,4) not null default 0`;
    const quotes = await sql<{
      id: number;
      name: string;
      partner_id: number;
      partner: string;
      date: string;
      valid_until: string;
      currency: string;
      fx_rate: string;
      state: string;
      total: string;
      credit_days: number;
      notes: string;
      delivery_to: string;
      price_offer: string;
      revision: number;
      tiie: string;
      spread: string;
    }>`
      select q.id, q.name, q.partner_id, p.name as partner, q.date::text, q.valid_until::text,
        q.currency, q.fx_rate::text, q.state, q.total::text, q.notes, q.delivery_to,
        coalesce(q.credit_days,0) as credit_days,
        coalesce(q.price_offer,'both') as price_offer,
        coalesce(q.revision,1) as revision,
        coalesce(q.tiie,0)::text as tiie,
        coalesce(q.spread,0)::text as spread
      from quotes q join partners p on p.id = q.partner_id
      where q.company_id = ${cid}
      order by q.id desc
    `;
    const lines = await sql<{
      id: number;
      quote_id: number;
      product_id: number;
      product: string;
      qty: string;
      unit_price: string;
      cash_price: string;
      credit_price: string;
      uom: string;
      on_hand: string;
      on_hand_own: string;
      on_hand_supplier: string;
      cost: string;
      freight: string;
    }>`
      select ql.id, ql.quote_id, ql.product_id, (pr.code || ' — ' || pr.name) as product, ql.qty::text, ql.unit_price::text,
        coalesce(nullif(ql.cash_price,0), ql.unit_price)::text as cash_price,
        coalesce(nullif(ql.credit_price,0), ql.unit_price)::text as credit_price,
        coalesce(ql.uom, pr.uom) as uom,
        coalesce((select sum(quantity) from stock_quants q where q.product_id = pr.id),0)::text as on_hand,
        coalesce((select sum(q.quantity) from stock_quants q join locations l on l.id = q.location_id where q.product_id = pr.id and l.loc_type = 'internal'),0)::text as on_hand_own,
        coalesce((select sum(q.quantity) from stock_quants q join locations l on l.id = q.location_id where q.product_id = pr.id and l.loc_type = 'supplier'),0)::text as on_hand_supplier,
        coalesce(nullif(ql.cost,0), pr.cost)::text as cost,
        coalesce(ql.freight,0)::text as freight
      from quote_lines ql
      join products pr on pr.id = ql.product_id
      join quotes q on q.id = ql.quote_id
      where q.company_id = ${cid}
    `;
    const customers = await sql<{ id: number; name: string; email: string; phone: string }>`
      select id, name, coalesce(email,'') as email, coalesce(phone,'') as phone
      from partners where company_id = ${cid} and is_customer = true order by name
    `;
    const products = await sql<{ id: number; code: string; name: string; list_price: string; uom: string }>`
      select id, code, name, list_price::text, uom from products where company_id = ${cid} order by code
    `;
    return { quotes, lines, customers, products };
  });

export const createQuote = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      partnerId: z.number(),
      currency: z.enum(["MXN", "USD"]),
      fxRate: z.number().positive(),
      validUntil: z.string(),
      notes: z.string().optional().default(""),
      deliveryTo: z.string().optional().default(""),
      tiie: z.number().optional().default(0),
      spread: z.number().optional().default(0),
      creditDays: z.number().optional().default(0),
      priceOffer: z.enum(["cash", "credit", "both"]).optional().default("both"),
      send: z.boolean().optional().default(true),
      lines: z
        .array(
          z.object({
            productId: z.number(),
            qty: z.number().positive(),
            unitPrice: z.number().nonnegative(),
            cashPrice: z.number().optional(),
            creditPrice: z.number().optional(),
            uom: z.string().optional().default(""),
            cost: z.number().optional().default(0),
            freight: z.number().optional().default(0),
            other: z.number().optional().default(0),
            marginPct: z.number().optional().default(0),
          }),
        )
        .min(1),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    await assertCan(sql, context.userId, "quotes", "edit");
    const today = new Date().toISOString().slice(0, 10);
    if (data.validUntil < today) {
      throw new Error(`La vigencia ya venció (${data.validUntil}). Elige hoy o una fecha posterior.`);
    }
    await sql`alter table quotes add column if not exists owner_id text`;
    await sql`alter table quotes add column if not exists tiie numeric(8,6) not null default 0`;
    await sql`alter table quotes add column if not exists spread numeric(8,6) not null default 0`;
    await sql`alter table quotes add column if not exists credit_days integer not null default 0`;
    await sql`alter table quotes add column if not exists price_offer text not null default 'both'`;
    await sql`alter table quotes add column if not exists revision integer not null default 1`;
    await sql`alter table quote_lines add column if not exists cost numeric(14,4) not null default 0`;
    await sql`alter table quote_lines add column if not exists freight numeric(14,4) not null default 0`;
    await sql`alter table quote_lines add column if not exists other_cost numeric(14,4) not null default 0`;
    await sql`alter table quote_lines add column if not exists margin_pct numeric(8,4) not null default 0`;
    await sql`alter table quote_lines add column if not exists cash_price numeric(14,4) not null default 0`;
    await sql`alter table quote_lines add column if not exists credit_price numeric(14,4) not null default 0`;
    const n = await sql<{ c: number }>`select count(*)::int as c from quotes where company_id = ${cid}`;
    const name = `COT-${String((n[0]?.c ?? 0) + 1).padStart(4, "0")}`;
    const offer = data.priceOffer ?? "both";
    const priced = data.lines.map((l) => {
      const cash = l.cashPrice ?? (offer === "credit" ? 0 : l.unitPrice);
      const credit = l.creditPrice ?? (offer === "cash" ? 0 : l.unitPrice);
      const unit = offer === "cash" ? cash : credit || l.unitPrice;
      return { ...l, cash, credit, unit };
    });
    const total = priced.reduce((s, l) => s + l.qty * l.unit, 0);
    const state = data.send ? "sent" : "draft";
    const q = await sql<{ id: number }>`
      insert into quotes (company_id, name, partner_id, valid_until, currency, fx_rate, state, notes, delivery_to, total, owner_id, tiie, spread, credit_days, price_offer)
      values (${cid}, ${name}, ${data.partnerId}, ${data.validUntil}, ${data.currency}, ${data.fxRate}, ${state},
        ${data.notes ?? ""}, ${data.deliveryTo ?? ""}, ${total}, ${context.userId}, ${data.tiie ?? 0}, ${data.spread ?? 0}, ${data.creditDays ?? 0}, ${offer})
      returning id
    `;
    await sql`alter table quote_lines add column if not exists uom text not null default ''`;
    for (const line of priced) {
      await sql`
        insert into quote_lines (quote_id, product_id, qty, unit_price, uom, cost, freight, other_cost, margin_pct, cash_price, credit_price)
        values (${q[0]!.id}, ${line.productId}, ${line.qty}, ${line.unit}, ${line.uom ?? ""}, ${line.cost ?? 0}, ${line.freight ?? 0}, ${line.other ?? 0}, ${line.marginPct ?? 0}, ${line.cash}, ${line.credit})
      `;
    }
    await rememberTrade(sql, {
      companyId: cid,
      partnerId: data.partnerId,
      kind: "sell",
      products: priced.map((l) => ({ productId: l.productId, unitPrice: l.unit })),
    });
    return { id: q[0]!.id, name, state };
  });

export const reviseQuote = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      quoteId: z.number(),
      creditDays: z.number().optional(),
      priceOffer: z.enum(["cash", "credit", "both"]).optional(),
      notes: z.string().optional(),
      lines: z
        .array(
          z.object({
            productId: z.number(),
            qty: z.number().positive(),
            cashPrice: z.number().nonnegative(),
            creditPrice: z.number().nonnegative(),
          }),
        )
        .min(1),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    await assertCan(sql, context.userId, "quotes", "edit");
    const q = await sql<{ id: number; state: string; name: string; revision: number; price_offer: string }>`
      select id, state, name, coalesce(revision,1) as revision, coalesce(price_offer,'both') as price_offer
      from quotes where id = ${data.quoteId} and company_id = ${cid}
    `;
    if (!q[0]) throw new Error("Cotización no encontrada");
    if (q[0].state === "accepted" || q[0].state === "rejected") {
      throw new Error("Ya se cerró. Abre una cotización nueva.");
    }
    const offer = data.priceOffer ?? q[0].price_offer;
    const total = data.lines.reduce((s, l) => s + l.qty * (offer === "cash" ? l.cashPrice : l.creditPrice || l.cashPrice), 0);
    await sql`
      update quotes
      set revision = ${q[0].revision + 1},
          total = ${total},
          price_offer = ${offer},
          credit_days = coalesce(${data.creditDays ?? null}, credit_days),
          notes = coalesce(${data.notes ?? null}, notes),
          state = 'sent'
      where id = ${q[0].id}
    `;
    for (const line of data.lines) {
      const unit = offer === "cash" ? line.cashPrice : line.creditPrice || line.cashPrice;
      await sql`
        update quote_lines
        set qty = ${line.qty}, unit_price = ${unit}, cash_price = ${line.cashPrice}, credit_price = ${line.creditPrice}
        where quote_id = ${q[0].id} and product_id = ${line.productId}
      `;
    }
    return { id: q[0].id, name: q[0].name, revision: q[0].revision + 1 };
  });

export const decideQuote = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      quoteId: z.number(),
      decision: z.enum(["accept", "partial", "reject"]),
      locationId: z.number().optional(),
      fulfillKind: z.enum(["inventory", "direct"]).optional().default("inventory"),
      acceptOffer: z.enum(["cash", "credit"]).optional(),
      lines: z.array(z.object({ productId: z.number(), qty: z.number().nonnegative() })).optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    await assertCan(sql, context.userId, "quotes", "edit");
    await sql`alter table quotes add column if not exists price_offer text not null default 'both'`;
    await sql`alter table quotes add column if not exists credit_days integer not null default 0`;
    const q = await sql<{
      id: number;
      partner_id: number;
      currency: string;
      fx_rate: string;
      notes: string;
      delivery_to: string;
      total: string;
      state: string;
      name: string;
      credit_days: number;
      price_offer: string;
      valid_until: string;
    }>`
      select id, partner_id, currency, fx_rate::text, notes, delivery_to, total::text, state, name,
        coalesce(credit_days,0) as credit_days,
        coalesce(price_offer,'both') as price_offer,
        valid_until::text
      from quotes where id = ${data.quoteId} and company_id = ${cid}
    `;
    if (!q[0] || q[0].state === "accepted" || q[0].state === "rejected") {
      throw new Error("Esta cotización ya se cerró");
    }
    if (data.decision !== "reject") {
      const today = new Date().toISOString().slice(0, 10);
      if (q[0].valid_until < today) {
        throw new Error(`La vigencia ya venció (${dateDMY(q[0].valid_until)}). Renegocia o emite otra cotización.`);
      }
    }
    if (data.decision === "reject") {
      await sql`update quotes set state = 'rejected' where id = ${q[0].id}`;
      return { soId: 0, name: q[0].name, state: "rejected", pos: [] as string[] };
    }
    if (!data.locationId) throw new Error("Elige la bodega de surtido");
    await sql`alter table quote_lines add column if not exists cash_price numeric(14,4) not null default 0`;
    await sql`alter table quote_lines add column if not exists credit_price numeric(14,4) not null default 0`;
    const quoted = await sql<{
      product_id: number;
      qty: string;
      unit_price: string;
      uom: string;
      cash_price: string;
      credit_price: string;
    }>`
      select product_id, qty::text, unit_price::text, coalesce(uom,'') as uom,
        coalesce(nullif(cash_price,0), unit_price)::text as cash_price,
        coalesce(nullif(credit_price,0), unit_price)::text as credit_price
      from quote_lines where quote_id = ${q[0].id}
    `;
    const wanted = new Map((data.lines ?? []).map((l) => [l.productId, l.qty]));
    const offer =
      data.acceptOffer ??
      (q[0].price_offer === "cash" ? "cash" : q[0].price_offer === "credit" ? "credit" : q[0].credit_days > 0 ? "credit" : "cash");
    const take = quoted
      .map((l) => ({
        productId: l.product_id,
        qty: data.decision === "partial" && wanted.size ? wanted.get(l.product_id) ?? 0 : Number(l.qty),
        unitPrice: offer === "cash" ? Number(l.cash_price) : Number(l.credit_price),
        uom: l.uom,
      }))
      .filter((l) => l.qty > 0);
    if (!take.length) throw new Error("No hay partidas aceptadas");
    const total = take.reduce((s, l) => s + l.qty * l.unitPrice, 0);
    const n = await sql<{ c: number }>`select count(*)::int as c from sales_orders where company_id = ${cid}`;
    const name = `PV-${String((n[0]?.c ?? 0) + 1).padStart(4, "0")}`;
    const today = new Date().toISOString().slice(0, 10);
    const days = offer === "credit" ? q[0].credit_days || 0 : 0;
    const termKind = days > 0 ? "credit_days" : "contado";
    const dues = computeDues({ date: today, termKind, invoiceDays: days, creditDays: days });
    const fulfillKind = data.fulfillKind ?? "inventory";
    const routeKind = fulfillKind === "direct" ? "supplier" : "own";
    await sql`alter table sales_orders add column if not exists term_kind text not null default 'contado'`;
    await sql`alter table sales_orders add column if not exists credit_days integer not null default 0`;
    await sql`alter table sales_orders add column if not exists invoice_days integer not null default 0`;
    const so = await sql<{ id: number }>`
      insert into sales_orders (
        company_id, name, partner_id, state, location_id, notes, total, currency, fx_rate, quote_id, delivery_to,
        term_kind, invoice_days, credit_days, invoice_due, credit_due, route_kind, date
      )
      values (
        ${cid}, ${name}, ${q[0].partner_id}, 'draft', ${data.locationId}, ${q[0].notes}, ${total},
        ${q[0].currency}, ${Number(q[0].fx_rate)}, ${q[0].id}, ${q[0].delivery_to},
        ${termKind}, ${dues.invoiceDays}, ${dues.creditDays}, ${dues.invoiceDue}, ${dues.creditDue}, ${routeKind}, ${today}
      )
      returning id
    `;
    for (const line of take) {
      await sql`
        insert into sales_lines (so_id, product_id, qty, unit_price, uom)
        values (${so[0]!.id}, ${line.productId}, ${line.qty}, ${line.unitPrice}, ${line.uom})
      `;
    }
    await rememberTrade(sql, {
      companyId: cid,
      partnerId: q[0].partner_id,
      kind: "sell",
      products: take.map((l) => ({ productId: l.productId, unitPrice: l.unitPrice })),
      locationId: data.locationId,
    });
    await sql`update quotes set state = ${data.decision === "partial" ? "partial" : "accepted"}, total = ${total} where id = ${q[0].id}`;

    const pos: string[] = [];
    const req = await sql<{ id: number; delivery_mode: string }>`
      select id, delivery_mode from customer_requests where quote_id = ${q[0].id} and company_id = ${cid} limit 1
    `;
    if (req[0]) {
      const winners = await sql<{ supplier_id: number; product_id: number; qty: string; cost: string; uom: string }>`
        select supplier_id, product_id, qty::text, cost::text, uom from customer_request_lines
        where request_id = ${req[0].id} and supplier_id is not null
      `;
      const bySup = new Map<number, typeof winners>();
      for (const w of winners) {
        const accepted = take.find((t) => t.productId === w.product_id);
        if (!accepted) continue;
        const list = bySup.get(w.supplier_id) ?? [];
        list.push({ ...w, qty: String(accepted.qty) });
        bySup.set(w.supplier_id, list);
      }
      await sql`alter table purchase_orders add column if not exists fulfill_kind text not null default 'inventory'`;
      await sql`alter table purchase_orders add column if not exists so_id integer`;
      await sql`alter table purchase_lines add column if not exists deliver_to text not null default ''`;
      for (const [supplierId, lines] of bySup) {
        const poN = await sql<{ c: number }>`select count(*)::int as c from purchase_orders where company_id = ${cid}`;
        const poName = `OC-${String((poN[0]?.c ?? 0) + 1).padStart(4, "0")}`;
        const poTotal = lines.reduce((s, l) => s + Number(l.qty) * Number(l.cost), 0);
        const po = await sql<{ id: number }>`
          insert into purchase_orders (company_id, name, partner_id, state, location_id, notes, total, currency, fx_rate, fulfill_kind, so_id)
          values (${cid}, ${poName}, ${supplierId}, 'confirmed', ${data.locationId}, ${`Desde ${name}`}, ${poTotal},
            ${q[0].currency}, ${Number(q[0].fx_rate)}, ${fulfillKind}, ${so[0]!.id})
          returning id
        `;
        for (const line of lines) {
          await sql`
            insert into purchase_lines (po_id, product_id, qty, unit_price, uom, deliver_to)
            values (${po[0]!.id}, ${line.product_id}, ${Number(line.qty)}, ${Number(line.cost)}, ${line.uom}, ${q[0].delivery_to})
          `;
        }
        await rememberTrade(sql, {
          companyId: cid,
          partnerId: supplierId,
          kind: "buy",
          products: lines.map((l) => ({ productId: l.product_id, unitPrice: Number(l.cost) })),
          locationId: data.locationId,
        });
        const daysPay = await sql<{ payment_days: number }>`select coalesce(payment_days,0) as payment_days from partners where id = ${supplierId}`;
        const due = new Date();
        due.setDate(due.getDate() + (daysPay[0]?.payment_days ?? 0));
        const ic = await sql<{ c: number }>`select count(*)::int as c from invoices where company_id = ${cid} and kind = 'supplier'`;
        const iname = `FP-${String((ic[0]?.c ?? 0) + 1).padStart(4, "0")}`;
        await sql`
          insert into invoices (company_id, kind, name, partner_id, due_date, state, amount, residual, origin, currency)
          values (${cid}, 'supplier', ${iname}, ${supplierId}, ${due.toISOString().slice(0, 10)}, 'open', ${poTotal}, ${poTotal}, ${poName}, ${q[0].currency})
        `;
        pos.push(poName);
      }
    }
    if (pos.length) {
      await sql`update sales_orders set notes = ${[q[0].notes, `Compras ${pos.join(", ")}`].filter(Boolean).join(" · ")} where id = ${so[0]!.id}`;
    }
    return { soId: so[0]!.id, name, state: data.decision, pos };
  });

export const listBanks = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    await assertCan(sql, context.userId, "banks", "view");
    try {
      const { seedExpenseCategories } = await import("@/lib/erp/expenses");
      await seedExpenseCategories(sql, cid);
    } catch {
      /* ignore */
    }
    const banks = await sql<{
      id: number;
      name: string;
      account: string;
      currency: string;
      opening: string;
      movement: string;
    }>`
      select b.id, b.name, b.account, b.currency, b.opening::text,
        coalesce((select sum(amount) from bank_moves m where m.bank_id = b.id),0)::text as movement
      from banks b
      where b.company_id = ${cid}
      order by b.id
    `;
    const moves = await sql<{
      id: number;
      bank: string;
      date: string;
      amount: string;
      memo: string;
      partner: string | null;
      reconciled: boolean;
      kind: string;
      invoice: string | null;
      so_name: string | null;
      po_name: string | null;
    }>`
      select m.id, b.name as bank, m.date::text, m.amount::text, m.memo, p.name as partner, m.reconciled,
        coalesce(m.kind, 'ajuste') as kind, i.name as invoice, s.name as so_name, po.name as po_name
      from bank_moves m
      join banks b on b.id = m.bank_id
      left join partners p on p.id = m.partner_id
      left join invoices i on i.id = m.invoice_id
      left join sales_orders s on s.id = m.so_id
      left join purchase_orders po on po.id = m.po_id
      where m.company_id = ${cid}
      order by m.date desc, m.id desc
      limit 80
    `;
    const partners = await sql<{ id: number; name: string; is_customer: boolean; is_supplier: boolean }>`
      select id, name, is_customer, is_supplier from partners where company_id = ${cid} order by name
    `;
    const invoices = await sql<{ id: number; name: string; partner_id: number; kind: string; residual: string }>`
      select id, name, partner_id, kind, residual::text from invoices
      where company_id = ${cid} and state <> 'paid' order by id desc limit 80
    `;
    const sales = await sql<{ id: number; name: string; partner_id: number }>`
      select id, name, partner_id from sales_orders where company_id = ${cid} order by id desc limit 80
    `;
    const purchases = await sql<{ id: number; name: string; partner_id: number }>`
      select id, name, partner_id from purchase_orders where company_id = ${cid} order by id desc limit 80
    `;
    return { banks, moves, partners, invoices, sales, purchases };
  });

export const saveBankOpening = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ bankId: z.number(), opening: z.number() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    await assertCan(sql, context.userId, "banks", "edit");
    await sql`update banks set opening = ${data.opening} where id = ${data.bankId} and company_id = ${cid}`;
    return { ok: true };
  });

export const addBankMove = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      bankId: z.number(),
      date: z.string(),
      amount: z.number().positive(),
      kind: z.enum(["cobro", "pago", "transferencia", "ajuste"]),
      memo: z.string().optional().default(""),
      partnerId: z.number().optional(),
      invoiceId: z.number().optional(),
      soId: z.number().optional(),
      poId: z.number().optional(),
      bankToId: z.number().optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    await assertCan(sql, context.userId, "banks", "edit");
    const signed =
      data.kind === "cobro" || data.kind === "ajuste" ? Math.abs(data.amount) : -Math.abs(data.amount);
    if (data.kind === "pago" || data.kind === "transferencia") {
      const bal = await sql<{ opening: string; movement: string }>`
        select b.opening::text, coalesce((select sum(amount) from bank_moves m where m.bank_id = b.id),0)::text as movement
        from banks b where b.id = ${data.bankId} and b.company_id = ${cid}
      `;
      const cash = Number(bal[0]?.opening ?? 0) + Number(bal[0]?.movement ?? 0);
      if (cash + 0.009 < Math.abs(data.amount)) {
        throw new Error(`No hay saldo suficiente en la cuenta (${cash.toFixed(2)}). Cobra primero o captura saldo inicial.`);
      }
    }
    const memo = data.memo ?? "";
    const mv = await sql<{ id: number }>`
      insert into bank_moves (company_id, bank_id, date, amount, memo, partner_id, kind, invoice_id, so_id, po_id, created_by)
      values (${cid}, ${data.bankId}, ${data.date}, ${signed}, ${memo}, ${data.partnerId ?? null},
        ${data.kind}, ${data.invoiceId ?? null}, ${data.soId ?? null}, ${data.poId ?? null}, ${context.userId})
      returning id
    `;
    if (data.kind === "transferencia") {
      if (!data.bankToId) throw new Error("Elige la cuenta destino");
      await sql`
        insert into bank_moves (company_id, bank_id, date, amount, memo, kind, created_by)
        values (${cid}, ${data.bankToId}, ${data.date}, ${Math.abs(data.amount)}, ${memo || "Transferencia"}, 'transferencia', ${context.userId})
      `;
    }
    if (data.invoiceId) {
      const inv = await sql<{ residual: string; partner_id: number; kind: string; date: string }>`
        select residual::text, partner_id, kind, date::text from invoices where id = ${data.invoiceId} and company_id = ${cid}
      `;
      if (inv[0]) {
        if (data.date < inv[0].date) {
          throw new Error(`La fecha del movimiento (${data.date}) no puede ser anterior a la factura (${inv[0].date}).`);
        }
        const residual = Number(inv[0].residual);
        const applied = Math.min(Math.abs(data.amount), residual);
        const n = await sql<{ c: number }>`select count(*)::int as c from payments where company_id = ${cid}`;
        const name = `PAG-${String((n[0]?.c ?? 0) + 1).padStart(4, "0")}`;
        const payKind = inv[0].kind === "customer" ? "inbound" : "outbound";
        const pay = await sql<{ id: number }>`
          insert into payments (company_id, kind, name, partner_id, amount, memo, created_by, date)
          values (${cid}, ${payKind}, ${name}, ${inv[0].partner_id}, ${applied}, ${memo}, ${context.userId}, ${data.date})
          returning id
        `;
        await sql`insert into payment_allocs (payment_id, invoice_id, amount) values (${pay[0]!.id}, ${data.invoiceId}, ${applied})`;
        await refreshInvoiceResidual(sql, data.invoiceId);
        await sql`update bank_moves set payment_id = ${pay[0]!.id} where id = ${mv[0]!.id}`;
      }
    }
    return { ok: true };
  });

export const reconcileMove = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ moveId: z.number() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    await sql`
      update bank_moves set reconciled = not reconciled
      where id = ${data.moveId} and company_id = ${cid}
    `;
    return { ok: true };
  });

export const getLiveStatement = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      partnerId: z.number().optional(),
      groupName: z.string().optional(),
      asOf: z.string().optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    const pol = await policy(sql, cid);
    const asOf = (data.asOf || new Date().toISOString().slice(0, 10)).slice(0, 10);
    const tiieRows = await sql<{ date: string; rate: string }>`
      select date::text, rate::text from tiie_rates where company_id = ${cid} order by date
    `;
    const tiieTable = tiieRows.map((r) => ({ date: r.date, rate: Number(r.rate) }));

    const partners = await sql<{
      id: number;
      code: string;
      name: string;
      legal_name: string;
      group_name: string;
      email: string;
      phone: string;
      rfc: string;
      payment_days: number;
    }>`
      select id, code, name, legal_name, group_name, email, phone, rfc, payment_days
      from partners
      where company_id = ${cid}
        and is_customer = true
        and (${data.partnerId ?? 0} = 0 or id = ${data.partnerId ?? 0})
        and (${data.groupName ?? ""} = '' or group_name = ${data.groupName ?? ""})
      order by name
    `;

    const result = [];
    for (const partner of partners) {
      const invoices = await sql<{
        id: number;
        name: string;
        kind: string;
        date: string;
        due_date: string;
        amount: string;
        residual: string;
        state: string;
        origin: string;
        currency: string;
        amount_fx: string;
        fx_agreed: string;
        fx_paid: string | null;
        inv_class: string;
        fega_charged: boolean;
        interest_invoiced: string;
        fx_invoiced: string;
        paid_date: string | null;
        credit_days: number;
      }>`
        select id, name, kind, date::text, due_date::text, amount::text, residual::text, state, origin,
          currency, amount_fx::text, fx_agreed::text, fx_paid::text, inv_class, fega_charged,
          interest_invoiced::text, fx_invoiced::text, paid_date::text,
          coalesce(credit_days, 0)::int as credit_days
        from invoices
        where company_id = ${cid} and partner_id = ${partner.id}
        order by date, id
      `;
      const lines = await sql<{
        invoice_id: number;
        product: string;
        qty: string;
        unit_price: string;
        amount: string;
      }>`
        select il.invoice_id, coalesce(p.name, il.description) as product,
          il.qty::text, il.unit_price::text, il.amount::text
        from invoice_lines il
        left join products p on p.id = il.product_id
        join invoices i on i.id = il.invoice_id
        where i.partner_id = ${partner.id} and i.company_id = ${cid}
      `;
      const contacts = await sql<{ name: string; email: string; phone: string; role: string; is_billing: boolean }>`
        select name, email, phone, role, is_billing from partner_contacts
        where partner_id = ${partner.id} order by is_billing desc
      `;
      const pays = await sql<{
        invoice_id: number;
        date: string;
        amount: string;
      }>`
        select pa.invoice_id, p.date::text, pa.amount::text
        from payment_allocs pa
        join payments p on p.id = pa.payment_id
        join invoices i on i.id = pa.invoice_id
        where i.company_id = ${cid} and i.partner_id = ${partner.id}
        order by p.date, pa.id
      `;

      const rows = invoices.map((inv) => {
        const tiie = nearestRate(tiieTable, inv.due_date, pol.defaultTiie);
        const cargo = Number(inv.amount);
        const saldo = Number(inv.residual);
        const capital = saldo > 0.009 ? saldo : cargo;
        const productDoc = inv.kind === "customer" && (inv.inv_class || "product") === "product";
        const mora = productDoc
          ? computeMora({
              capital,
              dueDate: inv.due_date,
              asOf,
              paidDate: inv.paid_date,
              tiieAtDue: tiie,
              spread: pol.collectionSpread,
              fegaRate: pol.fegaRate,
              fegaAlreadyCharged: inv.fega_charged || Number(inv.interest_invoiced) > 0,
            })
          : { daysOverdue: 0, annualRate: tiie + pol.collectionSpread, interest: 0, fega: 0, mora: 0, tiie, spread: pol.collectionSpread, capital, endDate: asOf };
        const liveMora = Math.max(0, mora.mora - Number(inv.interest_invoiced));
        const fxDiff = inv.currency === "USD"
          ? fxDifferential(Number(inv.amount_fx), Number(inv.fx_agreed), inv.fx_paid ? Number(inv.fx_paid) : null)
          : 0;
        const liveFx = Math.max(0, fxDiff - Number(inv.fx_invoiced));
        const dueNow = saldo + liveMora + liveFx;
        const allocs = pays.filter((p) => p.invoice_id === inv.id);
        const abono = allocs.reduce((s, p) => s + Number(p.amount), 0);
        const fechaAbono = allocs.length ? allocs[allocs.length - 1]!.date : inv.paid_date;
        const plazo = inv.credit_days || partner.payment_days || 0;
        const { serie, folio } = splitDocName(inv.name);
        const line = productDoc
          ? computeStatementLine({
              cargo,
              dueDate: inv.due_date,
              asOf,
              paidDate: fechaAbono,
              tiieAtDue: tiie,
              spread: pol.collectionSpread,
              fegaRate: pol.fegaRate,
              commissionRate: pol.commissionRate,
            })
          : null;
        const formula = explainInterest({
          capital: line?.capital ?? mora.capital,
          days: line?.daysVencidos ?? mora.daysOverdue,
          tiie: mora.tiie,
          spread: mora.spread,
          interest: line?.interest ?? mora.interest,
          fega: line?.comisionFega ?? mora.fega,
          fegaRate: pol.fegaRate,
          commissionRate: pol.commissionRate,
          currency: inv.currency,
          dueDate: inv.due_date,
          residual: saldo,
        });
        const dueCheck = validateDueDates({
          issue: inv.date,
          due: inv.due_date,
          days: plazo || undefined,
          asOf,
          allowPast: true,
        });
        return {
          ...inv,
          products: lines.filter((l) => l.invoice_id === inv.id),
          serie,
          folio,
          cargo,
          saldo,
          daysOverdue: mora.daysOverdue,
          daysVence: line?.daysVence ?? 0,
          daysVencidos: line?.daysVencidos ?? mora.daysOverdue,
          annualRate: line?.annualRate ?? mora.annualRate,
          liveMora,
          liveFx,
          utCambiaria: fxDiff,
          dueNow,
          abono,
          fechaAbono,
          fechaPago: line?.fechaPago ?? fechaAbono ?? asOf,
          plazo,
          interes: line?.interest ?? mora.interest,
          fega: mora.fega,
          comisionFega: line?.comisionFega ?? 0,
          totalFinanciero: line?.totalFinanciero ?? mora.mora,
          tiie,
          spread: pol.collectionSpread,
          formula: formula.short,
          formulaLines: formula.lines,
          dateErrors: dueCheck.errors,
          dateWarnings: dueCheck.warnings,
        };
      });

      const customerRows = rows.filter((r) => r.kind === "customer");
      const ar = customerRows.reduce((s, r) => s + Number(r.residual), 0);
      const ap = rows.filter((r) => r.kind === "supplier").reduce((s, r) => s + Number(r.residual), 0);
      const byCurrency = ["MXN", "USD"].map((cur) => {
        const set = customerRows.filter((r) => (r.currency || "MXN") === cur && (r.inv_class || "product") === "product");
        return {
          currency: cur,
          cargo: set.reduce((s, r) => s + r.cargo, 0),
          abono: set.reduce((s, r) => s + r.abono, 0),
          saldo: set.reduce((s, r) => s + r.saldo, 0),
          interes: set.reduce((s, r) => s + r.interes, 0),
          comisionFega: set.reduce((s, r) => s + r.comisionFega, 0),
          totalFinanciero: set.reduce((s, r) => s + r.totalFinanciero, 0),
          utCambiaria: set.reduce((s, r) => s + r.utCambiaria, 0),
        };
      });
      const byProduct: Record<string, number> = {};
      for (const r of customerRows) {
        if (r.products.length === 0) {
          byProduct[r.origin || r.name] = (byProduct[r.origin || r.name] ?? 0) + r.saldo;
        } else {
          const lineSum = r.products.reduce((s, l) => s + Number(l.amount), 0) || 1;
          for (const l of r.products) {
            byProduct[l.product] = (byProduct[l.product] ?? 0) + r.saldo * (Number(l.amount) / lineSum);
          }
        }
      }

      result.push({ partner, contacts, rows, ar, ap, byProduct, byCurrency });
    }

    const fegaSplit = splitFegaBundle(pol.fegaRate, pol.commissionRate);
    return {
      asOf,
      policy: {
        ...pol,
        commissionRate: fegaSplit.commission,
        fegaOnlyRate: fegaSplit.fega,
        fegaBundle: fegaSplit.bundle,
      },
      statements: result,
    };
  });

export async function issueMoraInvoice(
  sql: Sql,
  companyId: number,
  invoiceId: number,
  opts?: { asOf?: string; paidDate?: string | null; requireCharge?: boolean },
) {
  const pol = await policy(sql, companyId);
  const asOf = (opts?.asOf || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const inv = await sql<{
    id: number;
    partner_id: number;
    residual: string;
    amount: string;
    due_date: string;
    paid_date: string | null;
    fega_charged: boolean;
    interest_invoiced: string;
    name: string;
    kind: string;
    inv_class: string;
  }>`
    select id, partner_id, residual::text, amount::text, due_date::text, paid_date::text,
      fega_charged, interest_invoiced::text, name, kind, coalesce(inv_class,'product') as inv_class
    from invoices where id = ${invoiceId} and company_id = ${companyId}
  `;
  if (!inv[0]) throw new Error("Factura no encontrada");
  if (inv[0].kind !== "customer" || inv[0].inv_class === "interest") {
    return { name: null as string | null, charge: 0, formula: "" };
  }
  const tiieRows = await sql<{ date: string; rate: string }>`
    select date::text, rate::text from tiie_rates where company_id = ${companyId} order by date
  `;
  const tiie = nearestRate(
    tiieRows.map((r) => ({ date: r.date, rate: Number(r.rate) })),
    inv[0].due_date,
    pol.defaultTiie,
  );
  const paidDate = opts?.paidDate === undefined ? inv[0].paid_date : opts.paidDate;
  const mora = computeMora({
    capital: Number(inv[0].residual) > 0.009 ? Number(inv[0].residual) : Number(inv[0].amount),
    dueDate: inv[0].due_date,
    asOf,
    paidDate,
    tiieAtDue: tiie,
    spread: pol.collectionSpread,
    fegaRate: pol.fegaRate,
    fegaAlreadyCharged: inv[0].fega_charged || Number(inv[0].interest_invoiced) > 0,
  });
  const charge = Math.round(Math.max(0, mora.mora - Number(inv[0].interest_invoiced)) * 100) / 100;
  const formula = explainInterest({
    capital: mora.capital,
    days: mora.daysOverdue,
    tiie: mora.tiie,
    spread: mora.spread,
    interest: mora.interest,
    fega: mora.fega,
    fegaRate: pol.fegaRate,
    dueDate: inv[0].due_date,
    residual: Number(inv[0].residual),
  }).short;
  if (charge <= 0) {
    if (opts?.requireCharge !== false) throw new Error("No hay mora nueva por facturar");
    return { name: null as string | null, charge: 0, formula };
  }
  const n = await sql<{ c: number }>`select count(*)::int as c from invoices where company_id = ${companyId}`;
  const name = `FI-${String((n[0]?.c ?? 0) + 1).padStart(4, "0")}`;
  await sql`
    insert into invoices (
      company_id, kind, name, partner_id, date, due_date, state, amount, residual, origin, inv_class, currency
    )
    values (
      ${companyId}, 'customer', ${name}, ${inv[0].partner_id}, ${asOf}, ${asOf}, 'open',
      ${charge}, ${charge}, ${"Mora " + inv[0].name}, 'interest', 'MXN'
    )
  `;
  await sql`
    update invoices set interest_invoiced = interest_invoiced + ${charge}, fega_charged = true
    where id = ${inv[0].id}
  `;
  return { name, charge, formula };
}

export const invoiceLiveMora = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ invoiceId: z.number(), asOf: z.string().optional() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    return issueMoraInvoice(sql, cid, data.invoiceId, { asOf: data.asOf, requireCharge: true });
  });

export const saveDocument = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      kind: z.string(),
      title: z.string(),
      partnerId: z.number().optional(),
      body: z.string(),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    const row = await sql<{ id: number }>`
      insert into documents (company_id, kind, title, partner_id, body)
      values (${cid}, ${data.kind}, ${data.title}, ${data.partnerId ?? null}, ${data.body})
      returning id
    `;
    return { id: row[0]!.id };
  });

export const listDocuments = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const cid = await companyOf(sql, context.userId);
    return sql<{ id: number; kind: string; title: string; created_at: string; partner: string | null }>`
      select d.id, d.kind, d.title, d.created_at::text, p.name as partner
      from documents d
      left join partners p on p.id = d.partner_id
      where d.company_id = ${cid}
      order by d.id desc
      limit 50
    `;
  });

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { assertCan } from "@/lib/erp/acl";

type Sql = Awaited<ReturnType<typeof getSql>>;

export const DEAL_KINDS = ["request", "rfq", "quote", "sale", "purchase", "invoice"] as const;
export type DealKind = (typeof DEAL_KINDS)[number];

export type DealHop = {
  kind: DealKind;
  id: number;
  name: string;
  side?: "customer" | "supplier";
};

async function cid(sql: Sql, userId: string) {
  const rows = await sql<{ company_id: number }>`select company_id from members where user_id = ${userId} and status = 'active' limit 1`;
  if (!rows[0]) throw new Error("Sin empresa");
  return rows[0].company_id;
}

export async function ensureDealSchema(sql: Sql) {
  await sql`alter table quotes add column if not exists request_id integer`;
  await sql`alter table sales_orders add column if not exists quote_id integer`;
  await sql`alter table purchase_orders add column if not exists so_id integer`;
  await sql`alter table purchase_orders add column if not exists rfq_id integer`;
  await sql`alter table invoices add column if not exists order_id integer`;
  await sql`
    update quotes q set request_id = r.id
    from customer_requests r
    where r.quote_id = q.id and q.request_id is null
  `;
  await sql`
    update vendor_rfqs v set request_id = r.id
    from customer_requests r
    where r.rfq_id = v.id and v.request_id is null
  `;
  await sql`
    update purchase_orders po set rfq_id = v.id
    from vendor_rfqs v
    where po.rfq_id is null and po.notes like ('Desde ' || v.name || '%')
  `;
}

function pushUnique(list: DealHop[], hop: DealHop | null | undefined) {
  if (!hop || !hop.id || !hop.name) return;
  if (list.some((h) => h.kind === hop.kind && h.id === hop.id)) return;
  list.push(hop);
}

export function formatDealLine(hops: DealHop[]) {
  if (!hops.length) return "";
  const groups: DealKind[] = ["request", "rfq", "quote", "sale", "purchase", "invoice"];
  const parts: string[] = [];
  for (const k of groups) {
    const names = hops.filter((h) => h.kind === k).map((h) => h.name);
    if (names.length) parts.push(names.join(" · "));
  }
  return parts.join(" → ");
}

export const getDealTrail = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ kind: z.enum(DEAL_KINDS), id: z.number() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const companyId = await cid(sql, context.userId);
    await assertCan(sql, context.userId, "sales", "view");
    await ensureDealSchema(sql);

    let requestId: number | null = null;
    let rfqIds: number[] = [];
    let quoteId: number | null = null;
    let soId: number | null = null;
    let poIds: number[] = [];
    let invoiceIds: number[] = [];

    if (data.kind === "request") requestId = data.id;
    if (data.kind === "rfq") rfqIds = [data.id];
    if (data.kind === "quote") quoteId = data.id;
    if (data.kind === "sale") soId = data.id;
    if (data.kind === "purchase") poIds = [data.id];
    if (data.kind === "invoice") invoiceIds = [data.id];

    if (data.kind === "rfq") {
      const r = await sql<{ request_id: number | null; quote_id: number | null }>`
        select request_id, quote_id from vendor_rfqs where id = ${data.id} and company_id = ${companyId}
      `;
      requestId = r[0]?.request_id ?? null;
      quoteId = r[0]?.quote_id ?? null;
      if (!requestId) {
        const cr = await sql<{ id: number }>`
          select id from customer_requests where rfq_id = ${data.id} and company_id = ${companyId} limit 1
        `;
        requestId = cr[0]?.id ?? null;
      }
    }

    if (data.kind === "quote") {
      const q = await sql<{ request_id: number | null }>`
        select request_id from quotes where id = ${data.id} and company_id = ${companyId}
      `;
      requestId = q[0]?.request_id ?? null;
      if (!requestId) {
        const cr = await sql<{ id: number; rfq_id: number | null }>`
          select id, rfq_id from customer_requests where quote_id = ${data.id} and company_id = ${companyId} limit 1
        `;
        requestId = cr[0]?.id ?? null;
        if (cr[0]?.rfq_id) rfqIds.push(cr[0].rfq_id);
      }
    }

    if (data.kind === "sale") {
      const s = await sql<{ quote_id: number | null }>`
        select quote_id from sales_orders where id = ${data.id} and company_id = ${companyId}
      `;
      quoteId = s[0]?.quote_id ?? null;
    }

    if (data.kind === "purchase") {
      const p = await sql<{ so_id: number | null; rfq_id: number | null }>`
        select so_id, rfq_id from purchase_orders where id = ${data.id} and company_id = ${companyId}
      `;
      soId = p[0]?.so_id ?? null;
      if (p[0]?.rfq_id) rfqIds.push(p[0].rfq_id);
    }

    if (data.kind === "invoice") {
      const inv = await sql<{ order_id: number | null; origin: string; kind: string }>`
        select order_id, origin, kind from invoices where id = ${data.id} and company_id = ${companyId}
      `;
      soId = inv[0]?.order_id ?? null;
      const origin = inv[0]?.origin ?? "";
      if (origin) {
        const so = await sql<{ id: number }>`
          select id from sales_orders where company_id = ${companyId} and name = ${origin} limit 1
        `;
        if (so[0]) soId = so[0].id;
        const po = await sql<{ id: number; so_id: number | null; rfq_id: number | null }>`
          select id, so_id, rfq_id from purchase_orders where company_id = ${companyId} and name = ${origin} limit 1
        `;
        if (po[0]) {
          poIds.push(po[0].id);
          soId = soId ?? po[0].so_id;
          if (po[0].rfq_id) rfqIds.push(po[0].rfq_id);
        }
      }
    }

    if (quoteId && !requestId) {
      const cr = await sql<{ id: number; rfq_id: number | null }>`
        select id, rfq_id from customer_requests where quote_id = ${quoteId} and company_id = ${companyId} limit 1
      `;
      requestId = cr[0]?.id ?? null;
      if (cr[0]?.rfq_id) rfqIds.push(cr[0].rfq_id);
      const q = await sql<{ request_id: number | null }>`select request_id from quotes where id = ${quoteId}`;
      requestId = requestId ?? q[0]?.request_id ?? null;
    }

    if (soId && !quoteId) {
      const s = await sql<{ quote_id: number | null }>`select quote_id from sales_orders where id = ${soId}`;
      quoteId = s[0]?.quote_id ?? null;
    }

    if (requestId) {
      const req = await sql<{ quote_id: number | null; rfq_id: number | null }>`
        select quote_id, rfq_id from customer_requests where id = ${requestId} and company_id = ${companyId}
      `;
      quoteId = quoteId ?? req[0]?.quote_id ?? null;
      if (req[0]?.rfq_id) rfqIds.push(req[0].rfq_id);
      const more = await sql<{ id: number }>`
        select id from vendor_rfqs where company_id = ${companyId} and request_id = ${requestId}
      `;
      for (const r of more) rfqIds.push(r.id);
    }

    if (quoteId) {
      const sos = await sql<{ id: number }>`
        select id from sales_orders where company_id = ${companyId} and quote_id = ${quoteId}
      `;
      for (const s of sos) soId = soId ?? s.id;
      const rf = await sql<{ id: number }>`
        select id from vendor_rfqs where company_id = ${companyId} and quote_id = ${quoteId}
      `;
      for (const r of rf) rfqIds.push(r.id);
    }

    if (soId) {
      const pos = await sql<{ id: number; rfq_id: number | null }>`
        select id, rfq_id from purchase_orders where company_id = ${companyId} and so_id = ${soId}
      `;
      for (const p of pos) {
        poIds.push(p.id);
        if (p.rfq_id) rfqIds.push(p.rfq_id);
      }
      const invs = await sql<{ id: number }>`
        select id from invoices where company_id = ${companyId} and order_id = ${soId}
      `;
      for (const i of invs) invoiceIds.push(i.id);
    }

    rfqIds = [...new Set(rfqIds)];
    if (rfqIds.length && !poIds.length) {
      for (const rid of rfqIds) {
        const named = await sql<{ name: string }>`select name from vendor_rfqs where id = ${rid}`;
        const rfqName = named[0]?.name ?? "";
        const pos = await sql<{ id: number }>`
          select id from purchase_orders
          where company_id = ${companyId}
            and (rfq_id = ${rid} or (${rfqName} <> '' and notes like ('Desde ' || ${rfqName} || '%')))
        `;
        for (const p of pos) poIds.push(p.id);
      }
    }

    poIds = [...new Set(poIds)];
    if (poIds.length) {
      const pos = await sql<{ id: number; name: string; so_id: number | null; rfq_id: number | null }>`
        select id, name, so_id, rfq_id from purchase_orders where company_id = ${companyId}
      `;
      for (const p of pos.filter((row) => poIds.includes(row.id))) {
        soId = soId ?? p.so_id;
        if (p.rfq_id) rfqIds.push(p.rfq_id);
        const invs = await sql<{ id: number }>`
          select id from invoices where company_id = ${companyId} and origin = ${p.name}
        `;
        for (const i of invs) invoiceIds.push(i.id);
      }
    }

    rfqIds = [...new Set(rfqIds)];
    poIds = [...new Set(poIds)];
    invoiceIds = [...new Set(invoiceIds)];

    const hops: DealHop[] = [];

    if (requestId) {
      const r = await sql<{ id: number; name: string }>`
        select id, name from customer_requests where id = ${requestId} and company_id = ${companyId}
      `;
      if (r[0]) pushUnique(hops, { kind: "request", id: r[0].id, name: r[0].name });
    }
    if (rfqIds.length) {
      const rows = await sql<{ id: number; name: string }>`
        select id, name from vendor_rfqs where company_id = ${companyId} order by id
      `;
      for (const r of rows.filter((row) => rfqIds.includes(row.id))) pushUnique(hops, { kind: "rfq", id: r.id, name: r.name });
    }
    if (quoteId) {
      const q = await sql<{ id: number; name: string }>`
        select id, name from quotes where id = ${quoteId} and company_id = ${companyId}
      `;
      if (q[0]) pushUnique(hops, { kind: "quote", id: q[0].id, name: q[0].name });
    }
    if (soId) {
      const s = await sql<{ id: number; name: string }>`
        select id, name from sales_orders where id = ${soId} and company_id = ${companyId}
      `;
      if (s[0]) pushUnique(hops, { kind: "sale", id: s[0].id, name: s[0].name });
    }
    if (poIds.length) {
      const rows = await sql<{ id: number; name: string }>`
        select id, name from purchase_orders where company_id = ${companyId} order by id
      `;
      for (const r of rows.filter((row) => poIds.includes(row.id))) pushUnique(hops, { kind: "purchase", id: r.id, name: r.name });
    }
    if (invoiceIds.length) {
      const rows = await sql<{ id: number; name: string; kind: string }>`
        select id, name, kind from invoices where company_id = ${companyId} order by id
      `;
      for (const r of rows.filter((row) => invoiceIds.includes(row.id))) {
        pushUnique(hops, {
          kind: "invoice",
          id: r.id,
          name: r.name,
          side: r.kind === "supplier" ? "supplier" : "customer",
        });
      }
    }

    const spine = hops.find((h) => h.kind === "request") ?? hops.find((h) => h.kind === "rfq") ?? hops[0];
    return { hops, line: formatDealLine(hops), spine: spine?.name ?? "", purpose: hops.some((h) => h.kind === "request") ? "sale" : "stock" };
  });

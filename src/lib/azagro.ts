import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSql, withTx } from "@/lib/db";
import { authMiddleware } from "@/lib/auth/middleware";

import { BANK_CATALOG, CREDIT_POLICY_CATALOG, TIIE_SEED } from "@/lib/erp/catalog";
import { syncCompaqCatalogs, linkSeedDestinos } from "@/lib/erp/compaq";
import { rememberTrade } from "@/lib/erp/links";
import { seedAcl, type AppRole } from "@/lib/erp/acl";
import { activeMember, assertCan, canSeeCosts, canSeeSalePrices, memberScope } from "@/lib/erp/acl";
import { applyInvoicePayment, issueMoraInvoice, policy } from "@/lib/erp/ops";
import { nearestRate } from "@/lib/erp/credit";
import { ensureInvoiceExtras, ensureStock, postStock, refreshInvoiceResidual, seedOpeningLedger } from "@/lib/erp/stock";
import { writeAudit } from "@/lib/erp/audit";

export type Role = AppRole;

export type Workspace = {
  companyId: number;
  companyName: string;
  joinCode: string;
  role: string;
  roleLabel?: string;
  userId: string;
  memberId?: number;
  memberCount: number;
  ownOnly?: boolean;
  displayName?: string;
  acl?: Record<string, "none" | "view" | "edit">;
};

type Sql = Awaited<ReturnType<typeof getSql>>;

async function membership(sql: Sql, userId: string) {
  const rows = await sql<{
    company_id: number;
    name: string;
    join_code: string;
    role: string;
  }>`
    select c.id as company_id, c.name, c.join_code, m.role
    from members m
    join companies c on c.id = m.company_id
    where m.user_id = ${userId} and m.status = 'active'
    limit 1
  `;
  return rows[0] ?? null;
}

export async function seedCompany(sql: Sql, companyId: number) {
  await sql`alter table company_settings add column if not exists seeded_at timestamptz`;
  await sql`
    insert into company_settings (company_id, legal_name)
    values (${companyId}, 'AZ INSUMOS AGRICOLAS SA DE CV')
    on conflict (company_id) do nothing
  `;
  const already = await sql<{ seeded_at: string | null }>`
    select seeded_at::text from company_settings where company_id = ${companyId}
  `;
  await sql`update companies set legal_name = 'AZ INSUMOS AGRICOLAS SA DE CV' where id = ${companyId}`;

  await syncCompaqCatalogs(sql, companyId);
  await linkSeedDestinos(sql, companyId);

  if (already[0]?.seeded_at) return;
  await sql`
    create table if not exists credit_policies (
      id serial primary key,
      company_id integer not null references companies(id) on delete cascade,
      code text not null,
      name text not null,
      spread numeric(8,4) not null default 0,
      fega_rate numeric(8,4) not null default 0,
      unique (company_id, code)
    )
  `;
  await sql`alter table sales_orders add column if not exists term_kind text not null default 'credit_days'`;
  await sql`alter table sales_orders add column if not exists invoice_days integer not null default 0`;
  await sql`alter table sales_orders add column if not exists credit_days integer not null default 0`;
  await sql`alter table sales_orders add column if not exists invoice_due date`;
  await sql`alter table sales_orders add column if not exists credit_due date`;
  await sql`alter table sales_orders add column if not exists route_kind text not null default 'own'`;
  await sql`alter table sales_orders add column if not exists asr_partner_id integer`;
  await sql`alter table sales_orders add column if not exists policy_code text not null default 'NONE'`;
  await sql`alter table sales_orders add column if not exists oc_cliente text not null default ''`;
  await sql`alter table sales_orders add column if not exists price_mode text not null default 'custom'`;
  await sql`alter table sales_lines add column if not exists uom text not null default ''`;
  await sql`alter table invoices add column if not exists credit_due date`;
  await sql`alter table invoices add column if not exists invoice_days integer`;
  await sql`alter table invoices add column if not exists credit_days integer`;
  await sql`alter table invoices add column if not exists policy_code text not null default 'NONE'`;
  for (const p of CREDIT_POLICY_CATALOG) {
    await sql`
      insert into credit_policies (company_id, code, name, spread, fega_rate)
      values (${companyId}, ${p.code}, ${p.name}, ${p.spread}, ${p.fega_rate})
      on conflict (company_id, code) do update set name = excluded.name, spread = excluded.spread, fega_rate = excluded.fega_rate
    `;
  }

  await sql`
    insert into locations (company_id, code, name, loc_type, address)
    values
      (${companyId}, 'BOD-CENTRAL', 'Bodega Central Azagro', 'internal', ''),
      (${companyId}, 'TRANSITO', 'En tránsito', 'transit', ''),
      (${companyId}, 'ENT-SL', 'Entrega SL Agrícola — Ruiz Cortinez', 'customer', 'Ruiz Cortinez'),
      (${companyId}, 'ENT-CACO', 'Entrega Caco — Los Mochis', 'customer', 'Los Mochis')
    on conflict (company_id, code) do nothing
  `;
  await linkSeedDestinos(sql, companyId);

  const green = await sql<{ id: number }>`
    select id from partners where company_id = ${companyId} and code in ('PV013', 'GREENHOW')
    order by case when code = 'PV013' then 0 else 1 end
    limit 1
  `;
  if (green[0]) {
    await sql`
      insert into locations (company_id, code, name, loc_type, partner_id)
      values (${companyId}, 'PROV-GREENHOW', 'En poder de Greenhow', 'supplier', ${green[0].id})
      on conflict (company_id, code) do nothing
    `;
  }

  for (const b of BANK_CATALOG) {
    const exists = await sql<{ id: number }>`
      select id from banks where company_id = ${companyId} and name = ${b.name} limit 1
    `;
    if (!exists[0]) {
      await sql`
        insert into banks (company_id, name, account, currency)
        values (${companyId}, ${b.name}, ${b.account}, ${b.currency})
      `;
    }
  }

  for (const [date, rate] of TIIE_SEED) {
    await sql`
      insert into tiie_rates (company_id, date, rate)
      values (${companyId}, ${date}, ${rate})
      on conflict (company_id, date) do nothing
    `;
  }

  try {
    const { seedExpenseCategories } = await import("@/lib/erp/expenses");
    await seedExpenseCategories(sql, companyId);
  } catch {
    /* tables may land via migration 0008 */
  }
  await sql`update company_settings set seeded_at = now() where company_id = ${companyId} and seeded_at is null`;
}

export async function ensureCompany(sql: Sql, companyId: number) {
  await sql`
    insert into company_settings (company_id)
    values (${companyId})
    on conflict (company_id) do nothing
  `;
}

function joinCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "AZ";
  for (let i = 0; i < 4; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

export const getWorkspace = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const m = await membership(sql, context.userId);
    if (!m) return { status: "none" as const, workspace: null as Workspace | null };
    await seedCompany(sql, m.company_id);
    const count = await sql<{ n: number }>`
      select count(*)::int as n from members where company_id = ${m.company_id}
    `;
    return {
      status: "ok" as const,
      workspace: {
        companyId: m.company_id,
        companyName: m.name,
        joinCode: m.role === "admin" ? m.join_code : "",
        role: m.role,
        userId: context.userId,
        memberCount: count[0]?.n ?? 1,
      },
    };
  });

export const createCompany = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ name: z.string().min(2).max(80) }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const existing = await membership(sql, context.userId);
    if (existing) throw new Error("Ya perteneces a una empresa");
    const anyCo = await sql<{ n: number }>`select count(*)::int as n from companies`;
    if ((anyCo[0]?.n ?? 0) > 0) {
      throw new Error("La empresa ya existe. Solicita acceso y un administrador te asignará rol.");
    }
    const code = joinCode();
    const inserted = await sql<{ id: number }>`
      insert into companies (name, join_code, created_by)
      values (${data.name.trim()}, ${code}, ${context.userId})
      returning id
    `;
    const id = inserted[0]!.id;
    const mem = await sql<{ id: number }>`
      insert into members (company_id, user_id, role, display_name, status)
      values (${id}, ${context.userId}, 'admin', 'Administrador', 'active')
      returning id
    `;
    await seedAcl(sql, mem[0]!.id, "admin");
    await seedCompany(sql, id);
    return { ok: true, joinCode: code };
  });

export const joinCompany = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ code: z.string().min(4).max(12) }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const existing = await membership(sql, context.userId);
    if (existing) throw new Error("Ya perteneces a una empresa");
    const co = await sql<{ id: number }>`
      select id from companies where join_code = ${data.code.trim().toUpperCase()}
    `;
    if (!co[0]) throw new Error("Clave de equipo no válida");
    // La clave de equipo ya no da acceso directo: deja una solicitud pendiente
    // que un administrador debe aprobar asignando rol.
    const already = await sql<{ id: number }>`
      select id from access_requests
      where user_id = ${context.userId} and company_id = ${co[0].id} and status = 'pending'
      limit 1
    `;
    if (!already[0]) {
      const profile = await sql<{ email: string; name: string }>`
        select "email" as email, "name" as name from "user" where "id" = ${context.userId} limit 1
      `;
      await sql`
        insert into access_requests (company_id, user_id, email, name)
        values (${co[0].id}, ${context.userId}, ${profile[0]?.email ?? ""}, ${profile[0]?.name ?? ""})
      `;
    }
    return { ok: true, pending: true };
  });

async function requireCompany(sql: Sql, userId: string) {
  const m = await membership(sql, userId);
  if (!m) throw new Error("Sin empresa");
  return m;
}

async function nextCodeFor(sql: Sql, companyId: number, prefix: string, table: "partners" | "products" = "partners") {
  const rows =
    table === "products"
      ? await sql<{ code: string }>`select code from products where company_id = ${companyId} and code like ${prefix + "%"}`
      : await sql<{ code: string }>`select code from partners where company_id = ${companyId} and code like ${prefix + "%"}`;
  let max = 0;
  for (const r of rows) {
    const n = Number(String(r.code).slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

export const getDashboard = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const me = await activeMember(sql, context.userId);
    const cid = me.company_id;
    await ensureStock(sql);
    const ar = await sql<{ total: string; overdue: string }>`
      select
        coalesce(sum(residual),0)::text as total,
        coalesce(sum(case when due_date < current_date then residual else 0 end),0)::text as overdue
      from invoices
      where company_id = ${cid} and kind = 'customer' and state = 'open'
    `;
    const ap = await sql<{ total: string }>`
      select coalesce(sum(residual),0)::text as total
      from invoices
      where company_id = ${cid} and kind = 'supplier' and state = 'open'
    `;
    const stock = await sql<{ own: string; supplier: string; transit: string; value: string }>`
      select
        coalesce(sum(q.quantity * coalesce(nullif(q.avg_cost,0), p.cost)) filter (where l.loc_type = 'internal'),0)::text as own,
        coalesce(sum(q.quantity * coalesce(nullif(q.avg_cost,0), p.cost)) filter (where l.loc_type = 'supplier'),0)::text as supplier,
        coalesce(sum(q.quantity * coalesce(nullif(q.avg_cost,0), p.cost)) filter (where l.loc_type = 'transit'),0)::text as transit,
        coalesce(sum(q.quantity * coalesce(nullif(q.avg_cost,0), p.cost)),0)::text as value
      from stock_quants q
      join products p on p.id = q.product_id
      join locations l on l.id = q.location_id
      where q.company_id = ${cid}
    `;
    const low = await sql<{ n: number }>`
      select count(*)::int as n from (
        select p.id
        from products p
        left join stock_quants q on q.product_id = p.id and q.company_id = p.company_id
        where p.company_id = ${cid}
        group by p.id, p.min_stock
        having coalesce(sum(q.quantity),0) < p.min_stock
      ) t
    `;
    const aging = await sql<{ bucket: string; amount: string }>`
      select bucket, coalesce(sum(residual),0)::text as amount from (
        select residual,
          case
            when due_date >= current_date then 'Por vencer'
            when current_date - due_date <= 30 then '1-30'
            when current_date - due_date <= 60 then '31-60'
            else '61+'
          end as bucket
        from invoices
        where company_id = ${cid} and kind = 'customer' and state = 'open'
      ) x
      group by bucket
    `;
    const recentInv = await sql<{
      id: number;
      name: string;
      kind: string;
      partner: string;
      residual: string;
      due_date: string;
      amount: string;
    }>`
      select i.id, i.name, i.kind, p.name as partner, i.residual::text, i.due_date::text, i.amount::text
      from invoices i
      join partners p on p.id = i.partner_id
      where i.company_id = ${cid}
      order by i.date desc, i.id desc
      limit 8
    `;
    const locStock = await sql<{ name: string; loc_type: string; value: string; qty: string }>`
      select l.name, l.loc_type,
        coalesce(sum(q.quantity * coalesce(nullif(q.avg_cost,0), p.cost)),0)::text as value,
        coalesce(sum(q.quantity),0)::text as qty
      from locations l
      left join stock_quants q on q.location_id = l.id
      left join products p on p.id = q.product_id
      where l.company_id = ${cid}
      group by l.id, l.name, l.loc_type
      order by l.loc_type, l.name
    `;
    const pending = await sql<{ po: number; so: number; overdue_n: number }>`
      select
        (select count(*)::int from purchase_orders where company_id = ${cid} and state <> 'done') as po,
        (select count(*)::int from sales_orders where company_id = ${cid} and state <> 'done') as so,
        (select count(*)::int from invoices where company_id = ${cid} and kind = 'customer' and state = 'open' and due_date < current_date) as overdue_n
    `;
    const cash = await sql<{ total: string }>`
      select coalesce(sum(
        b.opening + coalesce((select sum(amount) from bank_moves m where m.bank_id = b.id), 0)
      ), 0)::text as total
      from banks b
      where b.company_id = ${cid}
    `;
    // Cada quien ve solo las cifras de sus módulos: sin cartera no hay saldos,
    // sin bancos no hay caja, sin permiso de costos el valor de inventario va en cero.
    const seeCredit = me.acl.credit !== "none";
    const seeBanks = me.acl.banks !== "none";
    const seeCosts = canSeeCosts(me.role);
    return {
      ar: seeCredit ? Number(ar[0]?.total ?? 0) : 0,
      arOverdue: seeCredit ? Number(ar[0]?.overdue ?? 0) : 0,
      ap: seeCredit ? Number(ap[0]?.total ?? 0) : 0,
      stockValue: seeCosts ? Number(stock[0]?.value ?? 0) : 0,
      stockOwn: seeCosts ? Number(stock[0]?.own ?? 0) : 0,
      stockSupplier: seeCosts ? Number(stock[0]?.supplier ?? 0) : 0,
      stockTransit: seeCosts ? Number(stock[0]?.transit ?? 0) : 0,
      cash: seeBanks ? Number(cash[0]?.total ?? 0) : 0,
      lowStock: low[0]?.n ?? 0,
      pendingPo: pending[0]?.po ?? 0,
      pendingSo: pending[0]?.so ?? 0,
      overdueN: seeCredit ? pending[0]?.overdue_n ?? 0 : 0,
      aging: seeCredit ? aging.map((a) => ({ bucket: a.bucket, amount: Number(a.amount) })) : [],
      recentInv: seeCredit ? recentInv : [],
      locStock: locStock.map((l) => ({
        name: l.name,
        locType: l.loc_type,
        value: seeCosts ? Number(l.value) : 0,
        qty: Number(l.qty),
      })),
    };
  });

export const listPartners = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const m = await requireCompany(sql, context.userId);
    const me = await activeMember(sql, context.userId);
    if (me.acl.partners === "none") throw new Error("Sin permiso para ver este módulo");
    const scope = { own_only: me.own_only };
    const rows = await sql<{
      id: number;
      code: string;
      name: string;
      rfc: string;
      is_customer: boolean;
      is_supplier: boolean;
      credit_limit: string;
      payment_days: number;
      late_rate: string;
      email: string;
      phone: string;
      city: string;
      group_name: string;
      legal_name: string;
      ar: string;
      ap: string;
    }>`
      select p.*,
        coalesce((select sum(residual) from invoices i where i.partner_id = p.id and i.kind = 'customer' and i.state = 'open'),0)::text as ar,
        coalesce((select sum(residual) from invoices i where i.partner_id = p.id and i.kind = 'supplier' and i.state = 'open'),0)::text as ap
      from partners p
      where p.company_id = ${m.company_id}
        and (${scope.own_only} = false or p.seller_id = ${context.userId} or p.seller_id is null)
      order by p.name
    `;
    // Sin permiso de cartera no se ven saldos ni límites de crédito.
    if (me.acl.credit === "none") {
      return rows.map((r) => ({ ...r, ar: "0", ap: "0", credit_limit: "0" }));
    }
    return rows;
  });

export const savePartner = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      id: z.number().optional(),
      code: z.string().optional().default(""),
      name: z.string().min(1),
      rfc: z.string().optional().default(""),
      is_customer: z.boolean(),
      is_supplier: z.boolean(),
      credit_limit: z.number(),
      payment_days: z.number(),
      late_rate: z.number(),
      email: z.string().optional().default(""),
      phone: z.string().optional().default(""),
      city: z.string().optional().default(""),
      address: z.string().optional().default(""),
      notes: z.string().optional().default(""),
      group_name: z.string().optional().default(""),
      legal_name: z.string().optional().default(""),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const m = await requireCompany(sql, context.userId);
    await assertCan(sql, context.userId, "partners", "edit");
    let code = (data.code ?? "").trim().toUpperCase();
    if (!code) {
      const prefix = data.is_supplier && !data.is_customer ? "P-" : "C-";
      code = await nextCodeFor(sql, m.company_id, prefix);
    }
    if (data.id) {
      // Los campos que mueven crédito quedan en bitácora con anterior → nuevo.
      const before = await sql<{ credit_limit: string; payment_days: number; late_rate: string; name: string }>`
        select credit_limit::text, payment_days, late_rate::text, name
        from partners where id = ${data.id} and company_id = ${m.company_id}
      `;
      await sql`
        update partners set
          code = ${code}, name = ${data.name}, rfc = ${data.rfc ?? ""},
          is_customer = ${data.is_customer}, is_supplier = ${data.is_supplier},
          credit_limit = ${data.credit_limit}, payment_days = ${data.payment_days},
          late_rate = ${data.late_rate}, email = ${data.email ?? ""},
          phone = ${data.phone ?? ""}, city = ${data.city ?? ""},
          address = ${data.address ?? ""}, notes = ${data.notes ?? ""},
          group_name = ${data.group_name ?? ""}, legal_name = ${data.legal_name ?? ""}
        where id = ${data.id} and company_id = ${m.company_id}
      `;
      if (before[0]) {
        const cambios: string[] = [];
        if (Number(before[0].credit_limit) !== data.credit_limit)
          cambios.push(`límite ${Number(before[0].credit_limit)} → ${data.credit_limit}`);
        if (before[0].payment_days !== data.payment_days)
          cambios.push(`plazo ${before[0].payment_days} → ${data.payment_days} d`);
        if (Number(before[0].late_rate) !== data.late_rate)
          cambios.push(`tasa mora ${Number(before[0].late_rate)} → ${data.late_rate}`);
        if (cambios.length) {
          await writeAudit(sql, {
            companyId: m.company_id,
            userId: context.userId,
            action: "credito-cliente",
            entity: "partner",
            entityId: data.id,
            name: data.name,
            detail: cambios.join(" · "),
          });
        }
      }
      return { id: data.id };
    }
    const row = await sql<{ id: number }>`
      insert into partners (company_id, code, name, rfc, is_customer, is_supplier, credit_limit, payment_days, late_rate, email, phone, city, address, notes, group_name, legal_name, seller_id)
      values (${m.company_id}, ${code}, ${data.name}, ${data.rfc ?? ""}, ${data.is_customer}, ${data.is_supplier},
        ${data.credit_limit}, ${data.payment_days}, ${data.late_rate}, ${data.email ?? ""}, ${data.phone ?? ""}, ${data.city ?? ""},
        ${data.address ?? ""}, ${data.notes ?? ""}, ${data.group_name ?? ""}, ${data.legal_name ?? ""}, ${context.userId})
      returning id
    `;
    if (data.is_supplier) {
      await sql`
        insert into locations (company_id, code, name, loc_type, partner_id)
        values (${m.company_id}, ${"PROV-" + code}, ${"En poder de " + data.name}, 'supplier', ${row[0]!.id})
        on conflict (company_id, code) do nothing
      `;
    }
    return { id: row[0]!.id };
  });

export const nextPartnerCode = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ kind: z.enum(["cliente", "proveedor"]) }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const m = await requireCompany(sql, context.userId);
    await assertCan(sql, context.userId, "partners", "view");
    const prefix = data.kind === "proveedor" ? "P-" : "C-";
    return { code: await nextCodeFor(sql, m.company_id, prefix) };
  });

export const getPartner = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ id: z.number() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const m = await requireCompany(sql, context.userId);
    await assertCan(sql, context.userId, "partners", "view");
    const rows = await sql<{
      id: number;
      code: string;
      name: string;
      rfc: string;
      is_customer: boolean;
      is_supplier: boolean;
      credit_limit: string;
      payment_days: number;
      late_rate: string;
      email: string;
      phone: string;
      city: string;
      address: string;
      group_name: string;
      legal_name: string;
      notes: string;
      ar: string;
      ap: string;
    }>`
      select p.id, p.code, p.name, p.rfc, p.is_customer, p.is_supplier, p.credit_limit::text,
        p.payment_days, p.late_rate::text, p.email, p.phone, p.city, p.address, p.group_name, p.legal_name, p.notes,
        coalesce((select sum(residual) from invoices i where i.partner_id = p.id and i.kind = 'customer' and i.state = 'open'),0)::text as ar,
        coalesce((select sum(residual) from invoices i where i.partner_id = p.id and i.kind = 'supplier' and i.state = 'open'),0)::text as ap
      from partners p
      where p.company_id = ${m.company_id} and p.id = ${data.id}
      limit 1
    `;
    if (!rows[0]) throw new Error("No encontrado");
    const me = await activeMember(sql, context.userId);
    const partner =
      me.acl.credit === "none" ? { ...rows[0], ar: "0", ap: "0", credit_limit: "0" } : rows[0];
    const contacts = await sql<{
      id: number;
      name: string;
      role: string;
      email: string;
      phone: string;
      is_billing: boolean;
    }>`
      select id, name, role, email, phone, is_billing
      from partner_contacts
      where company_id = ${m.company_id} and partner_id = ${data.id}
      order by is_billing desc, id
    `;
    return { partner, contacts };
  });

export const listProducts = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const m = await requireCompany(sql, context.userId);
    const me = await activeMember(sql, context.userId);
    if (me.acl.products === "none") throw new Error("Sin permiso para ver este módulo");
    const rows = await sql<{
      id: number;
      code: string;
      name: string;
      category: string;
      product_type: string;
      uom: string;
      cost: string;
      list_price: string;
      min_stock: string;
      on_hand: string;
    }>`
      select p.*, coalesce(sum(q.quantity),0)::text as on_hand
      from products p
      left join stock_quants q on q.product_id = p.id
      where p.company_id = ${m.company_id}
      group by p.id
      order by p.code
    `;
    const hideCost = !canSeeCosts(me.role);
    const hidePrice = !canSeeSalePrices(me.role);
    if (!hideCost && !hidePrice) return rows;
    return rows.map((r) => ({
      ...r,
      cost: hideCost ? "0" : r.cost,
      list_price: hidePrice ? "0" : r.list_price,
    }));
  });

export const saveProduct = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      id: z.number().optional(),
      code: z.string().optional().default(""),
      name: z.string().min(1),
      category: z.string().optional().default(""),
      product_type: z.string().min(1),
      uom: z.string().min(1),
      cost: z.number(),
      list_price: z.number(),
      min_stock: z.number(),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const m = await requireCompany(sql, context.userId);
    await assertCan(sql, context.userId, "products", "edit");
    let code = (data.code ?? "").trim().toUpperCase();
    if (!code) code = await nextCodeFor(sql, m.company_id, "PRD-", "products");
    const category = data.category || (data.product_type === "INSUMO" ? "Insumos" : "Fertilizantes");
    if (data.id) {
      // Costo y precio de lista son sensibles: cambios manuales a bitácora.
      const before = await sql<{ cost: string; list_price: string }>`
        select cost::text, list_price::text from products where id = ${data.id} and company_id = ${m.company_id}
      `;
      await sql`
        update products set code=${code}, name=${data.name}, category=${category},
          product_type=${data.product_type}, uom=${data.uom}, cost=${data.cost},
          list_price=${data.list_price}, min_stock=${data.min_stock}
        where id = ${data.id} and company_id = ${m.company_id}
      `;
      if (before[0]) {
        const cambios: string[] = [];
        if (Number(before[0].cost) !== data.cost) cambios.push(`costo ${Number(before[0].cost)} → ${data.cost}`);
        if (Number(before[0].list_price) !== data.list_price)
          cambios.push(`precio lista ${Number(before[0].list_price)} → ${data.list_price}`);
        if (cambios.length) {
          await writeAudit(sql, {
            companyId: m.company_id,
            userId: context.userId,
            action: "precio-producto",
            entity: "product",
            entityId: data.id,
            name: `${code} ${data.name}`,
            detail: cambios.join(" · "),
          });
        }
      }
      return { id: data.id };
    }
    const row = await sql<{ id: number }>`
      insert into products (company_id, code, name, category, product_type, uom, cost, list_price, min_stock)
      values (${m.company_id}, ${code}, ${data.name}, ${category}, ${data.product_type}, ${data.uom}, ${data.cost}, ${data.list_price}, ${data.min_stock})
      returning id
    `;
    return { id: row[0]!.id };
  });

export const nextProductCode = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const m = await requireCompany(sql, context.userId);
    await assertCan(sql, context.userId, "products", "view");
    return { code: await nextCodeFor(sql, m.company_id, "PRD-", "products") };
  });

export const getProduct = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ id: z.number() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const m = await requireCompany(sql, context.userId);
    await assertCan(sql, context.userId, "products", "view");
    const rows = await sql<{
      id: number;
      code: string;
      name: string;
      category: string;
      product_type: string;
      uom: string;
      cost: string;
      list_price: string;
      min_stock: string;
      on_hand: string;
    }>`
      select p.id, p.code, p.name, p.category, p.product_type, p.uom, p.cost::text, p.list_price::text, p.min_stock::text,
        coalesce((select sum(quantity) from stock_quants q where q.product_id = p.id),0)::text as on_hand
      from products p
      where p.company_id = ${m.company_id} and p.id = ${data.id}
      limit 1
    `;
    if (!rows[0]) throw new Error("No encontrado");
    const me = await activeMember(sql, context.userId);
    return {
      ...rows[0],
      cost: canSeeCosts(me.role) ? rows[0].cost : "0",
      list_price: canSeeSalePrices(me.role) ? rows[0].list_price : "0",
    };
  });

export const listInventory = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const m = await requireCompany(sql, context.userId);
    const me = await activeMember(sql, context.userId);
    if (me.acl.inventory === "none") throw new Error("Sin permiso para ver este módulo");
    await ensureStock(sql);
    await seedOpeningLedger(sql, m.company_id, context.userId).catch(() => undefined);
    const quants = await sql<{
      id: number;
      product_id: number;
      product_code: string;
      product_name: string;
      uom: string;
      location_id: number;
      location_name: string;
      loc_type: string;
      quantity: string;
      cost: string;
    }>`
      select q.id, q.product_id, p.code as product_code, p.name as product_name, p.uom,
        q.location_id, l.name as location_name, l.loc_type, q.quantity::text,
        coalesce(nullif(q.avg_cost, 0), p.cost)::text as cost
      from stock_quants q
      join products p on p.id = q.product_id
      join locations l on l.id = q.location_id
      where q.company_id = ${m.company_id}
      order by p.code, l.name
    `;
    const locations = await sql<{
      id: number;
      code: string;
      name: string;
      loc_type: string;
      partner_id: number | null;
      partner_name: string | null;
      address: string;
    }>`
      select l.id, l.code, l.name, l.loc_type, l.partner_id, pt.name as partner_name, coalesce(l.address,'') as address
      from locations l
      left join partners pt on pt.id = l.partner_id
      where l.company_id = ${m.company_id}
      order by l.loc_type, l.name
    `;
    const moves = await sql<{
      id: number;
      ref: string;
      move_type: string;
      date: string;
      origin: string;
      product: string;
      quantity: string;
      unit_cost: string;
      from_name: string | null;
      to_name: string | null;
      product_id: number;
    }>`
      select sm.id, sm.ref, sm.move_type, sm.date::text, sm.origin, p.code as product,
        sm.quantity::text, coalesce(sm.unit_cost, 0)::text as unit_cost,
        lf.name as from_name, lt.name as to_name, sm.product_id
      from stock_moves sm
      join products p on p.id = sm.product_id
      left join locations lf on lf.id = sm.location_from
      left join locations lt on lt.id = sm.location_to
      where sm.company_id = ${m.company_id}
      order by sm.id desc
      limit 200
    `;
    await sql`alter table purchase_orders add column if not exists fulfill_kind text not null default 'inventory'`;
    const incoming = await sql<{
      product_id: number;
      product_code: string;
      product_name: string;
      uom: string;
      po_name: string;
      location: string;
      pending: string;
    }>`
      select pl.product_id, p.code as product_code, p.name as product_name, p.uom,
        po.name as po_name, l.name as location, (pl.qty - pl.qty_received)::text as pending
      from purchase_lines pl
      join purchase_orders po on po.id = pl.po_id
      join products p on p.id = pl.product_id
      join locations l on l.id = po.location_id
      where po.company_id = ${m.company_id}
        and po.state <> 'done'
        and coalesce(po.fulfill_kind,'inventory') <> 'direct'
        and pl.qty - pl.qty_received > 0.0001
      order by po.id desc
    `;
    const outgoing = await sql<{
      product_id: number;
      product_code: string;
      product_name: string;
      uom: string;
      so_name: string;
      location: string;
      pending: string;
    }>`
      select sl.product_id, p.code as product_code, p.name as product_name, p.uom,
        s.name as so_name, l.name as location, (sl.qty - sl.qty_delivered)::text as pending
      from sales_lines sl
      join sales_orders s on s.id = sl.so_id
      join products p on p.id = sl.product_id
      join locations l on l.id = s.location_id
      where s.company_id = ${m.company_id}
        and s.state = 'confirmed'
        and coalesce(s.route_kind,'own') = 'own'
        and sl.qty - sl.qty_delivered > 0.0001
      order by s.id desc
    `;
    const rawMismatch = await sql<{
      product_id: number;
      product_code: string;
      product_name: string;
      location_name: string;
      shown: string;
      ledger: string;
    }>`
      select q.product_id, p.code as product_code, p.name as product_name, l.name as location_name,
        q.quantity::text as shown,
        (
          coalesce((select sum(quantity) from stock_moves m
            where m.company_id = q.company_id and m.product_id = q.product_id and m.location_to = q.location_id), 0)
          - coalesce((select sum(quantity) from stock_moves m
            where m.company_id = q.company_id and m.product_id = q.product_id and m.location_from = q.location_id), 0)
        )::text as ledger
      from stock_quants q
      join products p on p.id = q.product_id
      join locations l on l.id = q.location_id
      where q.company_id = ${m.company_id} and l.loc_type <> 'customer'
    `;
    const mismatches = rawMismatch.filter((r) => Math.abs(Number(r.shown) - Number(r.ledger)) > 0.001);
    if (!canSeeCosts(me.role)) {
      return {
        quants: quants.map((q) => ({ ...q, cost: "0" })),
        locations,
        moves: moves.map((mv) => ({ ...mv, unit_cost: "0" })),
        incoming,
        outgoing,
        mismatches,
      };
    }
    return { quants, locations, moves, incoming, outgoing, mismatches };
  });

export const transferStock = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      productId: z.number(),
      fromId: z.number(),
      toId: z.number(),
      quantity: z.number().positive(),
    }),
  )
  .handler(async ({ context, data }) => {
    return withTx(async (sql) => {
    const m = await requireCompany(sql, context.userId);
    await assertCan(sql, context.userId, "inventory", "edit");
    const posted = await postStock(sql, {
      companyId: m.company_id,
      userId: context.userId,
      moveType: "internal",
      origin: "Traslado",
      productId: data.productId,
      quantity: data.quantity,
      locationFrom: data.fromId,
      locationTo: data.toId,
    });
    await writeAudit(sql, {
      companyId: m.company_id,
      userId: context.userId,
      action: "traslado",
      entity: "stock",
      name: posted.ref,
    });
    return { ok: true, ref: posted.ref };
    });
  });

export const adjustStock = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      productId: z.number(),
      locationId: z.number(),
      quantity: z.number().refine((n) => n !== 0, "La cantidad no puede ser 0"),
      note: z.string().optional().default(""),
    }),
  )
  .handler(async ({ context, data }) => {
    return withTx(async (sql) => {
    const m = await requireCompany(sql, context.userId);
    await assertCan(sql, context.userId, "inventory", "edit");
    const inbound = data.quantity > 0;
    const posted = await postStock(sql, {
      companyId: m.company_id,
      userId: context.userId,
      moveType: "adjust",
      origin: data.note || (inbound ? "Ajuste de entrada" : "Ajuste de salida"),
      productId: data.productId,
      quantity: Math.abs(data.quantity),
      locationFrom: inbound ? null : data.locationId,
      locationTo: inbound ? data.locationId : null,
    });
    await writeAudit(sql, {
      companyId: m.company_id,
      userId: context.userId,
      action: "ajuste",
      entity: "stock",
      name: posted.ref,
      detail: data.note || "",
    });
    return { ok: true, ref: posted.ref };
    });
  });

export const listPurchases = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const m = await requireCompany(sql, context.userId);
    const me = await activeMember(sql, context.userId);
    if (me.acl.purchases === "none") throw new Error("Sin permiso para ver este módulo");
    await sql`alter table purchase_orders add column if not exists fulfill_kind text not null default 'inventory'`;
    await sql`alter table purchase_orders add column if not exists so_id integer`;
    await sql`alter table purchase_lines add column if not exists deliver_to text not null default ''`;
    await sql`alter table purchase_lines add column if not exists uom text not null default ''`;
    await sql`alter table purchase_orders add column if not exists rfq_id integer`;
    const orders = await sql<{
      id: number;
      name: string;
      partner_id: number;
      partner: string;
      date: string;
      state: string;
      location: string;
      total: string;
      currency: string;
      fulfill_kind: string;
      so_id: number | null;
      so_name: string | null;
      rfq_id: number | null;
      rfq_name: string | null;
    }>`
      select po.id, po.name, po.partner_id, pt.name as partner, po.date::text, po.state, l.name as location, po.total::text, po.currency,
        coalesce(po.fulfill_kind,'inventory') as fulfill_kind,
        po.so_id, so.name as so_name, po.rfq_id, v.name as rfq_name
      from purchase_orders po
      join partners pt on pt.id = po.partner_id
      join locations l on l.id = po.location_id
      left join sales_orders so on so.id = po.so_id
      left join vendor_rfqs v on v.id = po.rfq_id
      where po.company_id = ${m.company_id}
      order by po.id desc
    `;
    const lines = await sql<{
      po_id: number;
      product: string;
      qty: string;
      qty_received: string;
      unit_price: string;
      uom: string;
      deliver_to: string;
    }>`
      select pl.po_id, (p.code || ' — ' || p.name) as product, pl.qty::text, pl.qty_received::text, pl.unit_price::text,
        coalesce(pl.uom, p.uom) as uom, coalesce(pl.deliver_to,'') as deliver_to
      from purchase_lines pl
      join products p on p.id = pl.product_id
      join purchase_orders po on po.id = pl.po_id
      where po.company_id = ${m.company_id}
    `;
    const suppliers = await sql<{ id: number; name: string; email: string; phone: string }>`
      select id, name, coalesce(email,'') as email, coalesce(phone,'') as phone
      from partners where company_id = ${m.company_id} and is_supplier = true order by name
    `;
    const products = await sql<{ id: number; code: string; name: string; cost: string; uom: string }>`
      select id, code, name, cost::text, uom from products where company_id = ${m.company_id} order by code
    `;
    const locations = await sql<{ id: number; name: string; loc_type: string }>`
      select id, name, loc_type from locations where company_id = ${m.company_id} order by name
    `;
    if (!canSeeCosts(me.role)) {
      return {
        orders: orders.map((o) => ({ ...o, total: "0" })),
        lines: lines.map((l) => ({ ...l, unit_price: "0" })),
        suppliers,
        products: products.map((p) => ({ ...p, cost: "0" })),
        locations,
      };
    }
    return { orders, lines, suppliers, products, locations };
  });

export const createPurchase = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      partnerId: z.number(),
      locationId: z.number(),
      notes: z.string().optional().default(""),
      currency: z.enum(["MXN", "USD"]).optional().default("MXN"),
      fxRate: z.number().positive().optional().default(1),
      fulfillKind: z.enum(["inventory", "direct"]).optional().default("inventory"),
      lines: z.array(
        z.object({
          productId: z.number(),
          qty: z.number().positive(),
          unitPrice: z.number().nonnegative(),
          uom: z.string().optional().default(""),
          deliverTo: z.string().optional().default(""),
        }),
      ).min(1),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const m = await requireCompany(sql, context.userId);
    await assertCan(sql, context.userId, "purchases", "edit");
    await ensureInvoiceExtras(sql);
    const n = await sql<{ c: number }>`select count(*)::int as c from purchase_orders where company_id = ${m.company_id}`;
    const name = `OC-${String((n[0]?.c ?? 0) + 1).padStart(4, "0")}`;
    const total = data.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0);
    await sql`alter table purchase_orders add column if not exists fulfill_kind text not null default 'inventory'`;
    await sql`alter table purchase_lines add column if not exists uom text not null default ''`;
    await sql`alter table purchase_lines add column if not exists deliver_to text not null default ''`;
    const po = await sql<{ id: number }>`
      insert into purchase_orders (company_id, name, partner_id, state, location_id, notes, total, currency, fx_rate, fulfill_kind)
      values (${m.company_id}, ${name}, ${data.partnerId}, 'confirmed', ${data.locationId}, ${data.notes ?? ""}, ${total},
        ${data.currency ?? "MXN"}, ${data.fxRate ?? 1}, ${data.fulfillKind ?? "inventory"})
      returning id
    `;
    for (const line of data.lines) {
      const uom = line.uom;
      await sql`
        insert into purchase_lines (po_id, product_id, qty, unit_price, uom, deliver_to)
        values (${po[0]!.id}, ${line.productId}, ${line.qty}, ${line.unitPrice}, ${uom}, ${line.deliverTo ?? ""})
      `;
    }
    await rememberTrade(sql, {
      companyId: m.company_id,
      partnerId: data.partnerId,
      kind: "buy",
      products: data.lines.map((l) => ({ productId: l.productId, unitPrice: l.unitPrice })),
      locationId: data.locationId,
    });
    const days = await sql<{ payment_days: number }>`select coalesce(payment_days,0) as payment_days from partners where id = ${data.partnerId}`;
    const due = new Date();
    due.setDate(due.getDate() + (days[0]?.payment_days ?? 0));
    const ic = await sql<{ c: number }>`select count(*)::int as c from invoices where company_id = ${m.company_id} and kind = 'supplier'`;
    const iname = `FP-${String((ic[0]?.c ?? 0) + 1).padStart(4, "0")}`;
    await sql`
      insert into invoices (company_id, kind, name, partner_id, due_date, state, amount, residual, origin, currency, created_by)
      values (${m.company_id}, 'supplier', ${iname}, ${data.partnerId}, ${due.toISOString().slice(0, 10)}, 'open', ${total}, ${total}, ${name}, ${data.currency ?? "MXN"}, ${context.userId})
    `;
    await writeAudit(sql, {
      companyId: m.company_id,
      userId: context.userId,
      action: "crear-oc",
      entity: "purchase",
      entityId: po[0]!.id,
      name,
      detail: `Total ${total.toFixed(2)} ${data.currency ?? "MXN"} · genera ${iname} por pagar`,
    });
    return { id: po[0]!.id, name };
  });

export const receivePurchase = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ poId: z.number() }))
  .handler(async ({ context, data }) => {
    return withTx(async (sql) => {
    const m = await requireCompany(sql, context.userId);
    await assertCan(sql, context.userId, "purchases", "edit");
    const po = await sql<{ id: number; location_id: number; name: string; state: string; fulfill_kind: string }>`
      select id, location_id, name, state, coalesce(fulfill_kind,'inventory') as fulfill_kind from purchase_orders
      where id = ${data.poId} and company_id = ${m.company_id}
      for update
    `;
    if (!po[0] || po[0].state === "done") throw new Error("Orden no disponible");
    if (po[0].fulfill_kind === "direct") {
      throw new Error("Esta OC es directa / brokeraje: no se recibe en bodega. La mercancía va en camino al cliente.");
    }
    const lines = await sql<{ id: number; product_id: number; qty: string; qty_received: string; unit_price: string }>`
      select id, product_id, qty::text, qty_received::text, unit_price::text from purchase_lines where po_id = ${po[0].id}
    `;
    for (const line of lines) {
      const pending = Number(line.qty) - Number(line.qty_received);
      if (pending <= 0) continue;
      await postStock(sql, {
        companyId: m.company_id,
        userId: context.userId,
        moveType: "receipt",
        origin: po[0].name,
        productId: line.product_id,
        quantity: pending,
        locationTo: po[0].location_id,
        unitCost: Number(line.unit_price),
      });
      await sql`update purchase_lines set qty_received = qty where id = ${line.id}`;
    }
    await sql`update purchase_orders set state = 'done' where id = ${po[0].id}`;
    const already = await sql<{ id: number }>`
      select id from invoices where company_id = ${m.company_id} and kind = 'supplier' and origin = ${po[0].name} limit 1
    `;
    if (!already[0]) {
      const total = await sql<{ total: string }>`select total::text from purchase_orders where id = ${po[0].id}`;
      const partner = await sql<{ partner_id: number }>`select partner_id from purchase_orders where id = ${po[0].id}`;
      const days = await sql<{ payment_days: number }>`
        select payment_days from partners where id = ${partner[0]!.partner_id}
      `;
      const due = new Date();
      due.setDate(due.getDate() + (days[0]?.payment_days ?? 30));
      const ic = await sql<{ c: number }>`select count(*)::int as c from invoices where company_id = ${m.company_id} and kind = 'supplier'`;
      const iname = `FP-${String((ic[0]?.c ?? 0) + 1).padStart(4, "0")}`;
      await sql`
        insert into invoices (company_id, kind, name, partner_id, due_date, state, amount, residual, origin, created_by)
        values (${m.company_id}, 'supplier', ${iname}, ${partner[0]!.partner_id}, ${due.toISOString().slice(0, 10)}, 'open', ${Number(total[0]?.total ?? 0)}, ${Number(total[0]?.total ?? 0)}, ${po[0].name}, ${context.userId})
      `;
    }
    await writeAudit(sql, {
      companyId: m.company_id,
      userId: context.userId,
      action: "recibir",
      entity: "purchase",
      entityId: po[0].id,
      name: po[0].name,
      detail: "Entró al kardex",
    });
    return { ok: true };
    });
  });

export const listSales = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const m = await requireCompany(sql, context.userId);
    const me = await activeMember(sql, context.userId);
    if (me.acl.sales === "none") throw new Error("Sin permiso para ver este módulo");
    const orders = await sql<{
      id: number;
      name: string;
      partner: string;
      date: string;
      state: string;
      location: string;
      total: string;
    }>`
      select so.id, so.name, pt.name as partner, so.date::text, so.state, l.name as location, so.total::text
      from sales_orders so
      join partners pt on pt.id = so.partner_id
      join locations l on l.id = so.location_id
      where so.company_id = ${m.company_id}
      order by so.id desc
    `;
    const lines = await sql<{
      so_id: number;
      product: string;
      qty: string;
      qty_delivered: string;
      unit_price: string;
    }>`
      select sl.so_id, p.code as product, sl.qty::text, sl.qty_delivered::text, sl.unit_price::text
      from sales_lines sl
      join products p on p.id = sl.product_id
      join sales_orders so on so.id = sl.so_id
      where so.company_id = ${m.company_id}
    `;
    const customers = await sql<{ id: number; name: string; credit_limit: string }>`
      select id, name, credit_limit::text from partners where company_id = ${m.company_id} and is_customer = true order by name
    `;
    const products = await sql<{ id: number; code: string; name: string; list_price: string }>`
      select id, code, name, list_price::text from products where company_id = ${m.company_id} order by code
    `;
    const locations = await sql<{ id: number; name: string; loc_type: string }>`
      select id, name, loc_type from locations where company_id = ${m.company_id} order by name
    `;
    // Almacén entrega pedidos pero no ve precios de venta ni límites de crédito.
    if (!canSeeSalePrices(me.role)) {
      return {
        orders: orders.map((o) => ({ ...o, total: "0" })),
        lines: lines.map((l) => ({ ...l, unit_price: "0" })),
        customers: customers.map((c) => ({ ...c, credit_limit: "0" })),
        products: products.map((p) => ({ ...p, list_price: "0" })),
        locations,
      };
    }
    return { orders, lines, customers, products, locations };
  });

export const createSale = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      partnerId: z.number(),
      locationId: z.number(),
      notes: z.string().optional().default(""),
      currency: z.enum(["MXN", "USD"]).optional().default("MXN"),
      fxRate: z.number().positive().optional().default(1),
      deliveryTo: z.string().optional().default(""),
      overrideCredit: z.boolean().optional().default(false),
      lines: z.array(
        z.object({
          productId: z.number(),
          qty: z.number().positive(),
          unitPrice: z.number().nonnegative(),
        }),
      ).min(1),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const m = await requireCompany(sql, context.userId);
    const member = await assertCan(sql, context.userId, "sales", "edit");
    const partner = await sql<{ credit_limit: string }>`
      select credit_limit::text from partners where id = ${data.partnerId} and company_id = ${m.company_id}
    `;
    const ar = await sql<{ ar: string }>`
      select coalesce(sum(residual),0)::text as ar from invoices
      where partner_id = ${data.partnerId} and kind = 'customer' and state = 'open'
    `;
    const total = data.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0);
    const limit = Number(partner[0]?.credit_limit ?? 0);
    const used = Number(ar[0]?.ar ?? 0);
    if (limit > 0 && used + total > limit) {
      if (!(data.overrideCredit && member.role === "admin")) {
        // El rechazo también deja rastro: quién intentó, con qué números.
        await writeAudit(sql, {
          companyId: m.company_id,
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
        companyId: m.company_id,
        userId: context.userId,
        action: "autorizar-credito",
        entity: "partner",
        entityId: data.partnerId,
        detail: `Límite ${limit.toFixed(0)} · saldo ${used.toFixed(0)} · pedido ${total.toFixed(0)}`,
      });
    }
    const n = await sql<{ c: number }>`select count(*)::int as c from sales_orders where company_id = ${m.company_id}`;
    const name = `PV-${String((n[0]?.c ?? 0) + 1).padStart(4, "0")}`;
    const so = await sql<{ id: number }>`
      insert into sales_orders (company_id, name, partner_id, state, location_id, notes, total, currency, fx_rate, delivery_to, owner_id)
      values (${m.company_id}, ${name}, ${data.partnerId}, 'confirmed', ${data.locationId}, ${data.notes ?? ""}, ${total},
        ${data.currency ?? "MXN"}, ${data.fxRate ?? 1}, ${data.deliveryTo ?? ""}, ${context.userId})
      returning id
    `;
    for (const line of data.lines) {
      await sql`
        insert into sales_lines (so_id, product_id, qty, unit_price)
        values (${so[0]!.id}, ${line.productId}, ${line.qty}, ${line.unitPrice})
      `;
    }
    await rememberTrade(sql, {
      companyId: m.company_id,
      partnerId: data.partnerId,
      kind: "sell",
      products: data.lines.map((l) => ({ productId: l.productId, unitPrice: l.unitPrice })),
      locationId: data.locationId,
    });
    return { id: so[0]!.id, name };
  });

export const deliverSale = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ soId: z.number() }))
  .handler(async ({ context, data }) => {
    return withTx(async (sql) => {
    const m = await requireCompany(sql, context.userId);
    await assertCan(sql, context.userId, "sales", "edit");
    const so = await sql<{
      id: number;
      location_id: number;
      name: string;
      state: string;
      partner_id: number;
      total: string;
      invoice_due: string | null;
      credit_due: string | null;
      invoice_days: number | null;
      credit_days: number | null;
      policy_code: string | null;
      date: string;
      route_kind: string;
    }>`
      select id, location_id, name, state, partner_id, total::text,
        invoice_due::text, credit_due::text, invoice_days, credit_days, policy_code, date::text,
        coalesce(route_kind,'own') as route_kind
      from sales_orders
      where id = ${data.soId} and company_id = ${m.company_id}
      for update
    `;
    if (!so[0] || so[0].state === "done") throw new Error("Pedido no disponible");
    if (so[0].state !== "confirmed") throw new Error("Confirma el pedido antes de entregar");
    const lines = await sql<{ id: number; product_id: number; qty: string; qty_delivered: string }>`
      select id, product_id, qty::text, qty_delivered::text from sales_lines where so_id = ${so[0].id}
    `;
    const direct = so[0].route_kind === "supplier" || so[0].route_kind === "asr";
    for (const line of lines) {
      const pending = Number(line.qty) - Number(line.qty_delivered);
      if (pending <= 0) continue;
      if (!direct) {
        await postStock(sql, {
          companyId: m.company_id,
          userId: context.userId,
          moveType: "delivery",
          origin: so[0].name,
          productId: line.product_id,
          quantity: pending,
          locationFrom: so[0].location_id,
        });
      }
      await sql`update sales_lines set qty_delivered = qty where id = ${line.id}`;
    }
    await sql`update sales_orders set state = 'done' where id = ${so[0].id}`;
    const today = new Date().toISOString().slice(0, 10);
    const invoiceDue = so[0].invoice_due || today;
    const creditDue = so[0].credit_due || invoiceDue;
    const ic = await sql<{ c: number }>`select count(*)::int as c from invoices where company_id = ${m.company_id} and kind = 'customer'`;
    const iname = `FV-${String((ic[0]?.c ?? 0) + 1).padStart(4, "0")}`;
    const soMeta = await sql<{ currency: string; fx_rate: string }>`
      select currency, fx_rate::text from sales_orders where id = ${so[0].id}
    `;
    const currency = soMeta[0]?.currency ?? "MXN";
    const fx = Number(soMeta[0]?.fx_rate ?? 1);
    const mxn = Number(so[0].total);
    // Foto de parámetros al emitir: TIIE del mes de emisión y las tasas
    // vigentes hoy. Con esto la utilidad y el costo financiero de ESTA
    // factura siguen siendo explicables aunque después cambien Ajustes.
    const pol = await policy(sql, m.company_id);
    const tiieRows = await sql<{ date: string; rate: string }>`
      select date::text, rate::text from tiie_rates where company_id = ${m.company_id} order by date
    `;
    const tiieIssue = nearestRate(
      tiieRows.map((r) => ({ date: r.date, rate: Number(r.rate) })),
      today,
      pol.defaultTiie,
    );
    const snap = JSON.stringify({
      tiieIssue,
      costSpread: pol.asrSpread,
      commissionRate: pol.asrCommission,
      financialDays: pol.creditDays,
      collectionSpread: pol.collectionSpread,
      fegaRate: pol.fegaRate,
      earlyPayDays: pol.earlyPayDays,
    });
    const inv = await sql<{ id: number }>`
      insert into invoices (
        company_id, kind, name, partner_id, due_date, credit_due, state, amount, residual, origin,
        currency, amount_fx, fx_agreed, inv_class, order_id, invoice_days, credit_days, policy_code,
        created_by, params_snap
      )
      values (
        ${m.company_id}, 'customer', ${iname}, ${so[0].partner_id}, ${invoiceDue}, ${creditDue}, 'open',
        ${mxn}, ${mxn}, ${so[0].name}, ${currency}, ${currency === "USD" && fx ? mxn / fx : 0}, ${fx}, 'product', ${so[0].id},
        ${so[0].invoice_days ?? 0}, ${so[0].credit_days ?? 0}, ${so[0].policy_code ?? "NONE"},
        ${context.userId}, ${snap}
      )
      returning id
    `;
    const sold = await sql<{ product_id: number; qty: string; unit_price: string }>`
      select product_id, qty::text, unit_price::text from sales_lines where so_id = ${so[0].id}
    `;
    for (const line of sold) {
      const amt = Number(line.qty) * Number(line.unit_price);
      await sql`
        insert into invoice_lines (invoice_id, product_id, qty, unit_price, amount)
        values (${inv[0]!.id}, ${line.product_id}, ${Number(line.qty)}, ${Number(line.unit_price)}, ${amt})
      `;
    }
    await writeAudit(sql, {
      companyId: m.company_id,
      userId: context.userId,
      action: "entregar",
      entity: "sale",
      entityId: so[0].id,
      name: so[0].name,
      detail: iname,
    });
    return { ok: true };
    });
  });

export const returnSale = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      soId: z.number(),
      reason: z.string().optional().default(""),
      lines: z.array(z.object({ productId: z.number(), qty: z.number().positive() })).min(1),
    }),
  )
  .handler(async ({ context, data }) => {
    const boot = await getSql();
    await boot`alter table sales_lines add column if not exists qty_returned numeric(14,3) not null default 0`;
    await boot`alter table invoices add column if not exists paid_date date`;
    await boot`alter table invoices add column if not exists inv_class text not null default 'product'`;
    await boot`alter table invoices add column if not exists order_id integer`;
    return withTx(async (sql) => {
    const m = await requireCompany(sql, context.userId);
    await assertCan(sql, context.userId, "sales", "edit");
    const so = await sql<{
      id: number;
      name: string;
      state: string;
      partner_id: number;
      location_id: number;
      route_kind: string;
      currency: string;
    }>`
      select id, name, state, partner_id, location_id, coalesce(route_kind,'own') as route_kind, currency
      from sales_orders where id = ${data.soId} and company_id = ${m.company_id}
      for update
    `;
    if (!so[0]) throw new Error("Pedido no encontrado");
    if (so[0].state !== "done") throw new Error("Solo se devuelve un pedido ya entregado.");
    const lines = await sql<{
      id: number;
      product_id: number;
      qty: string;
      qty_delivered: string;
      qty_returned: string;
      unit_price: string;
    }>`
      select id, product_id, qty::text, coalesce(qty_delivered,0)::text as qty_delivered,
        coalesce(qty_returned,0)::text as qty_returned, unit_price::text
      from sales_lines where so_id = ${so[0].id}
    `;
    const direct = so[0].route_kind === "supplier" || so[0].route_kind === "asr";
    let credit = 0;
    const posted: string[] = [];
    for (const take of data.lines) {
      const src = lines.find((l) => l.product_id === take.productId);
      if (!src) throw new Error("Esa partida no está en el pedido");
      const max = Number(src.qty_delivered) - Number(src.qty_returned);
      if (take.qty > max + 0.0001) {
        throw new Error(`No puedes devolver más de lo entregado (${max}).`);
      }
      if (!direct) {
        const mv = await postStock(sql, {
          companyId: m.company_id,
          userId: context.userId,
          moveType: "return",
          origin: so[0].name,
          productId: take.productId,
          quantity: take.qty,
          locationTo: so[0].location_id,
          date: new Date().toISOString().slice(0, 10),
        });
        posted.push(mv.ref);
      }
      await sql`update sales_lines set qty_returned = qty_returned + ${take.qty} where id = ${src.id}`;
      credit += take.qty * Number(src.unit_price);
    }
    if (credit <= 0.009) throw new Error("La devolución no tiene importe");

    const ncN = await sql<{ c: number }>`select count(*)::int as c from invoices where company_id = ${m.company_id} and name like 'NC-%'`;
    const ncName = `NC-${String((ncN[0]?.c ?? 0) + 1).padStart(4, "0")}`;
    const note = (data.reason || "").trim() || `Devolución de ${so[0].name}`;
    const nc = await sql<{ id: number }>`
      insert into invoices (
        company_id, kind, name, partner_id, due_date, state, amount, residual, origin,
        currency, order_id, inv_class, created_by
      )
      values (
        ${m.company_id}, 'customer', ${ncName}, ${so[0].partner_id}, ${new Date().toISOString().slice(0, 10)},
        'open', ${-credit}, ${-credit}, ${so[0].name}, ${so[0].currency}, ${so[0].id}, 'product', ${context.userId}
      )
      returning id
    `;
    for (const take of data.lines) {
      const src = lines.find((l) => l.product_id === take.productId)!;
      const amt = take.qty * Number(src.unit_price);
      await sql`
        insert into invoice_lines (invoice_id, product_id, qty, unit_price, amount)
        values (${nc[0]!.id}, ${take.productId}, ${take.qty}, ${Number(src.unit_price)}, ${-amt})
      `;
    }

    const fv = await sql<{ id: number; residual: string; name: string }>`
      select id, residual::text, name from invoices
      where company_id = ${m.company_id} and order_id = ${so[0].id} and kind = 'customer' and name like 'FV-%'
      order by id desc limit 1
    `;
    let applied = 0;
    if (fv[0] && Number(fv[0].residual) > 0.009) {
      applied = Math.min(credit, Number(fv[0].residual));
      const n = await sql<{ c: number }>`select count(*)::int as c from payments where company_id = ${m.company_id}`;
      const payName = `PAG-${String((n[0]?.c ?? 0) + 1).padStart(4, "0")}`;
      const pay = await sql<{ id: number }>`
        insert into payments (company_id, kind, name, partner_id, amount, memo, created_by, date)
        values (${m.company_id}, 'inbound', ${payName}, ${so[0].partner_id}, ${applied}, ${`Devolución ${ncName}`}, ${context.userId}, ${new Date().toISOString().slice(0, 10)})
        returning id
      `;
      await sql`insert into payment_allocs (payment_id, invoice_id, amount) values (${pay[0]!.id}, ${fv[0].id}, ${applied})`;
      await refreshInvoiceResidual(sql, fv[0].id);
    }
    const leftover = credit - applied;
    if (leftover <= 0.009) {
      await sql`update invoices set residual = 0, state = 'paid', paid_date = current_date where id = ${nc[0]!.id}`;
    } else {
      await sql`update invoices set residual = ${-leftover}, state = 'open' where id = ${nc[0]!.id}`;
    }

    await writeAudit(sql, {
      companyId: m.company_id,
      userId: context.userId,
      action: "devolver",
      entity: "sale",
      entityId: so[0].id,
      name: so[0].name,
      detail: `${ncName}${posted.length ? ` · ${posted.join(", ")}` : ""}`,
    });
    return {
      ok: true,
      nc: ncName,
      refs: posted,
      applied,
      leftover,
      direct,
      note,
    };
    });
  });

export const listInvoices = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ kind: z.enum(["customer", "supplier", "all"]).optional() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const m = await requireCompany(sql, context.userId);
    await assertCan(sql, context.userId, "credit", "view");
    const kind = data?.kind && data.kind !== "all" ? data.kind : null;
    return sql<{
      id: number;
      kind: string;
      name: string;
      partner: string;
      partner_id: number;
      partner_email: string;
      partner_phone: string;
      date: string;
      due_date: string;
      state: string;
      amount: string;
      residual: string;
      late_amount: string;
      origin: string;
      credit_days: number;
      days_overdue: number;
      days_left: number;
      currency: string;
    }>`
      select i.id, i.kind, i.name, p.name as partner, i.partner_id, p.email as partner_email, p.phone as partner_phone,
        i.date::text, i.due_date::text,
        i.state, i.amount::text, i.residual::text, i.late_amount::text, i.origin,
        coalesce(i.credit_days, 0)::int as credit_days,
        greatest(0, (current_date - i.due_date))::int as days_overdue,
        (i.due_date - current_date)::int as days_left,
        coalesce(i.currency,'MXN') as currency
      from invoices i
      join partners p on p.id = i.partner_id
      where i.company_id = ${m.company_id}
        and (${kind}::text is null or i.kind = ${kind})
      order by i.due_date, i.id
    `;
  });

export const registerPayment = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      invoiceId: z.number(),
      amount: z.number().positive(),
      bankId: z.number(),
      memo: z.string().optional().default(""),
      date: z.string().optional(),
      fxPaid: z.number().positive().optional(),
      fxTreatment: z.enum(["utilidad", "ajuste"]).optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    const boot = await getSql();
    await boot`alter table bank_moves add column if not exists kind text not null default 'ajuste'`;
    await boot`alter table bank_moves add column if not exists invoice_id integer`;
    await boot`alter table bank_moves add column if not exists payment_id integer`;
    await boot`alter table invoices add column if not exists fx_result numeric(14,2) not null default 0`;
    await boot`alter table invoices add column if not exists fx_treatment text not null default ''`;
    await ensureInvoiceExtras(boot);
    return withTx(async (sql) => {
      const m = await requireCompany(sql, context.userId);
      await assertCan(sql, context.userId, "banks", "edit");
      // Mismo camino que Bancos: applyInvoicePayment es la única puerta de cobro.
      return applyInvoicePayment(sql, {
        companyId: m.company_id,
        userId: context.userId,
        invoiceId: data.invoiceId,
        bankId: data.bankId,
        amount: data.amount,
        memo: data.memo ?? "",
        date: data.date,
        fxPaid: data.fxPaid,
        fxTreatment: data.fxTreatment,
      });
    });
  });

export const applyLateInterest = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ invoiceId: z.number() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const m = await requireCompany(sql, context.userId);
    await assertCan(sql, context.userId, "credit", "edit");
    // issueMoraInvoice guarda el cálculo en la FI y escribe la bitácora.
    const r = await issueMoraInvoice(sql, m.company_id, data.invoiceId, { requireCharge: true, userId: context.userId });
    return { charge: r.charge, name: r.name };
  });

export const getStatement = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ partnerId: z.number() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const m = await requireCompany(sql, context.userId);
    await assertCan(sql, context.userId, "statements", "view");
    const partner = await sql<{
      id: number;
      code: string;
      name: string;
      rfc: string;
      is_customer: boolean;
      is_supplier: boolean;
      credit_limit: string;
      late_rate: string;
      payment_days: number;
    }>`
      select id, code, name, rfc, is_customer, is_supplier, credit_limit::text, late_rate::text, payment_days
      from partners where id = ${data.partnerId} and company_id = ${m.company_id}
    `;
    if (!partner[0]) throw new Error("Partner no encontrado");
    const invoices = await sql<{
      name: string;
      kind: string;
      date: string;
      due_date: string;
      amount: string;
      residual: string;
      state: string;
      origin: string;
      late_amount: string;
    }>`
      select name, kind, date::text, due_date::text, amount::text, residual::text, state, origin, late_amount::text
      from invoices where partner_id = ${data.partnerId} and company_id = ${m.company_id}
      order by date, id
    `;
    const payments = await sql<{
      name: string;
      kind: string;
      date: string;
      amount: string;
      memo: string;
    }>`
      select name, kind, date::text, amount::text, memo
      from payments where partner_id = ${data.partnerId} and company_id = ${m.company_id}
      order by date, id
    `;
    return { partner: partner[0], invoices, payments };
  });

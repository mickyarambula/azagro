import { creditDetail, creditExceededMessage, creditExceededSummary, creditExposure, creditRoom } from "@/lib/erp/credit-limit";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSql, withTx } from "@/lib/db";
import { authMiddleware } from "@/lib/auth/middleware";

import { BANK_CATALOG, CREDIT_POLICY_CATALOG, TIIE_SEED } from "@/lib/erp/catalog";
import { syncCompaqCatalogs, linkSeedDestinos } from "@/lib/erp/compaq";
import { rememberTrade } from "@/lib/erp/links";
import { seedAcl, type AppRole } from "@/lib/erp/acl";
import { activeMember, assertCan, canRevert, canSeeCosts, canSeeSalePrices, memberScope } from "@/lib/erp/acl";
import { applyInvoicePayment, issueMoraInvoice, policy } from "@/lib/erp/ops";
import { addDays, nearestRate, NO_MORA_POLICY, requireRate } from "@/lib/erp/credit";
import { avgCostAt, deliveredUnitCost, ensureInvoiceExtras, ensureStock, postStock, refreshInvoiceResidual, seedOpeningLedger } from "@/lib/erp/stock";
import { nextDocFolio } from "@/lib/erp/folios";
import { costToMxn, fxAt, isUsdFx, loadFxTable, missingFxMessage, receiptUnitCostMxn, saleToMxn, supplierInvoiceAmounts } from "@/lib/erp/fx";
import { writeAudit } from "@/lib/erp/audit";
import { ensureRefCost, resolveCost } from "@/lib/erp/cost";
import { purchaseLineGaps, salesLineGaps } from "@/lib/erp/parciales";
import { todayMx } from "@/lib/utils";
import { circuitTerms, inheritCircuit } from "@/lib/erp/circuits";
import { seedCircuits } from "@/lib/erp/circuits-seed";
import { computeDues, TERM_KINDS, type TermKind } from "@/lib/erp/order-terms";
import { guardSaleTerms } from "@/lib/erp/sale-terms";

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

/**
 * Candado de unicidad de folios (corre también en PGLite, donde no aplican
 * las migraciones de producción): una colisión de folios truena en vez de
 * crear dos documentos con el mismo nombre. Las importadas de Compaq quedan
 * fuera (folios de terceros); su unicidad la da cutover_key.
 */
async function ensureFolioLocks(sql: Sql) {
  await sql`alter table invoices add column if not exists cutover_key text`;
  const locks = [
    `create unique index if not exists invoices_folio_uq on invoices (company_id, name) where cutover_key is null`,
    `create unique index if not exists sales_orders_folio_uq on sales_orders (company_id, name)`,
    `create unique index if not exists purchase_orders_folio_uq on purchase_orders (company_id, name)`,
    `create unique index if not exists quotes_folio_uq on quotes (company_id, name)`,
    `create unique index if not exists payments_folio_uq on payments (company_id, name)`,
    `create unique index if not exists stock_moves_ref_uq on stock_moves (company_id, ref)`,
  ];
  for (const lock of locks) {
    try {
      await sql.query(lock);
    } catch (err) {
      // Un candado que no se puede crear (tabla aún sin migrar, duplicado
      // heredado) no debe tirar el arranque; se reintenta al siguiente boot.
      console.error("folio lock", err);
    }
  }
}

export async function seedCompany(sql: Sql, companyId: number) {
  await sql`alter table company_settings add column if not exists seeded_at timestamptz`;
  await ensureFolioLocks(sql);
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
  // Antes del "ya sembrada": una empresa que nació sin catálogo lo recibe al siguiente inicio de sesión.
  await seedCircuits(sql, companyId);

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
  await sql`alter table sales_orders add column if not exists policy_code text`;
  await sql`alter table sales_orders add column if not exists oc_cliente text not null default ''`;
  await sql`alter table sales_orders add column if not exists price_mode text not null default 'custom'`;
  await sql`alter table sales_lines add column if not exists uom text not null default ''`;
  await sql`alter table invoices add column if not exists credit_due date`;
  await sql`alter table invoices add column if not exists invoice_days integer`;
  await sql`alter table invoices add column if not exists credit_days integer`;
  await sql`alter table invoices add column if not exists policy_code text`;
  // Paso 1 del catálogo de circuitos: etiqueta por documento (migración 0025).
  await sql`alter table sales_orders add column if not exists circuit_code text`;
  await sql`alter table invoices add column if not exists circuit_code text`;
  for (const p of CREDIT_POLICY_CATALOG) {
    await sql`
      insert into credit_policies (company_id, code, name)
      values (${companyId}, ${p.code}, ${p.name})
      on conflict (company_id, code) do update set name = excluded.name
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
    const today = todayMx();
    // Cartera propia (own_only): un vendedor ve solo lo suyo — mismo patrón
    // que listQuotes / listOrders / listInvoices / getUpcomingDue. Un cliente
    // sin vendedor asignado se cuenta para todos (nadie se queda huérfano).
    const ar = await sql<{ total: string; overdue: string }>`
      select
        coalesce(sum(i.residual),0)::text as total,
        coalesce(sum(case when i.due_date < ${today}::date then i.residual else 0 end),0)::text as overdue
      from invoices i
      join partners p on p.id = i.partner_id
      -- SOLO LO QUE EL CLIENTE DEBE (19-sep-2026). Una nota de crédito nace
      -- con importe NEGATIVO y queda open mientras su crédito no se aplique,
      -- así que entraba aquí y restaba de lo que el cliente debe sin que nadie
      -- lo hubiera decidido — y en el conteo de vencidas se contaba como UNA
      -- FACTURA VENCIDA MÁS. Lo que el cliente tiene a su favor se enseña
      -- aparte (aFavor del estado de cuenta), no escondido dentro del saldo.
      where i.company_id = ${cid} and i.kind = 'customer' and i.state = 'open' and i.amount > 0
        and (${me.own_only} = false or p.seller_id = ${context.userId} or p.seller_id is null)
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
    // Para el inicio (bandeja de atención): la lista con nombres, no solo el
    // conteo — antes había que ir a Inventario a ver de qué producto se trata.
    const lowList = await sql<{ code: string; name: string; qty: string; min: string }>`
      select p.code, p.name, coalesce(sum(q.quantity),0)::text as qty, p.min_stock::text as min
      from products p
      left join stock_quants q on q.product_id = p.id and q.company_id = p.company_id
      where p.company_id = ${cid}
      group by p.id, p.code, p.name, p.min_stock
      having coalesce(sum(q.quantity),0) < p.min_stock
      order by (p.min_stock - coalesce(sum(q.quantity),0)) desc
      limit 8
    `;
    const aging = await sql<{ bucket: string; amount: string }>`
      select bucket, coalesce(sum(residual),0)::text as amount from (
        select residual,
          case
            when due_date >= ${today}::date then 'Por vencer'
            when ${today}::date - due_date <= 30 then '1-30'
            when ${today}::date - due_date <= 60 then '31-60'
            else '61+'
          end as bucket
        from invoices
        -- Sin las notas de crédito, por lo mismo de arriba: una NC caía en
        -- «Por vencer» el día que nacía y migraba a «1-30», «31-60» y «61+»
        -- como un importe negativo dentro de la antigüedad de la cartera.
        where company_id = ${cid} and kind = 'customer' and state = 'open' and amount > 0
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
    // Solo ubicaciones CON existencia: antes listaba todas, con o sin
    // producto, y salían "bodegas en cero" por construcción de la consulta.
    const locStock = await sql<{ name: string; loc_type: string; value: string; qty: string }>`
      select l.name, l.loc_type,
        coalesce(sum(q.quantity * coalesce(nullif(q.avg_cost,0), p.cost)),0)::text as value,
        coalesce(sum(q.quantity),0)::text as qty
      from locations l
      left join stock_quants q on q.location_id = l.id
      left join products p on p.id = q.product_id
      where l.company_id = ${cid}
      group by l.id, l.name, l.loc_type
      having coalesce(sum(q.quantity),0) > 0.0001
      order by l.loc_type, l.name
    `;
    const pending = await sql<{ po: number; so: number; overdue_n: number }>`
      select
        (select count(*)::int from purchase_orders where company_id = ${cid} and state not in ('done','cancelled')) as po,
        (select count(*)::int from sales_orders so join partners p on p.id = so.partner_id
          where so.company_id = ${cid} and so.state not in ('done','cancelled')
            and (${me.own_only} = false or p.seller_id = ${context.userId} or p.seller_id is null)) as so,
        (select count(*)::int from invoices i join partners p on p.id = i.partner_id
          where i.company_id = ${cid} and i.kind = 'customer' and i.state = 'open' and i.amount > 0 and i.due_date < ${today}::date
            and (${me.own_only} = false or p.seller_id = ${context.userId} or p.seller_id is null)) as overdue_n
    `;
    // Cada cuenta lleva SU moneda (A.1b/A.1c): la caja se suma por moneda, nunca pesos con dólares en un número.
    const cashByCur = await sql<{ currency: string; total: string }>`
      select coalesce(b.currency,'MXN') as currency, coalesce(sum(
        b.opening + coalesce((select sum(amount) from bank_moves m where m.bank_id = b.id), 0)
      ), 0)::text as total
      from banks b
      where b.company_id = ${cid}
      group by coalesce(b.currency,'MXN')
    `;
    const cash = [{ total: cashByCur.find((c) => c.currency !== "USD")?.total ?? "0" }];
    const cashUsd = Number(cashByCur.find((c) => c.currency === "USD")?.total ?? 0);
    // Lo que de eso está en dólares (documentos USD, en su moneda): el residual en pesos entre el TC pactado.
    const usdDocs = await sql<{ ar_usd: string; ap_usd: string }>`
      select
        coalesce(sum(case when i.kind = 'customer' then i.residual / i.fx_agreed else 0 end), 0)::text as ar_usd,
        coalesce(sum(case when i.kind = 'supplier' then i.residual / i.fx_agreed else 0 end), 0)::text as ap_usd
      from invoices i
      join partners p on p.id = i.partner_id
      -- Una NC en dólares sí baja la exposición (es saldo a favor del cliente
      -- en esa moneda), así que aquí NO se filtra el signo: lo que se filtra es
      -- lo mismo de siempre, que haya TC usable.
      where i.company_id = ${cid} and i.state = 'open' and coalesce(i.currency,'MXN') = 'USD' and i.fx_agreed > 1
        and (i.kind = 'supplier' or ${me.own_only} = false or p.seller_id = ${context.userId} or p.seller_id is null)
    `;
    // "Cartera propia" deja a un cliente sin vendedor visible para todos los
    // vendedores por diseño (nadie se queda huérfano de nadie) — pero eso
    // mismo puede esconder que nadie se hizo cargo. Aviso visible, no filtrado.
    const orphan = await sql<{ n: number }>`
      select count(*)::int as n from partners where company_id = ${cid} and is_customer = true and seller_id is null
    `;
    // Decisión 23: cuántas facturas de proveedor quedan del defecto viejo —
    // deuda de órdenes que todavía no se reciben. Se deriva, no hay columna;
    // el número baja solo conforme se reciben o se cancelan esas órdenes.
    // Paso 7 (Decisión 39): NC que nacieron de una reversa y siguen sin folio
    // fiscal. Para el SAT esa venta sigue viva hasta que alguien la timbre en
    // Compaq y capture aquí su folio. Se deriva; se limpia sola al capturarlo.
    const ncSinTimbrar = await sql<{ n: number }>`
      select count(*)::int as n from invoices
      where company_id = ${cid} and kind = 'customer' and name like 'NC-%' and reverses_id is not null
        and coalesce(folio_fiscal,'') = '' and coalesce(uuid_fiscal,'') = ''
    `;
    // Paso 8 (Decisión 41): NC de devolución revertidas que estaban timbradas
    // y siguen sin cancelarse ante el SAT. Para el SAT esa devolución sigue
    // viva hasta que alguien la cancele en Compaq y capture aquí la fecha.
    const ncPendientesSat = await sql<{ n: number }>`
      select count(*)::int as n from invoices
      where company_id = ${cid} and kind = 'customer' and name like 'NC-%' and state = 'reversed' and reverses_id is null
        and (coalesce(folio_fiscal,'') <> '' or coalesce(uuid_fiscal,'') <> '') and sat_cancelled_at is null
    `;
    // BLOQUE DE PARCIALES, paso 1.3: con recepción parcial, una FP legítima
    // también convive con su OC en 'confirmed' (todavía falta recibir el
    // resto) — el po.state solo ya no basta. `event_ref is null` la limita a
    // deuda huérfana DE VERDAD (nacida antes de este bloque, sin evento):
    // toda FP nueva nace con su event_ref puesto y nunca se marca.
    const fpSinRecibir = await sql<{ n: number }>`
      select count(*)::int as n
      from invoices i
      where i.company_id = ${cid} and i.kind = 'supplier' and i.state <> 'reversed' and i.event_ref is null
        and exists (
          select 1 from purchase_orders po
          where po.company_id = i.company_id and po.name = i.origin
            and po.state not in ('done','cancelled')
        )
    `;
    // Lo que vence en los próximos 7 días — el susto de la semana, no del mes.
    const payableWeek = await sql<{ total: string }>`
      select coalesce(sum(residual),0)::text as total
      from invoices
      where company_id = ${cid} and kind = 'supplier' and state = 'open'
        and due_date >= ${today}::date and due_date <= ${today}::date + 7
    `;
    // Pedidos confirmados con algo pendiente de entregar (cuenta lo cerrado
    // corto como ya resuelto, paso 7 de PARCIALES.md): cuántos y el más viejo.
    const confirmedNotDelivered = await sql<{ n: number; oldest: number | null }>`
      select count(*)::int as n, max(${today}::date - so.date) as oldest
      from sales_orders so
      join partners p on p.id = so.partner_id
      where so.company_id = ${cid} and so.state = 'confirmed'
        and (${me.own_only} = false or p.seller_id = ${context.userId} or p.seller_id is null)
        and exists (
          select 1 from sales_lines sl
          where sl.so_id = so.id and sl.qty_delivered + coalesce(sl.qty_closed_short,0) < sl.qty - 0.0001
        )
    `;
    // Cada quien ve solo las cifras de sus módulos: sin cartera no hay saldos,
    // sin bancos no hay caja, sin permiso de costos el valor de inventario va en cero.
    const seeCredit = me.acl.credit !== "none";
    const seeBanks = me.acl.banks !== "none";
    const seeCosts = canSeeCosts(me.role);
    const seePartners = me.acl.partners !== "none";
    // Paso 6 de PARCIALES.md (Decisión 51): la misma cuenta con la que
    // saveOrder decide si un pedido cabe, resumida para el inicio. Cartera
    // propia: cada vendedor ve sus clientes pasados de línea, no los de todos.
    const creditExceeded = seeCredit
      ? await creditExceededSummary(sql, cid, { ownOnly: me.own_only, userId: context.userId })
      : { n: 0, amount: 0 };
    // Decisión 47: en bodega propia entregar no factura — la mercancía que
    // ya salió y todavía no se facturó es normal, pero es dinero parado.
    // salesLineGaps es compartida con /inventory (company-wide a propósito
    // ahí); no distingue vendedor, así que con cartera propia esta cifra se
    // oculta en vez de enseñar el total de todos como si fuera el de uno.
    const porFacturarRows = seeCredit && !me.own_only ? (await salesLineGaps(sql, cid)).porFacturar : [];
    const deliveredNotInvoiced = {
      n: porFacturarRows.length,
      amount: porFacturarRows.reduce((s, r) => s + r.porFacturar * r.unitPrice, 0),
    };
    return {
      ar: seeCredit ? Number(ar[0]?.total ?? 0) : 0,
      arOverdue: seeCredit ? Number(ar[0]?.overdue ?? 0) : 0,
      ap: seeCredit ? Number(ap[0]?.total ?? 0) : 0,
      stockValue: seeCosts ? Number(stock[0]?.value ?? 0) : 0,
      stockOwn: seeCosts ? Number(stock[0]?.own ?? 0) : 0,
      stockSupplier: seeCosts ? Number(stock[0]?.supplier ?? 0) : 0,
      stockTransit: seeCosts ? Number(stock[0]?.transit ?? 0) : 0,
      cash: seeBanks ? Number(cash[0]?.total ?? 0) : 0,
      cashUsd: seeBanks ? cashUsd : 0,
      arUsd: seeCredit ? Number(usdDocs[0]?.ar_usd ?? 0) : 0,
      apUsd: seeCredit ? Number(usdDocs[0]?.ap_usd ?? 0) : 0,
      payableWeek: seeCredit ? Number(payableWeek[0]?.total ?? 0) : 0,
      lowStock: low[0]?.n ?? 0,
      lowStockList: lowList.map((l) => ({ code: l.code, name: l.name, qty: Number(l.qty), min: Number(l.min) })),
      pendingPo: pending[0]?.po ?? 0,
      pendingSo: pending[0]?.so ?? 0,
      overdueN: seeCredit ? pending[0]?.overdue_n ?? 0 : 0,
      orphanCustomers: seePartners ? orphan[0]?.n ?? 0 : 0,
      fpSinRecibir: seeCredit ? fpSinRecibir[0]?.n ?? 0 : 0,
      ncSinTimbrar: seeCredit ? ncSinTimbrar[0]?.n ?? 0 : 0,
      ncPendientesSat: seeCredit ? ncPendientesSat[0]?.n ?? 0 : 0,
      creditExceededN: creditExceeded.n,
      creditExceededAmount: creditExceeded.amount,
      deliveredNotInvoicedN: deliveredNotInvoiced.n,
      deliveredNotInvoicedAmount: deliveredNotInvoiced.amount,
      confirmedNotDeliveredN: confirmedNotDelivered[0]?.n ?? 0,
      confirmedNotDeliveredOldestDays: confirmedNotDelivered[0]?.oldest ?? 0,
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
      policy_code: string | null;
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
      // Decisión 67: vacío es vacío (sin plazo), nunca 0 = contado por omisión.
      payment_days: z.number().nullable(),
      late_rate: z.number(),
      email: z.string().optional().default(""),
      phone: z.string().optional().default(""),
      city: z.string().optional().default(""),
      address: z.string().optional().default(""),
      notes: z.string().optional().default(""),
      group_name: z.string().optional().default(""),
      legal_name: z.string().optional().default(""),
      // Decisión 73: la política de cobro del cliente vive aquí. Vacío = sin
      // política; un pedido a crédito la pedirá. Nunca se supone.
      policy_code: z.string().optional().default(""),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const m = await requireCompany(sql, context.userId);
    await assertCan(sql, context.userId, "partners", "edit");
    const policyCode = (data.policy_code ?? "").trim();
    if (policyCode) {
      const pol = await sql<{ code: string }>`select code from credit_policies where company_id = ${m.company_id} and code = ${policyCode}`;
      if (!pol[0]) throw new Error(`La política de cobro «${policyCode}» no existe en Ajustes → Políticas de cobro.`);
    }
    let code = (data.code ?? "").trim().toUpperCase();
    if (!code) {
      const prefix = data.is_supplier && !data.is_customer ? "P-" : "C-";
      code = await nextCodeFor(sql, m.company_id, prefix);
    }
    if (data.id) {
      // Los campos que mueven crédito quedan en bitácora con anterior → nuevo.
      const before = await sql<{ credit_limit: string; payment_days: number | null; late_rate: string; name: string }>`
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
          group_name = ${data.group_name ?? ""}, legal_name = ${data.legal_name ?? ""},
          policy_code = ${policyCode || null}
        where id = ${data.id} and company_id = ${m.company_id}
      `;
      if (before[0]) {
        const cambios: string[] = [];
        if (Number(before[0].credit_limit) !== data.credit_limit)
          cambios.push(`límite ${Number(before[0].credit_limit)} → ${data.credit_limit}`);
        if (before[0].payment_days !== data.payment_days)
          cambios.push(`plazo ${before[0].payment_days ?? "sin plazo"} → ${data.payment_days ?? "sin plazo"}${data.payment_days == null ? "" : " d"}`);
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
      insert into partners (company_id, code, name, rfc, is_customer, is_supplier, credit_limit, payment_days, late_rate, email, phone, city, address, notes, group_name, legal_name, seller_id, policy_code)
      values (${m.company_id}, ${code}, ${data.name}, ${data.rfc ?? ""}, ${data.is_customer}, ${data.is_supplier},
        ${data.credit_limit}, ${data.payment_days}, ${data.late_rate}, ${data.email ?? ""}, ${data.phone ?? ""}, ${data.city ?? ""},
        ${data.address ?? ""}, ${data.notes ?? ""}, ${data.group_name ?? ""}, ${data.legal_name ?? ""}, ${context.userId}, ${policyCode || null})
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
      policy_code: string;
      ar: string;
      ap: string;
    }>`
      select p.id, p.code, p.name, p.rfc, p.is_customer, p.is_supplier, p.credit_limit::text,
        p.payment_days, p.late_rate::text, p.email, p.phone, p.city, p.address, p.group_name, p.legal_name, p.notes, coalesce(p.policy_code,'') as policy_code,
        coalesce((select sum(residual) from invoices i where i.partner_id = p.id and i.kind = 'customer' and i.state = 'open'),0)::text as ar,
        coalesce((select sum(residual) from invoices i where i.partner_id = p.id and i.kind = 'supplier' and i.state = 'open'),0)::text as ap
      from partners p
      where p.company_id = ${m.company_id} and p.id = ${data.id}
      limit 1
    `;
    if (!rows[0]) throw new Error("No encontrado");
    const me = await activeMember(sql, context.userId);
    const partner =
      me.acl.credit === "none"
        ? { ...rows[0], ar: "0", reserved: "0", ap: "0", credit_limit: "0" }
        // Paso 6 (Decisión 51): lo apartado, de la misma regla que usa el candado.
        : { ...rows[0], reserved: String((await creditExposure(sql, m.company_id, rows[0]!.id)).reserved) };
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
      // Costo de referencia: opcional en el envío. Si no viene, no se toca.
      ref_cost: z.number().nonnegative().optional(),
      // Decisión 77: se captura declarando moneda y se guarda en pesos.
      ref_cost_currency: z.enum(["MXN", "USD"]).optional(),
      ref_cost_fx: z.number().positive().optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const m = await requireCompany(sql, context.userId);
    await assertCan(sql, context.userId, "products", "edit");
    await ensureRefCost(sql);
    const me = await activeMember(sql, context.userId);
    // El costo de referencia lo captura administración: validación en el
    // servidor, no solo en pantalla (la pantalla ni siquiera lo muestra a los
    // demás roles, pero eso no es un candado).
    if (data.ref_cost !== undefined && me.role !== "admin") {
      throw new Error("Solo un administrador puede capturar el costo de referencia");
    }
    if (data.ref_cost !== undefined && (!Number.isFinite(data.ref_cost) || data.ref_cost < 0)) {
      throw new Error("El costo de referencia no puede ser negativo");
    }
    // Decisión 77: el catálogo vive en pesos. Un costo de referencia capturado en
    // dólares se convierte con el TC dado o con el de la tabla a hoy; sin TC se
    // detiene. Lo capturado queda en el rastro (moneda y TC).
    const refCur: "MXN" | "USD" | null = data.ref_cost !== undefined ? (data.ref_cost_currency === "USD" && data.ref_cost > 0 ? "USD" : "MXN") : null;
    let refFx: number | null = null;
    let refCaptured = "";
    if (refCur === "USD") {
      const fx = isUsdFx(data.ref_cost_fx) ? Number(data.ref_cost_fx) : fxAt(await loadFxTable(sql, m.company_id), todayMx())?.rate;
      const c = costToMxn({ cost: data.ref_cost!, currency: "USD", fx, what: "el costo de referencia en dólares" });
      refCaptured = `${data.ref_cost} USD × TC ${c.fx}`;
      refFx = c.fx;
      // De aquí en adelante el costo de referencia ya es pesos, como todo el catálogo.
      data.ref_cost = c.mxn;
    }
    let code = (data.code ?? "").trim().toUpperCase();
    if (!code) code = await nextCodeFor(sql, m.company_id, "PRD-", "products");
    const category = data.category || (data.product_type === "INSUMO" ? "Insumos" : "Fertilizantes");
    if (data.id) {
      // Costo y precio de lista son sensibles: cambios manuales a bitácora.
      const before = await sql<{ cost: string; list_price: string; ref_cost: string }>`
        select cost::text, list_price::text, coalesce(ref_cost,0)::text as ref_cost
        from products where id = ${data.id} and company_id = ${m.company_id}
      `;
      await sql`
        update products set code=${code}, name=${data.name}, category=${category},
          product_type=${data.product_type}, uom=${data.uom}, cost=${data.cost},
          list_price=${data.list_price}, min_stock=${data.min_stock},
          ref_cost = coalesce(${data.ref_cost ?? null}, ref_cost),
          ref_cost_currency = coalesce(${refCur}, ref_cost_currency),
          ref_cost_fx = case when ${refCur}::text is null then ref_cost_fx else ${refFx} end
        where id = ${data.id} and company_id = ${m.company_id}
      `;
      if (before[0]) {
        const cambios: string[] = [];
        if (Number(before[0].cost) !== data.cost) cambios.push(`costo ${Number(before[0].cost)} → ${data.cost}`);
        if (data.ref_cost !== undefined && Number(before[0].ref_cost) !== data.ref_cost)
          cambios.push(`costo de referencia ${Number(before[0].ref_cost)} → ${data.ref_cost}`);
        if (refCaptured && Number(before[0].ref_cost) !== data.ref_cost) cambios.push(`capturado ${refCaptured}`);
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
      insert into products (company_id, code, name, category, product_type, uom, cost, list_price, min_stock, ref_cost, ref_cost_currency, ref_cost_fx)
      values (${m.company_id}, ${code}, ${data.name}, ${category}, ${data.product_type}, ${data.uom}, ${data.cost}, ${data.list_price}, ${data.min_stock}, ${data.ref_cost ?? 0}, ${refCur}, ${refFx})
      returning id
    `;
    if (data.ref_cost) {
      await writeAudit(sql, {
        companyId: m.company_id,
        userId: context.userId,
        action: "precio-producto",
        entity: "product",
        entityId: row[0]!.id,
        name: `${code} ${data.name}`,
        detail: `costo de referencia 0 → ${data.ref_cost}${refCaptured ? ` (capturado ${refCaptured})` : ""}`,
      });
    }
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
    await ensureRefCost(sql);
    const rows = await sql<{
      id: number;
      code: string;
      name: string;
      category: string;
      product_type: string;
      uom: string;
      cost: string;
      ref_cost: string;
      list_price: string;
      min_stock: string;
      on_hand: string;
    }>`
      select p.id, p.code, p.name, p.category, p.product_type, p.uom, p.cost::text, p.list_price::text, p.min_stock::text,
        coalesce(p.ref_cost,0)::text as ref_cost,
        coalesce((select sum(quantity) from stock_quants q where q.product_id = p.id),0)::text as on_hand
      from products p
      where p.company_id = ${m.company_id} and p.id = ${data.id}
      limit 1
    `;
    if (!rows[0]) throw new Error("No encontrado");
    const me = await activeMember(sql, context.userId);
    // De cuál de las dos vías sale el costo que el sistema está usando.
    const used = resolveCost({ avgCost: rows[0].cost, refCost: rows[0].ref_cost });
    return {
      ...rows[0],
      cost: canSeeCosts(me.role) ? rows[0].cost : "0",
      // El costo de referencia es de administración: nadie más lo ve.
      ref_cost: me.role === "admin" ? rows[0].ref_cost : "0",
      can_edit_ref_cost: me.role === "admin",
      cost_in_use: canSeeCosts(me.role) ? String(used.cost) : "0",
      cost_source: used.source,
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
      reverses_ref: string | null;
      reversed_by_ref: string | null;
    }>`
      select sm.id, sm.ref, sm.move_type, sm.date::text, sm.origin, p.code as product,
        sm.quantity::text, coalesce(sm.unit_cost, 0)::text as unit_cost,
        lf.name as from_name, lt.name as to_name, sm.product_id,
        -- BLOQUE DE DESHACER: el par entrada↔reversa se ve en los dos renglones.
        (select o.ref from stock_moves o where o.id = sm.reverses_id) as reverses_ref,
        (select r.ref from stock_moves r where r.reverses_id = sm.id limit 1) as reversed_by_ref
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
        po.name as po_name, l.name as location, (pl.qty - pl.qty_received - coalesce(pl.qty_closed_short,0))::text as pending
      from purchase_lines pl
      join purchase_orders po on po.id = pl.po_id
      join products p on p.id = pl.product_id
      join locations l on l.id = po.location_id
      where po.company_id = ${m.company_id}
        and po.state not in ('done','cancelled')
        and coalesce(po.fulfill_kind,'inventory') <> 'direct'
        and pl.qty - pl.qty_received - coalesce(pl.qty_closed_short,0) > 0.0001
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
        s.name as so_name, l.name as location, (sl.qty - sl.qty_delivered - coalesce(sl.qty_closed_short,0))::text as pending
      from sales_lines sl
      join sales_orders s on s.id = sl.so_id
      join products p on p.id = sl.product_id
      join locations l on l.id = s.location_id
      where s.company_id = ${m.company_id}
        and s.state = 'confirmed'
        and coalesce(s.route_kind,'own') = 'own'
        and sl.qty - sl.qty_delivered - coalesce(sl.qty_closed_short,0) > 0.0001
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
    // Bloque de parciales, paso 0(a) — patrón A6: el cuadre. Con el
    // todo-o-nada de hoy siempre da vacío; empieza a poblarse el día que
    // exista recepción/entrega parcial (paso 1 en adelante).
    const purchaseGaps = await purchaseLineGaps(sql, m.company_id);
    const salesRecon = await salesLineGaps(sql, m.company_id);
    const salesGaps = salesRecon.gaps;
    // Paso 3 (Decisión 47): entregado sin facturar es normal — se enseña
    // aparte, en tono normal, no como error.
    const porFacturar = salesRecon.porFacturar;
    if (!canSeeCosts(me.role)) {
      return {
        quants: quants.map((q) => ({ ...q, cost: "0" })),
        locations,
        moves: moves.map((mv) => ({ ...mv, unit_cost: "0" })),
        incoming,
        outgoing,
        mismatches,
        purchaseGaps,
        salesGaps,
        porFacturar,
      };
    }
    return { quants, locations, moves, incoming, outgoing, mismatches, purchaseGaps, salesGaps, porFacturar };
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
      fx_rate: string;
      closed_short_reason: string | null;
      fulfill_kind: string;
      so_id: number | null;
      so_name: string | null;
      rfq_id: number | null;
      rfq_name: string | null;
    }>`
      select po.id, po.name, po.partner_id, pt.name as partner, po.date::text, po.state, l.name as location, po.total::text, po.currency,
        coalesce(po.fx_rate,1)::text as fx_rate,
        po.closed_short_reason,
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
      id: number;
      po_id: number;
      product: string;
      qty: string;
      qty_received: string;
      qty_closed_short: string;
      unit_price: string;
      uom: string;
      deliver_to: string;
    }>`
      select pl.id, pl.po_id, (p.code || ' — ' || p.name) as product, pl.qty::text, pl.qty_received::text, coalesce(pl.qty_closed_short,0)::text as qty_closed_short, pl.unit_price::text,
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
        fxTable: await loadFxTable(sql, m.company_id),
      };
    }
    return { orders, lines, suppliers, products, locations, fxTable: await loadFxTable(sql, m.company_id) };
  });

export const createPurchase = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      partnerId: z.number(),
      locationId: z.number(),
      notes: z.string().optional().default(""),
      currency: z.enum(["MXN", "USD"]).optional().default("MXN"),
      fxRate: z.number().positive().optional(),
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
    // Decisión 78: una OC en dólares declara SU tipo de cambio (el del proveedor):
    // la pantalla lo propone de la tabla y se puede corregir; nunca 1 por omisión
    // ni el pactado con el cliente. En pesos el TC es 1 y significa una sola cosa.
    const currency = data.currency ?? "MXN";
    if (currency === "USD" && !isUsdFx(data.fxRate)) throw new Error(missingFxMessage("la orden de compra en dólares"));
    const fxRate = currency === "USD" ? Number(data.fxRate) : 1;
    const n = await sql<{ c: number }>`select count(*)::int as c from purchase_orders where company_id = ${m.company_id}`;
    const name = `OC-${String((n[0]?.c ?? 0) + 1).padStart(4, "0")}`;
    const total = data.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0);
    const today = todayMx();
    await sql`alter table purchase_orders add column if not exists fulfill_kind text not null default 'inventory'`;
    await sql`alter table purchase_lines add column if not exists uom text not null default ''`;
    await sql`alter table purchase_lines add column if not exists deliver_to text not null default ''`;
    const po = await sql<{ id: number }>`
      insert into purchase_orders (company_id, name, partner_id, date, state, location_id, notes, total, currency, fx_rate, fulfill_kind)
      values (${m.company_id}, ${name}, ${data.partnerId}, ${today}, 'confirmed', ${data.locationId}, ${data.notes ?? ""}, ${total},
        ${currency}, ${fxRate}, ${data.fulfillKind ?? "inventory"})
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
      currency,
    });
    // Decisión 14: aquí NO nace la deuda. La FP nace cuando la mercancía se
    // movió de verdad — al recibirla, o al entregarla si es directa/brokeraje
    // (`bornSupplierDebt`). Pedir hoy y recibir en un mes ya no consume plazo
    // que nunca corrió.
    await writeAudit(sql, {
      companyId: m.company_id,
      userId: context.userId,
      action: "crear-oc",
      entity: "purchase",
      entityId: po[0]!.id,
      name,
      detail: `Total ${total.toFixed(2)} ${currency}${currency === "USD" ? ` · TC ${fxRate}` : ""} · la deuda nace al recibir`,
    });
    return { id: po[0]!.id, name };
  });

/**
 * Decisión 78, la salida antes del candado: una OC en dólares que nació sin TC
 * real (las de antes de la migración 0044, con `fx_rate = 1`) lo captura aquí.
 * Solo mientras no tenga deuda viva: la FP ya nació en pesos con ese TC y no se
 * reescribe (Decisión 79); si hace falta corregirla, se revierte la recepción.
 */
export const setPurchaseFxRate = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ poId: z.number(), fxRate: z.number().positive() }))
  .handler(async ({ context, data }) => {
    const sql0 = await getSql();
    const m = await requireCompany(sql0, context.userId);
    await assertCan(sql0, context.userId, "purchases", "edit");
    if (!isUsdFx(data.fxRate)) throw new Error(missingFxMessage("la orden de compra en dólares"));
    // La OC se bloquea (for update) para que el candado "sin deuda viva" y la
    // escritura sean un solo acto frente a una recepción simultánea.
    return withTx(async (sql) => {
      const po = await sql<{ name: string; currency: string; fx_rate: string; state: string }>`
        select name, coalesce(currency,'MXN') as currency, coalesce(fx_rate,1)::text as fx_rate, state
        from purchase_orders where id = ${data.poId} and company_id = ${m.company_id} for update
      `;
      if (!po[0]) throw new Error("Orden de compra no encontrada");
      if (po[0].currency !== "USD") throw new Error(`${po[0].name} está en pesos: no lleva tipo de cambio.`);
      const fp = await sql<{ name: string }>`
        select name from invoices where company_id = ${m.company_id} and kind = 'supplier' and origin = ${po[0].name} and state <> 'reversed' limit 1
      `;
      if (fp[0]) {
        throw new Error(
          `${po[0].name} ya tiene deuda viva (${fp[0].name}) nacida con TC ${Number(po[0].fx_rate)}: el TC no se cambia después. ` +
            `Si el TC estaba mal, revierte la recepción, corrige el TC y vuelve a recibir.`,
        );
      }
      await sql`update purchase_orders set fx_rate = ${data.fxRate} where id = ${data.poId} and company_id = ${m.company_id}`;
      await writeAudit(sql, {
        companyId: m.company_id,
        userId: context.userId,
        action: "tc-oc",
        entity: "purchase",
        entityId: data.poId,
        name: po[0].name,
        detail: `TC ${Number(po[0].fx_rate)} → ${data.fxRate}`,
      });
      return { ok: true };
    });
  });

/**
 * LA DEUDA CON EL PROVEEDOR NACE CUANDO LA MERCANCÍA SE MOVIÓ (Decisión 14),
 * nunca al capturar la orden: al recibirla en bodega, o al entregarla al
 * cliente si la orden es directa / brokeraje (ésa nunca se recibe —
 * `receivePurchase` la rechaza—, así que sin ese segundo camino el brokeraje
 * quedaría sin cuenta por pagar). Antes nacía al capturar la OC y el plazo
 * empezaba a correr ese día aunque la mercancía llegara un mes después: la
 * cuenta por pagar decía que se debía algo que todavía no se tenía.
 *
 * El único lugar donde nace es `bornSupplierDebtByReceipt` (más abajo), UNA
 * POR EVENTO de recepción o entrega (Decisión 28).
 *
 * Aquí vivía `bornSupplierDebt`, que emitía una factura por ORDEN y era
 * idempotente por folio de orden. Se borró el 18-sep-2026 (Decisión 89): se
 * había quedado sin un solo llamador —brokeraje usa la de por evento, dentro
 * de `deliverPartial`— y su guarda era justamente la que abría el agujero:
 * con una recepción parcial ya viva devolvía null y el resto de la mercancía
 * entraba al kardex sin cuenta por pagar. Dejarla exportada era dejar la
 * trampa puesta para el siguiente que la llamara.
 */
export const receivePurchase = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({
    poId: z.number(),
    // BLOQUE DE PARCIALES, paso 1: cantidad por partida, opcional. Sin esto,
    // el camino de hoy — recibir todo lo pendiente — no cambia en nada.
    lines: z.array(z.object({ lineId: z.number(), qty: z.number().positive() })).optional(),
  }))
  .handler(async ({ context, data }) => {
    return withTx(async (sql) => {
    const m = await requireCompany(sql, context.userId);
    await assertCan(sql, context.userId, "purchases", "deliver");
    const po = await sql<{ id: number; location_id: number; name: string; state: string; fulfill_kind: string; currency: string; fx_rate: string }>`
      select id, location_id, name, state, coalesce(fulfill_kind,'inventory') as fulfill_kind,
        coalesce(currency,'MXN') as currency, coalesce(fx_rate,1)::text as fx_rate from purchase_orders
      where id = ${data.poId} and company_id = ${m.company_id}
      for update
    `;
    if (!po[0] || po[0].state === "done" || po[0].state === "cancelled") throw new Error("Orden no disponible");
    if (po[0].fulfill_kind === "direct") {
      throw new Error("Esta OC es directa / brokeraje: no se recibe en bodega. La mercancía va en camino al cliente.");
    }
    // TODA recepción va por partidas, con su evento `RCP` y su factura del
    // proveedor por lo que entró en ESE evento (Decisión 28). Antes había un
    // segundo camino —"recibir todo lo pendiente" sin partidas— que llamaba a
    // `bornSupplierDebt` (una FP por ORDEN, idempotente por folio de orden): si
    // la orden ya tenía una recepción parcial, esa guarda encontraba la factura
    // del primer evento, devolvía null, y **el resto de la mercancía entraba al
    // kardex sin cuenta por pagar** — justo lo que prohíbe la Decisión 14. El
    // parche del paso 7 (ir por partidas solo si había cierre corto) tapaba una
    // esquina del mismo agujero. Con un solo camino, Σ(FP de una orden) = lo
    // recibido, siempre, y cada entrada al kardex queda amarrada a su evento.
    // `bornSupplierDebt` (por orden) sigue viva para brokeraje/directo, que
    // nunca pasa por aquí (Decisión 29).
    const pend = await sql<{ id: number; pending: string }>`
      select id, (qty - coalesce(qty_received,0) - coalesce(qty_closed_short,0))::text as pending
      from purchase_lines where po_id = ${po[0].id} order by id
    `;
    const lines = data.lines && data.lines.length
      ? data.lines
      : pend.map((l) => ({ lineId: l.id, qty: Number(l.pending) })).filter((l) => l.qty > 0.0001);
    if (!lines.length) throw new Error("No queda nada pendiente por recibir en esta orden.");
    const parcial = Boolean(data.lines && data.lines.length);
    const r = await receivePartial(sql, {
      companyId: m.company_id,
      userId: context.userId,
      poId: po[0].id,
      poName: po[0].name,
      locationId: po[0].location_id,
      lines,
    });
    await writeAudit(sql, {
      companyId: m.company_id,
      userId: context.userId,
      action: "recibir",
      entity: "purchase",
      entityId: po[0].id,
      name: po[0].name,
      detail: `${parcial ? "Recepción parcial" : "Recepción"} ${r.eventRef}${r.fp ? ` · nace ${r.fp} por pagar` : ""}`,
    });
    return { ok: true, fp: r.fp, eventRef: r.eventRef };
    });
  });

/**
 * BLOQUE DE PARCIALES, paso 1.1: recepción parcial. Cantidad por partida,
 * validada contra lo pendiente; un `event_ref` (serie `RCP`, folio_counters,
 * A4) por LLAMADA, compartido por todos los movimientos de kardex y la FP de
 * esta recepción. Plain function — sin `createServerFn` — para poder
 * probarla contra PGlite; `receivePurchase` es el único que la llama.
 */
export async function receivePartial(
  sql: Sql,
  opts: {
    companyId: number;
    userId: string;
    poId: number;
    poName: string;
    locationId: number;
    lines: Array<{ lineId: number; qty: number }>;
  },
) {
  const rows = await sql<{ last_number: number }>`
    insert into folio_counters (company_id, series, last_number)
    values (${opts.companyId}, 'RCP', 1)
    on conflict (company_id, series) do update set last_number = folio_counters.last_number + 1
    returning last_number
  `;
  const eventRef = `RCP/${String(rows[0]!.last_number).padStart(4, "0")}`;
  // Decisión 77: el kardex vive en pesos; una OC en dólares entra al TC de la OC.
  const poFx = await sql<{ currency: string; fx_rate: string }>`
    select coalesce(currency,'MXN') as currency, coalesce(fx_rate,1)::text as fx_rate from purchase_orders
    where id = ${opts.poId} and company_id = ${opts.companyId}
  `;
  if (!poFx[0]) throw new Error("Orden de compra no encontrada");

  const received: Array<{ productId: number; qty: number; unitPrice: number }> = [];
  for (const l of opts.lines) {
    const line = await sql<{ id: number; product_id: number; qty: string; qty_received: string; qty_closed_short: string; unit_price: string }>`
      select id, product_id, qty::text, qty_received::text, coalesce(qty_closed_short,0)::text as qty_closed_short, unit_price::text from purchase_lines
      where id = ${l.lineId} and po_id = ${opts.poId}
      for update
    `;
    if (!line[0]) throw new Error("Esa partida no está en la orden");
    // Paso 7: lo cerrado corto no se recibe (ya nunca va a llegar).
    const pending = Number(line[0].qty) - Number(line[0].qty_received) - Number(line[0].qty_closed_short);
    if (l.qty > pending + 0.0001) {
      throw new Error(`No puedes recibir más de lo pendiente (${pending}) en ${line[0].product_id}`);
    }
    await postStock(sql, {
      companyId: opts.companyId,
      userId: opts.userId,
      moveType: "receipt",
      origin: opts.poName,
      productId: line[0].product_id,
      quantity: l.qty,
      locationTo: opts.locationId,
      unitCost: receiptUnitCostMxn({ unitPrice: line[0].unit_price, currency: poFx[0].currency, fx: poFx[0].fx_rate, poName: opts.poName }),
      eventRef,
    });
    await sql`update purchase_lines set qty_received = qty_received + ${l.qty} where id = ${l.lineId}`;
    received.push({ productId: line[0].product_id, qty: l.qty, unitPrice: Number(line[0].unit_price) });
  }

  const remaining = await sql<{ n: number }>`
    select count(*)::int as n from purchase_lines where po_id = ${opts.poId} and qty_received >= qty - 0.0001 - coalesce(qty_closed_short,0)
  `;
  const total = await sql<{ n: number }>`select count(*)::int as n from purchase_lines where po_id = ${opts.poId}`;
  if ((remaining[0]?.n ?? 0) === (total[0]?.n ?? 0)) {
    await sql`update purchase_orders set state = 'done' where id = ${opts.poId}`;
  }

  const fp = await bornSupplierDebtByReceipt(sql, {
    companyId: opts.companyId,
    userId: opts.userId,
    poId: opts.poId,
    poName: opts.poName,
    eventRef,
    received,
  });
  return { eventRef, fp };
}

/**
 * BLOQUE DE PARCIALES, paso 1.2 (Decisión 28): una FP por RECEPCIÓN, no una
 * sola vez por OC. Idempotente por `event_ref` (Decisión 42: la llave es el
 * propio evento), no por OC como `bornSupplierDebt` — esa función se queda
 * intacta para el camino de hoy y para el brokeraje de `deliverSale`.
 * Importe = Σ(cantidad recibida en ESTE evento × precio unitario), no
 * `po.total`: no nace completa al primer recibo. Definida después de
 * `receivePurchase` a propósito, para no invadir el rango
 * `[bornSupplierDebt, receivePurchase)` que usa `erp-trazabilidad.test.mjs`.
 */
export async function bornSupplierDebtByReceipt(
  sql: Sql,
  opts: {
    companyId: number;
    userId: string;
    poId: number;
    poName: string;
    eventRef: string;
    received: Array<{ productId: number; qty: number; unitPrice: number }>;
    date?: string;
  },
) {
  const already = await sql<{ id: number }>`
    select id from invoices
    where company_id = ${opts.companyId} and kind = 'supplier' and event_ref = ${opts.eventRef} and origin = ${opts.poName}
      and state <> 'reversed'
    limit 1
  `;
  if (already[0]) return null;
  const po = await sql<{ partner_id: number; currency: string; fx_rate: string; partner: string }>`
    select po.partner_id, coalesce(po.currency,'MXN') as currency,
      coalesce(po.fx_rate,1)::text as fx_rate, p.name as partner
    from purchase_orders po join partners p on p.id = po.partner_id
    where po.id = ${opts.poId} and po.company_id = ${opts.companyId}
  `;
  if (!po[0]) throw new Error("Orden de compra no encontrada");
  const days = await sql<{ payment_days: number | null }>`
    select payment_days from partners where id = ${po[0].partner_id}
  `;
  if (!days[0] || days[0].payment_days == null) {
    throw new Error(
      `Falta el plazo de pago de ${po[0].partner}. Sin ese dato no se puede saber cuándo hay que pagarle esta recepción, ` +
        `y por eso no se puede registrar la entrada. Pídele a compras, administración o gerencia que lo capture en la ` +
        `ficha del proveedor (si es de contado, se captura 0). En cuanto esté, vuelve a recibir.`,
    );
  }
  const day = (opts.date || todayMx()).slice(0, 10);
  const due = addDays(day, days[0].payment_days);
  // Decisión 79: mismo molde que la FV (pesos al TC de la OC, original en amount_fx).
  const amounts = supplierInvoiceAmounts({
    total: opts.received.reduce((s, r) => s + r.qty * r.unitPrice, 0),
    currency: po[0].currency,
    fx: po[0].fx_rate,
    poName: opts.poName,
  });
  const iname = await nextDocFolio(sql, opts.companyId, "FP");
  await sql`
    insert into invoices (company_id, kind, name, partner_id, date, due_date, state, amount, residual, amount_fx, origin, event_ref, currency, fx_agreed, created_by)
    values (${opts.companyId}, 'supplier', ${iname}, ${po[0].partner_id}, ${day}, ${due}, 'open', ${amounts.amount}, ${amounts.amount}, ${amounts.amountFx},
      ${opts.poName}, ${opts.eventRef}, ${amounts.currency}, ${amounts.fxAgreed}, ${opts.userId})
  `;
  return iname;
}

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
    // Decisión 82 (y el candado de TC que este camino no tenía): en dólares el
    // precio llega en dólares y se guarda en pesos; sin TC real no nace.
    if (data.currency === "USD") {
      if (!isUsdFx(data.fxRate)) throw new Error(missingFxMessage("la venta en dólares"));
      for (const l of data.lines) l.unitPrice = saleToMxn({ price: l.unitPrice, currency: "USD", fx: data.fxRate, what: "la venta en dólares" });
    }
    const total = data.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0);
    // Paso 6 (Decisión 51): la misma regla que saveOrder, del mismo lugar —
    // este camino no tiene pantalla hoy, pero no se deja una segunda copia.
    const exposure = await creditExposure(sql, m.company_id, data.partnerId);
    const room = creditRoom({ ...exposure, order: total });
    if (room.exceeds) {
      if (!(data.overrideCredit && member.role === "admin")) {
        // El rechazo también deja rastro: quién intentó, con qué números.
        await writeAudit(sql, {
          companyId: m.company_id,
          userId: context.userId,
          action: "rechazado-credito",
          entity: "partner",
          entityId: data.partnerId,
          detail: creditDetail(exposure, total),
        });
        throw new Error(creditExceededMessage(exposure));
      }
      await writeAudit(sql, {
        companyId: m.company_id,
        userId: context.userId,
        action: "autorizar-credito",
        entity: "partner",
        entityId: data.partnerId,
        detail: creditDetail(exposure, total),
      });
    }
    // Este camino no captura plazo: es contado, y de contado la política es
    // «Sin mora» — escrito aquí, no heredado de un default de la columna
    // (Decisiones 68 y 69, misma regla y mismo lugar que saveOrder).
    await guardSaleTerms(sql, m.company_id, { creditDays: 0, policyCode: NO_MORA_POLICY });
    const n = await sql<{ c: number }>`select count(*)::int as c from sales_orders where company_id = ${m.company_id}`;
    const name = `PV-${String((n[0]?.c ?? 0) + 1).padStart(4, "0")}`;
    const so = await sql<{ id: number }>`
      insert into sales_orders (company_id, name, partner_id, date, state, location_id, notes, total, currency, fx_rate, delivery_to, owner_id, term_kind, policy_code)
      values (${m.company_id}, ${name}, ${data.partnerId}, ${todayMx()}, 'confirmed', ${data.locationId}, ${data.notes ?? ""}, ${total},
        ${data.currency ?? "MXN"}, ${data.fxRate ?? 1}, ${data.deliveryTo ?? ""}, ${context.userId}, 'contado', ${NO_MORA_POLICY})
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
  .validator(z.object({
    soId: z.number(),
    // BLOQUE DE PARCIALES, paso 3: cantidad por partida, opcional. Sin esto
    // entrega todo lo pendiente. En bodega propia entregar YA NO factura
    // (Decisión 47: la FV se emite después, por evento — invoiceDelivery);
    // en directo/brokeraje sí, en el mismo acto (Decisión 29).
    lines: z.array(z.object({ lineId: z.number(), qty: z.number().positive() })).optional(),
  }))
  .handler(async ({ context, data }) => {
    return withTx(async (sql) => {
    const m = await requireCompany(sql, context.userId);
    await assertCan(sql, context.userId, "sales", "deliver");
    const so = await sql<{ id: number; name: string; state: string; route_kind: string }>`
      select id, name, state, coalesce(route_kind,'own') as route_kind from sales_orders
      where id = ${data.soId} and company_id = ${m.company_id}
      for update
    `;
    if (!so[0] || so[0].state === "done" || so[0].state === "cancelled") throw new Error("Pedido no disponible");
    if (so[0].state !== "confirmed") throw new Error("Confirma el pedido antes de entregar");
    // Decisión 74 (Altos #26, 17-sep-2026): en directo/brokeraje entregar
    // FACTURA al cliente y hace nacer la deuda con el proveedor en el mismo
    // acto (Decisión 29) — eso es facturar, y "deliver" (Decisión 48) no
    // factura ni edita. En bodega propia nada cambia: la FV se emite después,
    // con invoiceDelivery, que ya exige edit.
    if (so[0].route_kind === "supplier" || so[0].route_kind === "asr") {
      await assertCan(sql, context.userId, "sales", "edit");
    }
    let lines = data.lines ?? [];
    if (!lines.length) {
      const pend = await sql<{ id: number; qty: string; qty_delivered: string; qty_closed_short: string }>`
        select id, qty::text, coalesce(qty_delivered,0)::text as qty_delivered, coalesce(qty_closed_short,0)::text as qty_closed_short
        from sales_lines where so_id = ${so[0].id} order by id
      `;
      // Paso 7: lo cerrado corto ya nunca va a salir — no es pendiente.
      lines = pend
        .map((l) => ({ lineId: l.id, qty: Number(l.qty) - Number(l.qty_delivered) - Number(l.qty_closed_short) }))
        .filter((l) => l.qty > 0.0001);
    }
    if (!lines.length) throw new Error("No queda nada pendiente por entregar en este pedido");
    const r = await deliverPartial(sql, { companyId: m.company_id, userId: context.userId, soId: so[0].id, lines });
    const fpsDirectas = r.fps;
    await writeAudit(sql, {
      companyId: m.company_id,
      userId: context.userId,
      action: "entregar",
      entity: "sale",
      entityId: so[0].id,
      name: so[0].name,
      detail: `${r.eventRef}${r.fv ? ` · ${r.fv}` : " · sin facturar todavía"}${r.done ? " · pedido completo" : " · queda pendiente"}${fpsDirectas.length ? ` · brokeraje: nace ${fpsDirectas.join(", ")} por pagar` : ""}`,
    });
    return { ok: true, eventRef: r.eventRef, fv: r.fv, fps: fpsDirectas, done: r.done };
    });
  });

type DeliveredLine = { productId: number; qty: number; unitPrice: number };

/**
 * BLOQUE DE PARCIALES, paso 3.2: entrega parcial. Cantidad por partida,
 * validada contra lo pendiente; un `event_ref` (serie `ENV`, folio_counters,
 * A4) por LLAMADA, compartido por los movimientos de kardex y la FV de esta
 * entrega. Plain function — sin `createServerFn` — igual que receivePartial;
 * `deliverSale` es el único que la llama.
 *
 *   - Bodega propia: salida del kardex por partida con el evento; la FV NO
 *     nace aquí (Decisión 47: entregar sin facturar) — la emite
 *     `invoiceDelivery` cuando alguien con permiso de facturar lo pida.
 *   - Directo/brokeraje: sin kardex; entregar = facturar en el mismo acto
 *     (Decisión 29; decisión del dueño 15-sep-2026 — no hay kardex que
 *     registre el evento): FV de este evento y FP por evento de cada OC
 *     directa, con lo entregado al precio de esa OC.
 *   - `done` solo cuando ninguna partida tiene pendiente.
 */
export async function deliverPartial(
  sql: Sql,
  opts: { companyId: number; userId: string; soId: number; lines: Array<{ lineId: number; qty: number }> },
) {
  const so = await sql<{ id: number; name: string; location_id: number; route_kind: string }>`
    select id, name, location_id, coalesce(route_kind,'own') as route_kind
    from sales_orders where id = ${opts.soId} and company_id = ${opts.companyId}
  `;
  if (!so[0]) throw new Error("Pedido no encontrado");
  const direct = so[0].route_kind === "supplier" || so[0].route_kind === "asr";

  const rows = await sql<{ last_number: number }>`
    insert into folio_counters (company_id, series, last_number)
    values (${opts.companyId}, 'ENV', 1)
    on conflict (company_id, series) do update set last_number = folio_counters.last_number + 1
    returning last_number
  `;
  const eventRef = `ENV/${String(rows[0]!.last_number).padStart(4, "0")}`;

  const delivered: DeliveredLine[] = [];
  for (const l of opts.lines) {
    const line = await sql<{ id: number; product_id: number; qty: string; qty_delivered: string; qty_closed_short: string; unit_price: string }>`
      select id, product_id, qty::text, coalesce(qty_delivered,0)::text as qty_delivered, coalesce(qty_closed_short,0)::text as qty_closed_short, unit_price::text
      from sales_lines where id = ${l.lineId} and so_id = ${so[0].id}
      for update
    `;
    if (!line[0]) throw new Error("Esa partida no está en el pedido");
    // Paso 7: lo cerrado corto no se entrega (ya nunca va a salir).
    const pending = Number(line[0].qty) - Number(line[0].qty_delivered) - Number(line[0].qty_closed_short);
    if (l.qty > pending + 0.0001) {
      throw new Error(`No puedes entregar más de lo pendiente (${pending}) en la partida ${line[0].product_id}`);
    }
    if (!direct) {
      await postStock(sql, {
        companyId: opts.companyId,
        userId: opts.userId,
        moveType: "delivery",
        origin: so[0].name,
        productId: line[0].product_id,
        quantity: l.qty,
        locationFrom: so[0].location_id,
        eventRef,
      });
    }
    await sql`update sales_lines set qty_delivered = qty_delivered + ${l.qty} where id = ${l.lineId}`;
    delivered.push({ productId: line[0].product_id, qty: l.qty, unitPrice: Number(line[0].unit_price) });
  }

  const pend = await sql<{ n: number }>`
    select count(*)::int as n from sales_lines where so_id = ${so[0].id} and qty_delivered < qty - 0.0001 - coalesce(qty_closed_short,0)
  `;
  const done = (pend[0]?.n ?? 0) === 0;
  if (done) await sql`update sales_orders set state = 'done' where id = ${so[0].id}`;

  let fv: string | null = null;
  const fpsDirectas: string[] = [];
  if (direct) {
    fv = await issueDeliveryInvoice(sql, { companyId: opts.companyId, userId: opts.userId, soId: so[0].id, eventRef, delivered });
    // Decisión 29: la OC directa nunca se recibe, así que su deuda nace aquí
    // — por evento (Decisión 28), con lo entregado al precio de ESA OC.
    const ocs = await sql<{ id: number; name: string }>`
      select id, name from purchase_orders
      where company_id = ${opts.companyId} and so_id = ${so[0].id}
        and coalesce(fulfill_kind,'inventory') = 'direct' and state <> 'cancelled'
      order by id
    `;
    for (const oc of ocs) {
      const pls = await sql<{ product_id: number; unit_price: string }>`
        select product_id, unit_price::text from purchase_lines where po_id = ${oc.id}
      `;
      const received = delivered
        .map((d) => {
          const pl = pls.find((x) => x.product_id === d.productId);
          return pl ? { productId: d.productId, qty: d.qty, unitPrice: Number(pl.unit_price) } : null;
        })
        .filter((x): x is { productId: number; qty: number; unitPrice: number } => x !== null);
      if (!received.length) continue;
      const fp = await bornSupplierDebtByReceipt(sql, {
        companyId: opts.companyId,
        userId: opts.userId,
        poId: oc.id,
        poName: oc.name,
        eventRef,
        received,
      });
      if (fp) fpsDirectas.push(fp);
    }
  }
  return { eventRef, fv, fps: fpsDirectas, delivered, done };
}

/**
 * BLOQUE DE PARCIALES, paso 3.3: la FV de UNA entrega (Decisión 46: una por
 * evento). Renglones = lo que salió en ese evento — del kardex en bodega
 * propia, de la llamada en directo —, al precio de la partida; importe =
 * Σ(entregado × precio), nunca el pedido completo. Vencimientos desde la
 * fecha de la ENTREGA (Decisión 54) con el plazo que se cobró en el precio
 * (los días del pedido). La foto de parámetros es la de siempre: TIIE a la
 * fecha de emisión (Decisión 40), circuito y tasas congeladas de la
 * cotización. Idempotente por `event_ref`.
 */
export async function issueDeliveryInvoice(
  sql: Sql,
  opts: { companyId: number; userId: string; soId: number; eventRef: string; delivered?: DeliveredLine[] },
) {
  const already = await sql<{ name: string }>`
    select name from invoices
    where company_id = ${opts.companyId} and kind = 'customer' and event_ref = ${opts.eventRef} and state <> 'reversed'
    limit 1
  `;
  if (already[0]) return already[0].name;
  const so = await sql<{
    id: number;
    name: string;
    partner_id: number;
    invoice_due: string | null;
    credit_due: string | null;
    invoice_days: number | null;
    credit_days: number | null;
    policy_code: string | null;
    date: string;
    term_kind: string;
    circuit_code: string | null;
    currency: string;
    fx_rate: string;
  }>`
    select id, name, partner_id, invoice_due::text, credit_due::text, invoice_days, credit_days, policy_code, date::text,
      coalesce(term_kind,'contado') as term_kind, circuit_code, coalesce(currency,'MXN') as currency, coalesce(fx_rate,1)::text as fx_rate
    from sales_orders where id = ${opts.soId} and company_id = ${opts.companyId}
  `;
  if (!so[0]) throw new Error("Pedido no encontrado");
  const today = todayMx();

  let delivered: DeliveredLine[];
  let eventDate: string;
  if (opts.delivered && opts.delivered.length) {
    delivered = opts.delivered;
    eventDate = today;
  } else {
    const moves = await sql<{ product_id: number; qty: string; day: string }>`
      select product_id, sum(quantity)::text as qty, min(date)::text as day
      from stock_moves
      where company_id = ${opts.companyId} and origin = ${so[0].name} and event_ref = ${opts.eventRef} and move_type = 'delivery'
      group by product_id
    `;
    if (!moves.length) throw new Error(`No hay entrega con el evento ${opts.eventRef} en ${so[0].name}`);
    const prices = await sql<{ product_id: number; unit_price: string }>`
      select product_id, unit_price::text from sales_lines where so_id = ${so[0].id}
    `;
    delivered = moves.map((mv) => {
      const pl = prices.find((x) => x.product_id === mv.product_id);
      if (!pl) throw new Error(`La entrega ${opts.eventRef} sacó un producto que no está en ${so[0].name}`);
      return { productId: mv.product_id, qty: Number(mv.qty), unitPrice: Number(pl.unit_price) };
    });
    eventDate = moves.reduce((d, mv) => (mv.day < d ? mv.day : d), moves[0]!.day);
  }

  // Decisión 54: el plazo de ESTA factura arranca el día de su entrega, con
  // los mismos días que se cobraron en el precio del pedido. Misma regla que
  // decideQuote (computeDues), con otra fecha de arranque.
  const termKind = (TERM_KINDS as readonly string[]).includes(so[0].term_kind) ? (so[0].term_kind as TermKind) : null;
  if (!termKind) throw new Error(`Tipo de plazo desconocido en ${so[0].name}: ${so[0].term_kind}`);
  const dues = computeDues({
    date: eventDate,
    termKind,
    invoiceDays: so[0].invoice_days ?? 0,
    creditDays: so[0].credit_days ?? 0,
    invoiceDue: so[0].invoice_due ?? undefined,
    creditDue: so[0].credit_due ?? undefined,
  });
  const invoiceDue = dues.invoiceDue;
  const creditDue = dues.creditDue;
  // Decisión 68: la FV hereda la política del pedido tal cual. Sin política
  // capturada no se factura — ya no se rellena con «Sin mora».
  const policyCode = (so[0].policy_code ?? "").trim();
  if (!policyCode) throw new Error(`${so[0].name} no tiene política de cobro capturada: captúrala en el pedido antes de facturar.`);

  const iname = await nextDocFolio(sql, opts.companyId, "FV");
  const currency = so[0].currency;
  const fx = Number(so[0].fx_rate);
  const mxn = Math.round(delivered.reduce((s, d) => s + d.qty * d.unitPrice, 0) * 100) / 100;
  // Foto de parámetros al emitir: TIIE del mes de emisión y las tasas
  // vigentes hoy. Con esto la utilidad y el costo financiero de ESTA
  // factura siguen siendo explicables aunque después cambien Ajustes.
  const pol = await policy(sql, opts.companyId);
  const tiieRows = await sql<{ date: string; rate: string }>`
    select date::text, rate::text from tiie_rates where company_id = ${opts.companyId} order by date
  `;
  // A crédito, sin renglón de TIIE vigente a la fecha de emisión no se
  // factura: la entrega completa se revierte con el aviso. De contado no
  // hay financiamiento que calcular: se guarda el renglón si existe y, si
  // no, la foto queda sin TIIE (el reporte lo marca, no lo estima).
  const tiieTable = tiieRows.map((r) => ({ date: r.date, rate: Number(r.rate) }));
  const financedDays = so[0].credit_days ?? 0;
  // Paso 3: comisión, base y las dos tasas son del circuito del documento.
  // Si el pedido vino de cotización, lo congelado ahí manda; si no, el
  // catálogo del circuito que financia. En el lineal la tasa que entra al
  // precio es la de cobro congelada, no la TIIE.
  const circuitOfSale = inheritCircuit(so[0].circuit_code, financedDays);
  const qFrozen = await sql<{ commission_rate: string | null; cost_rate: string | null; collection_rate: string | null; tiie: string | null }>`
    select commission_rate::text, cost_rate::text, collection_rate::text, tiie::text
    from quotes q join sales_orders o on o.quote_id = q.id where o.id = ${so[0].id}
  `;
  const terms = financedDays > 0 ? await circuitTerms(sql, opts.companyId, circuitOfSale) : null;
  const lineal = terms?.financingBase === "costo_margen";
  const tiiePick =
      financedDays > 0 && !lineal
        ? requireRate(tiieTable, today, `emisión de ${iname} a crédito`)
        : lineal
          ? { rate: Number(qFrozen[0]?.collection_rate ?? qFrozen[0]?.tiie ?? 0), date: today }
          : nearestRate(tiieTable, today);
  const snap = JSON.stringify({
    tiieIssue: tiiePick?.rate ?? null,
    tiieDate: tiiePick?.date ?? null,
    costSpread: pol.asrSpread,
    commissionRate: qFrozen[0]?.commission_rate != null ? Number(qFrozen[0].commission_rate) : (terms?.commissionRate ?? null),
    circuit: circuitOfSale,
    financingBase: terms?.financingBase ?? null,
    costRate: qFrozen[0]?.cost_rate != null ? Number(qFrozen[0].cost_rate) : null,
    collectionRate: qFrozen[0]?.collection_rate != null ? Number(qFrozen[0].collection_rate) : null,
    // Los días financiados de ESTE pedido: los mismos que fueron cobrados
    // al cliente dentro del precio (0 = contado, sin circuito).
    financialDays: financedDays,
    collectionSpread: pol.collectionSpread,
    fegaRate: pol.fegaRate,
    earlyPayDays: pol.earlyPayDays,
  });
  const inv = await sql<{ id: number }>`
    insert into invoices (
      company_id, kind, name, partner_id, date, due_date, credit_due, state, amount, residual, origin,
      currency, amount_fx, fx_agreed, inv_class, order_id, invoice_days, credit_days, policy_code,
      created_by, params_snap, circuit_code, event_ref
    )
    values (
      ${opts.companyId}, 'customer', ${iname}, ${so[0].partner_id}, ${today}, ${invoiceDue}, ${creditDue}, 'open',
      ${mxn}, ${mxn}, ${so[0].name}, ${currency}, ${currency === "USD" && fx ? mxn / fx : 0}, ${fx}, 'product', ${so[0].id},
      ${so[0].invoice_days ?? 0}, ${so[0].credit_days ?? 0}, ${policyCode},
      ${opts.userId}, ${snap}, ${inheritCircuit(so[0].circuit_code, so[0].credit_days ?? 0)}, ${opts.eventRef}
    )
    returning id
  `;
  for (const d of delivered) {
    const amt = Math.round(d.qty * d.unitPrice * 100) / 100;
    await sql`
      insert into invoice_lines (invoice_id, product_id, qty, unit_price, amount)
      values (${inv[0]!.id}, ${d.productId}, ${d.qty}, ${d.unitPrice}, ${amt})
    `;
  }
  return iname;
}

/**
 * BLOQUE DE PARCIALES, paso 3.3: facturar UNA entrega ya hecha en bodega
 * propia. Facturar es dinero: pide sales:edit — almacén (deliver) entrega
 * pero no factura (Decisión 48). No se puede facturar lo que no salió
 * (Decisión 47): exige una entrega viva con ese evento. En directo/brokeraje
 * la FV ya nació con la entrega (Decisión 29): aquí se rechaza.
 */
export const invoiceDelivery = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ soId: z.number(), eventRef: z.string() }))
  .handler(async ({ context, data }) => {
    return withTx(async (sql) => {
      const m = await requireCompany(sql, context.userId);
      await assertCan(sql, context.userId, "sales", "edit");
      const so = await sql<{ id: number; name: string; state: string; route_kind: string }>`
        select id, name, state, coalesce(route_kind,'own') as route_kind from sales_orders
        where id = ${data.soId} and company_id = ${m.company_id}
        for update
      `;
      if (!so[0] || so[0].state === "cancelled") throw new Error("Pedido no disponible");
      if (so[0].route_kind !== "own") {
        throw new Error(`${so[0].name} es directo / brokeraje: su factura nació con la entrega, no se factura aparte.`);
      }
      const already = await sql<{ name: string }>`
        select name from invoices
        where company_id = ${m.company_id} and kind = 'customer' and event_ref = ${data.eventRef} and state <> 'reversed'
        limit 1
      `;
      if (already[0]) throw new Error(`La entrega ${data.eventRef} ya está facturada (${already[0].name}).`);
      const live = await sql<{ n: number }>`
        select count(*)::int as n from stock_moves m
        where m.company_id = ${m.company_id} and m.origin = ${so[0].name} and m.event_ref = ${data.eventRef} and m.move_type = 'delivery'
          and not exists (select 1 from stock_moves r where r.reverses_id = m.id)
      `;
      if ((live[0]?.n ?? 0) === 0) {
        throw new Error(`No hay entrega ${data.eventRef} viva en ${so[0].name}: no se factura lo que no salió.`);
      }
      const iname = await issueDeliveryInvoice(sql, { companyId: m.company_id, userId: context.userId, soId: so[0].id, eventRef: data.eventRef });
      await writeAudit(sql, {
        companyId: m.company_id,
        userId: context.userId,
        action: "facturar-entrega",
        entity: "sale",
        entityId: so[0].id,
        name: so[0].name,
        detail: `${iname} por la entrega ${data.eventRef}`,
      });
      return { ok: true, fv: iname };
    });
  });

/** Los eventos de entrega de un pedido, con su FV (o null) y si están revertidos — para la ficha del pedido. */
export const listDeliveryEvents = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ soId: z.number() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const m = await requireCompany(sql, context.userId);
    await assertCan(sql, context.userId, "sales", "view");
    const so = await sql<{ id: number; name: string }>`
      select id, name from sales_orders where id = ${data.soId} and company_id = ${m.company_id}
    `;
    if (!so[0]) throw new Error("Pedido no encontrado");
    // Bodega propia deja kardex por evento; directo/brokeraje solo deja FV
    // (nació con la entrega). Los dos caminos, un renglón por evento.
    const events = await sql<{ event_ref: string; date: string; reversed: boolean; fv: string | null }>`
      select e.event_ref, min(e.day)::text as date, bool_and(e.reversed) as reversed,
        (select i.name from invoices i
          where i.company_id = ${m.company_id} and i.kind = 'customer' and i.event_ref = e.event_ref and i.state <> 'reversed'
          limit 1) as fv
      from (
        select m.event_ref, m.date as day, exists (select 1 from stock_moves r where r.reverses_id = m.id) as reversed
        from stock_moves m
        where m.company_id = ${m.company_id} and m.origin = ${so[0].name} and m.event_ref is not null and m.move_type = 'delivery'
        union all
        select i.event_ref, i.date as day, (i.state = 'reversed') as reversed
        from invoices i
        where i.company_id = ${m.company_id} and i.order_id = ${so[0].id} and i.kind = 'customer' and event_ref is not null
          and i.reverses_id is null
          and not exists (select 1 from stock_moves m2 where m2.company_id = i.company_id and m2.event_ref = i.event_ref)
      ) e
      group by e.event_ref
      order by min(e.day), e.event_ref
    `;
    const fromStock = await sql<{ event_ref: string; code: string; name: string; uom: string; qty: string }>`
      select m.event_ref, p.code, p.name, coalesce(p.uom,'') as uom, sum(m.quantity)::text as qty
      from stock_moves m join products p on p.id = m.product_id
      where m.company_id = ${m.company_id} and m.origin = ${so[0].name} and m.event_ref is not null and m.move_type = 'delivery'
      group by m.event_ref, p.code, p.name, p.uom
    `;
    const fromInvoice = await sql<{ event_ref: string; code: string; name: string; uom: string; qty: string }>`
      select i.event_ref, p.code, p.name, coalesce(p.uom,'') as uom, sum(il.qty)::text as qty
      from invoices i join invoice_lines il on il.invoice_id = i.id join products p on p.id = il.product_id
      where i.company_id = ${m.company_id} and i.order_id = ${so[0].id} and i.kind = 'customer' and i.event_ref is not null
        and i.reverses_id is null
        and not exists (select 1 from stock_moves m2 where m2.company_id = i.company_id and m2.event_ref = i.event_ref)
      group by i.event_ref, p.code, p.name, p.uom
    `;
    const lines = [...fromStock, ...fromInvoice];
    return events.map((e) => ({
      eventRef: e.event_ref,
      date: e.date,
      fv: e.fv,
      reversed: e.reversed,
      lines: lines.filter((l) => l.event_ref === e.event_ref).map((l) => ({ code: l.code, name: l.name, uom: l.uom, qty: Number(l.qty) })),
    }));
  });

/**
 * BLOQUE DE PARCIALES, paso 7 (Decisión 50): cerrar corto un pedido — lo
 * pendiente que YA NUNCA va a salir se cierra con motivo obligatorio (A5) y
 * queda en `qty_closed_short` por partida; lo ya entregado y facturado no se
 * toca. Con `pendiente = qty − entregado − cerrado_corto = 0` en todas las
 * partidas el pedido pasa a `done` — un estado terminal normal, no un
 * atasco (destraba PARCIALES.md § 4.1 sin deshacer nada). Solo admin /
 * gerencia: es un juicio que no se deshace con un botón, como revertir.
 * Sin `lines` cierra todo lo pendiente; con `lines`, solo esas cantidades.
 */
export const closeShortSale = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({
    soId: z.number(),
    reason: z.string().trim().min(1, "Escribe el motivo"),
    lines: z.array(z.object({ lineId: z.number(), qty: z.number().positive() })).optional(),
  }))
  .handler(async ({ context, data }) => {
    return withTx(async (sql) => {
      const m = await requireCompany(sql, context.userId);
      const me = await activeMember(sql, context.userId);
      if (!canRevert(me.role)) throw new Error("Solo un administrador o gerencia puede cerrar corto un pedido: es una decisión que no se deshace.");
      const so = await sql<{ id: number; name: string; state: string }>`
        select id, name, state from sales_orders where id = ${data.soId} and company_id = ${m.company_id} for update
      `;
      if (!so[0]) throw new Error("Pedido no encontrado");
      if (so[0].state !== "confirmed") {
        throw new Error(so[0].state === "done" ? `${so[0].name} ya está completo: no hay pendiente que cerrar.` : `${so[0].name} no está confirmado: no hay pendiente que cerrar.`);
      }
      const lines = await sql<{ id: number; code: string; qty: string; qty_delivered: string; qty_closed_short: string }>`
        select sl.id, p.code, sl.qty::text, coalesce(sl.qty_delivered,0)::text as qty_delivered, coalesce(sl.qty_closed_short,0)::text as qty_closed_short
        from sales_lines sl join products p on p.id = sl.product_id where sl.so_id = ${so[0].id} order by sl.id
      `;
      const pendingOf = (l: (typeof lines)[number]) => Math.max(0, Number(l.qty) - Number(l.qty_delivered) - Number(l.qty_closed_short));
      const targets = data.lines?.length
        ? data.lines.map((x) => {
            const l = lines.find((y) => y.id === x.lineId);
            if (!l) throw new Error("Esa partida no está en el pedido");
            if (x.qty > pendingOf(l) + 0.0001) throw new Error(`No puedes cerrar más de lo pendiente (${pendingOf(l)}) en ${l.code}.`);
            return { line: l, qty: x.qty };
          })
        : lines.filter((l) => pendingOf(l) > 0.0001).map((l) => ({ line: l, qty: pendingOf(l) }));
      if (!targets.length) throw new Error(`${so[0].name} no tiene pendiente que cerrar.`);
      if (!lines.some((l) => Number(l.qty_delivered) > 0.0001)) {
        throw new Error(`${so[0].name} no tiene nada entregado: cerrar corto es para lo que falta después de entregar algo. Si no va a salir nada, cancela el pedido.`);
      }
      for (const t of targets) {
        await sql`update sales_lines set qty_closed_short = coalesce(qty_closed_short,0) + ${t.qty} where id = ${t.line.id}`;
      }
      const pend = await sql<{ n: number }>`
        select count(*)::int as n from sales_lines
        where so_id = ${so[0].id} and coalesce(qty_delivered,0) + coalesce(qty_closed_short,0) < qty - 0.0001
      `;
      const done = (pend[0]?.n ?? 0) === 0;
      await sql`
        update sales_orders set closed_short_at = now(), closed_short_by = ${context.userId}, closed_short_reason = ${data.reason}
        where id = ${so[0].id} and company_id = ${m.company_id}
      `;
      if (done) await sql`update sales_orders set state = 'done' where id = ${so[0].id} and company_id = ${m.company_id}`;
      const closed = targets.map((t) => ({ lineId: t.line.id, code: t.line.code, qty: t.qty }));
      await writeAudit(sql, {
        companyId: m.company_id,
        userId: context.userId,
        action: "cerrar-corto",
        entity: "sale",
        entityId: so[0].id,
        name: so[0].name,
        detail: `Cerrado sin salir: ${closed.map((c) => `${c.code} ${c.qty}`).join(", ")} · ${done ? "pedido completo (entregado)" : "queda pendiente"} · lo entregado y facturado queda intacto · ${data.reason}`,
      });
      return { ok: true as const, closed, done };
    });
  });

/**
 * Paso 7 (Decisión 49): cerrar corto una orden de compra — lo que el
 * proveedor ya no va a mandar. Igual que el pedido: `qty_closed_short` por
 * partida, motivo obligatorio, `done` cuando nada queda pendiente, solo
 * admin / gerencia. Una OC directa / brokeraje nunca se recibe (Decisión 29):
 * se cierra con su pedido, no por aquí.
 */
export const closeShortPurchase = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({
    poId: z.number(),
    reason: z.string().trim().min(1, "Escribe el motivo"),
    lines: z.array(z.object({ lineId: z.number(), qty: z.number().positive() })).optional(),
  }))
  .handler(async ({ context, data }) => {
    return withTx(async (sql) => {
      const m = await requireCompany(sql, context.userId);
      const me = await activeMember(sql, context.userId);
      if (!canRevert(me.role)) throw new Error("Solo un administrador o gerencia puede cerrar corto una orden de compra: es una decisión que no se deshace.");
      const po = await sql<{ id: number; name: string; state: string; fulfill_kind: string }>`
        select id, name, state, coalesce(fulfill_kind,'inventory') as fulfill_kind from purchase_orders
        where id = ${data.poId} and company_id = ${m.company_id} for update
      `;
      if (!po[0]) throw new Error("Orden de compra no encontrada");
      if (po[0].fulfill_kind === "direct") throw new Error(`${po[0].name} es directa / brokeraje: nunca se recibe en bodega, no hay pendiente de recepción que cerrar.`);
      if (po[0].state !== "confirmed") {
        throw new Error(po[0].state === "done" ? `${po[0].name} ya está completa: no hay pendiente que cerrar.` : `${po[0].name} no está confirmada: no hay pendiente que cerrar.`);
      }
      const lines = await sql<{ id: number; code: string; qty: string; qty_received: string; qty_closed_short: string }>`
        select pl.id, p.code, pl.qty::text, coalesce(pl.qty_received,0)::text as qty_received, coalesce(pl.qty_closed_short,0)::text as qty_closed_short
        from purchase_lines pl join products p on p.id = pl.product_id where pl.po_id = ${po[0].id} order by pl.id
      `;
      const pendingOf = (l: (typeof lines)[number]) => Math.max(0, Number(l.qty) - Number(l.qty_received) - Number(l.qty_closed_short));
      const targets = data.lines?.length
        ? data.lines.map((x) => {
            const l = lines.find((y) => y.id === x.lineId);
            if (!l) throw new Error("Esa partida no está en la orden");
            if (x.qty > pendingOf(l) + 0.0001) throw new Error(`No puedes cerrar más de lo pendiente (${pendingOf(l)}) en ${l.code}.`);
            return { line: l, qty: x.qty };
          })
        : lines.filter((l) => pendingOf(l) > 0.0001).map((l) => ({ line: l, qty: pendingOf(l) }));
      if (!targets.length) throw new Error(`${po[0].name} no tiene pendiente que cerrar.`);
      if (!lines.some((l) => Number(l.qty_received) > 0.0001)) {
        throw new Error(`${po[0].name} no tiene nada recibido: cerrar corto es para lo que falta después de recibir algo. Si no va a llegar nada, cancela la orden.`);
      }
      for (const t of targets) {
        await sql`update purchase_lines set qty_closed_short = coalesce(qty_closed_short,0) + ${t.qty} where id = ${t.line.id}`;
      }
      const pend = await sql<{ n: number }>`
        select count(*)::int as n from purchase_lines
        where po_id = ${po[0].id} and coalesce(qty_received,0) + coalesce(qty_closed_short,0) < qty - 0.0001
      `;
      const done = (pend[0]?.n ?? 0) === 0;
      await sql`
        update purchase_orders set closed_short_at = now(), closed_short_by = ${context.userId}, closed_short_reason = ${data.reason}
        where id = ${po[0].id} and company_id = ${m.company_id}
      `;
      if (done) await sql`update purchase_orders set state = 'done' where id = ${po[0].id} and company_id = ${m.company_id}`;
      const closed = targets.map((t) => ({ lineId: t.line.id, code: t.line.code, qty: t.qty }));
      await writeAudit(sql, {
        companyId: m.company_id,
        userId: context.userId,
        action: "cerrar-corto",
        entity: "purchase",
        entityId: po[0].id,
        name: po[0].name,
        detail: `Cerrado sin llegar: ${closed.map((c) => `${c.code} ${c.qty}`).join(", ")} · ${done ? "orden completa (recibida)" : "queda pendiente"} · lo recibido y su deuda quedan intactos · ${data.reason}`,
      });
      return { ok: true as const, closed, done };
    });
  });

export const returnSale = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      soId: z.number(),
      reason: z.string().optional().default(""),
      // Grupo D (auditoría, 17-sep-2026): la partida es sales_lines.id. Con el
      // mismo producto en dos renglones, product_id no dice cuál se devuelve.
      lines: z.array(z.object({ lineId: z.number(), qty: z.number().positive() })).min(1),
      // BLOQUE DE PARCIALES, paso 5 (Decisión 52): a cuál factura abona la
      // devolución. La propone `returnProposal` (la factura donde viajó el
      // producto); la persona confirma o cambia. Sin esto: la última viva,
      // como siempre (pedidos de una sola entrega).
      fvId: z.number().optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    const boot = await getSql();
    await boot`alter table invoices add column if not exists paid_date date`;
    await boot`alter table invoices add column if not exists inv_class text not null default 'product'`;
    await boot`alter table invoices add column if not exists order_id integer`;
    return withTx(async (sql) => {
    const m = await requireCompany(sql, context.userId);
    await assertCan(sql, context.userId, "sales", "deliver");
    const so = await sql<{
      id: number;
      name: string;
      state: string;
      partner_id: number;
      location_id: number;
      route_kind: string;
      currency: string;
      circuit_code: string | null;
    }>`
      select id, name, state, partner_id, location_id, coalesce(route_kind,'own') as route_kind, currency, circuit_code
      from sales_orders where id = ${data.soId} and company_id = ${m.company_id}
      for update
    `;
    if (!so[0]) throw new Error("Pedido no encontrado");
    // BLOQUE DE PARCIALES, paso 5: ya no exige el pedido completo (`done`).
    // Con entregas por partes un pedido puede tener mercancía en casa del
    // cliente y seguir "por entregar"; lo que se devuelve es lo entregado.
    if (so[0].state === "cancelled" || so[0].state === "draft") throw new Error("Solo se devuelve un pedido con mercancía entregada.");
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
    if (!lines.some((l) => Number(l.qty_delivered) - Number(l.qty_returned) > 0.0001)) {
      throw new Error("No hay nada entregado que devolver en este pedido.");
    }
    const direct = so[0].route_kind === "supplier" || so[0].route_kind === "asr";
    const today = todayMx();
    // La factura a la que abona (Decisión 52): la que la persona confirmó, o
    // la última viva del pedido. Nunca una revertida (paso 4 la deja en
    // `reversed` y el pedido vuelve a `confirmed`; aquí se excluye explícito,
    // no por flujo).
    const fv = data.fvId != null
      ? await sql<{ id: number; residual: string; name: string; currency: string; fx_agreed: string }>`
          select id, residual::text, name, coalesce(currency,'MXN') as currency, coalesce(fx_agreed,1)::text as fx_agreed from invoices
          where company_id = ${m.company_id} and id = ${data.fvId} and order_id = ${so[0].id}
            and kind = 'customer' and name like 'FV-%' and state <> 'reversed' and reverses_id is null
        `
      : await sql<{ id: number; residual: string; name: string; currency: string; fx_agreed: string }>`
          select id, residual::text, name, coalesce(currency,'MXN') as currency, coalesce(fx_agreed,1)::text as fx_agreed from invoices
          where company_id = ${m.company_id} and order_id = ${so[0].id} and kind = 'customer' and name like 'FV-%'
            and state <> 'reversed' and reverses_id is null
          order by id desc limit 1
        `;
    if (data.fvId != null && !fv[0]) throw new Error("Esa factura no es una factura viva de este pedido.");
    // Una devolución abona a una factura (Decisión 38: devolver es una venta
    // real de la que regresa mercancía). Si no hay factura viva, no hay venta
    // que abonar: la mercancía que salió sin facturarse se regresa revirtiendo
    // la entrega (paso 4), no con una nota de crédito sin factura. En directo
    // la FV siempre nace con la entrega, así que ahí no aplica.
    if (!fv[0]) {
      throw new Error(
        `${so[0].name} no tiene factura viva: no hay venta que abonar. Si la mercancía regresó sin haberse facturado, revierte esa entrega (panel de entregas, «Revertir ENV/…»).`,
      );
    }
    // Decisión 42: el folio de la NC se calcula antes de mover inventario, para
    // que el movimiento `return` lleve en `origin` la NC que lo causó — como el
    // `receipt` lleva la OC y el `delivery` el pedido. Así, dentro de un año,
    // se sabe de cuál devolución fue cada movimiento sin leer bitácora.
    const ncName = await nextDocFolio(sql, m.company_id, "NC");
    let credit = 0;
    const posted: string[] = [];
    const costs: Array<{
      productId: number;
      qty: number;
      unitCost: number;
      found: boolean;
      avgBefore: number;
      avgAfter: number;
    }> = [];
    // La misma partida dos veces en un envío pasaría dos veces el candado de
    // `max` (que lee el arreglo en memoria): se rechaza antes de mover nada.
    const vistas = new Set<number>();
    for (const take of data.lines) {
      if (vistas.has(take.lineId)) throw new Error("La misma partida viene dos veces en la devolución: captúrala una sola vez.");
      vistas.add(take.lineId);
    }
    for (const take of data.lines) {
      const src = lines.find((l) => l.id === take.lineId);
      if (!src) throw new Error("Esa partida no está en el pedido");
      const max = Number(src.qty_delivered) - Number(src.qty_returned);
      if (take.qty > max + 0.0001) {
        throw new Error(`No puedes devolver más de lo entregado (${max}).`);
      }
      if (!direct) {
        // Decisión 9: entra al costo con el que SALIÓ, no al promedio de hoy.
        // Si entrara al de hoy, esta devolución cambiaría la utilidad de una
        // venta ya cerrada y aparecería una pérdida o ganancia que nunca
        // existió. Sin salida encontrada (datos viejos) no se bloquea la
        // devolución: entra al promedio de hoy — que es lo que postStock hace
        // solo — y se avisa en pantalla y en bitácora, con folio y número.
        const exitCost = await deliveredUnitCost(sql, m.company_id, so[0].name, src.product_id);
        const avgBefore = await avgCostAt(sql, m.company_id, src.product_id, so[0].location_id);
        const mv = await postStock(sql, {
          companyId: m.company_id,
          userId: context.userId,
          moveType: "return",
          origin: ncName,
          productId: src.product_id,
          quantity: take.qty,
          locationTo: so[0].location_id,
          unitCost: exitCost ?? undefined,
          date: today,
        });
        const avgAfter = await avgCostAt(sql, m.company_id, src.product_id, so[0].location_id);
        posted.push(mv.ref);
        // Decisión 20: el promedio se acepta movido y SE MUESTRA, con el
        // número. Que se vea, no que el sistema finja que nada pasó.
        costs.push({
          productId: src.product_id,
          qty: take.qty,
          unitCost: mv.unitCost,
          found: exitCost != null,
          avgBefore,
          avgAfter,
        });
      }
      await sql`update sales_lines set qty_returned = qty_returned + ${take.qty} where id = ${src.id}`;
      credit += take.qty * Number(src.unit_price);
    }
    if (credit <= 0.009) throw new Error("La devolución no tiene importe");

    const note = (data.reason || "").trim() || `Devolución de ${so[0].name}`;
    // Decisión 82: la NC de una FV en dólares lleva su equivalente en dólares al
    // TC de ESA factura (molde FV/FP), para que ningún lector por amount_fx la cuente en cero.
    const ncFx = fv[0] && fv[0].currency === "USD" && isUsdFx(fv[0].fx_agreed)
      ? { amountFx: -Math.round((credit / Number(fv[0].fx_agreed)) * 100) / 100, fxAgreed: Number(fv[0].fx_agreed) }
      : { amountFx: 0, fxAgreed: 1 };
    const nc = await sql<{ id: number }>`
      insert into invoices (
        company_id, kind, name, partner_id, date, due_date, state, amount, residual, origin, amount_fx, fx_agreed,
        currency, order_id, inv_class, applies_to_id, created_by, circuit_code
      )
      values (
        ${m.company_id}, 'customer', ${ncName}, ${so[0].partner_id}, ${today}, ${today},
        'open', ${-credit}, ${-credit}, ${so[0].name}, ${ncFx.amountFx}, ${ncFx.fxAgreed}, ${so[0].currency}, ${so[0].id}, 'product', ${fv[0]?.id ?? null}, ${context.userId}, ${so[0].circuit_code}
      )
      returning id
    `;
    for (const take of data.lines) {
      const src = lines.find((l) => l.id === take.lineId)!;
      const amt = take.qty * Number(src.unit_price);
      // line_id (migración 0042): de qué partida sale este renglón de la NC,
      // para que la reversa (paso 8) regrese qty_returned a ESA partida.
      await sql`
        insert into invoice_lines (invoice_id, product_id, line_id, qty, unit_price, amount)
        values (${nc[0]!.id}, ${src.product_id}, ${src.id}, ${take.qty}, ${Number(src.unit_price)}, ${-amt})
      `;
    }

    let applied = 0;
    if (fv[0] && Number(fv[0].residual) > 0.009) {
      applied = Math.min(credit, Number(fv[0].residual));
      const payName = await nextDocFolio(sql, m.company_id, "PAG");
      const pay = await sql<{ id: number }>`
        insert into payments (company_id, kind, name, partner_id, amount, memo, created_by, date)
        values (${m.company_id}, 'inbound', ${payName}, ${so[0].partner_id}, ${applied}, ${`Devolución ${ncName}`}, ${context.userId}, ${today})
        returning id
      `;
      await sql`insert into payment_allocs (payment_id, invoice_id, amount) values (${pay[0]!.id}, ${fv[0].id}, ${applied})`;
      await refreshInvoiceResidual(sql, fv[0].id);
    }
    const leftover = credit - applied;
    if (leftover <= 0.009) {
      await sql`update invoices set residual = 0, state = 'paid', paid_date = ${today} where id = ${nc[0]!.id}`;
    } else {
      // NOTA (L3c, Decisión 11 — sigue SIN construir, 19-sep-2026). El crédito
      // que no cupo en ninguna factura viva queda aquí como `residual`
      // NEGATIVO, y ahí está atrapado: `applyInvoicePayment` lo rechaza con
      // «esta factura ya está saldada» (cualquier negativo cumple
      // `residual <= 0.009`, y el mensaje además miente) y
      // `refreshInvoiceResidual` lo colapsaría a $0 la primera vez que algo
      // legítimo lo tocara (`Math.max(0, …)`, `stock.ts`).
      //
      // El mecanismo para arreglarlo YA EXISTE desde el 19-sep-2026: el saldo
      // a favor de L5 (`advance.ts`). Se intentó cerrar aquí el mismo día y se
      // sacó del alcance porque mover este crédito a un saldo a favor cambia
      // TRES cosas a la vez que hay que resolver juntas: el estado de cuenta
      // del cliente (que hoy lo enseña como renglón negativo y dejaría de
      // hacerlo), la posición cambiaria de una NC en dólares
      // (`fx-position-query.ts` cuenta con este negativo) y la reversa de
      // devolución (paso 8, que tendría que llevarse el crédito consigo).
      // Sin las tres, el cliente vería un estado de cuenta $X más alto.
      await sql`update invoices set residual = ${-leftover}, state = 'open' where id = ${nc[0]!.id}`;
    }
    await writeAudit(sql, {
      companyId: m.company_id,
      userId: context.userId,
      action: "devolver",
      entity: "sale",
      entityId: so[0].id,
      name: so[0].name,
      detail: `${ncName}${fv[0] ? ` · abona a ${fv[0].name}${data.fvId != null ? " (elegida)" : ""}` : " · sin factura viva a la que abonar"}${posted.length ? ` · ${posted.join(", ")}` : ""}${
        costs.length ? ` · costo de salida ${costs.map((c) => (c.found ? c.unitCost.toFixed(4) : "SIN SALIDA")).join(", ")}` : ""
      }`,
    });
    // Si alguna partida no encontró con qué costo salió, queda su propio
    // renglón en la bitácora: si pasa alguna vez, se tiene que poder
    // encontrar después, no solo verse una vez en la pantalla.
    const sinSalida = costs.filter((c) => !c.found);
    if (sinSalida.length) {
      const codes = await sql<{ id: number; code: string }>`
        select id, code from products where company_id = ${m.company_id} and id = any(${sinSalida.map((c) => c.productId)})
      `;
      const label = (pid: number) => codes.find((p) => p.id === pid)?.code ?? String(pid);
      await writeAudit(sql, {
        companyId: m.company_id,
        userId: context.userId,
        action: "devolucion-sin-costo-origen",
        entity: "sale",
        entityId: so[0].id,
        name: so[0].name,
        detail: `${ncName} · sin movimiento de salida en el kardex para ${sinSalida
          .map((c) => `${label(c.productId)} (entró al promedio de hoy ${c.unitCost.toFixed(4)})`)
          .join(", ")}`,
      });
    }
    return {
      ok: true,
      nc: ncName,
      fv: fv[0]?.name ?? null,
      refs: posted,
      applied,
      leftover,
      direct,
      note,
      costs,
    };
    });
  });

/**
 * BLOQUE DE PARCIALES, paso 5 (Decisión 52): antes de devolver, en qué
 * factura viajó cada producto y cuánto queda por devolver de cada una. Si una
 * sola factura cubre todo lo que se va a devolver, se propone; si más de una
 * lo cubre, se PREGUNTA (la persona elige); si ninguna sola lo cubre, también
 * se pregunta y se dice por qué. Lo ya devuelto de cada factura se lee de las
 * NC con `applies_to_id` (migración 0036); una NC vieja sin liga no se puede
 * atribuir y se reporta aparte, sin adivinar.
 */
export const returnProposal = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ soId: z.number(), lines: z.array(z.object({ productId: z.number(), qty: z.number().positive() })) }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const m = await requireCompany(sql, context.userId);
    await assertCan(sql, context.userId, "sales", "view");
    const fvs = await sql<{ id: number; name: string; date: string; residual: string; event_ref: string | null }>`
      select id, name, date::text, residual::text, event_ref from invoices
      where company_id = ${m.company_id} and order_id = ${data.soId} and kind = 'customer' and name like 'FV-%'
        and state <> 'reversed' and reverses_id is null
      order by id
    `;
    const invoiced = await sql<{ invoice_id: number; product_id: number; qty: string }>`
      select il.invoice_id, il.product_id, sum(il.qty)::text as qty
      from invoice_lines il join invoices i on i.id = il.invoice_id
      where i.company_id = ${m.company_id} and i.order_id = ${data.soId} and i.kind = 'customer' and i.name like 'FV-%'
        and i.state <> 'reversed' and i.reverses_id is null and il.product_id is not null
      group by il.invoice_id, il.product_id
    `;
    const returned = await sql<{ applies_to_id: number | null; product_id: number; qty: string }>`
      select i.applies_to_id, il.product_id, sum(il.qty)::text as qty
      from invoice_lines il join invoices i on i.id = il.invoice_id
      where i.company_id = ${m.company_id} and i.order_id = ${data.soId} and i.name like 'NC-%'
        and i.state <> 'reversed' and i.reverses_id is null and il.product_id is not null
      group by i.applies_to_id, il.product_id
    `;
    const invoices = fvs.map((f) => {
      const lines = invoiced
        .filter((x) => x.invoice_id === f.id)
        .map((x) => {
          const ret = returned.filter((r) => r.applies_to_id === f.id && r.product_id === x.product_id).reduce((s, r) => s + Number(r.qty), 0);
          return { productId: x.product_id, invoiced: Number(x.qty), returned: ret, available: Math.max(0, Number(x.qty) - ret) };
        });
      return { id: f.id, name: f.name, date: f.date, residual: Number(f.residual), eventRef: f.event_ref, lines };
    });
    const unlinked = returned.filter((r) => r.applies_to_id == null).reduce((s, r) => s + Number(r.qty), 0);
    const covers = (inv: (typeof invoices)[number]) =>
      data.lines.every((l) => (inv.lines.find((x) => x.productId === l.productId)?.available ?? 0) >= l.qty - 0.0001);
    const candidates = data.lines.length ? invoices.filter(covers) : [];
    const proposedId = invoices.length <= 1 ? (invoices[0]?.id ?? null) : candidates.length === 1 ? candidates[0]!.id : null;
    const ask = invoices.length > 1 && candidates.length !== 1;
    const note =
      invoices.length > 1 && data.lines.length && candidates.length === 0
        ? "Ninguna factura sola cubre todo lo que se devuelve: elige a cuál abonar, o divide la devolución en dos."
        : invoices.length > 1 && candidates.length > 1
          ? "Lo que se devuelve viajó en más de una factura: elige a cuál abonar."
          : unlinked > 0.0001
            ? "Hay devoluciones anteriores sin liga a factura (de antes de la migración 0036): no se descuentan de ninguna."
            : null;
    return { invoices, proposedId, ask, candidateIds: candidates.map((c) => c.id), note };
  });

export const listInvoices = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ kind: z.enum(["customer", "supplier", "all"]).optional() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    // La factura de intereses trae su explicación al cliente (calc_client).
    await ensureInvoiceExtras(sql);
    const m = await requireCompany(sql, context.userId);
    await assertCan(sql, context.userId, "credit", "view");
    const me = await activeMember(sql, context.userId);
    const kind = data?.kind && data.kind !== "all" ? data.kind : null;
    const today = todayMx();
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
      amount_fx: string;
      fx_agreed: string;
      fx_paid: string | null;
      origin: string;
      credit_days: number;
      days_overdue: number;
      days_left: number;
      currency: string;
      policy_code: string;
      inv_class: string;
      int_part: string;
      fega_part: string;
      calc_client: string;
      calc: string;
      circuit_code: string | null;
      folio_fiscal: string;
      uuid_fiscal: string;
      supplier_folio: string;
      unreceived: boolean;
      last_payment_id: number | null;
      last_payment_name: string | null;
      sin_timbrar: boolean;
      reverses_name: string | null;
      pendiente_sat: boolean;
      sat_cancelled_at: string | null;
      cancelled_at: string | null;
    }>`
      select i.id, i.kind, i.name, p.name as partner, i.partner_id, p.email as partner_email, p.phone as partner_phone,
        i.date::text, i.due_date::text,
        i.state, i.amount::text, i.residual::text, i.late_amount::text, i.origin,
        coalesce(i.amount_fx,0)::text as amount_fx, coalesce(i.fx_agreed,1)::text as fx_agreed, i.fx_paid::text as fx_paid,
        coalesce(i.credit_days, 0)::int as credit_days,
        greatest(0, (${today}::date - i.due_date))::int as days_overdue,
        (i.due_date - ${today}::date)::int as days_left,
        coalesce(i.currency,'MXN') as currency,
        coalesce(i.policy_code, '') as policy_code,
        coalesce(i.inv_class, 'product') as inv_class,
        coalesce(i.int_part, 0)::text as int_part,
        coalesce(i.fega_part, 0)::text as fega_part,
        coalesce(i.calc_client, '') as calc_client,
        coalesce(i.calc, '') as calc,
        i.circuit_code,
        coalesce(i.folio_fiscal, '') as folio_fiscal,
        coalesce(i.uuid_fiscal, '') as uuid_fiscal,
        coalesce(i.supplier_folio, '') as supplier_folio,
        -- Decisión 23: las FP que nacieron con la OC (defecto que corrige la
        -- Decisión 14) se MARCAN, no se revierten ni se dejan. La marca se
        -- deriva, sin columna: es deuda de una orden que todavía no se recibe.
        -- Se limpia sola al recibir o al cancelar, que es lo que pide la
        -- decisión — sin migración ni proceso de limpieza. Paso 1.3 (bloque
        -- de parciales): event_ref is null la limita a deuda huérfana de
        -- verdad — una FP de recepción parcial, legítima, nace con su evento
        -- puesto y nunca se marca aunque su OC siga en 'confirmed'.
        (i.kind = 'supplier' and i.event_ref is null and exists (
          select 1 from purchase_orders po
          where po.company_id = i.company_id and po.name = i.origin
            and po.state not in ('done','cancelled')
        )) as unreceived,
        -- Paso 5: el último abono VIVO de la factura (sin reversas ni revertidos)
        -- es el único que se puede revertir desde aquí (regla del último abono).
        (select p.id from payment_allocs pa join payments p on p.id = pa.payment_id
          where pa.invoice_id = i.id and p.reverses_id is null
            and not exists (select 1 from payments r where r.reverses_id = p.id)
          order by p.id desc limit 1) as last_payment_id,
        (select p.name from payment_allocs pa join payments p on p.id = pa.payment_id
          where pa.invoice_id = i.id and p.reverses_id is null
            and not exists (select 1 from payments r where r.reverses_id = p.id)
          order by p.id desc limit 1) as last_payment_name,
        -- Paso 7: la NC contraria de una reversa sin folio fiscal capturado.
        (i.kind = 'customer' and i.reverses_id is not null and coalesce(i.folio_fiscal,'') = '' and coalesce(i.uuid_fiscal,'') = '') as sin_timbrar,
        (select o.name from invoices o where o.id = i.reverses_id) as reverses_name,
        -- Paso 8 (Decisión 41): NC de devolución revertida que estaba timbrada y
        -- todavía no se cancela ante el SAT. Se limpia al capturar la fecha.
        (i.kind = 'customer' and i.name like 'NC-%' and i.state = 'reversed' and i.reverses_id is null
          and (coalesce(i.folio_fiscal,'') <> '' or coalesce(i.uuid_fiscal,'') <> '') and i.sat_cancelled_at is null) as pendiente_sat,
        i.sat_cancelled_at::text,
        -- Decisión 75 (Altos #37): una factura revertida se imprime solo como
        -- comprobante interno, marcada, con la fecha en que se revirtió — en
        -- el huso de Azagro (America/Mazatlan), no el del servidor.
        to_char(i.cancelled_at at time zone 'America/Mazatlan', 'YYYY-MM-DD') as cancelled_at
      from invoices i
      join partners p on p.id = i.partner_id
      where i.company_id = ${m.company_id}
        and (${kind}::text is null or i.kind = ${kind})
        and (${me.own_only} = false or p.seller_id = ${context.userId} or p.seller_id is null)
      order by i.due_date, i.id
    `;
  });

/**
 * Puente con Compaq: el folio/UUID del CFDI que timbra Compaq (facturas de
 * cliente) o el folio de la factura del proveedor (facturas de compra), capturados
 * DESPUÉS de emitido el documento porque Compaq timbra más tarde. Vacío no es
 * error: es "todavía no se timbra". Sirve tanto para capturar la primera vez
 * como para corregir; las dos veces quedan en bitácora con el antes y el después.
 */
export const saveInvoiceReference = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      invoiceId: z.number(),
      folioFiscal: z.string().optional(),
      uuidFiscal: z.string().optional(),
      supplierFolio: z.string().optional(),
      /** Decisión 41: cuándo se canceló ante el SAT un CFDI que este sistema revirtió. Vacío = pendiente. */
      satCancelledAt: z.string().optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await ensureInvoiceExtras(sql);
    const m = await requireCompany(sql, context.userId);
    await assertCan(sql, context.userId, "credit", "edit");
    const inv = await sql<{
      id: number;
      kind: string;
      name: string;
      folio_fiscal: string;
      uuid_fiscal: string;
      supplier_folio: string;
      state: string;
      sat_cancelled_at: string | null;
    }>`
      select id, kind, name, coalesce(folio_fiscal,'') as folio_fiscal, coalesce(uuid_fiscal,'') as uuid_fiscal,
        coalesce(supplier_folio,'') as supplier_folio, state, sat_cancelled_at::text
      from invoices where id = ${data.invoiceId} and company_id = ${m.company_id} limit 1
    `;
    if (!inv[0]) throw new Error("Factura no encontrada");
    if (data.supplierFolio !== undefined && inv[0].kind !== "supplier") {
      throw new Error("El folio del proveedor solo aplica a facturas de proveedor.");
    }
    if ((data.folioFiscal !== undefined || data.uuidFiscal !== undefined) && inv[0].kind !== "customer") {
      throw new Error("El folio fiscal y el UUID solo aplican a facturas de cliente.");
    }
    const folioFiscal = data.folioFiscal !== undefined ? data.folioFiscal.trim() : inv[0].folio_fiscal;
    const uuidFiscal = data.uuidFiscal !== undefined ? data.uuidFiscal.trim() : inv[0].uuid_fiscal;
    const supplierFolio = data.supplierFolio !== undefined ? data.supplierFolio.trim() : inv[0].supplier_folio;
    // La fecha de cancelación ante el SAT solo tiene sentido en un documento de
    // cliente que este sistema revirtió y que estaba timbrado.
    let satCancelledAt: string | null = inv[0].sat_cancelled_at;
    if (data.satCancelledAt !== undefined) {
      const v = data.satCancelledAt.trim();
      if (v && inv[0].kind !== "customer") throw new Error("La cancelación ante el SAT solo aplica a documentos de cliente.");
      if (v && inv[0].state !== "reversed") throw new Error(`${inv[0].name} no está revertida: no hay cancelación ante el SAT que registrar.`);
      if (v && !folioFiscal && !uuidFiscal) throw new Error(`${inv[0].name} no tiene folio fiscal ni UUID: no estaba timbrada, no hay nada que cancelar ante el SAT.`);
      satCancelledAt = v || null;
    }
    await sql`
      update invoices set folio_fiscal = ${folioFiscal}, uuid_fiscal = ${uuidFiscal}, supplier_folio = ${supplierFolio},
        sat_cancelled_at = ${satCancelledAt}
      where id = ${inv[0].id}
    `;
    const describe = (folio: string, uuid: string, supplier: string) =>
      [folio ? `folio fiscal ${folio}` : "", uuid ? `UUID ${uuid}` : "", supplier ? `folio proveedor ${supplier}` : ""]
        .filter(Boolean)
        .join(" · ") || "sin captura";
    await writeAudit(sql, {
      companyId: m.company_id,
      userId: context.userId,
      action: "folio-fiscal",
      entity: "invoice",
      entityId: inv[0].id,
      name: inv[0].name,
      detail: `${describe(inv[0].folio_fiscal, inv[0].uuid_fiscal, inv[0].supplier_folio)} → ${describe(folioFiscal, uuidFiscal, supplierFolio)}${
        satCancelledAt !== inv[0].sat_cancelled_at ? ` · cancelada ante el SAT: ${inv[0].sat_cancelled_at ?? "pendiente"} → ${satCancelledAt ?? "pendiente"}` : ""
      }`,
    });
    return { ok: true };
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
      // Vive en Cartera: cobrar/pagar es acción de cartera, no de bancos (el
      // alta de un movimiento suelto en /banks sigue exigiendo banks:edit,
      // en addBankMove).
      await assertCan(sql, context.userId, "credit", "edit");
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
    // Grupo C de la auditoría: la FI es dinero y corre en transacción con la
    // FV bloqueada (for update dentro de issueMoraInvoice). Dos clics toman el
    // candado uno a la vez: el segundo ya lee el interés facturado y no
    // duplica. El alter table del ensure va antes, fuera de la transacción.
    const boot = await getSql();
    await ensureInvoiceExtras(boot);
    return withTx(async (sql) => {
      const m = await requireCompany(sql, context.userId);
      await assertCan(sql, context.userId, "credit", "edit");
      // issueMoraInvoice guarda el cálculo en la FI y escribe la bitácora.
      const r = await issueMoraInvoice(sql, m.company_id, data.invoiceId, { requireCharge: true, userId: context.userId });
      return { charge: r.charge, name: r.name };
    });
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

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { assertCan } from "@/lib/erp/acl";
import { writeAudit } from "@/lib/erp/audit";
import { fxToday, isUsdFx, missingFxMessage } from "@/lib/erp/fx";
import { EXPENSE_CATALOG } from "@/lib/erp/catalog";
import { todayMx } from "@/lib/utils";

type Sql = Awaited<ReturnType<typeof getSql>>;

async function companyOf(sql: Sql, userId: string) {
  const rows = await sql<{ company_id: number }>`
    select company_id from members where user_id = ${userId} and status = 'active' limit 1
  `;
  if (!rows[0]) throw new Error("Sin empresa");
  return rows[0].company_id;
}

export async function seedExpenseCategories(sql: Sql, companyId: number) {
  await sql.query(`
    create table if not exists expense_categories (
      id serial primary key,
      company_id integer not null references companies(id) on delete cascade,
      code text not null,
      name text not null,
      class text not null default 'operativo',
      unique (company_id, code)
    )
  `);
  await sql.query(`
    create table if not exists expenses (
      id serial primary key,
      company_id integer not null references companies(id) on delete cascade,
      name text not null,
      date date not null default current_date,
      class text not null default 'operativo',
      category_id integer references expense_categories(id),
      amount numeric(14,2) not null,
      partner_id integer references partners(id),
      so_id integer references sales_orders(id),
      po_id integer references purchase_orders(id),
      invoice_ref text not null default '',
      pay_kind text not null default 'cash',
      bank_id integer references banks(id),
      bank_move_id integer references bank_moves(id),
      notes text not null default '',
      created_by text not null default '',
      created_at timestamptz not null default now()
    )
  `);
  await sql.query(`alter table bank_moves add column if not exists kind text not null default 'ajuste'`);
  await sql.query(`alter table bank_moves add column if not exists expense_id integer`);
  await sql.query(`alter table bank_moves add column if not exists so_id integer`);
  await sql.query(`alter table bank_moves add column if not exists po_id integer`);
  await sql.query(`alter table bank_moves add column if not exists invoice_id integer`);
  for (const c of EXPENSE_CATALOG) {
    await sql`
      insert into expense_categories (company_id, code, name, class)
      values (${companyId}, ${c.code}, ${c.name}, ${c.class})
      on conflict (company_id, code) do update set name = excluded.name, class = excluded.class
    `;
  }
}

export const listExpenses = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    await assertCan(sql, context.userId, "gastos", "view");
    const cid = await companyOf(sql, context.userId);
    await seedExpenseCategories(sql, cid);
    const expenses = await sql<{
      id: number;
      name: string;
      date: string;
      class: string;
      category: string | null;
      amount: string;
      partner: string | null;
      so_name: string | null;
      po_name: string | null;
      pay_kind: string;
      invoice_ref: string;
      notes: string;
      is_freight: boolean;
      event_ref: string;
    }>`
      select e.id, e.name, e.date::text, e.class, c.name as category, e.amount::text,
        p.name as partner, s.name as so_name, po.name as po_name, e.pay_kind, e.invoice_ref, e.notes,
        coalesce(e.is_freight, false) as is_freight, coalesce(e.event_ref,'') as event_ref
      from expenses e
      left join expense_categories c on c.id = e.category_id
      left join partners p on p.id = e.partner_id
      left join sales_orders s on s.id = e.so_id
      left join purchase_orders po on po.id = e.po_id
      where e.company_id = ${cid}
      order by e.date desc, e.id desc
      limit 200
    `;
    const categories = await sql<{ id: number; code: string; name: string; class: string }>`
      select id, code, name, class from expense_categories where company_id = ${cid} order by class, name
    `;
    const partners = await sql<{ id: number; name: string; is_customer: boolean; is_supplier: boolean }>`
      select id, name, is_customer, is_supplier from partners where company_id = ${cid} order by name
    `;
    const sales = await sql<{ id: number; name: string; partner: string }>`
      select s.id, s.name, p.name as partner
      from sales_orders s join partners p on p.id = s.partner_id
      where s.company_id = ${cid} order by s.id desc limit 80
    `;
    const purchases = await sql<{ id: number; name: string; partner: string }>`
      select po.id, po.name, p.name as partner
      from purchase_orders po join partners p on p.id = po.partner_id
      where po.company_id = ${cid} order by po.id desc limit 80
    `;
    const banks = await sql<{ id: number; name: string; currency: string }>`
      select id, name, currency from banks where company_id = ${cid} order by id
    `;
    // El TC vigente hoy, para PROPONERLO cuando el gasto sale de una cuenta en
    // dólares (D86). Se propone y se corrige, como en la OC y en la compra de
    // dólares; sin renglón en la tabla la pantalla lo pide vacío y el servidor
    // se detiene (regla 9).
    const fx = await fxToday(sql, cid, todayMx());
    return { expenses, categories, partners, sales, purchases, banks, fxToday: fx ? { date: fx.date, rate: Number(fx.rate) } : null };
  });

/**
 * CORREGIR LA MARCA DE FLETE DE UN GASTO YA CAPTURADO (Decisión 99).
 *
 * Sin esto la Decisión 99 solo serviría para los gastos que nazcan de hoy en
 * adelante: un flete capturado ayer se quedaría restando dos veces para
 * siempre, y unas maniobras marcadas por error subirían el margen sin forma de
 * bajarlo. Un candado sin salida es peor que el bug que tapa.
 *
 * No mueve un peso: el importe, la fecha, la cuenta y el movimiento de banco
 * quedan intactos. Lo único que cambia es a qué renglón del costo pertenece,
 * y queda en bitácora con el número que se mueve.
 */
export const setExpenseFreight = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ id: z.number(), isFreight: z.boolean() }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await assertCan(sql, context.userId, "gastos", "edit");
    const cid = await companyOf(sql, context.userId);
    const e = await sql<{ id: number; name: string; amount: string; so_id: number | null; is_freight: boolean; event_ref: string }>`
      select id, name, amount::text, so_id, coalesce(is_freight, false) as is_freight, coalesce(event_ref,'') as event_ref
      from expenses where id = ${data.id} and company_id = ${cid}
    `;
    if (!e[0]) throw new Error("No existe ese gasto");
    // Decisión 101: el MISMO candado que al crear el gasto. `createExpense` se
    // detenía y esta puerta no: un candado que deja la puerta de al lado
    // abierta no es un candado (regla 5g).
    if (data.isFreight && e[0].event_ref) {
      throw new Error(
        "Este gasto ya está ligado a un viaje, así que su costo ya entró al de la mercancía. Marcarlo también como flete del pedido lo restaría dos veces.",
      );
    }
    if (data.isFreight && !e[0].so_id) {
      throw new Error("Marca el flete contra el pedido de venta al que pertenece: el flete de una orden de compra todavía no tiene a dónde ir");
    }
    if (e[0].is_freight === data.isFreight) return { ok: true as const, changed: false };
    await sql`update expenses set is_freight = ${data.isFreight} where id = ${data.id} and company_id = ${cid}`;
    await writeAudit(sql, {
      companyId: cid,
      userId: context.userId,
      action: data.isFreight ? "marcar-flete" : "desmarcar-flete",
      entity: "expense",
      entityId: e[0].id,
      name: e[0].name,
      detail: data.isFreight
        ? `${Number(e[0].amount).toFixed(2)} pasa a ser el flete del pedido: sustituye al cotizado en la utilidad`
        : `${Number(e[0].amount).toFixed(2)} deja de ser el flete del pedido: vuelve a contar como costo aparte y regresa el flete cotizado`,
    });
    return { ok: true as const, changed: true };
  });

export const addExpenseCategory = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ name: z.string().min(2), class: z.enum(["operativo", "pedido", "financiero"]) }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await assertCan(sql, context.userId, "gastos", "edit");
    const cid = await companyOf(sql, context.userId);
    const code = data.name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .slice(0, 16);
    const row = await sql<{ id: number; name: string }>`
      insert into expense_categories (company_id, code, name, class)
      values (${cid}, ${code || "CAT"}, ${data.name}, ${data.class})
      on conflict (company_id, code) do update set name = excluded.name
      returning id, name
    `;
    return row[0]!;
  });

export const createExpense = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      date: z.string(),
      class: z.enum(["operativo", "pedido", "financiero"]),
      categoryId: z.number(),
      amount: z.number().positive(),
      partnerId: z.number().optional(),
      soId: z.number().optional(),
      poId: z.number().optional(),
      payKind: z.enum(["cash", "credit"]),
      bankId: z.number().optional(),
      // Decisión 86: si el gasto sale de una cuenta EN DÓLARES, el importe se
      // captura en pesos y se declara el tipo de cambio del día. Sin él, un
      // gasto de $5,000 sacaba 5,000 DÓLARES de la cuenta y destruía el costo
      // en pesos del resto de los dólares (`usdCashAverage`).
      fxRate: z.number().optional(),
      // Decisión 100: el viaje de compra que este gasto pagó (el folio de la
      // recepción, RCP/000N). Deja compararlo contra lo que se comprometió al
      // capturar el viaje — la misma forma de la Decisión 99, lo comprometido
      // en el documento y lo pagado en el gasto. Sin esto, «Pagado» en la
      // pantalla de compras prometía una comparación sin manera de capturarla.
      eventRef: z.string().optional(),
      // Decisión 99: este gasto ES el flete del pedido, no un costo extra.
      // Marca estructural, no el nombre de la categoría: el flete real manda
      // sobre el cotizado y el cotizado deja de restar. Sin esto, el mismo
      // flete se restaba dos veces de la utilidad.
      isFreight: z.boolean().optional().default(false),
      invoiceRef: z.string().optional().default(""),
      notes: z.string().optional().default(""),
    }),
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await assertCan(sql, context.userId, "gastos", "edit");
    const cid = await companyOf(sql, context.userId);
    if (data.class === "pedido" && !data.soId && !data.poId) {
      throw new Error("Un gasto sobre pedido debe ligarse a una venta o una compra");
    }
    // Decisión 99: el flete es el flete DE un pedido de venta, porque la
    // utilidad del pedido lee sus gastos por ahí (`orderExpenses`). Marcado
    // contra una orden de COMPRA quedaría huérfano: no sustituiría nada y la
    // tarjeta seguiría diciendo «todavía no se captura», que sería falso para
    // quien acaba de capturarlo. El flete de una compra va al costo de la
    // mercancía en el kardex, y esa pieza no está construida (ESTADO H7).
    // El viaje tiene que existir, y pertenecer a la orden de compra ligada: un
    // folio suelto dejaría un pago colgando de nada.
    if (data.eventRef) {
      if (!data.poId) throw new Error("Para ligarlo a un viaje, liga el gasto a la orden de compra que llegó en él");
      const viaje = await sql<{ n: number }>`
        select count(*)::int as n from stock_moves m
        join purchase_orders po on po.company_id = m.company_id and po.name = m.origin
        where m.company_id = ${cid} and po.id = ${data.poId}
          and m.event_ref = ${data.eventRef} and m.move_type = 'receipt'
      `;
      if (!viaje[0]?.n) throw new Error(`La recepción ${data.eventRef} no pertenece a esa orden de compra`);
    }
    // Decisión 101: un gasto ligado a un VIAJE ya entró al costo de la
    // mercancía en el kardex. Marcarlo además como flete del pedido lo
    // restaría una segunda vez de la utilidad — el doble conteo de la Decisión
    // 99, entrando por la puerta de al lado.
    if (data.isFreight && data.eventRef) {
      throw new Error(
        "Este gasto ya está ligado a un viaje, así que su costo ya entró al de la mercancía. Marcarlo también como flete del pedido lo restaría dos veces.",
      );
    }
    if (data.isFreight && !data.soId) {
      throw new Error("Marca el flete contra el pedido de venta al que pertenece: el flete de una orden de compra todavía no tiene a dónde ir");
    }
    if (data.payKind === "cash" && !data.bankId) throw new Error("Elige la cuenta de donde sale el dinero");
    const n = await sql<{ c: number }>`select count(*)::int as c from expenses where company_id = ${cid}`;
    const name = `GAS-${String((n[0]?.c ?? 0) + 1).padStart(4, "0")}`;
    const exp = await sql<{ id: number }>`
      insert into expenses (company_id, name, date, class, category_id, amount, partner_id, so_id, po_id, invoice_ref, pay_kind, bank_id, notes, created_by, is_freight, event_ref)
      values (${cid}, ${name}, ${data.date}, ${data.class}, ${data.categoryId}, ${data.amount},
        ${data.partnerId ?? null}, ${data.soId ?? null}, ${data.poId ?? null}, ${data.invoiceRef ?? ""},
        ${data.payKind}, ${data.bankId ?? null}, ${data.notes ?? ""}, ${context.userId}, ${data.isFreight === true}, ${data.eventRef ?? ""})
      returning id
    `;
    if (data.payKind === "cash" && data.bankId) {
      const cat = await sql<{ name: string }>`select name from expense_categories where id = ${data.categoryId}`;
      // De una cuenta en dólares salen DÓLARES: el importe en pesos se
      // convierte con el TC declarado, y el movimiento guarda los dos (D86).
      const cuenta = await sql<{ currency: string; name: string }>`
        select coalesce(currency,'MXN') as currency, name from banks where id = ${data.bankId} and company_id = ${cid}
      `;
      const enDolares = cuenta[0]?.currency === "USD";
      if (enDolares && !isUsdFx(data.fxRate)) {
        throw new Error(missingFxMessage(`el gasto pagado desde ${cuenta[0]?.name ?? "la cuenta en dólares"}`));
      }
      const pesos = Math.abs(data.amount);
      const dolares = enDolares ? Math.round((pesos / Number(data.fxRate)) * 100) / 100 : 0;
      const mv = await sql<{ id: number }>`
        insert into bank_moves (company_id, bank_id, date, amount, memo, partner_id, kind, expense_id, so_id, po_id, created_by, amount_fx, fx_rate)
        values (${cid}, ${data.bankId}, ${data.date}, ${enDolares ? -dolares : -pesos}, ${cat[0]?.name ?? name},
          ${data.partnerId ?? null}, 'gasto', ${exp[0]!.id}, ${data.soId ?? null}, ${data.poId ?? null}, ${context.userId},
          ${enDolares ? -dolares : 0}, ${enDolares ? Number(data.fxRate) : null})
        returning id
      `;
      await sql`update expenses set bank_move_id = ${mv[0]!.id} where id = ${exp[0]!.id}`;
    }
    return { id: exp[0]!.id, name };
  });

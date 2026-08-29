import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { assertCan } from "@/lib/erp/acl";
import { EXPENSE_CATALOG } from "@/lib/erp/catalog";

type Sql = Awaited<ReturnType<typeof getSql>>;

async function companyOf(sql: Sql, userId: string) {
  const rows = await sql<{ company_id: number }>`
    select company_id from members where user_id = ${userId} limit 1
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
    }>`
      select e.id, e.name, e.date::text, e.class, c.name as category, e.amount::text,
        p.name as partner, s.name as so_name, po.name as po_name, e.pay_kind, e.invoice_ref, e.notes
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
    return { expenses, categories, partners, sales, purchases, banks };
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
    if (data.payKind === "cash" && !data.bankId) throw new Error("Elige la cuenta de donde sale el dinero");
    const n = await sql<{ c: number }>`select count(*)::int as c from expenses where company_id = ${cid}`;
    const name = `GAS-${String((n[0]?.c ?? 0) + 1).padStart(4, "0")}`;
    const exp = await sql<{ id: number }>`
      insert into expenses (company_id, name, date, class, category_id, amount, partner_id, so_id, po_id, invoice_ref, pay_kind, bank_id, notes, created_by)
      values (${cid}, ${name}, ${data.date}, ${data.class}, ${data.categoryId}, ${data.amount},
        ${data.partnerId ?? null}, ${data.soId ?? null}, ${data.poId ?? null}, ${data.invoiceRef ?? ""},
        ${data.payKind}, ${data.bankId ?? null}, ${data.notes ?? ""}, ${context.userId})
      returning id
    `;
    if (data.payKind === "cash" && data.bankId) {
      const cat = await sql<{ name: string }>`select name from expense_categories where id = ${data.categoryId}`;
      const mv = await sql<{ id: number }>`
        insert into bank_moves (company_id, bank_id, date, amount, memo, partner_id, kind, expense_id, so_id, po_id, created_by)
        values (${cid}, ${data.bankId}, ${data.date}, ${-Math.abs(data.amount)}, ${cat[0]?.name ?? name},
          ${data.partnerId ?? null}, 'gasto', ${exp[0]!.id}, ${data.soId ?? null}, ${data.poId ?? null}, ${context.userId})
        returning id
      `;
      await sql`update expenses set bank_move_id = ${mv[0]!.id} where id = ${exp[0]!.id}`;
    }
    return { id: exp[0]!.id, name };
  });

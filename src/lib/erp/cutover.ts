import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { dbSource, getSql, withTx, type Sql } from "@/lib/db";
import { assertCan } from "@/lib/erp/acl";
import { writeAudit } from "@/lib/erp/audit";
import { foldName } from "@/lib/erp/catalog";
import { ensureInvoiceExtras, postStock } from "@/lib/erp/stock";

async function cid(sql: Sql, userId: string) {
  const rows = await sql<{ company_id: number }>`select company_id from members where user_id = ${userId} and status = 'active' limit 1`;
  if (!rows[0]) throw new Error("Sin empresa");
  return rows[0].company_id;
}

function splitCsv(text: string) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function cells(line: string) {
  if (line.includes("\t")) return line.split("\t").map((c) => c.trim());
  return line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
}

function num(v: string) {
  const n = Number(String(v || "0").replace(/,/g, "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export const dbStatus = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    await assertCan(sql, context.userId, "settings", "view");
    return {
      source: dbSource,
      label: dbSource === "neon" ? "Postgres (producción)" : "Preview local — al desplegar con base, aquí sale Postgres",
    };
  });

export const exportBackup = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    await assertCan(sql, context.userId, "settings", "view");
    const companyId = await cid(sql, context.userId);
    const company = await sql<{ name: string }>`select name from companies where id = ${companyId}`;
    const invoices = await sql<{ name: string; kind: string; partner: string; amount: string; residual: string; due_date: string; currency: string; origin: string }>`
      select i.name, i.kind, p.name as partner, i.amount::text, i.residual::text, i.due_date::text,
        coalesce(i.currency,'MXN') as currency, coalesce(i.origin,'') as origin
      from invoices i join partners p on p.id = i.partner_id
      where i.company_id = ${companyId} order by i.id
    `;
    const quants = await sql<{ product: string; location: string; qty: string; cost: string }>`
      select p.code as product, l.name as location, q.quantity::text, coalesce(q.avg_cost, p.cost)::text as cost
      from stock_quants q join products p on p.id = q.product_id join locations l on l.id = q.location_id
      where q.company_id = ${companyId} and abs(q.quantity) > 0.0001
      order by p.code, l.name
    `;
    const partners = await sql<{ c: number }>`select count(*)::int as c from partners where company_id = ${companyId}`;
    const products = await sql<{ c: number }>`select count(*)::int as c from products where company_id = ${companyId}`;
    return {
      at: new Date().toISOString(),
      db: dbSource,
      company: company[0] ?? { name: "Azagro" },
      counts: { partners: partners[0]?.c ?? 0, products: products[0]?.c ?? 0, invoices: invoices.length, stock: quants.length },
      invoices,
      stock: quants,
    };
  });

const invRow = z.object({
  partnerCode: z.string(),
  folio: z.string(),
  date: z.string(),
  due: z.string(),
  cargo: z.number(),
  abono: z.number(),
  saldo: z.number(),
  currency: z.enum(["MXN", "USD"]),
  kind: z.enum(["customer", "supplier"]),
});

export function parseOpenInvoices(raw: string): z.infer<typeof invRow>[] {
  const lines = splitCsv(raw);
  const out: z.infer<typeof invRow>[] = [];
  for (const line of lines) {
    const c = cells(line);
    if (!c[0] || /codigo|código|partner|cliente|proveedor|folio/i.test(c[0]!) && out.length === 0) continue;
    const kind = /prov|pagar|supplier|fp/i.test(c[8] || c[0] || "") ? "supplier" : "customer";
    const folio = (c[1] || c[2] || "").replace(/\s+/g, "-");
    const saldo = num(c[6] || c[5] || "0");
    if (!folio || Math.abs(saldo) < 0.009) continue;
    out.push({
      partnerCode: (c[0] || "").toUpperCase(),
      folio,
      date: (c[2] || c[3] || new Date().toISOString().slice(0, 10)).slice(0, 10),
      due: (c[3] || c[4] || c[2] || new Date().toISOString().slice(0, 10)).slice(0, 10),
      cargo: num(c[4] || c[5] || "0"),
      abono: num(c[5] || "0"),
      saldo,
      currency: /usd|dll/i.test(c[7] || "") ? "USD" : "MXN",
      kind,
    });
  }
  return out;
}

export const previewOpenInvoices = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ csv: z.string().min(3) }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await assertCan(sql, context.userId, "settings", "edit");
    const companyId = await cid(sql, context.userId);
    await sql`alter table invoices add column if not exists cutover_key text`;
    const parsed = parseOpenInvoices(data.csv);
    const rows = [];
    for (const r of parsed) {
      const key = `${r.kind}:${r.partnerCode}:${r.folio}`;
      const exists = await sql<{ id: number }>`
        select id from invoices where company_id = ${companyId} and cutover_key = ${key} limit 1
      `;
      const partner = await sql<{ id: number; name: string }>`
        select id, name from partners where company_id = ${companyId} and upper(code) = ${r.partnerCode} limit 1
      `;
      rows.push({
        ...r,
        key,
        partnerName: partner[0]?.name ?? "",
        partnerId: partner[0]?.id ?? 0,
        skip: Boolean(exists[0]),
      });
    }
    return { rows, open: rows.filter((r) => !r.skip).length, skipped: rows.filter((r) => r.skip).length };
  });

export const applyOpenInvoices = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ csv: z.string().min(3) }))
  .handler(async ({ context, data }) => {
    const boot = await getSql();
    await boot`alter table invoices add column if not exists cutover_key text`;
    await boot`alter table invoices add column if not exists opening_paid numeric(14,2) not null default 0`;
    await ensureInvoiceExtras(boot);
    await boot.query(
      `create unique index if not exists invoices_cutover_key_uq on invoices (company_id, cutover_key) where cutover_key is not null`,
    );
    try {
    return await withTx(async (sql) => {
      await assertCan(sql, context.userId, "settings", "edit");
      const companyId = await cid(sql, context.userId);
      const parsed = parseOpenInvoices(data.csv);
      let inserted = 0;
      let skipped = 0;
      for (const r of parsed) {
        const key = `${r.kind}:${r.partnerCode}:${r.folio}`;
        const exists = await sql<{ id: number }>`
          select id from invoices where company_id = ${companyId} and cutover_key = ${key} limit 1
        `;
        if (exists[0]) {
          skipped += 1;
          continue;
        }
        let partner = await sql<{ id: number }>`
          select id from partners where company_id = ${companyId} and upper(code) = ${r.partnerCode} limit 1
        `;
        if (!partner[0]) {
          const folded = foldName(r.partnerCode);
          partner = await sql<{ id: number }>`
            select id from partners where company_id = ${companyId} and upper(name) = ${folded} limit 1
          `;
        }
        if (!partner[0]) throw new Error(`No está en catálogo el código ${r.partnerCode} (folio ${r.folio}). Carga catálogos Compaq primero.`);
        const cargo = r.cargo || r.saldo + r.abono;
        // El abono que ya traía en Compaq queda registrado: el saldo de aquí
        // en adelante es cargo − abono de corte − pagos capturados en el sistema.
        const openingPaid = Math.max(0, cargo - r.saldo);
        await sql`
          insert into invoices (company_id, kind, name, partner_id, date, due_date, state, amount, residual, origin, currency, cutover_key, opening_paid, created_by)
          values (
            ${companyId}, ${r.kind}, ${r.folio}, ${partner[0].id}, ${r.date}, ${r.due}, 'open',
            ${cargo}, ${r.saldo}, ${"Corte Compaq"}, ${r.currency}, ${key}, ${openingPaid}, ${context.userId}
          )
        `;
        inserted += 1;
      }
      await writeAudit(sql, {
        companyId,
        userId: context.userId,
        action: "corte",
        entity: "invoice",
        name: "Saldos abiertos Compaq",
        detail: `entraron ${inserted}, ya estaban ${skipped}`,
      });
      return { inserted, skipped };
    });
    } catch (err) {
      // La importación fallida (que se revierte completa) también deja rastro.
      await logImportFailure(boot, context.userId, "Saldos abiertos Compaq", err);
      throw err;
    }
  });

/** Registra en bitácora una importación que tronó (fuera de la transacción que se revirtió). */
async function logImportFailure(boot: Sql, userId: string, what: string, err: unknown) {
  try {
    const me = await boot<{ company_id: number }>`
      select company_id from members where user_id = ${userId} and status = 'active' limit 1
    `;
    if (!me[0]) return;
    await writeAudit(boot, {
      companyId: me[0].company_id,
      userId,
      action: "importacion-fallida",
      entity: "cutover",
      name: what,
      detail: (err instanceof Error ? err.message : "Error").slice(0, 400),
    });
  } catch {
    /* el registro del fallo nunca debe tapar el error original */
  }
}

const stockRow = z.object({
  productCode: z.string(),
  locationCode: z.string(),
  qty: z.number(),
  cost: z.number(),
});

export function parseStockSnap(raw: string): z.infer<typeof stockRow>[] {
  const out: z.infer<typeof stockRow>[] = [];
  for (const line of splitCsv(raw)) {
    const c = cells(line);
    if (!c[0] || /producto|codigo|código|code/i.test(c[0]!) && out.length === 0) continue;
    const qty = num(c[2] || c[1] || "0");
    if (qty <= 0.0001) continue;
    out.push({
      productCode: (c[0] || "").toUpperCase(),
      locationCode: (c[1] || "001").toUpperCase(),
      qty,
      cost: num(c[3] || c[2] || "0"),
    });
  }
  return out;
}

export const applyStockSnap = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ csv: z.string().min(3) }))
  .handler(async ({ context, data }) => {
    const boot = await getSql();
    await boot.query(
      `create unique index if not exists stock_moves_opening_cutover_uq
       on stock_moves (company_id, product_id, location_to)
       where move_type = 'opening' and origin = 'Corte Compaq'`,
    );
    try {
    return await withTx(async (sql) => {
      await assertCan(sql, context.userId, "inventory", "edit");
      const companyId = await cid(sql, context.userId);
      const parsed = parseStockSnap(data.csv);
      let inserted = 0;
      let skipped = 0;
      for (const r of parsed) {
        const product = await sql<{ id: number }>`
          select id from products where company_id = ${companyId} and upper(code) = ${r.productCode} limit 1
        `;
        if (!product[0]) throw new Error(`Producto ${r.productCode} no está en catálogo`);
        const loc = await sql<{ id: number }>`
          select id from locations
          where company_id = ${companyId} and (upper(code) = ${r.locationCode} or upper(name) = ${r.locationCode})
          limit 1
        `;
        if (!loc[0]) throw new Error(`Bodega ${r.locationCode} no está en catálogo`);
        const already = await sql<{ id: number }>`
          select id from stock_moves
          where company_id = ${companyId} and product_id = ${product[0].id} and location_to = ${loc[0].id}
            and move_type = 'opening' and origin = 'Corte Compaq'
          limit 1
          for update
        `;
        if (already[0]) {
          skipped += 1;
          continue;
        }
        await postStock(sql, {
          companyId,
          userId: context.userId,
          moveType: "opening",
          origin: "Corte Compaq",
          productId: product[0].id,
          quantity: r.qty,
          locationTo: loc[0].id,
          unitCost: r.cost,
        });
        inserted += 1;
      }
      await writeAudit(sql, {
        companyId,
        userId: context.userId,
        action: "corte",
        entity: "stock",
        name: "Existencias de corte",
        detail: `entraron ${inserted}, ya estaban ${skipped}`,
      });
      return { inserted, skipped };
    });
    } catch (err) {
      await logImportFailure(boot, context.userId, "Existencias de corte", err);
      throw err;
    }
  });

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { dbSource, getSql, withTx, type Sql } from "@/lib/db";
import { assertCan } from "@/lib/erp/acl";
import { writeAudit } from "@/lib/erp/audit";
import { todayMx } from "@/lib/utils";
import { foldName } from "@/lib/erp/catalog";
import { ensureInvoiceExtras, postStock } from "@/lib/erp/stock";
import { CIRCUIT_LABEL, CUTOVER_CIRCUIT } from "@/lib/erp/circuits";
import { guardSaleTerms } from "@/lib/erp/sale-terms";
import {
  applyOpenInvoiceRows,
  applyStockRows,
  parseOpenInvoices as parseOpenInvoicesCore,
  parseStockSnap,
  previewOpenInvoiceRows,
  previewStockRows,
  applyBankRows,
  parseBankSnap,
  previewBankRows,
} from "@/lib/erp/cutover-core";

async function cid(sql: Sql, userId: string) {
  const rows = await sql<{ company_id: number }>`select company_id from members where user_id = ${userId} and status = 'active' limit 1`;
  if (!rows[0]) throw new Error("Sin empresa");
  return rows[0].company_id;
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

/** El parseo vive en cutover-core.ts (probado en PGlite); aquí solo se le pone la fecha de hoy. */
export function parseOpenInvoices(raw: string) {
  return parseOpenInvoicesCore(raw, todayMx());
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
    return previewOpenInvoiceRows(sql, { companyId, rows: parsed, today: todayMx() });
  });

/**
 * Saldos abiertos del corte Compaq.
 *
 * La política de cobro se PIDE: hasta el 3-sep-2026 estas facturas nacían con
 * el `default 'NONE'` de la columna, es decir «Sin mora», y eso es un valor por
 * omisión que decide dinero (regla 9: el sistema no lo supone). Sin política
 * elegida no se pega nada.
 */
export const applyOpenInvoices = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      csv: z.string().min(3),
      policyCode: z.string().min(1),
      // Decisión 72: días del plazo financiero; sin capturarlos no se pega nada.
      creditDays: z.number().int().positive("Captura los días del plazo financiero de estos saldos (p. ej. 150)."),
    }),
  )
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
      // La política tiene que existir: no se acepta un código escrito a mano.
      const pol = await sql<{ code: string; name: string }>`
        select code, name from credit_policies where company_id = ${companyId} and code = ${data.policyCode} limit 1
      `;
      if (!pol[0]) {
        throw new Error(
          `Elige la política de cobro con la que entran estos saldos: «${data.policyCode}» no existe en Ajustes → Políticas de cobro.`,
        );
      }
      // Decisión 72 + Decisiones 68-69: con plazo financiero, cada saldo de
      // cliente es un documento a crédito y la política tiene que cuadrar con
      // el plazo — «Sin mora» con 150 días no nace aquí tampoco (hallazgo del
      // revisor de dinero, 17-sep-2026). Misma regla única que saveOrder,
      // createSale, decideQuote y la OC del cliente.
      await guardSaleTerms(sql, companyId, { creditDays: data.creditDays, policyCode: data.policyCode });
      const parsed = parseOpenInvoices(data.csv);
      const { inserted, skipped, rejected } = await applyOpenInvoiceRows(sql, {
        companyId,
        userId: context.userId,
        policyCode: data.policyCode,
        circuitCode: CUTOVER_CIRCUIT,
        rows: parsed,
        foldName,
        today: todayMx(),
        creditDays: data.creditDays,
      });
      await writeAudit(sql, {
        companyId,
        userId: context.userId,
        action: "corte",
        entity: "invoice",
        name: "Saldos abiertos Compaq",
        detail: `entraron ${inserted}, ya estaban ${skipped}, rechazadas ${rejected.length} · política de cobro ${pol[0].name} (${pol[0].code}) · plazo financiero ${data.creditDays} días (Decisión 72) · circuito ${CIRCUIT_LABEL[CUTOVER_CIRCUIT]}${rejectNote(rejected)}`,
      });
      return { inserted, skipped, rejected };
    });
    } catch (err) {
      // La importación fallida (que se revierte completa) también deja rastro.
      await logImportFailure(boot, context.userId, "Saldos abiertos Compaq", err);
      throw err;
    }
  });

/** Las primeras razones de rechazo, acotadas, para que la bitácora diga POR QUÉ (Decisión 66). */
function rejectNote(rejected: { reason: string }[]) {
  if (!rejected.length) return "";
  return ` · ${rejected.slice(0, 3).map((x) => x.reason).join(" | ").slice(0, 300)}${rejected.length > 3 ? " …" : ""}`;
}

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

export const previewStockSnap = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ csv: z.string().min(3) }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await assertCan(sql, context.userId, "inventory", "edit");
    const companyId = await cid(sql, context.userId);
    return previewStockRows(sql, { companyId, rows: parseStockSnap(data.csv) });
  });

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
      const { inserted, skipped, rejected } = await applyStockRows(sql, {
        companyId,
        userId: context.userId,
        rows: parsed,
        postStock,
      });
      await writeAudit(sql, {
        companyId,
        userId: context.userId,
        action: "corte",
        entity: "stock",
        name: "Existencias de corte",
        detail: `entraron ${inserted}, ya estaban ${skipped}, rechazadas ${rejected.length}${rejectNote(rejected)}`,
      });
      return { inserted, skipped, rejected };
    });
    } catch (err) {
      await logImportFailure(boot, context.userId, "Existencias de corte", err);
      throw err;
    }
  });

/**
 * Bancos del corte (Decisión 63, migración 0038): el saldo inicial de cada
 * cuenta como movimiento de banco con fecha, idempotente, conciliado. Ver
 * el encabezado de la sección en cutover-core.ts.
 */
export const previewBankSnap = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ csv: z.string().min(3) }))
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await assertCan(sql, context.userId, "banks", "edit");
    const companyId = await cid(sql, context.userId);
    return previewBankRows(sql, { companyId, rows: parseBankSnap(data.csv, todayMx()) });
  });

export const applyBankSnap = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ csv: z.string().min(3) }))
  .handler(async ({ context, data }) => {
    const boot = await getSql();
    try {
      return await withTx(async (sql) => {
        await assertCan(sql, context.userId, "banks", "edit");
        const companyId = await cid(sql, context.userId);
        const { inserted, skipped, rejected } = await applyBankRows(sql, {
          companyId,
          userId: context.userId,
          rows: parseBankSnap(data.csv, todayMx()),
        });
        await writeAudit(sql, {
          companyId,
          userId: context.userId,
          action: "corte",
          entity: "bank",
          name: "Saldos iniciales de bancos",
          detail: `entraron ${inserted}, ya estaban ${skipped}, rechazadas ${rejected.length}${rejectNote(rejected)}`,
        });
        return { inserted, skipped, rejected };
      });
    } catch (err) {
      await logImportFailure(boot, context.userId, "Saldos iniciales de bancos", err);
      throw err;
    }
  });

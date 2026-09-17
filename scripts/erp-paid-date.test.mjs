// paid_date = LA FECHA DEL DINERO — hallazgo #18 de la auditoría, 17-sep-2026.
//
// Antes `refreshInvoiceResidual` escribía `paid_date = hoy` al liquidar, y
// `applyInvoicePayment` corría ese refresh ANTES de su propio update con la
// fecha del cobro: un cobro del viernes capturado el lunes quedaba pagado el
// lunes — tres días de mora de más en el estado de cuenta, en la FI manual y
// en el P&L. Ahora la fecha sale del último abono VIVO (sin reverses_id y sin
// contrario); hoy solo como respaldo. La sentencia copiada tal cual sobre
// PGlite con las migraciones reales, y el cableado.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pendingMigrations } from "./migration-plan.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "migrations");
const src = (p) => readFileSync(join(root, p), "utf8");
const HOY = "2026-09-16";

async function fresh() {
  const db = new PGlite();
  for (const { path } of pendingMigrations(readdirSync(dir), [])) await db.exec(readFileSync(join(dir, path), "utf8"));
  await db.exec(`
    insert into companies (id, name, join_code, created_by) values (1, 'Azagro', 'AZ1', 'u1');
    insert into partners (id, company_id, code, name, is_customer, payment_days) values (10, 1, 'CL1', 'Cliente', true, 90);
    insert into invoices (id, company_id, kind, name, partner_id, date, due_date, amount, residual, origin, inv_class, state)
      values (1, 1, 'customer', 'FV-0001', 10, '2026-08-01', '2026-11-29', 1000, 1000, 'PV-0001', 'product', 'open');
  `);
  return db;
}
let pid = 0;
async function abono(db, amount, date, reversesId = null) {
  pid += 1;
  await db.query(`insert into payments (id, company_id, kind, name, partner_id, amount, created_by, date, reverses_id) values ($1, 1, 'inbound', $2, 10, $3, 'u1', $4, $5)`, [pid, `PAG-${String(pid).padStart(4, "0")}`, amount, date, reversesId]);
  await db.query(`insert into payment_allocs (payment_id, invoice_id, amount) values ($1, 1, $2)`, [pid, amount]);
  return pid;
}
/** El update de refreshInvoiceResidual al quedar pagada, tal cual (hoy = HOY en vez de todayMx()). */
async function liquidar(db) {
  await db.query(`
    update invoices i
    set residual = 0, state = 'paid',
      paid_date = coalesce(i.paid_date,
        (select max(p.date) from payment_allocs pa join payments p on p.id = pa.payment_id
          where pa.invoice_id = i.id and p.reverses_id is null
            and not exists (select 1 from payments r where r.reverses_id = p.id)),
        $1::date)
    where i.id = 1`, [HOY]);
  return (await db.query(`select paid_date::text as paid_date, state from invoices where id = 1`)).rows[0];
}
const reabrir = (db) => db.query(`update invoices set residual = 1000, state = 'open', paid_date = null where id = 1`);

test("#18: cobro del 13 capturado el 16 → paid_date 13 (la fecha del dinero, no la de captura)", async () => {
  const db = await fresh();
  await abono(db, 1000, "2026-09-13");
  assert.deepEqual(await liquidar(db), { paid_date: "2026-09-13", state: "paid" });
  await db.close();
});

test("#18: dos abonos (parcial del 10, resto del 13) → la fecha del último; pronto pago el mismo día no la mueve", async () => {
  const db = await fresh();
  await abono(db, 600, "2026-09-10");
  await abono(db, 380, "2026-09-13");
  await abono(db, 20, "2026-09-13"); // la bonificación de pronto pago lleva el payDate del cobro
  assert.deepEqual(await liquidar(db), { paid_date: "2026-09-13", state: "paid" });
  await db.close();
});

test("#18: un pago revertido no cuenta — pago del 13, reversa del 15, re-captura con fecha 13 → paid_date 13, no 15", async () => {
  const db = await fresh();
  const p1 = await abono(db, 1000, "2026-09-13");
  await liquidar(db);
  await abono(db, -1000, "2026-09-15", p1); // contrario, ligado (Decisión 34)
  await reabrir(db);
  await abono(db, 1000, "2026-09-13");
  assert.deepEqual(await liquidar(db), { paid_date: "2026-09-13", state: "paid" }, "ni el pago revertido ni su contrario deciden la fecha");
  await db.close();
});

test("#18: sin abono vivo (respaldo) → hoy; y un paid_date ya puesto no se pisa", async () => {
  const db = await fresh();
  assert.deepEqual(await liquidar(db), { paid_date: HOY, state: "paid" });
  await db.query(`update invoices set paid_date = '2026-09-01' where id = 1`);
  await abono(db, 1000, "2026-09-13");
  assert.deepEqual(await liquidar(db), { paid_date: "2026-09-01", state: "paid" }, "coalesce: lo ya escrito manda (la reapertura lo limpia antes)");
  await db.close();
});

test("cableado: refreshInvoiceResidual deriva paid_date del último abono vivo con todayMx de respaldo; el cobro no cambió; al reabrir se limpia", () => {
  const stock = src("src/lib/erp/stock.ts");
  const body = stock.slice(stock.indexOf("export async function refreshInvoiceResidual"));
  assert.ok(body.includes("paid_date = coalesce(i.paid_date,\n          (select max(p.date) from payment_allocs pa join payments p on p.id = pa.payment_id\n            where pa.invoice_id = i.id and p.reverses_id is null\n              and not exists (select 1 from payments r where r.reverses_id = p.id)),\n          ${todayMx()}::date)"), "la sentencia que esta prueba copia");
  assert.ok(body.includes("state = 'open', paid_date = null where id = ${invoiceId}"), "al reabrir se limpia (la mora vuelve a correr)");
  const ops = src("src/lib/erp/ops.ts");
  assert.ok(ops.includes("let newRes = await refreshInvoiceResidual(sql, inv[0].id);"), "el cobro sigue llamando igual, sin parámetro nuevo");
  assert.ok(ops.includes("update invoices set paid_date = coalesce(paid_date, ${payDate}::date) where id = ${inv[0].id}"), "su update posterior se conserva (redundante, inofensivo)");
});

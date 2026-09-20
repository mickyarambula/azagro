// «COBRADO» Y «PAGADO» DEL PERIODO SON DINERO QUE SE MOVIÓ EN EL BANCO
// (Decisión 98b, 19/20-sep-2026). Las dos consultas de `getCompanyPnl` se
// copian tal cual y se corren contra PGlite con las migraciones reales.
//
// Lo que se corrige: sumaban TODOS los PAG, incluidos los virtuales que no
// tocan la cuenta —el abono de una devolución, la bonificación de pronto pago,
// el saldo a favor que deja una devolución—, así que decían que entró dinero
// que nunca entró. Y ese número se compara contra el estado de cuenta del
// banco. Es retroactivo a propósito: meses cerrados bajan por esos virtuales.
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

async function fresh() {
  const db = new PGlite();
  for (const { path } of pendingMigrations(readdirSync(dir), [])) await db.exec(readFileSync(join(dir, path), "utf8"));
  await db.exec(`
    insert into companies (id, name, join_code, created_by) values (1, 'Azagro', 'AZ1', 'u1');
    insert into partners (id, company_id, code, name, is_customer, payment_days) values (10, 1, 'CL1', 'Cliente', true, 90);
    insert into banks (id, company_id, name) values (5, 1, 'Banorte MXN');
    insert into invoices (id, company_id, kind, name, partner_id, date, due_date, amount, residual, origin, inv_class, state)
      values (1, 1, 'customer', 'FV-0001', 10, '2026-08-01', '2026-11-29', 1000, 1000, 'PV-0001', 'product', 'open');
  `);
  return db;
}
let pid = 0;
async function pag(db, kind, amount, date, conBanco, reversesId = null) {
  pid += 1;
  await db.query(`insert into payments (id, company_id, kind, name, partner_id, amount, created_by, date, reverses_id) values ($1, 1, $2, $3, 10, $4, 'u1', $5, $6)`, [pid, kind, `PAG-${String(pid).padStart(4, "0")}`, amount, date, reversesId]);
  await db.query(`insert into payment_allocs (payment_id, invoice_id, amount) values ($1, 1, $2)`, [pid, amount]);
  if (conBanco) {
    await db.query(`insert into bank_moves (company_id, bank_id, date, amount, memo, partner_id, kind, invoice_id, payment_id, created_by) values (1, 5, $1, $2, 'x', 10, 'cobro', 1, $3, 'u1')`, [date, kind === "inbound" ? amount : -amount, pid]);
  }
  return pid;
}
// Las dos consultas, copiadas de reports.ts (getCompanyPnl) con $1/$2 en vez de from/to.
const COBRADO = `select coalesce(sum(p.amount),0)::text as amount
      from payments p
      where p.company_id = 1 and p.kind = 'inbound' and p.date between $1 and $2
        and exists (select 1 from bank_moves m where m.payment_id = p.id)`;
const PAGADO = COBRADO.replace("'inbound'", "'outbound'");
const num = async (db, q) => Number((await db.query(q, ["2026-09-01", "2026-09-30"])).rows[0].amount);

test("cableado: las consultas de esta prueba son las del reporte", () => {
  const r = src("src/lib/erp/reports.ts");
  assert.ok(r.includes("where p.company_id = ${companyId} and p.kind = 'inbound' and p.date between ${from} and ${to}\n        and exists (select 1 from bank_moves m where m.payment_id = p.id)"), "cobrado");
  assert.ok(r.includes("where p.company_id = ${companyId} and p.kind = 'outbound' and p.date between ${from} and ${to}\n        and exists (select 1 from bank_moves m where m.payment_id = p.id)"), "pagado");
});

test("un cobro real cuenta; un PAG virtual (devolución, pronto pago, saldo a favor) NO", async () => {
  const db = await fresh();
  await pag(db, "inbound", 700, "2026-09-10", true);    // cobro por banco
  await pag(db, "inbound", 300, "2026-09-12", false);   // abono virtual de una devolución
  await pag(db, "inbound", 50, "2026-09-15", false);    // bonificación de pronto pago
  assert.equal(await num(db, COBRADO), 700, "solo lo que entró al banco: antes decía 1,050");
  assert.equal(await num(db, PAGADO), 0);
  await db.close();
});

test("el par (cobro, contra-cobro) sigue neteando: o los dos tienen banco o ninguno", async () => {
  const db = await fresh();
  const a = await pag(db, "inbound", 700, "2026-09-10", true);
  await pag(db, "inbound", -700, "2026-09-11", true, a);  // reversa real: contra-movimiento de banco
  assert.equal(await num(db, COBRADO), 0, "el cobro y su reversa suman cero");
  const b = await pag(db, "inbound", 300, "2026-09-12", false);
  await pag(db, "inbound", -300, "2026-09-13", false, b);  // reversa de un virtual: sin banco los dos
  assert.equal(await num(db, COBRADO), 0, "y el par virtual ni entra ni sale");
  await db.close();
});

test("pagado a proveedores: mismo criterio", async () => {
  const db = await fresh();
  await pag(db, "outbound", 400, "2026-09-05", true);
  await pag(db, "outbound", 100, "2026-09-06", false);   // no toca banco: no es pago
  assert.equal(await num(db, PAGADO), 400);
  await db.close();
});

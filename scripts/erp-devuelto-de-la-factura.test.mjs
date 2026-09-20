// «CUÁNTO SE DEVOLVIÓ DE ESTA FACTURA» — la base del pronto pago (Decisión 96),
// corregida el 20-sep-2026 contra PGlite con las migraciones reales.
//
// EL AGUJERO: la fuente eran las APLICACIONES (`payment_allocs`), y una
// devolución solo abona a la factura lo que cupo — `Math.min(credit, residual)`.
// El resto se va a un saldo a favor SIN aplicar. Sobre una factura YA PAGADA no
// cabe nada, así que una devolución completa reportaba `devuelto = 0` y el
// pronto pago se calculaba sobre el cargo entero de una venta cuya mercancía
// regresó toda: hasta $4,979.26 regalados en la factura de referencia.
//
// La nota de crédito sí lo sabe: nace por el importe completo y guarda a qué
// factura pertenece (`applies_to_id`, migración 0036).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pendingMigrations } from "./migration-plan.mjs";
import { earlyPayBase } from "../src/lib/erp/advance.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "migrations");
const src = (p) => readFileSync(join(root, p), "utf8");

async function fresh() {
  const db = new PGlite();
  for (const { path } of pendingMigrations(readdirSync(dir), [])) await db.exec(readFileSync(join(dir, path), "utf8"));
  await db.exec(`
    insert into companies (id, name, join_code, created_by) values (1, 'Azagro', 'AZ1', 'u1');
    insert into partners (id, company_id, code, name, is_customer, payment_days) values (10, 1, 'CL1', 'Cliente', true, 90);
    insert into invoices (id, company_id, kind, name, partner_id, date, due_date, amount, residual, origin, inv_class, state)
      values (1, 1, 'customer', 'FV-0001', 10, '2026-02-01', '2026-06-01', 111876.11, 0, 'PV-0001', 'product', 'paid');
  `);
  return db;
}
let ncId = 100;
/** Una NC de devolución, como la escribe `returnSale`: importe negativo y ligada a su FV. */
async function nc(db, importe, { aplicaA = 1, estado = "paid", reversesId = null, nombre = null } = {}) {
  ncId += 1;
  await db.query(
    `insert into invoices (id, company_id, kind, name, partner_id, date, due_date, amount, residual, origin, inv_class, state, applies_to_id, reverses_id)
     values ($1, 1, 'customer', $2, 10, '2026-09-01', '2026-09-01', $3, 0, 'PV-0001', 'product', $4, $5, $6)`,
    [ncId, nombre ?? `NC-${String(ncId).padStart(4, "0")}`, -importe, estado, aplicaA, reversesId],
  );
  return ncId;
}
// La consulta, copiada de `returnedOfInvoices` (ops.ts) con $1 en vez del array.
const Q = `
    select nc.applies_to_id, coalesce(sum(-nc.amount), 0)::text as total
    from invoices nc
    where nc.company_id = 1 and nc.applies_to_id = any($1)
      and nc.kind = 'customer' and nc.name like 'NC-%'
      and nc.reverses_id is null and nc.state <> 'reversed'
    group by nc.applies_to_id`;
const devuelto = async (db, ids = [1]) => {
  const r = await db.query(Q, [ids]);
  const m = new Map(r.rows.map((x) => [x.applies_to_id, Number(x.total)]));
  return m.get(1) ?? 0;
};

test("cableado: la consulta de esta prueba es la del producto", () => {
  const ops = src("src/lib/erp/ops.ts");
  assert.ok(ops.includes("select nc.applies_to_id, coalesce(sum(-nc.amount), 0)::text as total"), "el select");
  assert.ok(ops.includes("and nc.reverses_id is null and nc.state <> 'reversed'"), "solo NC vivas");
  assert.ok(!ops.includes("from payment_allocs pa join payments p on p.id = pa.payment_id\n    join invoices i on i.id = pa.invoice_id"), "ya no sale de las aplicaciones");
});

test("EL AGUJERO: devolución completa sobre una factura YA PAGADA — antes $0, ahora el importe entero", async () => {
  const db = await fresh();                       // FV-0001 de $111,876.11, pagada
  await nc(db, 106876.11);                        // devuelve casi todo; no cupo nada como abono
  assert.equal(await devuelto(db), 106876.11, "la NC sí lo sabe");
  // Y de ahí sale la base del pronto pago (Decisión 96).
  assert.equal(earlyPayBase(111876.11, 106876.11), 5000, "base correcta");
  assert.equal(earlyPayBase(111876.11, 0), 111876.11, "lo que decía antes");
  // Sobre 145 días sin usar al 11.05 %: el bono cae de $4,979.26 a $222.53.
  const bono = (base) => Math.round(((base * 0.1105 * 145) / 360) * 100) / 100;
  assert.equal(bono(5000), 222.53);
  assert.equal(bono(111876.11), 4979.26);
  assert.equal(Math.round((4979.26 - 222.53) * 100) / 100, 4756.73, "lo que se regalaba");
  await db.close();
});

test("varias devoluciones de la misma factura se suman", async () => {
  const db = await fresh();
  await nc(db, 1000);
  await nc(db, 500.55);
  assert.equal(await devuelto(db), 1500.55);
  await db.close();
});

test("una NC revertida o contraria no cuenta", async () => {
  const db = await fresh();
  await nc(db, 1000);
  await nc(db, 400, { estado: "reversed" });                 // devolución revertida (paso 8)
  await nc(db, 300, { reversesId: 1 });                      // contraria de otra
  assert.equal(await devuelto(db), 1000, "solo la viva");
  await db.close();
});

test("la NC espejo de una reversa de entrega no se cuela: no lleva applies_to_id", async () => {
  const db = await fresh();
  await db.query(
    `insert into invoices (id, company_id, kind, name, partner_id, date, due_date, amount, residual, origin, inv_class, state, reverses_id)
     values (900, 1, 'customer', 'NC-0900', 10, '2026-09-01', '2026-09-01', -111876.11, 0, 'FV-0001', 'product', 'paid', 1)`,
  );
  assert.equal(await devuelto(db), 0, "esa se amarra por reverses_id, no por applies_to_id");
  await db.close();
});

test("sin devoluciones, la base del bono es el cargo entero — byte a byte", async () => {
  const db = await fresh();
  assert.equal(await devuelto(db), 0);
  assert.equal(earlyPayBase(111876.11, 0), 111876.11);
  await db.close();
});

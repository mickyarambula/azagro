// DEVOLUCIÓN POR PARTIDA — grupo D de la auditoría (AUDITORIA.md § 3,
// hallazgos #5, #22, #23), 17-sep-2026.
//
// Antes: la pantalla indexaba la casilla por product_id (dos partidas del
// mismo producto compartían casilla y el envío iba duplicado), returnSale
// hacía `lines.find(l => l.product_id === take.productId)` (la primera que
// apareciera: precio y qty_returned de la partida equivocada) y reverseReturn
// restaba qty_returned a TODAS las partidas del producto.
//
// Ahora: la partida es sales_lines.id. returnSale recibe lineId, la NC guarda
// invoice_lines.line_id (migración 0042) y la reversa regresa qty_returned a
// ESA partida; una NC anterior (line_id null) se revierte por producto, como
// se escribió. Aquí: la sentencia de cada camino copiada tal cual sobre PGlite
// con las migraciones reales, y el cableado.
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

function fnBody(source, name) {
  const markers = [`export const ${name} `, `export async function ${name}(`, `export function ${name}(`, `async function ${name}(`, `function ${name}(`];
  const start = markers.map((m) => source.indexOf(m)).find((i) => i !== -1);
  assert.notEqual(start, undefined, `No existe ${name}`);
  const rest = source.slice(start);
  const next = rest.slice(10).search(/\n(export )?(async )?function |\nexport const /);
  return next === -1 ? rest : rest.slice(0, next + 10);
}

async function fresh() {
  const db = new PGlite();
  for (const { path } of pendingMigrations(readdirSync(dir), [])) await db.exec(readFileSync(join(dir, path), "utf8"));
  await db.exec(`
    insert into companies (id, name, join_code, created_by) values (1, 'Azagro', 'AZ1', 'u1');
    insert into partners (id, company_id, code, name, is_customer, payment_days) values (10, 1, 'CL1', 'Cliente', true, 90);
    insert into locations (id, company_id, code, name, loc_type) values (1, 1, 'BOD', 'Bodega', 'internal');
    insert into products (id, company_id, code, name, uom, cost, list_price) values (7, 1, 'P7', 'Producto', 'L', 50, 100);
    insert into sales_orders (id, company_id, name, partner_id, location_id, date, term_kind, credit_days, state, policy_code)
      values (1, 1, 'PV-0001', 10, 1, '2026-09-10', 'contado', 0, 'done', 'NONE');
    -- El mismo producto en dos partidas, precios distintos, ambas entregadas.
    insert into sales_lines (id, so_id, product_id, qty, unit_price, qty_delivered, qty_returned) values
      (101, 1, 7, 10, 100, 10, 0),
      (102, 1, 7, 10, 200, 10, 0);
    insert into invoices (id, company_id, kind, name, partner_id, date, due_date, amount, residual, origin, inv_class, order_id, state)
      values (1, 1, 'customer', 'FV-0001', 10, '2026-09-10', '2026-09-10', 3000, 3000, 'PV-0001', 'product', 1, 'open');
  `);
  return db;
}
const lineas = async (db) => (await db.query(`select id, qty_returned::text as qty_returned from sales_lines where so_id = 1 order by id`)).rows;

/** El `for` de returnSale, tal cual: candado por partida, qty_returned a esa partida, renglón de NC con su precio y su line_id. */
async function devolver(db, takes, ncId) {
  const lines = (await db.query(`select id, product_id, qty::text, coalesce(qty_delivered,0)::text as qty_delivered, coalesce(qty_returned,0)::text as qty_returned, unit_price::text from sales_lines where so_id = 1`)).rows;
  const vistas = new Set();
  for (const take of takes) {
    if (vistas.has(take.lineId)) throw new Error("La misma partida viene dos veces en la devolución: captúrala una sola vez.");
    vistas.add(take.lineId);
  }
  let credit = 0;
  for (const take of takes) {
    const src = lines.find((l) => l.id === take.lineId);
    if (!src) throw new Error("Esa partida no está en el pedido");
    const max = Number(src.qty_delivered) - Number(src.qty_returned);
    if (take.qty > max + 0.0001) throw new Error(`No puedes devolver más de lo entregado (${max}).`);
    await db.query(`update sales_lines set qty_returned = qty_returned + $1 where id = $2`, [take.qty, src.id]);
    credit += take.qty * Number(src.unit_price);
  }
  await db.query(`insert into invoices (id, company_id, kind, name, partner_id, date, due_date, amount, residual, origin, inv_class, order_id, applies_to_id, state) values ($1, 1, 'customer', $2, 10, '2026-09-17', '2026-09-17', $3, $3, 'PV-0001', 'product', 1, 1, 'open')`, [ncId, `NC-${String(ncId).padStart(4, "0")}`, -credit]);
  for (const take of takes) {
    const src = lines.find((l) => l.id === take.lineId);
    const amt = take.qty * Number(src.unit_price);
    await db.query(`insert into invoice_lines (invoice_id, product_id, line_id, qty, unit_price, amount) values ($1, $2, $3, $4, $5, $6)`, [ncId, src.product_id, src.id, take.qty, Number(src.unit_price), -amt]);
  }
  return credit;
}

/** El paso 4 de reverseReturn, tal cual: por line_id si la NC lo trae; por producto si es anterior a la 0042. */
async function revertir(db, ncId) {
  const lines = (await db.query(`select il.product_id, il.line_id, il.qty::text from invoice_lines il where il.invoice_id = $1 order by il.id`, [ncId])).rows;
  for (const l of lines) {
    if (l.line_id != null) await db.query(`update sales_lines set qty_returned = greatest(0, qty_returned - $1) where id = $2 and so_id = 1`, [Number(l.qty), l.line_id]);
    else await db.query(`update sales_lines set qty_returned = greatest(0, qty_returned - $1) where so_id = 1 and product_id = $2`, [Number(l.qty), l.product_id]);
  }
}

test("#22: devolver 3 de la partida B ($200) acredita 600 y sube qty_returned solo en B; A ($100) intacta", async () => {
  const db = await fresh();
  const credit = await devolver(db, [{ lineId: 102, qty: 3 }], 50);
  assert.equal(credit, 600, "el precio es el de la partida devuelta, no el de la primera que aparece");
  assert.deepEqual(await lineas(db), [{ id: 101, qty_returned: "0.000" }, { id: 102, qty_returned: "3.000" }]);
  const nc = (await db.query(`select product_id, line_id, qty::text, amount::text from invoice_lines where invoice_id = 50`)).rows;
  assert.deepEqual(nc, [{ product_id: 7, line_id: 102, qty: "3.000", amount: "-600.00" }], "la NC sabe de qué partida salió");
  await db.close();
});

test("#5: dos partidas del mismo producto en el mismo envío son dos renglones distintos, cada uno con su precio; la misma partida dos veces se rechaza antes de mover nada", async () => {
  const db = await fresh();
  const credit = await devolver(db, [{ lineId: 101, qty: 2 }, { lineId: 102, qty: 3 }], 51);
  assert.equal(credit, 2 * 100 + 3 * 200);
  assert.deepEqual(await lineas(db), [{ id: 101, qty_returned: "2.000" }, { id: 102, qty_returned: "3.000" }]);
  await assert.rejects(() => devolver(db, [{ lineId: 101, qty: 1 }, { lineId: 101, qty: 1 }], 52), /La misma partida viene dos veces/);
  assert.deepEqual(await lineas(db), [{ id: 101, qty_returned: "2.000" }, { id: 102, qty_returned: "3.000" }], "el rechazo no movió nada");
  await assert.rejects(() => devolver(db, [{ lineId: 102, qty: 8 }], 53), /No puedes devolver más de lo entregado \(7\)/, "el candado es por partida: B tiene 7 disponibles aunque el producto tenga 15");
  await db.close();
});

test("#23: revertir la NC de la partida B regresa qty_returned solo a B; una NC anterior (line_id null) sigue por producto, como se escribió", async () => {
  const db = await fresh();
  await devolver(db, [{ lineId: 101, qty: 2 }], 60);
  await devolver(db, [{ lineId: 102, qty: 3 }], 61);
  await revertir(db, 61);
  assert.deepEqual(await lineas(db), [{ id: 101, qty_returned: "2.000" }, { id: 102, qty_returned: "0.000" }], "A conserva sus 2 devueltas");
  // NC de antes de la 0042: sin liga a partida.
  await db.query(`insert into invoices (id, company_id, kind, name, partner_id, date, due_date, amount, residual, origin, inv_class, order_id, state) values (62, 1, 'customer', 'NC-0062', 10, '2026-09-01', '2026-09-01', -100, 0, 'PV-0001', 'product', 1, 'open')`);
  await db.query(`insert into invoice_lines (invoice_id, product_id, qty, unit_price, amount) values (62, 7, 1, 100, -100)`);
  await db.query(`update sales_lines set qty_returned = 1 where id = 102`);
  await revertir(db, 62);
  assert.deepEqual(await lineas(db), [{ id: 101, qty_returned: "1.000" }, { id: 102, qty_returned: "0.000" }], "legado: resta a todas las del producto (greatest 0), igual que hasta hoy");
  await db.close();
});

test("kardex: una NC que devuelve dos partidas del mismo producto amarra cada renglón a SU movimiento return, sin repetir (liga 1:1 para la reversa)", async () => {
  const db = await fresh();
  await devolver(db, [{ lineId: 101, qty: 2 }, { lineId: 102, qty: 3 }], 70);
  // Los dos `return` que returnSale escribe: mismo origin (la NC), mismo producto, en ese orden.
  await db.exec(`
    insert into stock_moves (id, company_id, ref, move_type, date, origin, location_to, product_id, quantity, unit_cost, created_by) values
      (901, 1, 'DEV/0001', 'return', '2026-09-17', 'NC-0070', 1, 7, 2, 50, 'u1'),
      (902, 1, 'DEV/0002', 'return', '2026-09-17', 'NC-0070', 1, 7, 3, 50, 'u1');
  `);
  // El amarre de chainForReturn, tal cual: por NC + producto + cantidad, sin repetir movimiento, en orden.
  const lines = (await db.query(`select il.product_id, il.line_id, il.qty::text from invoice_lines il where il.invoice_id = 70 order by il.id`)).rows;
  const usados = [];
  for (const l of lines) {
    const mv = (await db.query(
      `select m.id from stock_moves m
       where m.company_id = 1 and m.move_type = 'return' and m.origin = 'NC-0070' and m.product_id = $1
         and m.quantity = $2 and not (m.id = any($3)) and not exists (select 1 from stock_moves r where r.reverses_id = m.id)
       order by m.id asc limit 1`, [l.product_id, Number(l.qty), usados])).rows;
    assert.ok(mv[0], `renglón de la partida ${l.line_id} sin movimiento`);
    usados.push(mv[0].id);
  }
  assert.deepEqual(usados, [901, 902], "renglón A → DEV/0001, renglón B → DEV/0002; nunca los dos al mismo");
  const chain = fnBody(src("src/lib/erp/return-reversal.ts"), "chainForReturn");
  assert.ok(chain.includes("and m.quantity = ${qty}\n          and not (m.id = any(${usados}))") && chain.includes("usados.push(m.id);"), "cableado: sin repetir");
  await db.close();
});

test("0042: columna nullable con referencia a sales_lines; idempotente", async () => {
  const db = await fresh();
  const m42 = readFileSync(join(dir, readdirSync(dir).find((f) => f.startsWith("0042"))), "utf8");
  await db.exec(m42);
  const col = (await db.query(`select is_nullable, data_type from information_schema.columns where table_name = 'invoice_lines' and column_name = 'line_id'`)).rows;
  assert.deepEqual(col, [{ is_nullable: "YES", data_type: "integer" }]);
  await assert.rejects(() => db.query(`insert into invoice_lines (invoice_id, product_id, line_id, qty, unit_price, amount) values (1, 7, 999, 1, 1, -1)`), /foreign key|violates/i, "una partida que no existe no se liga");
  await db.close();
});

test("cableado: returnSale recibe lineId, busca por id, rechaza duplicados y escribe line_id en la NC; ni un take.productId", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "returnSale");
  assert.ok(body.includes("lines: z.array(z.object({ lineId: z.number(), qty: z.number().positive() })).min(1),"), "el validador pide la partida");
  assert.equal((body.match(/lines\.find\(\(l\) => l\.id === take\.lineId\)/g) || []).length, 2, "las dos búsquedas son por id (kardex/qty_returned y renglón de NC)");
  assert.ok(!body.includes("take.productId") && !body.includes("l.product_id === take"), "product_id ya no identifica un renglón");
  assert.ok(body.includes("La misma partida viene dos veces en la devolución"), "duplicado en el envío: rechazo antes de mover nada");
  assert.ok(body.includes("insert into invoice_lines (invoice_id, product_id, line_id, qty, unit_price, amount)") && body.includes("${nc[0]!.id}, ${src.product_id}, ${src.id}, ${take.qty}"), "la NC guarda la partida");
  assert.ok(body.includes('productId: src.product_id,\n          quantity: take.qty,'), "el kardex sigue por producto (no lleva partidas), tomado de la partida elegida");
});

test("cableado: reverseReturn regresa qty_returned por line_id cuando la NC lo trae, por producto cuando es anterior; chainForReturn lo lee", () => {
  const c = src("src/lib/erp/return-reversal.ts");
  assert.ok(fnBody(c, "chainForReturn").includes("select il.product_id, il.line_id, il.qty::text, p.code"), "la NC trae line_id");
  assert.ok(c.includes("lines: Array<{ product_id: number; line_id: number | null; qty: number }>;"));
  const run = fnBody(c, "reverseReturn");
  assert.ok(run.includes("if (l.line_id != null) {") && run.includes("where id = ${l.line_id} and so_id = ${pv.so.id}`;"), "por partida");
  assert.ok(run.includes("} else {") && run.includes("where so_id = ${pv.so.id} and product_id = ${l.product_id}`;"), "legado por producto, como se escribió");
});

test("cableado: la pantalla indexa la casilla por l.id, manda lineId, y agrega por producto antes de pedir la factura (Decisión 52)", () => {
  const so = src("src/routes/sales.$orderId.tsx");
  assert.ok(!so.includes("retQty[l.product_id]"), "ninguna casilla por producto");
  assert.ok(so.includes("value={retQty[l.id] ?? 0}") && so.includes("[l.id]: Math.min(max, Math.max(0, n))"), "casilla por partida");
  assert.ok(so.includes('<tr key={l.id} className="border-t border-line">'), "un renglón por partida");
  assert.ok(so.includes(".map((l) => ({ lineId: l.id, qty: retQty[l.id] ?? 0 }))"), "el envío va por partida");
  assert.ok(so.includes("porProducto.set(l.product_id, (porProducto.get(l.product_id) ?? 0) + q)") && so.includes("const lines = [...porProducto].map(([productId, qty]) => ({ productId, qty }));"), "la propuesta de factura suma las partidas del mismo producto");
  assert.ok(so.includes("returnProposal({ data: { soId: id, lines } })"), "y sigue pidiéndola igual");
  assert.ok(so.includes("{moneyIn(num(l.unit_price), form.currency)}"), "cada renglón enseña su precio: así se distinguen dos partidas del mismo producto");
});

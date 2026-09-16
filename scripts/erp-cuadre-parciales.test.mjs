// BLOQUE DE PARCIALES, paso 0(a) (PARCIALES.md § 5, patrón A6 de
// PATRONES-DISENO.md): el cuadre. Si el sistema recibe/entrega cien
// unidades, tiene que poder decir dónde quedaron las cien.
//
// Función pura, sin acceso a base — las cantidades ya vienen sumadas por SQL
// (Σ movimientos vivos, Σ renglones de FV vivas); esto solo verifica la
// identidad. Hoy `cerrada_corta` no existe (nace en el paso 7): siempre 0,
// y con todo `= qty` o `= 0` (todo-o-nada de hoy) el gap tiene que dar cero
// sin ningún caso especial.
import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcilePurchaseLine, reconcileSalesLine } from "../src/lib/erp/parciales.ts";

test("reconcilePurchaseLine: hoy (todo-o-nada) siempre da gap 0 — nada recibido", () => {
  const r = reconcilePurchaseLine({ qty: 50, qtyReceived: 0 });
  assert.equal(r.pendiente, 50);
  assert.equal(r.recibida, 0);
  assert.equal(r.cerradaCorta, 0);
  assert.equal(r.gap, 0);
});

test("reconcilePurchaseLine: hoy (todo-o-nada) siempre da gap 0 — todo recibido", () => {
  const r = reconcilePurchaseLine({ qty: 50, qtyReceived: 50 });
  assert.equal(r.pendiente, 0);
  assert.equal(r.recibida, 50);
  assert.equal(r.gap, 0);
});

test("reconcilePurchaseLine: recepción parcial (paso 1) también da gap 0 — 20 de 50", () => {
  const r = reconcilePurchaseLine({ qty: 50, qtyReceived: 20 });
  assert.equal(r.recibida, 20);
  assert.equal(r.pendiente, 30);
  assert.equal(r.gap, 0);
});

test("reconcilePurchaseLine: con cierre corto (paso 7), qty = recibida + pendiente + cerrada_corta", () => {
  const r = reconcilePurchaseLine({ qty: 50, qtyReceived: 20, cerradaCorta: 30 });
  assert.equal(r.pendiente, 0, "lo cerrado ya no cuenta como pendiente");
  assert.equal(r.gap, 0);
});

test("reconcileSalesLine: hoy (todo-o-nada), nada entregado", () => {
  const r = reconcileSalesLine({ qty: 10, qtyDelivered: 0, qtyReturned: 0, invoicedQty: 0 });
  assert.equal(r.entregadaViva, 0);
  assert.equal(r.pendiente, 10);
  assert.equal(r.facturadaViva, 0);
  assert.equal(r.gap, 0);
  assert.equal(r.facturaGap, 0, "hoy facturada = entregada siempre");
});

test("reconcileSalesLine: hoy (todo-o-nada), todo entregado y facturado", () => {
  const r = reconcileSalesLine({ qty: 10, qtyDelivered: 10, qtyReturned: 0, invoicedQty: 10 });
  assert.equal(r.pendiente, 0);
  assert.equal(r.gap, 0);
  assert.equal(r.facturaGap, 0);
});

test("reconcileSalesLine: entrega parcial (paso 3) con devolución, sigue dando gap 0", () => {
  const r = reconcileSalesLine({ qty: 10, qtyDelivered: 6, qtyReturned: 2, invoicedQty: 6 });
  assert.equal(r.entregadaViva, 6);
  assert.equal(r.pendiente, 4);
  assert.equal(r.devuelta, 2);
  assert.equal(r.gap, 0);
  assert.equal(r.facturaGap, 0, "facturada (6) = entregada (6): cuadra aunque haya devolución");
});

test("reconcileSalesLine: facturaGap distinto de 0 delata una FV que no cubre lo entregado", () => {
  const r = reconcileSalesLine({ qty: 10, qtyDelivered: 10, qtyReturned: 0, invoicedQty: 7 });
  assert.equal(r.facturaGap, 3, "entregado 10, facturado 7: 3 de más entregado sin facturar");
});

// ---------------------------------------------------------------------------
// Contra una base real (PGlite): el panel de § 5, sembrado con datos de hoy
// (todo-o-nada) — debe dar 0 gaps en las dos tablas.
// ---------------------------------------------------------------------------
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pendingMigrations } from "./migration-plan.mjs";
import { purchaseLineGaps, salesLineGaps } from "../src/lib/erp/parciales.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "migrations");

async function fresh() {
  const db = new PGlite();
  for (const { path } of pendingMigrations(readdirSync(dir), [])) {
    await db.exec(readFileSync(join(dir, path), "utf8"));
  }
  return db;
}
const q = (db) => (strings, ...values) => {
  let text = strings[0];
  for (let i = 0; i < values.length; i += 1) text += `$${i + 1}${strings[i + 1]}`;
  return db.query(text, values).then((r) => r.rows);
};

test("purchaseLineGaps / salesLineGaps: sembrado de hoy (todo-o-nada) da 0 renglones con gap", async () => {
  const db = await fresh();
  const r = q(db);
  await r`insert into companies (id, name, join_code, created_by) values (1, 'Empresa', 'J1', 'u')`;
  await r`insert into partners (id, company_id, code, name, payment_days) values (10, 1, 'CL1', 'Cliente', 30), (11, 1, 'PV1', 'Proveedor', 30)`;
  await r`insert into products (id, company_id, code, name, cost) values (20, 1, 'P1', 'Producto', 10)`;
  await r`insert into locations (id, company_id, code, name, loc_type) values (30, 1, 'BOD', 'Bodega', 'internal')`;

  // OC recibida completa (hoy: qty_received = qty).
  await r`insert into purchase_orders (id, company_id, name, partner_id, location_id, state) values (40, 1, 'OC-0001', 11, 30, 'done')`;
  await r`insert into purchase_lines (po_id, product_id, qty, qty_received, unit_price) values (40, 20, 15, 15, 9)`;

  // Pedido confirmado, nada entregado todavía (pendiente completo).
  await r`insert into sales_orders (id, company_id, name, partner_id, location_id, state) values (50, 1, 'PV-0001', 10, 30, 'confirmed')`;
  await r`insert into sales_lines (so_id, product_id, qty, qty_delivered, unit_price) values (50, 20, 8, 0, 20)`;

  // Pedido entregado y facturado completo (hoy: qty_delivered = qty, FV por qty).
  await r`insert into sales_orders (id, company_id, name, partner_id, location_id, state) values (51, 1, 'PV-0002', 10, 30, 'done')`;
  await r`insert into sales_lines (so_id, product_id, qty, qty_delivered, unit_price) values (51, 20, 5, 5, 20)`;
  await r`insert into invoices (id, company_id, kind, name, partner_id, due_date, amount, residual, order_id) values (60, 1, 'customer', 'FV-0001', 10, current_date, 100, 100, 51)`;
  await r`insert into invoice_lines (invoice_id, product_id, qty, unit_price) values (60, 20, 5, 20)`;

  const pg = await purchaseLineGaps(r, 1);
  const sg = await salesLineGaps(r, 1);
  assert.deepEqual(pg, [], "ninguna partida de compra con gap");
  assert.deepEqual(sg, [], "ninguna partida de venta con gap");
  await db.close();
});

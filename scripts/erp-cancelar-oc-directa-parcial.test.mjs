// CANCELAR UNA OC DIRECTA CON ENTREGAS PARCIALES — grupo E de la auditoría
// (AUDITORIA.md § 3, hallazgo #6), 17-sep-2026.
//
// Antes: el único candado directo era `so_state === "done"`. Con entregas por
// partes el pedido sigue `confirmed` aunque ya facturó al cliente y ya nació
// FP real por evento; la búsqueda de FP a revertir no distinguía la del
// defecto viejo (sin event_ref) de la real (con event_ref) y la ofrecía como
// reversible con una nota falsa. Ahora: en directo "movió mercancía" = FP
// viva con event_ref en esa OC, o FV viva por evento del pedido con productos
// de esa OC; solo la FP sin event_ref es reversible desde aquí. Las consultas
// copiadas tal cual sobre PGlite con las migraciones reales, y el cableado.
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
  // Columnas que en la app agrega el ensure (azagro.ts:118, :1162-1163), no una migración.
  await db.exec(`
    alter table sales_orders add column if not exists route_kind text not null default 'own';
    alter table purchase_orders add column if not exists fulfill_kind text not null default 'inventory';
    alter table purchase_orders add column if not exists so_id integer;
  `);
  await db.exec(`
    insert into companies (id, name, join_code, created_by) values (1, 'Azagro', 'AZ1', 'u1');
    insert into partners (id, company_id, code, name, is_customer, is_supplier, payment_days) values
      (10, 1, 'CL1', 'Cliente', true, false, 90), (20, 1, 'PR1', 'Proveedor', false, true, 30);
    insert into locations (id, company_id, code, name, loc_type) values (1, 1, 'BOD', 'Bodega', 'internal');
    insert into products (id, company_id, code, name, uom, cost, list_price) values (7, 1, 'P7', 'Producto', 'L', 50, 100), (8, 1, 'P8', 'Otro', 'L', 5, 10);
    -- Pedido de 20 en brokeraje, entregados 10 (ENV/0001): sigue confirmado.
    insert into sales_orders (id, company_id, name, partner_id, location_id, date, term_kind, credit_days, state, policy_code, route_kind)
      values (1, 1, 'PV-0001', 10, 1, '2026-09-10', 'contado', 0, 'confirmed', 'NONE', 'supplier');
    insert into sales_lines (id, so_id, product_id, qty, unit_price, qty_delivered) values (101, 1, 7, 20, 100, 10);
    insert into purchase_orders (id, company_id, name, partner_id, location_id, date, state, total, fulfill_kind, so_id)
      values (1, 1, 'OC-0001', 20, 1, '2026-09-10', 'confirmed', 1000, 'direct', 1);
    insert into purchase_lines (po_id, product_id, qty, unit_price) values (1, 7, 20, 50);
  `);
  return db;
}
/** Exactamente la consulta del candado nuevo de chainForPurchase (cancel.ts). */
async function eventos(db, po) {
  return (await db.query(
    `select x.event_ref, string_agg(x.name, ', ' order by x.name) as docs
     from (
       select i.event_ref, i.name from invoices i
       where i.company_id = 1 and i.kind = 'supplier' and i.origin = $1 and i.event_ref is not null and i.state <> 'reversed'
       union
       select i.event_ref, i.name from invoices i
       where i.company_id = 1 and i.kind = 'customer' and i.order_id = $2 and i.event_ref is not null and i.state <> 'reversed' and i.reverses_id is null
         and exists (select 1 from invoice_lines il join purchase_lines pl on pl.product_id = il.product_id and pl.po_id = $3 where il.invoice_id = i.id)
     ) x group by x.event_ref order by x.event_ref`, [po.name, po.so_id, po.id])).rows;
}
/** Exactamente la búsqueda de FP reversibles (solo sin event_ref). */
async function fpsReversibles(db, poName) {
  return (await db.query(
    `select i.name from invoices i where i.company_id = 1 and i.kind = 'supplier' and i.origin = $1 and i.state <> 'reversed' and i.event_ref is null order by i.id`, [poName])).rows.map((r) => r.name);
}
const po = { id: 1, name: "OC-0001", so_id: 1 };
async function entregaParcial(db) {
  await db.exec(`
    insert into invoices (id, company_id, kind, name, partner_id, date, due_date, amount, residual, origin, inv_class, order_id, state, event_ref)
      values (1, 1, 'customer', 'FV-0001', 10, '2026-09-15', '2026-09-15', 1000, 1000, 'PV-0001', 'product', 1, 'open', 'ENV/0001');
    insert into invoice_lines (invoice_id, product_id, qty, unit_price, amount) values (1, 7, 10, 100, 1000);
    insert into invoices (id, company_id, kind, name, partner_id, date, due_date, amount, residual, origin, inv_class, state, event_ref)
      values (2, 1, 'supplier', 'FP-0001', 20, '2026-09-15', '2026-10-15', 500, 500, 'OC-0001', 'product', 'open', 'ENV/0001');
  `);
}

test("#6: OC directa con entrega parcial (pedido sigue confirmado): la cadena la detiene nombrando el evento y sus documentos; la FP real NO es reversible", async () => {
  const db = await fresh();
  assert.deepEqual(await eventos(db, po), [], "sin entregas, nada la detiene");
  await entregaParcial(db);
  assert.deepEqual(await eventos(db, po), [{ event_ref: "ENV/0001", docs: "FP-0001, FV-0001" }]);
  assert.deepEqual(await fpsReversibles(db, "OC-0001"), [], "la FP con evento es deuda real: no se ofrece");
  await db.close();
});

test("la FP del defecto viejo (sin event_ref) sí es reversible; con la entrega revertida (FV y FP `reversed`) la OC vuelve a poder cancelarse", async () => {
  const db = await fresh();
  await db.exec(`insert into invoices (id, company_id, kind, name, partner_id, date, due_date, amount, residual, origin, inv_class, state)
    values (3, 1, 'supplier', 'FP-0000', 20, '2026-09-10', '2026-10-10', 1000, 1000, 'OC-0001', 'product', 'open')`);
  assert.deepEqual(await fpsReversibles(db, "OC-0001"), ["FP-0000"], "nació con la OC, sin evento: reversible");
  await entregaParcial(db);
  assert.equal((await eventos(db, po)).length, 1);
  await db.exec(`update invoices set state = 'reversed' where id in (1, 2)`);
  assert.deepEqual(await eventos(db, po), [], "entrega revertida: como si nunca hubiera salido");
  assert.deepEqual(await fpsReversibles(db, "OC-0001"), ["FP-0000"]);
  await db.close();
});

test("solo cuenta la FV con productos de ESTA OC: otra OC directa del mismo pedido no se bloquea por una entrega ajena", async () => {
  const db = await fresh();
  await db.exec(`
    insert into purchase_orders (id, company_id, name, partner_id, location_id, date, state, total, fulfill_kind, so_id) values (2, 1, 'OC-0002', 20, 1, '2026-09-10', 'confirmed', 100, 'direct', 1);
    insert into purchase_lines (po_id, product_id, qty, unit_price) values (2, 8, 10, 5);
  `);
  await entregaParcial(db);
  assert.equal((await eventos(db, po)).length, 1, "OC-0001 sí: su producto viajó en FV-0001");
  assert.deepEqual(await eventos(db, { id: 2, name: "OC-0002", so_id: 1 }), [], "OC-0002 no: su producto no salió y no tiene FP");
  await db.close();
});

test("cableado: chainForPurchase conserva el candado viejo, agrega el de eventos vivos con salida nombrada, y solo revierte FP sin event_ref; chainForSale lo hereda", () => {
  const c = src("src/lib/erp/cancel.ts");
  const body = fnBody(c, "chainForPurchase");
  assert.ok(body.includes('o.fulfill_kind === "direct" && o.so_state === "done"'), "el candado de siempre se queda");
  assert.ok(body.includes('if (o.fulfill_kind === "direct") {') && body.includes("string_agg(x.name, ', ' order by x.name) as docs"), "eventos vivos: FP por evento en la OC ∪ FV por evento con productos de la OC");
  assert.ok(body.includes("and i.event_ref is not null and i.state <> 'reversed'\n        union"), "FP viva con evento");
  assert.ok(body.includes("join purchase_lines pl on pl.product_id = il.product_id and pl.po_id = ${o.id}"), "FV con productos de ESTA OC");
  assert.ok(body.includes("Eso no se cancela, se revierte: «Revertir ${eventos[0]!.event_ref}» en el pedido ${o.so_name ?? \"\"}, una entrega a la vez."), "candado con salida: la reversa por evento (paso 4 de parciales)");
  assert.ok(body.includes("and i.state <> 'reversed'\n      and i.event_ref is null\n    order by i.id"), "solo la FP del defecto viejo es reversible");
  assert.ok(fnBody(c, "chainForSale").includes("const sub = await chainForPurchase(sql, companyId, po.id);"), "el pedido hereda el bloqueo de sus OC");
});

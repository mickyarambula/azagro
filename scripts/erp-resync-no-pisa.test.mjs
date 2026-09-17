// CATÁLOGO COMPAQ — el resync no pisa lo capturado a mano (16-sep-2026).
//
// Hasta hoy, `syncCompaqCatalogs` (compaq.ts) hacía `on conflict … do update
// set payment_days = excluded.payment_days, credit_limit = excluded.credit_limit`:
// cada "Cargar / actualizar catálogos" regresaba el límite de crédito y el
// plazo de pago de TODOS los socios al valor escrito en el código. Y como el
// catálogo trae plazo 0 y bornSupplierDebt lee 0 = contado, un proveedor con
// 30 días capturados en su ficha volvía a deber el mismo día — sin aviso.
//
// Regla (misma que la migración 0022 para las políticas): lo capturado a mano
// MANDA. El catálogo siembra límite y plazo solo al CREAR el socio; después
// viven en la ficha. `is_customer` / `is_supplier` también se marcan a mano
// (links.ts): el catálogo puede sumar una bandera, nunca quitarla.
//
// La SQL de abajo se EXTRAE del archivo real (no es una copia): si alguien
// cambia el upsert, esta prueba corre el upsert nuevo.
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

/** El upsert de socios tal cual está en compaq.ts, con los ${…} vueltos $1..$n en orden. */
function upsertSql() {
  const s = src("src/lib/erp/compaq.ts");
  const start = s.indexOf("insert into partners (");
  const end = s.indexOf("`;", start);
  assert.ok(start > 0 && end > start, "no encontré el upsert de socios en compaq.ts");
  let i = 0;
  const text = s.slice(start, end).replace(/\$\{[^}]+\}/g, () => `$${++i}`);
  assert.equal(i, 13, "el upsert lleva 13 parámetros (company, code, name, legal, rfc, cli, prov, grupo, ciudad, plazo, mora, tipo, límite)");
  return text;
}

test("wiring: el on conflict ya no toca credit_limit ni payment_days, y las banderas solo se suman", () => {
  const s = src("src/lib/erp/compaq.ts");
  // Hay seis upserts con la misma cláusula (uom, bodegas, productos…): se ancla al de socios.
  const from = s.indexOf("on conflict (company_id, code) do update set", s.indexOf("insert into partners ("));
  const clause = s.slice(from, s.indexOf("`;", from));
  assert.ok(!clause.includes("credit_limit"), "credit_limit no se pisa en el resync");
  assert.ok(!clause.includes("payment_days"), "payment_days no se pisa en el resync");
  assert.ok(clause.includes("is_customer = partners.is_customer or excluded.is_customer"), "cliente: se suma, no se quita");
  assert.ok(clause.includes("is_supplier = partners.is_supplier or excluded.is_supplier"), "proveedor: se suma, no se quita");
});

async function freshDb() {
  const db = new PGlite();
  for (const { name, path } of pendingMigrations(readdirSync(dir), [])) {
    try {
      await db.exec(readFileSync(join(dir, path), "utf8"));
    } catch (e) {
      assert.fail(`${name}: ${e?.message ?? e}`);
    }
  }
  await db.exec(`insert into companies (id, name, join_code, created_by) values (1, 'Azagro', 'AZ1', 'u1')`);
  return db;
}

const seed = (over = {}) => {
  const p = { code: "PV009", name: "Química del Valle", legal_name: "Química del Valle SA", rfc: "QVA010101AAA", is_customer: false, is_supplier: true, group_name: "Varios", city: "Los Mochis", payment_days: 0, late: 0, partner_kind: "trade", credit_limit: 0, ...over };
  return [1, p.code, p.name, p.legal_name, p.rfc, p.is_customer, p.is_supplier, p.group_name, p.city, p.payment_days, p.late, p.partner_kind, p.credit_limit];
};

test("resync: el socio nuevo nace con el límite y el plazo del catálogo (siembra)", async () => {
  const db = await freshDb();
  await db.query(upsertSql(), seed({ credit_limit: 250000, payment_days: 0 }));
  const r = (await db.query(`select credit_limit::float8 as cl, payment_days as pd, is_supplier from partners where code = 'PV009'`)).rows[0];
  assert.equal(r.cl, 250000);
  assert.equal(r.pd, 0);
  assert.equal(r.is_supplier, true);
  await db.close();
});

test("resync: lo capturado a mano MANDA — 30 días y 500,000 de límite sobreviven a un segundo resync", async () => {
  const db = await freshDb();
  await db.query(upsertSql(), seed());
  // La ficha (savePartner): plazo 30 y límite 500,000, y además se marca como cliente (links.ts).
  await db.exec(`update partners set payment_days = 30, credit_limit = 500000, is_customer = true where code = 'PV009'`);
  await db.query(upsertSql(), seed({ name: "QUIMICA DEL VALLE (nombre nuevo)", credit_limit: 0, payment_days: 0 }));
  const r = (await db.query(`select name, credit_limit::float8 as cl, payment_days as pd, is_customer, is_supplier from partners where code = 'PV009'`)).rows[0];
  assert.equal(r.pd, 30, "el plazo capturado no vuelve a 0 (0 = contado: la FP nacería vencida)");
  assert.equal(r.cl, 500000, "el límite capturado no vuelve al del catálogo");
  assert.equal(r.is_customer, true, "la bandera marcada a mano no se quita");
  assert.equal(r.is_supplier, true);
  assert.equal(r.name, "QUIMICA DEL VALLE (nombre nuevo)", "lo que sí es del catálogo (nombre) sí se actualiza");
  const n = (await db.query(`select count(*)::int as n from partners`)).rows[0].n;
  assert.equal(n, 1, "sigue siendo un solo socio");
  await db.close();
});

test("resync: el catálogo SÍ puede sumar una bandera (un proveedor que el catálogo ahora marca también cliente)", async () => {
  const db = await freshDb();
  await db.query(upsertSql(), seed({ is_customer: false, is_supplier: true }));
  await db.query(upsertSql(), seed({ is_customer: true, is_supplier: true }));
  const r = (await db.query(`select is_customer, is_supplier from partners where code = 'PV009'`)).rows[0];
  assert.equal(r.is_customer, true);
  assert.equal(r.is_supplier, true);
  await db.close();
});

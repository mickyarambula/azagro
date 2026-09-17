// CORTE INICIAL, paso 0 (16-sep-2026): la primera prueba FUNCIONAL del
// importador del corte Compaq — hasta hoy solo había greps de texto fuente
// (erp-politica-cobro, erp-cartera). El corazón del importador vive ahora en
// `cutover-core.ts` (sin dependencias de servidor) y aquí se ejecuta DE
// VERDAD contra PGlite con las migraciones reales: parseo, idempotencia por
// `cutover_key`, `opening_paid`, dólares, circuito ASR solo en clientes, y
// el saldo inicial de existencias por producto+bodega.
//
// Congela el comportamiento vigente ANTES de los cambios de las Decisiones
// 63-66; lo que esas decisiones cambian a propósito se prueba en sus pasos.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pendingMigrations } from "./migration-plan.mjs";
import {
  applyOpenInvoiceRows,
  applyStockRows,
  parseOpenInvoices,
  parseStockSnap,
  previewOpenInvoiceRows,
  previewStockRows,
} from "../src/lib/erp/cutover-core.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "migrations");
const src = (p) => readFileSync(join(root, p), "utf8");

/** foldName real (catalog.ts), copiado letra por letra — catalog.ts no se puede importar en node --test (alias @). */
function foldName(s) {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

test("wiring: foldName de aquí es letra por letra el de catalog.ts", () => {
  const cat = src("src/lib/erp/catalog.ts");
  for (const linea of [
    '.normalize("NFD")',
    '.replace(/[\\u0300-\\u036f]/g, "")',
    '.replace(/[^A-Z0-9]/g, "")',
  ]) {
    assert.ok(cat.includes(linea), `catalog.ts ya no tiene ${linea}: actualizar la copia de la prueba`);
  }
});

test("wiring: ensureInvoiceExtras sigue agregando created_by (la prueba lo replica)", () => {
  const st = src("src/lib/erp/stock.ts");
  assert.ok(st.includes("add column if not exists created_by text not null default ''"), "cambió ensureInvoiceExtras: actualizar freshDb");
});

test("wiring: cutover.ts delega en cutover-core (no reimplementa el loop)", () => {
  const s = src("src/lib/erp/cutover.ts");
  assert.ok(s.includes("applyOpenInvoiceRows(sql, {"), "applyOpenInvoices debe usar applyOpenInvoiceRows del core");
  assert.ok(s.includes("applyStockRows(sql, {"), "applyStockSnap debe usar applyStockRows del core");
  assert.ok(s.includes("previewOpenInvoiceRows(sql, {"), "previewOpenInvoices debe usar el core");
  assert.ok(s.includes("circuitCode: CUTOVER_CIRCUIT"), "el circuito del corte sigue siendo el del catálogo (Decisión 3.d)");
  assert.ok(!/const invRow = z\.object/.test(s), "el parseo ya no vive en cutover.ts");
});

/** Adaptador: el tag `sql` de la app sobre PGlite (mismas llamadas, parámetros posicionales). */
function tagOf(db) {
  return async (strings, ...vals) => {
    let text = "";
    strings.forEach((part, i) => {
      text += part;
      if (i < vals.length) text += `$${i + 1}`;
    });
    return (await db.query(text, vals)).rows;
  };
}

async function freshDb() {
  const db = new PGlite();
  for (const { name, path } of pendingMigrations(readdirSync(dir), [])) {
    try {
      await db.exec(readFileSync(join(dir, path), "utf8"));
    } catch (e) {
      assert.fail(`${name}: ${e?.message ?? e}`);
    }
  }
  // Los extras que en producción agrega ensureInvoiceExtras (stock.ts) en
  // runtime — el wiring de abajo vigila que sigan siendo estas columnas.
  await db.exec(`alter table invoices add column if not exists created_by text not null default ''`);
  await db.exec(`insert into companies (id, name, join_code, created_by) values (1, 'Azagro', 'AZ1', 'u1')`);
  await db.exec(`insert into partners (company_id, code, name, is_customer, payment_days) values (1, 'CL0001', 'Grupo SL', true, 30)`);
  await db.exec(`insert into partners (company_id, code, name, is_supplier, payment_days) values (1, 'PR0001', 'Química del Valle', true, 30)`);
  await db.exec(`insert into credit_policies (company_id, code, name) values (1, 'ESTANDAR', 'Estándar')`);
  await db.exec(`insert into products (company_id, code, name) values (1, 'ALB-10', 'Albendazol 10')`);
  await db.exec(`insert into locations (company_id, code, name) values (1, '001', 'Bodega Mochis')`);
  return db;
}

/** postStock de prueba: registra la llamada y escribe el renglón mínimo del kardex (para que la idempotencia real, que lee stock_moves, tenga qué leer). */
function postStockStub(calls) {
  return async (sql, a) => {
    calls.push(a);
    await sql`
      insert into stock_moves (company_id, ref, move_type, origin, location_to, product_id, quantity, unit_cost, created_by)
      values (${a.companyId}, ${"INI/TEST"}, ${a.moveType}, ${a.origin}, ${a.locationTo}, ${a.productId}, ${a.quantity}, ${a.unitCost}, ${a.userId})
    `;
  };
}

// ---------- parseo ----------

test("parseOpenInvoices: 9 columnas, encabezado fuera, moneda y lado por texto", () => {
  const rows = parseOpenInvoices(
    [
      "código,folio,fecha,vence,cargo,abono,saldo,moneda,lado",
      "CL0001,A-292,2025-11-01,2026-04-01,150000,20000,130000,MXN,cliente",
      "PR0001,F 88,2025-12-01,2026-01-15,50000,0,50000,USD,proveedor",
      "CL0001,A-000,2025-11-01,2026-04-01,1000,1000,0,MXN,cliente",
    ].join("\n"),
    "2026-09-16",
  );
  assert.equal(rows.length, 2, "el encabezado y la fila con saldo 0 no entran");
  assert.deepEqual(rows[0], {
    partnerCode: "CL0001",
    folio: "A-292",
    date: "2025-11-01",
    due: "2026-04-01",
    cargo: 150000,
    abono: 20000,
    saldo: 130000,
    currency: "MXN",
    kind: "customer",
  });
  assert.equal(rows[1].kind, "supplier");
  assert.equal(rows[1].currency, "USD");
  assert.equal(rows[1].folio, "F-88", "espacios del folio a guiones");
});

test("parseStockSnap: 4 columnas, cantidad 0 fuera, bodega 001 si falta", () => {
  const rows = parseStockSnap(["ALB-10,001,25,18.5", "ALB-10,001,0,18.5"].join("\n"));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { productCode: "ALB-10", locationCode: "001", qty: 25, cost: 18.5 });
});

// ---------- saldos abiertos contra la base ----------

const CSV_INV = [
  "CL0001,A-292,2025-11-01,2026-04-01,150000,20000,130000,MXN,cliente",
  "PR0001,F-88,2025-12-01,2026-01-15,50000,0,50000,USD,proveedor",
].join("\n");

test("saldos: inserta con cutover_key, opening_paid = cargo − saldo, circuito ASR solo al cliente", async () => {
  const db = await freshDb();
  const sql = tagOf(db);
  const rows = parseOpenInvoices(CSV_INV, "2026-09-16");
  const r = await applyOpenInvoiceRows(sql, {
    companyId: 1,
    userId: "u1",
    policyCode: "ESTANDAR",
    circuitCode: "ASR",
    rows,
    foldName,
  });
  assert.deepEqual(r, { inserted: 2, skipped: 0, rejected: [] });
  const inv = (await db.query(
    `select kind, name, amount::float8 as amount, residual::float8 as residual, opening_paid::float8 as op,
            currency, cutover_key, policy_code, circuit_code, origin, state
     from invoices order by id`,
  )).rows;
  assert.equal(inv[0].cutover_key, "customer:CL0001:A-292");
  assert.equal(inv[0].amount, 150000);
  assert.equal(inv[0].residual, 130000);
  assert.equal(inv[0].op, 20000, "el abono de Compaq queda como opening_paid");
  assert.equal(inv[0].policy_code, "ESTANDAR");
  assert.equal(inv[0].circuit_code, "ASR", "cliente del corte entra por doble facturación (Decisión 3.d)");
  assert.equal(inv[0].origin, "Corte Compaq");
  assert.equal(inv[0].state, "open");
  assert.equal(inv[1].kind, "supplier");
  assert.equal(inv[1].currency, "USD");
  assert.equal(inv[1].circuit_code, null, "la FP del corte no lleva circuito");
  await db.close();
});

test("saldos: segunda pegada idéntica no duplica nada (idempotencia por cutover_key)", async () => {
  const db = await freshDb();
  const sql = tagOf(db);
  const rows = parseOpenInvoices(CSV_INV, "2026-09-16");
  const args = { companyId: 1, userId: "u1", policyCode: "ESTANDAR", circuitCode: "ASR", rows, foldName };
  await applyOpenInvoiceRows(sql, args);
  const r2 = await applyOpenInvoiceRows(sql, args);
  assert.deepEqual(r2, { inserted: 0, skipped: 2, rejected: [] });
  const n = (await db.query(`select count(*)::int as n from invoices`)).rows[0].n;
  assert.equal(n, 2);
  await db.close();
});

test("saldos: el partner también se encuentra por nombre plegado cuando el código no matchea", async () => {
  const db = await freshDb();
  const sql = tagOf(db);
  await db.exec(`update partners set name = 'GRUPOSL' where code = 'CL0001'`);
  const rows = parseOpenInvoices("Grupo SL,B-1,2025-11-01,2026-04-01,1000,0,1000,MXN,cliente", "2026-09-16");
  const r = await applyOpenInvoiceRows(sql, {
    companyId: 1, userId: "u1", policyCode: "ESTANDAR", circuitCode: "ASR", rows, foldName,
  });
  assert.deepEqual(r, { inserted: 1, skipped: 0, rejected: [] });
  await db.close();
});

test("preview de saldos: marca skip lo ya cargado y partnerId 0 lo que no está en catálogo", async () => {
  const db = await freshDb();
  const sql = tagOf(db);
  const rows = parseOpenInvoices(CSV_INV, "2026-09-16");
  await applyOpenInvoiceRows(sql, { companyId: 1, userId: "u1", policyCode: "ESTANDAR", circuitCode: "ASR", rows, foldName });
  const otra = parseOpenInvoices(
    CSV_INV + "\nXX9999,C-1,2025-11-01,2026-04-01,500,0,500,MXN,cliente",
    "2026-09-16",
  );
  const p = await previewOpenInvoiceRows(sql, { companyId: 1, rows: otra });
  assert.equal(p.skipped, 2, "las dos ya cargadas salen como skip");
  assert.equal(p.open, 1);
  const sinCatalogo = p.rows.filter((r) => !r.partnerId);
  assert.equal(sinCatalogo.length, 1);
  assert.equal(sinCatalogo[0].partnerCode, "XX9999");
  await db.close();
});

// ---------- existencias contra la base ----------

test("existencias: entra una vez por producto+bodega; la segunda pegada se salta", async () => {
  const db = await freshDb();
  const sql = tagOf(db);
  const calls = [];
  const rows = parseStockSnap("ALB-10,001,25,18.5");
  const args = { companyId: 1, userId: "u1", rows, postStock: postStockStub(calls) };
  const r1 = await applyStockRows(sql, args);
  assert.deepEqual(r1, { inserted: 1, skipped: 0, rejected: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].moveType, "opening");
  assert.equal(calls[0].origin, "Corte Compaq");
  assert.equal(calls[0].quantity, 25);
  assert.equal(calls[0].unitCost, 18.5);
  const r2 = await applyStockRows(sql, args);
  assert.deepEqual(r2, { inserted: 0, skipped: 1, rejected: [] }, "idempotente: ya hay INI de corte para ese producto+bodega");
  assert.equal(calls.length, 1, "no volvió a tocar el kardex");
  await db.close();
});

test("existencias: la bodega se encuentra por código o por nombre", async () => {
  const db = await freshDb();
  const sql = tagOf(db);
  const calls = [];
  const rows = parseStockSnap("ALB-10,BODEGA MOCHIS,10,20");
  const r = await applyStockRows(sql, { companyId: 1, userId: "u1", rows, postStock: postStockStub(calls) });
  assert.deepEqual(r, { inserted: 1, skipped: 0, rejected: [] });
  await db.close();
});

// ---------- paso 1: Decisiones 66 y 64 ----------
// 66: una fila con código desconocido NO aborta el lote — entran las válidas
//     y las malas se reportan con su razón (reintento seguro por cutover_key).
// 64: una existencia sin costo (vacío o ≤ 0) se rechaza y se avisa — vacío no
//     es cero (regla 9); no entra al kardex a $0.

test("Decisión 66 (saldos): la fila con código desconocido se reporta y las demás SÍ entran", async () => {
  const db = await freshDb();
  const sql = tagOf(db);
  const rows = parseOpenInvoices(
    CSV_INV + "\nXX9999,C-1,2025-11-01,2026-04-01,500,0,500,MXN,cliente",
    "2026-09-16",
  );
  const r = await applyOpenInvoiceRows(sql, {
    companyId: 1, userId: "u1", policyCode: "ESTANDAR", circuitCode: "ASR", rows, foldName,
  });
  assert.equal(r.inserted, 2, "las dos buenas entran aunque la tercera esté mal");
  assert.equal(r.skipped, 0);
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0].reason, /XX9999/, "la razón nombra el código que falta");
  assert.match(r.rejected[0].reason, /C-1/, "y el folio, para encontrarlo en el CSV");
  const n = (await db.query(`select count(*)::int as n from invoices`)).rows[0].n;
  assert.equal(n, 2, "en la base quedaron exactamente las buenas");
  await db.close();
});

test("Decisión 66 (saldos): reintento tras corregir el catálogo — lo cargado se salta, la corregida entra", async () => {
  const db = await freshDb();
  const sql = tagOf(db);
  const csv = CSV_INV + "\nXX9999,C-1,2025-11-01,2026-04-01,500,0,500,MXN,cliente";
  const rows = parseOpenInvoices(csv, "2026-09-16");
  const args = { companyId: 1, userId: "u1", policyCode: "ESTANDAR", circuitCode: "ASR", rows, foldName };
  await applyOpenInvoiceRows(sql, args);
  await db.exec(`insert into partners (company_id, code, name, is_customer, payment_days) values (1, 'XX9999', 'Cliente Nuevo', true, 30)`);
  const r2 = await applyOpenInvoiceRows(sql, args);
  assert.equal(r2.inserted, 1, "solo la que faltaba");
  assert.equal(r2.skipped, 2, "las de la primera pegada no se duplican");
  assert.equal(r2.rejected.length, 0);
  await db.close();
});

test("Decisión 66 (existencias): producto o bodega desconocidos se reportan, el resto entra", async () => {
  const db = await freshDb();
  const sql = tagOf(db);
  const calls = [];
  const rows = parseStockSnap(["ALB-10,001,25,18.5", "NOEXISTE,001,5,10", "ALB-10,BODEGA-X,5,10"].join("\n"));
  const r = await applyStockRows(sql, { companyId: 1, userId: "u1", rows, postStock: postStockStub(calls) });
  assert.equal(r.inserted, 1);
  assert.equal(r.rejected.length, 2);
  assert.match(r.rejected[0].reason, /NOEXISTE/);
  assert.match(r.rejected[1].reason, /BODEGA-X/);
  assert.equal(calls.length, 1, "el kardex solo vio la buena");
  await db.close();
});

test("Decisión 64 (existencias): sin costo (vacío o ≤ 0) la fila se rechaza — no entra a $0", async () => {
  const db = await freshDb();
  const sql = tagOf(db);
  const calls = [];
  const rows = parseStockSnap(["ALB-10,001,25,", "ALB-10,001,25,-3"].join("\n"));
  const r = await applyStockRows(sql, { companyId: 1, userId: "u1", rows, postStock: postStockStub(calls) });
  assert.equal(r.inserted, 0);
  assert.equal(r.rejected.length, 2);
  assert.match(r.rejected[0].reason, /sin costo/i, "dice qué falta");
  assert.match(r.rejected[0].reason, /ALB-10/, "y de qué producto");
  assert.equal(calls.length, 0, "el kardex no se tocó");
  const n = (await db.query(`select count(*)::int as n from stock_moves`)).rows[0].n;
  assert.equal(n, 0);
  await db.close();
});

// ---------- paso 2: Decisión 65 ----------
// Un folio (o producto+bodega) ya cargado que llega con importes distintos en
// una segunda pegada NO se ignora en silencio: el preview marca la diferencia
// sin aplicarla, y la persona decide. Lo idéntico sigue saliendo como "ya está".

test("Decisión 65 (saldos): mismo folio con otro saldo → el preview lo marca; idéntico → solo skip", async () => {
  const db = await freshDb();
  const sql = tagOf(db);
  const rows = parseOpenInvoices(CSV_INV, "2026-09-16");
  await applyOpenInvoiceRows(sql, { companyId: 1, userId: "u1", policyCode: "ESTANDAR", circuitCode: "ASR", rows, foldName });
  const otra = parseOpenInvoices(
    [
      "CL0001,A-292,2025-11-01,2026-04-01,150000,20000,135000,MXN,cliente", // saldo distinto
      "PR0001,F-88,2025-12-01,2026-01-15,50000,0,50000,USD,proveedor", // idéntica
    ].join("\n"),
    "2026-09-16",
  );
  const p = await previewOpenInvoiceRows(sql, { companyId: 1, rows: otra });
  const cambiada = p.rows.find((r) => r.folio === "A-292");
  assert.equal(cambiada.skip, true, "no se aplica: sigue siendo skip");
  assert.ok(cambiada.differs, "pero la diferencia se dice");
  assert.match(cambiada.differs, /130000/, "con el saldo guardado");
  assert.match(cambiada.differs, /135000/, "y el del CSV");
  const igual = p.rows.find((r) => r.folio === "F-88");
  assert.equal(igual.skip, true);
  assert.equal(igual.differs, undefined, "idéntico no alarma");
  assert.equal(p.differing, 1);
  await db.close();
});

test("Decisión 65 (saldos): mismo folio con otro cargo también se marca", async () => {
  const db = await freshDb();
  const sql = tagOf(db);
  const rows = parseOpenInvoices(CSV_INV, "2026-09-16");
  await applyOpenInvoiceRows(sql, { companyId: 1, userId: "u1", policyCode: "ESTANDAR", circuitCode: "ASR", rows, foldName });
  const otra = parseOpenInvoices("CL0001,A-292,2025-11-01,2026-04-01,155000,20000,130000,MXN,cliente", "2026-09-16");
  const p = await previewOpenInvoiceRows(sql, { companyId: 1, rows: otra });
  assert.match(p.rows[0].differs, /150000/);
  assert.match(p.rows[0].differs, /155000/);
  await db.close();
});

test("Decisión 65 (existencias): el preview nuevo marca ya está / con otros números / sin catálogo / sin costo", async () => {
  const db = await freshDb();
  const sql = tagOf(db);
  const calls = [];
  await applyStockRows(sql, {
    companyId: 1, userId: "u1", rows: parseStockSnap("ALB-10,001,25,18.5"), postStock: postStockStub(calls),
  });
  const otra = parseStockSnap(
    [
      "ALB-10,001,30,18.5", // misma llave, otra cantidad
      "NOEXISTE,001,5,10", // sin catálogo
      "ALB-10,001,25,18.5", // idéntica (misma llave otra vez: ya está)
    ].join("\n"),
  );
  const p = await previewStockRows(sql, { companyId: 1, rows: otra });
  assert.equal(p.rows[0].skip, true, "ya hay INI de ese producto+bodega: no se aplica");
  assert.ok(p.rows[0].differs, "y la diferencia de cantidad se dice");
  assert.match(p.rows[0].differs, /25/);
  assert.match(p.rows[0].differs, /30/);
  assert.match(p.rows[1].problem, /NOEXISTE/, "sin catálogo se ve desde el preview");
  assert.equal(p.rows[2].skip, true);
  assert.equal(p.rows[2].differs, undefined, "idéntica no alarma");
  const sinCosto = await previewStockRows(sql, { companyId: 1, rows: parseStockSnap("ALB-10,001,25,") });
  assert.match(sinCosto.rows[0].problem, /sin costo/i, "sin costo se ve desde el preview (Decisión 64)");
  await db.close();
});

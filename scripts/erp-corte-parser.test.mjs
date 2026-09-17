// CORTE COMPAQ — el parser no adivina (grupo B de la auditoría, #10 → #7 →
// #11, 17-sep-2026). Regla: un dato de negocio que el CSV no trae claramente
// no se adivina, se rechaza la fila (Decisión 66 aplicada al lado y a las
// comillas). #10: CSV real (RFC 4180) — una razón social con coma o "1,500.00"
// entre comillas ya no corre las columnas. #7: la columna «lado» decide sola;
// ausente o con otra palabra → la fila se rechaza con motivo, nunca entra
// como cuenta por cobrar. #11: el borrado de pruebas conserva los saldos
// iniciales de bancos del corte (bank_moves.cutover_key, Decisión 63).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pendingMigrations } from "./migration-plan.mjs";
import { PURGE } from "./purge-plan.mjs";
import { applyOpenInvoiceRows, parseBankSnap, parseOpenInvoices, parseStockSnap, previewOpenInvoiceRows } from "../src/lib/erp/cutover-core.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "migrations");
const src = (p) => readFileSync(join(root, p), "utf8");
const foldName = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
function tagOf(db) {
  return async (strings, ...vals) => {
    let text = "";
    strings.forEach((part, i) => { text += part; if (i < vals.length) text += `$${i + 1}`; });
    return (await db.query(text, vals)).rows;
  };
}
async function freshDb() {
  const db = new PGlite();
  for (const { path } of pendingMigrations(readdirSync(dir), [])) await db.exec(readFileSync(join(dir, path), "utf8"));
  await db.exec(`alter table invoices add column if not exists created_by text not null default ''`);
  await db.exec(`insert into companies (id, name, join_code, created_by) values (1, 'Azagro', 'AZ1', 'u1')`);
  await db.exec(`insert into partners (company_id, code, name, is_customer, payment_days) values (1, 'CL0001', 'Grupo SL', true, 30)`);
  await db.exec(`insert into partners (company_id, code, name, is_supplier, payment_days) values (1, 'PR0001', 'Química del Valle', true, 30)`);
  await db.exec(`insert into banks (id, company_id, name, account, currency) values (1, 1, 'BBVA Operativa', '0123456789', 'MXN')`);
  return db;
}
const HOY = "2026-09-17";

// ---------------------------------------------------------------------------
// #10 — comillas
// ---------------------------------------------------------------------------
test("#10: una razón social con coma entre comillas ya no corre las columnas; \"1,500.00\" es 1500; TSV sigue igual", () => {
  const csv = [
    `"GRUPO AGRICOLA, S.A. DE C.V.",FV-1001,2026-08-01,2026-11-29,100000,20000,80000,MXN,cliente`,
    `CLI-02,FV-1003,2026-08-02,2026-11-30,"1,500.00",,"1,500.00",MXN,cliente`,
    `CLI-03,"FV ""bis"" 7",2026-08-03,2026-11-30,10,0,10,MXN,cliente`,
  ].join("\n");
  const rows = parseOpenInvoices(csv, HOY);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { partnerCode: "GRUPO AGRICOLA, S.A. DE C.V.", folio: "FV-1001", date: "2026-08-01", due: "2026-11-29", cargo: 100000, abono: 20000, saldo: 80000, currency: "MXN", kind: "customer" });
  assert.deepEqual([rows[1].cargo, rows[1].abono, rows[1].saldo], [1500, 0, 1500], "antes: cargo 1, abono 500, saldo 500 — entraba sin aviso");
  assert.equal(rows[2].folio, 'FV-"bis"-7', "comilla doblada = comilla literal");
  const tsv = parseOpenInvoices(`GRUPO AGRICOLA, S.A. DE C.V.\tFV-1001\t2026-08-01\t2026-11-29\t100000\t20000\t80000\tMXN\tcliente`, HOY);
  assert.deepEqual(tsv[0], rows[0], "la rama TSV no cambió");
  assert.deepEqual(parseBankSnap(`"BBVA, CHEQUES",150000,2026-09-15`, HOY), [{ account: "BBVA, CHEQUES", amount: 150000, date: "2026-09-15" }]);
  assert.deepEqual(parseStockSnap(`ALB-10,"BODEGA 1, NORTE",25,120.5`), [{ productCode: "ALB-10", locationCode: "BODEGA 1, NORTE", qty: 25, cost: 120.5 }]);
  assert.deepEqual(parseStockSnap(`TUBO 2",001,10,50`), [{ productCode: "TUBO 2", locationCode: "001", qty: 10, cost: 50 }], "comilla sin par (pulgadas): la fila se lee como siempre (split, comilla final fuera), no desaparece");
});

// ---------------------------------------------------------------------------
// #7 — el lado
// ---------------------------------------------------------------------------
test("#7: sin columna «lado» o con otra palabra el parser NO adivina (kind unknown); cliente/proveedor y sus variantes sí", () => {
  const k = (lado) => parseOpenInvoices(`PR0001,F-88,2025-12-01,2026-01-15,50000,0,50000,MXN${lado === null ? "" : "," + lado}`, HOY)[0].kind;
  assert.equal(k(null), "unknown", "8 columnas: antes miraba el código PR0001 y, como no decía 'prov', era CLIENTE");
  assert.equal(k(""), "unknown");
  assert.equal(k("xyz"), "unknown");
  for (const v of ["proveedor", "PROVEEDORES", "prov", "CXP", "C x P", "por pagar", "supplier", "FP"]) assert.equal(k(v), "supplier", v);
  for (const v of ["cliente", "Clientes", "cli", "CXC", "c x c", "por cobrar", "customer", "FV"]) assert.equal(k(v), "customer", v);
  assert.equal(k("proveedor y cliente"), "unknown", "una palabra ajena no se acepta por contener 'prov'");
});

test("#7: el apply rechaza la fila sin lado con motivo y las demás SÍ entran (Decisión 66); el preview la marca y no la cuenta como 'entraría'", async () => {
  const db = await freshDb();
  const sql = tagOf(db);
  const rows = parseOpenInvoices([
    "CL0001,A-292,2025-11-01,2026-04-01,150000,20000,130000,MXN,cliente",
    "PR0001,F-88,2025-12-01,2026-01-15,50000,0,50000,MXN",
    "PR0001,F-91,2025-12-01,2026-01-15,1000,0,1000,MXN,proveedor",
  ].join("\n"), HOY);
  const pv = await previewOpenInvoiceRows(sql, { companyId: 1, rows });
  assert.equal(pv.problems, 1);
  assert.equal(pv.open, 2, "la sin lado no se cuenta como 'entraría'");
  assert.match(pv.rows[1].problem, /la columna «lado» no dice cliente o proveedor/);
  const r = await applyOpenInvoiceRows(sql, { companyId: 1, userId: "u1", rows, policyCode: "NONE", circuitCode: "ASR", foldName });
  assert.equal(r.inserted, 2);
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0].reason, /^Fila PR0001 · folio F-88: la columna «lado» no dice cliente o proveedor/);
  const inv = await sql`select name, kind from invoices where company_id = 1 order by id`;
  assert.deepEqual(inv, [{ name: "A-292", kind: "customer" }, { name: "F-91", kind: "supplier" }], "ninguna deuda con proveedor entró como cuenta por cobrar");
  await db.close();
});

// ---------------------------------------------------------------------------
// #8 — saldo a favor (Decisión 71)
// ---------------------------------------------------------------------------
test("#8 (Decisión 71): un saldo negativo del corte se rechaza con motivo y el preview lo marca; no nace una factura que el recálculo colapsaría a $0", async () => {
  const db = await freshDb();
  const sql = tagOf(db);
  const rows = parseOpenInvoices([
    "CL0001,NC-1,2025-01-01,2025-01-01,0,5000,-5000,MXN,cliente",
    "CL0001,A-7,2025-01-01,2025-03-01,1000,0,1000,MXN,cliente",
  ].join("\n"), HOY);
  assert.equal(rows.length, 2, "el parser la conserva para poder decir por qué no entra");
  const pv = await previewOpenInvoiceRows(sql, { companyId: 1, rows });
  assert.equal(pv.problems, 1);
  assert.match(pv.rows[0].problem, /saldo a favor \(-5000 MXN\)/);
  const r = await applyOpenInvoiceRows(sql, { companyId: 1, userId: "u1", rows, policyCode: "NONE", circuitCode: "ASR", foldName });
  assert.equal(r.inserted, 1);
  assert.match(r.rejected[0].reason, /Decisión 71/);
  assert.deepEqual(await sql`select name from invoices where company_id = 1`, [{ name: "A-7" }]);
  await db.close();
});

// ---------------------------------------------------------------------------
// #9 — dólares del corte (Decisión 70)
// ---------------------------------------------------------------------------
test("#9 (Decisión 70): una fila USD entra en pesos al TC del corte (último renglón ≤ hoy), con amount_fx y fx_agreed; la MXN no cambia un centavo", async () => {
  const db = await freshDb();
  const sql = tagOf(db);
  await db.exec(`insert into fx_rates (company_id, date, usd_mxn) values (1, '2026-09-10', 18.5), (1, '2026-09-20', 19.9)`);
  const rows = parseOpenInvoices([
    "CL0001,A-100,2025-11-01,2026-04-01,50000,0,50000,MXN,cliente",
    "CL0001,A-101,2025-11-01,2026-04-01,10000,2000,8000,USD,cliente",
  ].join("\n"), HOY);
  const r = await applyOpenInvoiceRows(sql, { companyId: 1, userId: "u1", rows, policyCode: "NONE", circuitCode: "ASR", foldName, today: HOY });
  assert.deepEqual(r, { inserted: 2, skipped: 0, rejected: [] });
  const inv = await sql`select name, currency, amount::float8 as amount, residual::float8 as residual, opening_paid::float8 as op, amount_fx::float8 as fx_amt, fx_agreed::float8 as fx from invoices where company_id = 1 order by id`;
  assert.deepEqual(inv[0], { name: "A-100", currency: "MXN", amount: 50000, residual: 50000, op: 0, fx_amt: 0, fx: 1 }, "MXN: los mismos valores por omisión de siempre (fx_agreed 1)");
  assert.deepEqual(inv[1], { name: "A-101", currency: "USD", amount: 185000, residual: 148000, op: 37000, fx_amt: 10000, fx: 18.5 }, "TC del 10-sep (≤ 17-sep), no el del 20-sep");
  // El límite de crédito ya suma pesos con pesos: 50,000 + 148,000, no 58,000.
  const ar = await sql`select sum(residual)::float8 as ar from invoices where company_id = 1 and kind = 'customer' and state = 'open'`;
  assert.equal(ar[0].ar, 198000);
  // Decisión 65 sobre la fila USD: idéntica no alarma aunque hoy el TC sea otro; con otro saldo sí.
  await db.exec(`insert into fx_rates (company_id, date, usd_mxn) values (1, '2026-09-17', 20)`);
  const otra = parseOpenInvoices("CL0001,A-101,2025-11-01,2026-04-01,10000,2000,8000,USD,cliente\nCL0001,A-100,2025-11-01,2026-04-01,50000,0,49000,MXN,cliente", HOY);
  const pv = await previewOpenInvoiceRows(sql, { companyId: 1, rows: otra, today: HOY });
  assert.equal(pv.rows[0].differs, undefined, "se compara en dólares, no al TC de hoy");
  assert.match(pv.rows[1].differs, /49000/);
  await db.close();
});

test("#9 (Decisión 70): la conversión es exacta al centavo — 999.99 USD × 18.5 = 18,499.82, no 18,499.81 del float", async () => {
  const db = await freshDb();
  const sql = tagOf(db);
  await db.exec(`insert into fx_rates (company_id, date, usd_mxn) values (1, '2026-09-10', 18.5)`);
  const rows = parseOpenInvoices("CL0001,A-9,2025-11-01,2026-04-01,999.99,0,999.99,USD,cliente", HOY);
  await applyOpenInvoiceRows(sql, { companyId: 1, userId: "u1", rows, policyCode: "NONE", circuitCode: "ASR", foldName, today: HOY });
  const inv = await sql`select amount::text as amount, residual::text as residual from invoices where company_id = 1`;
  assert.deepEqual(inv, [{ amount: "18499.82", residual: "18499.82" }]);
  assert.equal(Math.round(999.99 * 18.5 * 100) / 100, 18499.81, "el float sí se equivoca: por eso se multiplica en enteros");
  await db.close();
});

test("#9 (Decisión 70): sin TC en la tabla, la fila USD se rechaza con motivo y la MXN entra; el preview lo marca", async () => {
  const db = await freshDb();
  const sql = tagOf(db);
  const rows = parseOpenInvoices("CL0001,A-100,2025-11-01,2026-04-01,50000,0,50000,MXN,cliente\nCL0001,A-101,2025-11-01,2026-04-01,10000,0,10000,USD,cliente", HOY);
  const pv = await previewOpenInvoiceRows(sql, { companyId: 1, rows, today: HOY });
  assert.equal(pv.problems, 1);
  assert.match(pv.rows[1].problem, /no hay tipo de cambio en la tabla para la fecha del corte/);
  const r = await applyOpenInvoiceRows(sql, { companyId: 1, userId: "u1", rows, policyCode: "NONE", circuitCode: "ASR", foldName, today: HOY });
  assert.equal(r.inserted, 1);
  assert.match(r.rejected[0].reason, /Decisión 70/);
  await db.close();
});

test("cableado: cutover.ts pasa la fecha de hoy al preview y al apply (el TC del corte se busca a esa fecha)", () => {
  const c = src("src/lib/erp/cutover.ts");
  assert.ok(c.includes("previewOpenInvoiceRows(sql, { companyId, rows: parsed, today: todayMx() })"));
  assert.ok(c.includes("foldName,\n        today: todayMx(),\n        creditDays: data.creditDays,\n      });"));
  const core = src("src/lib/erp/cutover-core.ts");
  assert.ok(core.includes("(${today ?? null}::date is null or date <= ${today ?? null}::date)\n    order by date desc limit 1"), "último renglón con fecha ≤ la del corte");
  assert.ok(!core.includes("toISOString"), "el core no calcula 'hoy': se lo pasa cutover.ts (todayMx)");
});

// ---------------------------------------------------------------------------
// #19 — plazo financiero de los saldos del corte (Decisión 72)
// ---------------------------------------------------------------------------
test("#19 (Decisión 72): con días de plazo financiero, cada saldo nace con credit_due = fecha + días y credit_days = días; «vence» sigue siendo cobranza", async () => {
  const db = await freshDb();
  const sql = tagOf(db);
  const rows = parseOpenInvoices("CL0001,A-292,2025-11-01,2026-03-01,150000,20000,130000,MXN,cliente\nPR0001,P-7,2025-12-15,2026-01-14,800,0,800,MXN,proveedor", HOY);
  await applyOpenInvoiceRows(sql, { companyId: 1, userId: "u1", rows, policyCode: "ESTANDAR", circuitCode: "ASR", foldName, today: HOY, creditDays: 150 });
  const inv = await sql`select name, date::text as date, due_date::text as due, credit_due::text as credit_due, credit_days from invoices where company_id = 1 order by id`;
  assert.deepEqual(inv[0], { name: "A-292", date: "2025-11-01", due: "2026-03-01", credit_due: "2026-03-31", credit_days: 150 }, "vence (120) para cobranza; interés desde el día 150");
  assert.deepEqual(inv[1], { name: "P-7", date: "2025-12-15", due: "2026-01-14", credit_due: null, credit_days: 0 }, "la deuda con el proveedor no lleva plazo financiero");
  // Decisiones 68-69 en la puerta de producción: «Sin mora» con plazo no nace (regla única, guardSaleTerms).
  const c = src("src/lib/erp/cutover.ts");
  assert.ok(c.includes("await guardSaleTerms(sql, companyId, { creditDays: data.creditDays, policyCode: data.policyCode });"), "misma regla que los otros cuatro nacimientos");
  await db.close();
});

test("#19 (Decisión 72): sin días (solo pruebas viejas) la factura queda como antes — sin credit_due, credit_days 0; cutover.ts los exige y la pantalla no deja cargar sin ellos", async () => {
  const db = await freshDb();
  const sql = tagOf(db);
  const rows = parseOpenInvoices("CL0001,A-292,2025-11-01,2026-03-01,150000,20000,130000,MXN,cliente", HOY);
  await applyOpenInvoiceRows(sql, { companyId: 1, userId: "u1", rows, policyCode: "NONE", circuitCode: "ASR", foldName, today: HOY });
  assert.deepEqual(await sql`select credit_due, credit_days from invoices where company_id = 1`, [{ credit_due: null, credit_days: 0 }]);
  const c = src("src/lib/erp/cutover.ts");
  assert.ok(c.includes('creditDays: z.number().int().positive("Captura los días del plazo financiero de estos saldos (p. ej. 150).")'), "la puerta de producción lo exige");
  assert.ok(c.includes("creditDays: data.creditDays,") && c.includes("plazo financiero ${data.creditDays} días (Decisión 72)"), "se pasa al core y queda en bitácora");
  const ui = src("src/routes/importar.tsx");
  assert.ok(ui.includes("Días de plazo financiero de estos saldos") && ui.includes("disabled={busy || !csvInv.trim() || !policyCode || !(Number(creditDays) > 0)}"), "sin días no hay botón");
  await db.close();
});

// ---------------------------------------------------------------------------
// #11 — el borrado conserva los bancos del corte
// ---------------------------------------------------------------------------
test("#11: el borrado de pruebas conserva el saldo inicial de bancos del corte (cutover_key) y borra el resto", async () => {
  const db = await freshDb();
  await db.exec(`insert into bank_moves (company_id, bank_id, date, amount, memo, kind, reconciled, created_by, cutover_key) values
    (1, 1, '2026-09-15', 250000, 'Saldo inicial · corte Compaq', 'saldo-inicial', true, 'u1', 'bank:1'),
    (1, 1, '2026-09-16', -100, 'prueba', 'gasto', false, 'u1', null)`);
  const step = PURGE.find((s) => s.table === "bank_moves");
  assert.ok(step.sql.includes("cutover_key is null"), "como invoices: el corte sobrevive");
  assert.ok(step.keeps && step.keeps.includes("corte de Compaq"), "y el plan lo dice");
  await db.query(step.sql, [1]);
  const left = (await db.query(`select amount::text as amount, cutover_key from bank_moves where company_id = 1`)).rows;
  assert.deepEqual(left, [{ amount: "250000.00", cutover_key: "bank:1" }]);
  await db.close();
});

test("cableado: cells RFC 4180 solo en la rama de comas; sideOf decide por la columna 9 y nada más; la pantalla lo dice y enseña 'sin lado'", () => {
  const core = src("src/lib/erp/cutover-core.ts");
  assert.ok(core.includes('if (line.includes("\\t")) return line.split("\\t").map((c) => c.trim());'), "TSV intacto");
  assert.ok(core.includes("if (line[i + 1] === '\"') {") && core.includes("else if (ch === '\"') quoted = true;"), "comillas y comilla doblada");
  assert.ok(core.includes('if (((line.match(/"/g) || []).length & 1) === 1) return line.split(",")'), "el split de siempre solo para una comilla sin par (la fila no desaparece)");
  assert.equal((core.match(/line\.split\(","\)/g) || []).length, 1, "y en ningún otro lado");
  assert.ok(core.includes('const kind = sideOf(c[8] || "");'), "solo la columna 9");
  assert.ok(!core.includes("c[8] || c[0]"), "el código del socio ya no decide el lado");
  assert.ok(core.includes("const problem = rowProblem(r, fx);\n    if (problem) {\n      rejected.push({ reason: problem });"), "apply: rechazo con motivo, mismo orden que el preview");
  const ui = src("src/routes/importar.tsx");
  assert.ok(ui.includes("una fila sin lado se rechaza, no se adivina. Si una razón social lleva coma, va entre comillas."), "la pantalla dice el formato");
  assert.ok(ui.includes("{preview.problems} se rechazarían"), "y el preview cuenta lo que se rechazaría, con su motivo");
  assert.ok(src("src/lib/erp/purge.ts").includes("facturas y saldos iniciales de bancos con cutover_key"), "la bitácora del borrado nombra lo conservado");
});

// FOLIOS DE DINERO POR SERIE Y LA FI CON CANDADO — grupo C de la auditoría
// (AUDITORIA.md § 3, hallazgo #3), 17-sep-2026.
//
// Antes: FV, FP, NC, FI, ATC y PAG se numeraban con `count(*) + 1` sobre su
// tabla, cada sitio con un filtro distinto, y la FI se emitía sin transacción
// ni `for update`: dos clics en «Mora» podían facturar dos veces el mismo
// interés, comisión y FEGA. Ahora: `nextDocFolio` (folios.ts) con la misma
// sentencia atómica de `nextRef` (kardex, 0033) sobre folio_counters; la FV se
// lee `for update` dentro de `issueMoraInvoice`, y sus entradas manuales
// corren en `withTx`. La migración 0041 siembra cada serie desde el máximo
// real de los nombres: nada se renumera.
//
// La concurrencia real no se puede ejercer en PGlite (una sola conexión): la
// garantía es el candado de fila de Postgres — el mismo que ya protege el
// cobro — y aquí se fija el cableado y el comportamiento del contador.
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

/** Exactamente la SQL de nextDocFolio (folios.ts). */
async function pedirFolio(db, companyId, series) {
  const rows = (
    await db.query(
      `insert into folio_counters (company_id, series, last_number)
       values ($1, $2, 1)
       on conflict (company_id, series) do update set last_number = folio_counters.last_number + 1
       returning last_number`,
      [companyId, series],
    )
  ).rows;
  return `${series}-${String(rows[0].last_number).padStart(4, "0")}`;
}

async function applyUpTo(db, stopBefore) {
  for (const { name, path } of pendingMigrations(readdirSync(dir), [])) {
    if (stopBefore && name.startsWith(stopBefore)) continue;
    await db.exec(readFileSync(join(dir, path), "utf8"));
  }
  await db.exec(`insert into companies (id, name, join_code, created_by) values (1, 'Azagro', 'AZ1', 'u1'), (2, 'Otra', 'OT1', 'u1')`);
  await db.exec(`insert into partners (id, company_id, code, name, is_customer, payment_days) values (10, 1, 'CL1', 'Cliente', true, 90), (20, 2, 'CL1', 'Cliente', true, 90)`);
}
const m41 = () => readFileSync(join(dir, readdirSync(dir).find((f) => f.startsWith("0041"))), "utf8");

// ---------------------------------------------------------------------------
// nextDocFolio: la sentencia de nextRef, formato SERIE-NNNN
// ---------------------------------------------------------------------------
test("cableado: nextDocFolio usa el insert…on conflict…returning de folio_counters, formato SERIE-NNNN", () => {
  const body = fnBody(src("src/lib/erp/folios.ts"), "nextDocFolio");
  assert.ok(body.includes("insert into folio_counters"));
  assert.ok(body.includes("on conflict (company_id, series) do update set last_number = folio_counters.last_number + 1"), "el +1 atómico");
  assert.ok(body.includes("returning last_number"));
  assert.ok(body.includes('`${series}-${String(rows[0]!.last_number).padStart(4, "0")}`'), "guion y 4 dígitos, como siempre");
  assert.ok(!body.includes("count(*)"));
});

test("cableado: ningún documento de dinero se numera ya con count(*); los 12 sitios leen de nextDocFolio", () => {
  const files = ["src/lib/azagro.ts", "src/lib/erp/ops.ts", "src/lib/erp/reversal.ts", "src/lib/erp/return-reversal.ts", "src/lib/erp/delivery-reversal.ts"];
  for (const f of files) {
    const s = src(f);
    assert.ok(!/count\(\*\)::int as c from (invoices|payments)/.test(s), `${f}: queda un count(*) de folio sobre invoices/payments`);
    for (const serie of ["FV", "FP", "NC", "FI", "ATC", "PAG"]) {
      assert.ok(!s.includes(`\`${serie}-\${String(`), `${f}: queda el formato viejo ${serie}-\${String(`);
    }
  }
  const az = src("src/lib/azagro.ts");
  // Un solo sitio desde el 18-sep-2026: la FP por ORDEN se borró (Decisión 89).
  assert.equal((az.match(/nextDocFolio\(sql, opts\.companyId, "FP"\)/g) || []).length, 1, "FP: una sola, por recepción/entrega (por evento)");
  assert.ok(az.includes('const iname = await nextDocFolio(sql, opts.companyId, "FV");'), "FV");
  assert.ok(az.includes('const ncName = await nextDocFolio(sql, m.company_id, "NC");'), "NC de devolución");
  assert.ok(az.includes('const payName = await nextDocFolio(sql, m.company_id, "PAG");'), "PAG virtual de la devolución");
  const ops = src("src/lib/erp/ops.ts");
  assert.ok(ops.includes('const name = await nextDocFolio(sql, opts.companyId, "PAG");'), "PAG del cobro");
  assert.ok(ops.includes('const dname = await nextDocFolio(sql, opts.companyId, "PAG");'), "PAG del pronto pago");
  assert.ok(ops.includes('fxDoc = await nextDocFolio(sql, opts.companyId, "ATC");'), "ATC");
  assert.ok(fnBody(ops, "issueMoraInvoice").includes('const name = await nextDocFolio(sql, companyId, "FI");'), "FI");
  assert.ok(src("src/lib/erp/reversal.ts").includes('const nextPag = () => nextDocFolio(sql, companyId, "PAG");'), "PAG contrario (reversa de cobro)");
  assert.ok(src("src/lib/erp/return-reversal.ts").includes('const cname = await nextDocFolio(tx, companyId, "PAG");'), "PAG contrario (reversa de devolución)");
  assert.ok(src("src/lib/erp/delivery-reversal.ts").includes('const ncName = await nextDocFolio(sql, companyId, "NC");'), "NC espejo (reversa de entrega)");
  // El kardex sigue con el suyo, intacto (erp-folio-counters lo fija).
  assert.ok(fnBody(src("src/lib/erp/stock.ts"), "nextRef").includes("insert into folio_counters"));
});

// ---------------------------------------------------------------------------
// La FI: for update + withTx en las dos entradas manuales
// ---------------------------------------------------------------------------
test("cableado: issueMoraInvoice lee la FV for update; invoiceLiveMora y applyLateInterest corren en withTx con el ensure antes", () => {
  const ops = src("src/lib/erp/ops.ts");
  const fi = fnBody(ops, "issueMoraInvoice");
  assert.ok(fi.includes("from invoices where id = ${invoiceId} and company_id = ${companyId}\n    for update\n  `;"), "la FV se bloquea al leerla");
  assert.ok(!fi.includes("await ensureInvoiceExtras("), "ningún alter table dentro de la transacción de la FI (candado de toda la tabla en Neon): el ensure va en cada entrada, con boot, antes de withTx");
  // Las cuatro entradas que llegan a issueMoraInvoice garantizan las columnas ANTES de abrir su transacción.
  assert.ok(fnBody(src("src/lib/azagro.ts"), "registerPayment").includes("await ensureInvoiceExtras(boot);"), "cobro de Cartera");
  assert.ok(fnBody(ops, "addBankMove").includes("await ensureInvoiceExtras(boot);"), "alta ligada de Bancos");
  const live = fnBody(ops, "invoiceLiveMora");
  assert.ok(live.includes("const boot = await getSql();\n    await ensureInvoiceExtras(boot);\n    return withTx(async (sql) => {"), "alter table fuera, transacción adentro");
  assert.ok(live.includes("return issueMoraInvoice(sql, cid, data.invoiceId, { asOf: data.asOf, requireCharge: true, userId: context.userId });"));
  const late = fnBody(src("src/lib/azagro.ts"), "applyLateInterest");
  assert.ok(late.includes("const boot = await getSql();\n    await ensureInvoiceExtras(boot);\n    return withTx(async (sql) => {"));
  assert.ok(late.includes("issueMoraInvoice(sql, m.company_id, data.invoiceId, { requireCharge: true, userId: context.userId })"), "el literal que erp-permissions fija sigue igual");
  // Ninguna de las dos toma la conexión suelta para escribir.
  assert.ok(!live.includes("const sql = await getSql();") && !late.includes("const sql = await getSql();"));
});

// ---------------------------------------------------------------------------
// Contador por serie, en PGlite
// ---------------------------------------------------------------------------
test("cada serie avanza independiente y con guion: FV-0001, NC-0001, FV-0002, PAG-0001", async () => {
  const db = new PGlite();
  await applyUpTo(db);
  assert.equal(await pedirFolio(db, 1, "FV"), "FV-0001");
  assert.equal(await pedirFolio(db, 1, "NC"), "NC-0001");
  assert.equal(await pedirFolio(db, 1, "FV"), "FV-0002");
  assert.equal(await pedirFolio(db, 1, "PAG"), "PAG-0001");
  assert.equal(await pedirFolio(db, 2, "FV"), "FV-0001", "otra empresa, su propia serie");
  // La FI ya no cuenta todas las facturas: con dos FV y una NC, la primera FI es 0001.
  assert.equal(await pedirFolio(db, 1, "FI"), "FI-0001");
  await db.close();
});

test("0041: siembra cada serie desde el máximo real de los nombres; nada se renumera; idempotente; el corte queda fuera", async () => {
  const db = new PGlite();
  await applyUpTo(db, "0041");
  await db.exec(`
    insert into invoices (company_id, kind, name, partner_id, due_date, amount, residual, origin, inv_class) values
      (1, 'customer', 'FV-0001', 10, current_date, 100, 100, 'PV-0001', 'product'),
      (1, 'customer', 'FV-0007', 10, current_date, 100, 100, 'PV-0002', 'product'),
      (1, 'customer', 'NC-0002', 10, current_date, -50, 0, 'PV-0001', 'product'),
      (1, 'customer', 'FI-0010', 10, current_date, 33, 33, 'Mora FV-0001', 'interest'),
      (1, 'customer', 'ATC-0001', 10, current_date, -12, -12, 'Ajuste TC FV-0001', 'fx'),
      (1, 'supplier', 'FP-0003', 10, current_date, 800, 800, 'OC-0001', 'product'),
      (2, 'customer', 'FV-0002', 20, current_date, 100, 100, 'PV-0001', 'product');
    insert into invoices (company_id, kind, name, partner_id, due_date, amount, residual, origin, inv_class, cutover_key) values
      (1, 'customer', 'A-77', 10, current_date, 500, 500, 'Corte Compaq', 'product', 'k1'),
      (1, 'customer', 'FV-9999', 10, current_date, 500, 500, 'Corte Compaq', 'product', 'k2');
    insert into payments (company_id, kind, name, partner_id, amount, created_by) values
      (1, 'inbound', 'PAG-0004', 10, 10, 'u1'), (1, 'inbound', 'PAG-0002', 10, 10, 'u1');
  `);
  await db.exec(m41());
  const rows = (await db.query(`select company_id, series, last_number from folio_counters order by company_id, series`)).rows;
  assert.deepEqual(rows, [
    { company_id: 1, series: "ATC", last_number: 1 },
    { company_id: 1, series: "FI", last_number: 10 },
    { company_id: 1, series: "FP", last_number: 3 },
    { company_id: 1, series: "FV", last_number: 9999 }, // un folio del corte que por casualidad siga el patrón también cuenta: nunca se repite un nombre
    { company_id: 1, series: "NC", last_number: 2 },
    { company_id: 1, series: "PAG", last_number: 4 },
    { company_id: 2, series: "FV", last_number: 2 },
  ]);
  assert.equal(await pedirFolio(db, 1, "FI"), "FI-0011", "la siguiente FI sigue de su máximo, no del conteo de todas las facturas");
  assert.equal(await pedirFolio(db, 1, "PAG"), "PAG-0005");
  assert.equal(await pedirFolio(db, 2, "NC"), "NC-0001", "serie sin historia nace en 0001");
  // Segunda pasada: nada se mueve (ni siquiera los +1 recién pedidos bajan).
  await db.exec(m41());
  const otra = (await db.query(`select series, last_number from folio_counters where company_id = 1 and series in ('FI','PAG') order by series`)).rows;
  assert.deepEqual(otra, [{ series: "FI", last_number: 11 }, { series: "PAG", last_number: 5 }]);
  await db.close();
});

test("0041 sobre una base sin documentos no inserta nada", async () => {
  const db = new PGlite();
  await applyUpTo(db);
  assert.equal((await db.query(`select count(*)::int as c from folio_counters`)).rows[0].c, 0);
  await db.close();
});

test("el borrado de pruebas re-siembra las series de documentos en el mismo paso que el kardex", () => {
  const plan = src("scripts/purge-plan.mjs");
  const paso = plan.slice(plan.indexOf('name: "folios de kardex"'), plan.indexOf("set last_number = greatest(folio_counters.last_number, excluded.last_number)`", plan.indexOf('name: "folios de kardex"')));
  assert.ok(paso.includes("where company_id = $1 and name ~ '^(FV|FP|NC|FI|ATC)-[0-9]{4,}$'"), "facturas por serie");
  assert.ok(paso.includes("where company_id = $1 and name ~ '^PAG-[0-9]{4,}$'"), "pagos");
  assert.ok(src("migrations/README.md").includes("0041 = **folios de dinero por serie**"));
});

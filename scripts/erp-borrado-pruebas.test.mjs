// BLOQUE C4 — BORRADO DE DATOS DE PRUEBA, pasos 1 y 2 (15-sep-2026):
// migración 0034 + scripts/purge-plan.mjs (BORRADO-PRUEBAS.md).
//
// La única excepción al "no se borra" del sistema (Decisiones 15 y 16), y
// por eso la prueba más desconfiada: siembra el grafo completo en DOS
// empresas — catálogos, corte (FV/FP con cutover_key, INI 'Corte Compaq'),
// y capturados de todo tipo con reversas, NC/FI/ATC, gasto en efectivo (el
// ciclo bank_moves ↔ expenses), doc_files de los dos tipos, 'Saldo inicial',
// RFQ con vendor_rfq_targets (tabla que solo nace en runtime) — corre el plan
// sobre una y comprueba que sobrevive exactamente el corte y los catálogos,
// que la otra empresa no se movió, que las proyecciones cuadran con lo que
// sobrevive, que es idempotente, y que el caso negativo no deja nada a medias.
// Ninguna prueba existente cambia; base 588.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pendingMigrations } from "./migration-plan.mjs";
import { GUARD, KEEP, LIVE, LIVE_HARMLESS_ACTIONS, PREVIEW, PURGE, REBUILD, clearLive, keepTables, liveBlockers, previewCounts, purgeGuard, purgeState, purgeTables, runPurge, setLive } from "./purge-plan.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "migrations");
const src = (p) => readFileSync(join(root, p), "utf8");
const M34 = "0034_datos_de_prueba.sql";

async function applyAll(db) {
  for (const { name, path } of pendingMigrations(readdirSync(dir), [])) {
    try {
      await db.exec(readFileSync(join(dir, path), "utf8"));
    } catch (e) {
      assert.fail(`${name}: ${e?.message ?? e}`);
    }
  }
}

/** Base como la de producción: migraciones + la tabla que hoy solo nace en runtime. */
async function fresh() {
  const db = new PGlite();
  await applyAll(db);
  const req = src("src/lib/erp/requests.ts");
  const targets = req.match(/create table if not exists vendor_rfq_targets \([\s\S]*?\n\s*\)/);
  assert.ok(targets, "vendor_rfq_targets nace en requests.ts");
  await db.exec(targets[0]);
  return db;
}

const q = (db) => (t, p = []) => db.query(t, p).then((r) => r.rows);
const inTx = (db, cid) => db.transaction(async (tx) => runPurge((t, p) => tx.query(t, p).then((r) => r.rows), cid));

/** El grafo completo de una empresa. Ids = cid*10+n (catálogos), cid*100+n (documentos). */
async function seed(db, cid, userId) {
  const r = q(db);
  const P = cid * 10 + 1, PV = cid * 10 + 2, PR1 = cid * 10 + 1, PR2 = cid * 10 + 2, L = cid * 10 + 1, B = cid * 10 + 1;
  const I = (n) => cid * 100 + n;
  await r(`insert into companies (id, name, join_code, created_by) values ($1, $2, $3, 'u')`, [cid, `Empresa ${cid}`, `J${cid}`]);
  await r(`insert into company_settings (company_id) values ($1)`, [cid]);
  await r(`insert into members (company_id, user_id, role, status) values ($1, $2, 'admin', 'active')`, [cid, userId]);
  await r(`insert into partners (id, company_id, code, name, payment_days) values (${P}, $1, 'CL1', 'Cliente', 30), (${PV}, $1, 'PV1', 'Proveedor', 30)`, [cid]);
  await r(`insert into products (id, company_id, code, name, cost, ref_cost) values (${PR1}, $1, 'P1', 'Con corte', 99, 7.5), (${PR2}, $1, 'P2', 'Solo prueba', 55, 8.25)`, [cid]);
  await r(`insert into locations (id, company_id, code, name, loc_type) values (${L}, $1, 'BOD', 'Bodega', 'internal')`, [cid]);
  await r(`insert into banks (id, company_id, name, opening) values (${B}, $1, 'Banco', 1000)`, [cid]);
  await r(`insert into expense_categories (id, company_id, code, name) values (${cid * 10 + 1}, $1, 'FL', 'Flete')`, [cid]);
  // Corte: FV con abonos, mora, FEGA, ajuste TC y paid_date escritos por pruebas posteriores; FP limpia.
  await r(
    `insert into invoices (id, company_id, kind, name, partner_id, due_date, amount, residual, origin, cutover_key, opening_paid, folio_fiscal, uuid_fiscal, interest_invoiced, fega_charged, paid_date, state, fx_result, fx_treatment, fx_invoiced, fx_paid, sat_cancelled_at) values
     (${I(1)}, $1, 'customer', 'F-100', ${P}, current_date, 1000, 300, 'Corte Compaq', 'customer:CL1:F-100', 400, 'FF-1', 'UUID-1', 12.34, true, current_date, 'paid', 5, 'utilidad', 2, 18.5, current_date),
     (${I(2)}, $1, 'supplier', 'A-7', ${PV}, current_date, 500, 500, 'Corte Compaq', 'supplier:PV1:A-7', 0, '', '', 0, false, null, 'open', 0, '', 0, null, null)`,
    [cid],
  );
  await r(`insert into invoice_lines (invoice_id, product_id, qty, unit_price) values (${I(1)}, ${PR1}, 1, 1000)`);
  await r(
    `insert into stock_moves (id, company_id, ref, move_type, origin, location_to, product_id, quantity, unit_cost, created_by) values
     (${I(1)}, $1, 'INI/0001', 'opening', 'Corte Compaq', ${L}, ${PR1}, 10, 20, 'u'),
     (${I(2)}, $1, 'INI/0002', 'opening', 'Saldo inicial', ${L}, ${PR2}, 3, 9, 'u'),
     (${I(3)}, $1, 'REC/0001', 'receipt', 'OC-0001', ${L}, ${PR1}, 5, 30, 'u'),
     (${I(4)}, $1, 'REC/0002', 'receipt', 'OC-0002', ${L}, ${PR2}, 4, 50, 'u')`,
    [cid],
  );
  await r(`insert into stock_moves (id, company_id, ref, move_type, origin, location_from, product_id, quantity, unit_cost, created_by) values (${I(5)}, $1, 'ENT/0001', 'delivery', 'PV-0001', ${L}, ${PR1}, 2, 23.33, 'u')`, [cid]);
  await r(`insert into stock_moves (id, company_id, ref, move_type, origin, location_to, product_id, quantity, unit_cost, created_by, reverses_id) values (${I(6)}, $1, 'REV/0001', 'reversal', 'PV-0001', ${L}, ${PR1}, 2, 23.33, 'u', ${I(5)})`, [cid]);
  await r(`insert into stock_quants (company_id, product_id, location_id, quantity, avg_cost) values ($1, ${PR1}, ${L}, 15, 23.33), ($1, ${PR2}, ${L}, 7, 40)`, [cid]);
  await r(`insert into folio_counters (company_id, series, last_number) values ($1, 'INI', 2), ($1, 'REC', 2), ($1, 'ENT', 1), ($1, 'REV', 1)`, [cid]);
  await r(`insert into customer_requests (id, company_id, name, partner_id) values (${I(1)}, $1, 'SOL-0001', ${P})`, [cid]);
  await r(`insert into customer_request_lines (request_id, product_id, qty) values (${I(1)}, ${PR1}, 1)`);
  await r(`insert into quotes (id, company_id, name, partner_id) values (${I(1)}, $1, 'COT-0001', ${P})`, [cid]);
  await r(`insert into quote_lines (quote_id, product_id, qty, unit_price) values (${I(1)}, ${PR1}, 1, 10)`);
  await r(`insert into vendor_rfqs (id, company_id, name, quote_id) values (${I(1)}, $1, 'SC-0001', ${I(1)})`, [cid]);
  await r(`insert into vendor_rfq_suppliers (rfq_id, partner_id) values (${I(1)}, ${PV})`);
  await r(`insert into vendor_rfq_lines (rfq_id, product_id, qty) values (${I(1)}, ${PR1}, 1)`);
  await r(`insert into vendor_rfq_bids (rfq_id, partner_id, product_id) values (${I(1)}, ${PV}, ${PR1})`);
  await r(`insert into vendor_rfq_targets (rfq_id, product_id, partner_id) values (${I(1)}, ${PR1}, ${PV})`);
  await r(`insert into sales_orders (id, company_id, name, partner_id, location_id) values (${I(1)}, $1, 'PV-0001', ${P}, ${L})`, [cid]);
  await r(`insert into sales_lines (so_id, product_id, qty, unit_price) values (${I(1)}, ${PR1}, 2, 40)`);
  await r(`insert into purchase_orders (id, company_id, name, partner_id, location_id) values (${I(1)}, $1, 'OC-0001', ${PV}, ${L})`, [cid]);
  await r(`insert into purchase_lines (po_id, product_id, qty, unit_price) values (${I(1)}, ${PR1}, 5, 30)`);
  await r(`insert into customer_pos (id, company_id, partner_id, name, so_id) values (${I(1)}, $1, ${P}, 'OCC-1', ${I(1)})`, [cid]);
  await r(`insert into customer_po_lines (cpo_id, product_id, qty) values (${I(1)}, ${PR1}, 2)`);
  // FV, FP, NC (reversa de la FV, ligada), FI de mora.
  await r(
    `insert into invoices (id, company_id, kind, name, partner_id, due_date, amount, residual, order_id) values
     (${I(3)}, $1, 'customer', 'FV-0001', ${P}, current_date, 80, 80, ${I(1)}),
     (${I(4)}, $1, 'supplier', 'FP-0001', ${PV}, current_date, 150, 150, null),
     (${I(5)}, $1, 'customer', 'NC-0001', ${P}, current_date, -80, 0, ${I(1)}),
     (${I(6)}, $1, 'customer', 'FI-0001', ${P}, current_date, 3, 3, ${I(1)})`,
    [cid],
  );
  await r(`update invoices set reverses_id = ${I(3)}, state = 'reversed' where id = ${I(5)}`);
  await r(`insert into invoice_lines (invoice_id, product_id, qty, unit_price) values (${I(3)}, ${PR1}, 2, 40)`);
  // Cobro a la FV del corte + su reversa (PAG negativo ligado) + pronto pago; banco ligado, con reversa.
  await r(`insert into payments (id, company_id, kind, name, partner_id, amount, created_by) values (${I(1)}, $1, 'in', 'PAG-0001', ${P}, 700, 'u'), (${I(2)}, $1, 'in', 'PAG-0002', ${P}, -700, 'u'), (${I(3)}, $1, 'in', 'PAG-0003', ${P}, 1, 'u')`, [cid]);
  await r(`update payments set reverses_id = ${I(1)} where id = ${I(2)}`);
  await r(`insert into payment_allocs (payment_id, invoice_id, amount) values (${I(1)}, ${I(1)}, 700), (${I(2)}, ${I(1)}, -700), (${I(3)}, ${I(3)}, 1)`);
  await r(`insert into bank_moves (id, company_id, bank_id, amount, payment_id, invoice_id) values (${I(1)}, $1, ${B}, 700, ${I(1)}, ${I(1)}), (${I(2)}, $1, ${B}, -700, ${I(2)}, ${I(1)})`, [cid]);
  await r(`update bank_moves set reverses_id = ${I(1)} where id = ${I(2)}`);
  // Gasto en efectivo: el ciclo bank_moves.expense_id ↔ expenses.bank_move_id.
  await r(`insert into expenses (id, company_id, name, amount, category_id, po_id, bank_id) values (${I(1)}, $1, 'GAS-0001', 50, ${cid * 10 + 1}, ${I(1)}, ${B})`, [cid]);
  await r(`insert into bank_moves (id, company_id, bank_id, amount, expense_id, po_id) values (${I(3)}, $1, ${B}, -50, ${I(1)}, ${I(1)})`, [cid]);
  await r(`update expenses set bank_move_id = ${I(3)} where id = ${I(1)}`);
  await r(`insert into documents (company_id, kind, title) values ($1, 'quote', 'Doc')`, [cid]);
  await r(`insert into doc_files (company_id, kind, filename, content) values ($1, 'sale', 'a.pdf', 'x'), ($1, 'cutover', 'saldos.csv', 'y')`, [cid]);
  await r(`insert into notifications (company_id, title) values ($1, 'aviso')`, [cid]);
  await r(`insert into audit_log (company_id, action, entity) values ($1, 'entregar', 'sale'), ($1, 'cobrar', 'invoice')`, [cid]);
}

const ALL_TABLES = () => [...purgeTables(), ...keepTables()].filter((t) => t !== "_migrations").sort();

/** Las hijas sin company_id se cuentan por su padre; auth (sin empresa) entera. */
const CHILD = {
  payment_allocs: ["payments", "payment_id"],
  invoice_lines: ["invoices", "invoice_id"],
  customer_po_lines: ["customer_pos", "cpo_id"],
  purchase_lines: ["purchase_orders", "po_id"],
  sales_lines: ["sales_orders", "so_id"],
  vendor_rfq_suppliers: ["vendor_rfqs", "rfq_id"],
  vendor_rfq_lines: ["vendor_rfqs", "rfq_id"],
  vendor_rfq_bids: ["vendor_rfqs", "rfq_id"],
  vendor_rfq_targets: ["vendor_rfqs", "rfq_id"],
  quote_lines: ["quotes", "quote_id"],
  customer_request_lines: ["customer_requests", "request_id"],
  member_acl: ["members", "member_id"],
  member_favorites: ["members", "member_id"],
};

/** Conteo por tabla y por empresa. */
async function counts(db, cid) {
  const r = q(db);
  const out = {};
  for (const t of ALL_TABLES()) {
    const cols = (await r(`select column_name from information_schema.columns where table_name = $1`, [t])).map((c) => c.column_name);
    const name = t === "user" ? '"user"' : t;
    if (cols.includes("company_id")) out[t] = (await r(`select count(*)::int as n from ${name} where company_id = $1`, [cid]))[0].n;
    else if (CHILD[t]) out[t] = (await r(`select count(*)::int as n from ${t} x join ${CHILD[t][0]} p on p.id = x.${CHILD[t][1]} where p.company_id = $1`, [cid]))[0].n;
    else out[t] = (await r(`select count(*)::int as n from ${name}`))[0].n;
  }
  return out;
}

async function snapshot(db, cid) {
  const r = q(db);
  return {
    counts: await counts(db, cid),
    quants: await r(`select product_id, location_id, quantity::text, avg_cost::text from stock_quants where company_id = $1 order by 1, 2`, [cid]),
    products: await r(`select id, cost::text, ref_cost::text from products where company_id = $1 order by 1`, [cid]),
    invoices: await r(`select id, state, residual::text, interest_invoiced::text, fega_charged, paid_date::text, fx_result::text, folio_fiscal from invoices where company_id = $1 order by 1`, [cid]),
    folios: await r(`select series, last_number from folio_counters where company_id = $1 order by 1`, [cid]),
  };
}

// ---------------------------------------------------------------- paso 1: 0034

test("paso 1: 0034 existe, y con SOLO las migraciones las siete cosas existen como en producción", async () => {
  const files = pendingMigrations(readdirSync(dir), []);
  assert.ok(files.some((f) => f.name === M34), `${M34} está en migrations/`);
  const db = new PGlite();
  await applyAll(db);
  const col = async (table, name) =>
    (await db.query(`select data_type, numeric_precision, numeric_scale, is_nullable, column_default from information_schema.columns where table_name = $1 and column_name = $2`, [table, name])).rows[0];
  const n = await col("notifications", "payload");
  assert.equal(n?.data_type, "jsonb", "notifications.payload jsonb");
  for (const [t, c, scale] of [["invoices", "opening_paid", 2], ["invoices", "fx_result", 2], ["stock_moves", "unit_cost", 4], ["stock_quants", "avg_cost", 4]]) {
    const d = await col(t, c);
    assert.ok(d, `${t}.${c} existe`);
    assert.equal(d.data_type, "numeric", `${t}.${c} numeric`);
    assert.equal(Number(d.numeric_precision), 14, `${t}.${c} precisión 14`);
    assert.equal(Number(d.numeric_scale), scale, `${t}.${c} escala ${scale}`);
    assert.equal(d.is_nullable, "NO", `${t}.${c} NOT NULL`);
    assert.match(String(d.column_default), /^'?0'?(::numeric)?$/, `${t}.${c} default 0`);
  }
  const fx = await col("invoices", "fx_treatment");
  assert.equal(fx?.data_type, "text");
  assert.equal(fx?.is_nullable, "NO");
  assert.match(String(fx?.column_default), /^''(::text)?$/, "fx_treatment default ''");
  const live = await col("company_settings", "live_since");
  assert.equal(live?.data_type, "timestamp with time zone", "live_since timestamptz");
  assert.equal(live?.is_nullable, "YES", "live_since nula permitida: nula = en pruebas");
  assert.equal(live?.column_default, null, "live_since sin default: nadie arranca la operación real por omisión");
  // 0034 corre dos veces sin tronar (sobre producción todo ya existía por el alter de runtime).
  await db.exec(readFileSync(join(dir, M34), "utf8"));
  await db.exec(readFileSync(join(dir, M34), "utf8"));
  await db.close();
});

test("paso 1: 0034 copia las definiciones letra por letra de donde nacen en runtime, y nada más", () => {
  const m = readFileSync(join(dir, M34), "utf8");
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const ddl = (s) => norm(s.match(/create table if not exists notifications \([\s\S]*?\n\s*\)/)[0]);
  assert.equal(ddl(m), ddl(src("src/lib/erp/alerts.ts")), "notifications: byte-idéntica a ensureAlerts");
  const alters = [
    ["src/lib/erp/cutover.ts", "alter table invoices add column if not exists opening_paid numeric(14,2) not null default 0"],
    ["src/lib/azagro.ts", "alter table invoices add column if not exists fx_result numeric(14,2) not null default 0"],
    ["src/lib/azagro.ts", "alter table invoices add column if not exists fx_treatment text not null default ''"],
    ["src/lib/erp/stock.ts", "alter table stock_moves add column if not exists unit_cost numeric(14,4) not null default 0"],
    ["src/lib/erp/stock.ts", "alter table stock_quants add column if not exists avg_cost numeric(14,4) not null default 0"],
  ];
  for (const [file, stmt] of alters) {
    assert.ok(m.includes(`${stmt};`), `0034 trae: ${stmt}`);
    assert.ok(src(file).includes(stmt), `${file} lo tiene igual`);
  }
  assert.ok(m.includes("alter table company_settings add column if not exists live_since timestamptz;"), "live_since");
  const statements = m.split("\n").filter((l) => /^(create table|alter table)/.test(l));
  assert.equal(statements.length, 7, `exactamente siete sentencias (hay ${statements.length}): solo lo que el borrado nombra + live_since`);
});

// ---------------------------------------------------------------- forma del plan

test("forma del plan: cada sentencia va acotada a la empresa, el candado bloquea la fila, y el orden es el de § 2", () => {
  for (const s of PURGE) assert.ok(s.sql.includes("where company_id = $1"), `paso ${s.step} ${s.table}: where company_id = $1`);
  for (const r of REBUILD) assert.ok(r.sql.includes("$1"), `rebuild ${r.name}: acotado a $1`);
  assert.ok(GUARD.company.endsWith("for update") && GUARD.settings.endsWith("for update"), "for update en companies y company_settings");
  assert.deepEqual(
    PURGE.map((s) => s.table),
    // `trip_costs` (Decisión 100) va junto a los gastos y ANTES de
    // `purchase_orders`, de la que cuelga: el orden lo borra explícitamente en
    // vez de dejarlo a la cascada, para que el conteo lo reporte.
    ["expenses", "bank_moves", "expenses", "trip_costs", "payments", "invoices", "customer_pos", "purchase_orders", "sales_orders", "vendor_rfqs", "quotes", "customer_requests", "stock_moves", "stock_quants", "documents", "doc_files", "notifications", "folio_counters"],
  );
  assert.equal(PURGE[0].kind, "update", "el primer paso rompe el ciclo, no borra");
  assert.ok(PURGE.find((s) => s.table === "invoices").sql.includes("cutover_key is null"), "el corte sobrevive");
  assert.ok(PURGE.find((s) => s.table === "doc_files").sql.includes("kind <> 'cutover'"), "los CSV del corte sobreviven");
  assert.ok(PURGE.find((s) => s.table === "stock_moves").sql.includes("not (move_type = 'opening' and origin = 'Corte Compaq')"), "las existencias del corte sobreviven");
  assert.ok(REBUILD.find((r) => r.name === "existencias").sql.includes("OJO, quien modifique esto"), "el límite del promedio ponderado está escrito en el SQL mismo");
  assert.ok(!REBUILD.some((r) => r.sql.includes("ref_cost")), "ref_cost no se toca (Decisión 56)");
  assert.ok(KEEP.some((k) => k.table === "audit_log"), "la bitácora se conserva (Decisión 55)");
  assert.ok(KEEP.some((k) => k.table === "products"), "products se conserva (solo su cost se recalcula)");
});

// ---------------------------------------------------------------- candado

test("candado: empresa inexistente, id inválido y live_since fijado se niegan ANTES de borrar nada; el mensaje nombra la salida", async () => {
  const db = await fresh();
  await seed(db, 1, "u1");
  const before = await snapshot(db, 1);
  await assert.rejects(() => inTx(db, 999), /No existe la empresa 999/);
  await assert.rejects(() => inTx(db, "1"), /Empresa inválida/);
  await assert.rejects(() => inTx(db, 0), /Empresa inválida/);
  await db.query(`update company_settings set live_since = '2026-09-20T12:00:00Z' where company_id = 1`);
  await assert.rejects(() => inTx(db, 1), (e) => {
    assert.match(e.message, /«Empresa 1» arrancó la operación real el 2026-09-20/, "nombra la empresa y la fecha");
    assert.match(e.message, /«Regresar a pruebas»/, "nombra la salida (B3)");
    return true;
  });
  assert.deepEqual(await snapshot(db, 1), before, "nada se borró en ningún intento rechazado");
  // La salida: live_since de vuelta a nulo → el borrado vuelve a pasar.
  await db.query(`update company_settings set live_since = null where company_id = 1`);
  const g = await purgeGuard(q(db), 1);
  assert.deepEqual(g, { id: 1, name: "Empresa 1", liveSince: null }, "devuelve el nombre para que el paso 4 lo exija tecleado");
  const res = await inTx(db, 1);
  assert.equal(res.company.name, "Empresa 1");
  await db.close();
});

test("candado: una empresa sin renglón de Ajustes está 'en pruebas' (no se bloquea por ausencia)", async () => {
  const db = await fresh();
  await db.query(`insert into companies (id, name, join_code, created_by) values (7, 'Sin ajustes', 'J7', 'u')`);
  const g = await purgeGuard(q(db), 7);
  assert.equal(g.liveSince, null);
  await db.close();
});

// ---------------------------------------------------------------- la central

test("central: sobrevive exactamente el corte y los catálogos; la otra empresa no se mueve; proyecciones cuadran; folios = semilla 0033", async () => {
  const db = await fresh();
  const r = q(db);
  await seed(db, 1, "u1");
  await seed(db, 2, "u2");
  const c2Before = await snapshot(db, 2);
  const keepBefore = Object.fromEntries(Object.entries((await counts(db, 1))).filter(([t]) => keepTables().includes(t)));

  const res = await inTx(db, 1);

  // Lo borrado, paso por paso (el conteo que va a bitácora).
  const by = Object.fromEntries(res.deleted.map((d) => [`${d.table}${d.kind === "update" ? ":update" : ""}`, d.count]));
  assert.deepEqual(by, {
    "expenses:update": 1, bank_moves: 3, expenses: 1, trip_costs: 0, payments: 3, invoices: 4, customer_pos: 1, purchase_orders: 1, sales_orders: 1,
    vendor_rfqs: 1, quotes: 1, customer_requests: 1, stock_moves: 5, stock_quants: 2, documents: 1, doc_files: 1, notifications: 1, folio_counters: 4,
  });
  assert.deepEqual(Object.fromEntries(res.rebuilt.map((x) => [x.name, x.count])), { existencias: 1, "costo de productos": 2, "cartera del corte": 2, "folios de kardex": 1 });

  // Sobrevivientes en la empresa 1.
  const after = await counts(db, 1);
  const alive = Object.fromEntries(Object.entries(after).filter(([t]) => purgeTables().includes(t)));
  // De la empresa 1 queda solo el corte: dos facturas y el renglón de la FV del corte, un INI, un CSV, su proyección y su folio.
  assert.deepEqual(alive, {
    expenses: 0, trip_costs: 0, bank_moves: 0, payments: 0, payment_allocs: 0, invoices: 2, invoice_lines: 1, customer_pos: 0, customer_po_lines: 0,
    purchase_orders: 0, purchase_lines: 0, sales_orders: 0, sales_lines: 0, vendor_rfqs: 0, vendor_rfq_suppliers: 0, vendor_rfq_lines: 0,
    vendor_rfq_bids: 0, vendor_rfq_targets: 0, quotes: 0, quote_lines: 0, customer_requests: 0, customer_request_lines: 0,
    stock_moves: 1, stock_quants: 1, documents: 0, doc_files: 1, notifications: 0, folio_counters: 1,
  });
  assert.deepEqual(await r(`select ref, move_type, origin from stock_moves where company_id = 1`), [{ ref: "INI/0001", move_type: "opening", origin: "Corte Compaq" }], "solo el INI del corte; 'Saldo inicial' se fue");
  assert.deepEqual(await r(`select kind from doc_files where company_id = 1`), [{ kind: "cutover" }]);
  assert.deepEqual(await r(`select name, cutover_key is not null as corte from invoices where company_id = 1 order by id`), [{ name: "F-100", corte: true }, { name: "A-7", corte: true }]);
  for (const [t, n] of Object.entries(keepBefore)) assert.equal(after[t], n, `${t} se conserva entero`);
  assert.equal((await r(`select count(*)::int as n from audit_log where company_id = 1`))[0].n, 2, "bitácora completa (Decisión 55)");

  // Existencias = Σ movimientos que sobreviven; promedio = el unit_cost del movimiento (solo entradas).
  assert.deepEqual(await r(`select product_id, location_id, quantity::text, avg_cost::text from stock_quants where company_id = 1`), [{ product_id: 11, location_id: 11, quantity: "10.000", avg_cost: "20.0000" }]);
  // Costo: el del corte donde hay existencia; 0 donde solo hubo prueba; ref_cost intacto (Decisión 56).
  assert.deepEqual(await r(`select id, cost::text, ref_cost::text from products where company_id = 1 order by 1`), [
    { id: 11, cost: "20.0000", ref_cost: "7.5000" },
    { id: 12, cost: "0.0000", ref_cost: "8.2500" },
  ]);
  // Cartera del corte: estado de importación; folio fiscal y UUID se quedan.
  assert.deepEqual(
    await r(`select name, state, residual::text, interest_invoiced::text as ii, fega_charged as fg, paid_date as pd, fx_result::text as fxr, fx_treatment as fxt, fx_invoiced::text as fxi, fx_paid, sat_cancelled_at as sat, folio_fiscal as ff, uuid_fiscal as uu from invoices where company_id = 1 order by id`),
    [
      { name: "F-100", state: "open", residual: "600.00", ii: "0.00", fg: false, pd: null, fxr: "0.00", fxt: "", fxi: "0.00", fx_paid: null, sat: null, ff: "FF-1", uu: "UUID-1" },
      { name: "A-7", state: "open", residual: "500.00", ii: "0.00", fg: false, pd: null, fxr: "0.00", fxt: "", fxi: "0.00", fx_paid: null, sat: null, ff: "", uu: "" },
    ],
  );
  // Folios: exactamente lo que la semilla de 0033 produce sobre lo que sobrevive.
  const mine = await r(`select series, last_number from folio_counters where company_id = 1 order by 1`);
  assert.deepEqual(mine, [{ series: "INI", last_number: 1 }]);
  const seed33 = readFileSync(join(dir, "0033_folio_counters.sql"), "utf8").match(/insert into folio_counters[\s\S]*?;/)[0];
  await r(`delete from folio_counters where company_id = 1`);
  await db.exec(seed33);
  assert.deepEqual(await r(`select series, last_number from folio_counters where company_id = 1 order by 1`), mine, "misma consulta que 0033");

  // La empresa 2, intacta en todo.
  assert.deepEqual(await snapshot(db, 2), c2Before, "la otra empresa no cambió en ninguna tabla");
  await db.close();
});

test("central: idempotente — la segunda corrida borra 0 documentos y deja las dos proyecciones idénticas", async () => {
  const db = await fresh();
  await seed(db, 1, "u1");
  await inTx(db, 1);
  const first = await snapshot(db, 1);
  const res = await inTx(db, 1);
  for (const d of res.deleted) {
    const projection = d.table === "stock_quants" || d.table === "folio_counters";
    assert.equal(d.count, projection ? 1 : 0, `${d.table}: ${projection ? "proyección que se borra y se vuelve a sembrar igual" : "0 filas"}`);
  }
  assert.deepEqual(await snapshot(db, 1), first, "estado idéntico tras la segunda corrida");
  await db.close();
});

test("central (negativo): una factura del corte ligada por reverses_id a una borrada detiene el borrado entero y no deja nada a medias", async () => {
  const db = await fresh();
  await seed(db, 1, "u1");
  await db.query(`update invoices set reverses_id = 103 where id = 101`);
  const before = await snapshot(db, 1);
  await assert.rejects(() => inTx(db, 1), /invoices_reverses_id_fkey/);
  assert.deepEqual(await snapshot(db, 1), before, "todo o nada");
  await db.close();
});

// ---------------------------------------------------------------- paso 4: lo que el servidor le pide al plan

test("paso 4: el preview cuenta con la MISMA sentencia de cada paso — conteo antes = borrado después; costo de productos igual", async () => {
  const db = await fresh();
  await seed(db, 1, "u1");
  await seed(db, 2, "u2");
  const before = await previewCounts(q(db), 1);
  const cost = (await q(db)(PREVIEW.productCost, [1]))[0].n;
  const res = await inTx(db, 1);
  assert.deepEqual(before, res.deleted, "el preview es exactamente lo que después se borra, paso por paso");
  assert.equal(cost, res.rebuilt.find((x) => x.name === "costo de productos").count, "cuántos productos cambian de costo");
  // Sobre lo que quedó, el preview dice 0 documentos (y solo las dos proyecciones).
  const again = await previewCounts(q(db), 1);
  for (const d of again) assert.equal(d.count, d.table === "stock_quants" || d.table === "folio_counters" ? 1 : 0, `${d.table} después: nada que borrar`);
  assert.equal((await q(db)(PREVIEW.productCost, [1]))[0].n, 0, "ningún producto cambiaría de costo otra vez");
  await db.close();
});

test("paso 4: el nombre tecleado se exige ANTES de la primera sentencia; con el nombre exacto (recortado) pasa", async () => {
  const db = await fresh();
  await seed(db, 1, "u1");
  const before = await snapshot(db, 1);
  const run = (t, p) => db.query(t, p).then((r) => r.rows);
  await assert.rejects(() => db.transaction((tx) => runPurge((t, p) => tx.query(t, p).then((r) => r.rows), 1, { expectName: "Empresa 2" })), /no coincide con «Empresa 1»/);
  await assert.rejects(() => db.transaction((tx) => runPurge((t, p) => tx.query(t, p).then((r) => r.rows), 1, { expectName: "" })), /no coincide/);
  assert.deepEqual(await snapshot(db, 1), before, "nada se borró con el nombre equivocado");
  const res = await db.transaction((tx) => runPurge((t, p) => tx.query(t, p).then((r) => r.rows), 1, { expectName: "  Empresa 1  " }));
  assert.equal(res.company.name, "Empresa 1");
  assert.ok(res.deleted.some((d) => d.count > 0), "con el nombre exacto sí borró");
  void run;
  await db.close();
});

test("paso 4: purgeState lee sin bloquear y NO truena con live_since fijado (es lo que el preview enseña como bloqueo)", async () => {
  const db = await fresh();
  await seed(db, 1, "u1");
  assert.deepEqual(await purgeState(q(db), 1), { id: 1, name: "Empresa 1", liveSince: null });
  await db.query(`update company_settings set live_since = '2026-09-20T12:00:00Z' where company_id = 1`);
  const s = await purgeState(q(db), 1);
  assert.equal(s.name, "Empresa 1");
  assert.ok(s.liveSince, "devuelve la fecha para que el preview la enseñe");
  await assert.rejects(() => purgeState(q(db), 999), /No existe la empresa 999/);
  assert.ok(!LIVE.read.includes("for update"), "la lectura del preview no bloquea");
  await db.close();
});

test("paso 4: «Arrancó la operación real» fija live_since una sola vez, crea el renglón de Ajustes si falta, y desde entonces el borrado se niega", async () => {
  const db = await fresh();
  await seed(db, 1, "u1");
  await db.query(`insert into companies (id, name, join_code, created_by) values (7, 'Sin ajustes', 'J7', 'u')`);
  await assert.rejects(() => setLive(q(db), 1, { expectName: "Otra" }), /no coincide con «Empresa 1»/);
  const a = await setLive(q(db), 1, { expectName: "Empresa 1" });
  assert.ok(a.liveSince instanceof Date, "devuelve cuándo");
  await assert.rejects(() => setLive(q(db), 1, { expectName: "Empresa 1" }), /ya arrancó la operación real/);
  const b = await setLive(q(db), 7, { expectName: "Sin ajustes" });
  assert.ok(b.liveSince instanceof Date);
  assert.equal((await q(db)(`select count(*)::int as n from company_settings where company_id = 7`))[0].n, 1, "el renglón de Ajustes nace con la marca");
  await assert.rejects(() => inTx(db, 1), /arrancó la operación real/);
  assert.ok(LIVE.set.includes("live_since is null"), "la sentencia misma no pisa una marca ya puesta");
  await db.close();
});

test("paso 4: «Regresar a pruebas» — se niega si hay documentos fechados DESPUÉS o bitácora POSTERIOR (con la salida nombrada); sin nada, quita la marca", async () => {
  const db = await fresh();
  const r = q(db);
  await seed(db, 1, "u1");
  await assert.rejects(() => clearLive(r, 1, { expectName: "Empresa 1" }), /no está marcada/);
  await setLive(r, 1, { expectName: "Empresa 1" });
  // Lo sembrado es de hoy (no después) y la bitácora es anterior a la marca: no hay bloqueo.
  assert.deepEqual(await liveBlockers(r, 1, (await purgeState(r, 1)).liveSince), []);
  await assert.rejects(() => clearLive(r, 1, { expectName: "Empresa 2" }), /no coincide/);
  const cleared = await clearLive(r, 1, { expectName: "Empresa 1" });
  assert.equal(cleared.name, "Empresa 1");
  assert.equal((await purgeState(r, 1)).liveSince, null, "marca quitada");

  // Un pedido fechado un día después de la marca: bloquea y nombra la salida.
  await setLive(r, 1, { expectName: "Empresa 1" });
  await r(`insert into sales_orders (id, company_id, name, partner_id, location_id, date) values (199, 1, 'PV-0099', 11, 11, current_date + 1)`);
  const bl = await liveBlockers(r, 1, (await purgeState(r, 1)).liveSince);
  assert.deepEqual(bl, [{ what: "sales_orders", count: 1 }]);
  await assert.rejects(() => clearLive(r, 1, { expectName: "Empresa 1" }), (e) => {
    assert.match(e.message, /1 documento/, "cuenta");
    assert.match(e.message, /Cancela o revierte/, "nombra la salida: el bloque de deshacer");
    assert.match(e.message, /si son reales, la operación ya arrancó y no hay regreso/);
    return true;
  });
  assert.ok((await purgeState(r, 1)).liveSince, "la marca sigue puesta");
  await r(`delete from sales_orders where id = 199`);
  // Una factura del corte fechada después NO cuenta (no es captura de la app); un INI del corte tampoco.
  await r(`update invoices set date = current_date + 5 where id = 101`);
  await r(`update stock_moves set date = current_date + 5 where id = 101`);
  assert.deepEqual(await liveBlockers(r, 1, (await purgeState(r, 1)).liveSince), []);
  // Bitácora con reloj propio: un renglón POSTERIOR que escribió un documento bloquea; uno de Ajustes (tiie) no.
  await r(`insert into audit_log (company_id, action, entity, created_at) values (1, 'tiie', 'settings', now() + interval '1 second')`);
  assert.deepEqual(await liveBlockers(r, 1, (await purgeState(r, 1)).liveSince), []);
  assert.ok(LIVE_HARMLESS_ACTIONS.includes("tiie") && LIVE_HARMLESS_ACTIONS.includes("arranque-real"), "lo que no escribe documentos está en la lista");
  await r(`insert into audit_log (company_id, action, entity, created_at) values (1, 'crear-pedido', 'sale', now() + interval '1 second')`);
  assert.deepEqual(await liveBlockers(r, 1, (await purgeState(r, 1)).liveSince), [{ what: "bitácora", count: 1 }]);
  await assert.rejects(() => clearLive(r, 1, { expectName: "Empresa 1" }), /bitácora/);
  await db.close();
});

test("paso 4: fijar/quitar la marca toman for update sobre company_settings y releen live_since adentro", () => {
  const plan = src("scripts/purge-plan.mjs");
  const body = (name) => fnBody(plan, name);
  for (const fn of ["setLive", "clearLive", "purgeGuard"]) assert.ok(body(fn).includes("GUARD.settings"), `${fn}: for update en company_settings, la misma sentencia del candado`);
  assert.ok(GUARD.settings.endsWith("for update"));
});

function fnBody(source, name) {
  const markers = [`export const ${name} `, `export async function ${name}(`, `export function ${name}(`];
  const start = markers.map((m) => source.indexOf(m)).find((i) => i !== -1);
  assert.notEqual(start, undefined, `No existe export ${name}`);
  const rest = source.slice(start);
  const next = rest.slice(10).search(/\nexport /);
  return next === -1 ? rest : rest.slice(0, next + 10);
}

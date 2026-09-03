// Las migraciones se aplican de cero, en orden, sobre un Postgres real (PGLite).
//
// Es exactamente lo que hace src/lib/db.ts al arrancar el preview local y
// scripts/migrate.mjs en cada deploy. Una migración que da por hecho una tabla
// creada solo en código (p. ej. customer_requests, que nace en ensure() de
// requests.ts) truena aquí antes de tronar en el arranque de la app.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pendingMigrations } from "./migration-plan.mjs";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

test("todas las migraciones aplican en orden sobre una base vacía", async () => {
  const db = new PGlite();
  const files = pendingMigrations(readdirSync(dir), []);
  assert.ok(files.length >= 18, `hay ${files.length} migraciones`);
  for (const { name, path } of files) {
    try {
      await db.exec(readFileSync(join(dir, path), "utf8"));
    } catch (e) {
      assert.fail(`${name}: ${e?.message ?? e}`);
    }
  }
  const cols = async (table) =>
    (await db.query(`select column_name from information_schema.columns where table_name = $1`, [table])).rows.map((r) => r.column_name);
  // 0017 — dos precios por partida.
  for (const c of ["margin_cash_mode", "margin_credit_mode", "finance_unit"]) assert.ok((await cols("quote_lines")).includes(c), `quote_lines.${c}`);
  for (const c of ["margin_cash_pct", "margin_credit_nominal"]) assert.ok((await cols("customer_request_lines")).includes(c), `customer_request_lines.${c}`);
  for (const c of ["credit_days", "currency", "fx_rate"]) assert.ok((await cols("customer_requests")).includes(c), `customer_requests.${c}`);
  assert.ok((await cols("quotes")).includes("accepted_offer"), "quotes.accepted_offer");
  assert.ok((await cols("sales_orders")).includes("accepted_offer"), "sales_orders.accepted_offer");
  // 0019 — sin valores por omisión de negocio.
  const cs = await cols("company_settings");
  for (const c of ["early_pay_days", "fega_commission"]) assert.ok(cs.includes(c), `company_settings.${c}`);
  assert.ok(!cs.includes("default_tiie"), "la TIIE por omisión ya no existe: siempre sale de la tabla");
  const defaults = (await db.query(
    `select column_name, column_default, is_nullable from information_schema.columns where table_name = 'company_settings' and column_name = any($1)`,
    [["credit_days", "invoice_days", "fega_rate", "fega_commission", "collection_spread", "asr_commission", "asr_spread", "early_pay_days"]],
  )).rows;
  assert.equal(defaults.length, 8);
  for (const d of defaults) {
    assert.equal(d.column_default, null, `${d.column_name} no debe traer default`);
    assert.equal(d.is_nullable, "YES", `${d.column_name} nace vacío hasta que Ajustes lo capture`);
  }
  const pd = (await db.query(`select column_default, is_nullable from information_schema.columns where table_name = 'partners' and column_name = 'payment_days'`)).rows[0];
  assert.equal(pd.column_default, null, "partners.payment_days sin default 30");
  assert.equal(pd.is_nullable, "NO", "pero sigue siendo obligatorio: quien da de alta captura el plazo");
  await db.close();
});

test("0018 copia de verdad los márgenes viejos y deja sin margen lo que nadie capturó", async () => {
  const db = new PGlite();
  const files = pendingMigrations(readdirSync(dir), []);
  const hasta17 = files.filter((f) => f.name < "0018");
  for (const { path } of hasta17) await db.exec(readFileSync(join(dir, path), "utf8"));
  // El margen único vivía en código (ensure() de requests.ts): se replica igual
  // que estaba antes de la 0018, con su `default 12`.
  await db.exec(`
    alter table customer_request_lines add column margin_mode text not null default 'pct';
    alter table customer_request_lines add column margin_pct numeric(8,4) not null default 12;
    alter table customer_request_lines add column margin_nominal numeric(14,4) not null default 0;
  `);
  await db.exec(`
    insert into companies (id, name, join_code, created_by) values (1, 'AZ', 'AZ1', 'u1');
    insert into partners (id, company_id, code, name, is_customer) values (1, 1, 'CL001', 'Cliente', true);
    insert into products (id, company_id, code, name, uom) values (1, 1, 'P1', 'Producto 1', 'TM'), (2, 1, 'P2', 'Producto 2', 'TM');
    insert into customer_requests (id, company_id, name, partner_id) values (1, 1, 'SOL-0001', 1);
    -- 1: margen que alguien puso a mano. 2: la que nadie tocó (se quedó con el 12 del default).
    insert into customer_request_lines (request_id, product_id, qty, margin_mode, margin_pct, margin_nominal) values (1, 1, 10, 'nominal', 8, 1500);
    insert into customer_request_lines (request_id, product_id, qty) values (1, 2, 5);
    insert into quotes (id, company_id, name, partner_id) values (1, 1, 'COT-0001', 1);
    -- 1: margen real capturado. 2: el 0 de siempre = no sabemos cuál fue.
    insert into quote_lines (quote_id, product_id, qty, unit_price, cost, margin_pct) values (1, 1, 10, 11500, 10000, 15);
    insert into quote_lines (quote_id, product_id, qty, unit_price, cost, margin_pct) values (1, 2, 5, 900, 800, 0);
  `);
  await db.exec(readFileSync(join(dir, "0018_margen_migrado.sql"), "utf8"));

  const req = (await db.query(`
    select product_id, margin_cash_mode, margin_cash_pct::text as cp, margin_cash_nominal::text as cn, margin_cash_source,
      margin_credit_mode, margin_credit_pct::text as kp, margin_credit_source
    from customer_request_lines order by product_id
  `)).rows;
  // La copia es literal y va a las DOS columnas, marcada como venida de la migración.
  assert.deepEqual(req[0], {
    product_id: 1, margin_cash_mode: "nominal", cp: "8.0000", cn: "1500.0000", margin_cash_source: "migracion",
    margin_credit_mode: "nominal", kp: "8.0000", margin_credit_source: "migracion",
  });
  // La que nadie tocó traía el 12 del default viejo: se copia igual, pero
  // marcada, para que se vea que nadie la eligió.
  assert.equal(req[1].cp, "12.0000");
  assert.equal(req[1].margin_cash_source, "migracion");

  const ql = (await db.query(`
    select product_id, margin_cash_pct::text as cp, margin_cash_nominal::text as cn, margin_cash_source
    from quote_lines order by product_id
  `)).rows;
  assert.deepEqual(ql[0], { product_id: 1, cp: "15.0000", cn: "1500.0000", margin_cash_source: "migracion" });
  assert.deepEqual(ql[1], { product_id: 2, cp: null, cn: null, margin_cash_source: null }, "un 0 no se copia: es 'no sabemos', no 'sin utilidad'");

  // Y de aquí en adelante una partida nueva nace sin margen.
  await db.exec(`insert into customer_request_lines (request_id, product_id, qty) values (1, 1, 3)`);
  const nueva = (await db.query(`select margin_pct, margin_mode from customer_request_lines order by id desc limit 1`)).rows[0];
  assert.deepEqual(nueva, { margin_pct: null, margin_mode: null }, "sin default: nadie ha capturado el margen");

  // 0019: el 12 que nadie eligió pasa a "sin margen"; el margen capturado se queda.
  await db.exec(readFileSync(join(dir, "0019_sin_valores_por_omision.sql"), "utf8"));
  const req19 = (await db.query(`
    select product_id, margin_cash_mode, margin_cash_pct::text as cp, margin_cash_nominal::text as cn, margin_cash_source,
      margin_credit_mode, margin_credit_pct::text as kp, margin_credit_source, margin_pct::text as viejo
    from customer_request_lines where qty <> 3 order by product_id
  `)).rows;
  assert.deepEqual(req19[0], {
    product_id: 1, margin_cash_mode: "nominal", cp: "8.0000", cn: "1500.0000", margin_cash_source: "migracion",
    margin_credit_mode: "nominal", kp: "8.0000", margin_credit_source: "migracion", viejo: "8.0000",
  }, "el margen capturado a mano no se toca");
  assert.deepEqual(req19[1], {
    product_id: 2, margin_cash_mode: null, cp: null, cn: null, margin_cash_source: null,
    margin_credit_mode: null, kp: null, margin_credit_source: null, viejo: null,
  }, "el 12 del default viejo desaparece: la partida queda sin margen en las dos columnas y en la vieja");
  // Una cotización con 15% capturado tampoco se toca.
  const ql19 = (await db.query(`select margin_cash_pct::text as cp from quote_lines where product_id = 1`)).rows[0];
  assert.equal(ql19.cp, "15.0000");
  await db.close();
});

test("0019 respeta un 12% que sí fue capturado a mano", async () => {
  const db = new PGlite();
  const files = pendingMigrations(readdirSync(dir), []);
  for (const { path } of files.filter((f) => f.name < "0019")) await db.exec(readFileSync(join(dir, path), "utf8"));
  await db.exec(`
    insert into companies (id, name, join_code, created_by) values (1, 'AZ', 'AZ1', 'u1');
    insert into partners (id, company_id, code, name, is_customer, payment_days) values (1, 1, 'CL001', 'Cliente', true, 30);
    insert into products (id, company_id, code, name, uom) values (1, 1, 'P1', 'Producto 1', 'TM'), (2, 1, 'P2', 'Producto 2', 'TM'), (3, 1, 'P3', 'Producto 3', 'TM');
    insert into customer_requests (id, company_id, name, partner_id) values (1, 1, 'SOL-0001', 1);
    -- 1: 12% capturado a mano (origen 'captura'). 2: 12% de la migración con nominal (alguien lo tocó). 3: la firma exacta del default.
    insert into customer_request_lines (request_id, product_id, qty, margin_cash_mode, margin_cash_pct, margin_cash_source)
      values (1, 1, 10, 'pct', 12, 'captura');
    insert into customer_request_lines (request_id, product_id, qty, margin_cash_mode, margin_cash_pct, margin_cash_nominal, margin_cash_source)
      values (1, 2, 10, 'pct', 12, 250, 'migracion');
    insert into customer_request_lines (request_id, product_id, qty, margin_cash_mode, margin_cash_pct, margin_cash_source)
      values (1, 3, 10, 'pct', 12, 'migracion');
  `);
  await db.exec(readFileSync(join(dir, "0019_sin_valores_por_omision.sql"), "utf8"));
  const rows = (await db.query(`select product_id, margin_cash_pct::text as cp, margin_cash_source as src from customer_request_lines order by product_id`)).rows;
  assert.deepEqual(rows, [
    { product_id: 1, cp: "12.0000", src: "captura" },
    { product_id: 2, cp: "12.0000", src: "migracion" },
    { product_id: 3, cp: null, src: null },
  ], "solo la firma exacta del default (migración, %, 12, sin nominal) se limpia");
  await db.close();
});

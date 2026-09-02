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
  assert.ok(files.length >= 17, `hay ${files.length} migraciones`);
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
  await db.close();
});

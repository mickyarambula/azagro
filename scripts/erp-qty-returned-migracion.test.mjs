// BLOQUE DE PARCIALES — PASO 0.1 (14-sep-2026): sales_lines.qty_returned como
// migración de verdad (0032), no como `alter table` en tiempo de ejecución.
//
// Antes la columna nacía dentro de returnSale (azagro.ts) y getOrder
// (orders.ts): una base recién migrada no la tenía hasta que alguien abría un
// pedido o devolvía algo. Tres cosas se fijan aquí:
//   (a) con SOLO las migraciones, sin ninguna devolución, la columna existe y
//       es exactamente la que corría en producción: numeric(14,3), NOT NULL, 0;
//   (b) sobre una base que YA la tenía (producción, donde el alter viejo ya
//       corrió), 0032 no truena y no cambia nada — y corre dos veces igual;
//   (c) el código ya no la crea al vuelo.
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

async function columnDef(db) {
  const rows = (
    await db.query(
      `select data_type, numeric_precision, numeric_scale, is_nullable, column_default
       from information_schema.columns where table_name = 'sales_lines' and column_name = 'qty_returned'`,
    )
  ).rows;
  return rows[0] ?? null;
}

function assertProdDefinition(d, label) {
  assert.ok(d, `${label}: sales_lines.qty_returned existe`);
  assert.equal(d.data_type, "numeric", `${label}: numeric`);
  assert.equal(Number(d.numeric_precision), 14, `${label}: precisión 14`);
  assert.equal(Number(d.numeric_scale), 3, `${label}: escala 3`);
  assert.equal(d.is_nullable, "NO", `${label}: NOT NULL`);
  assert.match(String(d.column_default), /^'?0'?(::numeric)?$/, `${label}: default 0 (viene ${d.column_default})`);
}

test("(a) solo con las migraciones, sin ninguna devolución, sales_lines.qty_returned existe como en producción", async () => {
  const db = new PGlite();
  const files = pendingMigrations(readdirSync(dir), []);
  assert.ok(files.some((f) => f.name === "0032_qty_returned.sql"), "la 0032 está en migrations/");
  for (const { name, path } of files) {
    try {
      await db.exec(readFileSync(join(dir, path), "utf8"));
    } catch (e) {
      assert.fail(`${name}: ${e?.message ?? e}`);
    }
  }
  assertProdDefinition(await columnDef(db), "base vacía + migraciones");
  await db.close();
});

test("(b) sobre una base que YA tenía la columna por el alter viejo, 0032 es un no-op y corre dos veces sin tronar", async () => {
  const db = new PGlite();
  const files = pendingMigrations(readdirSync(dir), []);
  for (const { path } of files.filter((f) => f.name < "0032")) await db.exec(readFileSync(join(dir, path), "utf8"));
  assert.equal(await columnDef(db), null, "hasta 0031 la columna no existe por migración");
  // Lo que hacía el código en producción antes de este paso, tal cual.
  await db.exec(`alter table sales_lines add column if not exists qty_returned numeric(14,3) not null default 0`);
  const before = await columnDef(db);
  assertProdDefinition(before, "creada por el código viejo");
  const sql = readFileSync(join(dir, "0032_qty_returned.sql"), "utf8");
  await db.exec(sql);
  await db.exec(sql);
  assert.deepEqual(await columnDef(db), before, "0032 no cambió la definición, ni la primera ni la segunda vez");
  await db.close();
});

test("(c) el código ya no crea qty_returned al vuelo: la única definición vive en 0032", () => {
  const pattern = /add column if not exists qty_returned/;
  assert.ok(!pattern.test(src("src/lib/azagro.ts")), "azagro.ts (returnSale) ya no la crea");
  assert.ok(!pattern.test(src("src/lib/erp/orders.ts")), "orders.ts (getOrder) ya no la crea");
  const mig = src("migrations/0032_qty_returned.sql");
  assert.ok(mig.includes("alter table sales_lines add column if not exists qty_returned numeric(14,3) not null default 0;"), "misma definición byte a byte");
  assert.ok(!/drop |rename |alter column/i.test(mig), "aditiva: cero drops, renames o cambios de tipo");
});

// Una empresa creada DESPUÉS de la migración 0024 nacía sin catálogo de
// circuitos (la migración solo sembró las empresas que ya existían) y no podía
// cotizar: "El circuito Circuito ASR no está en el catálogo". Encontrado el
// 18-sep-2026 verificando L4a en una base fresca. La siembra es idempotente
// (on conflict do nothing), corre al crear la empresa y al abrir un catálogo
// vacío. La comisión de apertura nace SIN capturar (null): desde la 0026 vive
// solo en el catálogo y se captura en Ajustes → Circuitos — nunca un número
// en el código.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

test("seedCircuits (circuits-seed.ts: ni circuits.ts inserta, ni azagro.ts nombra la tabla): los cuatro circuitos de la 0024, idempotentes, con la comisión de apertura sin capturar (null)", () => {
  const fn = src("src/lib/erp/circuits-seed.ts");
  assert.ok(fn.includes("export async function seedCircuits("));
  for (const row of [
    "'CONTADO', 'Contado', null, null, 'azagro', null, true, 1",
    "'ASR', 'Circuito ASR', null, 'costo_comision', 'azagro', 'santa_rosa', true, 2",
    "'SANTA_ROSA', 'Línea Santa Rosa', null, 'costo_margen', 'santa_rosa', 'santa_rosa', false, 3",
    "'PROPIA', 'Línea propia', null, null, 'azagro', 'azagro', false, 4",
  ]) {
    assert.ok(fn.includes(row), row);
  }
  assert.equal((fn.match(/on conflict \(company_id, code\) do nothing/g) ?? []).length, 4, "nunca pisa lo capturado");
  assert.ok(!/0\.0[0-9]/.test(fn), "sin números de negocio");
  assert.ok(!fn.includes("asr_commission"), "company_settings.asr_commission ya no existe (migración 0026): la comisión nace sin capturar y se captura en Ajustes → Circuitos");
  // La regla de erp-circuitos sigue: el módulo de circuitos no inserta en el catálogo.
  assert.ok(!src("src/lib/erp/circuits.ts").includes("insert into credit_circuits"));
  assert.ok(!src("src/lib/azagro.ts").includes("credit_circuits"), "azagro.ts sigue sin nombrar la tabla del catálogo");
});

test("corre dentro de seedCompany, ANTES del candado «ya sembrada»: una empresa vieja sin catálogo lo recibe al siguiente inicio", () => {
  const a = src("src/lib/azagro.ts");
  const body = a.slice(a.indexOf("export async function seedCompany("));
  const seed = body.indexOf("await seedCircuits(sql, companyId);");
  const gate = body.indexOf("if (already[0]?.seeded_at) return;");
  assert.ok(seed !== -1 && gate !== -1 && seed < gate, "la siembra va antes del return de «ya sembrada»");
  assert.ok(body.indexOf("insert into company_settings") < seed, "y después de que exista company_settings (el insert hace join con ella)");
});

// BLOQUE C4 — BORRADO DE DATOS DE PRUEBA, paso 3 (15-sep-2026): "ninguna
// tabla se olvida" (BORRADO-PRUEBAS.md § 4.8 hecho prueba).
//
// Escanea TODOS los `create table` del repo — migrations/ (con auth/) y src/ —
// y exige que cada tabla esté clasificada en scripts/purge-plan.mjs: SE BORRA
// (PURGE, o hija en cascada de una de PURGE) o SE CONSERVA (KEEP). Una tabla
// nueva sin clasificar pone `npm test` en rojo: quien la cree tiene que
// decidir, en el mismo cambio, qué le pasa al borrar los datos de prueba.
// Además comprueba contra el esquema real (PGlite) que cada hija declarada
// cae de verdad en cascada desde su padre, y que cada tabla de PURGE tiene
// company_id (el `where company_id = $1` no es adorno).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pendingMigrations } from "./migration-plan.mjs";
import { KEEP, PURGE, classify, keepTables, purgeTables } from "./purge-plan.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(d, exts, out = []) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) {
      if (e !== "node_modules" && e !== ".git") walk(p, exts, out);
    } else if (exts.some((x) => e.endsWith(x))) out.push(p);
  }
  return out;
}

const RE = /create table (?:if not exists )?"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(([\s\S]*?)\n\s*\)/gi;

/** { table -> { files: [..], hasCompanyId, ddl } } */
function scanCreateTables() {
  const found = new Map();
  const files = [...walk(join(root, "migrations"), [".sql"]), ...walk(join(root, "src"), [".ts", ".tsx"])];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(RE)) {
      const table = m[1];
      const body = m[2];
      const cur = found.get(table) ?? { files: [], hasCompanyId: false, ddl: [] };
      cur.files.push(relative(root, f));
      cur.hasCompanyId = cur.hasCompanyId || /\bcompany_id\b/.test(body);
      cur.ddl.push(m[0]);
      found.set(table, cur);
    }
  }
  return found;
}

test("ninguna tabla olvidada: cada create table del repo está en SE BORRA o SE CONSERVA", () => {
  const found = scanCreateTables();
  assert.ok(found.size >= 50, `encontró ${found.size} tablas (esperaba al menos 50)`);
  const missing = [...found.keys()].filter((t) => classify(t) === null).sort();
  assert.deepEqual(
    missing,
    [],
    `Tablas sin clasificar en scripts/purge-plan.mjs (decide en el mismo cambio qué les pasa al borrar los datos de prueba):\n` +
      missing.map((t) => `  - ${t} (${found.get(t).files.join(", ")})`).join("\n"),
  );
  // Y al revés: el plan no nombra tablas que no existen (un typo dejaría una tabla fuera sin que nadie lo note).
  const ghosts = [...purgeTables(), ...keepTables()].filter((t) => !found.has(t)).sort();
  assert.deepEqual(ghosts, [], `El plan nombra tablas que no existen en el repo: ${ghosts.join(", ")}`);
  // Ninguna en las dos listas.
  const both = purgeTables().filter((t) => keepTables().includes(t));
  assert.deepEqual(both, [], `En SE BORRA y SE CONSERVA a la vez: ${both.join(", ")}`);
});

test("las tablas sin company_id son hijas en cascada de una de PURGE, o están en KEEP", () => {
  const found = scanCreateTables();
  const children = new Set(PURGE.flatMap((s) => s.children ?? []));
  const bad = [];
  for (const [t, info] of found) {
    if (info.hasCompanyId) continue;
    if (keepTables().includes(t)) continue;
    if (children.has(t)) continue;
    bad.push(t);
  }
  assert.deepEqual(bad.sort(), [], `Sin company_id y sin padre en PURGE ni en KEEP: ${bad.join(", ")}`);
  // Y toda tabla de PURGE (padre) sí tiene company_id.
  for (const s of PURGE) assert.ok(found.get(s.table)?.hasCompanyId, `${s.table} tiene company_id`);
  for (const k of KEEP) assert.ok(k.why, `${k.table}: motivo escrito`);
});

test("contra el esquema real: cada hija declarada cae en cascada desde su padre", async () => {
  const db = new PGlite();
  const dir = join(root, "migrations");
  for (const { name, path } of pendingMigrations(readdirSync(dir), [])) {
    try {
      await db.exec(readFileSync(join(dir, path), "utf8"));
    } catch (e) {
      assert.fail(`${name}: ${e?.message ?? e}`);
    }
  }
  // Las que solo nacen en runtime, con su DDL real (todas son `if not exists`).
  const found = scanCreateTables();
  const existing = new Set((await db.query(`select table_name from information_schema.tables where table_schema = 'public'`)).rows.map((r) => r.table_name));
  for (const [t, info] of found) {
    if (existing.has(t)) continue;
    if (t === "_migrations") continue; // la crea db.ts / migrate.mjs, fuera del esquema de negocio
    await db.exec(info.ddl[0]);
  }
  const fks = (await db.query(`
    select tc.table_name as child, ccu.table_name as parent, rc.delete_rule
    from information_schema.table_constraints tc
    join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name
    join information_schema.referential_constraints rc on rc.constraint_name = tc.constraint_name
    where tc.constraint_type = 'FOREIGN KEY'`)).rows;
  for (const s of PURGE) {
    for (const c of s.children ?? []) {
      const link = fks.find((f) => f.child === c && f.parent === s.table);
      assert.ok(link, `${c} tiene llave foránea a ${s.table}`);
      assert.equal(link.delete_rule, "CASCADE", `${c} → ${s.table} es on delete cascade`);
    }
  }
  await db.close();
});

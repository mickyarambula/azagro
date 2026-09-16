// BLOQUE C4 — BORRADO DE DATOS DE PRUEBA, paso 4 (15-sep-2026): el servidor
// (`src/lib/erp/purge.ts`), cableado por texto (BORRADO-PRUEBAS.md, plan § 4).
//
// Qué fija: purgePreview / purgeTestData / setLiveSince / clearLiveSince
// existen; usan el plan (`scripts/purge-plan.mjs`) y NO escriben SQL de
// borrado propia; solo administrador (los dos candados, B6); transacción;
// el nombre de la empresa tecleado y el motivo son obligatorios; el candado
// del plan (for update + releer live_since) corre adentro de la transacción;
// el intento rechazado queda en bitácora con conexión fresca; y — la regla de
// todo el repo — no existe ningún `delete from` de un documento fuera de
// `purge-plan.mjs`. Lo que la SQL hace de verdad lo prueba
// scripts/erp-borrado-pruebas.test.mjs sobre PGlite.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PURGE } from "./purge-plan.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

function fnBody(source, name) {
  const markers = [`export const ${name} `, `export async function ${name}(`, `export function ${name}(`, `async function ${name}(`, `function ${name}(`];
  const start = markers.map((m) => source.indexOf(m)).find((i) => i !== -1);
  assert.notEqual(start, undefined, `No existe export ${name}`);
  const rest = source.slice(start);
  const next = rest.slice(10).search(/\n(?:export |async function |function )/);
  return next === -1 ? rest : rest.slice(0, next + 10);
}

function walk(d, exts, out = []) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) {
      if (e !== "node_modules" && e !== ".git") walk(p, exts, out);
    } else if (exts.some((x) => e.endsWith(x))) out.push(p);
  }
  return out;
}

const PURGE_TS = "src/lib/erp/purge.ts";

test("purge.ts: toda la SQL del borrado viene del plan; aquí no hay delete ni update de la marca", () => {
  const s = src(PURGE_TS);
  assert.ok(s.includes('from "../../../scripts/purge-plan.mjs"'), "importa el plan, como db.ts importa migration-plan.mjs");
  assert.ok(!/delete from/i.test(s), "ningún delete from en purge.ts");
  assert.ok(!/live_since\s*=/.test(s), "la marca se escribe con LIVE.set / LIVE.clear del plan, no aquí");
  assert.ok(!/update company_settings/i.test(s), "sin update propio de Ajustes");
});

test("purgePreview: solo lectura — estado sin bloquear, conteos del plan, avisos, bloqueos, allowed; nunca borra", () => {
  const body = fnBody(src(PURGE_TS), "purgePreview");
  assert.ok(body.includes("purgeState("), "lee el estado con la lectura sin for update");
  assert.ok(body.includes("previewCounts("), "los conteos salen del plan (misma sentencia de cada paso)");
  assert.ok(body.includes("PREVIEW.productCost"), "cuántos productos cambian de costo (Decisión 56)");
  assert.ok(body.includes("PARTNER_CATALOG") && body.includes("PRODUCT_CATALOG"), "avisa socios/productos fuera del catálogo Compaq (§ 1)");
  assert.ok(body.includes("liveSinceMessage("), "el bloqueo de live_since usa el mismo mensaje del plan (nombra la salida)");
  assert.ok(body.includes("KEEP"), "enseña qué se conserva");
  assert.ok(body.includes("allowed"), "devuelve allowed");
  assert.ok(!body.includes("runPurge(") && !body.includes("withTx("), "el preview no borra ni abre transacción");
  assert.ok(body.includes('me.role !== "admin"'), "rol distinto de admin es un bloqueo (B6)");
});

test("purgeTestData: DDL fuera → withTx → assertAdmin → runPurge con el nombre tecleado → bitácora; rechazo con conexión fresca", () => {
  const s = src(PURGE_TS);
  const body = fnBody(s, "purgeTestData");
  assert.ok(body.includes("confirmName: z.string().trim().min(1"), "nombre de la empresa obligatorio");
  assert.ok(body.includes("reason: z.string().trim().min(1"), "motivo obligatorio (A5)");
  const ddl = body.indexOf("ensureAudit(sql)");
  const tx = body.indexOf("withTx(");
  assert.ok(ddl !== -1 && tx !== -1 && ddl < tx, "el DDL de runtime (bitácora) corre ANTES de abrir la transacción");
  assert.ok(body.includes("assertAdmin(sql, context.userId)"), "solo administrador, antes de entrar");
  assert.ok(body.includes("assertAdmin(tx, context.userId)"), "y otra vez adentro de la transacción");
  assert.ok(body.includes("runPurge(") && body.includes("expectName: data.confirmName"), "el plan corre con el nombre tecleado: candado (for update, relee live_since) y nombre antes de la primera sentencia");
  assert.ok(body.includes('action: "borrado-de-pruebas"'), "bitácora del borrado, adentro de la transacción");
  assert.ok(body.includes("auditRejected("), "el intento rechazado queda escrito");
  const rej = fnBody(s, "auditRejected");
  assert.ok(rej.includes("getSql()"), "conexión fresca: sobrevive al rollback (patrón de acl.ts logDenied / cancel.ts)");
  assert.ok(rej.includes('"borrado-rechazado"'));
  assert.ok(rej.includes("catch"), "la bitácora no impide el rechazo");
});

test("setLiveSince / clearLiveSince: admin, transacción, nombre tecleado, motivo; la salida exige además la frase", () => {
  const s = src(PURGE_TS);
  const set = fnBody(s, "setLiveSince");
  assert.ok(set.includes("withTx(") && set.includes("assertAdmin(tx, context.userId)"));
  assert.ok(set.includes("setLive(") && set.includes("expectName: data.confirmName"));
  assert.ok(set.includes("reason: z.string().trim().min(1"));
  assert.ok(set.includes('action: "arranque-real"'));
  const clear = fnBody(s, "clearLiveSince");
  assert.ok(clear.includes("withTx(") && clear.includes("assertAdmin(tx, context.userId)"));
  assert.ok(clear.includes("clearLive(") && clear.includes("expectName: data.confirmName"));
  assert.ok(clear.includes("reason: z.string().trim().min(1"));
  assert.ok(clear.includes("LIVE_CLEAR_PHRASE"), "doble confirmación escrita: la frase");
  assert.ok(clear.includes('action: "arranque-real-retirado"'));
  assert.ok(clear.includes("auditRejected("), "el rechazo (documentos posteriores, frase equivocada) queda escrito");
  assert.equal(s.match(/export const LIVE_CLEAR_PHRASE = "REGRESAR A PRUEBAS"/g)?.length, 1);
});

test("en todo src/: ningún delete from de una tabla de documentos (las de PURGE) — el borrado vive solo en purge-plan.mjs", () => {
  const docs = new Set(PURGE.map((s) => s.table));
  const bad = [];
  for (const f of walk(join(root, "src"), [".ts", ".tsx"])) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/delete from\s+"?([a-z_]+)"?/gi)) {
      if (docs.has(m[1])) bad.push(`${relative(root, f)}: delete from ${m[1]}`);
    }
  }
  assert.deepEqual(bad, [], `Borrado de documentos fuera del plan:\n${bad.join("\n")}`);
});

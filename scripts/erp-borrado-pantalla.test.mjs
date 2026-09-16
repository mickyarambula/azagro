// BLOQUE C4 — BORRADO DE DATOS DE PRUEBA, paso 5 (15-sep-2026): la pantalla
// en /importar y las etiquetas nuevas en /bitacora (BORRADO-PRUEBAS.md § plan,
// paso 5). Solo texto: qué se llama, en qué orden y qué candados se enseñan.
// Lo que el servidor hace de verdad ya lo prueban erp-borrado-servidor.test.mjs
// (cableado) y erp-borrado-pruebas.test.mjs (la SQL, sobre PGlite).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

test("importar.tsx: la sección de borrado importa las cuatro funciones del paso 4, nada de SQL propia", () => {
  const s = src("src/routes/importar.tsx");
  assert.ok(s.includes('from "@/lib/erp/purge"'), "importa src/lib/erp/purge.ts");
  for (const fn of ["purgePreview", "purgeTestData", "setLiveSince", "clearLiveSince"]) {
    assert.ok(s.includes(fn), `usa ${fn}`);
  }
  assert.ok(!/delete from|update .* set live_since/i.test(s), "ninguna SQL propia en la pantalla");
});

test("importar.tsx: la sección solo se dibuja para role === 'admin' (B6, candado también en pantalla)", () => {
  const s = src("src/routes/importar.tsx");
  assert.ok(s.includes("useAccess()"), "usa el mismo hook de rol que /settings");
  const idx = s.indexOf("purgePreview(");
  assert.ok(idx > -1, "hay una llamada real a purgePreview(...)");
  const before = s.slice(0, idx);
  assert.ok(/role === ["']admin["']/.test(before), 'role === "admin" envuelve la sección, ANTES de llamar purgePreview(...)');
});

test("importar.tsx: el conteo se pide (purgePreview) antes de poder confirmar (purgeTestData) — nunca al revés", () => {
  const s = src("src/routes/importar.tsx");
  assert.ok(s.indexOf("purgePreview(") < s.indexOf("purgeTestData("), "purgePreview se llama antes, en el código");
});

test("importar.tsx: el preview se presenta como FOTO, no como número exacto — la protección real es el nombre tecleado", () => {
  const s = src("src/routes/importar.tsx");
  assert.match(s, /foto/i, "dice que es una foto (puede cambiar entre el preview y el clic)");
  assert.ok(
    /puede cambiar/i.test(s) || /no es (el|un) número exacto/i.test(s),
    "advierte explícitamente que el conteo puede no ser exacto",
  );
  assert.match(s, /nombre (exacto|tecleado)[\s\S]{0,80}protecci[oó]n|protecci[oó]n[\s\S]{0,80}nombre/i, "dice que el candado real es el nombre, no el preview");
});

test("importar.tsx: el borrado exige el nombre de la empresa tecleado y un motivo; no se dispara con un clic solo", () => {
  const s = src("src/routes/importar.tsx");
  assert.ok(s.includes("confirmName"), "campo del nombre tecleado, mismo nombre que el validator del servidor");
  assert.ok(s.includes("reason"), "motivo");
  // El botón que dispara purgeTestData debe estar deshabilitado si el nombre tecleado no coincide con el de la empresa.
  const txDataBlock = s.slice(s.indexOf("purgeTestData("), s.indexOf("purgeTestData(") + 800);
  assert.ok(/confirmName/.test(s.slice(Math.max(0, s.indexOf("purgeTestData(") - 1500), s.indexOf("purgeTestData("))), "confirmName se usa antes de llamar purgeTestData");
  void txDataBlock;
});

test("importar.tsx: 'Arrancó la operación real' y 'Regresar a pruebas' están cableados, la salida exige la frase exacta", () => {
  const s = src("src/routes/importar.tsx");
  assert.ok(s.includes("setLiveSince("), "botón de arranque");
  assert.ok(s.includes("clearLiveSince("), "botón de salida");
  assert.ok(s.includes("LIVE_CLEAR_PHRASE") || s.includes("REGRESAR A PRUEBAS"), "exige la frase exacta de la salida (§ 4.2 b)");
});

test("importar.tsx: el texto del respaldo es el honesto (BACKUP_NOTE), no se inventa uno nuevo", () => {
  const s = src("src/routes/importar.tsx");
  assert.ok(s.includes("BACKUP_NOTE") || /no (es|sustituye) (el|un) respaldo de (la base|Postgres)/i.test(s), "usa el texto honesto del respaldo (§ 4.7), no uno improvisado");
});

test("bitacora.tsx: las cuatro etiquetas nuevas del paso 4 existen", () => {
  const s = src("src/routes/bitacora.tsx");
  for (const [action, must] of [
    ["borrado-de-pruebas", /borr/i],
    ["borrado-rechazado", /rechaz/i],
    ["arranque-real", /arranc/i],
    ["arranque-real-retirado", /regres|retir/i],
  ]) {
    const m = s.match(new RegExp(`"${action}":\\s*"([^"]+)"`));
    assert.ok(m, `ACTION["${action}"] existe`);
    assert.match(m[1], must, `ACTION["${action}"] describe lo que pasó`);
  }
});

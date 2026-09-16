// Los índices de ESTADO.md (§ 0) y DECISIONES.md ("Índice por tema") tienen
// que cuadrar con el cuerpo de cada archivo. Un índice que se queda viejo es
// peor que ninguno: manda a una sesión a leer lo que no toca, o le esconde
// una pregunta abierta. Estas pruebas fallan el día que alguien cierra una
// pregunta, agrega una decisión o cambia una clave sin tocar el índice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const estado = readFileSync(new URL("../ESTADO.md", import.meta.url), "utf8");
const decisiones = readFileSync(new URL("../DECISIONES.md", import.meta.url), "utf8");

// Corta el texto entre dos marcadores de inicio de línea (el segundo excluido).
function between(text, startsWith, endsWith) {
  const lines = text.split("\n");
  const a = lines.findIndex((l) => l.startsWith(startsWith));
  assert.ok(a >= 0, `no encontré la línea que empieza con «${startsWith}»`);
  let b = lines.findIndex((l, i) => i > a && l.startsWith(endsWith));
  if (b < 0) b = lines.length;
  return lines.slice(a, b);
}

const KEY_RE = /\b(L\d+[a-z]?|H\d+[a-z]?|D-[A-Z]|E\d+|N\d+)\b/g;
const keysIn = (lines) => new Set(lines.join("\n").match(KEY_RE) ?? []);
const sorted = (s) => [...s].sort();

test("ESTADO.md § 0: cada pregunta de § 2 está en el índice, y ninguna clave del índice sobra", () => {
  const body = between(estado, "## 2.", "## 3.");
  const bodyKeys = new Set(
    body.map((l) => l.match(/^### ([A-Z][A-Za-z0-9-]*?)\./)?.[1]).filter(Boolean),
  );
  const index = between(estado, "### § 2 por estado", "### § 4 por estado");
  const indexKeys = keysIn(index);
  assert.deepEqual(sorted(indexKeys), sorted(bodyKeys), "§ 2: el índice y el cuerpo no listan las mismas preguntas");
});

test("ESTADO.md § 0: las ABIERTAS del índice son exactamente las que empiezan con **ABIERTA en el cuerpo, y el conteo coincide", () => {
  const body = between(estado, "## 2.", "## 3.");
  const open = new Set();
  for (let i = 0; i < body.length; i++) {
    const key = body[i].match(/^### ([A-Z][A-Za-z0-9-]*?)\./)?.[1];
    if (!key) continue;
    let j = i + 1;
    while (j < body.length && body[j].trim() === "") j++;
    if (body[j]?.startsWith("**ABIERTA")) open.add(key);
  }
  const row = between(estado, "### § 2 por estado", "### § 4 por estado").find((l) => l.startsWith("| **ABIERTA**"));
  assert.ok(row, "falta la fila **ABIERTA** en el índice de § 2");
  const declared = Number(row.match(/\((\d+)\)/)?.[1]);
  const indexOpen = keysIn([row]);
  assert.deepEqual(sorted(indexOpen), sorted(open), "§ 2: las ABIERTAS del índice no son las del cuerpo");
  assert.equal(declared, open.size, `§ 2: el índice dice (${declared}) abiertas y el cuerpo tiene ${open.size}`);
});

test("ESTADO.md § 0: cada punto de § 4 está en el índice y viceversa, y el conteo de 'Sin contestar' coincide con su fila", () => {
  const body = between(estado, "## 4.", "## 5.");
  const bodyKeys = new Set(body.map((l) => l.match(/^### (4\.\d+)/)?.[1]).filter(Boolean));
  const index = between(estado, "### § 4 por estado", "**Corrección de conteo");
  const indexKeys = new Set(index.join("\n").match(/\b4\.\d+\b/g) ?? []);
  assert.deepEqual(sorted(indexKeys), sorted(bodyKeys), "§ 4: el índice y el cuerpo no listan los mismos puntos");
  const row = index.find((l) => l.startsWith("| **Sin contestar**"));
  assert.ok(row, "falta la fila **Sin contestar** en el índice de § 4");
  const declared = Number(row.match(/\((\d+)\)/)?.[1]);
  const listed = new Set(row.match(/\b4\.\d+\b/g) ?? []);
  assert.equal(declared, listed.size, `§ 4: la fila dice (${declared}) y lista ${listed.size}`);
});

test("DECISIONES.md: cada número del índice por tema existe como DECISIÓN N, y cada DECISIÓN N de la tabla está en el índice", () => {
  const index = between(decisiones, "### Índice por tema", "| Fecha | Decisión |");
  const rows = index.filter((l) => l.startsWith("| ") && !l.startsWith("| Tema") && !l.startsWith("|---"));
  const indexed = new Set();
  for (const r of rows) {
    const cell = r.split("|")[2] ?? "";
    for (const n of cell.match(/\d+/g) ?? []) indexed.add(Number(n));
  }
  const labelled = new Set([...decisiones.matchAll(/\*\*DECISIÓN (\d+) —/g)].map((m) => Number(m[1])));
  const plural = [...decisiones.matchAll(/\*\*DECISIONES (\d+) y (\d+) —/g)].flatMap((m) => [Number(m[1]), Number(m[2])]);
  for (const n of plural) labelled.add(n);
  const missingInTable = [...indexed].filter((n) => !labelled.has(n));
  assert.deepEqual(missingInTable, [], `el índice cita decisiones que no existen en la tabla: ${missingInTable.join(", ")}`);
  const missingInIndex = [...labelled].filter((n) => !indexed.has(n));
  assert.deepEqual(missingInIndex, [], `decisiones en la tabla que el índice no menciona: ${missingInIndex.join(", ")}`);
});

test("las dos pruebas viejas que leen ESTADO.md siguen encontrando lo suyo (nada se movió)", () => {
  assert.ok(estado.includes("### H4e."), "erp-permissions.test.mjs busca «### H4e.»");
  assert.ok(estado.includes("## 6. Hallazgo de construcción"), "erp-circuitos.test.mjs busca el § 6");
});

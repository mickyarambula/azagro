// BLOQUE DE PARCIALES, paso 2 (PARCIALES.md § 8): reversa de UNA recepción
// específica, no de la OC completa.
//
// receipt-reversal.ts no se puede importar directo en `node --test` (usa
// alias `@/` no resueltos fuera del bundler) — mismo método que ya usa
// erp-revertir-recepcion.test.mjs: verificación por texto (fnBody/.includes).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

function fnBody(source, name) {
  const markers = [`export const ${name} `, `export async function ${name}(`, `export function ${name}(`, `async function ${name}(`, `function ${name}(`];
  const start = markers.map((m) => source.indexOf(m)).find((i) => i !== -1);
  assert.notEqual(start, undefined, `No existe ${name}`);
  const rest = source.slice(start);
  const next = rest.slice(10).search(/\n(export )?(async )?function |\nexport const /);
  return next === -1 ? rest : rest.slice(0, next + 10);
}

test("receipt-reversal.ts: chainForReceipt / reverseReceipt de hoy (por OC completa) no se tocan", () => {
  const s = src("src/lib/erp/receipt-reversal.ts");
  assert.ok(s.includes("async function chainForReceipt(sql: Sql, companyId: number, poId: number, role: string)"));
  assert.ok(s.includes("where m.company_id = ${companyId} and m.origin = ${o.name} and m.move_type = 'receipt'"));
  assert.ok(s.includes("export const reverseReceipt = createServerFn"));
});

test("chainForReceiptEvent: los movimientos vivos son los del event_ref, no todo el origin de la OC", () => {
  const body = fnBody(src("src/lib/erp/receipt-reversal.ts"), "chainForReceiptEvent");
  assert.ok(body.includes("m.event_ref = ${eventRef}"), "amarre por evento, no por origin");
  assert.ok(body.includes("m.move_type = 'receipt'"));
});

test("chainForReceiptEvent: la FP a revertir es la del event_ref, no todas las de origin = po.name", () => {
  const body = fnBody(src("src/lib/erp/receipt-reversal.ts"), "chainForReceiptEvent");
  assert.ok(body.includes("i.event_ref = ${eventRef}"));
});

test("chainForReceiptEvent: Decisión 35 (salida posterior) se evalúa igual, por producto y bodega, sin cambiar con eventos", () => {
  const body = fnBody(src("src/lib/erp/receipt-reversal.ts"), "chainForReceiptEvent");
  assert.match(body, /location_from = \$\{m\.location_to\} and id > \$\{m\.id\}/);
});

test("reverseReceiptEvent: resta SOLO la cantidad de este evento (no zeroea qty_received — puede haber otras recepciones)", () => {
  const body = fnBody(src("src/lib/erp/receipt-reversal.ts"), "reverseReceiptEvent");
  assert.ok(body.includes("qty_received = greatest(0, qty_received - ${m.quantity})"), "resta, no pone en 0 — a diferencia de reverseReceipt (una sola recepción)");
});

test("reverseReceiptEvent: la OC vuelve a 'confirmed' solo si queda pendiente en alguna partida (no siempre, a diferencia de reverseReceipt)", () => {
  const body = fnBody(src("src/lib/erp/receipt-reversal.ts"), "reverseReceiptEvent");
  assert.match(body, /qty_received < qty - 0\.0001/);
});

test("listReceiptEvents: enumera los eventos de recepción de una OC (para la pantalla, cuando hay más de uno)", () => {
  const s = src("src/lib/erp/receipt-reversal.ts");
  const body = fnBody(s, "listReceiptEvents");
  assert.ok(body.includes("event_ref is not null"));
  assert.ok(body.includes("group by"), "un renglón por evento");
});

test("purchases.tsx: cuando hay más de un evento de recepción, se listan con su propio botón de reversa", () => {
  const s = src("src/routes/purchases.tsx");
  assert.ok(s.includes("listReceiptEvents"));
  assert.ok(s.includes("reverseReceiptEvent"));
});

test("ReceiptEventsPanel: vuelve a pedir la lista cuando cambia `refresh` (no solo al montar) — si no, una segunda recepción no aparece nunca", () => {
  const body = fnBody(src("src/routes/purchases.tsx"), "ReceiptEventsPanel");
  assert.match(body, /\}, \[props\.poId, props\.refresh\]\)/, "el efecto depende de refresh, no solo de poId");
  const s = src("src/routes/purchases.tsx");
  assert.match(s, /refresh=\{`\$\{o\.state\}:\$\{qlines\.reduce/, "el padre pasa una señal que cambia con cada recepción/reversa (qty_received acumulado)");
});

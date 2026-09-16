// BLOQUE DE PARCIALES, pasos 1.1-1.2 (PARCIALES.md § 8): recepción parcial y
// una FP por recepción (Decisión 28).
//
// azagro.ts no se puede importar directo en `node --test` (usa alias `@/` no
// resueltos fuera del bundler) — mismo motivo por el que NINGUNA prueba
// existente de este archivo (erp-fp-al-recibir.test.mjs, erp-cancelar.test.mjs,
// erp-trazabilidad.test.mjs) ejecuta su lógica contra una base real: todas
// verifican por texto (`fnBody`/`.includes`). Esta prueba sigue el mismo
// método, sobre el código nuevo.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

function fnBody(source, name) {
  const markers = [`export const ${name} `, `export async function ${name}(`, `async function ${name}(`, `export function ${name}(`, `function ${name}(`];
  const start = markers.map((m) => source.indexOf(m)).find((i) => i !== -1);
  assert.notEqual(start, undefined, `No existe ${name}`);
  const rest = source.slice(start);
  const next = rest.slice(10).search(/\n(?:export |async function |function )/);
  return next === -1 ? rest : rest.slice(0, next + 10);
}

// ---------------------------------------------------------------------------
// 1) El camino de hoy (sin `lines`) queda BYTE A BYTE — lo fija también
//    erp-fp-al-recibir.test.mjs; aquí se verifica que el nuevo branch no lo
//    tocó.
// ---------------------------------------------------------------------------
test("receivePurchase: sin data.lines, el camino de hoy sigue llamando a bornSupplierDebt (no al nuevo por evento)", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "receivePurchase");
  assert.ok(body.includes("if (data.lines && data.lines.length) {"), "hay un branch nuevo, explícito");
  assert.ok(body.includes("const fp = await bornSupplierDebt(sql, {"), "el camino de hoy no cambia — lo sigue fijando erp-fp-al-recibir.test.mjs");
  assert.ok(body.includes("update purchase_lines set qty_received = qty where id = ${line.id}"), "el update de hoy sigue igual");
});

// ---------------------------------------------------------------------------
// 2) El validator acepta `lines` opcional.
// ---------------------------------------------------------------------------
test("receivePurchase: el validator acepta cantidad por partida, opcional", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "receivePurchase");
  assert.ok(body.includes("lines: z.array(z.object({ lineId: z.number(), qty: z.number().positive() })).optional()"));
});

// ---------------------------------------------------------------------------
// 3) receivePartial: un evento por llamada, valida contra lo pendiente,
//    postStock con eventRef, y solo pasa a 'done' cuando ya no queda nada
//    pendiente en NINGUNA partida.
// ---------------------------------------------------------------------------
test("receivePartial: mina un event_ref por llamada (serie RCP, folio_counters) y lo pasa a postStock", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "receivePartial");
  assert.ok(body.includes("values (${opts.companyId}, 'RCP', 1)"), "serie RCP, misma mecánica que nextRef (A4)");
  assert.ok(body.includes("eventRef,"), "lo pasa a postStock");
});

test("receivePartial: valida que ninguna partida pida más de lo pendiente", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "receivePartial");
  assert.match(body, /No puedes recibir más de lo pendiente/);
});

test("receivePartial: la OC solo pasa a 'done' cuando NINGUNA partida tiene pendiente", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "receivePartial");
  assert.ok(body.includes("qty_received >= qty - 0.0001"), "se pregunta contra el acumulado, no contra esta llamada sola");
});

// ---------------------------------------------------------------------------
// 4) bornSupplierDebtByReceipt: idempotente POR EVENTO (Decisión 42), no por
//    OC; importe = lo recibido en ESE evento, no po.total (Decisión 28).
// ---------------------------------------------------------------------------
test("bornSupplierDebtByReceipt: idempotente por event_ref, no por origin/OC", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "bornSupplierDebtByReceipt");
  assert.ok(body.includes("event_ref = ${opts.eventRef}"), "la llave es el evento");
  // Paso 3.2: la llave es evento Y OC — una entrega directa con dos OC al mismo
  // evento tiene que producir dos FP; solo por evento, la segunda no nacía.
  assert.ok(body.includes("event_ref = ${opts.eventRef} and origin = ${opts.poName}"), "evento + OC");
});

test("bornSupplierDebtByReceipt: importe = lo recibido en este evento, no po.total", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "bornSupplierDebtByReceipt");
  assert.ok(!body.includes("po.total"), "Decisión 28: una FP por recepción, no completa al primer recibo");
  assert.ok(body.includes("opts.received"), "la lista de lo recibido en este evento entra como parámetro");
});

test("bornSupplierDebtByReceipt: se detiene sin plazo del proveedor, igual que bornSupplierDebt (Decisión 30)", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "bornSupplierDebtByReceipt");
  assert.ok(body.includes("Falta el plazo de pago de"));
});

test("bornSupplierDebtByReceipt: se define DESPUÉS de receivePurchase — no invade el rango que fija erp-trazabilidad.test.mjs", () => {
  const az = src("src/lib/azagro.ts");
  assert.ok(az.indexOf("export async function bornSupplierDebtByReceipt") > az.indexOf("export const receivePurchase"));
});

// ---------------------------------------------------------------------------
// 5) postStock acepta eventRef opcional y lo escribe en stock_moves.
// ---------------------------------------------------------------------------
test("postStock: acepta eventRef opcional y lo escribe en stock_moves.event_ref", () => {
  const body = fnBody(src("src/lib/erp/stock.ts"), "postStock");
  assert.ok(body.includes("eventRef?: string | null"));
  assert.ok(body.includes("event_ref"), "lo escribe en el insert");
});

// ---------------------------------------------------------------------------
// 6) La marca "FP de OC sin recibir" deja de mirar solo po.state.
// ---------------------------------------------------------------------------
test('"FP de OC sin recibir" (fpSinRecibir, getDashboard): agrega event_ref is null sin quitar el po.state', () => {
  const az = src("src/lib/azagro.ts");
  const start = az.indexOf("const fpSinRecibir = await sql<");
  const block = az.slice(start, start + 400);
  assert.ok(block.includes("po.state not in ('done','cancelled')"), "sigue limpiándose sola con deuda huérfana de verdad");
  assert.ok(block.includes("event_ref is null"), "y ya no marca las FP nuevas y correctas");
});

test('"FP de OC sin recibir" (unreceived, listInvoices): agrega event_ref is null sin quitar el po.state', () => {
  const az = src("src/lib/azagro.ts");
  const start = az.indexOf(") as unreceived,");
  const block = az.slice(Math.max(0, start - 400), start);
  assert.ok(block.includes("po.state not in ('done','cancelled')"), "sigue limpiándose sola con deuda huérfana de verdad");
  assert.ok(block.includes("event_ref is null"), "y ya no marca las FP nuevas y correctas");
});

// ---------------------------------------------------------------------------
// 7) Pantalla — /purchases: recibir cantidad por partida (paso 1.4).
// ---------------------------------------------------------------------------
test("purchases.tsx: el botón Recibir abre el diálogo de cantidad por partida (no dispara receivePurchase de un clic)", () => {
  const s = src("src/routes/purchases.tsx");
  assert.ok(s.includes("function ReceivePartialButton("), "el componente nuevo existe");
  assert.ok(s.includes("<ReceivePartialButton"), "y se usa en la lista de órdenes");
  assert.ok(!/onClick=\{async \(\) => \{\s*try \{\s*await receivePurchase\(\{ data: \{ poId: o\.id \} \}\);/.test(s), "ya no dispara de un clic sin cantidad");
});

test("purchases.tsx: 'Recibir todo lo pendiente' llama sin lines (el camino de hoy); confirmar cantidades llama con lines", () => {
  const s = src("src/routes/purchases.tsx");
  // Paso 3.5: el diálogo se extrajo a src/components/partial-qty-dialog.tsx
  // (lo comparten compras y ventas); ReceivePartialButton es un envoltorio.
  const body = fnBody(src("src/components/partial-qty-dialog.tsx"), "PartialQtyDialog");
  assert.ok(body.includes("void confirm(undefined)"), "recibir todo = sin lines");
  assert.ok(body.includes("confirm(Object.entries(qtys)"), "recibir lo capturado = con lines");
  assert.ok(s.includes("data: recvLines ? { poId: o.id, lines: recvLines } : { poId: o.id }"), "onReceive arma el data correcto en los dos casos");
});

test("listPurchases: sus renglones traen pl.id (falta antes de este bloque) para poder referenciar la partida", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "listPurchases");
  assert.match(body, /select pl\.id, pl\.po_id,/);
});

// BLOQUE DE PARCIALES, paso 4 (PARCIALES.md § 8): reversa de UNA entrega
// específica (evento ENV/000N), no del pedido completo.
//
// delivery-reversal.ts no se puede importar directo en `node --test` (usa
// alias `@/` no resueltos fuera del bundler) — mismo método que ya usan
// erp-revertir-entrega.test.mjs y erp-revertir-recepcion-parcial.test.mjs:
// verificación por texto (fnBody/.includes) más la aritmética que decide.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { repartirReversa } from "../src/lib/erp/parciales.ts";

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

const DR = "src/lib/erp/delivery-reversal.ts";

// ---------------------------------------------------------------------------
// El camino viejo (un pedido = una entrega) queda intacto: es el motor
// congelado de erp-revertir-entrega.test.mjs.
// ---------------------------------------------------------------------------
test("delivery-reversal.ts: chainForDelivery / reverseDelivery de hoy (pedido completo) no se tocan", () => {
  const s = src(DR);
  const chain = fnBody(s, "chainForDelivery");
  assert.ok(chain.includes("where m.company_id = ${companyId} and m.origin = ${s.name} and m.move_type = 'delivery'"), "todas las salidas del pedido, por origin");
  assert.ok(chain.includes('const fvRow = docs.find((d) => d.name.startsWith("FV-") && !d.reversed_by && d.origin === s.name);'), "una sola FV, por origin");
  const run = fnBody(s, "reverseDelivery");
  assert.ok(run.includes("update sales_lines set qty_delivered = 0"), "el camino viejo sigue zereando: es de una sola entrega");
  assert.ok(run.includes("const fresh = await chainForDelivery(tx, companyId, data.soId, me.role);"));
});

test("chainForDelivery (viejo): con 2+ eventos sigue bloqueando, pero ahora nombra el botón que sí existe; y un pedido parcial (no done) ya no dice 'no se ha entregado'", () => {
  const chain = fnBody(src(DR), "chainForDelivery");
  assert.match(chain, /paso 4 del bloque de parciales/, "erp-entrega-parcial lo fija");
  assert.ok(!chain.includes("todavía no construido"), "ya está construido: el mensaje no puede seguir diciendo que no");
  assert.ok(chain.includes("«Revertir esta entrega» en el panel de entregas"), "el camino, con el nombre del botón");
  // El gate por `done` se queda (es el camino de pedido completo), pero antes
  // de decir "no se ha entregado" cuenta las entregas parciales vivas.
  const iGate = chain.indexOf('if (s.state !== "done") {');
  const iCount = chain.indexOf("count(distinct event_ref)", iGate);
  const iFalse = chain.indexOf("no se ha entregado: no hay entrega que revertir", iGate);
  assert.ok(iGate > -1 && iCount > iGate && iCount < iFalse, "cuenta eventos vivos ANTES del mensaje de 'no se ha entregado'");
  assert.ok(chain.includes("entrega(s) parcial(es) y queda pendiente: se revierte por entrega"), "mensaje verdadero para el pedido parcial");
});

// ---------------------------------------------------------------------------
// El camino nuevo: por evento.
// ---------------------------------------------------------------------------
test("chainForDeliveryEvent: no exige pedido `done` — basta una entrega viva con ese evento (un error en la entrega 1 de 3 se corrige sin esperar las otras dos)", () => {
  const body = fnBody(src(DR), "chainForDeliveryEvent");
  assert.ok(!body.includes('s.state !== "done"'), "sin gate por done");
  assert.ok(body.includes('if (s.state === "cancelled")'), "cancelado sí bloquea");
  assert.ok(body.includes("m.event_ref = ${eventRef} and m.move_type = 'delivery'"), "las salidas de ESTE evento, no todo el origin");
  assert.ok(body.includes("No hay entrega con el evento ${eventRef} en ${s.name}."), "evento inexistente");
  assert.ok(body.includes("ya está revertida ("), "no se revierte dos veces");
});

test("chainForDeliveryEvent: la FV es la del event_ref (o ninguna: entrega sin facturar, Decisión 47); FI y ATC por el folio de ESA FV", () => {
  const body = fnBody(src(DR), "chainForDeliveryEvent");
  assert.ok(body.includes('d.name.startsWith("FV-") && d.event_ref === eventRef'), "FV por evento, no por origin");
  assert.ok(body.includes("entrega sin facturar (Decisión 47): no hay factura que anular, solo regresa la mercancía"), "sin FV no se bloquea: en bodega propia entregar no factura");
  assert.ok(body.includes('x.inv_class === "interest" && x.origin === `Mora ${fv!.name}`'), "la FI de esa FV");
  assert.ok(body.includes('x.inv_class === "fx" && x.origin === `Ajuste TC ${fv!.name}`'), "el ATC de esa FV");
  assert.ok(body.includes("tiene abonos: revierte ese cobro primero (Cartera → Revertir último abono)"), "con abonos → paso 5, con la ruta");
  assert.ok(body.includes("if (fvRow.folio_fiscal || fvRow.uuid_fiscal) preview.fiscal ="), "timbrada: se detecta, no se bloquea (Decisión 39)");
});

test("chainForDeliveryEvent: en directo/brokeraje no hay kardex — la entrega se identifica por su FV y la FP a revertir es la de ESE evento", () => {
  const body = fnBody(src(DR), "chainForDeliveryEvent");
  assert.ok(body.includes("select product_id, qty::text from invoice_lines where invoice_id = ${fvRow.id}"), "lo entregado, de los renglones de la FV");
  assert.ok(body.includes("i.kind = 'supplier' and i.event_ref = ${eventRef} and i.state <> 'reversed'"), "FP por evento (paso 3: por evento y por OC)");
  assert.ok(body.includes("brokeraje) tiene abonos: revierte ese pago primero"), "FP pagada → paso 5");
});

test("chainForDeliveryEvent: la devolución previa bloquea solo si es de un PRODUCTO de esta entrega (criterio de la Decisión 52), no por todo el pedido", () => {
  const body = fnBody(src(DR), "chainForDeliveryEvent");
  assert.ok(body.includes("il.product_id = any(${productIds}::int[])"), "NC viva con un renglón de estos productos");
  assert.ok(body.includes("where so_id = ${s.id} and product_id = any(${productIds}::int[])"), "cantidad devuelta en la partida de estos productos");
  assert.ok(body.includes("ya tiene una devolución de lo que salió en ${eventRef}") && body.includes("Primero revierte esa devolución: botón «Revertir devolución»"), "→ paso 8, con el camino nombrado");
});

test("chainForDeliveryEvent: la entrada contraria va al costo con el que salió y el promedio se enseña con su número (Decisiones 9 y 20)", () => {
  const body = fnBody(src(DR), "chainForDeliveryEvent");
  assert.ok(body.includes("const avgAfter = qtyAfter > 0.0000001 ? (qtyBefore * avgBefore + qty * unitCost) / qtyAfter : unitCost;"));
  assert.ok(body.includes("moves.push({ id: m.id, product_id: m.product_id, quantity: qty, unit_cost: unitCost, location_from: m.location_from });"));
});

test("reverseDeliveryEvent: resta SOLO lo de este evento (no zeroea qty_delivered), el pedido vuelve a 'confirmed', y todo queda ligado — nada se borra", () => {
  const s = src(DR);
  const run = fnBody(s, "reverseDeliveryEvent");
  assert.ok(run.includes("const { restas, sobrante } = repartirReversa(") && run.includes("update sales_lines set qty_delivered = qty_delivered - ${r.qty} where id = ${r.id}"), "resta partida por partida (repartirReversa), no pone en 0");
  assert.ok(run.includes("order by id for update"), "las partidas del producto, candadas");
  assert.ok(run.includes("AVISO: ${avisos.join") && run.includes("sin restar"), "si sobró algo por restar, queda en bitácora — no se tapa en silencio");
  assert.ok(!run.includes("qty_delivered = 0"), "nunca zeroea: puede haber otras entregas vivas");
  assert.ok(run.includes("update sales_orders set state = 'confirmed'"), "al restar queda pendiente: confirmed siempre");
  assert.ok(run.includes('moveType: "reversal"') && run.includes("locationTo: m.location_from, unitCost: m.unit_cost, reversesId: m.id"), "entrada contraria ligada a su salida, al costo de salida");
  assert.ok(run.includes("if (fresh.fv) written.push(await creditNoteFor("), "FV → NC por el total (Decisión 19)");
  assert.ok(run.includes("for (const fi of fresh.fis) written.push(await creditNoteFor("), "FI → NC (Decisión 37)");
  assert.ok(run.includes('action: "revertir-atc"') && run.includes('action: "revertir-fp"') && run.includes('action: "revertir-entrega"'), "misma bitácora que el camino viejo");
  assert.ok(run.includes("for update") && run.includes("const fresh = await chainForDeliveryEvent(tx, companyId, data.soId, data.eventRef, me.role);"), "transacción + candado + cadena fresca");
  assert.ok(run.includes("if (!canRevert(me.role)) throw new Error("), "admin/gerencia (Decisión 24)");
  assert.ok(!s.includes("delete from"), "Decisión 16: nunca se borra");
});

test("aritmética: tres entregas 10/5/5 de 20; revertir la segunda deja 15 entregadas, 5 pendientes, pedido confirmed; la resta nunca baja de 0", () => {
  const greatest0 = (n) => Math.max(0, n);
  let qtyDelivered = 10 + 5 + 5;
  const qty = 20;
  assert.equal(qtyDelivered, 20, "done");
  qtyDelivered = greatest0(qtyDelivered - 5); // revertir ENV/0002
  assert.equal(qtyDelivered, 15);
  assert.ok(qtyDelivered < qty - 0.0001, "queda pendiente → confirmed");
  // Las otras dos entregas siguen vivas: 10 (ENV/0001) + 5 (ENV/0003) = 15. Con el camino viejo (=0) se perderían.
  assert.equal(10 + 5, qtyDelivered);
  assert.equal(greatest0(3 - 5), 0, "una inconsistencia previa no deja qty_delivered negativa");
});

test("repartirReversa: reparte lo del evento entre las partidas del producto sin pasar de lo entregado en cada una; el sobrante se reporta", () => {
  // Mismo producto en dos partidas: A entregó 10 (ENV/0001), B entregó 5 (ENV/0002). Revertir ENV/0001 = 10.
  let r = repartirReversa([{ id: 1, delivered: 10 }, { id: 2, delivered: 5 }], 10);
  assert.deepEqual(r, { restas: [{ id: 1, qty: 10 }], sobrante: 0 }, "A queda en 0, B sigue en 5 — no se le pega a las dos");
  // Revertir ENV/0002 = 5 después de la anterior: A ya está en 0, la resta cae en B.
  r = repartirReversa([{ id: 1, delivered: 0 }, { id: 2, delivered: 5 }], 5);
  assert.deepEqual(r, { restas: [{ id: 2, qty: 5 }], sobrante: 0 });
  // Una entrega que cruzó partidas (7 de A + 3 de B en un evento de 10): se resta en orden, la suma es exacta.
  r = repartirReversa([{ id: 1, delivered: 7 }, { id: 2, delivered: 3 }], 10);
  assert.deepEqual(r, { restas: [{ id: 1, qty: 7 }, { id: 2, qty: 3 }], sobrante: 0 });
  assert.equal(r.restas.reduce((s, x) => s + x.qty, 0), 10, "lo restado = lo que salió en el evento");
  // Inconsistencia previa (entregado en partidas < lo que salió): nunca negativo, y el sobrante se dice.
  r = repartirReversa([{ id: 1, delivered: 3 }], 5);
  assert.deepEqual(r, { restas: [{ id: 1, qty: 3 }], sobrante: 2 });
  assert.deepEqual(repartirReversa([], 4), { restas: [], sobrante: 4 });
});

test("invoiceDelivery (paso 3) rechaza facturar un evento cuyas salidas ya están revertidas: no se factura lo que ya regresó", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "invoiceDelivery");
  assert.ok(body.includes("and not exists (select 1 from stock_moves r where r.reverses_id = m.id)"), "cuenta solo salidas vivas");
  assert.ok(body.includes("no se factura lo que no salió"));
});

// ---------------------------------------------------------------------------
// cancel.ts: un pedido con todas sus entregas revertidas vuelve a poder
// cancelarse (cierra la mitad del candado de PARCIALES.md § 4.1).
// ---------------------------------------------------------------------------
test("chainForSale (cancel.ts): solo las entregas VIVAS bloquean cancelar — una salida con su reversal ligada ya no cuenta", () => {
  const body = fnBody(src("src/lib/erp/cancel.ts"), "chainForSale");
  const i = body.indexOf("const deliveries = await sql");
  const q = body.slice(i, body.indexOf("`;", i));
  assert.ok(q.includes("m.move_type = 'delivery'"));
  assert.ok(q.includes("and not exists (select 1 from stock_moves r where r.reverses_id = m.id)"), "excluye las revertidas");
  assert.ok(body.includes("and state <> 'reversed'\n      and reverses_id is null"), "la NC contraria de una reversa (reverses_id) tampoco cuenta como factura viva");
});

test("las server functions nuevas existen con su firma por evento, listas para el panel de entregas (mitad B)", () => {
  const s = src(DR);
  assert.ok(s.includes("export const deliveryEventReversalPreview = createServerFn"));
  assert.ok(s.includes("export const reverseDeliveryEvent = createServerFn"));
  assert.ok(s.includes("export type DeliveryEventPreview = DeliveryReversalPreview & { eventRef: string; invoiced: boolean };"), "mismo preview que el diálogo de hoy, más el evento");
  assert.equal((s.match(/validator\(z\.object\(\{ soId: z\.number\(\), eventRef: z\.string\(\)/g) || []).length, 2, "preview y reversa, las dos por evento");
});

// ---------------------------------------------------------------------------
// Paso 4, mitad B (pantalla): botón «Revertir esta entrega» por evento.
// ---------------------------------------------------------------------------
test("DeliveryReversalButton: acepta un label por evento (patrón de ReceiptReversalButton, paso 2)", () => {
  const c = src("src/components/cancel-doc.tsx");
  const body = fnBody(c, "DeliveryReversalButton");
  assert.match(body, /label\?:\s*string;/, "prop opcional");
  assert.ok(body.includes('{props.label ?? "Revertir entrega"}'), "sin label sigue diciendo lo de siempre — no rompe el botón de hoy");
});

test("ficha del pedido: cada entrega viva del panel tiene su botón de revertir, salvo el único caso que ya cubre el botón de arriba (un evento, pedido done)", () => {
  const so = src("src/routes/sales.$orderId.tsx");
  assert.ok(so.includes("deliveryEventReversalPreview, deliveryReversalPreview, reverseDelivery, reverseDeliveryEvent"), "importa el camino por evento junto al de siempre");
  const body = fnBody(so, "Ficha");
  assert.ok(body.includes("const showRevert = canEdit && !e.reversed && (events.length > 1 || state !== \"done\");"), "se apoya en el botón de arriba solo cuando ese sí aplica");
  assert.ok(body.includes("load={() => deliveryEventReversalPreview({ data: { soId: id, eventRef: e.eventRef } })}"), "preview por evento");
  assert.ok(body.includes("onConfirm={(reason) => reverseDeliveryEvent({ data: { soId: id, eventRef: e.eventRef, reason } })}"), "reversa por evento");
  assert.ok(body.includes("label={`Revertir ${e.eventRef}`}"), "el botón nombra el evento, no dice solo 'Revertir entrega'");
  assert.ok(body.includes("onDone={load}"), "recarga la ficha completa — el mismo load() que ya usa el botón de siempre, sin panel aparte ni refresh-prop: aquí `events` ya se recarga con cada acción");
});

test("ficha del pedido: el botón de arriba (canEdit && state === 'done') se queda tal cual — sigue siendo el único camino cuando hay un solo evento y el pedido ya está completo", () => {
  const so = src("src/routes/sales.$orderId.tsx");
  assert.ok(so.includes("{canEdit && state === \"done\" && (\n            <DeliveryReversalButton"), "no se le agregó ninguna condición nueva");
});

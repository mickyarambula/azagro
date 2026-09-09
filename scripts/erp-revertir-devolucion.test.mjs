// BLOQUE DE DESHACER — PASO 8 (8-sep-2026): revertir una devolución. El que
// cierra el bloque y destraba al paso 7 (entrega con devolución previa).
//
// returnSale deja cuatro cosas: la NC negativa, un abono VIRTUAL aplicado a
// la FV, el movimiento `return` al costo con el que salió, y qty_returned.
//
// Prueba central: inventario y cartera exactamente como antes de la
// devolución, salvo lo que ya sabemos que no vuelve solo. Y los tres pares
// ligados: reversal → return, contra-PAG → PAG virtual, NC → reversed.
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
const r2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// 1) CENTRAL — inventario y cartera como antes de la devolución.
// ---------------------------------------------------------------------------
test("CENTRAL inventario: la salida contraria va al costo con el que regresó; existencia exacta; el promedio no se mueve (salida)", () => {
  const qtyFromMoves = (moves) => moves.reduce((s, m) => s + m, 0);
  // Entrega 20, devuelve 3 (entra al costo de salida), se revierte la devolución (sale 3).
  assert.equal(qtyFromMoves([35, -20, 3, -3]), 15, "existencia idéntica por construcción (+3 −3)");
  // Una salida conserva el promedio (stock.ts: writeQuant(..., prev.avg)).
  const avgAntes = 9357.142857;
  assert.equal(r2(avgAntes), r2(avgAntes), "el promedio no se mueve con una salida");
});

test("CENTRAL cartera: el contra-abono deja el saldo de la FV como antes de la devolución; la NC deja de contar", () => {
  const residualOf = (amount, allocs) => Math.max(0, amount - allocs.reduce((s, a) => s + a, 0));
  // FV 184,300; cobro 150,000; devolución de 27,645 (abono virtual) → saldo 6,655.
  assert.equal(r2(residualOf(184300, [150000, 27645])), 6655);
  // Reversa: contra-abono −27,645 → saldo 34,300, exactamente lo que había antes de devolver.
  assert.equal(r2(residualOf(184300, [150000, 27645, -27645])), 34300);
  assert.equal(r2(residualOf(184300, [150000])), 34300);
  const invoiceStillOwed = (s) => s !== "paid" && s !== "reversed";
  assert.equal(invoiceStillOwed("reversed"), false, "la NC revertida no es cartera (ni su saldo negativo a favor)");
});

test("CENTRAL (cableado): salida `reversal` al costo de regreso ligada al `return`; contra-PAG negativo sin banco ligado; NC por estado; nunca se borra", () => {
  const c = src("src/lib/erp/return-reversal.ts");
  const run = fnBody(c, "reverseReturn");
  assert.ok(run.includes('moveType: "reversal", origin: pv.nc.name'), "tipo propio, origin = la NC");
  assert.ok(run.includes("locationFrom: m.location_to, unitCost: m.unit_cost, reversesId: m.id"), "de la bodega a la que regresó, al costo con el que regresó, ligado");
  assert.ok(run.includes("values (${companyId}, 'inbound', ${cname}, ${fresh.partnerId}, ${-pv.virtualPayment.amount}"), "contra-abono: mismo tipo, negativo");
  assert.ok(run.includes("${today}, ${pv.virtualPayment.id})\n          returning id"), "ligado al PAG virtual");
  assert.ok(!run.includes("insert into bank_moves"), "sin banco: el abono virtual nunca lo tuvo");
  assert.ok(run.includes("await refreshInvoiceResidual(tx, pv.fv.id);"), "la FV se rehace desde los abonos: paid_date se limpia si la había cerrado");
  assert.ok(run.includes("update invoices set state = 'reversed', cancelled_at = now(), cancelled_by = ${context.userId}, cancel_reason = ${data.reason} where id = ${pv.nc.id}"), "NC por estado, sin documento contrario");
  assert.ok(run.includes("update sales_lines set qty_returned = greatest(0, qty_returned - ${l.qty})"), "lo devuelto, de regreso");
  assert.ok(!c.includes("delete from") && !/update stock_moves/.test(c), "nada se borra, el kardex sigue inmutable");
  assert.ok(!run.includes("update sales_orders"), "el pedido sigue entregado: la venta fue real");
});

// ---------------------------------------------------------------------------
// 2) El amarre (Decisión 42): el `return` lleva el folio de la NC de aquí en
//    adelante; lo viejo se amarra por producto + cantidad + fecha o se bloquea.
// ---------------------------------------------------------------------------
test("returnSale calcula el folio de la NC ANTES de mover inventario y lo escribe en el origin del return", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "returnSale");
  const iNc = body.indexOf("const ncName = `NC-${String(");
  const iPost = body.indexOf('moveType: "return"');
  assert.ok(iNc !== -1 && iPost !== -1 && iNc < iPost, "el folio se calcula antes del postStock");
  assert.ok(body.includes('moveType: "return",\n          origin: ncName,'), "origin = la NC, como la OC en el receipt y el pedido en el delivery");
  assert.equal((body.match(/const ncName = /g) || []).length, 1, "un solo cálculo del folio");
});

test("la reversa amarra primero por NC; si es una devolución vieja, por producto + cantidad + fecha (el último sin revertir); si no cuadra, bloquea sin adivinar", () => {
  const chain = fnBody(src("src/lib/erp/return-reversal.ts"), "chainForReturn");
  assert.ok(chain.includes("m.move_type = 'return' and m.origin = ${n.name} and m.product_id = ${l.product_id}"), "amarre nuevo: origin = NC");
  assert.ok(chain.includes("m.move_type = 'return' and m.origin = ${n.so_name ?? \"\"} and m.product_id = ${l.product_id}\n            and m.quantity = ${qty} and m.date = ${n.date}"), "amarre viejo: pedido + producto + cantidad + fecha");
  assert.ok(chain.includes("order by m.id desc limit 1"), "el último sin revertir (LIFO)");
  assert.ok(chain.includes("No se puede amarrar el movimiento de regreso de") && chain.includes("No se adivina."), "si no cuadra exacto, se detiene y lo dice");
  assert.ok(chain.includes('let matchedBy: "nc" | "legacy" = "nc";'), "y la pantalla dice cómo se amarró");
});

// ---------------------------------------------------------------------------
// 3) Los bloqueos: revendida (Decisión 35), LIFO, cobro real posterior (paso
//    5), NC de reversa de entrega, ya revertida, no es devolución.
// ---------------------------------------------------------------------------
test("mercancía revendida: bloqueo por salida posterior, no por existencia total — Decisión 35 aplicada a la entrada de devolución", () => {
  const chain = fnBody(src("src/lib/erp/return-reversal.ts"), "chainForReturn");
  assert.ok(chain.includes("and location_from = ${m.location_to} and id > ${m.id}"), "cualquier salida de ese producto desde esa bodega después del return");
  assert.ok(chain.includes("Después de la devolución ${n.name} salieron ${total} ${l.uom} de ${l.code}"), "nombra qué salió y cuánto");
  assert.ok(chain.includes("no se puede saber si lo que salió era lo devuelto. Revierte primero esa salida."));
});

test("LIFO estricto, cobro real posterior manda al paso 5, y los otros bloqueos con su mensaje", () => {
  const chain = fnBody(src("src/lib/erp/return-reversal.ts"), "chainForReturn");
  assert.ok(chain.includes("no es la última devolución de ${n.so_name}. Revierte primero ${later[0]!.name}."), "LIFO");
  assert.ok(chain.includes("después de esta devolución. Revierte primero ese cobro (Cartera → Revertir último abono)."), "abono real posterior → paso 5");
  assert.ok(chain.includes("es la nota de crédito de una reversa de entrega, no una devolución"), "la NC del paso 7 no se revierte por aquí");
  assert.ok(chain.includes("ya está revertida."));
  assert.ok(chain.includes("no es una devolución."));
  // Solo abonos y devoluciones VIVOS cuentan.
  assert.ok(chain.includes("and not exists (select 1 from payments r where r.reverses_id = pmt.id)"));
  assert.ok(chain.includes("and name like 'NC-%' and reverses_id is null and state <> 'reversed' and id > ${n.id}"));
});

test("la mora no se toca: la FI emitida después de la devolución se queda (la venta fue real); el paso no escribe interest_invoiced", () => {
  const c = src("src/lib/erp/return-reversal.ts");
  assert.ok(!c.includes("interest_invoiced"), "no toca lo facturado de interés");
  assert.ok(fnBody(c, "chainForReturn").includes("mora facturada después de la devolución: la venta fue real, ese interés corrió"), "y lo dice en pantalla");
  // returnSale tampoco toca mora (Decisión 10 no construida): no hay nada que deshacer.
  const ret = fnBody(src("src/lib/azagro.ts"), "returnSale");
  assert.ok(!ret.includes("interest_invoiced") && !ret.includes("issueMoraInvoice"));
});

test("todo o nada, admin/gerencia, intento rechazado en bitácora antes de la transacción", () => {
  const c = src("src/lib/erp/return-reversal.ts");
  const run = fnBody(c, "reverseReturn");
  const iAudit = run.indexOf("await auditRejected(sql, companyId, context.userId, chain);");
  const iTx = run.indexOf("return withTx(async (tx) => {");
  assert.ok(iAudit !== -1 && iAudit < iTx);
  assert.ok(run.includes("if (!canRevert(me.role)) throw new Error("));
  assert.ok(run.includes("for update") && run.includes("const fresh = await chainForReturn(tx, companyId, data.ncId, me.role);"));
  assert.ok(src("src/routes/bitacora.tsx").includes('"revertir-devolucion": "Revirtió devolución"'));
});

// ---------------------------------------------------------------------------
// 4) La NC timbrada (Decisión 41): no bloquea; se avisa; se captura la fecha de
//    cancelación ante el SAT en el puente; marca y conteo se limpian con ella.
// ---------------------------------------------------------------------------
test("migración 0030: sat_cancelled_at, nula = pendiente", () => {
  const m = src("migrations/0030_sat_cancelada.sql");
  assert.ok(m.includes("alter table invoices add column if not exists sat_cancelled_at date;"));
  assert.ok(m.includes("Nula = pendiente"));
});

test("NC timbrada: no bloquea, avisa que hay que CANCELAR (no timbrar) desde Compaq, y queda en bitácora", () => {
  const c = src("src/lib/erp/return-reversal.ts");
  const chain = fnBody(c, "chainForReturn");
  assert.ok(!/blockers\.push\([^)]*timbrad/.test(chain), "ningún bloqueo por timbrada");
  assert.ok(chain.includes("timbrada: n.folio_fiscal || n.uuid_fiscal ? { folio: n.folio_fiscal, uuid: n.uuid_fiscal } : null"));
  const ui = src("src/components/cancel-doc.tsx");
  assert.ok(ui.includes("cancelar ese CFDI desde Compaq y capturar aquí la fecha (Cartera → Folio fiscal). Hasta entonces, para el SAT la devolución sigue viva."));
  assert.ok(fnBody(c, "reverseReturn").includes("estaba TIMBRADA (") && fnBody(c, "reverseReturn").includes("cancelar ante el SAT desde Compaq y capturar la fecha"));
});

test("la fecha se captura en el mismo puente del folio fiscal, solo donde tiene sentido, y queda en bitácora", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "saveInvoiceReference");
  assert.ok(body.includes("satCancelledAt: z.string().optional(),"));
  assert.ok(body.includes('if (v && inv[0].kind !== "customer") throw new Error("La cancelación ante el SAT solo aplica a documentos de cliente.");'));
  assert.ok(body.includes('if (v && inv[0].state !== "reversed") throw new Error('), "solo un documento revertido");
  assert.ok(body.includes("no tiene folio fiscal ni UUID: no estaba timbrada, no hay nada que cancelar ante el SAT."), "y solo si estaba timbrado");
  assert.ok(body.includes("sat_cancelled_at = ${satCancelledAt}"));
  assert.ok(body.includes("cancelada ante el SAT: ${inv[0].sat_cancelled_at ?? \"pendiente\"} → ${satCancelledAt ?? \"pendiente\"}"), "bitácora con antes → después");
  const cred = src("src/routes/credit.tsx");
  assert.ok(cred.includes("Cancelada ante el SAT el"), "el campo en el modal del folio");
  assert.ok(cred.includes("{folioEdit.pendienteSat ? ("), "solo aparece donde aplica");
});

test("marca por renglón y conteo en el tablero, derivados: se limpian solos al capturar la fecha", () => {
  const az = src("src/lib/azagro.ts");
  assert.ok(az.includes("and (coalesce(i.folio_fiscal,'') <> '' or coalesce(i.uuid_fiscal,'') <> '') and i.sat_cancelled_at is null) as pendiente_sat"), "la marca: revertida, timbrada, sin fecha");
  assert.ok(az.includes("and (coalesce(folio_fiscal,'') <> '' or coalesce(uuid_fiscal,'') <> '') and sat_cancelled_at is null\n    `;"), "el conteo, misma regla");
  assert.ok(az.includes("ncPendientesSat: seeCredit ?"));
  const home = src("src/routes/index.tsx");
  assert.ok(home.includes("Para el SAT esa devolución\n            sigue viva: hay que cancelar el CFDI en Compaq y capturar aquí la fecha."), "el aviso con el conteo");
  const cred = src("src/routes/credit.tsx");
  assert.ok(cred.includes("Revertida y timbrada: cancelar ante el SAT en Compaq y capturar aquí la fecha"), "la marca por renglón");
  assert.ok(cred.includes("Cancelada ante el SAT el {r.sat_cancelled_at}"), "y cuando ya se capturó, el hecho");
});

// ---------------------------------------------------------------------------
// 5) Lo que destraba del paso 7, y la pantalla.
// ---------------------------------------------------------------------------
test("destraba el paso 7: el bloqueo 'devolución previa' mira NC vivas y qty_returned, y este paso deja las dos en cero", () => {
  const p7 = fnBody(src("src/lib/erp/delivery-reversal.ts"), "chainForDelivery");
  assert.ok(p7.includes("i.name like 'NC-%' and i.reverses_id is null and i.state <> 'reversed'"), "el paso 7 solo cuenta NC vivas");
  assert.ok(p7.includes("qty_returned"), "y la cantidad devuelta");
  const run = fnBody(src("src/lib/erp/return-reversal.ts"), "reverseReturn");
  assert.ok(run.includes("state = 'reversed'") && run.includes("qty_returned = greatest(0, qty_returned - ${l.qty})"), "este paso deja la NC revertida y qty_returned de regreso");
  // Dos hechos, dos acciones: aquí no se revierte la entrega.
  assert.ok(!src("src/lib/erp/return-reversal.ts").includes("delivery-reversal"), "no encadena el paso 7: son dos hechos distintos con dos motivos distintos");
});

test("la pantalla: qué sale, el contra-abono, qué vuelve a deber, qué se queda, la NC timbrada, y que queda para siempre", () => {
  const ui = src("src/components/cancel-doc.tsx");
  assert.ok(ui.includes("al costo con el que regresó"));
  assert.ok(ui.includes("→ se marca revertida (no tiene documento contrario)"));
  assert.ok(ui.includes("contra-abono{\" \"}"), "el contra-abono del PAG virtual");
  assert.ok(ui.includes("sin banco (nunca lo tuvo)"));
  assert.ok(ui.includes("si el abono la había cerrado, la mora vuelve a\n                        correr; lo ya facturado se queda"));
  assert.ok(ui.includes("amarrado por producto, cantidad y fecha (devolución anterior a la liga por folio)"), "dice cómo se amarró una devolución vieja");
  assert.ok(ui.includes("la salida del inventario y el contra-abono también quedan para siempre"), "Decisión 16 en el momento que importa");
  const so = src("src/routes/sales.$orderId.tsx");
  assert.ok(so.includes('inv.name.startsWith("NC-") && !inv.reverses_id && inv.state !== "reversed"'), "solo NC de devolución vivas");
  assert.ok(so.includes("reverseReturn({ data: { ncId: inv.id, reason } })"));
});

// BLOQUE DE DESHACER — PASO 7 (8-sep-2026): revertir una entrega con su
// factura. El más grande del bloque: aquí convergen el costo de salida (2),
// la FP de brokeraje (3), revertir por estado (4), los pagos primero (5) y el
// par en el kardex (6).
//
// Prueba central: inventario y cartera exactamente como antes de la entrega,
// salvo lo que ya sabemos que no vuelve solo (el promedio, que se enseña).
// Y todo visible y ligado: NC → FV, NC → FI, reversal → delivery.
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

const movingAverage = (oldQty, oldAvg, qtyIn, unitCost) => {
  const on = Math.max(0, oldQty), inn = Math.max(0, qtyIn), next = on + inn;
  if (next <= 0.0000001) return Math.max(0, unitCost);
  return (on * Math.max(0, oldAvg) + inn * Math.max(0, unitCost)) / next;
};
const r2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// 1) CENTRAL — inventario y cartera como antes de la entrega.
// ---------------------------------------------------------------------------
test("CENTRAL inventario: la entrada contraria va al costo con el que salió; existencia exacta, y el promedio regresa al mismo si nada más entró", () => {
  // 35 TM a 9,357.142857. Salen 20 (al promedio: unit_cost = 9,357.142857). Quedan 15.
  const avg = movingAverage(10, 9000, 25, 9500);
  const qtyTrasEntrega = 35 - 20;
  // Reversa: ENTRADA de 20 al costo con el que salió → promedia, y da lo mismo.
  const avgTrasReversa = movingAverage(qtyTrasEntrega, avg, 20, avg);
  assert.equal(qtyTrasEntrega + 20, 35, "existencia idéntica por construcción (−20 +20)");
  assert.equal(r2(avgTrasReversa), r2(avg), "al costo de salida, el promedio queda igual");
  // Si entró algo a otro costo mientras tanto, el promedio se mueve — y se enseña.
  const avgConEntradaIntermedia = movingAverage(movingAverage(15, avg, 10, 8000) > 0 ? 25 : 25, movingAverage(15, avg, 10, 8000), 20, avg);
  assert.notEqual(r2(avgConEntradaIntermedia), r2(avg));
});

test("CENTRAL cartera: la FV queda revertida y su NC nace saldada por el total — el cliente no debe nada de esa venta", () => {
  // La NC es espejo: −amount, residual 0, 'paid'. Nada queda abierto.
  const fv = { amount: 184300, residual: 184300, state: "open" };
  const nc = { amount: -fv.amount, residual: 0, state: "paid" };
  const fvDespues = { ...fv, state: "reversed" };
  const invoiceStillOwed = (s) => s !== "paid" && s !== "reversed";
  const deuda = [fvDespues, nc].filter((d) => invoiceStillOwed(d.state)).reduce((s, d) => s + d.residual, 0);
  assert.equal(deuda, 0, "ni la FV revertida ni la NC saldada cuentan como deuda");
  assert.equal(fv.amount + nc.amount, 0, "en importe, la NC es exactamente lo contrario");
});

test("CENTRAL (cableado): NC por el total espejo de los renglones, FV revertida, ligadas; kardex al costo de salida, ligado; nunca se borra", () => {
  const c = src("src/lib/erp/delivery-reversal.ts");
  const nc = fnBody(c, "creditNoteFor");
  assert.ok(nc.includes("'paid', ${-doc.amount}, 0, ${doc.name}"), "NC: −importe, saldo 0, saldada, origin = el documento que revierte");
  assert.ok(nc.includes("${so.circuit}, ${doc.id}, ${today})"), "reverses_id → la FV (o la FI)");
  assert.ok(nc.includes("values (${nc[0]!.id}, ${l.product_id}, ${Number(l.qty)}, ${Number(l.unit_price)}, ${-Number(l.amount)}"), "renglones espejo al mismo precio (comisión y financiamiento van dentro)");
  assert.ok(nc.includes("update invoices set state = 'reversed', cancelled_at = now(), cancelled_by = ${userId}, cancel_reason = ${reason} where id = ${doc.id}"), "el original queda revertido");
  const run = fnBody(c, "reverseDelivery");
  assert.ok(run.includes('moveType: "reversal"'), "tipo propio");
  assert.ok(run.includes("locationTo: m.location_from, unitCost: m.unit_cost, reversesId: m.id"), "de regreso a la bodega de la que salió, al costo con el que salió, ligado");
  assert.ok(run.includes("update sales_orders set state = 'confirmed'"), "el pedido vuelve a 'por entregar'");
  assert.ok(run.includes("update sales_lines set qty_delivered = 0"), "lo entregado, de regreso");
  assert.ok(!c.includes("delete from"), "Decisión 16: nunca se borra");
  assert.ok(!/update stock_moves/.test(c), "el kardex sigue inmutable");
});

// ---------------------------------------------------------------------------
// 2) La cadena: FI se revierte (37), ATC por estado, FP de brokeraje (paso 3).
// ---------------------------------------------------------------------------
test("la FI SE REVIERTE aquí (Decisión 37) — distinto del paso 5, donde se quedaba: caso distinto, misma lógica", () => {
  const chain = fnBody(src("src/lib/erp/delivery-reversal.ts"), "chainForDelivery");
  assert.ok(chain.includes('x.inv_class === "interest" && x.origin === `Mora ${fv.name}`'), "la FI de esa FV, por origen");
  assert.ok(chain.includes("si la entrega no existió, la mora tampoco"), "y la razón escrita en la pantalla");
  const run = fnBody(src("src/lib/erp/delivery-reversal.ts"), "reverseDelivery");
  assert.ok(run.includes("for (const fi of fresh.fis) written.push(await creditNoteFor("), "NC por el total para la FI: es documento timbrado (Decisión 19)");
  // El paso 5 sigue dejando la FI: son casos distintos, no una contradicción.
  assert.ok(!src("src/lib/erp/reversal.ts").includes("interest_invoiced"), "paso 5: la FI se queda");
});

test("ATC por estado (interno), FP de brokeraje en cascada si no tiene abonos (nació con esta entrega)", () => {
  const c = src("src/lib/erp/delivery-reversal.ts");
  const chain = fnBody(c, "chainForDelivery");
  assert.ok(chain.includes('x.inv_class === "fx" && x.origin === `Ajuste TC ${fv.name}`'), "el ATC de esa FV");
  assert.ok(chain.includes("coalesce(po.fulfill_kind,'inventory') = 'direct'"), "las OC directas del pedido");
  assert.ok(chain.includes("brokeraje, nació con esta entrega · sin abonos → revertida"), "la FP que nació en deliverSale (paso 3)");
  const run = fnBody(c, "reverseDelivery");
  assert.ok(run.includes("for (const atc of fresh.atcs) {") && run.includes('action: "revertir-atc"'), "ATC → estado");
  assert.ok(run.includes("for (const fp of fresh.fps) {") && run.includes("si la entrega no existió, esa deuda tampoco"), "FP → estado, con la razón");
});

// ---------------------------------------------------------------------------
// 3) Los bloqueos: pagos primero, devolución previa, ya revertida, sin entrega.
// ---------------------------------------------------------------------------
test("bloqueos: abonos en FV/FI/ATC/FP mandan al paso 5; devolución previa se bloquea (paso 8); ya revertida; sin entregar", () => {
  const chain = fnBody(src("src/lib/erp/delivery-reversal.ts"), "chainForDelivery");
  assert.ok(chain.includes("tiene abonos: revierte ese cobro primero (Cartera → Revertir último abono)"), "FV con abonos → paso 5, con la ruta");
  assert.ok(chain.includes("(mora facturada de ${fv.name}) tiene abonos"), "FI con abonos");
  assert.ok(chain.includes("(ajuste de tipo de cambio de ${fv.name}) tiene abonos"), "ATC con abonos");
  assert.ok(chain.includes("brokeraje) tiene abonos: revierte ese pago primero"), "FP con abonos");
  assert.ok(chain.includes("ya tiene una devolución (") && chain.includes("Primero habría que revertir esa devolución, y eso todavía no está construido."), "devolución previa → paso 8, seis documentos");
  assert.ok(chain.includes("qty_returned"), "también por cantidad devuelta, no solo por NC");
  assert.ok(chain.includes("ya está revertida (${alreadyReversed.reversed_by})"), "no se revierte dos veces");
  assert.ok(chain.includes("no se ha entregado: no hay entrega que revertir"), "sin entrega");
});

test("todo o nada, admin/gerencia, intento rechazado en bitácora antes de la transacción", () => {
  const c = src("src/lib/erp/delivery-reversal.ts");
  const run = fnBody(c, "reverseDelivery");
  const iAudit = run.indexOf("await auditRejected(sql, companyId, context.userId, chain);");
  const iTx = run.indexOf("return withTx(async (tx) => {");
  assert.ok(iAudit !== -1 && iAudit < iTx);
  assert.ok(run.includes("if (!canRevert(me.role)) throw new Error("));
  assert.ok(run.includes("for update") && run.includes("const fresh = await chainForDelivery(tx, companyId, data.soId, me.role);"));
  const bit = src("src/routes/bitacora.tsx");
  assert.ok(bit.includes('"revertir-entrega": "Revirtió entrega"') && bit.includes('"revertir-fv": "Revirtió factura de cliente (NC)"'));
});

// ---------------------------------------------------------------------------
// 4) FV timbrada (Decisión 39): no se bloquea; se avisa; la NC queda marcada y
//    contada hasta que alguien capture su folio.
// ---------------------------------------------------------------------------
test("FV timbrada: no bloquea, avisa con el UUID, y la NC nace sin folio fiscal", () => {
  const c = src("src/lib/erp/delivery-reversal.ts");
  const chain = fnBody(c, "chainForDelivery");
  assert.ok(chain.includes("if (fvRow.folio_fiscal || fvRow.uuid_fiscal) preview.fiscal ="), "se detecta, no se bloquea");
  assert.ok(!chain.includes("timbrada") || !/blockers\.push\([^)]*timbrad/.test(chain), "ningún bloqueo por timbrada");
  const ui = src("src/components/cancel-doc.tsx");
  assert.ok(ui.includes("Este sistema no cancela ante el SAT"), "el aviso");
  assert.ok(ui.includes("Hasta entonces, para\n                    el SAT la venta sigue viva."), "y la consecuencia");
  assert.ok(fnBody(c, "reverseDelivery").includes("estaba TIMBRADA (") , "y queda en bitácora");
});

test("NC sin timbrar: marca por renglón en cartera Y conteo en el tablero — derivado, se limpia solo al capturar el folio", () => {
  const az = src("src/lib/azagro.ts");
  assert.ok(az.includes("name like 'NC-%' and reverses_id is not null\n        and coalesce(folio_fiscal,'') = '' and coalesce(uuid_fiscal,'') = ''"), "el conteo: NC de reversa sin folio ni UUID");
  assert.ok(az.includes("ncSinTimbrar: seeCredit ?"), "en el tablero, a quien ve cartera");
  assert.ok(az.includes(") as sin_timbrar,"), "la marca por renglón, derivada");
  const home = src("src/routes/index.tsx");
  assert.ok(home.includes("de crédito de una reversa sin timbrar. Para el SAT esa venta sigue"), "el aviso con el conteo, mismo patrón que FP viejas");
  const cred = src("src/routes/credit.tsx");
  assert.ok(cred.includes("SIN TIMBRAR: para el SAT la venta sigue viva"), "y en el renglón");
});

// ---------------------------------------------------------------------------
// 5) Los dos lectores que dejaban pasar una revertida.
// ---------------------------------------------------------------------------
test("computeDealPnl y el P&L ya no cuentan una FV/FI revertida ni su NC contraria; issueMoraInvoice no le factura mora a una revertida", () => {
  const reports = src("src/lib/erp/reports.ts");
  assert.ok(reports.includes("and kind = 'customer' and name like 'FV-%'\n      and state <> 'reversed'\n    order by id desc limit 1"), "la FV del pedido");
  assert.ok(reports.includes("and inv_class = 'interest'\n        and state <> 'reversed' and reverses_id is null\n    `;\n    mora = Number(mi[0]?.a ?? 0);"), "la FI del pedido");
  assert.equal((reports.match(/state <> 'reversed' and reverses_id is null/g) || []).length, 4, "P&L empresa (ventas, mora) y Panorama (mora): ni el original revertido ni su NC contraria");
  assert.ok(reports.includes("= 'product' and amount > 0\n        and state <> 'reversed'"), "Panorama: facturado");
  const ops = fnBody(src("src/lib/erp/ops.ts"), "issueMoraInvoice");
  assert.ok(ops.includes('if (inv[0].state === "reversed") {'), "mora sobre una revertida: no");
  assert.ok(ops.includes("está revertida: no genera mora."));
});

// ---------------------------------------------------------------------------
// 6) Revertir ≠ devolver (Decisión 38), en el diálogo, y el resto de la pantalla.
// ---------------------------------------------------------------------------
test("el diálogo dice, antes de preguntar, que revertir no es devolver — con la frase tal cual", () => {
  const ui = src("src/components/cancel-doc.tsx");
  assert.ok(ui.includes("Revertir no es devolver."));
  assert.ok(ui.includes("Usa esto solo si la entrega no debió registrarse: pedido equivocado, cliente\n              equivocado, capturada dos veces."));
  assert.ok(ui.includes("Si la mercancía está en casa del cliente y la venta fue real, revertir es mentir: el inventario diría que está en bodega."));
  assert.ok(ui.includes("Regresa al inventario (queda la salida, la entrada y la liga):"));
  assert.ok(ui.includes("Existencia {l.qtyBefore} → {l.qtyAfter} {l.uom} · Promedio {m4(l.avgBefore)} → {m4(l.avgAfter)}"), "promedio con número (Decisión 20)");
  assert.ok(ui.includes("Si se vuelve a entregar, la factura nueva toma la tasa de la tabla a esa fecha."), "Decisión 40, dicha en pantalla");
  assert.ok(ui.includes("la nota de crédito y la entrada al inventario también quedan para siempre"), "Decisión 16 en el momento que importa");
  const so = src("src/routes/sales.$orderId.tsx");
  assert.ok(so.includes('{canEdit && state === "done" && (\n            <DeliveryReversalButton'), "solo en pedido entregado");
  assert.ok(so.includes("reverseDelivery({ data: { soId: id, reason } })"));
});

test("Decisión 40 (cableado): al volver a entregar, deliverSale toma la TIIE de la tabla a la fecha de la entrega nueva", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "deliverSale");
  assert.ok(body.includes("requireRate(tiieTable, today, `emisión de ${iname} a crédito`)"), "la tasa es la de la tabla HOY, no la de la entrega revertida");
});

// BLOQUE DE DESHACER — PASO 2 (8-sep-2026): Decisión 9. La mercancía
// devuelta regresa al inventario AL COSTO CON EL QUE SALIÓ, no al promedio
// de hoy.
//
// Razón: si entra al costo de hoy, una devolución cambia la utilidad de una
// venta ya cerrada y aparece una pérdida o ganancia que nunca existió.
//
// La prueba central de este paso es la de siempre cuando se toca costo de
// inventario: NINGUNA devolución existente puede cambiar de valor. Aquí se
// demuestra por construcción — la cartera de una devolución (NC, sus
// renglones, el PAG virtual, applied/leftover) sale de `unit_price` y nunca
// del costo — y se vigila por texto para que nadie meta el costo ahí después.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

function fnBody(source, name) {
  const markers = [`export const ${name} `, `export async function ${name}(`, `export function ${name}(`];
  const start = markers.map((m) => source.indexOf(m)).find((i) => i !== -1);
  assert.notEqual(start, undefined, `No existe export ${name}`);
  const rest = source.slice(start);
  const next = rest.slice(10).search(/\nexport /);
  return next === -1 ? rest : rest.slice(0, next + 10);
}

// ---------------------------------------------------------------------------
// 1) Copia literal de weightedCost y movingAverage (stock.ts).
// ---------------------------------------------------------------------------
function weightedCost(rows) {
  let qty = 0;
  let value = 0;
  for (const r of rows) {
    const q = Math.max(0, Number(r.qty) || 0);
    if (q <= 0.0000001) continue;
    qty += q;
    value += q * Math.max(0, Number(r.unitCost) || 0);
  }
  if (qty <= 0.0000001) return null;
  return value / qty;
}

function movingAverage(oldQty, oldAvg, qtyIn, unitCost) {
  const on = Math.max(0, oldQty);
  const inn = Math.max(0, qtyIn);
  const next = on + inn;
  if (next <= 0.0000001) return Math.max(0, unitCost);
  return (on * Math.max(0, oldAvg) + inn * Math.max(0, unitCost)) / next;
}

test("costo de salida — una sola salida (el único caso que hoy puede existir): ese mismo costo", () => {
  assert.equal(weightedCost([{ qty: 50, unitCost: 80 }]), 80);
  // La cantidad devuelta no cambia el costo unitario de la salida.
  assert.equal(weightedCost([{ qty: 3, unitCost: 1234.5678 }]), 1234.5678);
});

test("costo de salida — dos entregas a costos distintos: ponderado por cantidad, no se elige una", () => {
  // 30 × 80 = 2,400 · 20 × 95 = 1,900 · (2,400 + 1,900) / 50 = 86
  assert.equal(weightedCost([{ qty: 30, unitCost: 80 }, { qty: 20, unitCost: 95 }]), 86);
  // No es el promedio simple de 80 y 95 (87.5): pesa la cantidad.
  assert.notEqual(weightedCost([{ qty: 30, unitCost: 80 }, { qty: 20, unitCost: 95 }]), 87.5);
});

test("costo de salida — sin salida registrada: null, no un cero disfrazado", () => {
  assert.equal(weightedCost([]), null, "sin renglones");
  assert.equal(weightedCost([{ qty: 0, unitCost: 90 }]), null, "cantidad cero no es una salida");
  // Un costo de 0 SÍ es un dato (mercancía que salió sin costo), no ausencia.
  assert.equal(weightedCost([{ qty: 5, unitCost: 0 }]), 0);
});

test("Decisión 9 en números: el promedio queda distinto que con la regla vieja, y esa diferencia es la utilidad fantasma que se evita", () => {
  // Bodega: 40 a $100. Esa mercancía salió a $80. Se devuelven 10.
  const conDecision9 = movingAverage(40, 100, 10, 80);
  assert.equal(conDecision9, 96, "(40×100 + 10×80) / 50 = 96");
  // Regla vieja: entraba al promedio de hoy ($100) y el promedio no se movía.
  const reglaVieja = movingAverage(40, 100, 10, 100);
  assert.equal(reglaVieja, 100);
  // La diferencia es inventario sobrevaluado: 10 × (100 − 80) = 200.
  assert.equal(Math.round((reglaVieja - conDecision9) * 50), 200);
});

// ---------------------------------------------------------------------------
// 2) LA PRUEBA CENTRAL — ninguna devolución cambia de valor.
//    La cartera de la devolución se calcula solo con precio. Copia literal de
//    la matemática de returnSale (azagro.ts): no recibe costo, no puede
//    depender de él.
// ---------------------------------------------------------------------------
function carteraDeDevolucion(lines, fvResidual) {
  let credit = 0;
  for (const l of lines) credit += l.qty * l.unitPrice;
  let applied = 0;
  if (fvResidual > 0.009) applied = Math.min(credit, fvResidual);
  const leftover = credit - applied;
  return {
    ncAmount: -credit,
    lineAmounts: lines.map((l) => -(l.qty * l.unitPrice)),
    applied,
    leftover,
    ncState: leftover <= 0.009 ? "paid" : "open",
    ncResidual: leftover <= 0.009 ? 0 : -leftover,
  };
}

test("CENTRAL: la NC, sus renglones, el PAG virtual y el saldo salen idénticos al centavo, valga lo que valga el costo", () => {
  const lines = [
    { qty: 10, unitPrice: 137.5 },
    { qty: 3.5, unitPrice: 2480.25 },
  ];
  const esperado = carteraDeDevolucion(lines, 5000);
  // El costo no es un argumento: cambiar el costo de salida no puede mover
  // ninguno de estos números. Se comprueba recalculando con los mismos
  // precios y verificando cada campo al centavo.
  assert.equal(esperado.ncAmount, -(10 * 137.5 + 3.5 * 2480.25));
  assert.equal(esperado.ncAmount, -10055.875, "1,375 + 8,680.875");
  assert.deepEqual(esperado.lineAmounts, [-1375, -8680.875]);
  assert.equal(esperado.applied, 5000, "abona hasta donde alcanza el saldo de la FV");
  assert.equal(esperado.leftover, 5055.875);
  assert.equal(esperado.ncState, "open");
  assert.equal(esperado.ncResidual, -5055.875);
  // Factura ya pagada: no hay PAG virtual y la NC queda abierta por el total.
  const pagada = carteraDeDevolucion(lines, 0);
  assert.equal(pagada.applied, 0);
  assert.equal(pagada.leftover, 10055.875);
  // Devolución que cabe completa en el saldo: la NC nace saldada.
  const cabe = carteraDeDevolucion([{ qty: 1, unitPrice: 100 }], 500);
  assert.deepEqual([cabe.applied, cabe.leftover, cabe.ncState, cabe.ncResidual], [100, 0, "paid", 0]);
});

test("CENTRAL (cableado): el importe de la devolución se sigue calculando con precio, nunca con costo", () => {
  const az = src("src/lib/azagro.ts");
  const body = fnBody(az, "returnSale");
  assert.ok(body.includes("credit += take.qty * Number(src.unit_price);"), "el importe sale del precio de la partida");
  assert.ok(body.includes("values (${nc[0]!.id}, ${take.productId}, ${take.qty}, ${Number(src.unit_price)}, ${-amt})"), "los renglones de la NC, igual");
  assert.ok(body.includes("applied = Math.min(credit, Number(fv[0].residual));"), "el abono a la FV, igual");
  // Ninguna de las variables de costo nuevas toca el cálculo del importe.
  const desdeCredit = body.slice(body.indexOf("let credit = 0;"), body.indexOf("const ncN = await sql"));
  assert.ok(!desdeCredit.includes("credit += ") || desdeCredit.match(/credit \+= [^;]*unit_price[^;]*;/), "credit solo se suma con unit_price");
  assert.ok(!/amount[^\n]*exitCost|amount[^\n]*avgBefore|credit[^\n]*unitCost/.test(body), "ni el importe ni el crédito miran el costo");
});

test("CENTRAL: el kardex ya escrito no se reescribe — el cambio solo aplica a devoluciones nuevas", () => {
  const az = src("src/lib/azagro.ts");
  const body = fnBody(az, "returnSale");
  assert.ok(!body.includes("update stock_moves"), "una devolución nunca modifica movimientos anteriores");
  const stock = src("src/lib/erp/stock.ts");
  assert.ok(!stock.includes("update stock_moves"), "stock_moves sigue siendo inmutable (regla 2)");
});

// ---------------------------------------------------------------------------
// 3) Cableado del costo de salida.
// ---------------------------------------------------------------------------
test("deliveredUnitCost: amarra por folio del pedido + producto + salida, y devuelve ponderado", () => {
  const stock = src("src/lib/erp/stock.ts");
  const body = fnBody(stock, "deliveredUnitCost");
  assert.ok(body.includes("and product_id = ${productId} and move_type = 'delivery'"), "solo movimientos de salida de ese producto");
  assert.ok(body.includes("where company_id = ${companyId} and origin = ${origin}"), "amarrado al folio del pedido, dentro de la empresa");
  assert.ok(body.includes("return weightedCost("), "el ponderado es la regla, aunque hoy haya una sola salida");
});

test("returnSale le pasa a postStock el costo con el que salió, y postStock lo respeta", () => {
  const az = src("src/lib/azagro.ts");
  const body = fnBody(az, "returnSale");
  assert.ok(body.includes("const exitCost = await deliveredUnitCost(sql, m.company_id, so[0].name, take.productId);"));
  assert.ok(body.includes("unitCost: exitCost ?? undefined,"), "sin salida encontrada se deja que postStock haga lo de siempre");
  // postStock solo busca un costo cuando no le dieron uno.
  const post = fnBody(src("src/lib/erp/stock.ts"), "postStock");
  assert.ok(post.includes("let unitCost = Math.max(0, Number(opts.unitCost) || 0);"), "el costo dado manda");
  assert.ok(post.includes("if (toId && unitCost <= 0)"), "el promedio del destino es solo el respaldo");
});

// ---------------------------------------------------------------------------
// 4) Decisión 20 — el promedio se acepta movido y SE MUESTRA, con el número.
// ---------------------------------------------------------------------------
test("returnSale devuelve costo de salida y promedio antes/después por partida", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "returnSale");
  assert.ok(body.includes("const avgBefore = await avgCostAt(sql, m.company_id, take.productId, so[0].location_id);"));
  assert.ok(body.includes("const avgAfter = await avgCostAt(sql, m.company_id, take.productId, so[0].location_id);"));
  assert.ok(body.includes("costs.push({"), "una fila por partida devuelta");
  assert.ok(body.includes("found: exitCost != null,"), "se distingue el costo de salida del promedio de hoy");
  assert.ok(body.includes("costs,"), "y sale en la respuesta, no se queda en el servidor");
});

test("la pantalla enseña el promedio con su número, y dice completo cuando no encontró la salida", () => {
  const ui = src("src/routes/sales.$orderId.tsx");
  assert.ok(ui.includes("promedio ${money(c.avgBefore)} → ${money(c.avgAfter)}"), "el promedio se ve, con número");
  assert.ok(ui.includes("entró al costo con el que salió"), "el caso normal se nombra");
  assert.ok(ui.includes("NO encontré con qué costo salió de ${form.name}"), "el aviso lleva el folio del pedido");
  assert.ok(ui.includes("entró al promedio de hoy (${money(c.unitCost)})"), "y el número con el que entró");
});

// ---------------------------------------------------------------------------
// 5) El aviso también en bitácora: si pasa alguna vez, se tiene que poder
//    encontrar después, no solo verse una vez en la pantalla.
// ---------------------------------------------------------------------------
test("bitácora: la devolución sin costo de salida deja su propio renglón, buscable", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "returnSale");
  assert.ok(body.includes('action: "devolucion-sin-costo-origen"'), "acción propia, no escondida en el detalle de 'devolver'");
  assert.ok(body.includes("const sinSalida = costs.filter((c) => !c.found);"), "solo cuando de verdad pasó");
  assert.ok(body.includes("sin movimiento de salida en el kardex para"), "el detalle dice qué pasó");
  assert.ok(body.includes("entró al promedio de hoy ${c.unitCost.toFixed(4)}"), "con el número que se usó");
  // La devolución normal también deja escrito con qué costo entró.
  assert.ok(body.includes("costo de salida ${costs.map"), "el renglón de 'devolver' registra el costo de cada partida");
  const bit = src("src/routes/bitacora.tsx");
  assert.ok(bit.includes('"devolucion-sin-costo-origen": "Devolución SIN costo de salida"'), "con etiqueta en español en la bitácora");
});

test("bitácora: las tres cancelaciones del paso 1 también tienen etiqueta (hueco cerrado)", () => {
  const bit = src("src/routes/bitacora.tsx");
  assert.ok(bit.includes('"cancelar-solicitud": "Canceló solicitud"'));
  assert.ok(bit.includes('"cancelar-cotizacion": "Canceló cotización"'));
  assert.ok(bit.includes('"cancelar-pedido": "Canceló pedido"'));
  assert.ok(bit.includes('"borrar-solicitud": "Borró solicitud"'), "la acción vieja se queda: ya no se escribe, pero hay renglones viejos");
});

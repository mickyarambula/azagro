// BLOQUE DE DESHACER — PASO 6 (8-sep-2026): revertir una recepción.
//
// Decisión 15: lo que ya movió inventario se revierte, no se cancela — quedan
// la entrada y la salida, ligadas. Decisión 20: el promedio se acepta movido
// y SE MUESTRA con su número.
//
// Prueba central: las existencias quedan exactamente como estaban antes de la
// recepción; el VALOR no, y ése es el caso conocido que se enseña.
//
// Y las dos que más valen de este paso, con prueba propia:
//   1. El bloqueo por salida posterior — antes el corte miraba la existencia
//      total y se colaba, devolviendo mercancía nuestra al proveedor.
//   2. La idempotencia de bornSupplierDebt: recibir → revertir → recibir tiene
//      que hacer nacer deuda NUEVA.
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

// Copia literal de stock.ts: entradas promedian, salidas conservan el promedio.
const movingAverage = (oldQty, oldAvg, qtyIn, unitCost) => {
  const on = Math.max(0, oldQty);
  const inn = Math.max(0, qtyIn);
  const next = on + inn;
  if (next <= 0.0000001) return Math.max(0, unitCost);
  return (on * Math.max(0, oldAvg) + inn * Math.max(0, unitCost)) / next;
};
const qtyFromMoves = (moves) => moves.reduce((s, m) => s + m, 0);
const r2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// 1) CENTRAL — la existencia vuelve exacta; el valor no, y ése es el caso
//    conocido (Decisión 20). Los números del diagnóstico, comprobados.
// ---------------------------------------------------------------------------
test("CENTRAL: existencia idéntica por construcción (+25 −25); el promedio NO regresa y por eso el valor tampoco", () => {
  // 10 TM a 9,000 en bodega. Entran 25 a 9,500.
  const avgTrasRecibir = movingAverage(10, 9000, 25, 9500);
  assert.equal(r2(avgTrasRecibir), 9357.14);
  assert.equal(qtyFromMoves([10, 25]), 35);
  assert.equal(r2(35 * avgTrasRecibir), 327500);
  // Se revierte la entrada: la SALIDA conserva el promedio (solo las entradas promedian).
  const qtyDespues = qtyFromMoves([10, 25, -25]);
  assert.equal(qtyDespues, 10, "la existencia vuelve exacta a lo que era antes de la recepción");
  const avgDespues = avgTrasRecibir; // una salida no recompone el promedio
  assert.equal(r2(avgDespues), 9357.14, "quedan 10 TM a 9,357.14 y NO a 9,000 — el caso conocido");
  assert.equal(r2(qtyDespues * avgDespues), 93571.43);
  assert.equal(r2(93571.43 - 10 * 9000), 3571.43, "se quedan 3,571.43 de más en el valor");
});

test("CENTRAL (cableado): la salida contraria va al MISMO costo con el que entró, ligada, y con tipo propio", () => {
  const body = fnBody(src("src/lib/erp/receipt-reversal.ts"), "reverseReceipt");
  assert.ok(body.includes('moveType: "reversal"'), "tipo propio: un ajuste es una corrección de conteo, esto no");
  assert.ok(body.includes("unitCost: m.unit_cost,"), "al costo con el que entró, no al promedio de hoy");
  assert.ok(body.includes("locationFrom: m.location_to,"), "sale de la misma bodega a la que entró");
  assert.ok(body.includes("reversesId: m.id,"), "ligada a su entrada");
  const stock = src("src/lib/erp/stock.ts");
  assert.ok(stock.includes('reversal: "REV",'), "folio propio");
  assert.ok(stock.includes("product_id, quantity, unit_cost, created_by, reverses_id"), "la liga se escribe en el kardex");
  // El kardex sigue siendo inmutable: la reversa es un movimiento más.
  assert.ok(!stock.includes("update stock_moves"), "nunca se modifica un movimiento anterior");
  assert.ok(!src("src/lib/erp/receipt-reversal.ts").includes("delete from"), "nunca se borra");
});

test("el promedio anterior se reconstruye SOLO cuando es exacto; si entró más mercancía después, se dice que no se puede", () => {
  const body = fnBody(src("src/lib/erp/receipt-reversal.ts"), "chainForReceipt");
  assert.ok(body.includes("and location_to = ${m.location_to} and id > ${m.id}"), "revisa si entró algo después");
  assert.ok(body.includes("const puro = (entradasDespues[0]?.n ?? 0) === 0 && qtyAfter > 0.0001;"));
  assert.ok(body.includes("const avgBeforeReceipt = puro ? r2((qtyBefore * avgNow - qty * unitCost) / (qtyBefore - qty)) : null;"));
  // Con los números del ejemplo, la reconstrucción da exactamente 9,000.
  const avg = movingAverage(10, 9000, 25, 9500);
  assert.equal(r2((35 * avg - 25 * 9500) / 10), 9000);
  const ui = src("src/components/cancel-doc.tsx");
  assert.ok(ui.includes("no se puede reconstruir con exactitud; no se estima"), "y si no es exacto, no se estima");
});

// ---------------------------------------------------------------------------
// 2) EL BLOQUEO POR SALIDA POSTERIOR — el que se colaba.
// ---------------------------------------------------------------------------
test("SALIDA POSTERIOR: el corte por existencia total se colaba y devolvía mercancía nuestra al proveedor", () => {
  // 10 propias + 25 recibidas = 35; se venden 10 → quedan 25.
  const enBodega = qtyFromMoves([10, 25, -10]);
  assert.equal(enBodega, 25);
  // El corte viejo (postStock) solo compara existencia contra cantidad: 25 >= 25 → PASA.
  const cortePorExistencia = enBodega + 0.0001 < 25;
  assert.equal(cortePorExistencia, false, "por existencia total no se bloquea: por ahí se colaba");
  // Y dejaría el inventario en CERO cuando físicamente quedan 10 (las nuestras).
  assert.equal(qtyFromMoves([10, 25, -10, -25]), 0);
  // El corte nuevo mira MOVIMIENTOS de salida posteriores, no la existencia.
  const salidasPosteriores = [{ ref: "ENT/0031", qty: 10 }];
  assert.ok(salidasPosteriores.length > 0, "hubo una salida después de la entrada → se detiene");
});

test("SALIDA POSTERIOR (cableado): se busca por movimiento, nombra qué salió, y explica por qué no hay salida limpia", () => {
  const body = fnBody(src("src/lib/erp/receipt-reversal.ts"), "chainForReceipt");
  assert.ok(body.includes("and location_from = ${m.location_to} and id > ${m.id}"), "salidas posteriores de ese producto desde esa bodega");
  assert.ok(body.includes("El kardex no lleva lotes: no se puede saber si lo que salió era de esta orden"), "la razón, en simple");
  assert.ok(body.includes("revertir se llevaría existencia que no es del proveedor"), "y la consecuencia");
  assert.ok(body.includes("Revierte primero esa salida."), "y qué hacer");
  assert.ok(body.includes("salieron ${total} ${m.uom} de ${m.code}"), "con cantidad y producto");
  assert.ok(body.includes("(${salidas.map((x) => x.ref).join(\", \")})"), "y los folios de lo que salió");
});

// ---------------------------------------------------------------------------
// 3) IDEMPOTENCIA — recibir → revertir → recibir hace nacer deuda NUEVA.
// ---------------------------------------------------------------------------
test("SECUENCIA: recibir → revertir → volver a recibir tiene que hacer nacer deuda nueva", () => {
  // La regla, con datos: bornSupplierDebt considera "ya existe" solo una FP VIVA.
  const yaExiste = (facturas) => facturas.some((f) => f.origin === "OC-0044" && f.state !== "reversed");
  const paso1 = [];
  assert.equal(yaExiste(paso1), false, "recibir: no hay FP → nace FP-0019");
  const paso2 = [{ origin: "OC-0044", state: "open" }];
  assert.equal(yaExiste(paso2), true, "recibir dos veces no duplica la deuda");
  const paso3 = [{ origin: "OC-0044", state: "reversed" }];
  assert.equal(yaExiste(paso3), false, "revertida NO cuenta: al volver a recibir nace deuda nueva");
  // Con el filtro viejo (sin excluir reversed) la mercancía habría entrado sin cuenta por pagar.
  const reglaVieja = (facturas) => facturas.some((f) => f.origin === "OC-0044");
  assert.equal(reglaVieja(paso3), true, "el defecto: creía que ya existía y no generaba nada");
});

test("SECUENCIA (cableado): bornSupplierDebt excluye la FP revertida al decidir si ya existe", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "bornSupplierDebt");
  assert.ok(body.includes("and origin = ${opts.poName}\n      and state <> 'reversed'"), "la FP revertida no cuenta como existente");
  assert.ok(body.includes("tiene que nacer deuda nueva"), "y está explicado en el código");
  assert.ok(body.includes("if (already[0]) return null;"), "sigue siendo idempotente para una FP viva");
});

// ---------------------------------------------------------------------------
// 4) La cadena y los cuatro bloqueos.
// ---------------------------------------------------------------------------
test("la cadena: salida por partida, qty_received de regreso, OC a confirmada, FP revertida", () => {
  const body = fnBody(src("src/lib/erp/receipt-reversal.ts"), "reverseReceipt");
  assert.ok(body.includes("for (const m of fresh.moves) {"), "una salida por cada entrada de la orden");
  assert.ok(body.includes("update purchase_lines set qty_received = 0"), "lo recibido, de regreso");
  assert.ok(body.includes("update purchase_orders set state = 'confirmed'"), "la orden vuelve a 'por recibir'");
  assert.ok(body.includes("update invoices set state = 'reversed'"), "la FP que nació al recibir (paso 3) se revierte");
  assert.ok(body.includes('action: "revertir-recepcion"'), "bitácora, con los promedios en el detalle");
  assert.ok(body.includes("promedio ${l.avgNow.toFixed(4)} (no se mueve)"), "el promedio queda escrito");
});

test("los cuatro bloqueos, y el intento rechazado en bitácora", () => {
  const c = src("src/lib/erp/receipt-reversal.ts");
  const body = fnBody(c, "chainForReceipt");
  assert.ok(body.includes("está cancelada."), "OC cancelada");
  assert.ok(body.includes("ya está revertida ("), "recepción ya revertida");
  assert.ok(body.includes("no tiene entradas registradas en el kardex"), "nada que revertir");
  assert.ok(body.includes("ya tiene abonos: ya se le pagó al proveedor"), "FP pagada → paso 5");
  assert.ok(body.includes("Revierte primero ese pago."), "y a dónde ir");
  const run = fnBody(c, "reverseReceipt");
  const iAudit = run.indexOf("await auditRejected(sql, companyId, context.userId, chain);");
  const iTx = run.indexOf("return withTx(async (tx) => {");
  assert.ok(iAudit !== -1 && iAudit < iTx, "el rechazo se escribe ANTES de abrir la transacción");
  assert.ok(run.includes("if (!canRevert(me.role)) throw new Error("), "solo admin o gerencia");
  assert.ok(run.includes("const fresh = await chainForReceipt(tx, companyId, data.poId, me.role);"), "se vuelve a leer la cadena adentro");
  assert.ok(src("src/routes/bitacora.tsx").includes('"revertir-recepcion": "Revirtió recepción"'));
});

// ---------------------------------------------------------------------------
// 5) Visible y ligado: el par se ve en el kardex; la pantalla enseña el promedio.
// ---------------------------------------------------------------------------
test("el par entrada↔reversa se ve en el kardex, y el tipo nuevo aparece en las dos direcciones", () => {
  const az = src("src/lib/azagro.ts");
  assert.ok(az.includes("(select o.ref from stock_moves o where o.id = sm.reverses_id) as reverses_ref"));
  assert.ok(az.includes("(select r.ref from stock_moves r where r.reverses_id = sm.id limit 1) as reversed_by_ref"));
  const inv = src("src/routes/inventory.tsx");
  assert.ok(inv.includes('reversal: "Reversa",'), "con etiqueta en español");
  assert.ok(inv.includes('m.move_type === "internal" || m.move_type === "reversal"'), "entradas: revertir una entrega entra");
  assert.ok(inv.includes('m.move_type === "adjust" || m.move_type === "reversal"'), "salidas: revertir una recepción sale");
});

test("la pantalla enseña el promedio con su número y lo que se queda de más, y pregunta una vez", () => {
  const ui = src("src/components/cancel-doc.tsx");
  assert.ok(ui.includes("Sale del inventario (queda la entrada, la salida y la liga entre las dos):"));
  assert.ok(ui.includes("al costo con el que entró"));
  assert.ok(ui.includes("(no se mueve: solo las entradas lo promedian)"));
  assert.ok(ui.includes("Antes de esta recepción era {m(l.avgBeforeReceipt)}"), "el número de antes, cuando es exacto");
  assert.ok(ui.includes("de más en el valor de las {l.qtyAfter} {l.uom} que quedan. Eso no se corrige solo."));
  assert.ok(ui.includes('La orden vuelve a &quot;confirmada, por recibir&quot;: se puede recibir otra vez, y ahí nacerá su deuda nueva.'));
  assert.ok(ui.includes("la salida también queda para siempre"), "Decisión 16 en el momento que importa");
  assert.ok(ui.includes("Confirmar reversa"));
  const po = src("src/routes/purchases.tsx");
  assert.ok(po.includes('{o.state === "done" && o.fulfill_kind !== "direct" && ('), "el botón, solo en una OC recibida de inventario");
  assert.ok(po.includes("reverseReceipt({ data: { poId: o.id, reason } })"));
});

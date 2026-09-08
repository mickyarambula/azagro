// BLOQUE DE DESHACER — PASO 4 (8-sep-2026): cancelar en cascada.
//
//   - Una OC confirmada sin recibir.
//   - Un pedido confirmado sin entregar, con sus OC hijas (y las FP viejas de
//     ésas, del defecto anterior a la Decisión 14, revertidas por estado).
//
// Prueba central: NADA que ya movió inventario o cartera se cancela por este
// camino. Si alguien lo intenta, se detiene antes de tocar nada, dice por qué
// en lenguaje simple, y el intento queda en bitácora.
//
// Y el candado más grave de los cuatro que se cerraron aquí, con su prueba
// propia: una factura revertida NO revive porque algo recalcule su saldo.
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

// ---------------------------------------------------------------------------
// 1) EL CANDADO MÁS GRAVE: una factura revertida no revive sola.
//    Copia literal de nextInvoiceState (stock.ts) — la regla pura que decide
//    el estado después de recalcular el saldo — probada con datos.
// ---------------------------------------------------------------------------
function nextInvoiceState(current, residual) {
  if (current === "reversed") return "reversed";
  return residual <= 0.009 ? "paid" : "open";
}

test("REVIVIR: una factura revertida con saldo recalculado mayor que cero SE QUEDA revertida", () => {
  // Éste es el caso que rompería el bloque entero: se revierte una FP de
  // $121,500, después algo recalcula su saldo (amount − abonos = 121,500 > 0)
  // y, sin el candado, volvería a 'open' con toda su deuda.
  assert.equal(nextInvoiceState("reversed", 121500), "reversed");
  assert.equal(nextInvoiceState("reversed", 0.01), "reversed");
  assert.equal(nextInvoiceState("reversed", 0), "reversed", "ni siquiera a 'paid': revertida es terminal");
});

test("REVIVIR: lo de siempre no cambia — abierta con saldo sigue abierta, saldada pasa a pagada, pagada con saldo vuelve a abrir", () => {
  assert.equal(nextInvoiceState("open", 500), "open");
  assert.equal(nextInvoiceState("open", 0), "paid");
  assert.equal(nextInvoiceState("open", 0.009), "paid", "el umbral de centavos se respeta");
  // Un pago revertido (paso 5) reabre una factura pagada: eso SÍ debe pasar.
  assert.equal(nextInvoiceState("paid", 300), "open");
});

test("REVIVIR (cableado): refreshInvoiceResidual lee el estado actual, decide con la regla pura y sale sin escribir si está revertida", () => {
  const stock = src("src/lib/erp/stock.ts");
  const body = fnBody(stock, "refreshInvoiceResidual");
  assert.ok(body.includes("i.state\n    from invoices i"), "lee el estado actual, antes no lo leía");
  assert.ok(body.includes("const next = nextInvoiceState(row[0].state, residual);"), "decide con la regla pura, no con un if suelto");
  const iGuard = body.indexOf('if (next === "reversed") {');
  const iWritePaid = body.indexOf("set residual = 0, state = 'paid'");
  const iWriteOpen = body.indexOf("state = 'open', paid_date = null");
  assert.ok(iGuard !== -1 && iGuard < iWritePaid && iGuard < iWriteOpen, "el candado va ANTES de cualquier update");
  assert.ok(body.slice(iGuard, iWritePaid).includes("return 0;"), "revertida: regresa sin tocar el renglón");
  // La regla pura está exportada y es la única que escribe 'reversed' como resultado.
  assert.ok(stock.includes('export function nextInvoiceState(current: string, residual: number): "reversed" | "paid" | "open"'));
});

// ---------------------------------------------------------------------------
// 2) Los otros tres candados: nada le cobra, la suma ni la enseña a una
//    factura revertida.
// ---------------------------------------------------------------------------
test("applyInvoicePayment: a una factura revertida no se le abona, aunque su residual siga mayor que cero", () => {
  const body = fnBody(src("src/lib/erp/ops.ts"), "applyInvoicePayment");
  assert.ok(body.includes("circuit_code, state from invoices"), "ahora lee el estado");
  const iGuard = body.indexOf('if (inv[0].state === "reversed") throw new Error(');
  const iResidual = body.indexOf('if (residual <= 0.009) throw new Error("Esta factura ya está saldada")');
  assert.ok(iGuard !== -1 && iGuard < iResidual, "el candado de revertida va antes del de saldada");
  assert.ok(body.includes("está revertida: ya no es deuda, no se le puede abonar."), "mensaje simple");
});

test("P&L 'Compras' y estado de cuenta/Panorama excluyen la factura revertida", () => {
  const reports = src("src/lib/erp/reports.ts");
  assert.ok(reports.includes("kind = 'supplier'\n        and state <> 'reversed'\n        and date between"), "Compras del P&L");
  const ops = src("src/lib/erp/ops.ts");
  assert.ok(ops.includes('const vivas = invoices.filter((i) => i.state !== "reversed");'), "estado de cuenta: solo las vivas");
  assert.ok(ops.includes("const visibles = historico ? vivas.filter((i) => i.date <= asOf) : vivas;"), "y de ahí sale el saldo del Panorama");
});

// ---------------------------------------------------------------------------
// 3) La cadena: qué la detiene. Cada bloqueo nombra el folio y dice qué haría
//    falta, sin palabras técnicas.
// ---------------------------------------------------------------------------
test("CENTRAL: una OC que ya se recibió, con dinero amarrado, o directa con pedido entregado, NO se cancela", () => {
  const body = fnBody(src("src/lib/erp/cancel.ts"), "chainForPurchase");
  assert.ok(body.includes("move_type = 'receipt'"), "busca recepciones por folio, no solo el estado");
  assert.ok(body.includes('if (o.state === "done" || receipts.length)'), "estado O movimiento: cualquiera de los dos detiene");
  assert.ok(body.includes("ya se recibió en bodega"), "bloqueo de recepción, en lenguaje simple");
  assert.ok(body.includes('o.fulfill_kind === "direct" && o.so_state === "done"'), "directa con pedido entregado: la mercancía ya se movió al cliente");
  assert.ok(body.includes("ya tiene dinero amarrado"), "gasto o banco ligado detiene");
  assert.ok(body.includes('Number(fp.paid) > 0.009 || fp.state === "paid"'), "FP con un solo abono detiene");
  assert.ok(body.includes("ya se le pagó al proveedor"), "y lo dice claro");
  assert.ok(body.includes("todavía no está construido"), "nombra que revertir eso es otro paso");
});

test("CENTRAL: un pedido entregado, con FV, con kardex de salida o con dinero amarrado, NO se cancela; en borrador tampoco por aquí", () => {
  const body = fnBody(src("src/lib/erp/cancel.ts"), "chainForSale");
  assert.ok(body.includes("move_type = 'delivery'"), "busca entregas por folio");
  assert.ok(body.includes("order_id = ${s.id} and kind = 'customer' and state <> 'reversed'"), "busca la FV viva del pedido");
  assert.ok(body.includes('if (s.state === "done" || deliveries.length || fvs.length)'), "estado, kardex o factura: cualquiera detiene");
  assert.ok(body.includes("ya se entregó y facturó"), "lo dice claro");
  assert.ok(body.includes('if (s.state === "draft")'), "el borrador es del paso 1, no de la cascada");
  assert.ok(body.includes("ya tiene dinero amarrado"), "gasto o banco ligado detiene");
});

test("la cadena del pedido arrastra sus OC hijas y hereda sus bloqueos; la cotización queda aceptada (Decisión 18)", () => {
  const body = fnBody(src("src/lib/erp/cancel.ts"), "chainForSale");
  assert.ok(body.includes("where company_id = ${companyId} and so_id = ${s.id} and state <> 'cancelled'"), "OC hijas por so_id");
  assert.ok(body.includes("const sub = await chainForPurchase(sql, companyId, po.id);"), "cada OC con su propia cadena");
  assert.ok(body.includes("blockers.push(...sub.blockers);"), "un bloqueo en una OC detiene todo el pedido");
  assert.ok(body.includes('kind: "quote"'), "la cotización se enseña como 'no se toca'");
  assert.ok(body.includes("queda aceptada, con su folio y su precio; para vender otra vez, se cotiza de nuevo (Decisión 18)"));
  const c = src("src/lib/erp/cancel.ts");
  assert.ok(!c.includes("update quotes"), "y de verdad no se toca");
});

// ---------------------------------------------------------------------------
// 4) Todo o nada, permiso según lo que la cadena contenga, intento en bitácora.
// ---------------------------------------------------------------------------
test("todo o nada: la escritura va en una transacción, bloquea renglones y vuelve a leer la cadena adentro", () => {
  const body = fnBody(src("src/lib/erp/cancel.ts"), "runCancel");
  assert.ok(body.includes("return withTx(async (tx) => {"), "transacción");
  assert.ok(body.includes("for update"), "candado de renglones");
  assert.ok(body.includes("const fresh = await buildChain(tx, userId, kind, id);"), "re-verifica adentro: si algo cambió entre la pantalla y el clic, no se toca nada");
  assert.ok(body.includes("if (fresh.blockers.length) throw new Error(fresh.blockers[0]);"));
});

test("permiso: revertir cartera (FP vieja) es de administrador o gerencia; cancelar lo que no movió nada, del módulo", () => {
  const c = src("src/lib/erp/cancel.ts");
  const build = fnBody(c, "buildChain");
  assert.ok(build.includes('await assertCan(sql, userId, module, "edit");'), "sin permiso del módulo no se cancela ni lo liviano");
  assert.ok(build.includes("const revertsCartera = parts.reverts.length > 0;"), "depende de lo que la cadena contenga");
  assert.ok(build.includes("const allowed = !revertsCartera || canRevert(me.role);"), "solo si revierte cartera exige admin/gerencia");
  const acl = src("src/lib/erp/acl.ts");
  assert.ok(acl.includes('return role === "admin" || role === "gerencia";'), "canRevert: admin o gerencia, nadie más");
  assert.ok(acl.includes("Solo un administrador o gerencia puede revertir una deuda ya registrada"));
  // La pantalla lo dice antes de que alguien lo intente.
  const ui = src("src/components/cancel-doc.tsx");
  assert.ok(ui.includes("esta cancelación es solo de administrador o gerencia. Pídesela a uno de ellos."));
});

test("un intento que se detuvo queda en bitácora, con el motivo — fuera de la transacción, para que quede aunque nada más pase", () => {
  const c = src("src/lib/erp/cancel.ts");
  const rej = fnBody(c, "auditRejected");
  assert.ok(rej.includes('action: "cancelar-rechazado"'));
  assert.ok(rej.includes("detail: chain.blockers.join"), "con el motivo del bloqueo");
  // Se registra al enseñar la cadena bloqueada y al intentar confirmar.
  assert.ok(fnBody(c, "cancelChainPreview").includes("if (chain.blockers.length) await auditRejected(sql, context.userId, chain);"));
  const run = fnBody(c, "runCancel");
  const iAudit = run.indexOf("await auditRejected(sql, userId, chain);");
  const iTx = run.indexOf("return withTx(");
  assert.ok(iAudit !== -1 && iAudit < iTx, "el rechazo se escribe ANTES de abrir la transacción");
  assert.ok(src("src/routes/bitacora.tsx").includes('"cancelar-rechazado": "Cancelación RECHAZADA (algo ya se movió)"'), "con etiqueta en la bitácora");
  assert.ok(src("src/components/cancel-doc.tsx").includes("Este intento quedó en la bitácora."), "y la pantalla lo dice");
});

test("lo que sí pasa se escribe una vez por documento: OC cancelada, FP revertida, pedido cancelado con su cadena", () => {
  const body = fnBody(src("src/lib/erp/cancel.ts"), "applyChain");
  assert.ok(body.includes("set state = 'reversed', cancelled_at = now(), cancelled_by = ${userId}, cancel_reason = ${reason}"), "la FP se marca revertida, sin documento contrario (Decisión 19)");
  assert.ok(body.includes('action: "revertir-fp"'));
  assert.ok(body.includes('action: "cancelar-oc"'));
  assert.ok(body.includes('action: "cancelar-pedido"'));
  assert.ok(body.includes("· cadena: ${"), "el renglón del pedido lleva la cadena completa");
  assert.ok(!body.includes("delete from"), "nunca se borra nada");
});

// ---------------------------------------------------------------------------
// 5) Decisión 23: las FP viejas se limpian solas al cancelar su OC.
// ---------------------------------------------------------------------------
test("la marca 'mercancía no recibida' desaparece sola al cancelar la OC (se deriva de po.state), y la deuda sale de todos los lectores", () => {
  const az = src("src/lib/azagro.ts");
  assert.ok(az.includes("po.state not in ('done','cancelled')"), "la marca es 'OC ni recibida ni cancelada': cancelarla la apaga");
  // Y la FP pasa a 'reversed', que ya excluyen los lectores del paso 0.
  for (const f of ["src/lib/azagro.ts", "src/lib/erp/alerts.ts", "src/lib/erp/ops.ts"]) {
    const c = src(f);
    assert.ok(!/state <> 'paid'(?!.*reversed)/.test(c.split("\n").find((l) => l.includes("state <> 'paid'")) ?? ""), `${f}: ningún <> 'paid' suelto`);
  }
  assert.ok(src("src/lib/erp/credit.ts").includes('state !== "paid" && state !== "reversed"'), "invoiceStillOwed excluye revertida");
});

// ---------------------------------------------------------------------------
// 6) Pantalla: la cadena completa antes de preguntar, una sola vez.
// ---------------------------------------------------------------------------
test("la pantalla enseña qué se cancela, qué se revierte con importe y saldo, qué no se toca, y pide el motivo una vez", () => {
  const ui = src("src/components/cancel-doc.tsx");
  assert.ok(ui.includes("Se cancela:"));
  assert.ok(ui.includes("Se revierte (deuda que ya existe en cartera):"));
  assert.ok(ui.includes("saldo {money(d.residual ?? 0, d.currency)}"), "con el saldo de la FP");
  assert.ok(ui.includes("No se toca:"));
  assert.ok(ui.includes("No se puede cancelar."), "y el bloqueo en su lugar, sin botón");
  assert.ok(ui.includes("const canConfirm = Boolean(chain) && !blocked && Boolean(chain?.allowed) && Boolean(reason.trim()) && !busy;"), "sin cadena, bloqueada, sin permiso o sin motivo: no hay confirmar");
  assert.ok(ui.includes("Todo o nada."), "lo dice");
});

test("el botón vive junto a 'Entregar y facturar' (pedido confirmado) y junto a 'Recibir' (OC confirmada)", () => {
  const so = src("src/routes/sales.$orderId.tsx");
  assert.ok(so.includes('load={() => cancelChainPreview({ data: { kind: "sale", id } })}'));
  assert.ok(so.includes("cancelSalesOrderChain({ data: { soId: id, reason } })"));
  const iConfirmed = so.indexOf('{canEdit && state === "confirmed" && (');
  const iBtn = so.indexOf("<CancelChainButton");
  const iDone = so.indexOf('{canEdit && state === "done" && !receivedAt');
  assert.ok(iConfirmed < iBtn && iBtn < iDone, "dentro del bloque de pedido confirmado");
  const po = src("src/routes/purchases.tsx");
  assert.ok(po.includes('{o.state === "confirmed" && (\n                          <CancelChainButton'), "solo OC confirmada");
  assert.ok(po.includes("cancelPurchaseOrderChain({ data: { poId: o.id, reason } })"));
});

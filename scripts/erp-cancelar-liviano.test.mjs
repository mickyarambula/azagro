// BLOQUE DE DESHACER — PASO 1 (8-sep-2026): cancelar lo liviano.
//
// Solo lo que no movió inventario ni cartera: solicitud, cotización
// (draft/sent) y pedido en borrador. Se marca cancelado y se conserva, nunca
// se borra (Decisión 15); lo puede hacer quien tenga el permiso del módulo,
// no solo quien lo capturó (Decisión 24); motivo obligatorio, bitácora, y la
// pantalla enseña qué se va a cancelar antes de preguntar una vez
// (Decisión 25). Fuera de este paso: cancelar un pedido confirmado (arrastra
// OC/FP — paso 4, necesita la Decisión 14 antes).
//
// Del mismo estilo de cableado que scripts/erp-cancelar.test.mjs (paso 0):
// verifica por texto que cada acción nueva tiene su candado, que ningún
// cancelado se puede volver a cancelar, y que no existe ninguna acción de
// revivir/reactivar un cancelado en ningún lado.
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
// 1) cancelRequest (sustituye a deleteRequest, que ya no existe).
// ---------------------------------------------------------------------------
test("deleteRequest ya no existe — cancelRequest lo sustituye (Decisión 15: nunca se borra)", () => {
  const req = src("src/lib/erp/requests.ts");
  assert.ok(!req.includes("export const deleteRequest"), "el borrado duro tenía que irse");
  assert.ok(!req.includes("delete from customer_requests"), "ningún camino borra la solicitud");
});

test("cancelRequest: permiso del módulo (no de la persona), motivo obligatorio, candado, bitácora", () => {
  const req = src("src/lib/erp/requests.ts");
  const body = fnBody(req, "cancelRequest");
  assert.ok(body.includes('assertCan(sql, context.userId, "quotes", "edit")'), "quien tenga el permiso, no solo quien capturó — Decisión 24");
  assert.ok(body.includes("reason: z.string().trim().min(1"), "el motivo no es opcional");
  assert.ok(body.includes("await assertRequestOpen(sql, companyId, data.id)"), "mismo candado que las demás funciones internas — reutilizado, no duplicado");
  assert.ok(body.includes("set state = 'cancelled', cancelled_at = now(), cancelled_by = ${context.userId}, cancel_reason = ${data.reason}"));
  assert.ok(body.includes('action: "cancelar-solicitud"'), "bitácora");
  assert.ok(body.includes("detail: data.reason"), "el motivo queda en la bitácora");
});

// ---------------------------------------------------------------------------
// 2) El candado compartido (request-lock.ts) ahora also cierra dos huecos:
//    la solicitud misma cancelada, y una cotización cancelada ya no bloquea
//    (Decisión 19 — libera igual que rechazada).
// ---------------------------------------------------------------------------
test("assertRequestOpen: rechaza una solicitud cancelada ANTES de mirar la cotización ligada", () => {
  const lock = src("src/lib/erp/request-lock.ts");
  const body = fnBody(lock, "assertRequestOpen");
  const iCancelled = body.indexOf('r[0].state === "cancelled"');
  const iQuoteId = body.indexOf("r[0].quote_id &&");
  assert.notEqual(iCancelled, -1, "falta el candado de la solicitud misma");
  assert.ok(iCancelled < iQuoteId, "debe revisar cancelada antes que la cotización ligada");
  assert.ok(body.includes("throw new Error(requestCancelledMessage())"));
});

test("quoteStillBlocks: la cotización cancelada libera el candado (real archivo, no solo la copia del test)", () => {
  const lock = src("src/lib/erp/request-lock.ts");
  const body = fnBody(lock, "quoteStillBlocks");
  assert.ok(body.includes('state === "rejected" || state === "cancelled"'), 'cancelada debe caer en la misma rama que rechazada');
});

test('updateRequest y quoteFromRequest también rechazan una solicitud cancelada', () => {
  const req = src("src/lib/erp/requests.ts");
  assert.ok(fnBody(req, "updateRequest").includes("await assertRequestOpen(sql, companyId, data.id)"), "updateRequest reutiliza el candado — antes solo miraba quote_id");
  const qfr = fnBody(req, "quoteFromRequest");
  assert.ok(qfr.includes('req[0].state === "cancelled"'), "quoteFromRequest debe rechazar cotizar una solicitud cancelada");
});

test("las seis funciones internas de la solicitud (sendVendorRfq, pickVendor, saveLineMargin, applyCheapest, saveLineFreight, saveRequestTerms) siguen detrás del mismo candado", () => {
  const req = src("src/lib/erp/requests.ts");
  for (const fn of ["sendVendorRfq", "pickVendor", "saveLineMargin", "applyCheapest", "saveLineFreight"]) {
    assert.ok(fnBody(req, fn).includes("await assertRequestOpen(sql, companyId, data.requestId)"), `${fn} debe llamar assertRequestOpen`);
  }
  assert.ok(fnBody(req, "saveRequestTerms").includes("await assertRequestOpen(sql, companyId, data.id)"), "saveRequestTerms debe llamar assertRequestOpen");
});

// ---------------------------------------------------------------------------
// 3) cancelQuote — solo draft/sent (lo que no generó pedido). Aceptada,
//    parcial, rechazada o ya cancelada: rechazadas explícitamente, no un
//    candado prestado de otra función.
// ---------------------------------------------------------------------------
test("cancelQuote: permiso, motivo obligatorio, y las cuatro exclusiones (accepted/partial/rejected/cancelled)", () => {
  const ops = src("src/lib/erp/ops.ts");
  const body = fnBody(ops, "cancelQuote");
  assert.ok(body.includes('assertCan(sql, context.userId, "quotes", "edit")'));
  assert.ok(body.includes("reason: z.string().trim().min(1"));
  assert.ok(body.includes('q[0].state === "accepted" || q[0].state === "partial"'), "ya generó pedido: no se cancela así (Decisión 18)");
  assert.ok(body.includes('q[0].state === "rejected"'), "ya cerrada, no hay nada que cancelar");
  assert.ok(body.includes('q[0].state === "cancelled"'), "un cancelado no se vuelve a cancelar");
  assert.ok(body.includes("set state = 'cancelled', cancelled_at = now(), cancelled_by = ${context.userId}, cancel_reason = ${data.reason}"));
  assert.ok(body.includes('action: "cancelar-cotizacion"'));
});

test("quotes.tsx: el botón Cancelar solo aparece para una cotización que no se cerró (!closed)", () => {
  const c = src("src/routes/quotes.tsx");
  assert.ok(c.includes("cancelQuote({ data: { quoteId: qrow.id, reason } })"), "debe llamar cancelQuote");
  assert.ok(/\{!closed \? \(\s*<CancelButton/.test(c), "el botón debe estar gated por !closed");
});

// ---------------------------------------------------------------------------
// 4) cancelOrder — solo "draft" (lo que no generó OC/FP). Un confirmado se
//    rechaza con mensaje explícito: eso es el paso 4, no éste.
// ---------------------------------------------------------------------------
test("cancelOrder: permiso, motivo obligatorio, solo borrador, un cancelado no se vuelve a cancelar", () => {
  const orders = src("src/lib/erp/orders.ts");
  const body = fnBody(orders, "cancelOrder");
  assert.ok(body.includes('assertCan(sql, context.userId, "sales", "edit")'));
  assert.ok(body.includes("reason: z.string().trim().min(1"));
  assert.ok(body.includes('so[0].state === "cancelled"'), "un cancelado no se vuelve a cancelar");
  assert.ok(body.includes('so[0].state !== "draft"'), "un pedido confirmado no se cancela aquí — eso es el paso 4");
  assert.ok(body.includes("se revierte, no se cancela"), "el mensaje no debe prometer algo que este paso no construye");
  assert.ok(body.includes("set state = 'cancelled', cancelled_at = now(), cancelled_by = ${context.userId}, cancel_reason = ${data.reason}"));
  assert.ok(body.includes('action: "cancelar-pedido"'));
});

test("sales.$orderId.tsx: el botón Cancelar vive junto a Guardar/Confirmar (mismo candado editable = draft)", () => {
  const c = src('src/routes/sales.$orderId.tsx');
  assert.ok(c.includes("cancelOrder({ data: { soId: id, reason } })"));
  // El botón está dentro del mismo bloque `editable && (...)` que Guardar/Confirmar
  // — nunca se ofrece para un pedido confirmado/entregado/cancelado.
  const iEditable = c.indexOf("{editable && (");
  const iCancelBtn = c.indexOf("<CancelButton");
  const iEditableClose = c.indexOf(")}\n          {canEdit && state === \"confirmed\"");
  assert.ok(iEditable !== -1 && iCancelBtn !== -1 && iEditableClose !== -1, "no encontré los tres puntos de referencia");
  assert.ok(iEditable < iCancelBtn && iCancelBtn < iEditableClose, "CancelButton debe estar dentro del bloque editable");
});

// ---------------------------------------------------------------------------
// 5) El componente compartido: exige motivo, enseña qué se cancela, pregunta
//    una vez (Decisión 25 — no paso a paso).
// ---------------------------------------------------------------------------
test("CancelButton: no deja confirmar sin motivo, y el resumen se enseña antes de preguntar", () => {
  const c = src("src/components/cancel-doc.tsx");
  assert.ok(c.includes('if (!reason.trim())'), "el motivo se valida antes de llamar al servidor");
  assert.ok(c.includes("disabled={busy || !reason.trim()}"), "el botón de confirmar queda inhabilitado sin motivo");
  assert.ok(c.includes("props.summary.map"), "enseña qué se va a cancelar");
  assert.ok(c.includes("no se puede deshacer desde aquí"), "advierte que no hay revivir");
});

// ---------------------------------------------------------------------------
// 6) Un cancelado no revive: no existe, en ningún archivo de src/lib, una
//    acción que le quite el estado 'cancelled' a nada.
// ---------------------------------------------------------------------------
test("ningún archivo de src/lib reactiva un cancelado (cancelled_at = null, o state de vuelta a draft/open desde cancelado)", () => {
  const files = [
    "src/lib/erp/requests.ts",
    "src/lib/erp/ops.ts",
    "src/lib/erp/orders.ts",
    "src/lib/azagro.ts",
    "src/lib/erp/request-lock.ts",
  ];
  for (const f of files) {
    const c = src(f);
    assert.ok(!/cancelled_at\s*=\s*null/.test(c), `${f}: no debe limpiar cancelled_at`);
    assert.ok(!/set\s+state\s*=\s*'draft'/i.test(c), `${f}: no debe regresar un documento a 'draft'`);
  }
  // Ningún nombre de función sugiere "revivir" un cancelado.
  for (const f of files) {
    const c = src(f);
    assert.ok(!/export const (uncancel|reactivate|revive|reabrirCancel)/i.test(c), `${f}: no debe existir una acción de revivir`);
  }
});

// ---------------------------------------------------------------------------
// 7) Las tres pantallas muestran el motivo y la fecha de cancelación — el
//    rastro que Decisión 24 promete, visible, no solo en la bitácora.
// ---------------------------------------------------------------------------
for (const [file, marker] of [
  ["src/routes/solicitudes.$solicitudId.tsx", "request.cancel_reason"],
  ["src/routes/sales.$orderId.tsx", "cancelReason"],
]) {
  test(`${file}: muestra quién/cuándo/por qué se canceló, no solo el estado`, () => {
    const c = src(file);
    assert.ok(c.includes(marker), `${file} debe mostrar el motivo capturado`);
    assert.ok(c.includes("Cancelado") || c.includes("Cancelada"), `${file} debe rotular la cancelación`);
  });
}

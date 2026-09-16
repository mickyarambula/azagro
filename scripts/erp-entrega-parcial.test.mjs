// BLOQUE DE PARCIALES, paso 3 (PARCIALES.md § 8): entrega parcial con su
// factura. Decisiones 46 (una FV por entrega), 47 (entregar sin facturar;
// no facturar sin entregar), 54 (el plazo de cada FV arranca el día de su
// entrega), 40 (TIIE a la fecha de emisión), 29 (directo: la deuda nace al
// entregar y facturar) y la del dueño del 15-sep-2026: en directo/brokeraje
// entregar = facturar en el mismo acto (no hay kardex que registre el evento).
//
// Por texto (fnBody/.includes), como todas las pruebas de azagro.ts.
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
// 3.2 deliverSale: cantidad por partida opcional; ya no emite la FV en bodega
//     propia (Decisión 47). Sin `lines` = entregar todo lo pendiente.
// ---------------------------------------------------------------------------
test("deliverSale: acepta lines opcional, delega en deliverPartial y ya no emite la FV adentro", () => {
  const az = src("src/lib/azagro.ts");
  const body = fnBody(az, "deliverSale");
  assert.ok(body.includes("lines: z.array(z.object({ lineId: z.number(), qty: z.number().positive() })).optional()"), "cantidad por partida, opcional");
  assert.ok(body.includes('assertCan(sql, context.userId, "sales", "deliver")'), "solo entregar (Decisión 48)");
  assert.ok(body.includes('so[0].state === "done" || so[0].state === "cancelled"'), "el candado de cancelado se queda (erp-cancelar lo fija)");
  assert.ok(body.includes("await deliverPartial(sql, {"), "delega");
  assert.ok(!body.includes("insert into invoices"), "la FV ya no nace aquí (Decisión 47)");
  assert.ok(!body.includes("FV-${String("), "ni se folia aquí");
  assert.ok(body.includes("brokeraje: nace ${fpsDirectas.join"), "la bitácora sigue diciendo qué FP nacieron en directo");
});

// ---------------------------------------------------------------------------
// 3.2 deliverPartial: un evento por llamada (serie ENV), kardex solo en bodega
//     propia, done solo sin pendiente, y en directo FV + FP por evento.
// ---------------------------------------------------------------------------
test("deliverPartial: mina un event_ref por llamada (serie ENV, folio_counters) y lo pasa a postStock", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "deliverPartial");
  assert.ok(body.includes("values (${opts.companyId}, 'ENV', 1)"), "serie ENV, misma mecánica que RCP (A4)");
  assert.ok(body.includes("eventRef,"), "lo pasa a postStock");
  assert.ok(body.includes("if (!direct) {"), "kardex solo en bodega propia");
});

test("deliverPartial: valida contra lo pendiente y acumula qty_delivered (no lo pisa)", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "deliverPartial");
  assert.match(body, /No puedes entregar más de lo pendiente/);
  assert.ok(body.includes("qty_delivered = qty_delivered + ${l.qty}"), "acumula");
  assert.ok(!body.includes("set qty_delivered = qty where"), "ya no pisa con qty");
});

test("deliverPartial: el pedido pasa a 'done' solo cuando NINGUNA partida tiene pendiente", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "deliverPartial");
  assert.ok(body.includes("qty_delivered < qty - 0.0001"), "contra el acumulado");
});

test("deliverPartial: en directo/brokeraje entregar = facturar (FV + FP por evento en el mismo acto)", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "deliverPartial");
  assert.ok(body.includes("if (direct) {"));
  assert.ok(body.includes("await issueDeliveryInvoice(sql, {"), "la FV de este evento");
  assert.ok(body.includes("coalesce(fulfill_kind,'inventory') = 'direct' and state <> 'cancelled'"), "sus OC directas, sin las canceladas");
  assert.ok(body.includes("await bornSupplierDebtByReceipt(sql, {"), "FP por evento (Decisiones 28 + 29), no bornSupplierDebt por OC");
  assert.ok(!body.includes("await bornSupplierDebt(sql, {"), "bornSupplierDebt (por OC) queda intacta y sin uso aquí");
});

// ---------------------------------------------------------------------------
// 3.2 issueDeliveryInvoice: la FV de UN evento — renglones = lo que salió en
//     ese evento, vencimientos desde la fecha de la entrega, foto intacta.
// ---------------------------------------------------------------------------
test("issueDeliveryInvoice: idempotente por event_ref; renglones = lo entregado en ese evento, no sl.qty ni so.total", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "issueDeliveryInvoice");
  assert.ok(body.includes("kind = 'customer' and event_ref = ${opts.eventRef}"), "idempotente por evento");
  assert.ok(body.includes("move_type = 'delivery'") && body.includes("event_ref = ${opts.eventRef}"), "en bodega propia, del kardex de ese evento");
  assert.ok(!body.includes("so[0].total"), "importe = Σ(entregado × precio), no el pedido completo");
  assert.ok(!body.includes("select product_id, qty::text, unit_price::text from sales_lines where so_id"), "ya no factura por sales_lines.qty");
});

test("issueDeliveryInvoice: vencimientos desde la fecha de la ENTREGA (Decisión 54), con el plazo del pedido", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "issueDeliveryInvoice");
  assert.ok(body.includes("computeDues({"), "la misma regla de decideQuote, con otra fecha");
  assert.ok(body.includes("date: eventDate,"), "la fecha del evento, no la del pedido");
  assert.ok(body.includes("invoiceDays: so[0].invoice_days ?? 0,") && body.includes("creditDays: so[0].credit_days ?? 0,"), "los días que se cobraron en el precio");
});

test("issueDeliveryInvoice: la foto de la FV es la de siempre — TIIE a la fecha de emisión (Decisión 40), circuito y tasas congeladas", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "issueDeliveryInvoice");
  for (const campo of ["tiieIssue", "costSpread", "commissionRate", "financialDays", "collectionSpread", "fegaRate", "params_snap"]) {
    assert.ok(body.includes(campo), `la foto incluye ${campo}`);
  }
  assert.ok(body.includes("requireRate(tiieTable, today, `emisión de ${iname} a crédito`)"), "a crédito por ASR exige renglón de TIIE hoy");
  assert.ok(body.includes("${inheritCircuit(so[0].circuit_code, so[0].credit_days ?? 0)}"), "la FV hereda el circuito del pedido (erp-circuitos lo fija)");
  assert.ok(body.includes("order_id, invoice_days, credit_days, policy_code,"), "order_id: todos los lectores de hoy la siguen encontrando");
  assert.ok(body.includes("event_ref"), "y lleva su evento");
});

test("orden en el archivo: deliverPartial e issueDeliveryInvoice van después de deliverSale", () => {
  const az = src("src/lib/azagro.ts");
  const d = az.indexOf("export const deliverSale");
  assert.ok(az.indexOf("export async function deliverPartial") > d);
  assert.ok(az.indexOf("export async function issueDeliveryInvoice") > d);
});

// ---------------------------------------------------------------------------
// Defecto encontrado al diseñar 3.2: una entrega directa con DOS OC al mismo
// evento. La idempotencia de la FP tiene que ser por evento Y por OC.
// ---------------------------------------------------------------------------
test("bornSupplierDebtByReceipt: idempotente por evento Y por OC (dos OC directas en la misma entrega → dos FP)", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "bornSupplierDebtByReceipt");
  assert.ok(body.includes("event_ref = ${opts.eventRef} and origin = ${opts.poName}"), "evento + OC");
});

// ---------------------------------------------------------------------------
// 3.3 invoiceDelivery (server fn): facturar UNA entrega — solo con sales:edit
//     (almacén no factura, Decisión 48); rechaza directo (ahí ya nació con la
//     entrega), evento inexistente y evento ya facturado.
// ---------------------------------------------------------------------------
test("invoiceDelivery: exige sales:edit, rechaza directo / evento sin entrega / ya facturado, y emite con issueDeliveryInvoice", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "invoiceDelivery");
  assert.ok(body.includes('assertCan(sql, context.userId, "sales", "edit")'), "facturar es edit, no deliver");
  assert.ok(body.includes("eventRef: z.string()"), "por evento");
  assert.match(body, /directo|brokeraje/, "en directo la FV ya nació con la entrega");
  assert.ok(body.includes("ya está facturada"), "no se factura dos veces");
  assert.ok(body.includes("await issueDeliveryInvoice(sql, {"), "misma función que usa el directo");
  assert.ok(body.includes('action: "facturar-entrega"'), "bitácora propia");
});

test("listDeliveryEvents: un renglón por evento con su FV (o null) y si está revertido", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "listDeliveryEvents");
  assert.ok(body.includes("m.event_ref is not null") && body.includes("m.move_type = 'delivery'"), "eventos del kardex (bodega propia)");
  assert.ok(body.includes("kind = 'customer' and event_ref is not null"), "y los directos, que solo dejan FV");
  assert.ok(body.includes("group by"), "un renglón por evento");
});

// ---------------------------------------------------------------------------
// 3.4 (candado) chainForDelivery: "un pedido = una entrega = una FV". Con dos
//     eventos revertiría todo el kardex y una sola FV. Se bloquea antes de
//     tocar nada; la reversa por entrega es el paso 4.
// ---------------------------------------------------------------------------
test("chainForDelivery: con más de un evento vivo se bloquea antes de tocar nada (reversa por entrega = paso 4)", () => {
  const body = fnBody(src("src/lib/erp/delivery-reversal.ts"), "chainForDelivery");
  const i = body.indexOf("count(distinct event_ref)");
  assert.ok(i > -1, "cuenta los eventos vivos del pedido");
  assert.ok(i < body.indexOf("// La FV viva del pedido."), "ANTES de elegir una FV");
  assert.match(body, /paso 4 del bloque de parciales/, "nombra el camino que falta, no finge");
});


// ---------------------------------------------------------------------------
// 3.5 Pantalla — ficha del pedido: Entregar (cantidad por partida, permiso
//     deliver), Facturar esta entrega (edit), panel de entregas, aviso P&L.
//     El diálogo de cantidad por partida es UNO, compartido con /purchases.
// ---------------------------------------------------------------------------
test("partial-qty-dialog.tsx: un solo diálogo de cantidad por partida, compartido por compras y ventas", () => {
  const c = src("src/components/partial-qty-dialog.tsx");
  assert.ok(c.includes("export function PartialQtyDialog("));
  const body = fnBody(c, "PartialQtyDialog");
  assert.ok(body.includes("void confirm(undefined)"), "'todo lo pendiente' = sin lines (el camino de hoy)");
  assert.ok(body.includes("confirm(Object.entries(qtys)"), "confirmar = solo las partidas con cantidad > 0");
  assert.ok(src("src/routes/purchases.tsx").includes("<PartialQtyDialog"), "compras lo usa");
  assert.ok(src("src/routes/sales.$orderId.tsx").includes("<PartialQtyDialog"), "ventas lo usa");
});

test("ficha del pedido: Entregar pide deliver (almacén sí), Facturar y Cancelar piden edit; el botón de un clic 'Entregar y facturar' ya no existe en bodega propia", () => {
  const so = src("src/routes/sales.$orderId.tsx");
  assert.ok(so.includes('const canDeliver = can("sales", "deliver");'), "permiso de entregar, aparte del de editar");
  assert.ok(so.includes('{canDeliver && state === "confirmed" && ('), "entregar con deliver");
  assert.ok(so.includes('{canEdit && state === "confirmed" && ('), "cancelar sigue con edit (erp-cancelar-cascada lo fija)");
  assert.ok(so.includes("deliverSale({ data: recvLines ? { soId: id, lines: recvLines } : { soId: id } })"), "con o sin cantidades");
  assert.ok(so.includes("invoiceDelivery({ data: { soId: id, eventRef"), "facturar por evento");
  assert.ok(so.includes("Facturar esta entrega"), "el botón, por evento");
  assert.ok(so.includes("Entregar y facturar (directo)"), "en directo el botón dice que factura en el mismo acto");
  assert.ok(!so.includes('Entregar y facturar{form.routeKind !== "own"'), "el botón viejo de un clic se fue (Decisión 47)");
});

test("ficha del pedido: panel de entregas (listDeliveryEvents) recargado con load(), y chip 'Entregado parcial'", () => {
  const so = src("src/routes/sales.$orderId.tsx");
  assert.ok(so.includes("listDeliveryEvents({ data: { soId: id } })"), "los eventos del pedido");
  const iLoad = so.indexOf("async function load()");
  const iEvents = so.indexOf("listDeliveryEvents({ data: { soId: id } })");
  assert.ok(iLoad > -1 && iEvents > iLoad && iEvents < so.indexOf("}", so.indexOf("setSold(d.lines);")), "se cargan dentro de load(), no en un efecto propio (lección del paso 2: si no, una segunda entrega no aparece)");
  assert.ok(so.includes('"Entregado parcial"'), "el chip lo dice cuando hay entregado y queda pendiente");
});

test("ficha del pedido: con 2+ facturas vivas, el P&L avisa que toma solo la última (paso 5), no finge el número", () => {
  const so = src("src/routes/sales.$orderId.tsx");
  assert.ok(so.includes("events.filter((e) => e.fv).length > 1"), "cuenta las FV vivas");
  assert.match(so, /solo la última factura[\s\S]{0,120}paso 5/, "lo dice, con el paso que lo arregla");
});

test("ficha del pedido: el botón Recibir de las OC hijas también pasa a deliver (almacén recibe)", () => {
  const so = src("src/routes/sales.$orderId.tsx");
  assert.ok(so.includes('const canReceive = can("purchases", "deliver");'));
  assert.ok(so.includes("canDeliver && canReceive && po.state"));
});

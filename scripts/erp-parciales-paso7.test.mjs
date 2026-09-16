// BLOQUE DE PARCIALES, paso 7 (PARCIALES.md § 5 y § 8): cierre corto —
// lo pendiente que ya nunca va a llegar (OC) o a salir (pedido) se cierra
// a mano, con motivo obligatorio (A5); lo recibido/entregado y facturado
// queda intacto (Decisiones 49 y 50). Cierra el bloque: destraba § 4.1 sin
// deshacer nada. Y la decisión del dueño del 16-sep-2026: lo cerrado corto
// deja de apartar línea de crédito (opción A).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { reconcilePurchaseLine, reconcileSalesLine } from "../src/lib/erp/parciales.ts";
import { creditRoom } from "../src/lib/erp/credit-limit.ts";

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
// Migración 0037: aditiva, en 0 / nula.
// ---------------------------------------------------------------------------
test("migración 0037: qty_closed_short en purchase_lines y sales_lines (0), trío closed_short_* en las cabeceras (nulo), nada destructivo", () => {
  const m = src("migrations/0037_cierre_corto.sql");
  assert.ok(m.includes("alter table purchase_lines add column if not exists qty_closed_short numeric(14,3) not null default 0;"));
  assert.ok(m.includes("alter table sales_lines    add column if not exists qty_closed_short numeric(14,3) not null default 0;"));
  const flat = m.replace(/\s+/g, " ");
  for (const t of ["purchase_orders", "sales_orders"]) for (const c of ["closed_short_at timestamptz", "closed_short_by text", "closed_short_reason text"]) {
    assert.ok(flat.includes(`alter table ${t} add column if not exists ${c};`), `${t}.${c}`);
  }
  assert.ok(!/drop|rename|alter column|references/i.test(m));
  assert.ok(src("migrations/README.md").includes("0037 = **cierre corto**"));
});

// ---------------------------------------------------------------------------
// La identidad del cuadre con lo cerrado corto (§ 5) — ya existía pura; ahora
// el cuadre real la alimenta desde la columna.
// ---------------------------------------------------------------------------
test("identidad § 5: qty = recibida + pendiente + cerrada_corta; con 20 recibidas y 30 cerradas de 50, pendiente = 0 y gap = 0", () => {
  const g = reconcilePurchaseLine({ qty: 50, qtyReceived: 20, cerradaCorta: 30 });
  assert.deepEqual([g.pendiente, g.gap, g.cerradaCorta], [0, 0, 30]);
  const s = reconcileSalesLine({ qty: 20, qtyDelivered: 10, qtyReturned: 0, invoicedQty: 10, cerradaCorta: 10 });
  assert.deepEqual([s.pendiente, s.gap, s.porFacturar, s.overInvoiced], [0, 0, 0, false]);
  // Cerrar corto NO toca lo entregado ni lo facturado (Decisión 50): la venta real sigue igual.
  assert.equal(s.entregadaViva, 10);
  assert.equal(s.facturadaViva, 10);
});

test("purchaseLineGaps / salesLineGaps: leen qty_closed_short y lo pasan como cerradaCorta — un cierre corto ya no aparece como gap ni como pendiente", () => {
  const c = src("src/lib/erp/parciales.ts");
  const pg = fnBody(c, "purchaseLineGaps");
  assert.ok(pg.includes("coalesce(pl.qty_closed_short, 0)::text as qty_closed_short"));
  assert.ok(pg.includes("cerradaCorta: Number(r.qty_closed_short)"));
  const sg = fnBody(c, "salesLineGaps");
  assert.ok(sg.includes("coalesce(sl.qty_closed_short, 0)::text as qty_closed_short"));
  assert.ok(sg.includes("cerradaCorta: Number(r.qty_closed_short),"));
});

// ---------------------------------------------------------------------------
// closeShortSale / closeShortPurchase.
// ---------------------------------------------------------------------------
for (const [fn, doc, qtyCol, tabla, lineas] of [
  ["closeShortSale", "sales_orders", "qty_delivered", "pedido", "sales_lines"],
  ["closeShortPurchase", "purchase_orders", "qty_received", "orden", "purchase_lines"],
]) {
  test(`${fn}: solo admin/gerencia, solo confirmado con pendiente, motivo obligatorio, transacción con candado`, () => {
    const body = fnBody(src("src/lib/azagro.ts"), fn);
    assert.ok(body.includes('reason: z.string().trim().min(1, "Escribe el motivo")'), "motivo obligatorio (A5), sin default");
    assert.ok(body.includes("if (!canRevert(me.role)) throw new Error("), "admin/gerencia, como revertir: no se deshace con un botón");
    assert.ok(body.includes("return withTx(async (sql) => {") && body.includes("for update"), "transacción + candado del documento");
    assert.ok(body.includes('.state !== "confirmed")'), "solo confirmado");
    assert.ok(body.includes("no hay pendiente que cerrar"), "done o borrador: nada que cerrar");
    assert.ok(body.includes("no tiene pendiente que cerrar."), "sin pendiente: nada que cerrar");
  });

  test(`${fn}: cierra lo pendiente por partida (acumula qty_closed_short, nunca pisa), ${doc} a done solo cuando nada queda pendiente contando lo cerrado, y guarda el trío + bitácora`, () => {
    const body = fnBody(src("src/lib/azagro.ts"), fn);
    assert.ok(body.includes(`Math.max(0, Number(l.qty) - Number(l.${qtyCol}) - Number(l.qty_closed_short))`), "pendiente = qty − hecho − cerrado");
    assert.ok(body.includes(`update ${lineas} set qty_closed_short = coalesce(qty_closed_short,0) + \${t.qty} where id = \${t.line.id}`), "acumula por partida");
    assert.ok(body.includes(`coalesce(${qtyCol},0) + coalesce(qty_closed_short,0) < qty - 0.0001`), "pendiente contando lo cerrado");
    assert.ok(body.includes("const done = (pend[0]?.n ?? 0) === 0;") && body.includes("if (done) await sql`update ") && body.includes("set state = 'done' where id ="), "done solo si nada queda pendiente (dos sentencias: un fragmento anidado se ejecuta suelto y tumba el servidor)");
    assert.ok(body.includes("set closed_short_at = now(), closed_short_by = ${context.userId}, closed_short_reason = ${data.reason}"), "quién, cuándo, por qué");
    assert.ok(body.includes('action: "cerrar-corto"'), "bitácora propia");
    assert.ok(body.includes("No puedes cerrar más de lo pendiente"), "con lines, nunca más de lo pendiente");
    assert.ok(!body.includes("update stock_moves") && !body.includes("delete from") && !body.includes("update invoices"), "no toca kardex, facturas ni borra: cerrar no es borrar (Decisión 50)");
  });
}

test("closeShortPurchase: una OC directa / brokeraje no se cierra por aquí (nunca se recibe en bodega: no hay pendiente de recepción, Decisión 29)", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "closeShortPurchase");
  assert.ok(body.includes('if (po[0].fulfill_kind === "direct") throw new Error(`${po[0].name} es directa / brokeraje: nunca se recibe en bodega, no hay pendiente de recepción que cerrar.`);'));
});

// ---------------------------------------------------------------------------
// Violación que atrapó el revisor de dinero: lo cerrado corto todavía podía
// entregarse / recibirse (y las reversas lo devolvían a "pendiente"). Ahora
// entregar, recibir, la reversa de recepción y el P&L conocen la casilla.
// ---------------------------------------------------------------------------
test("entregar y recibir NO tocan lo cerrado corto: pendiente = qty − hecho − cerrado en el wrapper, por partida y en el paso a done", () => {
  const az = src("src/lib/azagro.ts");
  const ds = fnBody(az, "deliverSale");
  assert.ok(ds.includes("qty: Number(l.qty) - Number(l.qty_delivered) - Number(l.qty_closed_short)"), "«todo lo pendiente» excluye lo cerrado");
  const dp = fnBody(az, "deliverPartial");
  assert.ok(dp.includes("const pending = Number(line[0].qty) - Number(line[0].qty_delivered) - Number(line[0].qty_closed_short);"), "por partida");
  assert.ok(dp.includes("qty_delivered < qty - 0.0001 - coalesce(qty_closed_short,0)"), "done contando lo cerrado (erp-entrega-parcial fija el prefijo)");
  const rp = fnBody(az, "receivePartial");
  assert.ok(rp.includes("const pending = Number(line[0].qty) - Number(line[0].qty_received) - Number(line[0].qty_closed_short);"));
  assert.ok(rp.includes("qty_received >= qty - 0.0001 - coalesce(qty_closed_short,0)"), "erp-recepcion-parcial fija el prefijo");
  assert.ok(fnBody(src("src/lib/erp/receipt-reversal.ts"), "reverseReceiptEvent").includes("qty_received < qty - 0.0001 - coalesce(qty_closed_short,0)"), "la reversa de recepción vuelve a confirmed solo si queda pendiente de verdad");
  // Segunda pasada del revisor: «Recibir todo lo pendiente» (sin lines) entraba al camino viejo, que pisa qty_received = qty
  // y hace nacer la FP por po.total — recibía lo cerrado corto. Con cierre corto va por partidas; sin cierre corto, el camino de siempre.
  const rw = fnBody(az, "receivePurchase");
  assert.ok(rw.includes("from purchase_lines where po_id = ${po[0].id} and coalesce(qty_closed_short,0) > 0"), "detecta cierre corto");
  assert.ok(rw.includes("const pendLines = all.map((l) => ({ lineId: l.id, qty: Number(l.pending) })).filter((l) => l.qty > 0.0001);"), "pendiente sin lo cerrado, por partida");
  assert.ok(rw.includes("lo demás se cerró corto"), "y si no queda nada, lo dice");
  assert.ok(rw.includes("const pending = Number(line.qty) - Number(line.qty_received);") && rw.includes("update purchase_lines set qty_received = qty where id = ${line.id}"), "el camino viejo sigue byte a byte para OC sin cierre corto (erp-fp-al-recibir lo fija)");
});

test("closeShortSale / closeShortPurchase por API: sin nada entregado / recibido no se cierra corto — eso sería cancelar sin pasar por cancelar", () => {
  const az = src("src/lib/azagro.ts");
  assert.ok(fnBody(az, "closeShortSale").includes("no tiene nada entregado: cerrar corto es para lo que falta después de entregar algo"));
  assert.ok(fnBody(az, "closeShortPurchase").includes("no tiene nada recibido: cerrar corto es para lo que falta después de recibir algo"));
});

test("P&L: lo cerrado corto no se reporta como 'sin facturar todavía'; las pantallas restan lo cerrado al calcular el pendiente", () => {
  assert.ok(fnBody(src("src/lib/erp/reports.ts"), "computeDealPnlMulti").includes("Number(r.ordered) - Number(r.closed_short) - Number(r.invoiced)"));
  const so = src("src/routes/sales.$orderId.tsx");
  assert.ok(so.includes("num(l.qty) - num(l.qty_delivered) > 0.0001 + num(l.qty_closed_short ?? 0)"), "Entregar / Cerrar: pendiente sin lo cerrado");
  assert.ok(src("src/lib/erp/orders.ts").includes("coalesce(sl.qty_closed_short,0)::text as qty_closed_short"), "getOrder lo trae");
  const pu = src("src/routes/purchases.tsx");
  assert.ok(pu.includes("Number(l.qty) - Number(l.qty_received) > 0.0001 + Number(l.qty_closed_short ?? 0)"), "Recibir / Cerrar: pendiente sin lo cerrado");
  assert.ok(fnBody(src("src/lib/azagro.ts"), "listPurchases").includes("coalesce(pl.qty_closed_short,0)::text as qty_closed_short"), "listPurchases lo trae");
  // Tercera pasada del revisor: /inventory «Pendiente de recibir» / «Reservado» tampoco contaban la casilla.
  const az = src("src/lib/azagro.ts");
  assert.ok(az.includes("(pl.qty - pl.qty_received - coalesce(pl.qty_closed_short,0))::text as pending"), "pendiente de recibir sin lo cerrado");
  assert.ok(az.includes("(sl.qty - sl.qty_delivered - coalesce(sl.qty_closed_short,0))::text as pending"), "reservado sin lo cerrado");
});

test("bitácora: la acción cerrar-corto tiene etiqueta en español", () => {
  assert.ok(src("src/routes/bitacora.tsx").includes('"cerrar-corto": "Cerró corto (lo pendiente ya no llega / no sale)"'));
});

// ---------------------------------------------------------------------------
// Crédito (decisión del dueño, 16-sep-2026, opción A): lo cerrado corto deja
// de apartar línea.
// ---------------------------------------------------------------------------
test("creditExposure: el apartado resta también lo cerrado corto (qty_closed_short × precio) — un pedido cerrado no sigue apartando línea para siempre", () => {
  const body = fnBody(src("src/lib/erp/credit-limit.ts"), "creditExposure");
  assert.ok(body.includes("select sum(coalesce(sl.qty_closed_short, 0) * sl.unit_price) from sales_lines sl where sl.so_id = so.id"), "lo cerrado, a precio de la partida");
  assert.ok(body.includes("greatest(0, so.total - coalesce(("), "y sigue sin bajar de 0 por pedido");
});

test("aritmética del crédito: pedido de 50 a 100; 30 facturadas y 20 cerradas corto → apartado 0; sin el paso 7 quedarían 2,000 apartados para siempre", () => {
  const total = 50 * 100;
  const facturado = 30 * 100;
  const cerrado = 20 * 100;
  const apartadoAntes = Math.max(0, total - facturado);
  const apartadoAhora = Math.max(0, total - facturado - cerrado);
  assert.equal(apartadoAntes, 2000);
  assert.equal(apartadoAhora, 0);
  // Y ese cero es lo que entra a la línea:
  assert.equal(creditRoom({ limit: 10000, invoiced: 0, reserved: apartadoAhora, order: 10000 }).exceeds, false);
  assert.equal(creditRoom({ limit: 10000, invoiced: 0, reserved: apartadoAntes, order: 10000 }).exceeds, true, "con el apartado viejo, el siguiente pedido no cabría");
});

// ---------------------------------------------------------------------------
// § 4.1: el candado de cancelar ahora nombra la salida.
// ---------------------------------------------------------------------------
test("cancel.ts: un pedido / una OC a medias ya no queda sin salida — el mensaje nombra «Cerrar con lo entregado» / «Cerrar con lo recibido», solo mientras sigue confirmado", () => {
  const c = src("src/lib/erp/cancel.ts");
  const sale = fnBody(c, "chainForSale");
  assert.ok(sale.includes('(s.state === "confirmed" ? " Si lo que falta ya no va a salir y lo entregado sí fue real, ciérralo corto: «Cerrar con lo entregado» en el pedido (administrador o gerencia)." : "")'));
  assert.ok(sale.includes("Eso no se cancela, se revierte: usa «Revertir entrega» en el pedido."), "el texto de siempre se queda (erp-cancelar lo puede fijar)");
  const po = fnBody(c, "chainForPurchase");
  assert.ok(po.includes('(o.state === "confirmed" ? " Si lo que falta ya no va a llegar y lo recibido sí fue real, ciérrala corta: «Cerrar con lo recibido» en Compras (administrador o gerencia)." : "")'));
});

// ---------------------------------------------------------------------------
// Pantalla.
// ---------------------------------------------------------------------------
test("CloseShortButton: motivo obligatorio, lista lo que se cierra, dice que es de admin/gerencia y que no se borra nada", () => {
  const c = src("src/components/close-short.tsx");
  assert.ok(c.includes('setError("El motivo es obligatorio.")'));
  assert.ok(c.includes("disabled={busy || !reason.trim()}"), "sin motivo no se confirma");
  assert.ok(c.includes("Cerrar no es borrar: todo se conserva"));
  assert.ok(c.includes("Esto es de administrador o gerencia."));
  assert.ok(c.includes("Confirmar cierre corto"));
});

test("ficha del pedido: «Cerrar con lo entregado» solo admin/gerencia, solo confirmado con algo entregado y algo pendiente; chip y nota de cerrado corto", () => {
  const so = src("src/routes/sales.$orderId.tsx");
  assert.ok(so.includes('{(role === "admin" || role === "gerencia") && state === "confirmed" && sold.some((l) => num(l.qty_delivered) > 0.0001) && sold.some((l) => num(l.qty) - num(l.qty_delivered) > 0.0001 + num(l.qty_closed_short ?? 0)) && ('));
  assert.ok(so.includes("onConfirm={(reason) => closeShortSale({ data: { soId: id, reason } })}"));
  assert.ok(so.includes('"Entregado (cerrado corto)"'), "el chip lo dice");
  assert.ok(so.includes("Cerrado corto el {closedShort.at.slice(0, 10)}: lo pendiente ya no va a salir; lo entregado y facturado queda como está."));
  assert.ok(src("src/lib/erp/orders.ts").includes("closed_short_at::text, closed_short_reason"), "getOrder lo trae");
});

test("compras: «Cerrar con lo recibido» solo admin/gerencia, solo confirmada (no directa) con algo recibido y algo pendiente; la píldora dice «Recibida (cerrada corta)»", () => {
  const pu = src("src/routes/purchases.tsx");
  assert.ok(pu.includes('(role === "admin" || role === "gerencia") && o.state === "confirmed" && o.fulfill_kind !== "direct" &&'));
  // useAccess() solo tiene contexto DENTRO del AppShell; Page lo renderiza, así que el botón vive en un componente hijo.
  assert.ok(fnBody(pu, "CloseShortPurchaseButton").includes("const { role } = useAccess();"), "el rol se lee dentro del shell, no en Page");
  assert.ok(pu.includes("<CloseShortPurchaseButton o={o} qlines={qlines} onDone={load} />"));
  assert.ok(pu.includes("onConfirm={(reason) => closeShortPurchase({ data: { poId: o.id, reason } })}"));
  assert.ok(pu.includes('? "Recibida (cerrada corta)"'));
  assert.ok(fnBody(src("src/lib/azagro.ts"), "listPurchases").includes("po.closed_short_reason,"), "listPurchases lo trae");
});

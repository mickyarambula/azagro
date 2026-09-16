// BLOQUE DE PARCIALES, paso 6 (PARCIALES.md § 8): límite de crédito por
// partes. Decisión 51 (9-sep-2026): el límite se APARTA al confirmar el
// pedido y se convierte en deuda real conforme se factura cada entrega.
// Hoy (antes de este paso) `used` era solo el saldo de facturas abiertas: un
// pedido confirmado y sin facturar consumía $0.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
// La aritmética (pura).
// ---------------------------------------------------------------------------
test("creditRoom: lo que ocupa la línea = facturado + apartado; el pedido nuevo cabe si no pasa el límite", () => {
  // Límite 100,000. Facturado 30,000. Un pedido confirmado de 50,000 del que ya se facturaron 20,000 → apartado 30,000.
  const r = creditRoom({ limit: 100000, invoiced: 30000, reserved: 30000, order: 35000 });
  assert.equal(r.used, 60000);
  assert.equal(r.after, 95000);
  assert.equal(r.exceeds, false);
  assert.equal(r.room, 40000);
  // Con el criterio de antes (solo facturado) cabrían 70,000; con la Decisión 51 solo 40,000.
  assert.equal(creditRoom({ limit: 100000, invoiced: 30000, reserved: 30000, order: 45000 }).exceeds, true, "45,000 ya no cabe: el apartado cuenta");
  assert.equal(creditRoom({ limit: 100000, invoiced: 30000, reserved: 0, order: 45000 }).exceeds, false, "sin apartado sí cabría — la diferencia es exactamente la Decisión 51");
});

test("creditRoom: sin límite capturado (0) no se limita — como siempre, ningún número por omisión decide", () => {
  const r = creditRoom({ limit: 0, invoiced: 1e9, reserved: 1e9, order: 1e9 });
  assert.equal(r.exceeds, false);
  assert.equal(r.room, null);
});

test("creditRoom: al centavo — 33.335 + 33.335 se redondea antes de comparar, no se acumula el tercer decimal", () => {
  const r = creditRoom({ limit: 100, invoiced: 33.335, reserved: 33.335, order: 33.33 });
  assert.equal(r.used, 66.67);
  assert.equal(r.after, 100);
  assert.equal(r.exceeds, false, "exactamente el límite: cabe");
  assert.equal(creditRoom({ limit: 100, invoiced: 33.335, reserved: 33.335, order: 33.34 }).exceeds, true);
});

// ---------------------------------------------------------------------------
// El apartado se lee en vivo de pedidos y facturas (sin columna "reservado").
// ---------------------------------------------------------------------------
test("creditExposure: apartado = Σ pedidos confirmados a crédito del cliente, cada uno menos sus facturas vivas, nunca negativo; excluye el pedido que se está confirmando", () => {
  const c = src("src/lib/erp/credit-limit.ts");
  const body = fnBody(c, "creditExposure");
  assert.ok(body.includes("partner_id = ${partnerId} and kind = 'customer' and state = 'open'"), "facturado: el saldo de facturas abiertas, como siempre");
  assert.ok(body.includes("and (${exclude} = 0 or order_id is distinct from ${exclude})"), "re-guardar un pedido con facturas: sus facturas salen del facturado porque su total entra completo (aviso del revisor)");
  assert.ok(body.includes("select coalesce(sum(greatest(0, so.total - coalesce(("), "apartado: total del pedido menos lo facturado, sin negativos");
  assert.ok(body.includes("i.name like 'FV-%'\n        and i.reverses_id is null and i.state <> 'reversed'"), "solo facturas vivas del pedido (una FV revertida vuelve a apartar)");
  // Violación que atrapó el revisor de dinero: en bodega propia entregar no factura (Decisión 47) y el pedido pasa a `done`
  // al terminar de entregar — si solo contara `confirmed`, un pedido entregado y sin facturar dejaría de ocupar la línea.
  assert.ok(body.includes("so.state in ('confirmed', 'done')"), "confirmado O entregado: aparta hasta que se facture; borrador y cancelado, no");
  assert.ok(body.includes("coalesce(so.term_kind,'credit_days') <> 'contado'"), "contado no ocupa línea");
  assert.ok(body.includes("so.id <> ${exclude}"), "el pedido que se confirma no se cuenta dos veces");
  assert.ok(!/alter table|add column|reserved_amount/.test(c), "sin columna nueva: se calcula en vivo (las facturas y los pedidos son la verdad)");
  assert.ok(!src("src/lib/erp/credit-limit.ts").includes("0.0304") && !/\b(0\.09|0\.04|18)\b/.test(c), "regla 9: ningún número de negocio en el código");
});

// ---------------------------------------------------------------------------
// Un solo lugar para la regla: saveOrder (el camino real) y createSale (el
// camino viejo sin pantalla) leen de credit-limit.ts — ya no hay dos copias.
// ---------------------------------------------------------------------------
test("saveOrder: el candado usa creditExposure/creditRoom (excluyendo el pedido que se confirma), y sigue exigiendo admin para exceder, con bitácora en los dos casos", () => {
  const body = fnBody(src("src/lib/erp/orders.ts"), "saveOrder");
  assert.ok(body.includes("const exposure = await creditExposure(sql, companyId, data.partnerId, { excludeSoId: data.id ?? null });"));
  assert.ok(body.includes("const room = creditRoom({ ...exposure, order: total });") && body.includes("if (room.exceeds) {"));
  assert.ok(body.includes('data.overrideCredit && member.role === "admin"'), "erp-permissions lo fija");
  assert.ok(body.includes('"rechazado-credito"') && body.includes('"autorizar-credito"'), "erp-trazabilidad lo fija");
  assert.ok(body.includes("detail: creditDetail(exposure, total),"), "bitácora con facturado y apartado por separado");
  assert.ok(body.includes("throw new Error(creditExceededMessage(exposure));"));
  assert.ok(!body.includes("select credit_limit::text from partners"), "la consulta ya no vive aquí");
});

test("createSale (camino viejo, sin pantalla): misma regla, mismo lugar — no queda una segunda copia desactualizada", () => {
  const az = src("src/lib/azagro.ts");
  const body = fnBody(az, "createSale");
  assert.ok(body.includes("const exposure = await creditExposure(sql, m.company_id, data.partnerId);"));
  assert.ok(body.includes("if (room.exceeds) {") && body.includes("throw new Error(creditExceededMessage(exposure));"));
  assert.ok(!body.includes("select credit_limit::text from partners"), "sin copia de la consulta");
  assert.equal((az.match(/select credit_limit::text from partners/g) || []).length, 0, "en todo azagro.ts");
  assert.equal((src("src/lib/erp/orders.ts").match(/select credit_limit::text from partners/g) || []).length, 0, "y en orders.ts");
});

test("el mensaje de rechazo sigue empezando con 'Supera el límite de crédito (' — las pantallas de pedido lo buscan para ofrecer la autorización de administrador", () => {
  const c = src("src/lib/erp/credit-limit.ts");
  assert.ok(c.includes("`Supera el límite de crédito (${x.limit.toFixed(0)})."));
  assert.ok(c.includes("apartado en pedidos confirmados sin facturar ${x.reserved.toFixed(0)}"), "y dice cuánto es apartado, aparte del facturado");
  for (const f of ["src/routes/sales.nuevo.tsx", "src/routes/sales.$orderId.tsx"]) {
    assert.ok(src(f).includes('error?.includes("límite de crédito")'), `${f}: la casilla de autorizar sigue enganchada al texto`);
  }
});

// ---------------------------------------------------------------------------
// Pantalla: la ficha del cliente enseña lo apartado junto a lo por cobrar.
// ---------------------------------------------------------------------------
test("ficha del cliente: 'apartado en pedidos confirmados sin facturar', con la misma consulta que el candado, y en cero para quien no ve cartera", () => {
  const az = src("src/lib/azagro.ts");
  const body = fnBody(az, "getPartner");
  assert.ok(body.includes("reserved: String((await creditExposure(sql, m.company_id, rows[0]!.id)).reserved)"), "lee del helper: un solo lugar para la regla (aviso del revisor)");
  assert.ok(!body.includes("as reserved"), "sin copia propia de la consulta");
  assert.ok(body.includes('ar: "0", reserved: "0", ap: "0", credit_limit: "0"'), "sin permiso de cartera, en cero como lo demás");
  const ui = src("src/routes/partners.$partnerId.tsx");
  assert.ok(ui.includes("apartado en pedidos confirmados sin facturar ${money(meta.reserved)}"));
  assert.ok(ui.includes("Number(meta.reserved) > 0.009"), "solo cuando hay algo apartado");
});

// BLOQUE DE DESHACER — PASO 3 (8-sep-2026): Decisión 14. La deuda con el
// proveedor NACE AL RECIBIR la mercancía, no al capturar la orden de compra.
//
// Antes nacía con la OC (azagro.ts, ops.ts, rfq.ts): si pedías hoy y llegaba
// en un mes, el sistema creía que llevabas 30 días de plazo consumidos que
// nunca corrieron, y la cuenta por pagar decía que debías algo que todavía no
// tenías.
//
// Prueba central: las órdenes y facturas de proveedor que YA existen no
// cambian de valor ni de vencimiento. Lo único que cambia es CUÁNDO nace la
// deuda de aquí en adelante.
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
// 1) CENTRAL — nada existente cambia de valor ni de vencimiento.
// ---------------------------------------------------------------------------
test("CENTRAL: ninguna factura ni orden existente se toca — solo se deja de crear la FP al capturar la OC", () => {
  for (const f of ["src/lib/azagro.ts", "src/lib/erp/ops.ts", "src/lib/erp/rfq.ts"]) {
    const c = src(f);
    assert.ok(!/update invoices set (amount|due_date|date)/.test(c), `${f}: nadie reescribe importes ni vencimientos`);
    assert.ok(!/update purchase_orders set (total|date)/.test(c), `${f}: nadie reescribe el total ni la fecha de una OC`);
  }
});

test("CENTRAL: los tres sitios de la OC ya no crean la factura de proveedor", () => {
  const sitios = [
    ["src/lib/azagro.ts", "createPurchase"],
    ["src/lib/erp/ops.ts", "decideQuote"],
    ["src/lib/erp/rfq.ts", "applyRfqWinners"],
  ];
  for (const [file, fn] of sitios) {
    const body = fnBody(src(file), fn);
    assert.ok(!body.includes("'supplier'"), `${fn} ya no inserta facturas de proveedor`);
    assert.ok(!body.includes("FP-${String("), `${fn} ya no folia una FP`);
    // Y con ello muere el cero silencioso que decía "contado" sin que nadie lo capturara.
    assert.ok(!body.includes("coalesce(payment_days,0)"), `${fn}: se fue el plazo 0 por omisión (regla 9)`);
  }
});

test("CENTRAL: el nacimiento es idempotente — recibir no duplica deuda, ni la crea de nuevo para una OC vieja que ya la traía", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "bornSupplierDebt");
  assert.ok(body.includes("kind = 'supplier' and origin = ${opts.poName}"), "busca si esa OC ya tiene su FP");
  assert.ok(body.includes("if (already[0]) return null;"), "si ya existe, no crea otra");
});

// ---------------------------------------------------------------------------
// 2) Dónde nace ahora: al recibir, y en brokeraje al entregar y facturar.
// ---------------------------------------------------------------------------
test("la deuda nace al recibir la mercancía", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "receivePurchase");
  assert.ok(body.includes("const fp = await bornSupplierDebt(sql, {"), "receivePurchase la hace nacer");
  assert.ok(body.includes("nace ${fp} por pagar"), "y queda en bitácora con su folio");
});

test("brokeraje: la OC directa nunca se recibe, así que su deuda nace al entregar y facturar", () => {
  const az = src("src/lib/azagro.ts");
  // La OC directa se rechaza en recepción: sin el camino de la entrega,
  // el brokeraje se quedaría sin cuenta por pagar.
  assert.ok(fnBody(az, "receivePurchase").includes("no se recibe en bodega"), "la directa no se recibe");
  const entrega = fnBody(az, "deliverSale");
  assert.ok(entrega.includes("if (direct) {"), "solo en pedido directo/brokeraje");
  assert.ok(entrega.includes("coalesce(fulfill_kind,'inventory') = 'direct' and state <> 'cancelled'"), "sus OC directas, sin las canceladas");
  assert.ok(entrega.includes("await bornSupplierDebt(sql, {"), "ahí nace la deuda");
  assert.ok(entrega.includes("brokeraje: nace ${fpsDirectas.join"), "y queda en bitácora");
});

test("la FP nace con la moneda y el tipo de cambio de su OC (antes el camino de recepción los perdía)", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "bornSupplierDebt");
  assert.ok(body.includes("coalesce(po.currency,'MXN') as currency"), "lee la moneda de la OC");
  assert.ok(body.includes("coalesce(po.fx_rate,1)::text as fx_rate"), "y su tipo de cambio");
  assert.ok(body.includes("origin, currency, fx_agreed, created_by"), "y los escribe en la factura");
});

// ---------------------------------------------------------------------------
// 3) Sin plazo capturado: se detiene, y el mensaje sirve a quien recibe.
// ---------------------------------------------------------------------------
test("sin plazo de pago capturado no se inventa un cero: se detiene", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "bornSupplierDebt");
  assert.ok(body.includes("if (!days[0] || days[0].payment_days == null)"), "vacío no es cero (regla 9)");
  assert.ok(!body.includes("coalesce(payment_days,0)"), "sin respaldo silencioso");
});

test("el mensaje dice qué falta, de qué proveedor y a quién pedírselo — quien recibe es almacén y no puede capturarlo", () => {
  const body = fnBody(src("src/lib/azagro.ts"), "bornSupplierDebt");
  assert.ok(body.includes("Falta el plazo de pago de ${po[0].partner}"), "nombra al proveedor");
  assert.ok(body.includes("compras, administración o gerencia"), "dice a quién llamar");
  assert.ok(body.includes("si es de contado, se captura 0"), "dice qué se captura");
  assert.ok(!/regla 9|payment_days|coalesce|null/.test(body.slice(body.indexOf("Falta el plazo"), body.indexOf("En cuanto esté"))), "nada técnico en el mensaje");
  // Almacén ve proveedores pero no los edita: por eso el mensaje manda a pedirlo.
  const acl = src("src/lib/erp/acl.ts");
  assert.ok(acl.includes('partners: "view"'), "almacén no puede capturar proveedores");
});

// ---------------------------------------------------------------------------
// 4) Decisión 23 — las FP viejas se marcan, derivado y sin columna.
// ---------------------------------------------------------------------------
test("la marca de FP vieja se deriva de la OC sin recibir — sin columna, se limpia sola", () => {
  const az = src("src/lib/azagro.ts");
  assert.ok(az.includes("po.state not in ('done','cancelled')"), "la marca es 'su orden no se ha recibido ni cancelado'");
  assert.ok(az.includes(")) as unreceived"), "listInvoices la trae por renglón");
  assert.ok(az.includes("fpSinRecibir: seeCredit ?"), "el tablero trae el conteo, solo a quien ve cartera");
  // No se inventó columna para esto.
  const migraciones = src("migrations/0029_bloque_deshacer_paso0.sql");
  assert.ok(!/unreceived|legacy_fp/.test(migraciones), "nada de columna nueva: es derivable");
});

test("el aviso está en el tablero y la marca en cartera, donde alguien está por pagar", () => {
  const tablero = src("src/routes/index.tsx");
  assert.ok(tablero.includes("data!.fpSinRecibir} factura"), "aviso con el número");
  assert.ok(tablero.includes("mercancía que todavía no\n            llega"), "dice qué son");
  assert.ok(tablero.includes("Se limpian solas al recibir la orden o al cancelarla."), "y que no hay que hacer nada a mano");
  assert.ok(tablero.includes('search={{ lado: "pagar" }}'), "liga a cartera por pagar");
  const cartera = src("src/routes/credit.tsx");
  assert.ok(cartera.includes("{r.unreceived ?"), "y la marca sale por renglón");
  assert.ok(cartera.includes("Mercancía no recibida"), "con texto de negocio, no técnico");
});

// ---------------------------------------------------------------------------
// 5) Los textos que dejaban de ser ciertos.
// ---------------------------------------------------------------------------
test("los textos ya no prometen que la deuda nace con la orden", () => {
  const az = src("src/lib/azagro.ts");
  assert.ok(!az.includes("genera ${iname} por pagar"), "la bitácora de crear-oc ya no promete una FP");
  assert.ok(fnBody(az, "createPurchase").includes("la deuda nace al recibir"), "dice cuándo nace de verdad");
  const rules = src("src/lib/erp/rules.ts");
  assert.ok(rules.includes("La deuda todavía no nace aquí: nace cuando la mercancía llega"), "la tarjeta de la OC, corregida");
  assert.ok(rules.includes("Al recibir nace la cuenta por pagar al proveedor"), "la tarjeta de recibir, también");
  assert.ok(rules.includes("la cuenta por pagar nace al entregar y facturar"), "y el caso de brokeraje");
});

// ---------------------------------------------------------------------------
// 6) El script de verificación contra producción (solo lectura).
// ---------------------------------------------------------------------------
test("el script contesta las dos preguntas y no escribe nada", () => {
  const s = src("scripts/erp-fp-sin-recibir.mjs");
  assert.ok(s.includes("FACTURAS DE PROVEEDOR DE MERCANCÍA QUE TODAVÍA NO LLEGA"), "pregunta 1");
  assert.ok(s.includes("PROVEEDORES CON ÓRDENES ABIERTAS Y SIN PLAZO DE PAGO CAPTURADO"), "pregunta 2");
  assert.ok(!/\b(insert|update|delete)\s+(into\s+)?[a-z_]+/i.test(s.replace(/--[^\n]*/g, "")), "solo lectura, de verdad");
});

// Dos precios por partida (contado / crédito), captura inversa, solicitud
// bloqueada al cotizar y plazo heredado en el pedido.
//
// 1) Fórmulas: copia literal de src/lib/erp/margins.ts (si cambia allá, cambia
//    aquí a propósito). Financiamiento: NO se toca, viene de pricing.ts.
// 2) Cableado: los archivos contienen exactamente lo que el flujo necesita.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

function fnBody(source, name) {
  const start = source.indexOf(`export const ${name} `);
  assert.notEqual(start, -1, `No existe export const ${name}`);
  const rest = source.slice(start + 10);
  const next = rest.search(/\nexport /);
  return next === -1 ? rest : rest.slice(0, next);
}

// ---------------------------------------------------------------------------
// Copia de margins.ts
// ---------------------------------------------------------------------------
function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
function marginOf(row, which) {
  const mode = which === "cash" ? row.margin_cash_mode : row.margin_credit_mode;
  if (mode === "pct" || mode === "nominal") {
    return {
      mode,
      pct: n(which === "cash" ? row.margin_cash_pct : row.margin_credit_pct),
      nominal: n(which === "cash" ? row.margin_cash_nominal : row.margin_credit_nominal),
      legacy: false,
    };
  }
  if (row.margin_mode === "pct" || row.margin_mode === "nominal") {
    return { mode: row.margin_mode, pct: n(row.margin_pct), nominal: n(row.margin_nominal), legacy: true };
  }
  return { mode: "pct", pct: row.margin_pct == null ? 12 : n(row.margin_pct), nominal: n(row.margin_nominal), legacy: true };
}
function marginUnit(m, landed) {
  return m.mode === "nominal" ? m.nominal : (landed * m.pct) / 100;
}
function priceFromMargin(i) {
  return Math.round((i.landed + marginUnit(i.margin, i.landed) + Math.max(0, i.finance)) * 10000) / 10000;
}
function marginFromPrice(i) {
  const nominal = Math.round((i.price - i.landed - Math.max(0, i.finance)) * 10000) / 10000;
  const pct = i.landed > 0 ? Math.round(((nominal / i.landed) * 100) * 10000) / 10000 : 0;
  return { mode: i.mode, pct, nominal };
}
function normalizeMargin(m, landed) {
  if (m.mode === "nominal") {
    return { mode: "nominal", nominal: m.nominal, pct: landed > 0 ? Math.round(((m.nominal / landed) * 100) * 10000) / 10000 : 0 };
  }
  return { mode: "pct", pct: m.pct, nominal: Math.round(((landed * m.pct) / 100) * 10000) / 10000 };
}
// Copia de pricing.ts (solo para armar el ejemplo; la fórmula se prueba en erp-formulas).
function financeUnit(i) {
  if (i.days <= 0) return 0;
  const commission = i.cost * i.commissionRate;
  const layer1 = i.cost * (1 + i.commissionRate) * (i.tiie + i.costSpread) * (i.days / 360);
  return commission + layer1;
}

test("las copias de margins.ts siguen iguales al original", () => {
  const m = src("src/lib/erp/margins.ts");
  assert.ok(m.includes("return m.mode === \"nominal\" ? m.nominal : (landed * m.pct) / 100;"), "marginUnit");
  assert.ok(m.includes("Math.round((i.landed + marginUnit(i.margin, i.landed) + Math.max(0, i.finance)) * 10000) / 10000"), "priceFromMargin");
  assert.ok(m.includes("const nominal = Math.round((i.price - i.landed - Math.max(0, i.finance)) * 10000) / 10000;"), "marginFromPrice");
  assert.ok(m.includes("return { mode: \"pct\", pct: row.margin_pct == null ? 12 : n(row.margin_pct), nominal: n(row.margin_nominal), legacy: true };"), "marginOf legacy 12%");
});

// ---------------------------------------------------------------------------
// A1/A2 — dos márgenes independientes, dos precios.
// ---------------------------------------------------------------------------
test("contado y crédito tienen cada uno su margen: cambiar uno no mueve el otro", () => {
  const landed = 10000; // costo puesto por unidad
  const fin = financeUnit({ cost: landed, days: 150, tiie: 0.0706, costSpread: 0.09, commissionRate: 0.01 });
  // 1% comisión = 100; capa 1 = 10000 × 1.01 × 0.1606 × 150/360 = 675.86
  assert.ok(Math.abs(fin - 775.8583) < 0.01, `fin ${fin}`);

  const row = { margin_cash_mode: "pct", margin_cash_pct: 10, margin_credit_mode: "nominal", margin_credit_nominal: 1500 };
  const cash = priceFromMargin({ landed, finance: 0, margin: marginOf(row, "cash") });
  const credit = priceFromMargin({ landed, finance: fin, margin: marginOf(row, "credit") });
  assert.equal(cash, 11000, "contado = costo + 10%, sin financiamiento");
  assert.ok(Math.abs(credit - (10000 + 1500 + fin)) < 0.001, "crédito = costo + $1500 + financiamiento");

  // Subir el margen de contado a 20% no toca el crédito.
  const row2 = { ...row, margin_cash_pct: 20 };
  assert.equal(priceFromMargin({ landed, finance: 0, margin: marginOf(row2, "cash") }), 12000);
  assert.equal(priceFromMargin({ landed, finance: fin, margin: marginOf(row2, "credit") }), credit);
});

test("sin margen nuevo (dato anterior a 0017) se usa el margen único viejo y se marca legacy; sin nada, 12%", () => {
  const viejo = marginOf({ margin_mode: "nominal", margin_nominal: 800, margin_pct: 8 }, "credit");
  assert.deepEqual(viejo, { mode: "nominal", pct: 8, nominal: 800, legacy: true });
  const nada = marginOf({}, "cash");
  assert.deepEqual(nada, { mode: "pct", pct: 12, nominal: 0, legacy: true });
  const nuevo = marginOf({ margin_cash_mode: "pct", margin_cash_pct: 15, margin_mode: "nominal", margin_nominal: 800 }, "cash");
  assert.equal(nuevo.legacy, false);
  assert.equal(nuevo.pct, 15);
});

// ---------------------------------------------------------------------------
// A3 — captura inversa: del precio final salen utilidad y margen %.
// ---------------------------------------------------------------------------
test("captura inversa: precio → utilidad y margen %, y de regreso da el mismo precio", () => {
  const landed = 10000;
  const fin = 775.8583;
  // Contado: escribo 11 500 → utilidad 1 500, margen 15%.
  const mc = marginFromPrice({ price: 11500, landed, finance: 0, mode: "pct" });
  assert.equal(mc.nominal, 1500);
  assert.equal(mc.pct, 15);
  assert.equal(priceFromMargin({ landed, finance: 0, margin: mc }), 11500);
  // Crédito: escribo 12 500 → utilidad = 12 500 − 10 000 − 775.86 = 1 724.14; margen 17.24%.
  const mk = marginFromPrice({ price: 12500, landed, finance: fin, mode: "nominal" });
  assert.equal(mk.nominal, 1724.1417);
  assert.equal(mk.pct, 17.2414);
  assert.equal(priceFromMargin({ landed, finance: fin, margin: mk }), 12500);
});

test("utilidad negativa se calcula y se guarda tal cual (aviso, no candado)", () => {
  const m = marginFromPrice({ price: 9500, landed: 10000, finance: 0, mode: "pct" });
  assert.equal(m.nominal, -500);
  assert.equal(m.pct, -5);
  // La UI no bloquea: OfferCells solo pinta en rojo y el aviso dice "Se puede guardar".
  const q = src("src/routes/quotes.tsx");
  assert.ok(q.includes("Utilidad negativa: el precio no cubre el costo puesto"), "aviso de utilidad negativa");
  assert.ok(q.includes("Se puede guardar"), "no bloquea");
  const ops = src("src/lib/erp/ops.ts");
  assert.ok(!fnBody(ops, "reviseQuote").includes("Utilidad negativa"), "el servidor tampoco bloquea");
});

test("normalizeMargin deja % y $ en sincronía según el modo", () => {
  assert.deepEqual(normalizeMargin({ mode: "pct", pct: 12, nominal: 0 }, 10000), { mode: "pct", pct: 12, nominal: 1200 });
  assert.deepEqual(normalizeMargin({ mode: "nominal", pct: 0, nominal: 1500 }, 10000), { mode: "nominal", nominal: 1500, pct: 15 });
  assert.deepEqual(normalizeMargin({ mode: "nominal", pct: 0, nominal: 1500 }, 0), { mode: "nominal", nominal: 1500, pct: 0 });
});

// ---------------------------------------------------------------------------
// A5/A6 — bitácora por margen y migración sin rellenar datos viejos.
// ---------------------------------------------------------------------------
test("saveLineMargin guarda por columna (which) y la bitácora dice cuál margen cambió", () => {
  const req = src("src/lib/erp/requests.ts");
  const body = fnBody(req, "saveLineMargin");
  assert.ok(body.includes(`which: z.enum(["cash", "credit"])`), "recibe cuál margen");
  assert.ok(body.includes("set margin_cash_mode = ${data.marginMode}, margin_cash_pct = ${data.marginPct}, margin_cash_nominal = ${data.marginNominal}"), "escribe columnas de contado");
  assert.ok(body.includes("set margin_credit_mode = ${data.marginMode}, margin_credit_pct = ${data.marginPct}, margin_credit_nominal = ${data.marginNominal}"), "escribe columnas de crédito");
  assert.ok(body.includes("const etiqueta = OFFER_LABEL[data.which];"), "etiqueta contado/crédito");
  assert.ok(body.includes("detail: `${before[0].code}: margen ${etiqueta} ${old} → ${nuevo}`"), "anterior → nuevo con etiqueta");
  assert.ok(!body.includes("update customer_request_lines set margin_mode ="), "ya no pisa el margen único viejo");
});

test("la migración 0017 solo agrega columnas nulas: no rellena datos existentes (A6 pendiente de respuesta)", () => {
  const mig = src("migrations/0017_dos_precios.sql");
  for (const col of ["margin_cash_mode", "margin_cash_pct", "margin_cash_nominal", "margin_credit_mode", "margin_credit_pct", "margin_credit_nominal"]) {
    assert.ok(mig.includes(col), `columna ${col}`);
  }
  assert.ok(mig.includes("finance_unit"), "finance_unit en quote_lines");
  assert.ok(mig.includes("accepted_offer"), "accepted_offer");
  assert.ok(!/^\s*update\s/im.test(mig), "sin update: los datos viejos no se tocan hasta que el dueño decida");
  const adds = mig.split("\n").filter((l) => /add column/i.test(l));
  assert.ok(adds.length >= 18, "agrega las columnas nuevas");
  assert.ok(adds.every((l) => !/\bdefault\b/i.test(l)), "columnas nuevas sin default: nulo = todavía no capturado");
  // Las tablas de solicitud nacieron en código, no en migración: en base vacía se crean aquí.
  assert.ok(mig.includes("create table if not exists customer_requests"), "crea customer_requests si no existe");
  assert.ok(mig.includes("create table if not exists customer_request_lines"), "crea customer_request_lines si no existe");
});

test("quoteFromRequest arma los dos precios: contado sin financiamiento, crédito con financiamiento, y guarda márgenes + finance_unit", () => {
  const req = src("src/lib/erp/requests.ts");
  const body = fnBody(req, "quoteFromRequest");
  assert.ok(body.includes("commissionRate: pol.asrCommission"), "comisión de Ajustes (fórmula intacta)");
  assert.ok(body.includes("days: 0,"), "contado con 0 días");
  assert.ok(body.includes("margin_cash_mode, margin_cash_pct, margin_cash_nominal, margin_credit_mode, margin_credit_pct, margin_credit_nominal, finance_unit"), "inserta márgenes y financiamiento por unidad");
  assert.ok(!body.includes("resolveCost"), "el costo sigue siendo el del proveedor ganador (RFQ intacto)");
});

// ---------------------------------------------------------------------------
// A4 — la cotización registra cuál precio aceptó el cliente; el pedido lo hereda.
// ---------------------------------------------------------------------------
test("decideQuote guarda accepted_offer en la cotización y en el pedido", () => {
  const ops = src("src/lib/erp/ops.ts");
  const body = fnBody(ops, "decideQuote");
  assert.ok(body.includes("policy_code, price_mode, accepted_offer"), "columnas en el insert del pedido");
  assert.ok(body.includes("accepted_offer = ${offer} where id = ${q[0].id}"), "queda en la cotización");
  const orders = src("src/lib/erp/orders.ts");
  const get = fnBody(orders, "getOrder");
  assert.ok(get.includes(`const which: Offer = origin?.accepted_offer === "cash" ? "cash" : "credit";`), "el pedido lee el margen de la columna aceptada");
});

// ---------------------------------------------------------------------------
// B1 — la solicitud que ya cotizó se bloquea; los cambios van por la cotización.
// ---------------------------------------------------------------------------
test("solicitud bloqueada al cotizar: servidor (todas las escrituras) y RFQ", () => {
  const lock = src("src/lib/erp/request-lock.ts");
  assert.ok(lock.includes("Esta solicitud ya generó ${quoteName ?? \"una cotización\"}. Los cambios se hacen desde la cotización"), "mensaje claro");
  const req = src("src/lib/erp/requests.ts");
  for (const fn of ["saveRequestTerms", "sendVendorRfq", "saveLineMargin", "saveLineFreight", "pickVendor", "applyCheapest"]) {
    assert.ok(fnBody(req, fn).includes("await assertRequestOpen(sql, companyId, data."), `${fn} respeta el candado`);
  }
  const rfq = src("src/lib/erp/rfq.ts");
  assert.ok(rfq.includes("await assertRfqOpen(sql, data.rfqId);"), "las ofertas del RFQ también");
  assert.ok(!rfq.includes("resolveCost"), "RFQ: costo = precio del proveedor ganador, sin tocar");
});

test("solicitud bloqueada en pantalla: banner con liga a la COT y al PV, y campos apagados", () => {
  const ui = src("src/routes/solicitudes.$solicitudId.tsx");
  assert.ok(ui.includes("const locked = Boolean(request.quote_id);"), "candado = ya tiene cotización");
  assert.ok(ui.includes("<strong>Esta solicitud ya generó</strong>"), "banner");
  assert.ok(ui.includes(`<Link to="/quotes" search={{ ver: request.quote_id ?? undefined }}`), "liga a la cotización");
  assert.ok(ui.includes(`to="/sales/$orderId"`), "liga al pedido");
  assert.ok((ui.match(/disabled=\{locked\}/g) ?? []).length >= 8, "ofertas, flete, moneda y financiamiento apagados");
  assert.ok(ui.includes(`disabled={locked} onSaved={load}`), "márgenes apagados");
});

// ---------------------------------------------------------------------------
// B2 — los días de crédito (y moneda/TC) de la solicitud se guardan, no viven solo en memoria.
// ---------------------------------------------------------------------------
test("plazo, moneda y TC de la solicitud se guardan al salir del campo y se restauran al volver", () => {
  const req = src("src/lib/erp/requests.ts");
  const terms = fnBody(req, "saveRequestTerms");
  assert.ok(terms.includes(`action: "plazo-solicitud"`), "bitácora");
  assert.ok(terms.includes("plazo ${"), "anterior → nuevo del plazo");
  assert.ok(fnBody(req, "getRequest").includes("credit_days"), "getRequest devuelve el plazo guardado");
  const ui = src("src/routes/solicitudes.$solicitudId.tsx");
  assert.ok(ui.includes("onCommit={(n) => saveTerms({ creditDays: Math.max(0, Math.floor(n)) })}"), "días al salir del campo");
  assert.ok(ui.includes("onCommit={(n) => saveTerms({ fxRate: n })}"), "TC al salir del campo");
  assert.ok(ui.includes("saveTerms({ currency"), "moneda al cambiar");
  assert.ok(!/onChange=\{\([^)]*\) => saveTerms/.test(ui), "nunca por tecla");
  const mig = src("migrations/0017_dos_precios.sql");
  assert.ok(mig.includes("customer_requests add column if not exists credit_days"), "columna en la solicitud");
});

// ---------------------------------------------------------------------------
// C1/C2 — el pedido hereda el plazo; cambiarlo es explícito, recalcula y deja bitácora.
// ---------------------------------------------------------------------------
test("changeOrderTerm: solo borrador, rehace precios con el margen de crédito guardado, dues y bitácora", () => {
  const orders = src("src/lib/erp/orders.ts");
  const body = fnBody(orders, "changeOrderTerm");
  assert.ok(body.includes(`if (so[0].state !== "draft") throw new Error("Pedido confirmado: el plazo ya no se cambia.`), "confirmado no cambia");
  assert.ok(body.includes("financeUnit({ cost: landed, days, tiie: Number(q[0].tiie), costSpread: Number(q[0].spread), commissionRate: pol.asrCommission })"), "financiamiento con la misma fórmula y TIIE/spread de la COT");
  assert.ok(body.includes(`priceFromMargin({ landed, finance: fin, margin: marginOf(l, "credit") })`), "precio = costo + margen crédito + financiamiento");
  assert.ok(body.includes("price = Number(l.cash_price);"), "a 0 días vuelve al precio de contado");
  assert.ok(body.includes("Math.min(pol.invoiceDays || days, days)"), "días factura de Ajustes sin pasar del plazo");
  assert.ok(body.includes(`action: "cambiar-plazo-pedido"`), "bitácora");
  assert.ok(body.includes("`plazo ${so[0].credit_days} → ${days} d`"), "anterior → nuevo");
  assert.ok(body.includes("${l.code} precio ${Number(l.unit_price)} → ${price}"), "precio por partida anterior → nuevo");
});

test("pantalla del pedido: plazo heredado con origen, cambio explícito con aviso, y días apagados", () => {
  const ui = src("src/routes/sales.$orderId.tsx");
  assert.ok(ui.includes("changeOrderTerm({ data: { id, creditDays: newDays } })"), "cambio explícito por servidor");
  assert.ok(ui.includes("Cambiar el plazo de {form.name}"), "panel de cambio");
  assert.ok(ui.includes("Con otro plazo ese precio ya no"), "aviso");
  assert.ok(ui.includes("Heredado de {origin.quote_name}"), "origen visible");
  const form = src("src/components/order-form.tsx");
  assert.ok((form.match(/disabled=\{locked \|\| Boolean\(inherited\)\}/g) ?? []).length === 2, "días factura y crédito no se editan a mano cuando vienen de la COT");
  assert.ok(form.includes("Heredado de {inherited.quoteName}"), "chip de origen");
});

// ---------------------------------------------------------------------------
// C4 — valores por omisión del pedido salen de Ajustes y de la política del cliente.
// ---------------------------------------------------------------------------
test("decideQuote: días factura de Ajustes (tope = plazo), política de mora por cliente, contado sin mora", () => {
  const ops = src("src/lib/erp/ops.ts");
  const body = fnBody(ops, "decideQuote");
  assert.ok(body.includes("const invoiceDays = days > 0 ? Math.min(pol.invoiceDays || days, days) : 0;"), "factura = Ajustes, sin pasar del plazo");
  assert.ok(body.includes(`const policyCode = days > 0 ? (grp[0]?.group_name === "Grupo SL" ? "GRUPO_SL" : "ESTANDAR") : "NONE";`), "mora por cliente");
  assert.ok(body.includes(`const priceMode = days > 0 ? "financed" : "cash";`), "modo de precio");
});

// ---------------------------------------------------------------------------
// Cotización: dos columnas con captura inversa, sin ligar crédito a contado.
// ---------------------------------------------------------------------------
test("panel de la cotización: captura inversa por columna, sin fórmula crédito = contado + fin", () => {
  const q = src("src/routes/quotes.tsx");
  assert.ok(q.includes("function OfferCells("), "celdas de una columna (precio / utilidad / margen)");
  assert.ok(q.includes("onChange={(u) => onPrice(round4(landed + fin + u))}"), "utilidad → precio");
  assert.ok(q.includes("onChange={(m) => onPrice(round4(landed + fin + (landed * m) / 100))}"), "margen % → precio");
  assert.ok(q.includes(`<OfferCells price={rp.cash} landed={landed} fin={0}`), "contado sin financiamiento");
  assert.ok(q.includes(`<OfferCells price={rp.credit} landed={landed} fin={fin}`), "crédito con financiamiento");
  const panel = q.slice(q.indexOf("Documento al cliente"));
  assert.ok(!panel.includes("creditFromCash("), "en el panel el crédito ya no se deriva del contado (cada columna tiene su margen)");
  assert.ok(q.includes("validateSearch"), "?ver= abre el folio desde la solicitud/pedido");
  assert.ok(q.includes("El cliente aceptó el precio de {OFFER_LABEL[qrow.accepted_offer]}"), "muestra cuál precio aceptó");
});

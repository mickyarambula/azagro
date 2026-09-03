// Dos precios por partida (contado / crédito), captura inversa, solicitud
// bloqueada al cotizar y plazo heredado en el pedido.
//
// 1) Fórmulas: copia literal de src/lib/erp/margins.ts (si cambia allá, cambia
//    aquí a propósito). Financiamiento: NO se toca, viene de pricing.ts.
//    Desde el 3-sep-2026 el margen % es SOBRE EL PRECIO DE VENTA y el
//    financiamiento se suma al costo antes del margen:
//      precio = (costo puesto + financiamiento) ÷ (1 − margen %)
//      precio =  costo puesto + financiamiento + margen $
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
  const pct = which === "cash" ? row.margin_cash_pct : row.margin_credit_pct;
  const nominal = which === "cash" ? row.margin_cash_nominal : row.margin_credit_nominal;
  if ((mode === "pct" || mode === "nominal") && (pct != null || nominal != null)) {
    return {
      mode,
      pct: n(pct),
      nominal: n(nominal),
      legacy: false,
      source: which === "cash" ? row.margin_cash_source ?? null : row.margin_credit_source ?? null,
    };
  }
  if ((row.margin_mode === "pct" || row.margin_mode === "nominal") && (row.margin_pct != null || row.margin_nominal != null)) {
    return { mode: row.margin_mode, pct: n(row.margin_pct), nominal: n(row.margin_nominal), legacy: true, source: null };
  }
  return null;
}
const round4 = (x) => Math.round(x * 10000) / 10000;
function marginValid(m) {
  return m != null && (m.mode === "nominal" || m.pct < 100);
}
function marginUnit(m, landed, finance = 0) {
  if (m.mode === "nominal") return m.nominal;
  if (!marginValid(m)) throw new Error(`Margen ${Number(m.pct)}% sobre el precio: tiene que ser menor a 100%.`);
  const base = landed + Math.max(0, finance);
  return (base * m.pct) / (100 - m.pct);
}
function priceFromMargin(i) {
  const fin = Math.max(0, i.finance);
  return round4(i.landed + fin + marginUnit(i.margin, i.landed, fin));
}
function marginFromPrice(i) {
  const nominal = round4(i.price - i.landed - Math.max(0, i.finance));
  const pct = i.price > 0 ? round4((nominal / i.price) * 100) : 0;
  return { mode: i.mode, pct, nominal };
}
function normalizeMargin(m, landed, finance = 0) {
  const fin = Math.max(0, finance);
  if (m.mode === "nominal") {
    const price = landed + fin + m.nominal;
    return { mode: "nominal", nominal: m.nominal, pct: price > 0 ? round4((m.nominal / price) * 100) : 0 };
  }
  return { mode: "pct", pct: m.pct, nominal: round4(marginUnit(m, landed, fin)) };
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
  assert.ok(m.includes("return (base * m.pct) / (100 - m.pct);"), "marginUnit: margen % sobre el precio (base × m / (100 − m))");
  assert.ok(m.includes("const base = landed + Math.max(0, finance);"), "marginUnit: el financiamiento entra a la base ANTES del margen");
  assert.ok(m.includes("return round4(i.landed + fin + marginUnit(i.margin, i.landed, fin));"), "priceFromMargin = (costo + fin) ÷ (1 − margen)");
  assert.ok(m.includes("const nominal = round4(i.price - i.landed - Math.max(0, i.finance));"), "marginFromPrice: utilidad = precio − costo − fin");
  assert.ok(m.includes("const pct = i.price > 0 ? round4((nominal / i.price) * 100) : 0;"), "marginFromPrice: % sobre el PRECIO, no sobre el costo");
  assert.ok(m.includes('return m != null && (m.mode === "nominal" || m.pct < 100);'), "un % de 100 o más no da precio");
  assert.ok(m.includes("if ((mode === \"pct\" || mode === \"nominal\") && (pct != null || nominal != null))"), "marginOf: nulo no es cero");
  assert.ok(m.trimEnd().includes("  return null;\n}"), "marginOf termina en null, no en un margen inventado");
});

// ---------------------------------------------------------------------------
// A1/A2 — dos márgenes independientes, dos precios.
// ---------------------------------------------------------------------------
test("contado y crédito tienen cada uno su margen: cambiar uno no mueve el otro", () => {
  const landed = 10000; // costo puesto por unidad
  // Parámetros reales de Ajustes: TIIE 7.06% + spread ASR 4% (el 9% es el de
  // mora, que NO entra en el precio), comisión ASR 1%.
  const fin = financeUnit({ cost: landed, days: 150, tiie: 0.0706, costSpread: 0.04, commissionRate: 0.01 });
  // comisión 1% = 100; capa 1 = 10 000 × 1.01 × 0.1106 × 150/360 = 465.44
  assert.ok(Math.abs(fin - 565.4417) < 0.01, `fin ${fin}`);

  const row = { margin_cash_mode: "pct", margin_cash_pct: 10, margin_credit_mode: "nominal", margin_credit_nominal: 1500 };
  const cash = priceFromMargin({ landed, finance: 0, margin: marginOf(row, "cash") });
  const credit = priceFromMargin({ landed, finance: fin, margin: marginOf(row, "credit") });
  assert.equal(cash, 11111.1111, "contado = costo ÷ (1 − 10%), sin financiamiento: el 10% es del precio");
  assert.ok(Math.abs(cash - 10000 - cash * 0.1) < 0.001, "la utilidad es exactamente 10% del precio");
  assert.ok(Math.abs(credit - (10000 + 1500 + fin)) < 0.001, "crédito = costo + financiamiento + $1500");

  // Subir el margen de contado a 20% no toca el crédito.
  const row2 = { ...row, margin_cash_pct: 20 };
  assert.equal(priceFromMargin({ landed, finance: 0, margin: marginOf(row2, "cash") }), 12500);
  assert.equal(priceFromMargin({ landed, finance: fin, margin: marginOf(row2, "credit") }), credit);
});

test("no hay margen por omisión: sin dato es null, nunca 12% ni 0%", () => {
  const viejo = marginOf({ margin_mode: "nominal", margin_nominal: 800, margin_pct: 8 }, "credit");
  assert.deepEqual(viejo, { mode: "nominal", pct: 8, nominal: 800, legacy: true, source: null });
  // Nada capturado: sin margen. Antes esto devolvía 12% inventado.
  assert.equal(marginOf({}, "cash"), null);
  // Columna vieja en nulo (una partida nueva después de la 0018): sin margen.
  assert.equal(marginOf({ margin_mode: "pct", margin_pct: null, margin_nominal: null }, "cash"), null);
  const nuevo = marginOf({ margin_cash_mode: "pct", margin_cash_pct: 15, margin_cash_source: "captura", margin_mode: "nominal", margin_nominal: 800 }, "cash");
  assert.equal(nuevo.legacy, false);
  assert.equal(nuevo.pct, 15);
  assert.equal(nuevo.source, "captura");
  // Un margen de 0% capturado a propósito SÍ es un margen (vender al costo).
  const cero = marginOf({ margin_credit_mode: "pct", margin_credit_pct: 0, margin_credit_source: "captura" }, "credit");
  assert.deepEqual(cero, { mode: "pct", pct: 0, nominal: 0, legacy: false, source: "captura" });
});

test("el origen del margen distingue lo capturado de lo que copió la migración", () => {
  const copiado = marginOf({ margin_cash_mode: "pct", margin_cash_pct: 12, margin_cash_source: "migracion" }, "cash");
  assert.equal(copiado.source, "migracion");
  const m = src("src/lib/erp/margins.ts");
  assert.ok(m.includes('export type MarginSource = "captura" | "migracion";'), "los dos orígenes posibles");
  // La pantalla lo dice, no se queda en la base.
  assert.ok(src("src/routes/solicitudes.$solicitudId.tsx").includes('m.source === "migracion" ? "de la migración"'), "solicitud");
  assert.ok(src("src/routes/sales.$orderId.tsx").includes('o.margin.source === "migracion"'), "pedido");
  // Y lo que escribe una persona queda marcado 'captura'.
  assert.ok(src("src/lib/erp/requests.ts").includes("margin_cash_source = 'captura'"), "saveLineMargin marca captura");
  assert.ok(src("src/lib/erp/ops.ts").includes("margin_cash_source = 'captura'"), "la revisión marca captura");
});

// ---------------------------------------------------------------------------
// A3 — captura inversa: del precio final salen utilidad y margen %.
// ---------------------------------------------------------------------------
test("captura inversa: precio → utilidad y margen %, y de regreso da el mismo precio", () => {
  const landed = 10000;
  const fin = 565.4417; // TIIE 7.06% + spread ASR 4%, comisión 1%, 150 d
  // Contado: escribo 11 500 → utilidad 1 500, margen 13.04% DEL PRECIO (1 500 / 11 500).
  const mc = marginFromPrice({ price: 11500, landed, finance: 0, mode: "pct" });
  assert.equal(mc.nominal, 1500);
  assert.equal(mc.pct, 13.0435);
  // De regreso con el % (redondeado a 4 decimales, como la columna numeric(8,4)) queda a centavos.
  assert.ok(Math.abs(priceFromMargin({ landed, finance: 0, margin: mc }) - 11500) < 0.01);
  // Crédito: escribo 12 500 → utilidad = 12 500 − 10 000 − 565.44 = 1 934.56; margen 15.48% del precio.
  const mk = marginFromPrice({ price: 12500, landed, finance: fin, mode: "nominal" });
  assert.equal(mk.nominal, 1934.5583);
  assert.equal(mk.pct, 15.4765);
  assert.equal(priceFromMargin({ landed, finance: fin, margin: mk }), 12500);
});

test("utilidad negativa se calcula y se guarda tal cual (aviso, no candado)", () => {
  const m = marginFromPrice({ price: 9500, landed: 10000, finance: 0, mode: "pct" });
  assert.equal(m.nominal, -500);
  assert.equal(m.pct, -5.2632);
  // La UI no bloquea: OfferCells solo pinta en rojo y el aviso dice "Se puede guardar".
  const q = src("src/routes/quotes.tsx");
  assert.ok(q.includes("Utilidad negativa: el precio no cubre el costo puesto"), "aviso de utilidad negativa");
  assert.ok(q.includes("Se puede guardar"), "no bloquea");
  const ops = src("src/lib/erp/ops.ts");
  assert.ok(!fnBody(ops, "reviseQuote").includes("Utilidad negativa"), "el servidor tampoco bloquea");
});

test("normalizeMargin deja % y $ en sincronía según el modo (el % es del precio, con su financiamiento)", () => {
  // 12% del precio con costo 10 000: precio 11 363.64, utilidad 1 363.64.
  assert.deepEqual(normalizeMargin({ mode: "pct", pct: 12, nominal: 0 }, 10000), { mode: "pct", pct: 12, nominal: 1363.6364 });
  // Con financiamiento 558.71 la base sube y el $ también: (10 558.71 × 12 / 88).
  assert.deepEqual(normalizeMargin({ mode: "pct", pct: 12, nominal: 0 }, 10000, 558.71), { mode: "pct", pct: 12, nominal: 1439.8241 });
  // $1 500 sobre costo 10 000: precio 11 500 → 13.04% del precio.
  assert.deepEqual(normalizeMargin({ mode: "nominal", pct: 0, nominal: 1500 }, 10000), { mode: "nominal", nominal: 1500, pct: 13.0435 });
  // Sin costo todo el precio es utilidad: 100% (el $ fijo sigue siendo válido).
  assert.deepEqual(normalizeMargin({ mode: "nominal", pct: 0, nominal: 1500 }, 0), { mode: "nominal", nominal: 1500, pct: 100 });
  assert.equal(marginValid({ mode: "nominal", pct: 100, nominal: 1500 }), true);
  assert.equal(marginValid({ mode: "pct", pct: 100, nominal: 0 }), false);
  assert.throws(() => priceFromMargin({ landed: 10000, finance: 0, margin: { mode: "pct", pct: 100, nominal: 0 } }), /menor a 100%/);
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

test("la migración 0017 solo agrega columnas nulas: el relleno es cosa de la 0018", () => {
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

// ---------------------------------------------------------------------------
// A6 — los márgenes que ya existían se copian marcados, y muere el 12%.
// ---------------------------------------------------------------------------
test("la migración 0018 copia el margen viejo a las dos columnas y lo marca 'migracion'", () => {
  const mig = src("migrations/0018_margen_migrado.sql");
  assert.ok(mig.includes("margin_cash_source") && mig.includes("margin_credit_source"), "columna de origen en las dos");
  assert.ok(/update customer_request_lines\s+set margin_cash_mode = coalesce\(margin_mode, 'pct'\)/.test(mig), "copia a contado");
  assert.ok(/update customer_request_lines\s+set margin_credit_mode = coalesce\(margin_mode, 'pct'\)/.test(mig), "copia a crédito");
  assert.equal((mig.match(/margin_cash_source = 'migracion'/g) ?? []).length, 2, "lo copiado queda marcado (solicitud y cotización)");
  assert.ok(mig.includes("where margin_cash_mode is null"), "no pisa un margen ya capturado");
  // En cotizaciones la columna vieja es `default 0`: copiar ese 0 sería afirmar
  // "sin utilidad", que no es lo mismo que "no sabemos". Solo se copia si > 0.
  assert.ok(mig.includes("where margin_cash_mode is null and coalesce(margin_pct, 0) > 0"), "en quote_lines solo se copia un margen real");
});

test("muere el 12%: ni en la base, ni en las consultas, ni en el código", () => {
  const mig = src("migrations/0018_margen_migrado.sql");
  assert.ok(mig.includes("alter column margin_pct drop default"), "la columna vieja pierde el default 12");
  assert.ok(mig.includes("alter column margin_pct drop not null"), "y puede quedar nula = sin margen");
  const req = src("src/lib/erp/requests.ts");
  assert.ok(!req.includes("default 12"), "ensure() ya no crea la columna con 12");
  assert.ok(!req.includes("coalesce(l.margin_pct,12)") && !req.includes("coalesce(margin_pct,12)"), "las consultas ya no rellenan 12");
  assert.ok(!src("src/lib/erp/margins.ts").includes("? 12 :"), "marginOf ya no inventa 12%");
  for (const f of ["src/lib/erp/margins.ts", "src/lib/erp/requests.ts", "src/lib/erp/ops.ts", "src/lib/erp/orders.ts"]) {
    assert.ok(!/margin[^\n]*\b12\b/.test(src(f).replace(/^.*(numeric|12,4|8,4).*$/gm, "")), `${f}: sin 12 pegado al margen`);
  }
});

test("sin margen la pantalla lo dice y no deja cotizar; nunca propone un número", () => {
  const ui = src("src/routes/solicitudes.$solicitudId.tsx");
  assert.ok(ui.includes('export const SIN_MARGEN') === false, "el texto vive en margins.ts, no duplicado");
  assert.ok(src("src/lib/erp/margins.ts").includes('export const SIN_MARGEN = "Sin margen";'), "un solo texto para 'sin margen'");
  assert.ok(ui.includes("placeholder={SIN_MARGEN}"), "el campo vacío lo dice");
  assert.ok(ui.includes("Falta capturar el margen de"), "aviso antes de cotizar");
  assert.ok(ui.includes("!marginOf(l, \"cash\") || (days > 0 && !marginOf(l, \"credit\"))"), "el botón de cotizar se apaga sin margen");
  assert.ok(ui.includes('{!m ? <span className="text-warn">{SIN_MARGEN}</span>'), "en modo lectura también");
  const ped = src("src/routes/sales.$orderId.tsx");
  assert.ok(ped.includes('<span className="text-warn">{SIN_MARGEN}</span>'), "el pedido heredado también lo dice");
});

test("quoteFromRequest arma los dos precios: contado sin financiamiento, crédito con financiamiento, y guarda márgenes + finance_unit", () => {
  const req = src("src/lib/erp/requests.ts");
  const body = fnBody(req, "quoteFromRequest");
  assert.ok(body.includes("commissionRate: pol.asrCommission"), "comisión de Ajustes (fórmula intacta)");
  assert.ok(body.includes("days: 0,"), "contado con 0 días");
  assert.ok(body.includes("normalizeMargin({ mode: mCash.mode, pct: mCash.pct, nominal: mCash.nominal }, landed, 0)"), "el margen contado se sincroniza sin financiamiento");
  assert.ok(body.includes("landed, creditCalc.financeUnit)"), "y el de crédito con el financiamiento de su columna (el % es del precio)");
  assert.ok(body.includes("Corrige el margen antes de cotizar."), "un margen ≥ 100% se detiene con mensaje");
  assert.ok(body.includes("margin_cash_mode, margin_cash_pct, margin_cash_nominal, margin_cash_source,"), "inserta el margen de contado con su origen");
  assert.ok(body.includes("margin_credit_mode, margin_credit_pct, margin_credit_nominal, margin_credit_source, finance_unit)"), "y el de crédito con el financiamiento por unidad");
  assert.ok(body.includes("throw new Error(`Captura el margen antes de cotizar:"), "sin margen no se cotiza: se dice qué falta");
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
  assert.ok(body.includes("priceFromMargin({ landed, finance: fin, margin: mCredit })"), "precio = (costo + financiamiento) ÷ (1 − margen crédito): la columna de la escalera del plazo nuevo");
  assert.ok(body.includes('cambios.push(`${l.code} ${landed > 0.0001 ? "sin margen" : "sin costo"}: precio sin recalcular`)'), "sin margen no se inventa uno para recalcular");
  assert.ok(body.includes("price = Number(l.cash_price);"), "a 0 días vuelve al precio de contado");
  assert.ok(body.includes("Math.min(pol.invoiceDays, days)"), "días factura de Ajustes sin pasar del plazo (sin respaldo: Ajustes es obligatorio)");
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
  assert.ok(q.includes("onChange={(m) => (m < 100 ? onPrice(round4((landed + fin) / (1 - m / 100))) : undefined)}"), "margen % → precio = (costo + fin) ÷ (1 − m); 100% no da precio");
  assert.ok(q.includes("const pct = hasCost && price > 0 ? (util / price) * 100 : 0;"), "el % que se muestra es sobre el precio");
  assert.ok(q.includes(`<OfferCells price={rp.cash} landed={landed} fin={0}`), "contado sin financiamiento");
  assert.ok(q.includes(`<OfferCells price={rp.credit} landed={landed} fin={fin}`), "crédito con financiamiento");
  const panel = q.slice(q.indexOf("Documento al cliente"));
  assert.ok(panel.includes("{ ...(prev[l.product_id] ?? rp), [which]: p }"), "en lo ya cotizado cada columna se mueve sola: no se deriva el crédito del contado");
  // Única excepción: la partida que se está agregando todavía no tiene costo ni
  // margen guardados, así que su precio a crédito se arma con la base que
  // manda el servidor (igual que el alta manual). Nunca con el costo en pantalla.
  assert.equal((panel.match(/creditFromCash\(\{/g) ?? []).length, 1, "solo la partida nueva deriva el crédito");
  assert.ok(panel.includes("creditFromCash({ cash: p, fin: prod.fin ?? SIN_FIN, days: qrow.credit_days })"), "y con la base del servidor (sin TIIE en la tabla la base es 0 y el servidor no deja cotizar a crédito)");
  assert.ok(panel.includes("creditDays: agreedDays,"), "la revisión manda el plazo acordado en edición");
  assert.ok(q.includes("validateSearch"), "?ver= abre el folio desde la solicitud/pedido");
  assert.ok(q.includes("El cliente aceptó el precio de {OFFER_LABEL[qrow.accepted_offer]}"), "muestra cuál precio aceptó");
});

// ---------------------------------------------------------------------------
// C3 — agregar partida: tres comportamientos según de dónde venga el pedido.
// ---------------------------------------------------------------------------
test("pedido que vino de cotización: la partida se agrega en la cotización, no en el pedido", () => {
  const form = src("src/components/order-form.tsx");
  assert.ok(form.includes("Agregar partida en {inherited.quoteName}"), "el botón manda a la cotización");
  assert.ok(form.includes("onClick={inherited.onAddLine}"), "y no agrega la línea aquí");
  assert.ok(form.includes("la partida se agrega ahí, donde pasa por costo, margen y"), "dice por qué");
  const ped = src("src/routes/sales.$orderId.tsx");
  assert.ok(ped.includes('onAddLine: editable ? () => void navigate({ to: "/quotes", search: { ver: origin.quote_id } }) : undefined'), "abre la cotización de origen");
});

test("pedido confirmado: no se agregan partidas, se levanta uno nuevo", () => {
  const form = src("src/components/order-form.tsx");
  assert.ok(form.includes("Pedido confirmado: ya no se agregan partidas. Si falta algo, levanta un pedido nuevo."), "mensaje claro");
  // El mensaje sustituye al botón: el único que agrega una partida local es el
  // del pedido directo, y va al final de la cadena (confirmado → cotizado → directo).
  assert.equal((form.match(/onClick=\{addLine\}/g) ?? []).length, 1, "un solo botón que agrega partida local");
  assert.ok(
    form.indexOf("Pedido confirmado: ya no se agregan partidas") < form.indexOf("Agregar partida en {inherited.quoteName}") &&
      form.indexOf("Agregar partida en {inherited.quoteName}") < form.indexOf("onClick={addLine}"),
    "primero se descarta el confirmado, luego el que vino de cotización, y hasta el final el directo",
  );
  const ops = src("src/lib/erp/ops.ts");
  assert.ok(fnBody(ops, "reviseQuote").includes("ya está confirmado: la cotización ya no se revisa"), "el servidor tampoco deja");
});

test("pedido capturado directo (sin cotización): agregar partida sigue igual", () => {
  const form = src("src/components/order-form.tsx");
  assert.ok(form.includes("onClick={addLine}"), "el botón de siempre para el pedido directo");
  assert.ok(form.includes("3. Capturado directo (sin cotización) → como siempre."), "y está documentado en el código");
});

test("la revisión acepta partidas nuevas, les resuelve costo y actualiza el pedido en borrador", () => {
  const ops = src("src/lib/erp/ops.ts");
  const body = fnBody(ops, "reviseQuote");
  assert.ok(body.includes("const nuevasIds = data.lines.filter((l) => !oldLines.some((o) => o.product_id === l.productId))"), "detecta las partidas nuevas");
  assert.ok(body.includes("resolveCost({ avgCost: p?.cost, refCost: p?.ref_cost }).cost"), "costo por el orden único (kardex → referencia)");
  assert.ok(body.includes("insert into quote_lines (quote_id, product_id, qty, unit_price, uom, cost, freight, cash_price, credit_price)"), "entra a la cotización");
  assert.ok(body.includes("partida nueva ×"), "queda en la bitácora de la revisión");
  assert.ok(body.includes("await assertCostForCredit(sql, cid, data.lines.map((l) => l.productId), plazoRev)"), "a crédito sigue exigiendo costo");
  // Sincronía con el pedido en borrador.
  assert.ok(body.includes("const borradores = ordenes.filter((o) => o.state === \"draft\")"), "solo pedidos en borrador");
  assert.ok(body.includes("insert into sales_lines (so_id, product_id, qty, unit_price, uom)"), "la partida nueva baja al pedido");
  assert.ok(body.includes(`action: "actualizar-pedido-por-revision"`), "y queda en bitácora del pedido");
  assert.ok(body.includes("update sales_orders set total = ${totalSo}"), "el total del pedido se rehace");
  assert.ok(body.includes("// parcial) se queda fuera: el cliente no la pidió."), "una aceptación parcial no se revive");
});

test("el panel de la cotización deja agregar partida mientras el pedido siga en borrador", () => {
  const q = src("src/routes/quotes.tsx");
  assert.ok(q.includes('const borrador = Boolean(qrow.order_id) && qrow.order_state === "draft";'), "sabe si el pedido es borrador");
  assert.ok(q.includes("const revisable = qrow.state !== \"rejected\" && (!closed || borrador);"), "revisable = abierta, o aceptada con pedido en borrador");
  assert.ok(q.includes("setAddLines((ls) => [...ls, { productId: data.products[0]?.id ?? 0, qty: 1 }])"), "botón de agregar partida");
  assert.ok(q.includes("Entra al guardar la revisión: ahí pasa por costo, margen y financiamiento"), "explica cuándo entra");
  const ops = src("src/lib/erp/ops.ts");
  assert.ok(fnBody(ops, "listQuotes").includes("as order_state"), "la lista trae el estado del pedido");
});

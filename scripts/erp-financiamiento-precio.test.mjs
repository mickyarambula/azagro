import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

/**
 * Financiamiento DENTRO del precio de venta:
 *
 *   financiamiento por unidad = costo × comisión ASR (1%, una sola vez)
 *                             + costo × 1.01 × (TIIE al cotizar + spread ASR 4%) × días / 360
 *
 * El × 1.01 sale del Excel operativo, hoja DIF_TC_SL_AGRICOLA, columna AN
 * (AN = AL × (1 + 0.01) × W / 360 × 150): la línea adelanta costo + comisión,
 * así que la comisión se cobra una vez Y ADEMÁS genera interés. La utilidad
 * (columna AO) resta la comisión aparte. NO quitar el 1.01.
 *
 * De contado (0 días) todo es $0, comisión incluida. Nada de esto toca el
 * 3.04% (comisión 1% + FEGA 2.04%) del estado de cuenta ni el 9% de mora.
 *
 * Copias de financeCost (credit.ts) y priceSale / financeUnit / financeBase /
 * financeFor / creditFromCash (pricing.ts).
 */
const YEAR_DAYS = 360;
const round2 = (n) => Math.round(n * 100) / 100;

function financeCost(input) {
  const cost = Math.max(0, input.supplierCost);
  const rate = input.tiieAtIssue + input.costSpread;
  const commission = round2(cost * Math.max(0, input.commissionRate));
  const layer1 = round2((cost * (1 + Math.max(0, input.commissionRate)) * rate * Math.max(0, input.financialDays)) / YEAR_DAYS);
  const layer2 = round2((Math.max(0, input.saleCapital) * rate * Math.max(0, input.daysExceeded)) / YEAR_DAYS);
  return { rate, commission, layer1, layer2, total: round2(commission + layer1 + layer2) };
}
function financeUnit(i) {
  if (i.days <= 0) return 0;
  const fin = financeCost({
    supplierCost: Math.max(0, i.cost),
    saleCapital: 0,
    commissionRate: Math.max(0, i.commissionRate),
    costSpread: Math.max(0, i.costSpread),
    tiieAtIssue: Math.max(0, i.tiie),
    financialDays: i.days,
    daysExceeded: 0,
  });
  return fin.commission + fin.layer1;
}
function priceSale(i) {
  const landedUnit = Math.max(0, i.cost) + Math.max(0, i.freight) + Math.max(0, i.other);
  const marginUnit = i.marginMode === "nominal" ? Math.max(0, i.marginNominal) : landedUnit * (Math.max(0, i.marginPct) / 100);
  const fin =
    i.days > 0
      ? financeCost({
          supplierCost: landedUnit,
          saleCapital: 0,
          commissionRate: Math.max(0, i.commissionRate),
          costSpread: Math.max(0, i.costSpread),
          tiieAtIssue: Math.max(0, i.tiie),
          financialDays: i.days,
          daysExceeded: 0,
        })
      : { commission: 0, layer1: 0, total: 0 };
  const financeUnit = fin.commission + fin.layer1;
  return { landedUnit, marginUnit, commissionUnit: fin.commission, layer1Unit: fin.layer1, financeUnit, priceUnit: landedUnit + marginUnit + financeUnit };
}
function financeBase(i) {
  const cost = Math.max(0, i.cost);
  const commissionRate = Math.max(0, i.commissionRate);
  const rate = Math.max(0, i.tiie) + Math.max(0, i.costSpread);
  return { commission: round2(cost * commissionRate), interestYear: cost * (1 + commissionRate) * rate };
}
function financeFor(base, days) {
  if (days <= 0) return 0;
  return base.commission + round2((base.interestYear * days) / YEAR_DAYS);
}
function creditFromCash(i) {
  const cash = Math.max(0, i.cash);
  if (i.days <= 0) return cash;
  return Math.round((cash + financeFor(i.fin, i.days)) * 10000) / 10000;
}

// Los cuatro casos del dueño: costo $10,000, TIIE 6.9%, spread ASR 4%, comisión 1%.
const CASO = { cost: 10000, freight: 0, other: 0, tiie: 0.069, costSpread: 0.04, commissionRate: 0.01, marginMode: "nominal", marginNominal: 0, marginPct: 0, qty: 1 };

test("contado (0 días) → financiamiento $0.00, comisión incluida", () => {
  const p = priceSale({ ...CASO, days: 0 });
  assert.equal(p.commissionUnit, 0);
  assert.equal(p.layer1Unit, 0);
  assert.equal(p.financeUnit, 0);
  assert.equal(p.priceUnit, 10000); // costo + margen 0, nada más
  assert.equal(financeUnit({ ...CASO, days: 0 }), 0);
});

test("60 días → $283.48 (100 de comisión + 10,100 × 10.9% × 60/360 = 183.48)", () => {
  const p = priceSale({ ...CASO, days: 60 });
  assert.equal(p.commissionUnit, 100);
  assert.equal(p.layer1Unit, 183.48);
  assert.equal(round2(p.financeUnit), 283.48);
});

test("90 días → $375.23 (100 + 275.23)", () => {
  const p = priceSale({ ...CASO, days: 90 });
  assert.equal(p.commissionUnit, 100);
  assert.equal(p.layer1Unit, 275.23);
  assert.equal(round2(p.financeUnit), 375.23);
});

test("150 días → $558.71 (100 + 458.71), la fórmula AN del Excel", () => {
  const p = priceSale({ ...CASO, days: 150 });
  assert.equal(p.commissionUnit, 100);
  assert.equal(p.layer1Unit, 458.71);
  assert.equal(round2(p.financeUnit), 558.71);
  // Excel: AN = AL × 1.01 × W / 360 × 150.
  assert.equal(p.layer1Unit, round2(10000 * 1.01 * 0.109 / 360 * 150));
  // Sin el 1.01 daría 554.17: es lo que se quitó por error y se regresó.
  assert.equal(round2(100 + round2(10000 * 0.109 * 150 / 360)), 554.17);
  assert.notEqual(round2(p.financeUnit), 554.17);
});

test("la comisión es una sola vez: cambia con el costo, no con los días", () => {
  for (const days of [1, 30, 60, 90, 150, 365]) {
    assert.equal(priceSale({ ...CASO, days }).commissionUnit, 100, `a ${days} días sigue siendo $100`);
  }
  assert.equal(priceSale({ ...CASO, cost: 20000, days: 150 }).commissionUnit, 200);
});

test("el financiamiento va sobre el costo puesto (costo + flete), y el margen no genera financiamiento", () => {
  // Con flete $500: base 10,500. Margen 12% no cambia el financiero.
  const sinMargen = priceSale({ ...CASO, freight: 500, days: 150 });
  const conMargen = priceSale({ ...CASO, freight: 500, days: 150, marginMode: "pct", marginPct: 12 });
  assert.equal(sinMargen.commissionUnit, 105);
  assert.equal(sinMargen.layer1Unit, round2(10500 * 1.01 * 0.109 * 150 / 360)); // 481.64
  assert.equal(conMargen.financeUnit, sinMargen.financeUnit);
  assert.equal(conMargen.priceUnit, round2(10500 + 1260 + sinMargen.financeUnit));
});

test("la base que manda el servidor da el mismo peso que la fórmula completa", () => {
  const base = financeBase({ cost: 10000, tiie: 0.069, costSpread: 0.04, commissionRate: 0.01 });
  for (const days of [0, 1, 7, 30, 45, 60, 90, 120, 150, 180, 270, 365, 500]) {
    assert.equal(financeFor(base, days), financeUnit({ ...CASO, days }), `a ${days} días`);
  }
  // Y con costos rotos: mismos centavos que el motor, sin excepciones.
  for (const cost of [0, 0.01, 137.77, 4999.99, 128345.61]) {
    const b = financeBase({ cost, tiie: 0.0706, costSpread: 0.04, commissionRate: 0.01 });
    for (const days of [17, 90, 150]) {
      assert.equal(financeFor(b, days), financeUnit({ cost, days, tiie: 0.0706, costSpread: 0.04, commissionRate: 0.01 }), `costo ${cost} a ${days} días`);
    }
  }
});

// ---------------------------------------------------------------------------
// El precio NO puede depender de quién cotiza.
// ---------------------------------------------------------------------------
/** Copia de lo que hace listQuotes: la base se calcula con el costo real y
 *  DESPUÉS se esconde el costo a quien no puede verlo. */
function payloadListQuotes(role, products, pol) {
  const canSeeCosts = role === "admin" || role === "gerencia" || role === "compras";
  const priced = products.map((p) => ({
    ...p,
    fin: financeBase({ cost: Number(p.cost) || 0, tiie: pol.defaultTiie, costSpread: pol.asrSpread, commissionRate: pol.asrCommission }),
  }));
  return canSeeCosts ? priced : priced.map((p) => ({ ...p, cost: "0" }));
}

test("mismo producto y mismo plazo → mismo precio para admin y para ventas", () => {
  const pol = { defaultTiie: 0.069, asrSpread: 0.04, asrCommission: 0.01 };
  const products = [{ id: 1, code: "P-1", list_price: "12000", uom: "TM", cost: "10000" }];
  const admin = payloadListQuotes("admin", products, pol)[0];
  const ventas = payloadListQuotes("ventas", products, pol)[0];

  // Al de ventas no le llega el costo…
  assert.equal(admin.cost, "10000");
  assert.equal(ventas.cost, "0");
  // …pero el precio a crédito es idéntico, peso por peso, en cualquier plazo.
  for (const days of [0, 30, 60, 90, 150]) {
    const pAdmin = creditFromCash({ cash: 12000, fin: admin.fin, days });
    const pVentas = creditFromCash({ cash: 12000, fin: ventas.fin, days });
    assert.equal(pVentas, pAdmin, `a ${days} días el precio no puede cambiar con el rol`);
  }
  assert.equal(creditFromCash({ cash: 12000, fin: ventas.fin, days: 150 }), 12558.71);
  assert.equal(creditFromCash({ cash: 12000, fin: ventas.fin, days: 0 }), 12000);
  // El error que se corrigió: financiar sobre el precio de contado cuando no
  // se veía el costo daba $12,670.45 al de ventas por lo mismo.
  assert.equal(round2(12000 + financeUnit({ cost: 12000, days: 150, tiie: 0.069, costSpread: 0.04, commissionRate: 0.01 })), 12670.45);
});

test("producto sin costo capturado: no se inventa financiamiento (crédito = contado)", () => {
  // Hueco de datos, no de fórmula: queda documentado hasta que el dueño decida.
  const pol = { defaultTiie: 0.069, asrSpread: 0.04, asrCommission: 0.01 };
  const sinCosto = payloadListQuotes("admin", [{ id: 2, code: "P-2", list_price: "12000", uom: "TM", cost: "0" }], pol)[0];
  assert.equal(sinCosto.fin.commission, 0);
  assert.equal(sinCosto.fin.interestYear, 0);
  assert.equal(creditFromCash({ cash: 12000, fin: sinCosto.fin, days: 150 }), 12000);
});

// ---------------------------------------------------------------------------
// Cableado: la fórmula de verdad es la del código, no la de esta copia.
// ---------------------------------------------------------------------------
test("cableado: financeCost capitaliza la comisión en la Capa 1 (columna AN)", () => {
  const credit = src("src/lib/erp/credit.ts");
  const fn = credit.slice(credit.indexOf("export function financeCost"), credit.indexOf("export type ClockStatus"));
  assert.ok(
    fn.includes("const layer1 = round2((cost * (1 + Math.max(0, input.commissionRate)) * rate * Math.max(0, input.financialDays)) / YEAR_DAYS);"),
    "Capa 1 = costo × (1 + comisión) × tasa × días / 360",
  );
  assert.ok(fn.includes("const commission = round2(cost * Math.max(0, input.commissionRate));"), "comisión = costo × tasa de comisión, sin días");
  // El comentario que explica de dónde sale el 1.01 no se borra.
  const doc = credit.slice(credit.indexOf("Costo financiero PROPIO"), credit.indexOf("export function financeCost"));
  assert.ok(doc.includes("DIF_TC_SL_AGRICOLA"), "queda escrito de qué hoja sale");
  assert.ok(doc.includes("AN = AL * (1 + 0.01) * W / 360 * 150"), "y la fórmula tal cual");
});

test("cableado: priceSale cobra $0 al contado, comisión incluida, y el cotizador usa comisión + spread ASR", () => {
  const pricing = src("src/lib/erp/pricing.ts");
  assert.ok(pricing.includes("i.days > 0\n      ? financeCost({"), "solo hay financiamiento si hay días");
  assert.ok(pricing.includes("commission: 0, layer1: 0, layer2: 0, total: 0"), "al contado la comisión también es 0");
  assert.ok(pricing.includes("export function financeUnit("), "helper único para el financiero por unidad");
  assert.ok(!pricing.includes("financeSpread"), "el spread del precio es el ASR, no el de línea");

  const ui = src("src/routes/solicitudes.$solicitudId.tsx");
  assert.ok(ui.includes("setSpreadPct(Number((s.asrSpread * 100).toFixed(2)))"), "Financiero /u parte del spread ASR de Ajustes");
  assert.ok(ui.includes("setCommissionPct(Number((s.asrCommission * 100).toFixed(2)))"), "y de la comisión ASR de Ajustes");
  assert.ok(ui.includes("costSpread: spreadPct / 100,") && ui.includes("commissionRate: commissionPct / 100,"), "y los pasa a priceSale");
  assert.ok(ui.includes("Financiero /u"), "la columna sigue existiendo");

  const req = src("src/lib/erp/requests.ts");
  assert.ok(req.includes("commissionRate: pol.asrCommission"), "la cotización guardada usa la comisión ASR");
});

test("cableado: el 4.5% (spread de línea) ya no existe en Ajustes, política ni pantallas", () => {
  for (const file of [
    "src/lib/erp/credit.ts",
    "src/lib/erp/pricing.ts",
    "src/lib/erp/ops.ts",
    "src/lib/erp/rules.ts",
    "src/lib/erp/requests.ts",
    "src/lib/erp/reports.ts",
    "src/routes/settings.tsx",
    "src/routes/quotes.tsx",
    "src/routes/solicitudes.$solicitudId.tsx",
  ]) {
    // La única mención permitida es la que tira la columna vieja de la base.
    const body = src(file).replace("alter table company_settings drop column if exists finance_spread", "");
    assert.ok(!body.includes("financeSpread"), `${file}: sin financeSpread`);
    assert.ok(!body.includes("finance_spread"), `${file}: sin finance_spread`);
    assert.ok(!body.includes("0.045"), `${file}: sin el 4.5% quemado`);
    assert.ok(!body.includes("4.5%"), `${file}: sin el texto 4.5%`);
  }
  assert.ok(src("src/lib/erp/ops.ts").includes("drop column if exists finance_spread"), "la columna vieja se tira de la base");
  const settings = src("src/routes/settings.tsx");
  assert.ok(!settings.includes("Spread de línea"), "el campo se quitó");
  assert.ok(!settings.includes("Costo de línea en cotización"), "el texto de ayuda viejo se quitó");
  assert.ok(settings.includes("Financiamiento dentro del precio de venta (por unidad) = costo ×"), "el texto de ayuda describe la fórmula real");
  assert.ok(settings.includes("De contado (0 días) el financiamiento es $0, comisión incluida."), "y aclara el contado");
  // El 3.04% del estado de cuenta sigue intacto y separado del precio.
  assert.ok(settings.includes("Comisión 1% + FEGA 2.04% = 3.04% sobre el cargo"), "FEGA + comisión del estado de cuenta no se tocó");
  const rules = src("src/lib/erp/rules.ts");
  assert.ok(rules.includes("Comisión 1% + FEGA 2.04% = 3.04% una sola vez sobre el cargo"), "regla de mora intacta");
});

test("cableado: el servidor calcula el financiamiento con el costo real ANTES de escondérselo a ventas", () => {
  const ops = src("src/lib/erp/ops.ts");
  const fn = ops.slice(ops.indexOf("export const listQuotes"), ops.indexOf("export const createQuote"));
  assert.ok(fn.includes("financeBase({ cost, tiie: pol.defaultTiie, costSpread: pol.asrSpread, commissionRate: pol.asrCommission })"), "la base sale del costo resuelto y de Ajustes");
  assert.ok(fn.includes("resolveCost({ avgCost: row.cost, refCost: row.ref_cost })"), "y el costo sale del orden único (kardex → referencia)");
  assert.ok(fn.indexOf("const pricedProducts") < fn.indexOf("if (!canSeeCosts(me.role))"), "primero se calcula, después se esconde el costo");
  assert.ok(fn.includes("pricedLines.map((l) => ({ ...l, cost: \"0\", ref_cost: \"0\", freight: \"0\" }))"), "a ventas se le esconde costo y flete, no el precio");
  assert.ok(fn.includes("pricedProducts.map((p) => ({ ...p, cost: \"0\", ref_cost: \"0\" }))"), "lo mismo en el catálogo de productos");

  const q = src("src/routes/quotes.tsx");
  assert.ok(!q.includes("num(p.cost)") && !q.includes("num(prod?.cost)"), "la pantalla ya no calcula con el costo");
  assert.ok(!q.includes("cost: num(l.cost), days"), "ni en la revisión");
  assert.ok(q.includes("creditFromCash({ cash: l.cashPrice, fin: l.fin, days })"), "el crédito sale de la base que mandó el servidor");
  assert.ok((q.match(/creditFromCash\(\{/g) ?? []).length >= 6, "todas las llamadas usan la firma nueva (con fin)");
  const pricing = src("src/lib/erp/pricing.ts");
  assert.ok(pricing.includes("export function financeBase("), "la base vive en pricing.ts");
  assert.ok(!pricing.includes("const base = i.cost > 0 ? i.cost : cash;"), "ya no se financia sobre el precio de contado cuando falta el costo");
});

test("cableado: no se puede guardar una revisión de cotización sin ningún cambio", () => {
  const ops = src("src/lib/erp/ops.ts");
  const fn = ops.slice(ops.indexOf("export const reviseQuote"), ops.indexOf("export const decideQuote"));
  assert.ok(fn.includes('throw new Error("Sin cambios: la revisión no se guardó.'), "el servidor rechaza la revisión vacía");
  assert.ok(!fn.includes("sin cambio de precios"), "ya no puede quedar 'sin cambio de precios' en bitácora");
  // El rechazo va ANTES de tocar la base: nada de subir revisión y luego avisar.
  assert.ok(fn.indexOf("if (!cambios.length)") < fn.indexOf("update quotes"), "se valida antes del update");
  assert.ok(fn.includes("Math.abs(Number(prev.cash_price) - line.cashPrice) > 0.009"), "misma tolerancia de centavos que la pantalla");
  assert.ok(fn.includes("cambios.push(`plazo ${q[0].credit_days} → ${data.creditDays} d`)"), "cambiar el plazo sí cuenta como revisión");
});

test("cableado: en un RFQ el ganador se elige por renglón y puede ser distinto en cada uno", () => {
  const rfq = src("src/lib/erp/rfq.ts");
  assert.ok(
    rfq.includes("winners: z.array(z.object({ productId: z.number(), unitPrice: z.number(), partnerId: z.number() }))"),
    "el servidor recibe proveedor por producto",
  );
  assert.ok(rfq.includes("const bySup = new Map<number, Array<{ productId: number; unitPrice: number }>>();"), "y agrupa por proveedor: una OC por ganador");
  const ui = src("src/routes/rfq.$rfqId.tsx");
  assert.ok(ui.includes("value={pick[line.product_id] ?? \"\"}"), "un selector de ganador por renglón");
  assert.ok(ui.includes("if (chosen && bids.some((b) => b.partner_id === chosen)) next[line.product_id] = chosen;"), "la elección manual no se pierde al recargar precios");
  const req = src("src/lib/erp/requests.ts");
  assert.ok(req.includes("z.object({ requestId: z.number(), productId: z.number(), supplierId: z.number(), unitPrice: z.number() })"), "pickVendor es por producto");
  const sol = src("src/routes/solicitudes.$solicitudId.tsx");
  assert.ok(sol.includes("const win = l.supplier_id === s.id;"), "en la comparativa el ganador se marca por renglón");
});

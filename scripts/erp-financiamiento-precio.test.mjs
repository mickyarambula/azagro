import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

/**
 * Financiamiento DENTRO del precio de venta (regla del dueño, 2026-09-01):
 *
 *   financiamiento por unidad = costo × comisión ASR (1%, una sola vez)
 *                             + costo × (TIIE vigente al cotizar + spread ASR 4%) × días / 360
 *
 * - La comisión no depende de los días.
 * - La Capa 1 va sobre el costo SOLO. No se capitaliza la comisión (nada de
 *   costo × 1.01, que era la hoja DIF_TC del Excel del circuito con la hermana).
 * - De contado (0 días) todo es $0, comisión incluida.
 * - Nada de esto toca el 3.04% (comisión 1% + FEGA 2.04%) del estado de
 *   cuenta ni el 9% de mora: esos van aparte.
 *
 * Copias de financeCost (credit.ts), priceSale / financeUnit / creditFromCash
 * (pricing.ts). Si cambia el motor, actualiza aquí y piensa por qué.
 */
const YEAR_DAYS = 360;
const round2 = (n) => Math.round(n * 100) / 100;

function financeCost(input) {
  const cost = Math.max(0, input.supplierCost);
  const rate = input.tiieAtIssue + input.costSpread;
  const commission = round2(cost * Math.max(0, input.commissionRate));
  const layer1 = round2((cost * rate * Math.max(0, input.financialDays)) / YEAR_DAYS);
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
function creditFromCash(i) {
  const cash = Math.max(0, i.cash);
  if (i.days <= 0) return cash;
  const base = i.cost > 0 ? i.cost : cash;
  return Math.round((cash + financeUnit({ ...i, cost: base })) * 10000) / 10000;
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

test("60 días → $281.67 (100 de comisión + 10,000 × 10.9% × 60/360 = 181.67)", () => {
  const p = priceSale({ ...CASO, days: 60 });
  assert.equal(p.commissionUnit, 100);
  assert.equal(p.layer1Unit, 181.67);
  assert.equal(round2(p.financeUnit), 281.67);
});

test("90 días → $372.50 (100 + 272.50)", () => {
  const p = priceSale({ ...CASO, days: 90 });
  assert.equal(p.commissionUnit, 100);
  assert.equal(p.layer1Unit, 272.5);
  assert.equal(round2(p.financeUnit), 372.5);
});

test("150 días → $554.17 (100 + 454.17), NO $558.71 (costo × 1.01) ni $475.00 (TIIE + 4.5% sin comisión)", () => {
  const p = priceSale({ ...CASO, days: 150 });
  assert.equal(p.commissionUnit, 100);
  assert.equal(p.layer1Unit, 454.17);
  assert.equal(round2(p.financeUnit), 554.17);
  // Lo que daba antes (Capa 1 sobre costo × 1.01):
  assert.equal(round2(100 + round2(10100 * 0.109 * 150 / 360)), 558.71);
  // Lo que decía el texto de ayuda viejo (una capa, TIIE + 4.5%, sin comisión):
  assert.equal(round2(10000 * (0.069 + 0.045) * 150 / 360), 475);
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
  assert.equal(sinMargen.layer1Unit, round2(10500 * 0.109 * 150 / 360)); // 476.88
  assert.equal(conMargen.financeUnit, sinMargen.financeUnit);
  assert.equal(conMargen.priceUnit, round2(10500 + 1260 + sinMargen.financeUnit));
});

test("cotización directa: crédito = contado + financiamiento sobre el COSTO (no sobre el precio)", () => {
  // Contado $12,000 con costo $10,000 a 150 días: 12,000 + 554.17.
  assert.equal(creditFromCash({ cash: 12000, cost: 10000, days: 150, tiie: 0.069, costSpread: 0.04, commissionRate: 0.01 }), 12554.17);
  // Contado: crédito = contado.
  assert.equal(creditFromCash({ cash: 12000, cost: 10000, days: 0, tiie: 0.069, costSpread: 0.04, commissionRate: 0.01 }), 12000);
  // Sin costo conocido: se usa el contado como base (conservador, nunca cobra de menos).
  const sinCosto = creditFromCash({ cash: 12000, cost: 0, days: 150, tiie: 0.069, costSpread: 0.04, commissionRate: 0.01 });
  assert.equal(sinCosto, round2(12000 + 120 + round2(12000 * 0.109 * 150 / 360)));
  assert.ok(sinCosto > 12554.17);
});

// ---------------------------------------------------------------------------
// Cableado: la fórmula de verdad es la del código, no la de esta copia.
// ---------------------------------------------------------------------------
test("cableado: financeCost ya no capitaliza la comisión en la Capa 1", () => {
  const credit = src("src/lib/erp/credit.ts");
  const fn = credit.slice(credit.indexOf("export function financeCost"), credit.indexOf("export type ClockStatus"));
  assert.ok(fn.includes("const layer1 = round2((cost * rate * Math.max(0, input.financialDays)) / YEAR_DAYS);"), "Capa 1 = costo × tasa × días / 360");
  assert.ok(!fn.includes("(1 + Math.max(0, input.commissionRate))"), "nada de costo × 1.01");
  assert.ok(fn.includes("const commission = round2(cost * Math.max(0, input.commissionRate));"), "comisión = costo × tasa de comisión, sin días");
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

test("cableado: la cotización directa financia sobre el costo promedio del producto con comisión + spread ASR", () => {
  const q = src("src/routes/quotes.tsx");
  assert.ok(q.includes("setSpread(s.asrSpread)") && q.includes("setCommission(s.asrCommission)"), "parámetros de Ajustes");
  assert.ok(!q.includes("annualRate("), "ya no usa la tasa plana del modelo viejo");
  assert.ok((q.match(/creditFromCash\(\{/g) ?? []).length >= 6, "todas las llamadas usan la firma nueva (con costo)");
  const ops = src("src/lib/erp/ops.ts");
  assert.ok(ops.includes("coalesce(cost,0)::text as cost from products"), "listQuotes manda el costo del producto");
  assert.ok(ops.includes('products: products.map((p) => ({ ...p, cost: "0" }))'), "y lo esconde a quien no puede ver costos");
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

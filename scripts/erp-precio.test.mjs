import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

/**
 * Copias de src/lib/erp/credit.ts (financeCost) y src/lib/erp/pricing.ts
 * (priceSale) — si cambia el motor, actualiza aquí y piensa por qué.
 *
 * Regla del dueño: el costo financiero NO lo absorbe Azagro — se cobra al
 * cliente dentro del precio. Orden: costo → margen → financiamiento encima,
 * con los días de crédito de ESE pedido.
 *
 * Financiamiento por unidad = costo × comisión ASR (una vez) + costo ×
 * (TIIE + spread ASR) × días / 360. La Capa 1 va sobre el costo SOLO (no
 * sobre costo × 1.01 como en la hoja DIF_TC del Excel viejo): decisión del
 * dueño 2026-09-01. Los casos con sus números están en
 * erp-financiamiento-precio.test.mjs.
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
  return { landedUnit, marginUnit, financeUnit, priceUnit: landedUnit + marginUnit + financeUnit, commissionUnit: fin.commission, layer1Unit: fin.layer1 };
}

// Ejemplo base: costo $1,000/u, 100 unidades, pedido a 150 días,
// TIIE emisión 10% + spread costo 4% = 14%, comisión 1%, margen elegido 8%.
const EJ = { cost: 1000, freight: 0, other: 0, days: 150, tiie: 0.10, costSpread: 0.04, commissionRate: 0.01, marginMode: "pct", marginPct: 8, marginNominal: 0, qty: 100 };

test("el precio sugerido lleva el financiamiento ADENTRO: costo → margen → comisión + Capa 1 encima", () => {
  const p = priceSale(EJ);
  assert.equal(p.landedUnit, 1000);
  assert.equal(p.marginUnit, 80); // 8% sobre el costo de mercancía
  assert.equal(p.commissionUnit, 10); // comisión 1%
  assert.equal(p.layer1Unit, 58.33); // 1,000 × 14% × 150/360 (días del PEDIDO)
  assert.equal(p.financeUnit, 68.33);
  assert.equal(p.priceUnit, 1148.33); // 1,000 + 80 + 68.33
});

test("al contado no hay circuito: precio = costo + margen, sin financiamiento", () => {
  const p = priceSale({ ...EJ, days: 0 });
  assert.equal(p.financeUnit, 0);
  assert.equal(p.priceUnit, 1080);
});

test("los días son los del pedido, no 150 fijos: a 90 días el financiamiento baja", () => {
  const p = priceSale({ ...EJ, days: 90 });
  assert.equal(p.layer1Unit, 35); // 1,000 × 14% × 90/360
  assert.equal(p.priceUnit, round2(1000 + 80 + 10 + 35));
});

test("la utilidad final queda en el margen elegido: cobrado en precio − pagado al circuito ≈ 0", () => {
  const p = priceSale(EJ);
  const venta = p.priceUnit * 100; // 114,833
  const costo = 100000;
  // Lo que Azagro paga al circuito por la operación completa (mismos 150 días):
  const fin = financeCost({ supplierCost: costo, saleCapital: venta, commissionRate: 0.01, costSpread: 0.04, tiieAtIssue: 0.10, financialDays: 150, daysExceeded: 0 });
  const utilidad = round2(venta - costo - fin.commission - fin.layer1);
  const margenElegido = 8000; // 8% sobre 100,000
  assert.ok(Math.abs(utilidad - margenElegido) < 1, `utilidad ${utilidad} debe quedar en el margen elegido ${margenElegido}`);
  // Con el modelo viejo (precio sin financiamiento, restando capas igual),
  // la misma operación mostraba ~1% en vez de 8%: ese era el agujero.
  const ventaVieja = 1080 * 100;
  const utilidadVieja = round2(ventaVieja - costo - fin.commission - fin.layer1);
  assert.ok(utilidadVieja < 1500, "el modelo viejo aplastaba la utilidad");
  assert.ok(utilidad - utilidadVieja > 6000, "la diferencia son los ~7 puntos que se descontaban dos veces");
});

test("contra el Excel (hoja DIF_TC): misma tasa y días que la fórmula AN, pero sobre el costo solo (sin × 1.01)", () => {
  // Excel: AN = costo × (1 + 1%) × (TIIE emisión + 4%) / 360 × 150 (el circuito
  // con la hermana adelantaba costo + comisión). Con ASR la comisión no se
  // capitaliza: Capa 1 = costo × (TIIE + 4%) × días / 360.
  const excelAN = round2(100000 * 1.01 * 0.14 / 360 * 150); // 5,891.67
  const op = financeCost({ supplierCost: 100000, saleCapital: 0, commissionRate: 0.01, costSpread: 0.04, tiieAtIssue: 0.10, financialDays: 150, daysExceeded: 0 });
  assert.equal(op.layer1, 5833.33); // 100,000 × 14% × 150/360, sobre el costo solo
  assert.equal(round2(excelAN - op.layer1), 58.34, "la diferencia es exactamente el interés sobre la comisión (1,000 × 14% × 150/360)");
  const p = priceSale(EJ);
  assert.equal(p.layer1Unit, 58.33); // por unidad: lo mismo entre 100
  // Margen bruto s/venta ≈ 13% y utilidad ≈ 7% s/venta: el rango del Excel
  // (8-9% con mora e ingresos cambiarios encima), no 5 puntos abajo.
  const venta = p.priceUnit * 100;
  const brutoPct = ((venta - 100000) / venta) * 100;
  const netaPct = (8000 / venta) * 100;
  assert.ok(brutoPct > 12 && brutoPct < 14, `bruto ${brutoPct.toFixed(1)}%`);
  assert.ok(netaPct > 6.5, `neta ${netaPct.toFixed(1)}% no debe quedar aplastada`);
});

test("cableado: el cotizador y el P&L usan el mismo modelo", () => {
  const pricing = src("src/lib/erp/pricing.ts");
  assert.ok(pricing.includes("financeCost({"), "el precio usa comisión + Capa 1 (las fórmulas que ya existen)");
  assert.ok(pricing.includes("landedUnit + marginUnit + financeUnit"), "orden: costo → margen → financiamiento encima");
  assert.ok(pricing.includes("i.days > 0"), "al contado no hay financiamiento");
  assert.ok(!pricing.includes("annualRate: number") || !pricing.includes("landedUnit * Math.max(0, i.annualRate)"), "ya no existe el modelo viejo (financiar y luego marginar)");
  const req = src("src/lib/erp/requests.ts");
  assert.ok(req.includes("commissionRate: pol.asrCommission"), "la comisión del precio sale de Ajustes");
  const az = src("src/lib/azagro.ts");
  assert.ok(az.includes("financialDays: so[0].credit_days ?? 0"), "la FV congela los días de SU pedido, no un fijo");
  const rep = src("src/lib/erp/reports.ts");
  assert.ok(rep.includes("financialDays > 0 || daysExceeded > 0"), "P&L: contado sin circuito, nada que restar");
  const ui = src("src/routes/solicitudes.$solicitudId.tsx");
  assert.ok(ui.includes("Financiero /u"), "el cotizador muestra el financiero por unidad");
  assert.ok(ui.includes("com {money(calc.commissionUnit)} + C1 {money(calc.layer1Unit)}"), "con su desglose comisión + Capa 1");
  assert.ok(ui.includes("costo {money(calc.landedUnit)} + margen {money(calc.marginUnit)}"), "y la composición del precio");
});

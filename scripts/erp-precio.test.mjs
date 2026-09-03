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
 * cliente dentro del precio. Orden (hojas reales de la dirección, 3-sep-2026):
 * costo → financiamiento SUMADO al costo → margen SOBRE EL PRECIO encima:
 *   precio = (costo puesto + financiamiento) ÷ (1 − margen %)
 * con los días de crédito de ESE pedido.
 *
 * Financiamiento por unidad = costo × comisión ASR (una vez) + costo × 1.01 ×
 * (TIIE + spread ASR) × días / 360. El × 1.01 es la columna AN del Excel
 * DIF_TC: la línea adelanta costo + comisión. Los casos con sus números
 * están en erp-financiamiento-precio.test.mjs.
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
function marginUnitOf(m, landed, finance = 0) {
  if (m.mode === "nominal") return m.nominal;
  if (!(m.pct < 100)) throw new Error("margen ≥ 100%");
  return ((landed + Math.max(0, finance)) * m.pct) / (100 - m.pct);
}
function priceSale(i) {
  const landedUnit = Math.max(0, i.cost) + Math.max(0, i.freight) + Math.max(0, i.other);
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
  const marginUnit =
    i.marginMode === "nominal" ? Math.max(0, i.marginNominal) : marginUnitOf({ mode: "pct", pct: Math.max(0, i.marginPct), nominal: 0 }, landedUnit, financeUnit);
  return { landedUnit, marginUnit, financeUnit, priceUnit: landedUnit + financeUnit + marginUnit, commissionUnit: fin.commission, layer1Unit: fin.layer1 };
}

// Ejemplo base: costo $1,000/u, 100 unidades, pedido a 150 días,
// TIIE emisión 10% + spread costo 4% = 14%, comisión 1%, margen elegido 8%.
const EJ = { cost: 1000, freight: 0, other: 0, days: 150, tiie: 0.10, costSpread: 0.04, commissionRate: 0.01, marginMode: "pct", marginPct: 8, marginNominal: 0, qty: 100 };

test("el precio sugerido lleva el financiamiento ADENTRO: costo → comisión + Capa 1 sumadas → margen sobre el precio", () => {
  const p = priceSale(EJ);
  assert.equal(p.landedUnit, 1000);
  assert.equal(p.commissionUnit, 10); // comisión 1%
  assert.equal(p.layer1Unit, 58.92); // 1,000 × 1.01 × 14% × 150/360 (días del PEDIDO)
  assert.equal(p.financeUnit, 68.92);
  // precio = (1,000 + 68.92) ÷ 0.92 = 1,161.87; el 8% es DEL PRECIO.
  assert.equal(round2(p.priceUnit), 1161.87);
  assert.equal(round2(p.marginUnit), 92.95);
  assert.ok(Math.abs(p.marginUnit - p.priceUnit * 0.08) < 0.0001, "la utilidad es exactamente 8% del precio");
  // Con el 8% sobre el costo (fórmula anterior) daría 1,148.92: ya no.
  assert.notEqual(round2(p.priceUnit), 1148.92);
});

test("al contado no hay circuito: precio = costo ÷ (1 − margen), sin financiamiento", () => {
  const p = priceSale({ ...EJ, days: 0 });
  assert.equal(p.financeUnit, 0);
  assert.equal(round2(p.priceUnit), 1086.96); // 1,000 ÷ 0.92
});

test("los días son los del pedido, no 150 fijos: a 90 días el financiamiento baja", () => {
  const p = priceSale({ ...EJ, days: 90 });
  assert.equal(p.layer1Unit, 35.35); // 1,000 × 1.01 × 14% × 90/360
  assert.equal(round2(p.priceUnit), round2((1000 + 10 + 35.35) / 0.92));
});

test("la utilidad final queda en el margen elegido: cobrado en precio − pagado al circuito = 8% de la venta", () => {
  const p = priceSale(EJ);
  const venta = p.priceUnit * 100; // 116,186.96
  const costo = 100000;
  // Lo que Azagro paga al circuito por la operación completa (mismos 150 días):
  const fin = financeCost({ supplierCost: costo, saleCapital: venta, commissionRate: 0.01, costSpread: 0.04, tiieAtIssue: 0.10, financialDays: 150, daysExceeded: 0 });
  const utilidad = round2(venta - costo - fin.commission - fin.layer1);
  const margenElegido = round2(venta * 0.08); // 8% sobre la venta
  assert.ok(Math.abs(utilidad - margenElegido) < 1, `utilidad ${utilidad} debe quedar en el margen elegido ${margenElegido}`);
  // Con el modelo viejo (precio sin financiamiento, restando capas igual),
  // la misma operación mostraba ~1% en vez de 8%: ese era el agujero.
  const ventaVieja = (1000 / 0.92) * 100;
  const utilidadVieja = round2(ventaVieja - costo - fin.commission - fin.layer1);
  assert.ok(utilidadVieja < 2500, "el modelo viejo aplastaba la utilidad");
  assert.ok(utilidad - utilidadVieja > 6000, "la diferencia son los ~7 puntos que se descontaban dos veces");
});

test("contra el Excel (hoja DIF_TC): la Capa 1 da exactamente la fórmula AN", () => {
  // Excel: AN = AL × (1 + 1%) × W / 360 × 150, con W = TIIE emisión + 4%.
  const excelAN = round2(100000 * 1.01 * 0.14 / 360 * 150); // 5,891.67
  const op = financeCost({ supplierCost: 100000, saleCapital: 0, commissionRate: 0.01, costSpread: 0.04, tiieAtIssue: 0.10, financialDays: 150, daysExceeded: 0 });
  assert.equal(op.layer1, excelAN, "el sistema debe dar la misma Capa 1 que el Excel");
  assert.equal(op.layer1, 5891.67);
  const p = priceSale(EJ);
  assert.equal(p.layer1Unit, 58.92); // por unidad: lo mismo entre 100
  // Margen bruto s/venta ≈ 14% y utilidad = 8% s/venta (el margen elegido es
  // del precio): el rango del Excel (8-9% con mora e ingresos cambiarios
  // encima), no 5 puntos abajo.
  const venta = p.priceUnit * 100;
  const brutoPct = ((venta - 100000) / venta) * 100;
  const netaPct = ((p.marginUnit * 100) / venta) * 100;
  assert.ok(brutoPct > 12 && brutoPct < 15, `bruto ${brutoPct.toFixed(1)}%`);
  assert.ok(Math.abs(netaPct - 8) < 0.01, `neta ${netaPct.toFixed(2)}% = el margen elegido`);
});

test("cableado: el cotizador y el P&L usan el mismo modelo", () => {
  const pricing = src("src/lib/erp/pricing.ts");
  assert.ok(pricing.includes("financeCost({"), "el precio usa comisión + Capa 1 (las fórmulas que ya existen)");
  assert.ok(pricing.includes("landedUnit + financeUnit + marginUnit"), "orden: costo → financiamiento sumado → margen encima");
  assert.ok(pricing.includes('marginUnitOf({ mode: "pct", pct: Math.max(0, i.marginPct), nominal: 0 }, landedUnit, financeUnit)'), "el margen % es del precio y lleva el financiamiento en la base (fórmula única de margins.ts)");
  assert.ok(!pricing.includes("landedUnit * (Math.max(0, i.marginPct) / 100)"), "ya no existe el margen como recargo sobre el costo");
  assert.ok(pricing.includes("i.days > 0"), "al contado no hay financiamiento");
  assert.ok(!pricing.includes("annualRate: number") || !pricing.includes("landedUnit * Math.max(0, i.annualRate)"), "ya no existe el modelo viejo (financiar y luego marginar)");
  const req = src("src/lib/erp/requests.ts");
  assert.ok(req.includes("commissionRate: pol.asrCommission"), "la comisión del precio sale de Ajustes");
  const az = src("src/lib/azagro.ts");
  assert.ok(az.includes("const financedDays = so[0].credit_days ?? 0;") && az.includes("financialDays: financedDays,"), "la FV congela los días de SU pedido, no un fijo");
  const rep = src("src/lib/erp/reports.ts");
  assert.ok(rep.includes("financialDays > 0 || daysExceeded > 0"), "P&L: contado sin circuito, nada que restar");
  const ui = src("src/routes/solicitudes.$solicitudId.tsx");
  assert.ok(ui.includes("Financiero /u"), "el cotizador muestra el financiero por unidad");
  assert.ok(ui.includes("com {money(calc.commissionUnit)} + C1 {money(calc.layer1Unit)}"), "con su desglose comisión + Capa 1");
  assert.ok(ui.includes("Precio = (costo puesto + financiamiento) ÷ (1 − margen %)"), "y la fórmula del precio a la vista");
});

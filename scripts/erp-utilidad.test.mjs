import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

/**
 * Copias de src/lib/erp/credit.ts (financeCost, earlyPayBonus) — si cambia el
 * motor, actualiza aquí y piensa por qué. Los casos replican las fórmulas del
 * Excel de utilidad (hoja DIF_TC: comisión, Capa 1 = AN, Capa 2 = AK,
 * descuento = Z) con números inventados. La Capa 1 va sobre costo × 1.01
 * como en la columna AN: la línea adelanta costo + comisión.
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
function daysBetween(from, to) {
  const a = Date.parse(from.slice(0, 10) + "T00:00:00");
  const b = Date.parse(to.slice(0, 10) + "T00:00:00");
  return Math.round((b - a) / 86400000);
}
function earlyPayBonus(input) {
  const lived = daysBetween(input.issueDate, input.payDate);
  const rate = input.tiieAtIssue + input.costSpread;
  if (lived >= input.thresholdDays) return { applies: false, lived, days: 0, rate, bonus: 0 };
  const days = Math.max(0, input.financialDays - lived);
  const bonus = round2((Math.max(0, input.cargo) * rate * days) / YEAR_DAYS);
  return { applies: days > 0, lived, days, rate, bonus };
}

// Parámetros del ejemplo: comisión 1%, TIIE emisión 10%, spread costo 4% → 14%.
const P = { commissionRate: 0.01, costSpread: 0.04, tiieAtIssue: 0.10, financialDays: 150 };

test("Capa 1 = fórmula AN del Excel: costo × 1.01 × 14% × 150/360", () => {
  const f = financeCost({ supplierCost: 100000, saleCapital: 115000, daysExceeded: 0, ...P });
  // Excel DIF_TC_SL_AGRICOLA, AN = AL × (1 + 0.01) × W / 360 × 150.
  assert.equal(f.layer1, round2(100000 * 1.01 * 0.14 / 360 * 150));
  assert.equal(f.layer1, 5891.67);
  assert.equal(f.commission, 1000); // 1% sobre costo de proveedor, aparte (columna AO)
  assert.equal(f.layer2, 0); // sin días excedidos no hay Capa 2
});

test("Capa 2 (fórmula AK del Excel): capital de venta × 14% × días excedidos/360", () => {
  const f = financeCost({ supplierCost: 100000, saleCapital: 115000, daysExceeded: 90, ...P });
  // Excel: AK = R × W × N / 360
  const excel = round2(115000 * 0.14 * 90 / 360);
  assert.equal(f.layer2, excel);
  assert.equal(f.layer2, 4025);
  assert.equal(f.total, 1000 + 5891.67 + 4025);
});

test("operación completa: venta 115,000, costo 100,000, 90 días excedidos → utilidad 12,179.33", () => {
  // Ingresos: venta + mora al cliente (TIIE venc. 7% + 9% = 16% sobre cargo).
  const venta = 115000;
  const costo = 100000;
  const mora = round2(115000 * 0.16 * 90 / 360) + round2(115000 * 0.0304); // 4,600 + 3,496
  assert.equal(mora, 8096);
  const fin = financeCost({ supplierCost: costo, saleCapital: venta, daysExceeded: 90, ...P });
  // Utilidad = venta + mora + dif. cambiario − costo − comisión − C1 − C2 − descuento
  const utilidad = round2(venta + mora + 0 - costo - fin.commission - fin.layer1 - fin.layer2 - 0);
  assert.equal(utilidad, 12179.33); // 115,000 + 8,096 − 100,000 − 1,000 − 5,891.67 − 4,025
  // El cálculo viejo (una capa: costo × TIIE actual+4.5% × días de crédito/360)
  // habría restado solo ~4,817: la utilidad salía inflada ~$6,100.
  const capaViejaUnica = round2(100000 * (0.0706 + 0.045) * 150 / 360);
  assert.equal(capaViejaUnica, 4816.67);
  assert.ok(fin.total - capaViejaUnica > 6000);
});

test("descuento pronto pago real: paga al día 100 → se perdonan 1,944.44 del saldo", () => {
  const b = earlyPayBonus({
    cargo: 100000,
    issueDate: "2026-01-01",
    payDate: "2026-04-11",
    thresholdDays: 120,
    financialDays: 150,
    tiieAtIssue: 0.10,
    costSpread: 0.04,
  });
  assert.equal(b.applies, true);
  assert.equal(b.bonus, 1944.44);
  // El cliente deposita 98,055.56; el resto (1,944.44 ≤ bonificación) se
  // perdona y la factura queda saldada.
  const saldoTrasPago = round2(100000 - 98055.56);
  assert.ok(saldoTrasPago <= b.bonus + 0.009);
});

test("cableado: el P&L por pedido usa TIIE de emisión y parámetros de Ajustes", () => {
  const rep = src("src/lib/erp/reports.ts");
  assert.ok(rep.includes("financeCost({"), "computeDealPnl debe usar financeCost (comisión + Capa 1 + Capa 2)");
  assert.ok(rep.includes("issueDate"), "la TIIE de costo se toma de la fecha de emisión de la factura");
  // Primero la foto guardada en la factura; si no hay, los Ajustes de hoy.
  assert.ok(rep.includes("snap.commissionRate ?? pol.asrCommission"), "la comisión sale de la foto de la factura o de Ajustes, no quemada");
  assert.ok(rep.includes("snap.costSpread ?? pol.asrSpread"), "el spread de costo sale de la foto de la factura o de Ajustes");
  assert.ok(
    rep.includes("snap.financialDays ?? (fv[0] ? fv[0].credit_days : so[0].credit_days)"),
    "el plazo financiado es el del PEDIDO (foto de la factura, o sus días de crédito), no un fijo de Ajustes",
  );
  assert.ok(rep.includes("margin + mora + fxIncome - finance - discount"), "utilidad = margen + mora + dif. − financiero − descuento");
  assert.ok(!rep.includes("finance_spread"), "ya no debe usarse el spread de línea como costo del circuito");
});

test("cableado: el descuento por pronto pago se aplica de verdad al cobrar, con bitácora", () => {
  const ops = src("src/lib/erp/ops.ts");
  const helper = ops.slice(ops.indexOf("export async function applyInvoicePayment"), ops.indexOf("export const addBankMove"));
  assert.ok(helper.includes("earlyPayBonus({"), "el cobro debe calcular la bonificación");
  assert.ok(helper.includes("bono.applies && newRes <= bono.bonus"), "solo se perdona lo que cabe en la bonificación ganada");
  assert.ok(helper.includes(`"pronto-pago"`), "el descuento aplicado queda en bitácora");
  assert.ok(helper.includes("Pronto pago ${inv[0].name}"), "el descuento queda como pago sin banco, ligado a la factura");
  assert.ok(helper.includes("thresholdDays: pol.earlyPayDays"), "el umbral sale de Ajustes");
});

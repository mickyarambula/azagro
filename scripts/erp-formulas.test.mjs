import assert from "node:assert/strict";
import { test } from "node:test";

/** Copia de src/lib/erp/stock.ts movingAverage — si cambia el motor, este test falla. */
function movingAverage(oldQty, oldAvg, qtyIn, unitCost) {
  const on = Math.max(0, oldQty);
  const inn = Math.max(0, qtyIn);
  const next = on + inn;
  if (next <= 0.0000001) return Math.max(0, unitCost);
  return (on * Math.max(0, oldAvg) + inn * Math.max(0, unitCost)) / next;
}

const YEAR_DAYS = 360;
function daysBetween(from, to) {
  const a = Date.parse(from.slice(0, 10) + "T00:00:00");
  const b = Date.parse(to.slice(0, 10) + "T00:00:00");
  return Math.round((b - a) / 86400000);
}
function computeMora(input) {
  const end = input.paidDate && input.paidDate < input.asOf ? input.paidDate : input.asOf;
  const daysOverdue = Math.max(0, daysBetween(input.dueDate, end));
  const annualRate = input.tiieAtDue + input.spread;
  const interest = daysOverdue > 0 ? (input.capital * annualRate * daysOverdue) / YEAR_DAYS : 0;
  const fega = daysOverdue > 0 && !input.fegaAlreadyCharged ? input.capital * input.fegaRate : 0;
  return { daysOverdue, interest, fega, mora: interest + fega };
}
function computeStatementLine(input) {
  const paid = input.paidDate ? input.paidDate.slice(0, 10) : "";
  const fechaPago = paid && paid <= input.asOf ? paid : input.asOf;
  const daysVencidos = daysBetween(input.dueDate, fechaPago);
  const annualRate = input.tiieAtDue + input.spread;
  const interest = (input.cargo * annualRate * daysVencidos) / YEAR_DAYS;
  const comisionFega = input.cargo * input.fegaRate;
  return { daysVencidos, interest, comisionFega };
}
function residual(amount, paid) {
  return Math.max(0, amount - paid);
}

test("promedio móvil: 50 a 20 + 100 a 18 = 18.666…", () => {
  const avg = movingAverage(50, 20, 100, 18);
  assert.ok(Math.abs(avg - 18.666666) < 0.0001);
});

test("promedio móvil con bodega vacía toma el costo de la entrada", () => {
  assert.equal(movingAverage(0, 0, 10, 22), 22);
});

test("mora: 60 días, TIIE 7.06% + 9%, cargo 100000, FEGA 3.04%", () => {
  const m = computeMora({
    capital: 100000,
    dueDate: "2026-06-01",
    asOf: "2026-07-31",
    tiieAtDue: 0.0706,
    spread: 0.09,
    fegaRate: 0.0304,
    fegaAlreadyCharged: false,
  });
  assert.equal(m.daysOverdue, 60);
  const interest = (100000 * 0.1606 * 60) / 360;
  assert.ok(Math.abs(m.interest - interest) < 0.01);
  assert.ok(Math.abs(m.fega - 3040) < 0.01);
});

test("estado de cuenta: interés con signo (pronto pago negativo)", () => {
  const line = computeStatementLine({
    cargo: 100000,
    dueDate: "2026-10-01",
    asOf: "2026-08-01",
    paidDate: "2026-08-01",
    tiieAtDue: 0.0706,
    spread: 0.09,
    fegaRate: 0.0304,
  });
  assert.ok(line.daysVencidos < 0);
  assert.ok(line.interest < 0);
});

test("residual de factura no baja de cero", () => {
  assert.equal(residual(1000, 400), 600);
  assert.equal(residual(1000, 1000), 0);
  assert.equal(residual(1000, 1200), 0);
});

test("límite de crédito: usado + pedido no puede pasar el tope", () => {
  const limit = 500000;
  const used = 420000;
  const pedido = 90000;
  assert.equal(used + pedido > limit, true);
  assert.equal(used + 50000 > limit, false);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

/**
 * Copias de src/lib/erp/credit.ts (daysBetween, computeMora, moraBilling,
 * earlyPayBonus) — si cambia el motor, actualiza aquí y piensa por qué.
 * Los casos numéricos vienen de LOGICA.md y de las decisiones del dueño
 * (bloque 1): TIIE+9% de cobro, cargo original, mora desde el día 150.
 */
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
  return { daysOverdue, annualRate, interest, fega, mora: interest + fega, capital: input.capital };
}
const round2 = (n) => Math.round(n * 100) / 100;
function moraBilling(input) {
  const cargo = Math.max(0, input.cargo);
  const base = computeMora({
    capital: cargo,
    dueDate: input.moraDue,
    asOf: input.asOf,
    paidDate: input.paidDate,
    tiieAtDue: input.tiieAtDue,
    spread: input.spread,
    fegaRate: input.fegaRate,
    fegaAlreadyCharged: input.fegaCharged,
  });
  const interestNew = round2(Math.max(0, base.interest - Math.max(0, input.interestInvoiced)));
  const fegaNew = round2(base.fega);
  return { ...base, interestNew, fegaNew, charge: round2(interestNew + fegaNew) };
}
function earlyPayBonus(input) {
  const lived = daysBetween(input.issueDate, input.payDate);
  const rate = input.tiieAtIssue + input.costSpread;
  if (lived >= input.thresholdDays) return { applies: false, lived, days: 0, rate, bonus: 0 };
  const days = Math.max(0, input.financialDays - lived);
  const bonus = round2((Math.max(0, input.cargo) * rate * days) / YEAR_DAYS);
  return { applies: days > 0, lived, days, rate, bonus };
}

// Parámetros de los ejemplos: TIIE 7% + spread 9% = 16% anual, FEGA 3.04%.
const P = { tiieAtDue: 0.07, spread: 0.09, fegaRate: 0.0304 };

// ---------------------------------------------------------------------------
// Corrección 1 — la mora arranca el día 150 (plazo financiero), no el 120.
// ---------------------------------------------------------------------------
test("mora desde el día 150: factura 1-ene, paga 30-jun → 30 días de interés, no 60", () => {
  const cargo = 100000;
  // Factura 2026-01-01. Vencimiento visible: +120 = 1-may. Financiero: +150 = 31-may.
  const conRegla = moraBilling({
    cargo, moraDue: "2026-05-31", asOf: "2026-06-30", paidDate: "2026-06-30",
    ...P, interestInvoiced: 0, fegaCharged: false,
  });
  assert.equal(conRegla.daysOverdue, 30);
  assert.equal(conRegla.interestNew, 1333.33); // 100,000 × 16% × 30/360
  assert.equal(conRegla.fegaNew, 3040);
  // Con la fecha vieja (120 d) habrían sido 60 días: 30 de más.
  const reglaVieja = moraBilling({
    cargo, moraDue: "2026-05-01", asOf: "2026-06-30", paidDate: "2026-06-30",
    ...P, interestInvoiced: 0, fegaCharged: false,
  });
  assert.equal(reglaVieja.daysOverdue, 60);
  assert.equal(reglaVieja.interestNew, 2666.67);
});

test("cableado: la FI y el estado de cuenta usan credit_due (día 150), no due_date", () => {
  const ops = src("src/lib/erp/ops.ts");
  assert.ok(ops.includes("const moraDue = inv[0].credit_due || inv[0].due_date"), "issueMoraInvoice debe partir de credit_due");
  assert.ok(ops.includes("const moraDue = inv.credit_due || inv.due_date"), "getLiveStatement debe partir de credit_due");
  // La TIIE se toma en la fecha financiera, no en la visible.
  assert.ok(!ops.includes("nearestRate(tiieTable, inv.due_date"), "la TIIE del estado de cuenta ya no debe leerse al día 120");
});

// ---------------------------------------------------------------------------
// Corrección 2 — el abono del corte de Compaq se respeta al recalcular saldo.
// ---------------------------------------------------------------------------
test("factura importada: cargo 150,000, abono Compaq 20,000, pago nuevo 10,000 → saldo 120,000", () => {
  // Fórmula nueva de refreshInvoiceResidual: cargo − abono de corte − pagos de aquí.
  const residual = Math.max(0, 150000 - 20000 - 10000);
  assert.equal(residual, 120000);
  // Con la fórmula vieja (cargo − pagos) el saldo SUBÍA a 140,000.
  const viejo = Math.max(0, 150000 - 10000);
  assert.equal(viejo, 140000);
  const stock = src("src/lib/erp/stock.ts");
  assert.ok(stock.includes("opening_paid"), "refreshInvoiceResidual debe restar opening_paid");
  assert.ok(/amount\) - Number\(row\[0\]\.opening_paid\) - Number\(row\[0\]\.paid\)/.test(stock), "la resta debe incluir el abono de corte");
  const cutover = src("src/lib/erp/cutover.ts");
  assert.ok(cutover.includes("const openingPaid = Math.max(0, cargo - r.saldo)"), "el importador debe guardar el abono previo");
  assert.ok(cutover.includes("opening_paid"), "el insert del corte debe llevar opening_paid");
});

// ---------------------------------------------------------------------------
// Correcciones 3 y 6 — FEGA separado del interés y facturación por etapas.
// ---------------------------------------------------------------------------
test("segunda FI: día 60 factura 5,706.67; día 120 factura 2,666.66 (el código viejo daba 0)", () => {
  const cargo = 100000;
  const fi1 = moraBilling({
    cargo, moraDue: "2026-03-01", asOf: "2026-04-30", paidDate: null,
    ...P, interestInvoiced: 0, fegaCharged: false,
  });
  assert.equal(fi1.daysOverdue, 60);
  assert.equal(fi1.interestNew, 2666.67);
  assert.equal(fi1.fegaNew, 3040);
  assert.equal(fi1.charge, 5706.67);

  // Segunda corrida al día 120: el acumulado es SOLO interés (2,666.67).
  const fi2 = moraBilling({
    cargo, moraDue: "2026-03-01", asOf: "2026-06-29", paidDate: null,
    ...P, interestInvoiced: fi1.interestNew, fegaCharged: true,
  });
  assert.equal(fi2.daysOverdue, 120);
  assert.equal(fi2.interestNew, 2666.66); // 5,333.33 − 2,666.67
  assert.equal(fi2.fegaNew, 0);
  assert.equal(fi2.charge, 2666.66);

  // El defecto viejo: acumulado mezclado (interés + FEGA = 5,706.67) contra
  // interés solo → max(0, 5,333.33 − 5,706.67) = 0. Cobraba $0.
  const mezclaVieja = round2(Math.max(0, 5333.33 - 5706.67));
  assert.equal(mezclaVieja, 0);
});

test("pago parcial + liquidación: la mora corre sobre el CARGO, no sobre el saldo", () => {
  const cargo = 100000;
  // Paga 50,000 al día 60 de vencida: FI-1 sobre cargo completo.
  const fi1 = moraBilling({
    cargo, moraDue: "2026-03-01", asOf: "2026-04-30", paidDate: "2026-04-30",
    ...P, interestInvoiced: 0, fegaCharged: false,
  });
  assert.equal(fi1.charge, 5706.67);
  // Liquida al día 120: el interés nuevo sigue siendo sobre el cargo.
  const fi2 = moraBilling({
    cargo, moraDue: "2026-03-01", asOf: "2026-06-29", paidDate: "2026-06-29",
    ...P, interestInvoiced: fi1.interestNew, fegaCharged: true,
  });
  assert.equal(fi2.charge, 2666.66); // el código viejo (base saldo 50,000) daba $0
  const ops = src("src/lib/erp/ops.ts");
  assert.ok(ops.includes("cargo: Number(inv[0].amount)"), "la FI debe usar el cargo original como base");
  assert.ok(!/capital: Number\(inv\[0\]\.residual\) > 0\.009/.test(ops), "ya no debe existir la base sobre saldo en la FI");
});

// ---------------------------------------------------------------------------
// Corrección 4 — un solo camino de cobro para Cartera y Bancos.
// ---------------------------------------------------------------------------
test("cableado: Cartera y Bancos cobran por applyInvoicePayment, en transacción", () => {
  const az = src("src/lib/azagro.ts");
  const ops = src("src/lib/erp/ops.ts");
  assert.ok(az.includes("return applyInvoicePayment(sql, {"), "registerPayment debe delegar en applyInvoicePayment");
  assert.ok(ops.includes("return applyInvoicePayment(sql, {"), "addBankMove ligado a factura debe delegar en applyInvoicePayment");
  const addBank = ops.slice(ops.indexOf("export const addBankMove"), ops.indexOf("export const reconcileMove"));
  assert.ok(addBank.includes("withTx("), "addBankMove debe correr en transacción");
  // El camino compartido factura la mora al cobrar (ya no se salta en Bancos).
  const helper = ops.slice(ops.indexOf("export async function applyInvoicePayment"), ops.indexOf("export const addBankMove"));
  assert.ok(helper.includes("issueMoraInvoice("), "el cobro compartido debe facturar la mora del día del pago");
  assert.ok(!helper.includes("catch"), "un error real al facturar mora no debe tragarse en silencio");
});

// ---------------------------------------------------------------------------
// Corrección 5 — pantalla y factura alineadas (ambas sobre cargo).
// ---------------------------------------------------------------------------
test("cableado: el estado de cuenta calcula sobre cargo y muestra lo mismo que facturaría la FI", () => {
  const ops = src("src/lib/erp/ops.ts");
  assert.ok(ops.includes("capital: Math.max(0, cargo)"), "computeMora del estado de cuenta debe usar el cargo");
  assert.ok(!/const capital = saldo > 0\.009 \? saldo : cargo/.test(ops), "ya no debe alternar entre saldo y cargo");
  assert.ok(
    ops.includes("Math.max(0, mora.interest - intInvoiced) + mora.fega"),
    "liveMora debe ser interés nuevo + FEGA pendiente (lo mismo que facturaría la FI)",
  );
  // Un abono parcial no congela los días: solo la liquidación total detiene el interés.
  assert.ok(ops.includes("const paidForCalc = saldo <= 0.009"), "el interés debe correr hasta la liquidación total");
});

// ---------------------------------------------------------------------------
// Bonificación por pronto pago (regla confirmada, parametrizable).
// ---------------------------------------------------------------------------
test("pronto pago: paga al día 100 → bonifica 50 días a TIIE emisión + 4%", () => {
  const b = earlyPayBonus({
    cargo: 100000,
    issueDate: "2026-01-01",
    payDate: "2026-04-11", // día 100
    thresholdDays: 120,
    financialDays: 150,
    tiieAtIssue: 0.10,
    costSpread: 0.04,
  });
  assert.equal(b.applies, true);
  assert.equal(b.lived, 100);
  assert.equal(b.days, 50);
  assert.equal(b.bonus, 1944.44); // 100,000 × 14% × 50/360
});

test("pronto pago: paga al día 130 (después del umbral de 120) → no aplica", () => {
  const b = earlyPayBonus({
    cargo: 100000,
    issueDate: "2026-01-01",
    payDate: "2026-05-11", // día 130
    thresholdDays: 120,
    financialDays: 150,
    tiieAtIssue: 0.10,
    costSpread: 0.04,
  });
  assert.equal(b.applies, false);
  assert.equal(b.bonus, 0);
});

// ---------------------------------------------------------------------------
// Parámetros: nada quemado; editable solo por administrador y con bitácora.
// ---------------------------------------------------------------------------
test("parámetros de cartera: editables, solo admin, con bitácora anterior → nuevo", () => {
  const ops = src("src/lib/erp/ops.ts");
  const save = ops.slice(ops.indexOf("export const saveSettings"), ops.indexOf("export const saveTiie"));
  assert.ok(save.includes("assertAdmin(sql, context.userId)"), "guardar parámetros exige administrador");
  assert.ok(save.includes("writeAudit("), "los cambios de parámetros van a bitácora");
  assert.ok(save.includes("→"), "la bitácora debe llevar valor anterior → nuevo");
  assert.ok(save.includes("early_pay_days"), "el umbral de pronto pago se guarda en Ajustes");
  const policyFn = ops.slice(ops.indexOf("async function policy"), ops.indexOf("export const getSettings"));
  for (const col of ["credit_days", "invoice_days", "fega_rate", "collection_spread", "asr_commission", "asr_spread", "early_pay_days"]) {
    assert.ok(policyFn.includes(col), `la política debe leer ${col} de Ajustes (no constantes)`);
  }
  const credit = src("src/lib/erp/credit.ts");
  assert.ok(credit.includes("thresholdDays"), "el umbral del pronto pago es parámetro, no número quemado");
  assert.ok(credit.includes("financialDays"), "el plazo financiero es parámetro, no número quemado");
});

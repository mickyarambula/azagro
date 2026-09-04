// ESTADO DE CUENTA CON CORTE ANTES DEL VENCIMIENTO (3-sep-2026, prueba con el
// dueño).
//
// Lo que estaba mal: la pantalla multiplicaba por días NEGATIVOS y mostraba un
// "interés a favor" a la tasa de COBRO (TIIE + spread de mora), más una columna
// de comisión + FEGA sobre facturas que todavía no vencían.
//
// Cómo debe quedar, con corte ANTES del vencimiento:
//   · saldo, fecha de vencimiento y los días que faltan;
//   · NADA de interés, comisión ni FEGA — no existen todavía;
//   · aparte y etiquetado como ESTIMACIÓN, el beneficio por pronto pago si el
//     cliente pagara en la fecha del corte, a la tasa de COSTO (TIIE de la
//     emisión + spread ASR), no a la de cobro, y solo si el pago cae antes del
//     umbral de pronto pago de Ajustes.
// Con corte DESPUÉS del vencimiento no cambia nada: mora normal.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

const YEAR_DAYS = 360;
const round2 = (n) => Math.round(n * 100) / 100;

function daysBetween(from, to) {
  const a = Date.parse(from.slice(0, 10) + "T00:00:00");
  const b = Date.parse(to.slice(0, 10) + "T00:00:00");
  return Math.round((b - a) / 86400000);
}

/** Copia de src/lib/erp/credit.ts splitFegaBundle. */
function splitFegaBundle(fegaRate, commissionRate) {
  const commission = Math.min(Math.max(0, commissionRate), Math.max(0, fegaRate));
  return { commission, fega: Math.max(0, fegaRate - commission), bundle: fegaRate };
}

/** Copia de src/lib/erp/credit.ts computeStatementLine. */
function computeStatementLine(input) {
  const paid = input.paidDate ? input.paidDate.slice(0, 10) : "";
  const fechaPago = paid && paid <= input.asOf ? paid : input.asOf;
  const daysVence = daysBetween(input.dueDate, input.asOf);
  const daysVencidos = daysBetween(input.dueDate, fechaPago);
  const vencido = daysVencidos > 0;
  const annualRate = input.tiieAtDue + input.spread;
  const interest = vencido ? (input.cargo * annualRate * daysVencidos) / YEAR_DAYS : 0;
  const split = splitFegaBundle(input.fegaRate, input.commissionRate);
  const comisionFega = vencido ? input.cargo * split.bundle : 0;
  return {
    fechaPago,
    daysVence,
    daysVencidos,
    vencido,
    diasPorVencer: Math.max(0, -daysVence),
    annualRate,
    interest,
    comisionFega,
    totalFinanciero: interest + comisionFega,
  };
}

/** Copia de src/lib/erp/credit.ts earlyPayBonus. */
function earlyPayBonus(input) {
  const lived = daysBetween(input.issueDate, input.payDate);
  const rate = input.tiieAtIssue + input.costSpread;
  if (lived >= input.thresholdDays) return { applies: false, lived, days: 0, rate, bonus: 0 };
  const days = Math.max(0, input.financialDays - lived);
  const bonus = round2((Math.max(0, input.cargo) * rate * days) / YEAR_DAYS);
  return { applies: days > 0, lived, days, rate, bonus };
}

// El caso del dueño: SL AGRICOLA, cargo 156,849.85, factura emitida el día del
// corte, plazo financiero 150 d, umbral de pronto pago 120 d.
// TIIE 6.9% · spread de cobro 9% · spread ASR (costo) 4% · comisión + FEGA 3.04%.
const CASO = {
  cargo: 156849.85,
  emision: "2026-09-03",
  moraDue: "2027-01-31", // 150 días exactos después
  tiie: 0.069,
  spreadCobro: 0.09,
  spreadAsr: 0.04,
  fegaRate: 0.0304,
  commissionRate: 0.01,
  financialDays: 150,
  umbral: 120,
};

test("corte antes del vencimiento: ni interés, ni comisión, ni FEGA; solo los días que faltan", () => {
  const line = computeStatementLine({
    cargo: CASO.cargo,
    dueDate: CASO.moraDue,
    asOf: CASO.emision,
    paidDate: null,
    tiieAtDue: CASO.tiie,
    spread: CASO.spreadCobro,
    fegaRate: CASO.fegaRate,
    commissionRate: CASO.commissionRate,
  });
  assert.equal(line.vencido, false);
  assert.equal(line.diasPorVencer, 150);
  assert.equal(line.interest, 0);
  assert.equal(line.comisionFega, 0);
  assert.equal(line.totalFinanciero, 0);
});

test("lo que hacía antes: interés negativo a tasa de cobro + 3.04% sobre lo no vencido", () => {
  // Reproducción del cálculo viejo, para dejar por escrito de qué se salió.
  const viejoInteres = round2((CASO.cargo * (CASO.tiie + CASO.spreadCobro) * -150) / YEAR_DAYS);
  assert.equal(viejoInteres, -10391.3);
  const viejaComision = round2(CASO.cargo * CASO.fegaRate);
  assert.equal(viejaComision, 4768.24);
});

test("la bonificación va a tasa de COSTO: 7,123.60, no 10,391.30", () => {
  const b = earlyPayBonus({
    cargo: CASO.cargo,
    issueDate: CASO.emision,
    payDate: CASO.emision, // el cliente pagaría hoy, en la fecha del corte
    thresholdDays: CASO.umbral,
    financialDays: CASO.financialDays,
    tiieAtIssue: CASO.tiie,
    costSpread: CASO.spreadAsr, // TIIE + spread ASR = 10.9%
  });
  assert.equal(b.applies, true);
  assert.equal(b.days, 150);
  assert.equal(round2(b.rate), 0.11); // 10.9% redondeado a dos decimales de fracción
  assert.equal(b.bonus, 7123.6);
  // Con la tasa de cobro (TIIE + spread de mora = 15.9%) salían 10,391.30:
  // 3,267.71 regalados por factura.
  const conTasaDeCobro = round2((CASO.cargo * (CASO.tiie + CASO.spreadCobro) * 150) / YEAR_DAYS);
  assert.equal(conTasaDeCobro, 10391.3);
  assert.equal(round2(conTasaDeCobro - b.bonus), 3267.7);
});

test("el umbral manda: pagar el día del umbral o después no bonifica nada", () => {
  const enElUmbral = earlyPayBonus({
    cargo: CASO.cargo,
    issueDate: CASO.emision,
    payDate: "2027-01-01", // día 120 exacto desde la emisión
    thresholdDays: CASO.umbral,
    financialDays: CASO.financialDays,
    tiieAtIssue: CASO.tiie,
    costSpread: CASO.spreadAsr,
  });
  assert.equal(enElUmbral.lived, 120);
  assert.equal(enElUmbral.applies, false);
  assert.equal(enElUmbral.bonus, 0);
  // Un día antes sí: se bonifican los 31 d del plazo financiero sin consumir.
  const unDiaAntes = earlyPayBonus({
    cargo: CASO.cargo,
    issueDate: CASO.emision,
    payDate: "2026-12-31",
    thresholdDays: CASO.umbral,
    financialDays: CASO.financialDays,
    tiieAtIssue: CASO.tiie,
    costSpread: CASO.spreadAsr,
  });
  assert.equal(unDiaAntes.lived, 119);
  assert.equal(unDiaAntes.applies, true);
  assert.equal(unDiaAntes.days, 31);
  assert.equal(unDiaAntes.bonus, round2((CASO.cargo * 0.109 * 31) / YEAR_DAYS));
});

test("corte después del vencimiento: la mora sigue igual que siempre", () => {
  const line = computeStatementLine({
    cargo: CASO.cargo,
    dueDate: CASO.moraDue,
    asOf: "2027-03-02", // 30 días exactos vencida
    paidDate: null,
    tiieAtDue: CASO.tiie,
    spread: CASO.spreadCobro,
    fegaRate: CASO.fegaRate,
    commissionRate: CASO.commissionRate,
  });
  assert.equal(line.vencido, true);
  assert.equal(line.daysVencidos, 30);
  assert.equal(round2(line.interest), round2((CASO.cargo * 0.159 * 30) / YEAR_DAYS));
  assert.equal(round2(line.comisionFega), round2(CASO.cargo * CASO.fegaRate));
  // Y ahí sí, con corte vencido, no hay bonificación de pronto pago.
  const b = earlyPayBonus({
    cargo: CASO.cargo,
    issueDate: CASO.emision,
    payDate: "2027-03-02",
    thresholdDays: CASO.umbral,
    financialDays: CASO.financialDays,
    tiieAtIssue: CASO.tiie,
    costSpread: CASO.spreadAsr,
  });
  assert.equal(b.applies, false);
});

test("cableado: el motor no cobra nada antes del vencimiento", () => {
  const credit = src("src/lib/erp/credit.ts");
  assert.ok(credit.includes("const vencido = daysVencidos > 0;"), "computeStatementLine decide si ya venció");
  assert.ok(
    credit.includes("const interest = vencido ? (input.cargo * annualRate * daysVencidos) / YEAR_DAYS : 0;"),
    "sin vencimiento no hay interés (no se multiplica por días negativos)",
  );
  assert.ok(credit.includes("const comisionFega = vencido ? input.cargo * split.bundle : 0;"), "sin vencimiento no hay comisión + FEGA");
  assert.ok(credit.includes("if (i.days <= 0) {"), "el desglose explica que no ha vencido en vez de enseñar un interés a favor");
});

test("cableado: el estado de cuenta estima el pronto pago al corte, a tasa ASR", () => {
  const ops = src("src/lib/erp/ops.ts");
  const live = ops.slice(ops.indexOf("export const getLiveStatement"), ops.indexOf("export async function issueMoraInvoice"));
  assert.ok(live.includes("const vencido = productDoc && diasVencidos > 0;"), "cada renglón sabe si ya venció");
  assert.ok(live.includes("const sinTiie = vencido && tiiePick == null;"), "una factura por vencer no necesita TIIE: no hay nada que calcular");
  assert.ok(live.includes("const fechaBono = paidForCalc ?? asOf;"), "sin pago, la bonificación se estima a la fecha del corte");
  assert.ok(live.includes("const bonoEstimado = productDoc && paidForCalc == null;"), "y queda marcada como estimación");
  assert.ok(live.includes("costSpread: pol.asrSpread,"), "la bonificación va a tasa de COSTO (spread ASR), no a la de cobro");
  assert.ok(!live.includes("costSpread: pol.collectionSpread"), "nunca con el spread de cobro");
  assert.ok(live.includes("thresholdDays: pol.earlyPayDays,"), "el umbral sale de Ajustes");
});

test("cableado: la pantalla muestra la columna de pronto pago y esconde lo que no ha nacido", () => {
  const ec = src("src/routes/statements.tsx");
  assert.ok(ec.includes('"Pronto pago (est.)"'), "columna nueva, etiquetada como estimación");
  assert.ok(ec.includes("`faltan ${r.diasPorVencer}`"), "con corte antes del vencimiento se ven los días que faltan");
  assert.ok(ec.includes('!r.vencido ? "—"'), "interés, comisión y FEGA salen en guion mientras no venza");
  assert.ok(ec.includes("Lo que todavía no vence no lleva interés, ni comisión, ni FEGA"), "y la pantalla lo dice");
});

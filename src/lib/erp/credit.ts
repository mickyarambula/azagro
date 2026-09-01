import { COMMISSION_RATE, FEGA_BUNDLE_RATE, YEAR_DAYS } from "@/lib/erp/rules";
import { dateDMY, moneyIn, todayMx } from "@/lib/utils";

/** Motor de crédito Azagro — mismas reglas que los Excel de cartera (Grupo SL, no el export crudo de Compaq). */

export type CreditPolicy = {
  creditDays: number;
  invoiceDays: number;
  fegaRate: number;
  commissionRate: number;
  collectionSpread: number;
  financeSpread: number;
  defaultTiie: number;
};

export const DEFAULT_POLICY: CreditPolicy = {
  creditDays: 150,
  invoiceDays: 120,
  fegaRate: FEGA_BUNDLE_RATE,
  commissionRate: COMMISSION_RATE,
  collectionSpread: 0.09,
  financeSpread: 0.045,
  defaultTiie: 0.0706,
};

export function daysBetween(from: string, to: string) {
  const a = Date.parse(from.slice(0, 10) + "T00:00:00");
  const b = Date.parse(to.slice(0, 10) + "T00:00:00");
  return Math.round((b - a) / 86400000);
}

export function addDays(iso: string, days: number) {
  // Aritmética en UTC puro: el resultado no depende del timezone del servidor.
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

export function nearestRate(table: Array<{ date: string; rate: number }>, asOf: string, fallback: number) {
  const t = asOf.slice(0, 10);
  const sorted = [...table].sort((a, b) => a.date.localeCompare(b.date));
  let pick = fallback;
  for (const row of sorted) {
    if (row.date <= t) pick = row.rate;
    else break;
  }
  return pick;
}

/** Serie + folio al estilo Compaq (A / 292). FV-0001 → serie FV, folio 0001. */
export function splitDocName(name: string) {
  const m = String(name || "").trim().match(/^([A-Za-z]+)\s*[-]?\s*(\d+)\s*$/);
  if (m) return { serie: m[1]!.toUpperCase(), folio: m[2]! };
  return { serie: "", folio: String(name || "").trim() };
}

export function splitFegaBundle(fegaRate: number, commissionRate = COMMISSION_RATE) {
  const commission = Math.min(Math.max(0, commissionRate), Math.max(0, fegaRate));
  return { commission, fega: Math.max(0, fegaRate - commission), bundle: fegaRate };
}

/**
 * Mora a facturar (FI):
 *   Interés = Capital × (TIIE vencimiento + spread) × días vencidos / 360   (nunca negativo)
 *   FEGA    = Capital × 3.04%  (una sola vez, si ya venció y no se ha facturado)
 * Mora corre aunque el capital ya se haya pagado, sobre los días que estuvo vencido
 * hasta la fecha de pago (o el corte si sigue pendiente).
 */
export function computeMora(input: {
  capital: number;
  dueDate: string;
  asOf: string;
  paidDate?: string | null;
  tiieAtDue: number;
  spread: number;
  fegaRate: number;
  fegaAlreadyCharged: boolean;
}) {
  const end = input.paidDate && input.paidDate < input.asOf ? input.paidDate : input.asOf;
  const daysOverdue = Math.max(0, daysBetween(input.dueDate, end));
  const annualRate = input.tiieAtDue + input.spread;
  const interest = daysOverdue > 0 ? (input.capital * annualRate * daysOverdue) / YEAR_DAYS : 0;
  const fega = daysOverdue > 0 && !input.fegaAlreadyCharged ? input.capital * input.fegaRate : 0;
  return {
    daysOverdue,
    annualRate,
    interest,
    fega,
    mora: interest + fega,
    tiie: input.tiieAtDue,
    spread: input.spread,
    capital: input.capital,
    endDate: end,
  };
}

/**
 * Línea del estado de cuenta (papel Excel, no el export crudo de Compaq).
 *
 * Compaq trae: código, serie, folio, fecha, vencimiento, días vence, cargo, abono, saldo, ut. cambiaria.
 * El Excel le agrega: plazo, fecha de pago, días vencidos, interés s/ días, comisión + FEGA, total.
 *
 * Fórmulas (igual que GRUPO SL / SL AGRICOLA):
 *   Días vence     = vencimiento → corte (con signo)
 *   Días vencidos  = vencimiento → fecha de pago, o corte si sigue abierta (con signo)
 *   Interés        = Cargo × (TIIE al vencimiento + 9%) × días vencidos / 360   (con signo: negativo = pronto pago)
 *   Comisión+FEGA  = Cargo × 3.04%  (1% + 2.04%), siempre, sobre el cargo
 *   Total int+FEGA = interés + comisión+FEGA
 *
 * El capital del Excel es el CARGO (importe original), no el saldo.
 * La tasa anual del encabezado es TIIE + spread (en el Excel a veces la congelaban a 18%).
 */
export function computeStatementLine(input: {
  cargo: number;
  dueDate: string;
  asOf: string;
  paidDate?: string | null;
  tiieAtDue: number;
  spread: number;
  fegaRate: number;
  commissionRate?: number;
}) {
  const paid = input.paidDate ? input.paidDate.slice(0, 10) : "";
  const fechaPago = paid && paid <= input.asOf ? paid : input.asOf;
  const daysVence = daysBetween(input.dueDate, input.asOf);
  const daysVencidos = daysBetween(input.dueDate, fechaPago);
  const annualRate = input.tiieAtDue + input.spread;
  const interest = (input.cargo * annualRate * daysVencidos) / YEAR_DAYS;
  const split = splitFegaBundle(input.fegaRate, input.commissionRate);
  const comisionFega = input.cargo * split.bundle;
  return {
    fechaPago,
    daysVence,
    daysVencidos,
    annualRate,
    tiie: input.tiieAtDue,
    spread: input.spread,
    interest,
    commissionRate: split.commission,
    fegaOnlyRate: split.fega,
    comisionFega,
    totalFinanciero: interest + comisionFega,
    capital: input.cargo,
  };
}

export function pctRate(n: number) {
  const p = Math.max(0, n) * 100;
  const t = p.toFixed(4).replace(/\.?0+$/, "");
  return `${t}%`;
}

/** Texto del cálculo, el que va en el estado de cuenta y en cartera. */
export function explainInterest(i: {
  capital: number;
  days: number;
  tiie: number;
  spread: number;
  interest: number;
  fega?: number;
  fegaRate?: number;
  commissionRate?: number;
  currency?: string;
  dueDate?: string;
  residual?: number;
}) {
  const cur = i.currency === "USD" ? "USD" : "MXN";
  const cap = moneyIn(i.capital, cur);
  const int = moneyIn(i.interest, cur);
  const annual = i.tiie + i.spread;
  const dueBit = i.dueDate ? ` al ${dateDMY(i.dueDate)}` : " en la fecha de vencimiento";
  const split = splitFegaBundle(i.fegaRate ?? FEGA_BUNDLE_RATE, i.commissionRate);
  const base =
    i.residual != null && i.residual > 0.009
      ? "saldo pendiente"
      : i.residual != null
        ? "cargo original (el documento ya se pagó)"
        : "cargo";

  const math = `${cap} × (${pctRate(i.tiie)} TIIE + ${pctRate(i.spread)}) × ${i.days} d / 360 = ${int}`;
  const lines = [
    "Misma fórmula que el Excel de cartera (no el export crudo de Compaq).",
    "Interés = Cargo × Tasa anual × Días vencidos / 360.",
    `Tasa anual = TIIE${dueBit} + 9% (spread de cobro) = ${pctRate(annual)}.`,
    `Cargo (${base}): ${cap}. Días vencidos: ${i.days} (con signo; el factor es /360).`,
    math,
  ];
  if (i.days < 0) {
    lines.push("Días negativos = pagaron o el corte es antes del vencimiento (pronto pago). El interés sale a favor.");
  }
  const fg = moneyIn(i.fega ?? 0, cur);
  lines.push(
    `Comisión ${pctRate(split.commission)} + FEGA ${pctRate(split.fega)} = ${pctRate(split.bundle)} × ${cap} = ${fg || moneyIn(i.capital * split.bundle, cur)}. Se factura aparte en FI, no se suma al precio del producto.`,
  );
  const total = (i.interest || 0) + (i.fega ?? i.capital * split.bundle);
  lines.push(`Total intereses + FEGA = ${int} + comisión/FEGA = ${moneyIn(total, cur)}.`);
  return { short: math, lines };
}

export type DueCheck = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

/** Vencimiento vs emisión, días exactos y si ya se pasó. */
export function validateDueDates(input: {
  issue: string;
  due: string;
  days?: number;
  asOf?: string;
  allowPast?: boolean;
  invoiceDue?: string;
}): DueCheck {
  const issue = (input.issue || "").slice(0, 10);
  const due = (input.due || "").slice(0, 10);
  const asOf = (input.asOf || todayMx()).slice(0, 10);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!issue || !due) {
    errors.push("Falta la fecha de emisión o la de vencimiento.");
    return { ok: false, errors, warnings };
  }
  if (due < issue) {
    errors.push(`El vencimiento (${dateDMY(due)}) no puede ser anterior a la emisión (${dateDMY(issue)}).`);
  }
  if (input.invoiceDue) {
    const inv = input.invoiceDue.slice(0, 10);
    if (inv < issue) {
      errors.push(`El vencimiento de factura (${dateDMY(inv)}) no puede ser anterior a la emisión (${dateDMY(issue)}).`);
    }
    if (due < inv) {
      errors.push(`La mora (${dateDMY(due)}) no puede ser anterior al vencimiento de factura (${dateDMY(inv)}).`);
    }
  }
  if (input.days != null && input.days > 0) {
    const expected = addDays(issue, input.days);
    if (expected !== due) {
      warnings.push(`Con ${input.days} d exactos debe vencer el ${dateDMY(expected)}, no el ${dateDMY(due)}.`);
    }
  }
  if (due < asOf) {
    const n = daysBetween(due, asOf);
    const msg = `Ya venció hace ${n} d exactos (${dateDMY(due)}).`;
    if (input.allowPast) warnings.push(msg);
    else errors.push(msg);
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function assertDueOk(check: DueCheck) {
  if (check.errors[0]) throw new Error(check.errors[0]);
}

/** Diferencial = Importe USD × (TC pactado − TC pagado). Positivo = nos deben. */
export function fxDifferential(usdAmount: number, fxAgreed: number, fxPaid: number | null | undefined) {
  if (!usdAmount || !fxAgreed || fxPaid == null || !Number.isFinite(fxPaid)) return 0;
  return usdAmount * (fxAgreed - fxPaid);
}

/**
 * Cobro de una factura en dólares (el libro se lleva en pesos al TC pactado):
 * el depósito real en pesos se convierte a USD con el TC del día del pago,
 * esos USD se aplican al saldo al TC PACTADO, y la diferencia de pesos es el
 * diferencial cambiario del tramo:
 *   diff = USD aplicados × (TC pagado − TC pactado)
 *   diff negativo → pagaron de menos (POR COBRAR) · positivo → de más (POR DEVOLVER)
 */
export function fxPaymentSplit(input: {
  depositedMxn: number;
  fxPaid: number;
  fxAgreed: number;
  residualMxn: number;
}) {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  if (input.fxPaid <= 0 || input.fxAgreed <= 0) {
    throw new Error("Tipo de cambio inválido");
  }
  const residualUsd = input.residualMxn / input.fxAgreed;
  const usdPaid = input.depositedMxn / input.fxPaid;
  const usdApplied = Math.min(usdPaid, residualUsd);
  const appliedMxn = round2(usdApplied * input.fxAgreed);
  const bankMxn = round2(usdApplied * input.fxPaid);
  return { usdApplied: round2(usdApplied), appliedMxn, bankMxn, diff: round2(bankMxn - appliedMxn) };
}

/**
 * Cuánto facturar HOY de mora (FI), sin cobrar doble.
 *
 * Reglas del negocio (Excel de utilidad, confirmadas por el dueño):
 * - El interés corre SIEMPRE sobre el cargo original, no sobre el saldo.
 * - Arranca en el plazo financiero (día 150 desde la factura), no en el
 *   vencimiento visible (120).
 * - El acumulado ya facturado se lleva POR SEPARADO: interés por un lado
 *   (interestInvoiced) y FEGA por otro (fegaCharged). Mezclarlos hacía que
 *   la segunda FI cobrara de menos exactamente el FEGA.
 */
export function moraBilling(input: {
  cargo: number;
  moraDue: string;
  asOf: string;
  paidDate?: string | null;
  tiieAtDue: number;
  spread: number;
  fegaRate: number;
  interestInvoiced: number;
  fegaCharged: boolean;
}) {
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
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const interestNew = round2(Math.max(0, base.interest - Math.max(0, input.interestInvoiced)));
  const fegaNew = round2(base.fega);
  return { ...base, interestNew, fegaNew, charge: round2(interestNew + fegaNew) };
}

/**
 * Bonificación por pronto pago (regla Excel, confirmada):
 * aplica solo si el cliente paga antes del umbral (120 días desde la factura);
 * bonifica los días entre el pago y el plazo financiero (150), a la tasa de
 * COSTO (TIIE del mes de emisión + spread de costo), sobre el cargo.
 */
export function earlyPayBonus(input: {
  cargo: number;
  issueDate: string;
  payDate: string;
  thresholdDays: number;
  financialDays: number;
  tiieAtIssue: number;
  costSpread: number;
}) {
  const lived = daysBetween(input.issueDate, input.payDate);
  const rate = input.tiieAtIssue + input.costSpread;
  if (lived >= input.thresholdDays) {
    return { applies: false, lived, days: 0, rate, bonus: 0 };
  }
  const days = Math.max(0, input.financialDays - lived);
  const bonus = Math.round(((Math.max(0, input.cargo) * rate * days) / YEAR_DAYS) * 100) / 100;
  return { applies: days > 0, lived, days, rate, bonus };
}

/**
 * Costo financiero PROPIO de Azagro por operación (circuito con la empresa
 * hermana, hoja RUTA del Excel):
 * - Comisión sobre el costo de proveedor (hoy 1%).
 * - Capa 1 = costo × (1 + comisión) × (TIIE de emisión + spread de costo)
 *   × plazo financiero / 360. Corre SIEMPRE, sobre el plazo completo.
 * - Capa 2 = capital de la venta × la misma tasa × días excedidos / 360.
 *   Solo cuando el cliente se pasa del plazo financiero.
 * La TIIE de emisión (mes en que se facturó) es distinta de la TIIE con la
 * que se cobra al cliente (mes del vencimiento financiero).
 */
export function financeCost(input: {
  supplierCost: number;
  saleCapital: number;
  commissionRate: number;
  costSpread: number;
  tiieAtIssue: number;
  financialDays: number;
  daysExceeded: number;
}) {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const cost = Math.max(0, input.supplierCost);
  const rate = input.tiieAtIssue + input.costSpread;
  const commission = round2(cost * Math.max(0, input.commissionRate));
  const layer1 = round2((cost * (1 + Math.max(0, input.commissionRate)) * rate * Math.max(0, input.financialDays)) / YEAR_DAYS);
  const layer2 = round2((Math.max(0, input.saleCapital) * rate * Math.max(0, input.daysExceeded)) / YEAR_DAYS);
  return { rate, commission, layer1, layer2, total: round2(commission + layer1 + layer2) };
}

export type ClockStatus = "overdue" | "today" | "open";

/** Reloj de un vencimiento en días calendario exactos. */
export function exactClock(due: string, asOf?: string) {
  const today = (asOf || todayMx()).slice(0, 10);
  const d = due.slice(0, 10);
  const delta = daysBetween(d, today);
  if (delta > 0) {
    return { status: "overdue" as const, days: delta, due: d, asOf: today, label: `Vencido ${delta} d exactos` };
  }
  if (delta === 0) {
    return { status: "today" as const, days: 0, due: d, asOf: today, label: "Vence hoy" };
  }
  return { status: "open" as const, days: -delta, due: d, asOf: today, label: `${-delta} d exactos por vencer` };
}

// PASO 3 del catálogo de circuitos (5-sep-2026): EL MOTOR LEE EL CIRCUITO.
//
// Dos cosas, en este orden de importancia:
//
//   1. IDENTIDAD. Todo lo que corre por el Circuito ASR (doble facturación,
//      lo único que ha operado hasta hoy) sale IDÉNTICO AL CENTAVO. Aquí vive
//      una copia CONGELADA del motor tal como estaba antes del paso 3
//      (priceSale / financeUnit / creditFromCash / ladderFor sin base) y se
//      compara contra las copias literales del motor de ahora con
//      financingBase = "costo_comision", en una malla de casos y en los casos
//      del dueño. Si un solo número cambia, algo está mal y hay que parar.
//
//   2. EL CAMINO LINEAL (Línea Santa Rosa), lo único nuevo, contra los
//      números de DISENO_FINANCIAMIENTO.md § 5 recalculado el 5-sep-2026:
//      costo 100,000 · margen 6.5 % sobre la factura a Santa Rosa · tasa de
//      cobro 7.05 % + spread 4.00 % · 150 días →
//        factura a Santa Rosa 106,951.87 (margen 6,951.87)
//        financiamiento        4,924.24
//        precio al cliente   111,876.11
//      En % y en $ fijo, y la captura inversa desde el precio al cliente. Y la
//      partición del P&L: margen 6,951.87 / financiamiento 4,924.24, no los
//      320.08 mal atribuidos del motor ASR (ESTADO.md § 3.d).
//
// Contado no cambia. Línea propia sigue apagada.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");
const sinComentarios = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:'"`])\/\/.*$/gm, "$1");

const YEAR_DAYS = 360;
const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;

// ---------------------------------------------------------------------------
// A. Copias literales de margins.ts / credit.ts (no cambiaron en el paso 3).
// ---------------------------------------------------------------------------
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
function financeCost(input) {
  const cost = Math.max(0, input.supplierCost);
  const rate = input.tiieAtIssue + input.costSpread;
  const commission = round2(cost * Math.max(0, input.commissionRate));
  const layer1 = round2((cost * (1 + Math.max(0, input.commissionRate)) * rate * Math.max(0, input.financialDays)) / YEAR_DAYS);
  const layer2 = round2((Math.max(0, input.saleCapital) * rate * Math.max(0, input.daysExceeded)) / YEAR_DAYS);
  return { rate, commission, layer1, layer2, total: round2(commission + layer1 + layer2) };
}

// ---------------------------------------------------------------------------
// B. El motor ANTES del paso 3, congelado tal cual (commit d1af834). Es la
//    referencia: no se toca nunca. Si cambia el motor, la comparación de
//    abajo tiene que seguir dando cero diferencias por ASR.
// ---------------------------------------------------------------------------
function priceSale_ANTES(i) {
  const qty = i.qty || 0;
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
      : { rate: Math.max(0, i.tiie) + Math.max(0, i.costSpread), commission: 0, layer1: 0, layer2: 0, total: 0 };
  const financeUnit = fin.commission + fin.layer1;
  const marginUnitV =
    i.marginMode === "nominal" ? Math.max(0, i.marginNominal) : marginUnit({ mode: "pct", pct: Math.max(0, i.marginPct), nominal: 0 }, landedUnit, financeUnit);
  const priceUnit = landedUnit + financeUnit + marginUnitV;
  return {
    landedUnit,
    marginUnit: marginUnitV,
    commissionUnit: fin.commission,
    layer1Unit: fin.layer1,
    financeUnit,
    priceUnit,
    marginPct: priceUnit > 0 ? (marginUnitV / priceUnit) * 100 : 0,
    marginNominal: marginUnitV,
    landed: landedUnit * qty,
    margin: marginUnitV * qty,
    finance: financeUnit * qty,
    price: priceUnit * qty,
    rate: fin.rate,
  };
}
function financeUnit_ANTES(i) {
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
function ladderTerms(terms, agreed) {
  const all = new Set([0, ...terms.filter((t) => t >= 0)]);
  if (agreed > 0) all.add(agreed);
  return [...all].sort((a, b) => a - b);
}
function ladderFor_ANTES(i) {
  return ladderTerms(i.terms, i.agreed).map((days) => {
    const margin = days <= 0 ? i.marginCash : i.marginCredit;
    const finance = days <= 0 ? 0 : Math.max(0, i.financeAt(days));
    if (!marginValid(margin)) return { days, finance, price: null, utility: null, pct: null, agreed: days === i.agreed };
    const price = priceFromMargin({ landed: i.landed, finance, margin });
    const utility = round4(price - i.landed - finance);
    return { days, finance, price, utility, pct: price > 0 ? round4((utility / price) * 100) : null, agreed: days === i.agreed };
  });
}

// ---------------------------------------------------------------------------
// C. El motor de AHORA (copias literales de pricing.ts / ladder.ts, paso 3).
// ---------------------------------------------------------------------------
function linealDisbursedUnit(landed, margin) {
  return Math.max(0, landed) + marginUnit(margin, Math.max(0, landed), 0);
}
function linealFinanceUnit(i) {
  if (i.days <= 0) return 0;
  return round2((Math.max(0, i.disbursed) * Math.max(0, i.rate) * Math.max(0, i.days)) / YEAR_DAYS);
}
function linealPriceFromMargin(i) {
  const disbursed = round4(linealDisbursedUnit(i.landed, i.margin));
  const finance = linealFinanceUnit({ disbursed, rate: i.rate, days: i.days });
  return { disbursed, finance, price: round4(disbursed + finance) };
}
function linealMarginFromPrice(i) {
  const k = i.days > 0 ? (Math.max(0, i.rate) * i.days) / YEAR_DAYS : 0;
  const disbursed = round4(Math.max(0, i.price) / (1 + k));
  const nominal = round4(disbursed - Math.max(0, i.landed));
  const pct = disbursed > 0 ? round4((nominal / disbursed) * 100) : 0;
  return { mode: i.mode, pct, nominal, disbursed, finance: round4(Math.max(0, i.price) - disbursed) };
}
function creditFromCashLineal(i) {
  const cash = Math.max(0, i.cash);
  if (i.days <= 0) return cash;
  return round4(cash + linealFinanceUnit({ disbursed: cash, rate: i.rate, days: i.days }));
}
function priceSaleLineal(i) {
  const qty = i.qty || 0;
  const landedUnit = Math.max(0, i.cost) + Math.max(0, i.freight) + Math.max(0, i.other);
  const rate = Math.max(0, i.tiie) + Math.max(0, i.costSpread);
  const margin = i.marginMode === "nominal" ? { mode: "nominal", pct: 0, nominal: Math.max(0, i.marginNominal) } : { mode: "pct", pct: Math.max(0, i.marginPct), nominal: 0 };
  const marginUnitV = marginUnit(margin, landedUnit, 0);
  const disbursedUnit = i.days > 0 ? landedUnit + marginUnitV : 0;
  const financeUnit = linealFinanceUnit({ disbursed: landedUnit + marginUnitV, rate, days: i.days });
  const priceUnit = landedUnit + marginUnitV + financeUnit;
  const invoice = landedUnit + marginUnitV;
  return {
    landedUnit,
    marginUnit: marginUnitV,
    commissionUnit: 0,
    layer1Unit: financeUnit,
    financeUnit,
    priceUnit,
    marginPct: invoice > 0 ? (marginUnitV / invoice) * 100 : 0,
    marginNominal: marginUnitV,
    disbursedUnit,
    landed: landedUnit * qty,
    margin: marginUnitV * qty,
    finance: financeUnit * qty,
    price: priceUnit * qty,
    rate,
  };
}
function priceSale(i) {
  if (i.financingBase === "costo_margen") return priceSaleLineal(i);
  const r = priceSale_ANTES(i);
  return { ...r, disbursedUnit: i.days > 0 ? r.landedUnit * (1 + Math.max(0, i.commissionRate)) : 0 };
}
function ladderForLineal(i) {
  return ladderTerms(i.terms, i.agreed).map((days) => {
    const margin = days <= 0 ? i.marginCash : i.marginCredit;
    if (!marginValid(margin)) return { days, finance: 0, price: null, utility: null, pct: null, agreed: days === i.agreed };
    const disbursed = round4(i.landed + marginUnit(margin, i.landed, 0));
    const finance = days <= 0 ? 0 : linealFinanceUnit({ disbursed, rate: i.rateAt ? i.rateAt(days) : 0, days });
    const price = round4(disbursed + finance);
    const utility = round4(price - i.landed - finance);
    return { days, finance, price, utility, pct: disbursed > 0 ? round4((utility / disbursed) * 100) : null, agreed: days === i.agreed };
  });
}
function ladderFor(i) {
  if (i.financingBase === "costo_margen") return ladderForLineal(i);
  return ladderFor_ANTES(i);
}

test("las copias de pricing.ts / ladder.ts / margins.ts siguen iguales al original", () => {
  const p = sinComentarios(src("src/lib/erp/pricing.ts"));
  // El camino ASR de priceSale: mismas líneas de siempre, después del desvío al lineal.
  assert.ok(p.includes('if (i.financingBase === "costo_margen") return priceSaleLineal(i);'), "priceSale desvía al lineal solo con esa base");
  assert.ok(p.includes("const financeUnit = fin.commission + fin.layer1;"), "ASR: financiamiento = comisión + Capa 1");
  assert.ok(p.includes("const priceUnit = landedUnit + financeUnit + marginUnit;"), "ASR: precio = costo + financiamiento + margen");
  assert.ok(p.includes('marginUnitOf({ mode: "pct", pct: Math.max(0, i.marginPct), nominal: 0 }, landedUnit, financeUnit)'), "ASR: el % lleva el financiamiento en la base");
  assert.ok(p.includes("i.days > 0\n      ? financeCost({"), "ASR: financeCost, el de siempre");
  // Lineal.
  assert.ok(p.includes("return round2((Math.max(0, i.disbursed) * Math.max(0, i.rate) * Math.max(0, i.days)) / YEAR_DAYS);"), "linealFinanceUnit");
  assert.ok(p.includes("const disbursed = round4(Math.max(0, i.price) / (1 + k));"), "linealMarginFromPrice: precio ÷ (1 + k)");
  assert.ok(p.includes("const marginUnit = marginUnitOf(margin, landedUnit, 0);"), "lineal: el margen es sobre la factura, sin financiamiento en la base");
  assert.ok(p.includes("marginPct: invoice > 0 ? (marginUnit / invoice) * 100 : 0,"), "lineal: el % es sobre la factura a Santa Rosa");
  const l = sinComentarios(src("src/lib/erp/ladder.ts"));
  assert.ok(l.includes('if (i.financingBase === "costo_margen") return ladderForLineal(i);'), "ladderFor desvía al lineal solo con esa base");
  assert.ok(l.includes("const price = priceFromMargin({ landed: i.landed, finance, margin });"), "ASR: la escalera de siempre");
  assert.ok(l.includes("const disbursed = round4(i.landed + marginUnit(margin, i.landed, 0));"), "lineal: factura a Santa Rosa por columna");
  // credit.ts (financeCost) y margins.ts no cambiaron.
  const c = src("src/lib/erp/credit.ts");
  assert.ok(c.includes("const layer1 = round2((cost * (1 + Math.max(0, input.commissionRate)) * rate * Math.max(0, input.financialDays)) / YEAR_DAYS);"), "Capa 1 intacta (columna AN)");
  const m = src("src/lib/erp/margins.ts");
  assert.ok(m.includes("return (base * m.pct) / (100 - m.pct);") && m.includes("const base = landed + Math.max(0, finance);"), "marginUnit intacto");
});

// ---------------------------------------------------------------------------
// 1. IDENTIDAD: Circuito ASR antes = después, al centavo.
// ---------------------------------------------------------------------------
const MALLA = [];
for (const cost of [0, 1000, 10000, 14420, 100000, 137500, 98765.43]) {
  for (const freight of [0, 300, 3000, 4321]) {
    for (const days of [0, 30, 60, 90, 120, 150, 45]) {
      for (const tiie of [0.069, 0.10, 0.0706]) {
        for (const margin of [
          { marginMode: "pct", marginPct: 6.5, marginNominal: 0 },
          { marginMode: "pct", marginPct: 8, marginNominal: 0 },
          { marginMode: "pct", marginPct: 0, marginNominal: 0 },
          { marginMode: "nominal", marginPct: 0, marginNominal: 1500 },
          { marginMode: "nominal", marginPct: 0, marginNominal: 6951.87 },
        ]) {
          MALLA.push({ cost, freight, other: 0, days, tiie, costSpread: 0.04, commissionRate: 0.01, qty: 3, ...margin });
        }
      }
    }
  }
}

test("IDENTIDAD ASR: priceSale con base costo_comision = el motor de antes, campo por campo, en toda la malla", () => {
  assert.ok(MALLA.length > 2000, `malla de ${MALLA.length} casos`);
  for (const caso of MALLA) {
    const antes = priceSale_ANTES(caso);
    const ahora = priceSale({ ...caso, financingBase: "costo_comision" });
    for (const k of Object.keys(antes)) {
      assert.equal(ahora[k], antes[k], `${k} en ${JSON.stringify(caso)}`);
    }
  }
});

test("IDENTIDAD ASR: los cuatro casos del dueño y PV-0003 siguen dando lo mismo", () => {
  const CASO = { cost: 10000, freight: 0, other: 0, tiie: 0.069, costSpread: 0.04, commissionRate: 0.01, marginMode: "nominal", marginNominal: 0, marginPct: 0, qty: 1, financingBase: "costo_comision" };
  assert.equal(priceSale({ ...CASO, days: 0 }).financeUnit, 0);
  assert.equal(round2(priceSale({ ...CASO, days: 60 }).financeUnit), 283.48);
  assert.equal(round2(priceSale({ ...CASO, days: 90 }).financeUnit), 375.23);
  assert.equal(round2(priceSale({ ...CASO, days: 150 }).financeUnit), 558.71);
  // costo puesto 10,000, TIIE 6.9 %, 150 d, margen crédito 6.5 % → 11,292.74, utilidad 734.03.
  const p = priceSale({ ...CASO, days: 150, marginMode: "pct", marginPct: 6.5 });
  assert.equal(round2(p.priceUnit), 11292.74);
  assert.equal(round2(p.marginUnit), 734.03);
  // PV-0003: el flete financia; la diferencia sigue siendo 167.61.
  const con = financeUnit_ANTES({ cost: 140500, days: 150, tiie: 0.069, costSpread: 0.04, commissionRate: 0.01 });
  const sin = financeUnit_ANTES({ cost: 137500, days: 150, tiie: 0.069, costSpread: 0.04, commissionRate: 0.01 });
  assert.equal(round2(con - sin), 167.61);
  assert.equal(priceSale({ ...CASO, cost: 137500, freight: 3000, days: 150 }).financeUnit, con);
});

test("IDENTIDAD ASR: la escalera con base costo_comision = la de antes, columna por columna", () => {
  const terms = [0, 30, 60, 90, 120, 150];
  for (const landed of [10000, 14420, 140500]) {
    for (const agreed of [45, 90, 150]) {
      const finAt = (d) => financeUnit_ANTES({ cost: landed, days: d, tiie: 0.069, costSpread: 0.04, commissionRate: 0.01 });
      const args = { terms, agreed, landed, marginCash: { mode: "pct", pct: 5, nominal: 0 }, marginCredit: { mode: "pct", pct: 6.5, nominal: 0 }, financeAt: finAt };
      assert.deepEqual(ladderFor({ ...args, financingBase: "costo_comision" }), ladderFor_ANTES(args), `landed ${landed} agreed ${agreed}`);
      assert.deepEqual(ladderFor(args), ladderFor_ANTES(args), "sin base dicha, la escalera es la de siempre");
    }
  }
});

test("Contado no cambia: 0 días → financiamiento 0 y precio = costo + margen, en las dos bases", () => {
  for (const base of ["costo_comision", "costo_margen"]) {
    const p = priceSale({ cost: 14420, freight: 0, other: 0, days: 0, tiie: 0.069, costSpread: 0.04, commissionRate: 0.01, financingBase: base, marginMode: "pct", marginPct: 6.5, marginNominal: 0, qty: 1 });
    assert.equal(p.financeUnit, 0, base);
    assert.equal(p.commissionUnit, 0, base);
    assert.equal(round2(p.priceUnit), 15422.46, `${base}: 14,420 ÷ (1 − 0.065)`);
    assert.equal(p.disbursedUnit, 0, `${base}: al contado nadie desembolsa`);
  }
});

// ---------------------------------------------------------------------------
// 2. EL CAMINO LINEAL contra los números del diseño (DISENO § 5 recalculado).
// ---------------------------------------------------------------------------
const LINEAL = { cost: 100000, freight: 0, other: 0, days: 150, tiie: 0.0705, costSpread: 0.04, commissionRate: 0, financingBase: "costo_margen", qty: 1 };

test("lineal, margen 6.5 % sobre la factura: factura 106,951.87 · financiamiento 4,924.24 · precio al cliente 111,876.11", () => {
  const p = priceSale({ ...LINEAL, marginMode: "pct", marginPct: 6.5, marginNominal: 0 });
  assert.equal(round2(p.marginUnit), 6951.87, "margen = 6.5 % de la factura a Santa Rosa");
  assert.equal(round2(p.landedUnit + p.marginUnit), 106951.87, "factura de Azagro a Santa Rosa");
  assert.equal(round2(p.disbursedUnit), 106951.87, "lo que Santa Rosa desembolsa");
  assert.equal(p.financeUnit, 4924.24, "(7.05 % + 4.00 %) × 150 / 360 sobre 106,951.87");
  assert.equal(round2(p.priceUnit), 111876.11, "precio al cliente");
  assert.equal(p.commissionUnit, 0, "sin comisión de apertura (Decisión 6)");
  assert.equal(round4(p.marginPct), 6.5, "el % reportado es sobre la factura, no sobre el precio");
});

test("lineal, margen en monto fijo 6,951.87: mismos tres números (el motor ASR cobraba 320.08 de menos)", () => {
  const p = priceSale({ ...LINEAL, marginMode: "nominal", marginPct: 0, marginNominal: 6951.87 });
  assert.equal(round2(p.landedUnit + p.marginUnit), 106951.87);
  assert.equal(p.financeUnit, 4924.24);
  assert.equal(round2(p.priceUnit), 111876.11);
  // Lo que daba el motor ASR con ese margen fijo y la misma tasa de 11.05 %,
  // sin comisión: financia solo el costo → 4,604.17, precio 111,556.04.
  const asr = priceSale({ ...LINEAL, financingBase: "costo_comision", marginMode: "nominal", marginPct: 0, marginNominal: 6951.87 });
  assert.equal(asr.financeUnit, 4604.17);
  assert.equal(round2(asr.priceUnit), 111556.04);
  assert.equal(round2(p.priceUnit - asr.priceUnit), 320.07, "≈ 320.08 = margen × k (redondeo de centavo)");
});

test("lineal, captura inversa: del precio al cliente 111,876.11 se despeja la factura 106,951.87 y el margen 6.5 % / 6,951.87", () => {
  const inv = linealMarginFromPrice({ price: 111876.11, landed: 100000, rate: 0.1105, days: 150, mode: "pct" });
  assert.ok(Math.abs(inv.disbursed - 106951.87) < 0.01, `factura ${inv.disbursed}`);
  assert.ok(Math.abs(inv.nominal - 6951.87) < 0.01, `utilidad ${inv.nominal}`);
  assert.ok(Math.abs(inv.pct - 6.5) < 0.0001, `margen ${inv.pct} %`);
  assert.ok(Math.abs(inv.finance - 4924.24) < 0.01, `financiamiento ${inv.finance}`);
  // Ida y vuelta: precio → margen → precio.
  const back = linealPriceFromMargin({ landed: 100000, margin: { mode: "pct", pct: inv.pct, nominal: 0 }, rate: 0.1105, days: 150 });
  assert.ok(Math.abs(back.price - 111876.11) < 0.01, `de regreso ${back.price}`);
  // Y con el modo $ fijo.
  const back2 = linealPriceFromMargin({ landed: 100000, margin: { mode: "nominal", pct: 0, nominal: inv.nominal }, rate: 0.1105, days: 150 });
  assert.ok(Math.abs(back2.price - 111876.11) < 0.01, `de regreso ($) ${back2.price}`);
});

test("lineal, cotización directa: crédito = contado (costo + margen) × (1 + k)", () => {
  assert.equal(creditFromCashLineal({ cash: 106951.87, rate: 0.1105, days: 150 }), 111876.11);
  assert.equal(creditFromCashLineal({ cash: 106951.87, rate: 0.1105, days: 0 }), 106951.87, "contado: sin financiamiento");
});

test("lineal, escalera: la factura a Santa Rosa es la misma en todas las columnas; solo cambia lo que Santa Rosa le agrega al cliente", () => {
  const steps = ladderFor({
    terms: [0, 30, 60, 90, 120, 150],
    agreed: 150,
    landed: 100000,
    marginCash: { mode: "pct", pct: 6.5, nominal: 0 },
    marginCredit: { mode: "pct", pct: 6.5, nominal: 0 },
    financeAt: () => 0,
    financingBase: "costo_margen",
    rateAt: () => 0.1105,
  });
  const at = (d) => steps.find((s) => s.days === d);
  // La escalera trabaja a 4 decimales (igual que la de ASR); se compara a centavos.
  assert.equal(round2(at(0).price), 106951.87, "contado: costo + margen, sin financiar");
  assert.equal(at(150).finance, 4924.24);
  assert.equal(round2(at(150).price), 111876.11);
  assert.equal(round2(at(150).utility), 6951.87, "la utilidad de Azagro no depende del plazo");
  assert.equal(at(150).pct, 6.5, "el % es sobre la factura");
  for (const d of [30, 60, 90, 120]) assert.equal(round2(at(d).utility), 6951.87, `${d} d`);
  assert.equal(at(30).finance, round2((106951.87 * 0.1105 * 30) / 360));
});

// ---------------------------------------------------------------------------
// 3. Partición del P&L (copia de la lógica por partida de reports.ts).
// ---------------------------------------------------------------------------
function pnlLine(i) {
  const asr = i.financingBase === "costo_comision";
  const sale = i.qty * i.saleUnit;
  const landed = i.qty * i.costUnit;
  const fin = asr ? financeCost({ supplierCost: landed, saleCapital: sale, commissionRate: i.commissionRate, costSpread: i.costSpread, tiieAtIssue: i.tiie, financialDays: i.days, daysExceeded: 0 }) : { commission: 0, layer1: 0, layer2: 0, total: 0 };
  let disbursed = 0;
  if (!asr) disbursed = i.qty * (i.disbursedUnit ?? linealMarginFromPrice({ price: i.saleUnit, landed: i.costUnit, rate: i.tiie + i.costSpread, days: i.days, mode: "pct" }).disbursed);
  const financierFinance = !asr ? round2(sale - disbursed) : 0;
  const revenueLine = asr ? sale : disbursed;
  const margin = revenueLine - landed;
  return { sale, finance: fin.total, disbursed, financierFinance, revenueLine, margin };
}

test("P&L lineal: margen 6,951.87 para Azagro, financiamiento 4,924.24 para Santa Rosa — no los 320.08 mal atribuidos", () => {
  const l = pnlLine({ financingBase: "costo_margen", qty: 1, saleUnit: 111876.11, costUnit: 100000, disbursedUnit: 106951.87, commissionRate: 0, costSpread: 0.04, tiie: 0.0705, days: 150 });
  assert.equal(round2(l.margin), 6951.87);
  assert.equal(l.financierFinance, 4924.24);
  assert.equal(round2(l.revenueLine), 106951.87, "la venta de Azagro es la factura a Santa Rosa");
  assert.equal(l.finance, 0, "Azagro no paga financiamiento en el lineal");
  // Sin disbursed_unit guardado (partida anterior), se despeja del precio: mismo resultado.
  const l2 = pnlLine({ financingBase: "costo_margen", qty: 1, saleUnit: 111876.11, costUnit: 100000, disbursedUnit: null, commissionRate: 0, costSpread: 0.04, tiie: 0.0705, days: 150 });
  assert.ok(Math.abs(l2.margin - 6951.87) < 0.01);
  assert.ok(Math.abs(l2.financierFinance - 4924.24) < 0.01);
});

test("P&L ASR: idéntico al de antes — la partida con margen % sigue atribuyendo 7,271.95 a Azagro y 4,604.17 al circuito", () => {
  // Mismo caso (costo 100,000, 6.5 %, 11.05 % sin comisión) por ASR: precio
  // 111,876.11 pero la partición es la del motor ASR (ESTADO § 3.d).
  const l = pnlLine({ financingBase: "costo_comision", qty: 1, saleUnit: 111876.11, costUnit: 100000, disbursedUnit: null, commissionRate: 0, costSpread: 0.04, tiie: 0.0705, days: 150 });
  assert.equal(round2(l.margin), 11876.11, "margen bruto = venta − costo (como siempre)");
  assert.equal(l.finance, 4604.17, "comisión + Capa 1 sobre el costo (como siempre)");
  assert.equal(round2(l.margin - l.finance), 7271.94, "utilidad neta ASR ≈ 7,271.95");
  assert.equal(l.disbursed, 0);
  assert.equal(l.financierFinance, 0);
});

// ---------------------------------------------------------------------------
// 4. Cableado: el motor recibe el circuito; la comisión se congela; Ajustes
//    ya no la tiene; contado y línea propia como estaban.
// ---------------------------------------------------------------------------
test("cableado: ni pricing.ts, ni margins.ts, ni ladder.ts leen el catálogo — reciben comisión y base por parámetro", () => {
  for (const f of ["src/lib/erp/pricing.ts", "src/lib/erp/margins.ts", "src/lib/erp/ladder.ts"]) {
    const body = src(f);
    for (const palabra of ["credit_circuits", "funding_rates", "erp/circuits", "./circuits", "getSql", "createServerFn"]) {
      assert.ok(!body.includes(palabra), `${f}: sin ${palabra}`);
    }
  }
  assert.ok(src("src/lib/erp/pricing.ts").includes("financingBase: FinancingBase;"), "priceSale exige la base: nadie decide por omisión");
  assert.ok(src("src/lib/erp/ladder.ts").includes("financingBase?: FinancingBase;"), "la escalera recibe la base");
});

test("cableado: la comisión se CONGELA en la cotización y los caminos que reprecian la leen de ahí (cierra ESTADO § 6)", () => {
  const ops = src("src/lib/erp/ops.ts");
  const orders = src("src/lib/erp/orders.ts");
  const req = src("src/lib/erp/requests.ts");
  // Se escribe al cotizar (los dos altas).
  assert.ok(/insert into quotes \([^)]*commission_rate, cost_rate, collection_rate\)/.test(ops), "createQuote congela comisión y las dos tasas");
  assert.ok(/insert into quotes \([^)]*commission_rate, cost_rate, collection_rate\)/.test(req), "quoteFromRequest congela comisión y las dos tasas");
  // Se lee de la cotización al repreciar, nunca de Ajustes.
  assert.ok(ops.includes("const frozenCommission = Number(q[0].commission_rate);"), "reviseQuote: comisión congelada");
  assert.ok(orders.includes("const frozenCommission = Number(q[0].commission_rate);"), "changeOrderTerm: comisión congelada");
  assert.ok(ops.includes("commission_rate::text as q_commission"), "listQuotes: la escalera y el derivado usan la congelada");
  for (const f of ["src/lib/erp/ops.ts", "src/lib/erp/orders.ts", "src/lib/erp/requests.ts", "src/lib/azagro.ts", "src/lib/erp/reports.ts", "src/routes/solicitudes.$solicitudId.tsx", "src/routes/quotes.tsx", "src/routes/settings.tsx"]) {
    assert.ok(!src(f).includes("pol.asrCommission") && !src(f).includes("s.asrCommission"), `${f}: ya no existe pol.asrCommission`);
  }
  // Sin comisión congelada no se inventa: se detiene.
  assert.ok(ops.includes("sin comisión congelada en la cotización (migración 0026 pendiente)"), "reviseQuote se detiene sin comisión congelada");
  assert.ok(orders.includes("sin comisión congelada en la cotización (migración 0026 pendiente)"), "changeOrderTerm se detiene sin comisión congelada");
});

test("cableado: disbursed_unit se escribe por partida en las tres altas/revisiones; la migración 0026 agrega las columnas", () => {
  const ops = src("src/lib/erp/ops.ts");
  const req = src("src/lib/erp/requests.ts");
  assert.ok(/insert into quote_lines \([^)]*finance_unit, disbursed_unit\)/.test(ops), "createQuote");
  assert.ok(/insert into quote_lines \([^)]*finance_unit, disbursed_unit\)/.test(req), "quoteFromRequest");
  assert.ok(ops.includes("disbursed_unit = ${m.disbursed}"), "reviseQuote");
  const sql = src("migrations/0026_motor_por_circuito.sql").replace(/--[^\n]*/g, "");
  for (const col of ["quotes add column if not exists commission_rate", "quotes add column if not exists cost_rate", "quotes add column if not exists collection_rate", "quote_lines add column if not exists disbursed_unit"]) {
    assert.ok(sql.includes(col), col);
  }
  assert.ok(sql.includes("alter table company_settings drop column if exists asr_commission;"), "\"Comisión ASR\" sale de Ajustes");
  assert.ok(sql.includes("set commission_rate = 0\nwhere code = 'SANTA_ROSA' and commission_rate is null;"), "Santa Rosa: 0 escrito, no \"sin capturar\"");
});

test("cableado: \"Comisión ASR\" desapareció de Ajustes y vive solo en el catálogo, con captura de administrador y bitácora", () => {
  const ops = src("src/lib/erp/ops.ts");
  assert.ok(!ops.includes('["asrCommission", "comisión ASR"]'), "ya no es un renglón de la política");
  assert.ok(!ops.includes("asr_commission::text"), "readPolicy no lo lee");
  assert.ok(ops.includes("drop column if exists asr_commission"), "la columna se tira");
  const st = src("src/routes/settings.tsx");
  assert.ok(!st.includes("Comisión ASR (en precio"), "el campo se quitó de la pantalla");
  assert.ok(st.includes('onSaveCommission("ASR")'), "se captura en el renglón del circuito");
  const c = src("src/lib/erp/circuits.ts");
  const fn = c.slice(c.indexOf("export const saveCircuitCommission"), c.length);
  assert.ok(fn.includes("await assertAdmin(sql, context.userId);"), "solo administrador");
  assert.ok(fn.includes('action: "circuito"') && fn.includes("→"), "bitácora anterior → nuevo");
  // El motor se detiene si no está capturada: no inventa un 1 %.
  assert.ok(c.includes("sin comisión de apertura capturada. Captúrala en Ajustes → Circuitos de financiamiento"), "circuitTerms se detiene sin comisión");
});

test("cableado: la tabla de tasas tiene pantalla de captura (dos columnas, cobro precargada = costo, solo admin, bitácora)", () => {
  const c = src("src/lib/erp/circuits.ts");
  const fn = c.slice(c.indexOf("export const saveFundingRate"), c.indexOf("export const saveCircuitCommission"));
  assert.ok(fn.includes("await assertAdmin(sql, context.userId);"), "solo administrador");
  assert.ok(fn.includes('action: "tasas"') && fn.includes("→ costo ${data.costRate} / cobro ${data.collectionRate}"), "bitácora anterior → nuevo, las dos columnas");
  assert.ok(fn.includes("La tasa de cobro no puede ser menor que la tasa de costo"), "la protección no puede ser negativa");
  const st = src("src/routes/settings.tsx");
  assert.ok(st.includes("if (!frCollTouched) setFrColl(v);"), "la de cobro se precarga igual a la de costo hasta que alguien la toque");
  assert.ok(st.includes("collectionRate: frColl ?? frCost"), "y si nadie la tocó, se guarda igual a la de costo");
  assert.ok(st.includes("Solo un administrador puede capturar las tasas."), "los demás solo ven");
  // La tasa que entra al precio del lineal es la de cobro; la de costo queda para el reporte.
  assert.ok(c.includes("return pick ? { rate: pick.collectionRate, date: pick.date, costRate: pick.costRate, collectionRate: pick.collectionRate, source: \"tasas\" } : null;"), "priceRateFor: lineal = tasa de cobro");
});

test("cableado: Línea propia sigue apagada y el selector sigue ofreciendo solo Contado y Circuito ASR", () => {
  const c = src("src/lib/erp/circuits.ts");
  assert.ok(c.includes('export const SELECTABLE_CIRCUITS: CircuitCode[] = ["CONTADO", "ASR"];'), "Santa Rosa se enciende en el paso 5, no aquí");
  assert.ok(c.includes('circuito por construir, todavía no financia'), "un circuito sin base (Línea propia) se detiene");
});

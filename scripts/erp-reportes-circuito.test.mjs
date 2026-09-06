// PASO 4 del catálogo de circuitos (5-sep-2026): LOS REPORTES LEEN EL CIRCUITO.
//
//   1. IDENTIDAD. La utilidad de todo pedido que corre por el Circuito ASR es
//      la misma que antes del paso 4, número por número. Aquí vive una copia
//      CONGELADA de la lógica por partida y de los totales del P&L tal como
//      estaban (commit 64f0dd0) y se compara contra la copia literal de la de
//      ahora en una malla de casos. Si un solo número cambia, hay que parar.
//   2. LA PROTECCIÓN SE VE POR SEPARADO (razón de ser de las dos tasas,
//      Decisión 1). Lineal, DISENO § 5: financiamiento de Santa Rosa 4,924.24
//      = costo real de la línea 4,857.40 (tasa de costo 6.90 % + spread 4.00 %)
//      + protección 66.84 (0.15 puntos). ASR: una sola tasa → protección 0.
//   3. Cableado: el P&L usa comisión y base congeladas en la factura (y si
//      no, en la cotización), nunca Ajustes; la tarjeta dice la base según el
//      circuito; el Panorama y la lista por pedido heredan lo mismo.
//
// NO entra el reparto 50/50 de la mora con Santa Rosa: necesita la factura
// de Azagro a Santa Rosa y el cobro reportado (Fase 3). Aquí se vigila que
// no se haya construido nada de eso por cuenta propia.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

const YEAR_DAYS = 360;
const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;

// Copias literales (credit.ts / pricing.ts), sin cambios en el paso 4.
function financeCost(input) {
  const cost = Math.max(0, input.supplierCost);
  const rate = input.tiieAtIssue + input.costSpread;
  const commission = round2(cost * Math.max(0, input.commissionRate));
  const layer1 = round2((cost * (1 + Math.max(0, input.commissionRate)) * rate * Math.max(0, input.financialDays)) / YEAR_DAYS);
  const layer2 = round2((Math.max(0, input.saleCapital) * rate * Math.max(0, input.daysExceeded)) / YEAR_DAYS);
  return { rate, commission, layer1, layer2, total: round2(commission + layer1 + layer2) };
}
function linealMarginFromPrice(i) {
  const k = i.days > 0 ? (Math.max(0, i.rate) * i.days) / YEAR_DAYS : 0;
  const disbursed = round4(Math.max(0, i.price) / (1 + k));
  const nominal = round4(disbursed - Math.max(0, i.landed));
  const pct = disbursed > 0 ? round4((nominal / disbursed) * 100) : 0;
  return { mode: i.mode, pct, nominal, disbursed, finance: round4(Math.max(0, i.price) - disbursed) };
}

// ---------------------------------------------------------------------------
// A. La partida del P&L ANTES del paso 4 (commit 64f0dd0), congelada.
// ---------------------------------------------------------------------------
function pnlLine_ANTES(i) {
  const asr = i.financingBase === "costo_comision";
  const sale = i.qty * i.saleUnit;
  const cogs = i.qty * i.costUnit;
  const freight = i.qty * i.freightUnit;
  const other = i.qty * i.otherUnit;
  const landed = cogs + freight + other;
  const fin =
    asr && i.tiie != null && (i.days > 0 || i.daysExceeded > 0)
      ? financeCost({ supplierCost: i.days > 0 ? landed : 0, saleCapital: sale, commissionRate: i.commissionRate ?? 0, costSpread: i.costSpread, tiieAtIssue: i.tiie, financialDays: Math.max(0, i.days), daysExceeded: i.daysExceeded })
      : { commission: 0, layer1: 0, layer2: 0, total: 0 };
  const finance = fin.total;
  let disbursed = 0;
  if (!asr) {
    const perUnit = i.disbursedUnit != null ? i.disbursedUnit : i.days > 0 && i.tiie != null ? linealMarginFromPrice({ price: i.saleUnit, landed: i.costUnit + i.freightUnit + i.otherUnit, rate: i.tiie + i.costSpread, days: i.days, mode: "pct" }).disbursed : i.saleUnit;
    disbursed = i.qty * perUnit;
  }
  const financierFinance = !asr ? round2(sale - disbursed) : 0;
  const revenueLine = asr ? sale : disbursed;
  const margin = revenueLine - cogs - freight - other;
  return { sale, cogs, freight, other, landed, finance, commission: fin.commission, layer1: fin.layer1, layer2: fin.layer2, disbursed, financierFinance, revenueLine, margin };
}

// ---------------------------------------------------------------------------
// B. La partida del P&L de AHORA (copia literal de reports.ts, paso 4): lo
//    mismo más costo real de la línea y protección.
// ---------------------------------------------------------------------------
function pnlLine(i) {
  const antes = pnlLine_ANTES(i);
  const asr = i.financingBase === "costo_comision";
  let lineCost = asr ? antes.finance : null;
  let protection = asr ? 0 : null;
  if (!asr && i.days > 0 && i.costRate != null) {
    lineCost = Math.round(((antes.disbursed * (i.costRate + i.costSpread) * i.days) / YEAR_DAYS) * 100) / 100;
    protection = Math.round((antes.financierFinance - lineCost) * 100) / 100;
  } else if (!asr && i.days <= 0) {
    lineCost = 0;
    protection = 0;
  }
  return { ...antes, lineCost, protection };
}
// Totales (sin cambios en el paso 4; se copian para fijarlos).
function totals(lines, extra) {
  const revenue = lines.reduce((s, l) => s + l.revenueLine, 0);
  const cogs = lines.reduce((s, l) => s + l.cogs, 0);
  const freight = lines.reduce((s, l) => s + l.freight, 0) + extra.expPedido;
  const other = lines.reduce((s, l) => s + l.other, 0);
  const finance = lines.reduce((s, l) => s + l.commission + l.layer1 + l.layer2, 0);
  const margin = revenue - cogs - freight - other - extra.expOther;
  const netProfit = margin + extra.mora + extra.fxIncome - finance - extra.discount;
  return { revenue, cogs, freight, finance, margin, netProfit };
}

test("las copias siguen iguales al original (reports.ts, paso 4)", () => {
  const r = src("src/lib/erp/reports.ts");
  assert.ok(r.includes("lineCost = Math.round(((disbursed * (costRate + costSpread) * financialDays) / YEAR_DAYS) * 100) / 100;"), "costo real de la línea: lo desembolsado × (tasa de costo + spread) × días / 360");
  assert.ok(r.includes("protection = Math.round((financierFinance - lineCost) * 100) / 100;"), "protección = cobrado al cliente − costo real");
  assert.ok(r.includes("let lineCost: number | null = asr ? finance : null;") && r.includes("let protection: number | null = asr ? 0 : null;"), "ASR: costo real = costo financiero, protección 0");
  assert.ok(r.includes("const financierFinance = !asr && !excluded ? Math.round((sale - disbursed) * 100) / 100 : 0;"), "financiamiento de Santa Rosa (sin cambio)");
  assert.ok(r.includes("const margin = excluded ? 0 : revenueLine - cogs - freight - other;"), "margen por partida (sin cambio)");
  assert.ok(r.includes("const netProfit = margin + mora + fxIncome - finance - discount;"), "utilidad final (sin cambio)");
  assert.ok(r.includes("const finance = commission + layer1 + layer2;"), "costo financiero = comisión + Capa 1 + Capa 2 (sin cambio)");
});

// ---------------------------------------------------------------------------
// 1. IDENTIDAD ASR.
// ---------------------------------------------------------------------------
const MALLA = [];
for (const saleUnit of [143.75, 11292.74, 1189.05, 15422.46]) {
  for (const costUnit of [100, 10000, 1000, 14420]) {
    for (const freightUnit of [0, 10, 30]) {
      for (const days of [0, 60, 90, 150]) {
        for (const tiie of [0.069, 0.10, null]) {
          for (const daysExceeded of [0, 30]) {
            MALLA.push({ financingBase: "costo_comision", qty: 3, saleUnit, costUnit, freightUnit, otherUnit: 0, days, tiie, costSpread: 0.04, commissionRate: 0.01, daysExceeded, disbursedUnit: null, costRate: null });
          }
        }
      }
    }
  }
}

test("IDENTIDAD ASR: la partida del P&L da lo mismo que antes del paso 4, campo por campo, en toda la malla", () => {
  assert.ok(MALLA.length > 1000, `malla de ${MALLA.length} casos`);
  for (const caso of MALLA) {
    const antes = pnlLine_ANTES(caso);
    const ahora = pnlLine(caso);
    for (const k of Object.keys(antes)) assert.equal(ahora[k], antes[k], `${k} en ${JSON.stringify(caso)}`);
    assert.equal(ahora.lineCost, antes.finance, "ASR: el costo real ES el costo financiero de siempre");
    assert.equal(ahora.protection, 0, "ASR: protección 0, no estorba");
  }
});

test("IDENTIDAD ASR: totales y utilidad final de un pedido con mora, TC y pronto pago, iguales que antes", () => {
  const lines = [
    { financingBase: "costo_comision", qty: 10, saleUnit: 143.75, costUnit: 100, freightUnit: 10, otherUnit: 0, days: 90, tiie: 0.0706, costSpread: 0.04, commissionRate: 0.01, daysExceeded: 12, disbursedUnit: null, costRate: null },
    { financingBase: "costo_comision", qty: 5, saleUnit: 1189.05, costUnit: 1000, freightUnit: 0, otherUnit: 0, days: 90, tiie: 0.0706, costSpread: 0.04, commissionRate: 0.01, daysExceeded: 12, disbursedUnit: null, costRate: null },
  ];
  const extra = { expPedido: 300, expOther: 120, mora: 250.5, fxIncome: -80.25, discount: 33.1 };
  const antes = totals(lines.map(pnlLine_ANTES), extra);
  const ahora = totals(lines.map(pnlLine), extra);
  assert.deepEqual(ahora, antes);
  // PV-0003 (costo puesto 140,500 a 150 d): el costo financiero sigue siendo comisión + Capa 1 sobre el costo puesto.
  const pv3 = pnlLine({ financingBase: "costo_comision", qty: 1, saleUnit: 160000, costUnit: 137500, freightUnit: 3000, otherUnit: 0, days: 150, tiie: 0.069, costSpread: 0.04, commissionRate: 0.01, daysExceeded: 0, disbursedUnit: null, costRate: null });
  assert.equal(pv3.finance, financeCost({ supplierCost: 140500, saleCapital: 0, commissionRate: 0.01, costSpread: 0.04, tiieAtIssue: 0.069, financialDays: 150, daysExceeded: 0 }).total);
  assert.equal(pv3.lineCost, pv3.finance);
  assert.equal(pv3.protection, 0);
});

// ---------------------------------------------------------------------------
// 2. LINEAL: la protección por separado, contra DISENO § 5.
// ---------------------------------------------------------------------------
const LINEAL = { financingBase: "costo_margen", qty: 1, saleUnit: 111876.11, costUnit: 100000, freightUnit: 0, otherUnit: 0, days: 150, tiie: 0.0705, costSpread: 0.04, commissionRate: 0, daysExceeded: 0, disbursedUnit: 106951.87, costRate: 0.069 };

test("lineal: financiamiento de Santa Rosa 4,924.24 = costo real de la línea 4,857.40 + protección 66.84", () => {
  const l = pnlLine(LINEAL);
  assert.equal(l.financierFinance, 4924.24);
  assert.equal(l.lineCost, 4857.4, "106,951.87 × (6.90 % + 4.00 %) × 150 / 360");
  assert.equal(l.protection, 66.84, "0.15 puntos × 150 / 360 sobre 106,951.87");
  assert.equal(round2(l.margin), 6951.87, "el margen de Azagro no se toca");
  assert.equal(l.finance, 0, "Azagro no paga financiamiento en el lineal");
  assert.equal(round2(l.revenueLine), 106951.87);
});

test("lineal: tasa de costo = tasa de cobro → protección exactamente 0 y no estorba", () => {
  const l = pnlLine({ ...LINEAL, costRate: 0.0705 });
  assert.equal(l.lineCost, 4924.24);
  assert.equal(l.protection, 0);
});

test("lineal: sin tasa de costo congelada la protección NO se estima (null), y de contado es 0", () => {
  const sinTasa = pnlLine({ ...LINEAL, costRate: null });
  assert.equal(sinTasa.lineCost, null);
  assert.equal(sinTasa.protection, null);
  assert.equal(sinTasa.financierFinance, 4924.24, "lo cobrado al cliente sí se sabe");
  const contado = pnlLine({ ...LINEAL, days: 0, saleUnit: 106951.87, disbursedUnit: null, costRate: null });
  assert.equal(contado.lineCost, 0);
  assert.equal(contado.protection, 0);
  assert.equal(contado.financierFinance, 0);
});

// ---------------------------------------------------------------------------
// 3. Cableado.
// ---------------------------------------------------------------------------
test("cableado: el P&L usa comisión, base y las dos tasas congeladas en la factura; si no, en la cotización; nunca Ajustes", () => {
  const r = src("src/lib/erp/reports.ts");
  assert.ok(r.includes("snap.commissionRate ?? (so[0].q_commission != null ? Number(so[0].q_commission) : null)"), "comisión: foto → cotización → (catálogo solo si hace falta)");
  assert.ok(r.includes("const financingBase: FinancingBase = snap.financingBase ??"), "base: foto primero");
  assert.ok(r.includes("const costRate = snap.costRate ?? (so[0].q_cost_rate != null ? Number(so[0].q_cost_rate) : null);"), "tasa de costo: foto → cotización, sin respaldo");
  assert.ok(r.includes("const collectionRate = snap.collectionRate ?? (so[0].q_collection_rate != null ? Number(so[0].q_collection_rate) : null);"), "tasa de cobro: foto → cotización, sin respaldo");
  assert.ok(!r.includes("pol.asrCommission"), "ninguna comisión de Ajustes");
  assert.ok(!/costRate\s*\?\?\s*[\d.]/.test(r) && !/collectionRate\s*\?\?\s*[\d.]/.test(r), "sin números de respaldo para las tasas");
  // Los totales propagan el "sin dato": no se inventa una protección cero por una partida sin tasa.
  assert.ok(r.includes("const protectionKnown = included.every((l) => l.lineCost != null && l.protection != null);"), "total de protección solo si todas las partidas la tienen");
  const lista = r.slice(r.indexOf("export const listDealPnl"), r.indexOf("export const getCompanyPnl"));
  for (const campo of ["circuit: d.circuit", "financingBase: d.financingBase", "financierFinance: d.financierFinance", "lineCost: d.lineCost", "protection: d.protection"]) {
    assert.ok(lista.includes(campo), `la lista por pedido hereda ${campo}`);
  }
  assert.ok(lista.includes("lineCost: s.lineCost == null || d.lineCost == null ? null : s.lineCost + d.lineCost"), "el total de la lista propaga el sin dato");
  const pano = r.slice(r.indexOf("export const getPanorama"), r.indexOf("export const getUpcomingDue"));
  assert.ok(pano.includes("r.financiamientoSR += d.financierFinance;") && pano.includes("r.proteccion = r.proteccion == null || d.protection == null ? null : r.proteccion + d.protection;"), "el Panorama hereda financiamiento de Santa Rosa y protección por razón social");
  assert.ok(pano.includes("proteccion: porRazon.some((r) => r.proteccion == null) ? null : sum((r) => r.proteccion ?? 0),"), "…y en el total del grupo");
});

test("cableado: la tarjeta del pedido dice la base según el circuito y desglosa costo real + protección", () => {
  const ficha = src("src/routes/sales.$orderId.tsx");
  assert.ok(ficha.includes("Base: el costo puesto ${money(pnl.financeBase)} (mercancía + flete) × (1 + comisión del circuito), la misma que el precio."), "ASR: costo puesto × (1 + comisión)");
  assert.ok(ficha.includes("Una sola tasa (TIIE ${pctDe(pnl.tiieIssue)} + spread ${pctDe(pnl.spread)}): el costo real es este mismo, protección ${money(0)}."), "ASR: una sola tasa, protección 0");
  assert.ok(ficha.includes("Base: la factura de Azagro a Santa Rosa ${money(pnl.disbursed)} (costo + margen)"), "lineal: la factura a Santa Rosa");
  assert.ok(ficha.includes("Desglose: costo real de la línea ${money(pnl.lineCost)} (tasa de costo ${pctDe(pnl.costRate)} + spread ${pctDe(pnl.spread)}) + protección ${money(pnl.protection)}"), "lineal: costo real + protección, con sus tasas");
  assert.ok(ficha.includes('"Sin tasa de costo congelada: la protección no se estima."'), "sin tasa de costo no se inventa");
});

test("cableado: el Panorama y la lista por pedido muestran la protección por separado — solo cuando hay algo que mostrar", () => {
  const p = src("src/routes/reportes.tsx");
  assert.ok(p.includes("const conLineal = Boolean(pano && (pano.totales.financiamientoSR !== 0 || pano.totales.proteccion == null || pano.totales.proteccion !== 0));"), "columnas del Panorama solo si algún pedido corrió por la línea (por ASR sería una columna de ceros)");
  assert.ok(p.includes('{conLineal ? <th className="px-3 py-3 text-right font-medium">Protección</th> : null}'), "Panorama: columna Protección");
  assert.ok(p.includes('{conLineal ? <th className="px-3 py-3 text-right font-medium">Financ. S. Rosa</th> : null}'), "Panorama: columna de financiamiento de Santa Rosa");
  assert.ok(p.includes("Santa Rosa · costo real {d.lineCost == null ? \"sin dato\" : money(d.lineCost)} · protección {d.protection == null ? \"sin dato\" : money(d.protection)}"), "lista por pedido: desglose en la celda de costo financiero del lineal");
  assert.ok(p.includes("{circuitLabel(d.circuit)}"), "lista por pedido: el circuito bajo el folio");
  assert.ok(p.includes('"Circuito", "Venta", "Costo", "Flete", "Costo financiero", "Financ. Santa Rosa", "Costo real línea", "Protección"'), "el CSV lleva circuito, financiamiento de Santa Rosa, costo real y protección");
  assert.ok(p.includes("Sin pedidos en el periodo."), "lo demás sigue igual");
});

test("no se construyó el reparto de la mora (Fase 3): ni 50/50, ni reparto, ni factura a Santa Rosa", () => {
  const r = src("src/lib/erp/reports.ts");
  const p = src("src/routes/reportes.tsx");
  for (const palabra of ["mora_share", "moraShare", "reparto", "50/50", "espejo", "instrucción de facturación"]) {
    assert.ok(!r.includes(palabra) && !p.includes(palabra), `sin ${palabra} en reportes`);
  }
  assert.ok(r.includes("mora = Number(mi[0]?.a ?? 0);"), "la mora del P&L sigue siendo la que Azagro facturó (FI), sin repartir");
});

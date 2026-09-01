import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

/**
 * Copia de src/lib/erp/credit.ts (fxPaymentSplit) — si cambia el motor,
 * actualiza aquí y piensa por qué. Casos de la hoja AJUSTE_TC del Excel,
 * con números inventados.
 */
const round2 = (n) => Math.round(n * 100) / 100;
function fxPaymentSplit(input) {
  if (input.fxPaid <= 0 || input.fxAgreed <= 0) throw new Error("Tipo de cambio inválido");
  const residualUsd = input.residualMxn / input.fxAgreed;
  const usdPaid = input.depositedMxn / input.fxPaid;
  const usdApplied = Math.min(usdPaid, residualUsd);
  const appliedMxn = round2(usdApplied * input.fxAgreed);
  const bankMxn = round2(usdApplied * input.fxPaid);
  return { usdApplied: round2(usdApplied), appliedMxn, bankMxn, diff: round2(bankMxn - appliedMxn) };
}

// ---------------------------------------------------------------------------
// 1) Tipo de cambio del pago
// ---------------------------------------------------------------------------
test("pagó de menos: 10,000 USD pactados a 19.00, deposita 186,000 a TC 18.60 → POR COBRAR 4,000", () => {
  const s = fxPaymentSplit({ depositedMxn: 186000, fxPaid: 18.6, fxAgreed: 19.0, residualMxn: 190000 });
  assert.equal(s.usdApplied, 10000);
  assert.equal(s.appliedMxn, 190000); // la factura se aplica al TC pactado y queda saldada
  assert.equal(s.bankMxn, 186000); // el banco registra los pesos reales
  assert.equal(s.diff, -4000); // negativo = pagaron de menos → POR COBRAR 4,000
});

test("pagó de más: deposita 194,000 a TC 19.40 → POR DEVOLVER 4,000", () => {
  const s = fxPaymentSplit({ depositedMxn: 194000, fxPaid: 19.4, fxAgreed: 19.0, residualMxn: 190000 });
  assert.equal(s.usdApplied, 10000);
  assert.equal(s.appliedMxn, 190000);
  assert.equal(s.diff, 4000); // positivo = pagaron de más → POR DEVOLVER
});

test("pago parcial en dólares: deposita 93,000 a TC 18.60 → aplica 95,000 al pactado, diferencial −2,000", () => {
  const s = fxPaymentSplit({ depositedMxn: 93000, fxPaid: 18.6, fxAgreed: 19.0, residualMxn: 190000 });
  assert.equal(s.usdApplied, 5000);
  assert.equal(s.appliedMxn, 95000);
  assert.equal(s.bankMxn, 93000);
  assert.equal(s.diff, -2000);
});

test("cableado: el cobro exige TC en facturas USD y decide utilidad o ajuste, con documento y bitácora", () => {
  const ops = src("src/lib/erp/ops.ts");
  const helper = ops.slice(ops.indexOf("export async function applyInvoicePayment"), ops.indexOf("export const addBankMove"));
  assert.ok(helper.includes("captura el tipo de cambio del pago"), "factura USD sin TC debe rechazarse");
  assert.ok(helper.includes("fxPaymentSplit({"), "el cobro USD separa pesos reales vs pesos al pactado");
  assert.ok(helper.includes(`opts.fxTreatment ?? "utilidad"`), "la decisión es por cobro (utilidad por omisión)");
  assert.ok(helper.includes("ATC-"), "el ajuste genera documento ATC (por cobrar / por devolver)");
  assert.ok(helper.includes("fx_result = fx_result +"), "la opción utilidad acumula el diferencial en la factura");
  assert.ok(helper.includes(`"ajuste-tc"`) && helper.includes(`"diferencial-tc"`), "ambas decisiones dejan bitácora");
  // El banco registra pesos reales; la factura, pesos al pactado.
  assert.ok(helper.includes("const signed = inv[0].kind === \"customer\" ? bankAmount : -bankAmount"), "el banco lleva los pesos reales");
  // Los ajustes de TC no generan mora.
  assert.ok(ops.includes(`inv[0].inv_class !== "product"`), "solo documentos de producto generan mora");
});

// ---------------------------------------------------------------------------
// 2) Las cuatro visiones de utilidad (hoja PANORAMA)
// ---------------------------------------------------------------------------
test("visiones: utilidad 12,179.33 con mora pendiente 8,096 y factura pagada 60%", () => {
  const netProfit = 12179.33;
  const moraPendiente = 8096;
  const paidRatio = 0.6;
  const fullyPaid = false;
  const devengada = netProfit;
  const realizada = netProfit - moraPendiente;
  const caja = fullyPaid ? realizada : 0;
  const proporcional = round2(netProfit * paidRatio);
  assert.equal(devengada, 12179.33);
  assert.equal(round2(realizada), 4083.33);
  assert.equal(caja, 0); // no está 100% cobrada
  assert.equal(proporcional, 7307.6);
});

test("visiones: misma operación ya liquidada y con la mora cobrada → todo converge", () => {
  const netProfit = 12179.33;
  const moraPendiente = 0;
  const realizada = netProfit - moraPendiente;
  const caja = realizada; // fullyPaid
  const proporcional = netProfit * 1;
  assert.equal(realizada, 12179.33);
  assert.equal(caja, 12179.33);
  assert.equal(proporcional, 12179.33);
});

test("cableado: computeDealPnl calcula las cuatro visiones y usa el fx decidido como utilidad", () => {
  const rep = src("src/lib/erp/reports.ts");
  assert.ok(rep.includes("const utilidadDevengada = netProfit"), "devengada");
  assert.ok(rep.includes("const utilidadRealizada = netProfit - moraPendiente"), "realizada = devengada − mora pendiente");
  assert.ok(rep.includes("const utilidadCaja = fullyPaid ? utilidadRealizada : 0"), "en caja solo con factura liquidada");
  assert.ok(rep.includes("const utilidadProporcional = netProfit * paidRatio"), "proporcional según % pagado");
  assert.ok(rep.includes("Number(fv[0].fx_result)"), "el diferencial decidido como utilidad entra al P&L");
});

// ---------------------------------------------------------------------------
// 3) Saldos por vencer por mes y 4) Panorama por razón social
// ---------------------------------------------------------------------------
test("cableado: por vencer por mes usa el plazo financiero y proyecta interés sobre el cargo", () => {
  const rep = src("src/lib/erp/reports.ts");
  const fn = rep.slice(rep.indexOf("export const getUpcomingDue"));
  assert.ok(fn.includes("inv.credit_due || inv.due_date"), "agrupa por el plazo financiero (día 150)");
  assert.ok(fn.includes("Number(inv.amount) * rate * 30) / 360"), "interés mensual proyectado sobre el CARGO");
  assert.ok(fn.includes(`assertCan(sql, context.userId, "credit", "view")`), "requiere permiso de cartera");
});

test("cableado: el Panorama exige permiso de márgenes y arma cobranza + ajustes TC", () => {
  const rep = src("src/lib/erp/reports.ts");
  const fn = rep.slice(rep.indexOf("export const getPanorama"), rep.indexOf("export const getUpcomingDue"));
  assert.ok(fn.includes("canSeeMargins(me.role)"), "márgenes solo para quien tiene permiso");
  assert.ok(fn.includes("granTotalPorCobrar: capitalPendiente + moraPend + fxPorCobrar"), "gran total = capital + mora + ajustes TC");
  assert.ok(fn.includes("group_name"), "conserva el grupo de cada razón social");
  for (const campo of ["comision", "capa1", "capa2", "descuento", "realizada", "caja", "proporcional"]) {
    assert.ok(fn.includes(campo), `el P&L por razón social lleva ${campo}`);
  }
});

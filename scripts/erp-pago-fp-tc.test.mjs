// Bloque A.1b — pagar la FP con tipo de cambio y diferencial (Decisión 80,
// 17-sep-2026, MODELO-NEGOCIO.md § 11.3-11.4, § 12). Antes, applyInvoicePayment
// solo calculaba diferencial para kind='customer': una FP en dólares se pagaba
// con pesos 1:1 contra un saldo en dólares y la pantalla ofrecía TC y
// tratamiento que el servidor tiraba. Aquí se fija la aritmética de los cuatro
// modos (moneda de factura × moneda de banco), el signo del diferencial por
// lado, y que el cobro y la reversa usen lo mismo.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fxResultDeltaFor, mxnInvoicePaidInUsd, settleMode, usdBankSettlement } from "../src/lib/erp/fx.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");

function fnBody(source, name) {
  const markers = [`export const ${name} `, `export async function ${name}(`, `export function ${name}(`, `async function ${name}(`, `function ${name}(`];
  const start = markers.map((m) => source.indexOf(m)).find((i) => i !== -1);
  assert.notEqual(start, undefined, `No existe ${name}`);
  const rest = source.slice(start);
  const next = rest.slice(10).search(/\n(export )?(async )?function |\nexport const /);
  return next === -1 ? rest : rest.slice(0, next + 10);
}

// Copia literal de fxPaymentSplit (credit.ts), como en erp-fx-visiones: el mismo
// reparto sirve para cliente y proveedor; solo cambia el signo de la utilidad.
const round2 = (n) => Math.round(n * 100) / 100;
function fxPaymentSplit(input) {
  const residualUsd = input.residualMxn / input.fxAgreed;
  const usdPaid = input.depositedMxn / input.fxPaid;
  const usdApplied = Math.min(usdPaid, residualUsd);
  const appliedMxn = round2(usdApplied * input.fxAgreed);
  const bankMxn = round2(usdApplied * input.fxPaid);
  return { usdApplied: round2(usdApplied), appliedMxn, bankMxn, diff: round2(bankMxn - appliedMxn) };
}

test("settleMode: moneda de factura × moneda de banco dan cuatro modos, ni uno más", () => {
  assert.equal(settleMode({ usdInvoice: true, bankUsd: false }), "usd-con-pesos");
  assert.equal(settleMode({ usdInvoice: true, bankUsd: true }), "usd-con-dolares");
  assert.equal(settleMode({ usdInvoice: false, bankUsd: true }), "mxn-con-dolares");
  assert.equal(settleMode({ usdInvoice: false, bankUsd: false }), "mxn");
});

test("Dinámica 2 (D80): FP de 1,000 USD a 18.50 pagada con pesos a 19.00 — se aplican 18,500 al pactado, salen 19,000 del banco, y los 500 son PÉRDIDA (el mismo número que sería utilidad si lo pagara un cliente)", () => {
  const s = fxPaymentSplit({ depositedMxn: 19000, fxPaid: 19, fxAgreed: 18.5, residualMxn: 18500 });
  assert.deepEqual(s, { usdApplied: 1000, appliedMxn: 18500, bankMxn: 19000, diff: 500 });
  assert.equal(fxResultDeltaFor("supplier", s.diff), -500, "Azagro pagó 500 pesos de más: pérdida cambiaria");
  assert.equal(fxResultDeltaFor("customer", s.diff), 500, "el cliente que paga de más deja utilidad");
  // Pagada a 18.00: salen 18,000, el proveedor recibió sus 1,000 USD, Azagro ganó 500.
  const g = fxPaymentSplit({ depositedMxn: 18000, fxPaid: 18, fxAgreed: 18.5, residualMxn: 18500 });
  assert.deepEqual(g, { usdApplied: 1000, appliedMxn: 18500, bankMxn: 18000, diff: -500 });
  assert.equal(fxResultDeltaFor("supplier", g.diff), 500);
  // El ATC lleva −diff en los dos lados: para el proveedor, +500 = por pagar (se le pagó de menos), −500 = por cobrarle.
  assert.equal(-g.diff, 500, "pagó de menos → ATC por pagar 500");
  assert.equal(-s.diff, -500, "pagó de más → ATC por cobrar al proveedor 500");
});

test("Dinámica 1 (D80): FP de 1,000 USD a 18.50 pagada desde la cuenta en dólares — sin diferencial, el banco lleva dólares y el libro 18,500 pesos", () => {
  assert.deepEqual(usdBankSettlement({ amountUsd: 1000, fxAgreed: 18.5, residualMxn: 18500 }), { usdApplied: 1000, appliedMxn: 18500, bankUsd: 1000 });
  // Pago parcial de 400 USD: aplica 7,400 pesos; salen 400 USD.
  assert.deepEqual(usdBankSettlement({ amountUsd: 400, fxAgreed: 18.5, residualMxn: 18500 }), { usdApplied: 400, appliedMxn: 7400, bankUsd: 400 });
  // Más dólares que el saldo: se aplica solo lo que queda.
  assert.deepEqual(usdBankSettlement({ amountUsd: 5000, fxAgreed: 18.5, residualMxn: 18500 }), { usdApplied: 1000, appliedMxn: 18500, bankUsd: 1000 });
});

test("Factura en pesos pagada desde la cuenta en dólares: los dólares valen pesos al TC del pago; sin TC se detiene", () => {
  assert.deepEqual(mxnInvoicePaidInUsd({ amountUsd: 1000, fxPaid: 18.5, residualMxn: 20000 }), { appliedMxn: 18500, bankUsd: 1000 });
  // Más de lo que se debe: se aplica el saldo y salen solo los dólares que hacen falta.
  assert.deepEqual(mxnInvoicePaidInUsd({ amountUsd: 2000, fxPaid: 18.5, residualMxn: 18500 }), { appliedMxn: 18500, bankUsd: 1000 });
  assert.throws(() => mxnInvoicePaidInUsd({ amountUsd: 1000, fxPaid: 1, residualMxn: 20000 }), /captura el tipo de cambio del pago/);
});

test("El caso del Excel sigue igual del lado cliente: FV 10,000 USD a 19.00 cobrada con 186,000 pesos a 18.60 → pagada en dólares, 4,000 de pérdida (o ATC por cobrar 4,000)", () => {
  const s = fxPaymentSplit({ depositedMxn: 186000, fxPaid: 18.6, fxAgreed: 19, residualMxn: 190000 });
  assert.deepEqual(s, { usdApplied: 10000, appliedMxn: 190000, bankMxn: 186000, diff: -4000 });
  assert.equal(fxResultDeltaFor("customer", s.diff), -4000);
  assert.equal(-s.diff, 4000, "ATC por cobrar 4,000");
});

// ---------------------------------------------------------------------------
// Cableado: el cobro y la reversa usan lo mismo, en los dos lados.
// ---------------------------------------------------------------------------
test("applyInvoicePayment: la rama en dólares ya no excluye al proveedor; el ATC nace del lado de la factura; el banco en dólares lleva dólares", () => {
  const b = fnBody(src("src/lib/erp/ops.ts"), "applyInvoicePayment");
  assert.ok(b.includes('const isUsdSupplier = inv[0].kind === "supplier" && mode === "usd-con-pesos";'), "FP en dólares pagada con pesos");
  assert.ok(b.includes("if (isUsdCustomer || isUsdSupplier) {"), "el mismo reparto para los dos lados");
  assert.ok(b.includes("fxPaymentSplit({"), "el reparto de siempre (sin cambio)");
  assert.ok(b.includes("const fxResultDelta = fxResultDeltaFor(inv[0].kind, fxDiff);"), "el signo de la utilidad por lado");
  assert.ok(b.includes("fx_result = fx_result + ${fxResultDelta}"), "la opción utilidad acumula con el signo del lado");
  assert.ok(b.includes("${opts.companyId}, ${inv[0].kind}, ${fxDoc}"), "el ATC nace con el kind de la factura, ya no 'customer' fijo");
  assert.ok(b.includes("POR COBRAR AL PROVEEDOR"), "el ajuste del proveedor tiene sus dos nombres");
  assert.ok(b.includes('} else if (mode === "usd-con-dolares") {') && b.includes("usdBankSettlement({"), "dólares contra dólares, sin diferencial");
  assert.ok(b.includes('} else if (mode === "mxn-con-dolares") {') && b.includes("mxnInvoicePaidInUsd({"), "pesos pagados con dólares al TC del pago");
  assert.ok(b.includes("${bankUsd ? signed : null}, ${moveFx}"), "el movimiento de banco guarda amount_fx (con el signo de amount) y el TC");
  // 19-sep-2026 (L5, Decisión 12): se sigue comparando en la moneda de la
  // cuenta, y ahora contra el importe COMPLETO que sale de ella — no solo
  // contra lo que se aplica a la factura. De una cuenta sale todo el pago,
  // incluido el sobrante que queda como saldo a favor.
  assert.ok(b.includes("cash + 0.009 < bankAmount + sobrante"), "el saldo se compara en SU moneda, contra lo que de verdad sale (aplicado + sobrante)");
  assert.ok(b.includes("const deposito = depositSplit({ deposited: opts.amount, used: bankAmount });"), "el depósito real y lo consumido se separan");
  assert.ok(b.includes("${payDate}, 'MXN', ${moveFx ?? 1})"), "el PAG está en pesos al pactado y guarda el TC del movimiento (columnas que existían y nadie escribía)");
  assert.ok(b.includes('const signed = inv[0].kind === "customer" ? bankAmount : -bankAmount'), "el banco lleva lo real, con signo por lado (sin cambio)");
});

test("reversal: la reversa reconstruye el diferencial también del lado proveedor, con el signo contrario, y no inventa diferencial cuando el banco es en dólares", () => {
  const r = src("src/lib/erp/reversal.ts");
  const chain = fnBody(r, "chainForPayment");
  assert.ok(chain.includes("const fxDiff = isUsdCustomer && bankMove ? r2(Math.abs(bankMove.amount) - amount) : 0;"), "derivable exacto del cliente (sin cambio)");
  assert.ok(chain.includes("const fxDiffSupplier = isUsdSupplier && bankMove ? r2(Math.abs(bankMove.amount) - amount) : 0;"), "y del proveedor");
  assert.ok(chain.includes("const fxResultDelta = isUsdSupplier ? r2(-fxDiffSupplier) : fxDiff;"), "signo contrario del lado proveedor");
  assert.ok(chain.includes('const paidInMxn = !bankMove || bankMove.currency !== "USD";'), "desde la cuenta en dólares no hay diferencial que regresar");
  const apply = fnBody(r, "applyReversal");
  assert.ok(apply.includes("const fxBack = chain.atc ? 0 : chain.fxResultDelta;"), "se regresa lo que se registró, con su signo");
  assert.ok(apply.includes("fx_result = fx_result - ${fxBack}"), "(sin cambio)");
});

test("las dos pantallas piden el TC según la moneda de la CUENTA elegida, no solo la de la factura", () => {
  const c = src("src/routes/credit.tsx");
  assert.ok(c.includes('banks.find((b) => b.id === pay.bankId)?.currency !== "USD" && ('), "Cartera: TC y tratamiento solo si se paga con pesos");
  assert.ok(c.includes("TC del pago (factura en pesos pagada con dólares)"), "Cartera: pesos pagados con dólares");
  assert.ok(c.includes("Ajustar al pactado (por pagar / por cobrar al proveedor)"), "Cartera: el ajuste del proveedor con sus nombres");
  const k = src("src/routes/banks.tsx");
  assert.ok(k.includes('data?.banks.find((b) => String(b.id) === bankId)?.currency !== "USD" && ('), "Bancos: igual");
});

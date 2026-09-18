// Bloque A.1a — moneda y TC en la cadena de compra (Decisiones 76-81,
// 17-sep-2026, MODELO-NEGOCIO.md § 11-12). Antes de este bloque ningún costo
// tenía moneda: un bid de 1,000 USD copiado a una cotización en pesos se
// preciaba como 1,000 pesos; toda OC en USD capturada a mano nacía con TC 1; la
// FP nacía en dólares crudos sin amount_fx; y el P&L restaba dólares contra
// pesos. Aquí se fija la aritmética (pura, fx.ts) y que cada nacimiento la use.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { costToMxn, fxAt, invoiceShown, isUsdFx, mxnToCostCurrency, poCostToMxn, supplierInvoiceAmounts } from "../src/lib/erp/fx.ts";

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

// ---------------------------------------------------------------------------
// La aritmética (pura).
// ---------------------------------------------------------------------------
test("isUsdFx: un TC USD→MXN real es > 1; el 1 del esquema y el vacío no son tipo de cambio", () => {
  assert.equal(isUsdFx(18.5), true);
  assert.equal(isUsdFx("17.9"), true);
  assert.equal(isUsdFx(1), false);
  assert.equal(isUsdFx("1"), false);
  assert.equal(isUsdFx(0), false);
  assert.equal(isUsdFx(null), false);
  assert.equal(isUsdFx(undefined), false);
});

test("costToMxn (D76): el caso de § 11.2 — 1,000 USD a 17.50 son 17,500 pesos, no 1,000; sin TC se detiene", () => {
  const c = costToMxn({ cost: 1000, currency: "USD", fx: 17.5, what: "prueba" });
  assert.deepEqual(c, { mxn: 17500, currency: "USD", fx: 17.5 });
  assert.deepEqual(costToMxn({ cost: 1000, currency: "MXN", fx: null, what: "prueba" }), { mxn: 1000, currency: "MXN", fx: null });
  assert.throws(() => costToMxn({ cost: 1000, currency: "USD", fx: null, what: "el costo de SC-0001" }), /Sin tipo de cambio para el costo de SC-0001/);
  assert.throws(() => costToMxn({ cost: 1000, currency: "USD", fx: 1, what: "x" }), /Sin tipo de cambio/, "el 1 del esquema no convierte nada");
});

test("mxnToCostCurrency (D78): el costo en pesos vuelve a la moneda del proveedor para la OC, y el viaje ida y vuelta cuadra a 4 decimales", () => {
  assert.equal(mxnToCostCurrency({ mxn: 17500, currency: "USD", fx: 17.5, what: "x" }), 1000);
  const ida = costToMxn({ cost: 999.99, currency: "USD", fx: 18.1234, what: "x" }).mxn;
  assert.equal(mxnToCostCurrency({ mxn: ida, currency: "USD", fx: 18.1234, what: "x" }), 999.99);
  assert.equal(mxnToCostCurrency({ mxn: 1234.5678, currency: "MXN", what: "x" }), 1234.5678);
});

test("supplierInvoiceAmounts (D79): la FP nace como la FV — pesos al TC de la OC, el original en amount_fx; en MXN amount_fx 0 y TC 1", () => {
  assert.deepEqual(supplierInvoiceAmounts({ total: 1000, currency: "USD", fx: 18.5, poName: "OC-0001" }), { amount: 18500, amountFx: 1000, fxAgreed: 18.5, currency: "USD" });
  assert.deepEqual(supplierInvoiceAmounts({ total: "1000.004", currency: "MXN", fx: 1, poName: "OC-0002" }), { amount: 1000, amountFx: 0, fxAgreed: 1, currency: "MXN" });
  // Una OC en dólares sin TC real no hace nacer deuda: el mensaje nombra la OC y la salida.
  assert.throws(() => supplierInvoiceAmounts({ total: 1000, currency: "USD", fx: 1, poName: "OC-0003" }), /OC-0003 está en dólares sin tipo de cambio[\s\S]*Compras/);
});

test("poCostToMxn (D76, P&L): USD × TC de la OC; una OC en dólares con TC 1 no se resta contra pesos (null → la partida se excluye)", () => {
  assert.equal(poCostToMxn({ unitPrice: "1000", currency: "USD", fx: "18.5" }), 18500);
  assert.equal(poCostToMxn({ unitPrice: "1000", currency: "MXN", fx: "1" }), 1000);
  assert.equal(poCostToMxn({ unitPrice: "1000", currency: null, fx: null }), 1000, "sin moneda es pesos, como siempre");
  assert.equal(poCostToMxn({ unitPrice: "1000", currency: "USD", fx: "1" }), null);
  assert.equal(poCostToMxn({ unitPrice: null, currency: "USD", fx: "18.5" }), null);
});

test("invoiceShown: por fila, un documento en dólares se enseña en dólares (el caso del Excel: 10,000 USD a 19.00, mitad cobrada)", () => {
  const fv = invoiceShown({ amount: 190000, residual: 95000, currency: "USD", amountFx: 10000, fxAgreed: 19 });
  assert.deepEqual(fv, { amount: 10000, residual: 5000, paid: 5000, currency: "USD", fx: 19 });
  // FP de antes de la 0044 (TC 1, amount_fx = amount por el backfill): se enseña tal cual, sin fingir un TC.
  assert.deepEqual(invoiceShown({ amount: 1000, residual: 1000, currency: "USD", amountFx: 1000, fxAgreed: 1 }), { amount: 1000, residual: 1000, paid: 0, currency: "USD", fx: null });
  assert.deepEqual(invoiceShown({ amount: 500, residual: 200, currency: "MXN", amountFx: 0, fxAgreed: 1 }), { amount: 500, residual: 200, paid: 300, currency: "MXN", fx: null });
});

test("fxAt: el renglón más reciente con fecha ≤ la pedida; sin renglón que aplique, null (nunca un respaldo)", () => {
  const table = [{ date: "2026-09-10", rate: 18.2 }, { date: "2026-09-01", rate: 18.0 }, { date: "2026-09-20", rate: 18.6 }];
  assert.deepEqual(fxAt(table, "2026-09-15"), { date: "2026-09-10", rate: 18.2 });
  assert.deepEqual(fxAt(table, "2026-09-20"), { date: "2026-09-20", rate: 18.6 });
  assert.equal(fxAt(table, "2026-08-31"), null);
});

// ---------------------------------------------------------------------------
// Que cada nacimiento use la aritmética (el texto del código, como las demás pruebas del proyecto).
// ---------------------------------------------------------------------------
test("D79: los dos nacimientos de FP usan supplierInvoiceAmounts y escriben amount_fx y fx_agreed", () => {
  const a = src("src/lib/azagro.ts");
  for (const fn of ["bornSupplierDebtByReceipt"]) {
    const b = fnBody(a, fn);
    assert.ok(b.includes("supplierInvoiceAmounts({"), `${fn} convierte con el molde de la FV`);
    assert.ok(b.includes("amount, residual, amount_fx, origin,"), `${fn} escribe amount_fx`);
    assert.ok(b.includes("${amounts.amount}, ${amounts.amount}, ${amounts.amountFx}"), `${fn}: amount y residual en pesos, el original en amount_fx`);
    assert.ok(!b.includes("${total}, ${total}"), `${fn}: ya no inserta el total crudo`);
  }
});

test("D78: una OC en dólares nunca nace con TC 1 — ni a mano, ni desde RFQ, ni desde la cotización aceptada", () => {
  const a = src("src/lib/azagro.ts");
  const cp = fnBody(a, "createPurchase");
  assert.ok(!cp.includes("fxRate: z.number().positive().optional().default(1)"), "createPurchase: el 1 por omisión se fue del validador");
  assert.ok(cp.includes('if (currency === "USD" && !isUsdFx(data.fxRate)) throw new Error(missingFxMessage('), "createPurchase se detiene sin TC");
  assert.ok(cp.includes("${currency}, ${fxRate}, ${data.fulfillKind"), "createPurchase inserta el TC capturado");
  const r = fnBody(src("src/lib/erp/rfq.ts"), "applyRfqWinners");
  assert.ok(!r.includes("${rfq[0].currency}, 1, 'inventory'"), "applyRfqWinners: el 1 literal se fue");
  assert.ok(r.includes("${rfqCurrency}, ${fx}, 'inventory'"), "applyRfqWinners inserta el TC del proveedor");
  assert.ok(r.includes("cost_currency = ${c.currency}, cost_fx = ${c.fx}"), "applyRfqWinners deja moneda y TC del costo en la cotización (D76)");
  const d = fnBody(src("src/lib/erp/ops.ts"), "decideQuote");
  assert.ok(d.includes("${poCurrency}, ${poFx}, ${fulfillKind}"), "decideQuote: la OC nace en la moneda del proveedor con su TC, no con el del cliente");
  assert.ok(!d.includes("${q[0].currency}, ${Number(q[0].fx_rate)}, ${fulfillKind}"), "decideQuote ya no hereda el TC del cliente a la OC");
  const sp = fnBody(a, "setPurchaseFxRate");
  assert.ok(sp.includes("state <> 'reversed' limit 1") && sp.includes("revierte la recepción"), "la salida: capturar el TC en la OC mientras no haya deuda viva");
});

test("D76: el costo de la solicitud y de la cotización se guarda en pesos con su moneda y TC de origen", () => {
  const rq = src("src/lib/erp/requests.ts");
  for (const fn of ["pickVendor", "applyCheapest"]) {
    const b = fnBody(rq, fn);
    assert.ok(b.includes("costToMxn({"), `${fn} convierte`);
    assert.ok(b.includes("cost_currency = ${c.currency}, cost_fx = ${c.fx}"), `${fn} deja moneda y TC en la partida`);
  }
  assert.ok(fnBody(rq, "quoteFromRequest").includes("${line.credit}, ${line.costCurrency}, ${line.costFx},"), "quoteFromRequest copia moneda y TC a la cotización");
  const ops = src("src/lib/erp/ops.ts");
  assert.ok(fnBody(ops, "createQuote").includes("credit_price, cost_currency, cost_fx,"), "createQuote: el costo de catálogo es pesos (D77)");
});

test("D76, P&L: dealPnlCore trae moneda y TC de la OC, convierte antes de restar y excluye con motivo la OC en dólares sin TC", () => {
  const b = fnBody(src("src/lib/erp/reports.ts"), "dealPnlCore");
  assert.ok(b.includes(") as po_currency,") && b.includes(") as po_fx,"), "la consulta trae po.currency y po.fx_rate");
  assert.ok(b.includes("const poCost = poCostToMxn({ unitPrice: l.po_cost, currency: l.po_currency, fx: l.po_fx });"), "costUnit en pesos");
  assert.ok(b.includes('"OC en dólares sin tipo de cambio (captúralo en Compras)"'), "la partida se excluye con motivo, no se mezcla");
  // El spread sigue siendo informativo: NO está en la fórmula. Lo que sí
  // entró el 18-sep-2026 es `fxCompra`, el diferencial REALIZADO del pago al
  // proveedor (Decisión 87) — otra cosa, y con documento que lo respalda.
  assert.ok(b.includes("const netProfit = margin + mora + fxIncome + fxCompra - finance - discount;"), "la utilidad lleva los dos diferenciales realizados");
  assert.ok(!b.includes("+ fxSpread -") && !b.includes("+ fxSpread +"), "el spread sigue fuera de la utilidad");
  assert.ok(b.includes("const fxSpread = Math.round(included.reduce((s, l) => s + l.fxSpread, 0) * 100) / 100;"), "spread cambiario del deal, sumado sobre lo incluido");
});

test("migración 0044: solo aditiva, y el backfill de FP en USD deja fuera las del corte y las que no tienen TC real", () => {
  const m = src("migrations/0044_moneda_del_costo.sql");
  assert.ok(!/\b(drop|rename)\b/i.test(m) && !/alter column .* type/i.test(m), "sin drops, renames ni cambios de tipo");
  assert.ok(m.includes("where kind = 'supplier' and currency = 'USD' and cutover_key is null"), "el backfill no toca el corte (D70)");
  assert.ok(m.includes("and fx_agreed > 0 and fx_agreed <> 1"), "solo se convierte lo que tiene TC real");
  assert.ok(m.includes("residual  = round(amount * fx_agreed, 2) - (amount - residual)"), "el saldo sigue la única regla: importe nuevo − abonos previos (pesos reales), nunca saldo × TC");
  assert.ok(m.includes("add column if not exists pair_id integer references bank_moves(id)"), "las dos patas de una compra de dólares se ligan (D81)");
});

// Bloque A.1c — comprar dólares, dólares en caja a promedio, caja por moneda y
// la recepción en pesos (Decisiones 77 y 81, 18-sep-2026, MODELO-NEGOCIO.md
// § 11.6-11.7, § 12). Antes: la transferencia entre cuentas acreditaba el mismo
// número en las dos monedas (18,000 pesos entraban como 18,000 dólares), el
// inicio sumaba pesos con dólares, y la recepción de una OC en dólares metía
// el precio crudo al kardex (1,000 en inventario contra 18,500 de deuda).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exchangeLegs, receiptUnitCostMxn, usdCashAverage } from "../src/lib/erp/fx.ts";

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

test("exchangeLegs (D81): comprar 1,000 USD a 18.40 saca 18,400 pesos y mete 1,000 dólares; vender es el espejo; sin TC se detiene", () => {
  const c = exchangeLegs({ direction: "compra-usd", usd: 1000, fx: 18.4 });
  assert.deepEqual(c, { usd: 1000, mxn: 18400, pesos: { amount: -18400, amountFx: -1000 }, dolares: { amount: 1000, amountFx: 1000 } });
  const v = exchangeLegs({ direction: "venta-usd", usd: 500, fx: 18.6 });
  assert.deepEqual(v, { usd: 500, mxn: 9300, pesos: { amount: 9300, amountFx: 500 }, dolares: { amount: -500, amountFx: -500 } });
  assert.throws(() => exchangeLegs({ direction: "compra-usd", usd: 1000, fx: 1 }), /Sin tipo de cambio para la compra de dólares/);
});

test("usdCashAverage (D81): los dólares en caja llevan su costo a promedio móvil; las salidas salen al promedio; lo sin TC se lleva aparte", () => {
  // 1,000 a 18.40 y 500 a 18.60 → promedio 18.4667; salen 400 al promedio.
  const a = usdCashAverage({ opening: 0, moves: [{ amount: 1000, fxRate: 18.4 }, { amount: 500, fxRate: 18.6 }, { amount: -400, fxRate: 18.5 }] });
  assert.equal(a.usd, 1100);
  assert.equal(a.avgFx, 18.4667);
  assert.equal(a.mxn, 20313.37);
  assert.equal(a.sinTc, 0);
  // Saldo inicial de 2,000 sin TC: no se le inventa costo; los 1,000 comprados sí lo tienen.
  const b = usdCashAverage({ opening: 2000, moves: [{ amount: 1000, fxRate: 18.4 }] });
  assert.deepEqual(b, { usd: 3000, tracked: 1000, sinTc: 2000, avgFx: 18.4, mxn: 18400 });
  // Una salida consume primero los dólares con costo y luego los sin TC.
  const c = usdCashAverage({ opening: 2000, moves: [{ amount: 1000, fxRate: 18.4 }, { amount: -1500, fxRate: 18.5 }] });
  assert.deepEqual(c, { usd: 1500, tracked: 0, sinTc: 1500, avgFx: null, mxn: null });
  // Sin movimientos ni saldo: nada.
  assert.deepEqual(usdCashAverage({ opening: 0, moves: [] }), { usd: 0, tracked: 0, sinTc: 0, avgFx: null, mxn: null });
  // Revertir el cobro de 500 a 18.60 deshace ESA entrada a su TC: quedan 1,000 a 18.40 = 18,400, no 1,000 a 18.4667 (el caso del revisor de dinero).
  const d = usdCashAverage({ opening: 0, moves: [{ amount: 1000, fxRate: 18.4 }, { amount: 500, fxRate: 18.6 }, { amount: -500, fxRate: 18.6, reversal: true }] });
  assert.deepEqual(d, { usd: 1000, tracked: 1000, sinTc: 0, avgFx: 18.4, mxn: 18400 });
});

test("receiptUnitCostMxn (D77): la OC de 1,000 USD a 18.50 entra al kardex a 18,500 pesos por unidad; en pesos igual que siempre; en dólares sin TC no entra", () => {
  assert.equal(receiptUnitCostMxn({ unitPrice: "1000", currency: "USD", fx: "18.5", poName: "OC-0001" }), 18500);
  assert.equal(receiptUnitCostMxn({ unitPrice: "1234.5678", currency: "MXN", fx: "1", poName: "OC-0002" }), 1234.5678);
  assert.throws(() => receiptUnitCostMxn({ unitPrice: "1000", currency: "USD", fx: "1", poName: "OC-0003" }), /OC-0003 está en dólares sin tipo de cambio[\s\S]*Compras/);
});

// ---------------------------------------------------------------------------
// Cableado.
// ---------------------------------------------------------------------------
test("la recepción convierte ANTES de postStock, en los dos caminos; postStock no cambia de firma", () => {
  const a = src("src/lib/azagro.ts");
  assert.ok(fnBody(a, "receivePurchase").includes("unitCost: receiptUnitCostMxn({ unitPrice: line.unit_price, currency: po[0].currency, fx: po[0].fx_rate, poName: po[0].name })"), "recibir todo lo pendiente");
  const rp = fnBody(a, "receivePartial");
  assert.ok(rp.includes("unitCost: receiptUnitCostMxn({ unitPrice: line[0].unit_price, currency: poFx[0].currency, fx: poFx[0].fx_rate, poName: opts.poName })"), "recibir por partida");
  assert.ok(rp.includes("received.push({ productId: line[0].product_id, qty: l.qty, unitPrice: Number(line[0].unit_price) });"), "la FP sigue recibiendo el precio en la moneda de la OC (ella convierte)");
  const st = src("src/lib/erp/stock.ts");
  assert.ok(!st.includes("currency") && !st.includes("fx_rate"), "el kardex sigue sin saber de monedas");
});

test("addBankMove: compra/venta de dólares con TC y las dos patas ligadas; una transferencia entre monedas se rechaza nombrando la salida", () => {
  const b = fnBody(src("src/lib/erp/ops.ts"), "addBankMove");
  assert.ok(b.includes('kind: z.enum(["cobro", "pago", "transferencia", "ajuste", "compra-usd", "venta-usd"])'), "los dos tipos nuevos");
  assert.ok(b.includes("const legs = exchangeLegs({ direction: data.kind, usd: data.amount, fx: Number(data.fxRate) });"), "la aritmética pura");
  assert.ok(b.includes("values (${cid}, ${to.id}, ${data.date}, ${legTo.amount}, ${memoX}, ${data.kind}, ${context.userId}, ${legTo.amountFx}, ${Number(data.fxRate)}, ${a[0]!.id})"), "la segunda pata nace ligada a la primera");
  assert.ok(b.includes("await sql`update bank_moves set pair_id = ${b[0]!.id} where id = ${a[0]!.id}`;"), "y la primera a la segunda");
  assert.ok(b.includes("una transferencia no cambia de moneda"), "transferencia entre monedas: rechazada");
  assert.ok(b.includes('Usa «${from.currency === "MXN" ? "Compra de dólares" : "Venta de dólares"}», que pide el tipo de cambio.'), "…nombrando la salida");
  assert.ok(b.includes("No hay saldo suficiente en ${from.name}"), "candado de saldo en la moneda de la cuenta origen");
});

test("bancos e inicio por moneda: el promedio de dólares por cuenta, y caja / por cobrar / por pagar con su parte en dólares", () => {
  const ops = src("src/lib/erp/ops.ts");
  assert.ok(fnBody(ops, "listBanks").includes("const avg = usdCashAverage({ opening: Number(b.opening), moves: ms.map((m) => ({ amount: m.amount, fxRate: m.fx_rate, reversal: m.reverses_id != null })) });"), "listBanks calcula el promedio por cuenta USD y marca las reversas");
  const rv = fnBody(src("src/lib/erp/reversal.ts"), "applyReversal");
  assert.ok(rv.includes("${chain.bankMove.amount_fx != null ? -chain.bankMove.amount_fx : null}, ${chain.bankMove.fx_rate}, ${userId}, false, ${chain.bankMove.id})"), "el contra-movimiento copia amount_fx y fx_rate (los literales de la reversa siguen intactos)");
  const dash = fnBody(src("src/lib/azagro.ts"), "getDashboard");
  assert.ok(dash.includes("group by coalesce(b.currency,'MXN')"), "la caja se suma por moneda");
  assert.ok(dash.includes("cashUsd: seeBanks ? cashUsd : 0,") && dash.includes("arUsd: seeCredit ?") && dash.includes("apUsd: seeCredit ?"), "y el inicio recibe los tres por separado");
  assert.ok(dash.includes("i.residual / i.fx_agreed"), "lo en dólares es el residual en pesos entre el TC pactado");
  const ix = src("src/routes/index.tsx");
  assert.ok(ix.includes("en la cuenta en dólares") && ix.includes("en dólares` : \"\"}`}"), "las tarjetas del inicio lo enseñan");
  const bk = src("src/routes/banks.tsx");
  assert.ok(bk.includes('{ id: "compra-usd", label: "Compra de dólares" }') && bk.includes("TC promedio ${b.usd_avg_fx}"), "Bancos ofrece la compra y enseña el promedio");
});

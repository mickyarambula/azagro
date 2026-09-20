// L4a — el precio de venta se captura en la moneda del documento y se guarda
// en pesos (Decisión 82, 18-sep-2026, MODELO-NEGOCIO.md § 12.8). Antes de
// esto una cotización "en USD" guardaba el número tecleado como si fuera
// pesos, la FV nacía con amount = ese número y amount_fx = amount ÷ TC, y la
// NC de una devolución en dólares nacía sin amount_fx ni fx_agreed. Aquí se
// fija la aritmética (pura, fx.ts), que los seis nacimientos la usen, que las
// dos NC lleven su parte en dólares y que las pantallas enseñen la moneda del
// documento sin tocar lo guardado.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { finShown, reshowPrice, salePriceShown, saleToMxn, snapOrConvert } from "../src/lib/erp/fx.ts";

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
test("saleToMxn: 1,000 USD a 18.50 se guardan como 18,500 pesos; en pesos no se toca; en dólares sin TC se detiene", () => {
  assert.equal(saleToMxn({ price: 1000, currency: "USD", fx: 18.5, what: "prueba" }), 18500);
  assert.equal(saleToMxn({ price: "1234.5678", currency: "USD", fx: "18.5", what: "prueba" }), 22839.5043);
  assert.equal(saleToMxn({ price: 1000, currency: "MXN", fx: 18.5, what: "prueba" }), 1000);
  assert.equal(saleToMxn({ price: 1000, currency: "MXN", fx: null, what: "prueba" }), 1000);
  assert.throws(() => saleToMxn({ price: 1000, currency: "USD", fx: null, what: "la cotización en dólares" }), /tipo de cambio/i);
  assert.throws(() => saleToMxn({ price: 1000, currency: "USD", fx: 1, what: "la cotización en dólares" }), /tipo de cambio/i, "el 1 del esquema no es un TC");
});

test("salePriceShown: lo guardado en pesos se enseña en dólares al TC del documento, y el viaje ida y vuelta cierra", () => {
  assert.equal(salePriceShown(18500, "USD", 18.5), 1000);
  assert.equal(salePriceShown("18500", "USD", "18.5"), 1000);
  assert.equal(salePriceShown(18500, "MXN", 18.5), 18500);
  assert.equal(salePriceShown(18500, "USD", 1), 18500, "sin TC válido no se inventa una división");
  assert.equal(salePriceShown(18500, "USD", null), 18500);
  for (const usd of [1000, 1234.5678, 0.01, 999999.99]) {
    const mxn = saleToMxn({ price: usd, currency: "USD", fx: 18.5, what: "prueba" });
    assert.ok(Math.abs(salePriceShown(mxn, "USD", 18.5) - usd) < 0.00005, `ida y vuelta ${usd}`);
  }
});

test("snapOrConvert: si la pantalla devuelve el mismo precio que enseñó, se conserva el peso guardado byte a byte; si lo cambió, se convierte", () => {
  // 18,500.1234 pesos se enseñan como 1,000.0067 USD; si vuelve 1,000.0067 no se re-redondea a 18,500.1240.
  const prevMxn = 18500.1234;
  const shown = salePriceShown(prevMxn, "USD", 18.5);
  assert.equal(snapOrConvert({ sent: shown, prevMxn, currency: "USD", fx: 18.5, what: "prueba" }), prevMxn);
  assert.equal(snapOrConvert({ sent: "1000.0067", prevMxn: "18500.1234", currency: "USD", fx: "18.5", what: "prueba" }), prevMxn);
  // Precio cambiado: se convierte con el TC del documento.
  assert.equal(snapOrConvert({ sent: 1100, prevMxn, currency: "USD", fx: 18.5, what: "prueba" }), 20350);
  // Partida nueva (sin anterior): se convierte.
  assert.equal(snapOrConvert({ sent: 1000, prevMxn: null, currency: "USD", fx: 18.5, what: "prueba" }), 18500);
  assert.equal(snapOrConvert({ sent: 1000, prevMxn: undefined, currency: "USD", fx: 18.5, what: "prueba" }), 18500);
  // En pesos: lo que llega es lo que se guarda.
  assert.equal(snapOrConvert({ sent: 1000, prevMxn: 999, currency: "MXN", fx: 1, what: "prueba" }), 1000);
  assert.throws(() => snapOrConvert({ sent: 1100, prevMxn, currency: "USD", fx: null, what: "el pedido en dólares" }), /tipo de cambio/i);
});

test("invoiceShown: una NC en dólares (amount_fx negativo) también se enseña en dólares — antes salía «−US$92,500.00»", async () => {
  const { invoiceShown } = await import("../src/lib/erp/fx.ts");
  assert.deepEqual(invoiceShown({ amount: -92500, residual: 0, currency: "USD", amountFx: -5000, fxAgreed: 18.5 }), { amount: -5000, residual: 0, paid: -5000, currency: "USD", fx: 18.5 });
});

test("finShown: la base del financiamiento (pesos) baja a dólares con el TC; en pesos o sin TC se queda igual", () => {
  const fin = { commission: 185, interestYear: 3700 };
  assert.deepEqual(finShown(fin, "USD", 18.5), { commission: 10, interestYear: 200 });
  assert.equal(finShown(fin, "MXN", 18.5), fin);
  assert.equal(finShown(fin, "USD", 1), fin);
  assert.equal(finShown(fin, "USD", null), fin);
});

test("reshowPrice: al cambiar de moneda lo escrito se convierte; con la misma moneda y otro TC, los dólares escritos se quedan", () => {
  // Sin TC, "USD" era pesos: 18,500 escritos con TC 0 pasan a 1,000 cuando aparece el 18.50.
  assert.equal(reshowPrice(18500, { currency: "USD", fx: 0 }, { currency: "USD", fx: 18.5 }), 1000);
  // MXN → USD y USD → MXN.
  assert.equal(reshowPrice(18500, { currency: "MXN", fx: 1 }, { currency: "USD", fx: 18.5 }), 1000);
  assert.equal(reshowPrice(1000, { currency: "USD", fx: 18.5 }, { currency: "MXN", fx: 1 }), 18500);
  // Mismo USD, otro TC: 1,000 dólares siguen siendo 1,000 dólares.
  assert.equal(reshowPrice(1000, { currency: "USD", fx: 18.5 }, { currency: "USD", fx: 18.6 }), 1000);
  assert.equal(reshowPrice(1000, { currency: "MXN", fx: 1 }, { currency: "MXN", fx: 1 }), 1000);
  const q = src("src/routes/quotes.tsx");
  assert.ok(q.includes("function reshowLines(next: { currency: \"USD\" | \"MXN\"; fx: number })"), "la cotización re-enseña al cambiar moneda o TC");
  assert.ok(q.includes("reshowLines({ currency: next, fx: fxRate });") && q.includes("reshowLines({ currency, fx });"), "desde el selector de moneda y desde el TC");
  assert.ok(q.includes("const cash = salePriceShown(p.list_price, currency, fxFresh);"), "la partida inicial se propone con el TC recién leído de la tabla, no con el del render anterior");
  const f = src("src/components/order-form.tsx");
  assert.equal((f.match(/reshowPrice\(/g) ?? []).length, 2, "el pedido re-enseña desde el selector de moneda y desde el TC");
});

// ---------------------------------------------------------------------------
// Cableado: los nacimientos convierten ANTES de precio, margen, total y factura.
// ---------------------------------------------------------------------------
test("cotización directa: createQuote convierte unitPrice, cashPrice y creditPrice a pesos antes de preciar", () => {
  const ops = src("src/lib/erp/ops.ts");
  const fn = fnBody(ops, "createQuote");
  assert.ok(fn.includes('l.unitPrice = saleToMxn({ price: l.unitPrice, currency: "USD", fx: data.fxRate, what: "la cotización en dólares" });'), "unitPrice");
  assert.ok(fn.includes('if (l.cashPrice != null) l.cashPrice = saleToMxn({ price: l.cashPrice, currency: "USD", fx: data.fxRate, what: "la cotización en dólares" });'), "cashPrice");
  assert.ok(fn.includes('if (l.creditPrice != null) l.creditPrice = saleToMxn({ price: l.creditPrice, currency: "USD", fx: data.fxRate, what: "la cotización en dólares" });'), "creditPrice");
  // La conversión va ANTES de que se filtren y precien las partidas (el motor de precio no cambia).
  assert.ok(fn.indexOf("saleToMxn(") < fn.indexOf("const priced ="), "convierte antes de preciar");
});

test("revisión: reviseQuote compara lo que la pantalla enseñó con lo guardado y conserva el peso si no cambió", () => {
  const ops = src("src/lib/erp/ops.ts");
  const fn = fnBody(ops, "reviseQuote");
  assert.ok(fn.includes("l.cashPrice = snapOrConvert({ sent: l.cashPrice, prevMxn: p?.cash_price, currency: \"USD\", fx: q[0].fx_rate,"), "cashPrice contra el guardado");
  assert.ok(fn.includes("l.creditPrice = snapOrConvert({ sent: l.creditPrice, prevMxn: p?.credit_price, currency: \"USD\", fx: q[0].fx_rate,"), "creditPrice contra el guardado");
});

test("pedido: saveOrder convierte con snapOrConvert contra la partida guardada; createSale convierte con saleToMxn", () => {
  const orders = fnBody(src("src/lib/erp/orders.ts"), "saveOrder");
  assert.ok(orders.includes('l.unitPrice = snapOrConvert({ sent: l.unitPrice, prevMxn: p?.unit_price, currency: "USD", fx: data.fxRate, what: "el pedido en dólares" });'));
  assert.ok(orders.indexOf("snapOrConvert(") < orders.indexOf("const total = data.lines.reduce("), "el total se suma ya en pesos");
  const sale = fnBody(src("src/lib/azagro.ts"), "createSale");
  assert.ok(sale.includes('for (const l of data.lines) l.unitPrice = saleToMxn({ price: l.unitPrice, currency: "USD", fx: data.fxRate, what: "la venta en dólares" });'));
});

test("OC del cliente: convertCustomerPO lleva cada precio a pesos con el TC de la tabla antes del total y de la partida", () => {
  const fn = fnBody(src("src/lib/erp/cpo.ts"), "convertCustomerPO");
  assert.ok(fn.includes("const priceMxn = (p: string | number) => saleToMxn({ price: p, currency: cpo[0].currency, fx: fxRate,"), "una sola conversión");
  assert.ok(fn.includes("const total = lines.reduce((s, l) => s + Number(l.qty) * priceMxn(l.unit_price), 0);"), "total en pesos");
  assert.ok(fn.includes("priceMxn(line.unit_price)"), "la partida del pedido en pesos");
});

test("las dos NC llevan su parte en dólares: devolución (returnSale) y reversa de entrega (creditNoteFor)", () => {
  const ret = fnBody(src("src/lib/azagro.ts"), "returnSale");
  assert.ok(ret.includes("amount_fx, fx_agreed"), "la NC de devolución inserta amount_fx y fx_agreed");
  assert.ok(ret.includes("coalesce(currency,'MXN') as currency, coalesce(fx_agreed,1)::text as fx_agreed from invoices"), "lee la moneda y el TC pactado de la FV a la que abona");
  assert.ok(ret.includes('const ncFx = fv[0] && fv[0].currency === "USD" && isUsdFx(fv[0].fx_agreed)'), "solo con FV en dólares y TC pactado real");
  assert.ok(ret.includes("amountFx: -Math.round((credit / Number(fv[0].fx_agreed)) * 100) / 100, fxAgreed: Number(fv[0].fx_agreed)"), "NC negativa en dólares al TC pactado de ESA FV");
  const rev = fnBody(src("src/lib/erp/delivery-reversal.ts"), "creditNoteFor");
  assert.ok(rev.includes("origin, amount_fx, fx_agreed, currency"), "la NC espejo de la reversa también");
  assert.ok(rev.includes("${-(doc.amount_fx ?? 0)}, ${doc.fx_agreed ?? 1}"), "espejo negativo del amount_fx de la FV, mismo TC pactado");
});

// ---------------------------------------------------------------------------
// Pantallas y papel: enseñan la moneda del documento, no tocan lo guardado.
// ---------------------------------------------------------------------------
test("cotización (pantalla): precio de lista y base del financiamiento en la moneda que se captura; lo guardado se enseña dividido", () => {
  const q = src("src/routes/quotes.tsx");
  assert.ok(q.includes("const l = { ...l0, fin: finShown(l0.fin, money.currency, money.fx) };"), "el crédito de la partida nueva usa la base en la moneda del documento");
  assert.ok(q.includes("const listShown = (p: { list_price: string } | undefined) => salePriceShown(p?.list_price ?? 0, currency, fxRate);"), "el precio de lista (pesos) se propone en la moneda elegida");
  assert.ok(!q.includes("const cash = Number(p.list_price);") && !q.includes("Number(p?.list_price ?? 0)"), "ningún default lee list_price crudo");
  assert.ok(q.includes("P. contado ({currency})") && q.includes("P. crédito ({currency})"), "las columnas dicen en qué moneda se captura");
  assert.ok(q.includes("const shQ = (n: number | string) => salePriceShown(n, cur, qrow.fx_rate);"), "lo guardado se enseña en la moneda de la cotización");
  assert.ok(q.includes("const rpOf = (l: (typeof qlines)[number]) => revPrices[l.product_id] ?? { cash: shQ(l.cash_price), credit: shQ(l.credit_price), qty: Number(l.qty) };"), "el panel abre con los precios en esa moneda");
  assert.ok(q.includes("const landed = shQ(num(l.cost) + num(l.freight));\n                            if (landed <= 0.009) return null;"), "el aviso de utilidad negativa compara precio y costo en la misma moneda");
  assert.ok(q.includes("prices[l.product_id] = { cash: shO(l.cash_price), credit: shO(l.credit_price), qty: Number(l.qty) };"), "openQuote siembra la revisión en esa moneda (si no, 18,500 pesos salían como US$18,500 y el panel decía «cambiaste precios»)");
  assert.ok(q.includes("const unit = shQ(offer === \"cash\" ? Number(l.cash_price) : Number(l.credit_price));"), "el papel al cliente imprime en la moneda del documento");
  assert.ok(q.includes("const paperUnit = (l: (typeof qlines)[number]) => shQ(paperOffer === \"cash\" ? Number(l.cash_price) : Number(l.credit_price));"), "y el mensaje también");
  assert.ok(q.includes("const prod = prod0 ? { ...prod0, fin: finShown(prod0.fin ?? SIN_FIN, cur, fxQ) } : prod0;"), "la partida agregada en el panel deriva el crédito con la base en esa moneda");
  assert.ok(q.includes("agreed: number, fxQ = 1): LadderStep[]"), "la escalera trabaja en la moneda del documento");
  // Hallazgo del revisor: una cotización EN PESOS también guarda el TC de la tabla; la moneda manda, no el TC.
  assert.ok(q.includes('const fxQ = cur === "USD" ? Number(qrow.fx_rate) : 1;'), "en pesos no se divide nada aunque haya fx_rate guardado");
});

test("pedidos (lista y ficha): ningún peso guardado sale con signo US$ — total de la lista, saldo de la FV, precio de la partida devuelta, selector de factura y resultado de la devolución", () => {
  const idx = src("src/routes/sales.index.tsx");
  assert.ok(idx.includes("moneyIn(salePriceShown(r.total, r.currency, r.fx_rate), r.currency)"), "la lista de pedidos");
  assert.ok(src("src/lib/erp/orders.ts").includes("so.fx_rate::text as fx_rate\n      from sales_orders so"), "listOrders trae el TC para enseñar el total en la moneda del pedido");
  const s = src("src/routes/sales.$orderId.tsx");
  for (const k of [
    "moneyIn(salePriceShown(inv.residual, form.currency, form.fxRate), form.currency)",
    'd.lines = d.lines.map((ln) => ({ ...ln, unit_price: String(salePriceShown(ln.unit_price, curO, o.fx_rate)) }));',
    "saldo ${moneyIn(salePriceShown(i.residual, form.currency, form.fxRate), form.currency)}",
    "Se abonó ${moneyIn(salePriceShown(r.applied, form.currency, form.fxRate), form.currency)}",
    "por ${moneyIn(salePriceShown(r.leftover, form.currency, form.fxRate), form.currency)}",
  ]) assert.ok(s.includes(k), k);
  assert.ok(!/moneyIn\((inv\.residual|i\.residual|r\.applied|r\.leftover), form\.currency\)/.test(s), "ningún peso crudo con la moneda del pedido");
  assert.ok(src("src/routes/statements.tsx").includes("total en pesos; los renglones en dólares van al tipo de cambio pactado"), "el texto de envío del estado de cuenta dice que el saldo del socio es en pesos");
});

test("pedido (pantalla): la partida se carga y se captura en la moneda del pedido; al cambiar la moneda lo escrito se convierte", () => {
  const f = src("src/components/order-form.tsx");
  assert.ok(f.includes('unitPrice: salePriceShown(p?.list_price ?? 0, form.currency, form.fxRate)'), "partida nueva: precio de lista en la moneda del pedido");
  assert.ok(f.includes("Precio / UoM ({form.currency})"), "la columna dice la moneda");
  assert.ok(f.includes("reshowPrice(l.unitPrice, { currency: form.currency, fx: form.fxRate }, { currency, fx: fxRate })"), "cambiar de moneda convierte lo ya escrito");
  const s = src("src/routes/sales.$orderId.tsx");
  // Una sola conversión al cargar (d.lines), y de ahí leen el formulario y la tabla de devolución: dos divisiones daban 54.05 en vez de 1,000.
  assert.ok(s.includes('d.lines = d.lines.map((ln) => ({ ...ln, unit_price: String(salePriceShown(ln.unit_price, curO, o.fx_rate)) }));'), "la ficha carga el precio guardado (pesos) en la moneda del pedido");
  assert.equal((s.match(/salePriceShown\(ln\.unit_price/g) ?? []).length, 1, "y solo una vez");
  assert.ok(s.includes("unitPrice: num(ln.unit_price),"), "el formulario toma el ya convertido");
  assert.ok(s.includes("const unit = num(l.unit_price);") && s.includes("const quoted = shO(o.quoted_price);"), "la tabla «Heredado de COT»: el precio del pedido ya convertido, el cotizado (pesos) se convierte ahí");
  assert.ok(s.includes('o.margin.mode === "nominal" ? `${moneyIn(shO(o.margin.nominal), form.currency)} fijo`'), "el margen en $ fijo se enseña en la moneda del pedido");
  assert.ok(s.includes("const shO = (n: number | string) => salePriceShown(n, form.currency, form.fxRate);"), "cotizado, costo puesto y financiamiento también");
});

test("OC del cliente (pantalla): importes en la moneda de la OC; el precio de lista solo se propone en pesos", () => {
  const c = src("src/routes/cpo.tsx");
  assert.ok(c.includes('const listIn = (p: { list_price: string } | undefined) => (currency === "MXN" ? num(p?.list_price) : 0);'));
  assert.ok(c.includes("moneyIn(total, currency)") && c.includes("moneyIn(row.total, row.currency)") && c.includes("moneyIn(line.qty * line.unitPrice, currency)"));
  assert.ok(!/[^a-zA-Z]money\(/.test(c), "ningún importe sin moneda");
});

test("estado de cuenta: la fila de una FV en dólares sale en dólares al TC pactado, y la cartera del socio se suma en pesos", () => {
  const fn = fnBody(src("src/lib/erp/ops.ts"), "getLiveStatement");
  assert.ok(fn.includes('const showFx = inv.currency === "USD" && isUsdFx(inv.fx_agreed) && Number(inv.amount_fx) !== 0 ? Number(inv.fx_agreed) : 1;'), "solo con TC pactado real y parte en dólares (negativa en una NC)");
  assert.ok(fn.includes("const u = (n: number) => (showFx === 1 ? n : Math.round((n / showFx) * 100) / 100);"), "una sola división, a centavos");
  for (const k of ["cargo: u(cargo),", "saldo: u(saldo),", "abono: u(abono),", "interes: u(line?.interest ?? mora.interest),", "comisionFega: u(line?.comisionFega ?? 0),", "totalFinanciero: u(line?.totalFinanciero ?? mora.mora),", "liveMora: u(liveMora),", "bonificacion: bono.applies ? u(bono.bonus) : 0,"]) {
    assert.ok(fn.includes(k), k);
  }
  assert.ok(fn.includes("saldoMxn: saldo,"), "el saldo en pesos viaja aparte");
  // Cerrado en A.2: `liveFx` es un ajuste de tipo de cambio (pesos por
  // naturaleza), así que se suma al resto YA convertido en vez de dividirse
  // junto con él. Nadie leía `dueNow`, pero mezclaba monedas dentro del número.
  assert.ok(fn.includes("const dueNow = u(saldo + liveMora) + (showFx === 1 ? liveFx : 0);"), "dueNow no mezcla pesos con dólares");
  assert.ok(fn.includes("\n          dueNow,"), "y se publica sin volver a dividir");
  assert.ok(fn.includes("const ar = customerRows.reduce((s, r) => s + r.saldoMxn, 0);"), "la cartera del socio no mezcla dólares con pesos");
  assert.ok(fn.includes("const ap = rows.filter((r) => r.kind === \"supplier\").reduce((s, r) => s + r.saldoMxn, 0);"));
  // El interés se calcula en pesos (capital: Math.max(0, cargo)) y solo se DIVIDE al enseñar: el motor no cambia.
  assert.ok(fn.includes("capital: moraBase(cargo, devueltoMap.get(inv.id) ?? 0, inv.mora_ajusta !== false),"), "computeMora sigue sobre el cargo en pesos (menos lo devuelto, L3b)");
  assert.ok(fn.includes("utCambiaria: fxDiff,"), "el ajuste por TC es pesos y no se divide");
});

test("recordatorios y alertas: el saldo se dice en la moneda de la factura", () => {
  const a = src("src/lib/erp/alerts.ts");
  assert.ok(!/[^a-zA-Z]money\(/.test(a), "ningún saldo sin moneda");
  assert.equal((a.match(/invoiceShown\(\{/g) ?? []).length, 3, "las tres consultas (digesto, recordatorio, recordatorios por socio)");
  assert.ok(a.includes("`Saldo ${moneyIn(shown.residual, shown.currency)}`"), "el recordatorio individual");
  assert.ok(a.includes("Saldo ${moneyIn(sh.residual, sh.currency)}"), "los recordatorios por socio");
  assert.ok(a.includes("${moneyIn(i.residual, i.currency)}"), "el digesto");
});

// ---------------------------------------------------------------------------
// Avisos cerrados (18-sep-2026, tras el revisor de dinero): el ajuste
// cambiario del estado de cuenta imprimía pesos con signo US$; una OC del
// cliente en dólares dejaba pasar un precio en 0.
// ---------------------------------------------------------------------------
test("estado de cuenta (pantalla): la columna «Ut. cambiaria» siempre en pesos, aunque la fila esté en el bloque de dólares", () => {
  const st = src("src/routes/statements.tsx");
  assert.ok(st.includes('if (withFx) cells.push(Math.abs(r.utCambiaria) > 0.009 ? money(r.utCambiaria) : "—");'), "la fila");
  assert.ok(st.includes("if (withFx) cells.push(money(fx));"), "el total");
  assert.ok(!/utCambiaria.*moneyIn\(/.test(st) && !/moneyIn\(fx,/.test(st), "ningún camino la enseña en la moneda del bloque");
});

test("OC del cliente en dólares: el servidor exige precio positivo por partida, y la pantalla lo dice antes de mandarlo", () => {
  const cpoLib = src("src/lib/erp/cpo.ts");
  assert.ok(cpoLib.includes("unitPrice: z.number().positive(),"), "0 ya no es un precio válido");
  const cpoPage = src("src/routes/cpo.tsx");
  assert.ok(cpoPage.includes("const sinPrecio = lines.find((l) => l.productId && l.qty > 0 && !(l.unitPrice > 0));"), "detecta la partida sin precio antes de guardar");
  assert.ok(cpoPage.includes("Falta el precio de ${p?.code ?? sinPrecio.productId}: escríbelo en ${currency}."), "y dice en qué moneda capturarlo");
});

// ---------------------------------------------------------------------------
// El revisor lo encontró en la segunda pasada: la pantalla ya quedó en
// pesos, pero el papel (statementPaperRow/Totals de doc-text.ts) tenía el
// mismo bug — un alias local "money" que en realidad llamaba moneyIn(n, cur).
// ---------------------------------------------------------------------------
test("el papel del estado de cuenta (doc-text.ts): la columna «Ut. cambiaria» también siempre en pesos", () => {
  const dt = src("src/lib/erp/doc-text.ts");
  assert.ok(dt.includes('if (withFx) cells.push(Math.abs(r.utCambiaria) > 0.009 ? moneyIn(r.utCambiaria, "MXN") : "—");'), "la fila del papel");
  assert.ok(dt.includes('if (withFx) cells.push(moneyIn(rows.reduce((s, r) => s + r.utCambiaria, 0), "MXN"));'), "el total del papel");
  const fn = dt.slice(dt.indexOf("export function statementPaperRow"), dt.indexOf("export function quoteNotes"));
  assert.ok(!/utCambiaria.*\bmoney\(/.test(fn.replace(/moneyIn/g, "MONEYIN")), "ningún camino la enseña con el alias local (moneyIn con cur)");
});

test("el pedido levantado sin cotización propone la PRIMERA partida ya en dólares (agujero de L4a, 18-sep-2026)", () => {
  // `/sales/nuevo` nace en dólares. La partida sembrada llevaba el precio de
  // lista CRUDO — pesos — bajo una columna que dice «PRECIO / UOM (USD)»:
  // 18,500 donde debía decir 1,000. Si el vendedor aceptaba el número, el
  // pedido nacía 18.5 veces más grande. Las partidas agregadas después sí
  // convertían (`order-form.tsx`), así que era un solo renglón.
  const nuevo = src("src/routes/sales.nuevo.tsx");
  assert.ok(
    nuevo.includes('unitPrice: salePriceShown(prod?.list_price ?? 0, "USD", lookups.fx?.rate ?? 0),'),
    "la primera partida pasa por salePriceShown, como las demás",
  );
  assert.ok(!nuevo.includes("unitPrice: num(prod?.list_price)"), "y ya no siembra el precio de lista en pesos");
});

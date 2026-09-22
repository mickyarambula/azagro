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
import { exchangeLegs, receiptUnitCostMxn, splitFxCost, usdCashAverage, usdCashRealized } from "../src/lib/erp/fx.ts";

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
test("la recepción convierte ANTES de postStock; postStock no cambia de firma", () => {
  const a = src("src/lib/azagro.ts");
  // Ya no hay «dos caminos»: toda recepción pasa por `receivePartial`, así que
  // la conversión vive en UN solo lugar (18-sep-2026, el agujero de la cuenta
  // por pagar). `receivePurchase` no mueve kardex por su cuenta.
  const rw = fnBody(a, "receivePurchase");
  assert.ok(!rw.includes("await postStock(sql, {"), "receivePurchase no toca el kardex: delega");
  assert.ok(rw.includes("const r = await receivePartial(sql, {"), "toda recepción va por partidas");
  const rp = fnBody(a, "receivePartial");
  // Decisión 101: el bucle se partió en dos pasadas para poder repartir el
  // flete del viaje, así que cambiaron los nombres. El PRINCIPIO no: convertir
  // antes de postStock, y la factura del proveedor con el precio en la moneda
  // de la OC. Se refuerza con lo nuevo.
  assert.ok(rp.includes("receiptUnitCostMxn({ unitPrice: x.unitPrice, currency: poFx[0].currency, fx: poFx[0].fx_rate, poName: opts.poName })"), "recibir por partida, convirtiendo antes");
  assert.ok(
    rp.includes("poName: opts.poName }) + (fleteUnit.get(x.lineId) ?? 0),"),
    "el flete se suma FUERA de receiptUnitCostMxn: se paga en pesos, y adentro lo multiplicaría el tipo de cambio",
  );
  assert.ok(rp.includes("received.push({ productId: x.productId, qty: x.qty, unitPrice: Number(x.unitPrice) });"), "la FP sigue recibiendo el precio en la moneda de la OC (ella convierte)");
  assert.ok(!/received\.push\([^;]*flete/i.test(rp), "y NUNCA el flete: al proveedor se le debe su mercancía, no lo que cobró el fletero");
  const st = src("src/lib/erp/stock.ts");
  assert.ok(!st.includes("currency") && !st.includes("fx_rate"), "el kardex sigue sin saber de monedas");
  // Decisión 101: el kardex tampoco sabe de viajes. Recibe el costo YA sumado
  // y, aparte, cuánto de él era flete — nunca lee `trip_costs`.
  assert.ok(!st.includes("trip_costs"), "el kardex no lee la tabla de viajes");
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

// ---------------------------------------------------------------------------
// DECISIÓN 91 — los dólares salen a su costo, como la mercancía del kardex.
// El promedio ya existía; lo que faltaba era decir cuánto se ganó o se perdió
// al USARLOS. Mismo recorrido, otra pregunta: nunca dos promedios distintos.
// ---------------------------------------------------------------------------
test("usdCashRealized: el caso del dueño — compras a 17.00 y pagas una deuda pactada a 17.50: ganas 50 centavos por dólar", () => {
  const r = usdCashRealized({
    opening: 0,
    moves: [
      { amount: 10000, fxRate: 17.0, ref: "compra" },
      { amount: -10000, fxRate: 17.5, ref: "FP-0001" },
    ],
  });
  assert.equal(r.exits.length, 1);
  assert.equal(r.exits[0].usd, 10000);
  assert.equal(r.exits[0].fxCost, 17, "lo que costaron");
  assert.equal(r.exits[0].fxOut, 17.5, "lo que valieron al usarse");
  assert.equal(r.exits[0].result, 5000, "10,000 × (17.50 − 17.00)");
  assert.equal(r.total, 5000);
  assert.equal(r.exits[0].ref, "FP-0001", "se puede nombrar en pantalla");
});

test("usdCashRealized: al revés — compras caro y usas barato, y el signo no se invierte", () => {
  const r = usdCashRealized({ opening: 0, moves: [{ amount: 10000, fxRate: 18.5 }, { amount: -10000, fxRate: 17.5 }] });
  assert.equal(r.total, -10000, "compraste a 18.50 y los usaste valiendo 17.50");
});

test("usdCashRealized: sale al PROMEDIO de lo que hay, no al TC de la última compra", () => {
  // 1,000 a 18.00 y 1,000 a 19.00 → promedio 18.50. Salen 1,000 valiendo 19.00.
  const r = usdCashRealized({
    opening: 0,
    moves: [{ amount: 1000, fxRate: 18 }, { amount: 1000, fxRate: 19 }, { amount: -1000, fxRate: 19 }],
  });
  assert.equal(r.exits[0].fxCost, 18.5, "promedio móvil, como el kardex");
  assert.equal(r.exits[0].result, 500, "1,000 × (19.00 − 18.50)");
});

test("usdCashRealized: lo que sale del saldo inicial sin TC no realiza nada — no se le inventa costo", () => {
  const r = usdCashRealized({ opening: 2000, moves: [{ amount: -1500, fxRate: 18.5 }] });
  assert.equal(r.exits.length, 0, "no hay contra qué comparar");
  assert.equal(r.total, 0);
  assert.equal(r.noMedidos.length, 1, "pero se dice, con su fecha, para poder recortarlo al periodo");
  assert.equal(r.noMedidos[0].usd, 1500);
  assert.equal(r.noMedidos[0].motivo, "sin-costo");
});

test("usdCashRealized: una salida mixta realiza SOLO la parte con costo conocido", () => {
  // 2,000 sin TC + 1,000 comprados a 18.00; salen 1,500 valiendo 18.50.
  const r = usdCashRealized({ opening: 2000, moves: [{ amount: 1000, fxRate: 18 }, { amount: -1500, fxRate: 18.5 }] });
  assert.equal(r.exits[0].usd, 1000, "solo los que tienen costo");
  assert.equal(r.exits[0].result, 500, "1,000 × (18.50 − 18.00)");
  assert.equal(r.noMedidos[0].usd, 500, "los otros 500 salieron sin costo conocido");
  assert.equal(r.noMedidos[0].motivo, "sin-costo");
});

test("usdCashRealized: una reversa NO realiza nada — deshace, no usa", () => {
  const r = usdCashRealized({
    opening: 0,
    moves: [{ amount: 1000, fxRate: 18.4 }, { amount: 500, fxRate: 18.6 }, { amount: -500, fxRate: 18.6, reversal: true }],
  });
  assert.equal(r.exits.length, 0, "revertir un cobro en dólares no es usarlos");
  assert.equal(r.total, 0);
  // Y el promedio queda como si el cobro revertido no hubiera existido.
  assert.equal(usdCashAverage({ opening: 0, moves: [{ amount: 1000, fxRate: 18.4 }, { amount: 500, fxRate: 18.6 }, { amount: -500, fxRate: 18.6, reversal: true }] }).avgFx, 18.4);
});

test("usdCashRealized: un traslado entre dos cuentas en dólares no realiza nada (Decisión 86)", () => {
  // Los mismos dólares cambiados de cuenta salen al promedio y entran con ese
  // mismo costo: 1,000 comprados a 18.40, trasladados a 18.40.
  const r = usdCashRealized({ opening: 0, moves: [{ amount: 1000, fxRate: 18.4 }, { amount: -1000, fxRate: 18.4 }] });
  assert.equal(r.total, 0, "no se gana ni se pierde por cambiar de cuenta");
});

test("usdCashRealized: el promedio y la realización salen del MISMO recorrido", () => {
  const fx = src("src/lib/erp/fx.ts");
  assert.ok(fx.includes("function walkUsdCash("), "un solo recorrido");
  assert.ok(fx.includes("const w = walkUsdCash(i);"), "los dos lo llaman");
  assert.equal((fx.match(/costMxn \+= amount \* Number\(m\.fxRate\)/g) || []).length, 1, "la regla del promedio está escrita UNA vez");
});

test("el costo del dólar por periodo: dos mitades disjuntas, las dos derivadas, ninguna guardada", () => {
  const q = src("src/lib/erp/fx-cost-query.ts");
  // MITAD 1 — la deuda. La resta es la MISMA que hizo fxPaymentSplit, sobre
  // los dos números que ese pago dejó escritos: no es una segunda fórmula.
  assert.ok(q.includes("r.kind === \"customer\" ? banco - aplicado : banco + aplicado"), "signo por lado, como fxResultDeltaFor");
  assert.ok(q.includes("and coalesce(i.currency,'MXN') = 'USD'") && q.includes("and coalesce(b.currency,'MXN') = 'MXN'"),
    "factura en dólares y cuenta en PESOS: el único modo que convierte al pagar");
  assert.ok(!q.includes("bm.amount_fx"), "nunca por amount_fx: está en null para todo lo anterior a la 0044");
  assert.ok(!q.includes("p.reverses_id is null"), "sin filtro de reversa: el par contrario se cancela solo, en su mes");
  // MITAD 2 — la caja. Recorrido completo y luego el periodo.
  assert.ok(q.includes("const r = usdCashRealized({"), "el kardex de los dólares");
  assert.ok(q.includes("where bank_id = ${c.id} and company_id = ${companyId} order by id"), "desde el principio y por id, como Bancos");
  assert.ok(q.includes("if (!e.date || e.date < from || e.date > to) continue;"), "y solo después se recorta al periodo");
  assert.ok(q.includes("and coalesce(currency,'MXN') = 'USD'"), "solo cuentas en dólares");
  // Nada se guarda: no hay un solo insert ni update en todo el módulo.
  assert.ok(!/insert into|update /.test(q), "se deriva, no se guarda: ninguna segunda verdad");
  // Permisos: los mismos dos que el P&L por periodo.
  assert.ok(q.includes('await assertCan(sql, context.userId, "credit", "view")'), "módulo cartera");
  assert.ok(q.includes("if (!canSeeMargins(me.role))"), "y ver márgenes");
  assert.ok(!q.includes("own_only"), "es un total de empresa: no tiene «mi parte»");
});

test("las dos mitades no se traslapan: una es con cuenta de pesos, la otra con cuenta de dólares", () => {
  // Pagar una factura en dólares CON PESOS no deja movimiento en la cuenta de
  // dólares, así que el recorrido de la caja no lo ve; y una salida de dólares
  // nunca entra a la consulta de la deuda, que exige cuenta en MXN. Disjuntas
  // por construcción, no por un filtro que alguien pueda quitar.
  const fx = src("src/lib/erp/fx.ts");
  assert.ok(fx.includes('if (i.usdInvoice) return i.bankUsd ? "usd-con-dolares" : "usd-con-pesos";'),
    "settleMode separa los dos modos por la moneda de la cuenta");
  const q = src("src/lib/erp/fx-cost-query.ts");
  assert.ok(q.includes("disjuntas por construcción") || q.includes("**disjuntas por construcción**"), "y está dicho donde se lee");
});

test("la pantalla enseña las dos mitades por separado y dice por qué no cuadra contra Compras", () => {
  const r = src("src/routes/reportes.tsx");
  assert.ok(r.includes("Lo que costó el dólar"), "el bloque");
  assert.ok(r.includes("Al pagar en pesos lo que se debía en dólares"), "mitad 1 con nombre");
  assert.ok(r.includes("Al usar dólares que ya se tenían"), "mitad 2 con nombre");
  assert.ok(r.includes("son dos hechos con dos fechas"), "por qué no cuadra contra Compras");
  assert.ok(r.includes("como la mercancía del kardex"), "la explicación que el dueño ya entiende");
  // Fuera del «Resultado» del P&L: meterlo ahí contestaría por omisión la
  // pregunta abierta de si el ajuste por TC entra a la utilidad.
  assert.ok(!r.includes("pnl.net + fx.total") && !r.includes("fx.total + pnl.net"), "no se mete al Resultado del periodo");
});

// ---------------------------------------------------------------------------
// Las tres correcciones del revisor de dinero (NO PASA a la primera).
// ---------------------------------------------------------------------------
test("REVERSA DE UNA SALIDA: borra la ganancia y devuelve los dólares al costo con el que salieron", () => {
  // El caso del revisor: compras 10,000 a 17.00, pagas una FP pactada a 17.50
  // desde la cuenta en dólares (ganancia 5,000) y REVIERTEN el pago. El
  // contra-movimiento nace POSITIVO, así que antes caía por la rama de entrada
  // normal: la ganancia se quedaba publicada y el promedio subía a 17.50.
  const moves = [
    { amount: 10000, fxRate: 17, id: 1 },
    { amount: -10000, fxRate: 17.5, id: 2, ref: "FP-0001" },
    { amount: 10000, fxRate: 17.5, id: 3, reversal: true, reversesId: 2 },
  ];
  const r = usdCashRealized({ opening: 0, moves });
  assert.equal(r.exits.length, 0, "la salida revertida ya no existe");
  assert.equal(r.total, 0, "cero, no +5,000 de una operación que se deshizo");
  // Y el promedio vuelve a 17.00: los dólares regresan a lo que COSTARON, no
  // al TC al que se habían liquidado.
  const a = usdCashAverage({ opening: 0, moves });
  assert.equal(a.tracked, 10000);
  assert.equal(a.avgFx, 17, "no 17.5: eso eran $5,000 de costo inventado");
  assert.equal(a.mxn, 170000);
});

test("UN TRASLADO no realiza nada aunque el promedio no sea redondo (la ganancia por redondeo, cerrada)", () => {
  // El traslado se estampa con el promedio YA REDONDEADO a 4 decimales; contra
  // el promedio sin redondear publicaba hasta $24 de ganancia inventada en un
  // traslado grande. Ahora no realiza por TIPO, no por comparar números.
  const r = usdCashRealized({
    opening: 0,
    moves: [
      { amount: 300000, fxRate: 19.01 },
      { amount: 187000, fxRate: 19.031 },
      { amount: -487000, fxRate: 19.018, kind: "transferencia" },
    ],
  });
  assert.equal(r.total, 0, "mover dólares de cuenta no gana ni pierde un peso");
  assert.equal(r.exits.length, 0);
  assert.equal(r.noMedidos.length, 0, "y tampoco se reporta como «no medido»");
});

test("una salida CON costo pero SIN tipo de cambio no se mide, y se dice — no se esconde en un cero", () => {
  const r = usdCashRealized({ opening: 0, moves: [{ amount: 1000, fxRate: 18 }, { amount: -1000, fxRate: null, ref: "ajuste" }] });
  assert.equal(r.exits.length, 0, "no se le inventa un TC de salida (regla 9)");
  assert.equal(r.total, 0);
  assert.equal(r.noMedidos.length, 1);
  assert.equal(r.noMedidos[0].motivo, "sin-tc");
  assert.equal(r.noMedidos[0].usd, 1000);
});

test("lo no medido se recorta al periodo, igual que las salidas", () => {
  const q = src("src/lib/erp/fx-cost-query.ts");
  assert.ok(q.includes("if (!n.date || n.date < from || n.date > to) continue;"), "mismo recorte que las salidas");
  assert.ok(!q.includes("cajaSinCosto += r.sinCosto"), "ya no se suma el total de toda la vida de la cuenta");
});

test("«del banco salieron» compara contra el lado PROVEEDOR, no contra la suma de los dos lados", () => {
  const q = src("src/lib/erp/fx-cost-query.ts");
  assert.ok(q.includes('deudaFilas.filter((r) => r.lado === "proveedor")'), "el total del lado proveedor, aparte");
  const r = src("src/routes/reportes.tsx");
  assert.ok(r.includes("money(pnl.paidOut - fx.deuda.proveedor)"), "«Pagado a proveedores» solo suma pagos salientes");
  assert.ok(!r.includes("pnl.paidOut - fx.deuda.total"), "restarle el diferencial de un cobro al cliente inventaba la diferencia");
});

// ---------------------------------------------------------------------------
// DECISIÓN 92 — el diferencial entra al Resultado del periodo, pero solo lo
// ABSORBIDO. Lo que se convirtió en documento de ajuste es cartera.
// ---------------------------------------------------------------------------
test("la fórmula del Resultado del periodo lleva el diferencial, y SOLO lo absorbido", () => {
  const r = src("src/lib/erp/reports.ts");
  assert.ok(r.includes("const net = operating - expFin + moraIn + fx.absorbido;"), "el término nuevo, y es el absorbido");
  assert.ok(!r.includes("+ fx.total;"), "nunca el total: lo que quedó en documento de ajuste es cartera");
  // Sale del MISMO lugar que la pantalla: una sola cuenta del mismo hecho.
  assert.ok(r.includes("const fx = await fxCostOfPeriod(sql, companyId, from, to);"), "el P&L lo lee de la función compartida");
  assert.ok(r.includes("fxAbsorbido: fx.absorbido,") && r.includes("fxEnAjuste: fx.enAjuste,"), "y publica las dos partes para que la pantalla cuadre");
});

test("NÚMEROS: elegir «ajuste» no deja pérdida; elegir «utilidad» sí — los dos lados", () => {
  // (a) Cliente: FV pactada a 19.00, el cliente deposita $186,000 (TC 18.60).
  //     El resultado derivado es −4,000 y el ajuste nace en +4,000.
  const a = splitFxCost({ deuda: -4000, caja: 0, ajustes: [{ kind: "customer", nacidos: 4000, revertidos: 0 }] });
  assert.equal(a.total, -4000);
  assert.equal(a.enAjuste, -4000);
  assert.equal(a.absorbido, 0, "no hubo pérdida: hay $4,000 por cobrar");
  // (b) Lo mismo con tratamiento «utilidad»: no nace ajuste.
  const b = splitFxCost({ deuda: -4000, caja: 0, ajustes: [] });
  assert.equal(b.absorbido, -4000, "aquí sí es pérdida del periodo");
  // (c) Proveedor: FP pactada a 17.50 pagada a 18.50. El ajuste nace en −1,000.
  const c = splitFxCost({ deuda: -1000, caja: 0, ajustes: [{ kind: "supplier", nacidos: -1000, revertidos: 0 }] });
  assert.equal(c.absorbido, 0, "los $1,000 quedan por cobrar al proveedor");
  // (d) Y con «utilidad».
  assert.equal(splitFxCost({ deuda: -1000, caja: 0, ajustes: [] }).absorbido, -1000);
});

test("NÚMEROS: los dos lados y los dos tratamientos en el mismo periodo", () => {
  const m = splitFxCost({
    deuda: -10000,
    caja: 0,
    ajustes: [
      { kind: "customer", nacidos: 4000, revertidos: 0 },
      { kind: "supplier", nacidos: -1000, revertidos: 0 },
    ],
  });
  assert.equal(m.total, -10000);
  assert.equal(m.enAjuste, -5000, "los dos ajustes, cada uno con su signo");
  assert.equal(m.absorbido, -5000, "solo los dos de «utilidad»");
});

test("NÚMEROS: la caja SIEMPRE se absorbe — usar dólares propios nunca abre un documento", () => {
  const r = splitFxCost({ deuda: -10000, caja: 3000, ajustes: [{ kind: "supplier", nacidos: -1000, revertidos: 0 }] });
  assert.equal(r.total, -7000);
  assert.equal(r.enAjuste, -1000);
  assert.equal(r.absorbido, -6000, "−7,000 menos el ajuste; los +3,000 de caja entran enteros");
});

test("NÚMEROS: revertir un ajuste NO mueve el mes en que nació — cada mes cierra por su cuenta", () => {
  // Éste es el hallazgo del revisor de dinero. Septiembre: nace el ajuste.
  const sep = splitFxCost({ deuda: -4000, caja: 0, ajustes: [{ kind: "customer", nacidos: 4000, revertidos: 0 }] });
  assert.equal(sep.absorbido, 0);
  // Octubre: se revierte el cobro. El contra-pago aporta +4,000 y el ajuste
  // revertido lo compensa. Septiembre, reimpreso, sigue diciendo 0 — porque no
  // se filtra por el estado de HOY, se cuenta por la fecha de cada hecho.
  const oct = splitFxCost({ deuda: 4000, caja: 0, ajustes: [{ kind: "customer", nacidos: 0, revertidos: 4000 }] });
  assert.equal(oct.total, 4000);
  assert.equal(oct.enAjuste, 4000);
  assert.equal(oct.absorbido, 0, "un hecho que se deshizo no deja resultado en ningún mes");
  // Y si nace y se revierte dentro del MISMO periodo, se cancela solo.
  const mismo = splitFxCost({ deuda: 0, caja: 0, ajustes: [{ kind: "customer", nacidos: 4000, revertidos: 4000 }] });
  assert.equal(mismo.absorbido, 0);
  assert.equal(mismo.enAjuste, 0);
});

test("la consulta cuenta el ajuste por FECHA de nacimiento y de reversa, nunca por su estado de hoy", () => {
  const q = src("src/lib/erp/fx-cost-query.ts");
  assert.ok(q.includes("coalesce(sum(amount) filter (where date between ${from} and ${to}), 0)::text as nacidos"), "los que nacieron en el periodo");
  assert.ok(
    q.includes("coalesce(sum(amount) filter (where state = 'reversed' and cancelled_at::date between ${from} and ${to}), 0)::text as revertidos"),
    "y los que se revirtieron en el periodo, que reversal.ts sí fecha",
  );
  assert.ok(!q.includes("inv_class = 'fx' and state <> 'reversed'"), "filtrar por estado movía hacia atrás un mes cerrado");
  assert.ok(q.includes("const { total, enAjuste, absorbido } = splitFxCost({"), "y la aritmética vive en una función pura, con prueba de números");
});

test("la pantalla dice qué entra al Resultado y qué no", () => {
  const p = src("src/routes/reportes.tsx");
  assert.ok(p.includes('label="Diferencial cambiario"'), "tarjeta propia en el P&L, para que el Resultado cuadre con lo de arriba");
  // La tarjeta se dibuja por lo ABSORBIDO, no solo por el total: un mes con un
  // ajuste de +4,000 y una pérdida absorbida de −4,000 da total 0, y sin esta
  // condición el Resultado bajaba 4,000 sin renglón que lo explicara.
  assert.ok(p.includes("pnl.fxTotal !== 0 || pnl.fxAbsorbido !== 0 ?"), "se dibuja también cuando el total se cancela pero algo se absorbió");
  // Y el inicio, que enseña la misma utilidad neta, lleva su renglón.
  assert.ok(src("src/routes/index.tsx").includes('<span className="text-muted">Diferencial cambiario</span>'), "el inicio también cuadra a la vista");
  assert.ok(p.includes("money(pnl.fxAbsorbido)"), "la tarjeta enseña lo absorbido, que es lo que entró");
  assert.ok(p.includes("eso es cartera"), "y el bloque explica por qué lo otro no entra");
  assert.ok(p.includes("NO entra al «Resultado» de arriba"), "con esas palabras");
});

test("una nota de crédito resta del importe pero NO se cuenta como una venta más", () => {
  const r = src("src/lib/erp/reports.ts");
  assert.ok(r.includes("count(*) filter (where name not like 'NC-%')::int as n"), "el conteo deja fuera las notas de crédito");
  assert.ok(r.includes("coalesce(sum(amount),0)::text as amount"), "el importe sigue sumando todo: la NC resta, que es lo correcto");
  // Excluir por el prefijo de la NC y no incluir por el de la FV: las facturas
  // del corte Compaq traen su propio folio y filtrar por FV las habría dejado
  // de contar sin que nadie lo pidiera.
  assert.ok(!r.includes("filter (where name like 'FV-%')"), "nunca por FV: el corte no usa ese prefijo");
  assert.ok(src("src/lib/erp/cutover-core.ts").includes("${o.companyId}, ${r.kind}, ${r.folio}, ${partner[0].id}"), "el corte inserta el folio de Compaq tal cual");
});

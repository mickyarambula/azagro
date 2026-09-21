// EL FLETE DEL PEDIDO SE CUENTA UNA VEZ, Y EL REAL MANDA (Decisión 99).
//
// Hasta hoy los dos cálculos de la utilidad hacían `freightQuote + expPedido`.
// El flete cotizado es lo que se metió al PRECIO; el gasto del fletero es el
// MISMO costo, ya pagado. Quien cotizaba $2,000 de flete y luego capturaba la
// factura del fletero contra ese pedido veía la utilidad $2,000 más baja de lo
// que fue — y la pantalla de Gastos invita con todas sus letras a capturar ahí
// «flete de un pedido».
//
// La regla nueva no es nueva: es la que ese mismo cálculo ya aplica al costo
// de la mercancía tres renglones arriba —«el costo real manda: OC del
// proveedor, luego el de la cotización»— extendida al flete, que viaja en el
// mismo costo puesto.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freightOfDeal, mergeDealPnl } from "../src/lib/erp/parciales.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");
/**
 * El archivo sin comentarios. La fórmula vieja se NOMBRA en la explicación de
 * por qué se fue; lo que no puede volver es el código.
 */
const code = (p) => src(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const gasto = (over) => ({ id: 1, name: "GAS-0001", class: "pedido", amount: 0, ...over });

// ---------------------------------------------------------------------------
// 1. La regla, con números
// ---------------------------------------------------------------------------
test("sin gasto de flete capturado, resta el cotizado y lo dice", () => {
  const f = freightOfDeal(2000, []);
  assert.equal(f.cost, 2000);
  assert.equal(f.source, "cotizado");
  assert.equal(f.real, 0);
  assert.equal(f.n, 0);
  assert.equal(f.diff, null, "sin el número real no hay contra qué comparar; un cero diría «salió igual»");
});

test("con el gasto del fletero capturado, manda el real y el cotizado deja de restar", () => {
  const f = freightOfDeal(2000, [gasto({ amount: 2600, isFreight: true })]);
  assert.equal(f.cost, 2600, "el costo es lo que de verdad se pagó");
  assert.equal(f.source, "real");
  assert.equal(f.diff, 600, "el viaje salió $600 más caro que lo comprometido");
  // Lo que hacía antes: 2,000 + 2,600 = 4,600 por un solo costo de 2,600.
  assert.notEqual(f.cost, 2000 + 2600, "el doble conteo");
});

test("si el viaje salió más barato, la diferencia va con signo negativo", () => {
  assert.equal(freightOfDeal(2000, [gasto({ amount: 1500, isFreight: true })]).diff, -500);
});

test("dos viajes, dos gastos: el flete real es la suma, no el último", () => {
  const f = freightOfDeal(2000, [gasto({ id: 1, amount: 1200, isFreight: true }), gasto({ id: 2, amount: 1400, isFreight: true })]);
  assert.equal(f.real, 2600);
  assert.equal(f.n, 2, "la pantalla dice cuántos se capturaron: con uno solo de dos, el real va corto y hay que poder verlo");
});

test("cotizar el flete en CERO y que el viaje cueste no se disimula: la diferencia es el flete entero", () => {
  const f = freightOfDeal(0, [gasto({ amount: 2600, isFreight: true })]);
  assert.equal(f.cost, 2600);
  assert.equal(f.diff, 2600, "nadie lo metió al precio y se lo comió la utilidad completo");
});

// ---------------------------------------------------------------------------
// 2. Las otras dos cubetas: el candado de al lado
// ---------------------------------------------------------------------------
test("un gasto de flete NO vuelve a entrar como gasto del pedido ni como gasto de otra clase", () => {
  const f = freightOfDeal(2000, [
    gasto({ id: 1, amount: 2600, isFreight: true }),
    gasto({ id: 2, amount: 500, class: "pedido" }),
    gasto({ id: 3, amount: 300, class: "operativo" }),
  ]);
  assert.equal(f.cost, 2600);
  assert.equal(f.pedido, 500, "las maniobras siguen restando aparte");
  assert.equal(f.otros, 300);
  assert.equal(f.pedido + f.otros, 800, "el flete no aparece en ninguna de las dos");
});

test("un flete marcado con clase «operativo» tampoco se cuela: la marca manda sobre la clase", () => {
  // Una puerta que se cierra por un lado y se deja abierta por el otro no es
  // una puerta. La marca es estructural; la clase la elige una persona.
  const f = freightOfDeal(2000, [gasto({ amount: 2600, class: "operativo", isFreight: true })]);
  assert.equal(f.cost, 2600);
  assert.equal(f.pedido, 0);
  assert.equal(f.otros, 0, "no resta dos veces por haberlo clasificado distinto");
});

test("la marca se lee estricta: `undefined` y `false` son «no es el flete»", () => {
  assert.equal(freightOfDeal(2000, [gasto({ amount: 2600 })]).source, "cotizado", "un gasto viejo, sin columna, cuenta como venía contando");
  assert.equal(freightOfDeal(2000, [gasto({ amount: 2600, isFreight: false })]).source, "cotizado");
});

// ---------------------------------------------------------------------------
// 3. La utilidad del pedido, de punta a punta
// ---------------------------------------------------------------------------
function line(over) {
  return {
    productId: 1, code: "URE01", name: "UREA", qty: 20, uom: "TON", saleUnit: 1000, sale: 20000, costUnit: 600, costSource: "OC",
    cogs: 12000, freightUnit: 100, freight: 2000, other: 0, landed: 14000, finance: 0, commission: 0, layer1: 0, layer2: 0,
    margin: 6000, marginPct: 30, disbursed: 0, financierFinance: 0, lineCost: 0, protection: 0, revenueLine: 20000,
    excluded: false, excludeReason: null, ...over,
  };
}
function part(over = {}) {
  const l = line();
  return {
    invoice: { id: 1, name: "FV-0001", eventRef: "ENV/0001", date: "2026-10-01", amount: 20000, residual: 20000, paidDate: null },
    pnl: {
      name: "PV-0001", currency: "MXN", creditDays: 60, circuit: "ASR", financingBase: "costo_comision", clientPrice: 20000,
      disbursed: 0, financierFinance: 0, commissionRate: 0.01, costRate: null, collectionRate: null, spread: 0.04, lineCost: 0,
      protection: 0, financeRate: 0.11, tiieIssue: 0.07, tiieDate: "2026-10-01", financialDays: 60, daysExceeded: 0, lines: [l],
      revenue: 20000, cogs: 12000, freightQuote: 2000, other: 0, commission: 0, layer1: 0, layer2: 0, finance: 0,
      financeBase: 14000, discount: 0, fxIncome: 0, ...over,
    },
  };
}
const pedido = (expenses) => ({ expenses, mora: 0, moraPendiente: 0, uninvoiced: [] });

test("el caso que estaba mal: $2,000 cotizados y la factura del fletero de $2,600 dejaban la utilidad $2,000 corta", () => {
  const m = mergeDealPnl([part()], pedido([gasto({ amount: 2600, isFreight: true })]));
  assert.equal(m.revenue, 20000);
  assert.equal(m.cogs, 12000);
  assert.equal(m.freight, 2600, "el costo real del viaje");
  assert.equal(m.freightQuote, 2000);
  assert.equal(m.freightReal, 2600);
  assert.equal(m.freightSource, "real");
  assert.equal(m.freightDiff, 600);
  assert.equal(m.margin, 5400, "20,000 − 12,000 − 2,600");
  // Lo que daba antes: freight = 2,000 + 2,600 = 4,600 → margen 3,400.
  assert.equal(5400 - 3400, 2000, "exactamente el flete cotizado, restado de más");
});

test("sin gasto capturado la utilidad no cambia ni un centavo: el camino de siempre queda igual", () => {
  const m = mergeDealPnl([part()], pedido([]));
  assert.equal(m.freight, 2000);
  assert.equal(m.freightSource, "cotizado");
  assert.equal(m.margin, 6000, "20,000 − 12,000 − 2,000, como siempre");
  assert.equal(m.freightDiff, null);
});

test("los gastos del pedido que NO son flete siguen restando: sacarlos de `freight` no podía desaparecerlos", () => {
  // El error fácil al arreglar esto: `freight` dejaba de incluir `expPedido` y
  // las maniobras se salían del costo sin que nadie las echara de menos.
  const m = mergeDealPnl([part()], pedido([gasto({ id: 1, amount: 2600, isFreight: true }), gasto({ id: 2, amount: 500 })]));
  assert.equal(m.freight, 2600);
  assert.equal(m.other, 500, "las maniobras, por su propio lado");
  assert.equal(m.margin, 4900, "20,000 − 12,000 − 2,600 − 500");
  assert.equal(m.netProfit, 4900, "sin mora, sin financiamiento, sin descuento");
});

test("solo maniobras, sin flete real: el cotizado sigue mandando y las maniobras suman aparte", () => {
  const m = mergeDealPnl([part()], pedido([gasto({ amount: 500 })]));
  assert.equal(m.freight, 2000);
  assert.equal(m.other, 500);
  assert.equal(m.margin, 5500, "20,000 − 12,000 − 2,000 − 500 — el mismo total que daba antes");
});

// ---------------------------------------------------------------------------
// 4. Una sola regla, y los DOS lectores la usan
// ---------------------------------------------------------------------------
test("la fórmula del doble conteo no existe en ningún lado", () => {
  for (const p of ["src/lib/erp/reports.ts", "src/lib/erp/parciales.ts"]) {
    assert.ok(!code(p).includes("freightQuote + expPedido"), `${p} todavía suma las dos`);
    assert.ok(!code(p).includes("expPedido + freightQuote"), `${p} las suma al revés`);
  }
});

test("los DOS que calculan la utilidad del pedido leen la MISMA regla — si uno se sale, se sale sin que nadie lo note", () => {
  // La lección de los SEIS lectores de la mora: la lista de abajo es la que
  // revisa el siguiente que toque esto. Si dice menos de los que hay, el que
  // falte se queda con la fórmula vieja.
  const lectores = ["src/lib/erp/reports.ts", "src/lib/erp/parciales.ts"];
  for (const p of lectores) {
    assert.ok(src(p).includes("freightOfDeal("), `${p} no llama a la regla`);
    assert.ok(src(p).includes("const freight = flete.cost;"), `${p} no toma el costo de la regla`);
    assert.ok(src(p).includes("const expPedido = flete.pedido;"), `${p} arma la cubeta del pedido por su cuenta`);
    assert.ok(src(p).includes("const expOther = flete.otros;"), `${p} arma la cubeta de otros por su cuenta`);
    assert.ok(src(p).includes("const otros = otherQuote + expPedido + expOther;"), `${p} deja fuera del margen los gastos del pedido`);
    assert.ok(src(p).includes("const margin = revenue - cogs - freight - otros;"), `${p} arma el margen distinto`);
  }
  // Y la regla vive UNA sola vez.
  assert.equal((src("src/lib/erp/parciales.ts").match(/export function freightOfDeal\(/g) || []).length, 1);
  assert.ok(!src("src/lib/erp/reports.ts").includes("function freightOfDeal("), "reports.ts la importa, no la copia");
});

test("la base del costo financiero NO se toca: al cliente se le cobró sobre el flete cotizado", () => {
  // Recalcular el financiamiento con el flete real cambiaría un cargo que ya
  // se hizo, y descuadraría precio contra tarjeta (regla 8: las dos cifras
  // tienen que coincidir).
  for (const p of ["src/lib/erp/reports.ts", "src/lib/erp/parciales.ts"]) {
    assert.ok(/financeBase = (included\.reduce\(\(s, l\) => s \+ l\.landed, 0\)|sum\(included, \(l\) => l\.landed\))/.test(src(p)), `${p} movió la base del financiamiento`);
  }
  assert.ok(src("src/lib/erp/reports.ts").includes("const landed = cogs + freight + other;"), "el costo puesto de la partida sigue con el flete COTIZADO");
  const m = mergeDealPnl([part()], pedido([gasto({ amount: 2600, isFreight: true })]));
  assert.equal(m.financeBase, 14000, "12,000 + 2,000 cotizados: el real no la mueve");
});

// ---------------------------------------------------------------------------
// 5. La marca, la guarda y la pantalla
// ---------------------------------------------------------------------------
test("la marca es una columna, no el nombre de la categoría que teclea una persona", () => {
  const mig = src("migrations/0049_flete_del_pedido.sql");
  assert.ok(mig.includes("alter table expenses add column if not exists is_freight boolean not null default false;"));
  const e = src("src/lib/erp/expenses.ts");
  assert.ok(e.includes("isFreight: z.boolean().optional().default(false),"), "se captura");
  assert.ok(e.includes("${data.isFreight === true}, ${data.eventRef ?? \"\"})"), "se guarda (con la liga del viaje de la Decisión 100 al lado)");
  assert.ok(e.includes("coalesce(e.is_freight, false) as is_freight"), "se devuelve al listado");
  const r = src("src/lib/erp/reports.ts");
  assert.ok(r.includes("coalesce(is_freight, false) as is_freight"), "la utilidad la lee");
  // Nunca por el nombre de la categoría.
  assert.ok(!/category[^\n]*===[^\n]*[Ff]lete/.test(r) && !/category[^\n]*===[^\n]*[Ff]lete/.test(src("src/lib/erp/parciales.ts")), "no se reconoce por el texto");
});

test("un gasto marcado como flete sin pedido al que pertenecer se detiene", () => {
  // La guarda se apretó al cerrar la revisión: no basta con estar ligado a
  // algo, tiene que ser un pedido de VENTA (ver la sección 6).
  const e = src("src/lib/erp/expenses.ts");
  assert.ok(e.includes("if (data.isFreight && !data.soId) {"), "la guarda");
  assert.ok(e.includes("Marca el flete contra el pedido de venta al que pertenece"), "y dice qué hacer");
});

test("la pantalla de Gastos ofrece la casilla y explica qué cambia", () => {
  const g = src("src/routes/gastos.tsx");
  assert.ok(g.includes("Es el flete de este pedido"), "la casilla");
  assert.ok(g.includes("sustituye al que se cotizó, en vez de sumarse encima"), "dice qué hace");
  assert.ok(g.includes('isFreight: cls === "pedido" && esFlete && !!soId,'), "y lo manda, solo con pedido de venta");
  assert.ok(g.includes("Flete del pedido"), "el listado enseña cuál es");
});

test("la tarjeta del pedido enseña de dónde salió el flete y la diferencia contra lo cotizado", () => {
  const p = src("src/routes/sales.$orderId.tsx");
  assert.ok(p.includes('pnl.freightSource === "real"'), "distingue el real del cotizado");
  assert.ok(p.includes("y esa diferencia se la comió la utilidad"), "nombra a dónde se fue el dinero");
  assert.ok(p.includes("Todavía no se captura el gasto del fletero contra este pedido"), "y cuando no hay real, lo dice en vez de callarlo");
  assert.ok(p.includes('tone={pnl.freightSource === "real" && pnl.freightDiff != null && pnl.freightDiff > 0.009 ? "bad" : undefined}'), "y se pinta cuando salió más caro");
});

// ---------------------------------------------------------------------------
// 6. Lo que cerró la revisión de dinero (PASA CON AVISOS, 20-sep-2026)
// ---------------------------------------------------------------------------
test("la marca SE PUEDE CORREGIR: sin eso, un flete capturado ayer restaría dos veces para siempre", () => {
  // Un candado sin salida es peor que el bug que tapa. No hay pantalla para
  // editar un gasto: si la marca solo se pudiera poner al capturarlo, la
  // Decisión 99 no serviría para nada de lo ya capturado, y una marca puesta
  // por error subiría el margen sin forma de bajarlo.
  const e = src("src/lib/erp/expenses.ts");
  assert.ok(e.includes("export const setExpenseFreight = createServerFn"), "existe el verbo");
  assert.ok(e.includes('await assertCan(sql, context.userId, "gastos", "edit");'), "con permiso");
  assert.ok(e.includes('action: data.isFreight ? "marcar-flete" : "desmarcar-flete",'), "y en bitácora");
  assert.ok(e.includes("deja de ser el flete del pedido: vuelve a contar como costo aparte y regresa el flete cotizado"), "la bitácora dice qué número se mueve");
  // No mueve dinero: ni importe, ni fecha, ni cuenta, ni movimiento de banco.
  const cuerpo = e.slice(e.indexOf("export const setExpenseFreight"), e.indexOf("export const addExpenseCategory"));
  assert.ok(cuerpo.includes("update expenses set is_freight ="), "solo la marca");
  assert.ok(!cuerpo.includes("bank_moves"), "no toca el banco");
  assert.ok(!/set [^\n]*amount\s*=/.test(cuerpo), "no toca el importe");
  const g = src("src/routes/gastos.tsx");
  assert.ok(g.includes("Marcar como flete") && g.includes("No es el flete"), "y hay botón en las dos direcciones");
});

test("el flete se marca contra el pedido de VENTA: contra una orden de compra quedaría huérfano", () => {
  // La utilidad del pedido lee sus gastos por `so_id`. Marcado contra una OC
  // no sustituiría nada Y la tarjeta seguiría diciendo «todavía no se
  // captura», que para quien acaba de capturarlo es falso.
  const e = src("src/lib/erp/expenses.ts");
  assert.equal((e.match(/if \(data\.isFreight && !data\.soId\) \{/g) || []).length, 1, "la guarda al crear");
  assert.ok(e.includes("if (data.isFreight && !e[0].so_id) {"), "y la misma al corregir: las dos puertas, el mismo candado");
  assert.equal(
    (e.match(/Marca el flete contra el pedido de venta al que pertenece/g) || []).length,
    2,
    "el mismo mensaje en las dos",
  );
  const g = src("src/routes/gastos.tsx");
  assert.ok(g.includes("{soId ? ("), "la casilla solo aparece con pedido de venta");
  assert.ok(g.includes("El flete de una orden de compra todavía no tiene a dónde ir"), "y con una OC se dice por qué no está");
  assert.ok(g.includes('isFreight: cls === "pedido" && esFlete && !!soId,'), "y no se manda marcada sin pedido de venta");
});

test("con la captura incompleta el sistema NO concluye un ahorro", () => {
  // Dos viajes y una sola factura capturada: el real va corto, sustituye al
  // cotizado completo y el margen sale alto. El mecanismo se queda (usar un
  // número real es mejor que inventar), pero la pantalla no puede llamarle
  // ahorro a una factura que falta.
  const p = src("src/routes/sales.$orderId.tsx");
  assert.ok(p.includes("antes de contarlo como ahorro, revisa que no falte capturar un viaje"), "lo dice");
  assert.ok(!p.includes("esa diferencia quedó de utilidad"), "y ya no afirma el ahorro");
  assert.ok(p.includes("con ${pnl.freightN === 1 ? `1 gasto capturado` : `${pnl.freightN} gastos capturados`} hasta hoy".replaceAll("`", "`")) || p.includes("hasta hoy"), "y dice que es lo capturado hasta hoy");
});

test("los gastos del pedido que no son flete siguen a la vista, sumados", () => {
  // Antes vivían dentro del recuadro «Flete / sobre pedido». Al salir de ahí,
  // unas maniobras de $500 restaban del margen sin aparecer en ningún renglón.
  const p = src("src/routes/sales.$orderId.tsx");
  assert.ok(p.includes("Otros costos del pedido:"), "el total se enseña");
  assert.ok(p.includes("restan del margen aparte del flete"), "y dice que restan");
  assert.ok(p.includes("es el flete del pedido"), "y se ve cuál de los gastos es el flete");
});

test("la columna que cambió de significado cambió también de nombre", () => {
  // Era «cotizado + gastos del pedido»; ahora es «el pagado si lo hay, si no
  // el cotizado». Mismo encabezado con otro número mueve el total del Excel
  // de una semana a la otra sin nada en la hoja que lo explique.
  const r = src("src/routes/reportes.tsx");
  assert.ok(r.includes('"Flete pagado o cotizado"'), "el Excel");
  assert.ok(r.includes(">Flete pagado o cotizado</th>"), "y la tabla");
});

test("si la columna todavía no existe, los gastos se leen sin ella: nunca desaparecen del costo", () => {
  // El try/catch devolvía lista vacía. Con la columna nueva, un despliegue con
  // el código adelante de la migración habría sacado TODOS los gastos del
  // pedido del costo, en silencio y a favor del margen.
  const r = src("src/lib/erp/reports.ts");
  const q = r.slice(r.indexOf("async function orderExpenses"), r.indexOf("async function orderMora"));
  assert.equal((q.match(/select id, name, class, amount::text/g) || []).length, 2, "la consulta de respaldo, sin la columna");
  assert.ok(q.includes("isFreight: false"), "y ahí ningún gasto es flete: cuentan como contaban antes");
  assert.ok(q.includes("de los dos modos de fallar, ése es el peor"), "y queda dicho por qué");
});
